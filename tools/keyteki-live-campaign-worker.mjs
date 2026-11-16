/** One campaign attempt. The existing native one-seat lifecycle remains the authority. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runOneSeat } from './keyteki-human-launcher.mjs';
import { runCreatePublic } from './keyteki-human-create-public.mjs';
import { readLobbyFromBrowser } from './keyteki-live-lobby.mjs';
import { releaseOwnedHumanBrowser } from './keyteki-owned-browser-release.mjs';
import { stopUnjoinedHost } from './keyteki-unjoined-host-stop.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writePrivate = (file, value) => {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};
const missedBeforeJoin = new Set([
  'CURRENT_PUBLIC_LISTING_NOT_OBSERVED',
  'CURRENT_PUBLIC_LISTING_REQUIRED',
  'PUBLIC_ROOM_PAIR_CHANGED',
  'PUBLIC_ROOM_NOT_EXPECTED_JOINABLE_KIND',
  'PUBLIC_ROOM_BINDING_CHANGED',
]);

export function canRetireUnjoined(live) {
  return Boolean(
    live?.state?.held &&
      !live.state.operatorPaused &&
      !live.state.fullVerified &&
      !live.state.finalPublicView &&
      missedBeforeJoin.has(live.state.holdReason) &&
      live.observer &&
      live.observer.joinRequested === false &&
      live.observer.pending === null &&
      !live.observer.selection &&
      live.instance &&
      live.pool &&
      !live.state.gameplayDiagnostics?.stats?.commands &&
      !live.state.gameplayDiagnostics?.stats?.queuedCommands,
  );
}

/** Only a failed target selection BEFORE join was requested can use this no-write retirement. */
export async function retireUnjoinedAttempt(
  live,
  { probe = readLobbyFromBrowser, stopHost, release = releaseOwnedHumanBrowser } = {},
) {
  if (!canRetireUnjoined(live)) return false;
  const snapshot = await probe(live.instance.browser, { origin: live.config.origin });
  const absent =
    snapshot?.nativeFullRoster === true &&
    snapshot.source === 'native-lobby' &&
    snapshot.anonymous === true &&
    snapshot.origin === live.config.origin &&
    Date.now() - snapshot.fullObservedAt <= 30000 &&
    snapshot.fullObservedAt <= Date.now() + 1000 &&
    Array.isArray(snapshot.rooms) &&
    snapshot.rooms.every((row) => row.players && !Object.hasOwn(row.players, live.config.self.name));
  if (!absent || !canRetireUnjoined(live)) return false;
  live.state.unjoinedRetirement = {
    schema: 'kf-unjoined-retirement-v1',
    phase: 'verified-before-host-stop',
    gameId: live.config.room.gameId,
    playerName: live.config.self.name,
    guard: live.state.holdReason,
    joinRequested: false,
    pending: false,
    selection: false,
    neverNativeActive: true,
    zeroGameplaySends: true,
    nativeAbsence: snapshot,
    checkedAt: new Date().toISOString(),
  };
  live.save();
  // Nothing has joined or sent gameplay. Stop only this exact fresh host before retiring its browser.
  const stopped = await stopHost();
  const operatorChanged = () =>
    stopped?.operatorIntervened === true || stopped?.operatorUnchanged?.() === false;
  if (operatorChanged()) {
    live.state.operatorPaused = true;
    live.state.unjoinedRetirement.phase = 'operator-preserved';
    live.save();
    return false;
  }
  if (stopped?.stopped !== true || !canRetireUnjoined(live)) return false;
  live.watchdog?.close();
  live.finishedExit?.close();
  live.disconnectedExit?.close();
  await release({ pool: live.pool, instance: live.instance, config: live.config });
  if (operatorChanged() || !canRetireUnjoined(live)) {
    live.state.operatorPaused = true;
    live.state.unjoinedRetirement.phase = 'operator-preserved';
    live.save();
    return false;
  }
  live.observer.dispose();
  live.state.matchmakingMiss = {
    gameId: live.config.room.gameId,
    playerName: live.config.self.name,
    reason: live.state.holdReason,
    serverSeatAbsent: true,
    nativeFullRoster: true,
    neverNativeActive: true,
    zeroGameplaySends: true,
    joinRequested: false,
    fullRosterObservedAt: snapshot.fullObservedAt,
    checkedAt: new Date().toISOString(),
  };
  live.state.hostStoppedAfterMiss = true;
  live.state.runtimeRetired = true;
  live.state.unjoinedRetirement.phase = 'retired';
  if (stopped.retirementId) live.state.unjoinedRetirement.hostRetirementId = stopped.retirementId;
  live.state.phase = 'matchmaking-miss-retired';
  live.save();
  return true;
}

export async function runCampaignWorker(input, { createPublic = false } = {}) {
  const previous = new Map();
  const evidence = (row) => {
    let hostRunId = null;
    try {
      hostRunId = read(path.join(input.output, 'host', 'connection.json')).runId;
    } catch {}
    const { observedAt, ...content } = row;
    const value = { ...content, hostRunId };
    const signature = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    if (previous.get(row.type) === signature) return;
    fs.appendFileSync(
      path.join(input.output, 'evidence.jsonl'),
      JSON.stringify({ ...row, hostRunId }) + '\n',
      { mode: 0o600 },
    );
    previous.set(row.type, signature);
  };
  const live = createPublic
    ? await runCreatePublic(input, { onEvidence: evidence })
    : await runOneSeat(input, null, { onEvidence: evidence });
  let firstViewSaved = false,
    faultViewSaved = false;
  const captureOwnView = () => {
    const raw = live.watchdog?.native?.snapshot();
    if (
      !raw ||
      raw.id !== live.config.room.gameId ||
      Object.keys(raw.players ?? {})
        .sort()
        .join('\0') !== [...live.config.participants].sort().join('\0')
    )
      return;
    // Private diagnostic inputs only. These files are never copied into public campaign summaries.
    writePrivate(path.join(input.output, 'last-player-view.json'), raw);
    if (!firstViewSaved) {
      writePrivate(path.join(input.output, 'first-player-view.json'), raw);
      firstViewSaved = true;
      writePrivate(path.join(input.output, 'match-details.json'), {
        gameId: raw.id,
        strategy: live.config.self.codePolicy,
        playerName: live.config.self.name,
        players: Object.fromEntries(
          live.config.participants.map((name) => [
            name,
            {
              deckName: raw.hideDeckLists ? null : (raw.players[name]?.deckData?.name ?? null),
              deckUuid: raw.hideDeckLists ? null : (raw.players[name]?.deckData?.uuid ?? null),
            },
          ]),
        ),
      });
    }
    if (live.state.held && !faultViewSaved) {
      writePrivate(path.join(input.output, 'first-fault-player-view.json'), raw);
      faultViewSaved = true;
    }
    if (live.state.finished) writePrivate(path.join(input.output, 'terminal-player-view.json'), raw);
  };
  if (!createPublic && canRetireUnjoined(live)) {
    try {
      await retireUnjoinedAttempt(live, {
        stopHost: () => stopUnjoinedHost(live.config, live.unjoinedHostBinding),
      });
    } catch {
      live.state.matchmakingRetirementError = 'UNJOINED_RETIREMENT_UNCONFIRMED';
      live.save();
    }
  }
  while (!live.state.runtimeRetired) {
    try {
      captureOwnView();
      evidence({
        schema: 'kf-one-seat-evidence-v1',
        type: 'lifecycle-sample',
        observedAt: new Date().toISOString(),
        gameId: live.state.gameId,
        playerName: live.config.self.name,
        codePolicy: live.config.self.codePolicy,
        phase: live.state.phase,
        held: live.state.held,
        holdReason: live.state.holdReason ?? null,
        operatorPaused: live.state.operatorPaused === true,
        publicView: live.state.finalPublicView ?? null,
        hostRestarts: live.state.hostRestarts ?? 0,
        diagnostics: live.state.gameplayDiagnostics ?? null,
        watchdogPhase: live.state.watchdog?.phase ?? null,
      });
    } catch {
      live.state.evidenceWriteFailures = (live.state.evidenceWriteFailures ?? 0) + 1;
      live.state.lastEvidenceWriteError = 'EVIDENCE_SINK_FAILED';
    }
    live.save();
    await pause(2000);
  }
  captureOwnView();
  live.save();
  return live.state;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf('--config');
  void (async () => {
    if (i < 0 || !process.argv[i + 1]) throw Error('WORKER_CONFIG_REQUIRED');
    await runCampaignWorker(read(path.resolve(process.argv[i + 1])), {
      createPublic: process.argv.includes('--create-public'),
    });
    // All owned runtime resources have confirmed retirement. Do not keep unused signal listeners alive.
  })().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'campaign-worker-failed',
        code: /^[A-Z0-9_-]+$/.test(error?.message ?? '') ? error.message : 'WORKER_FAILURE',
      }),
    );
    process.exitCode = 1;
  });
}
