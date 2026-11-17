#!/usr/bin/env node
/** Continuous one-account supervisor. No game command is sent by this process. */
import fs from 'node:fs';
import { campaignAccountLockRoot } from './browser-paths.mjs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeHumanConfig, REPO_ROOT } from './keyteki-human-config.mjs';
import { readCampaignLobby } from './keyteki-live-lobby.mjs';
import { resolveRuntimeExecutables } from './runtime-executables.mjs';
import { collectRuntimeFiles } from './freeze-keyteki-live.mjs';
import {
  selectCampaignRoom,
  classifyCampaignAttempt,
  campaignHealth,
  focusedCampaignProgress,
} from './keyteki-live-campaign-policy.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
};
export function atomicCampaignJson(file, value) {
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};

export function normalizeCampaignConfig(input) {
  if (
    input?.schema !== 'keyteki-live-campaign-v1' ||
    !/^[a-z0-9][a-z0-9-]{1,79}$/.test(input.id ?? '') ||
    !path.isAbsolute(input.output ?? '') ||
    !path.isAbsolute(input.runtimeManifest ?? '') ||
    !/^[a-f0-9]{64}$/.test(input.runtimeManifestSha256 ?? '')
  )
    fail('CAMPAIGN_CONFIG_INVALID');
  const output = path.resolve(input.output);
  const seat = normalizeHumanConfig(
    { ...input.seat, output: path.join(output, 'config-check') },
    { createPublic: true },
  );
  if (!seat.leaveAfterFinish || !seat.watchdog.enabled) fail('CAMPAIGN_LIFECYCLE_REQUIRED');
  const bounded = (key, fallback, min, max) => {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('CAMPAIGN_TIMING_INVALID');
    return value;
  };
  const focusOpponentName = input.focusOpponentName ?? null;
  if (
    focusOpponentName !== null &&
    (typeof focusOpponentName !== 'string' ||
      !/^[A-Za-z0-9_-]{3,15}$/.test(focusOpponentName) ||
      seat.ownAccountNames.includes(focusOpponentName))
  )
    fail('CAMPAIGN_FOCUS_OPPONENT_INVALID');
  const focusNaturalGameLimit =
    input.focusNaturalGameLimit == null ? null : bounded('focusNaturalGameLimit', null, 1, 10000);
  if (focusNaturalGameLimit !== null && focusOpponentName === null) fail('CAMPAIGN_FOCUS_OPPONENT_REQUIRED');
  const budget = (key, max) => {
    const value = input[key];
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) fail('CAMPAIGN_BUDGET_INVALID');
    return value;
  };
  return {
    ...input,
    output,
    network: seat.network,
    maxNaturalGames: budget('maxNaturalGames', 10000),
    maxAttempts: budget('maxAttempts', 100000),
    maxElapsedMs: budget('maxElapsedMs', 30 * 24 * 60 * 60 * 1000),
    origin: seat.origin,
    selfName: seat.self.name,
    ownAccountNames: seat.ownAccountNames,
    focusOpponentName,
    focusNaturalGameLimit,
    focusPollMs: bounded('focusPollMs', 10000, 3000, 300000),
    betweenGamesMs: bounded('betweenGamesMs', 30000, 1000, 300000),
    emptyRetryMs: bounded('emptyRetryMs', 60000, 1000, 900000),
    heldGraceMs: bounded('heldGraceMs', 150000, 90000, 300000),
    setupDeadlineMs: bounded('setupDeadlineMs', 240000, 60000, 600000),
    minimumFreeBytes: bounded('minimumFreeBytes', 5 * 1024 ** 3, 128 * 1024 ** 2, 1024 ** 4),
  };
}

/** Persistent wall-clock budget: pauses and restarts never buy a fresh allowance. */
export function campaignBudget(config, state, now = Date.now()) {
  const createdAt = Date.parse(state.createdAt ?? '');
  const attemptsStarted = state.attemptsStarted ??
    (state.records.length + (state.activeAttempt ? 1 : 0));
  if (!Number.isSafeInteger(attemptsStarted) || attemptsStarted < state.records.length ||
      !Number.isFinite(now) || (config.maxElapsedMs !== null &&
      (!Number.isFinite(createdAt) || now < createdAt))) fail('CAMPAIGN_BUDGET_STATE_INVALID');
  const naturalGames = new Set(state.records
    .filter((row) => row.natural === true && row.canContinue === true)
    .map((row) => row.gameId)).size;
  const elapsedMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : null;
  const reasons = [];
  if (config.maxNaturalGames !== null && naturalGames >= config.maxNaturalGames)
    reasons.push('natural-game-limit');
  if (config.maxAttempts !== null && attemptsStarted >= config.maxAttempts)
    reasons.push('attempt-limit');
  if (config.maxElapsedMs !== null && elapsedMs >= config.maxElapsedMs)
    reasons.push('elapsed-time-limit');
  return {
    maxNaturalGames: config.maxNaturalGames,
    maxAttempts: config.maxAttempts,
    maxElapsedMs: config.maxElapsedMs,
    startedAt: state.createdAt,
    elapsedMs,
    naturalGames,
    attemptsStarted,
    reached: reasons.length > 0,
    reasons,
  };
}

export function verifyCampaignRuntime(
  config,
  { root = REPO_ROOT, resolveExecutables = resolveRuntimeExecutables } = {},
) {
  const bytes = fs.readFileSync(config.runtimeManifest);
  if (hash(bytes) !== config.runtimeManifestSha256) fail('RUNTIME_MANIFEST_CHANGED');
  const manifest = JSON.parse(bytes);
  if (
    manifest.schema !== 'kf-live-runtime-freeze-v1' ||
    path.resolve(manifest.root) !== path.resolve(root) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 3
  )
    fail('RUNTIME_FREEZE_INVALID');
  const required = new Set([
    'tools/keyteki-live-campaign.mjs',
    'tools/keyteki-live-campaign-worker.mjs',
    'dist/src/ai/style-policy-upgrades.js',
    'dist/src/ai/loop-guard.js',
  ]);
  for (const row of manifest.files) {
    if (
      typeof row.path !== 'string' ||
      path.isAbsolute(row.path) ||
      row.path.split(/[\\/]/).includes('..') ||
      !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
    )
      fail('RUNTIME_FREEZE_PATH_INVALID');
    const file = path.join(root, row.path);
    if (!fs.statSync(file).isFile() || hash(fs.readFileSync(file)) !== row.sha256)
      fail('RUNTIME_BYTES_CHANGED');
    required.delete(row.path);
  }
  if (required.size) fail('RUNTIME_FREEZE_INCOMPLETE');
  if (manifest.sourceFingerprint !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(manifest.sourceFingerprint)) fail('RUNTIME_CONTENT_FINGERPRINT_INVALID');
    const currentFiles = collectRuntimeFiles(root);
    if (
      hash(JSON.stringify(currentFiles)) !== manifest.sourceFingerprint ||
      JSON.stringify(currentFiles) !== JSON.stringify(manifest.files)
    )
      fail('RUNTIME_FILE_SET_CHANGED');
  }

  if (!Array.isArray(manifest.externalFiles) || !manifest.externalFiles.length)
    fail('EXTERNAL_RUNTIME_FREEZE_REQUIRED');
  if (manifest.executables !== undefined) {
    const actual = resolveExecutables();
    if (
      !manifest.executables ||
      Object.keys(manifest.executables).length !== 3 ||
      !['node', 'python', 'chromium'].every(
        (key) =>
          path.isAbsolute(manifest.executables[key] ?? '') &&
          actual[key] === manifest.executables[key] &&
          manifest.externalFiles.some((row) => row.path === actual[key]),
      )
    )
      fail('RUNTIME_EXECUTABLE_SELECTION_CHANGED');
  }
  for (const row of manifest.externalFiles) {
    if (
      !path.isAbsolute(row.path ?? '') ||
      !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') ||
      hash(fs.readFileSync(row.path)) !== row.sha256
    )
      fail('EXTERNAL_RUNTIME_BYTES_CHANGED');
  }
  return {
    sourceCommit: manifest.sourceCommit,
    manifestSha256: config.runtimeManifestSha256,
    verifiedAt: new Date().toISOString(),
  };
}

/** Kernel-held account lease shared by every output/version. The last active run survives a parent crash. */
export async function acquireCampaignAccount(config, { lockRoot = campaignAccountLockRoot() } = {}) {
  fs.mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const key = hash(config.origin + '\n' + config.selfName);
  const stem = path.join(lockRoot, key),
    recordPath = stem + '.json';
  const source =
    'import fcntl,os,sys\nf=os.fdopen(os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600),"r+")\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)\nprint("locked",flush=True)\nsys.stdin.read()\n';
  const child = spawn('python3', ['-c', source, stem + '.lock'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('ACCOUNT_LOCK_TIMEOUT')), 5000);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('locked\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once('error', () => {
        clearTimeout(timer);
        reject(Error('ACCOUNT_LOCK_UNAVAILABLE'));
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('ACCOUNT_ALREADY_RUNNING'));
      });
    });
    const old = json(recordPath);
    if (old?.output) {
      const before = json(path.join(old.output, 'checkpoint.json'));
      if (before?.activeAttempt) fail('PREVIOUS_ACCOUNT_ATTEMPT_UNRESOLVED');
    }
    atomicCampaignJson(recordPath, {
      origin: config.origin,
      selfName: config.selfName,
      output: config.output,
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    });
    return { healthy: () => !exited, close: () => child.stdin.end() };
  } catch (error) {
    child.stdin.end();
    throw error;
  }
}

function readWatchdog(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function campaignSummary(config, state) {
  const natural = state.records.filter((row) => row.natural),
    terminal = state.records.filter((row) => row.terminal);
  return {
    schema: 'keyteki-live-campaign-summary-v1',
    id: config.id,
    updatedAt: state.updatedAt,
    phase: state.phase,
    paused: state.paused,
    pauseReasons: state.pauseReasons,
    strategy: config.seat.self.codePolicy,
    network: config.network,
    budget: state.budget ?? null,
    deckUuid: config.seat.self.deckSelector,
    source: state.runtime,
    activeAttempt: state.activeAttempt,
    health: state.health,
    focus: state.focus,
    focusWaiting: state.focusWaiting ?? null,
    completion: state.completion ?? null,
    disconnectedOpponentDepartures: state.records.filter((row) => row.outcome === 'opponent-disconnected-departure').length,
    natural: {
      games: natural.length,
      wins: natural.filter((row) => row.won).length,
      losses: natural.filter((row) => !row.won).length,
    },
    serverTerminals: {
      games: terminal.length,
      wins: terminal.filter((row) => row.won).length,
      losses: terminal.filter((row) => !row.won).length,
    },
    records: state.records,
  };
}

export async function runLiveCampaign(input, dependencies = {}) {
  const config = normalizeCampaignConfig(input);
  const clock = dependencies.now ?? Date.now;
  fs.mkdirSync(config.output, { recursive: true, mode: 0o700 });
  const configSha256 = hash(JSON.stringify(input));
  const checkpointFile = path.join(config.output, 'checkpoint.json');
  const controlFile = path.join(config.output, 'control.json');
  const before = json(checkpointFile);
  if (before && before.configSha256 !== configSha256) fail('CAMPAIGN_CONFIG_CHANGED');
  if (before?.activeAttempt) fail('CAMPAIGN_ACTIVE_ATTEMPT_REQUIRES_INSPECTION');
  const lease = await (dependencies.acquire ?? acquireCampaignAccount)(config);
  const state = before ?? {
    schema: 'keyteki-live-campaign-state-v1',
    id: config.id,
    configSha256,
    runId: randomUUID(),
    createdAt: new Date(clock()).toISOString(),
    attemptsStarted: 0,
    phase: 'initializing',
    records: [],
    activeAttempt: null,
    paused: false,
    pauseReasons: [],
  };
  const save = () => {
    state.health = campaignHealth(state.records);
    state.focus = focusedCampaignProgress(state.records, config);
    state.budget = campaignBudget(config, state, clock());
    state.updatedAt = new Date().toISOString();
    state.pid = process.pid;
    atomicCampaignJson(checkpointFile, state);
    atomicCampaignJson(path.join(config.output, 'summary.json'), campaignSummary(config, state));
  };
  const setPause = (reason) => {
    state.paused = true;
    if (!state.pauseReasons.includes(reason)) state.pauseReasons.push(reason);
    state.phase = 'paused';
    save();
  };
  let stopRequested = false, budgetReached = false;
  const completeBudget = () => {
    // An in-flight game keeps its normal lifecycle even after the allowance expires.
    if (state.activeAttempt) return false;
    const budget = campaignBudget(config, state, clock());
    if (!budget.reached) return false;
    budgetReached = true;
    state.phase = 'completed-budget';
    state.completion ??= {
      reason: 'campaign-budget',
      reasons: budget.reasons,
      naturalGames: budget.naturalGames,
      attemptsStarted: budget.attemptsStarted,
      elapsedMs: budget.elapsedMs,
      completedAt: new Date(clock()).toISOString(),
    };
    save();
    return true;
  };
  const signal = () => {
    stopRequested = true;
    setPause('operator-stop-after-current');
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  const dispatchCancelled = () => {
    if (!lease.healthy()) setPause('account-lease-lost');
    if (json(controlFile)?.pauseAfterCurrent) setPause('operator-pause-after-current');
    return stopRequested || state.paused;
  };
  const poll = async (ms) => {
    const until = Date.now() + ms;
    do {
      if (!lease.healthy()) {
        setPause('account-lease-lost');
        stopRequested = true;
      }
      if (json(controlFile)?.pauseAfterCurrent) setPause('operator-pause-after-current');
      if (stopRequested || state.paused || completeBudget()) break;
      await pause(Math.min(1000, until - Date.now()));
    } while (Date.now() < until);
  };
  try {
    save();
    while (!stopRequested && !state.paused && !budgetReached) {
      if (dispatchCancelled() || completeBudget()) break;
      const health = campaignHealth(state.records);
      if (health.pause) {
        for (const reason of health.reasons) setPause(reason);
        break;
      }
      const focus = focusedCampaignProgress(state.records, config);
      if (focus?.targetReached) {
        state.phase = 'completed-focus-target';
        state.completion ??= {
          reason: 'focus-natural-game-limit',
          opponentName: config.focusOpponentName,
          naturalGames: focus.naturalGames,
          completedAt: new Date().toISOString(),
        };
        save();
        break;
      }
      if (health.stable && json(controlFile)?.unattendedEnabled !== true) {
        setPause('observation-complete-awaiting-operator-inspection');
        break;
      }
      state.runtime = (dependencies.verifyRuntime ?? verifyCampaignRuntime)(config);
      const free = fs.statfsSync(config.output);
      if (free.bavail * free.bsize < config.minimumFreeBytes) {
        setPause('storage-floor');
        break;
      }
      if (json(controlFile)?.pauseAfterCurrent) {
        setPause('operator-pause-after-current');
        break;
      }
      let snapshot;
      try {
        snapshot = await (dependencies.readLobby ?? readCampaignLobby)({
          profileDir: path.join(config.output, 'lobby-browser'),
          agentId: 'keyforge-tco-bot:lobby-' + config.id,
          origin: config.origin,
          network: config.network,
        });
      } catch (error) {
        state.lobbyFailures = (state.lobbyFailures ?? 0) + 1;
        state.lastLobbyError = /^[A-Z0-9_-]+$/.test(error?.message ?? '')
          ? error.message
          : 'LOBBY_UNAVAILABLE';
        if (state.lobbyFailures >= 3) {
          setPause('consecutive-lobby-failures');
          break;
        }
        state.phase = 'waiting-for-lobby';
        save();
        await poll(config.emptyRetryMs);
        continue;
      }
      if (dispatchCancelled() || completeBudget()) break;
      state.lobbyFailures = 0;
      if (snapshot.rooms.some((row) => Object.hasOwn(row.players, config.selfName))) {
        setPause('account-already-seated');
        break;
      }
      const choice = selectCampaignRoom(snapshot, {
        selfName: config.selfName,
        ownAccountNames: config.ownAccountNames,
        recentAttempts: state.records,
        focusOpponentName: config.focusOpponentName,
      });
      if (choice.reason && choice.reason !== 'no-eligible-room') {
        setPause(choice.reason);
        break;
      }
      if (config.focusOpponentName !== null && !choice.candidate) {
        const targetRoomIds = snapshot.rooms
          .filter((row) => row.owner === config.focusOpponentName)
          .map((row) => row.id);
        state.phase = 'waiting-for-focus-opponent';
        state.focusWaiting = {
          opponentName: config.focusOpponentName,
          since: state.focusWaiting?.since ?? new Date().toISOString(),
          lastLobbyObservedAt: snapshot.observedAt,
          pollMs: config.focusPollMs,
          targetRoomIds,
          targetSkipReasons: [
            ...new Set(
              choice.skipped.filter((row) => targetRoomIds.includes(row.gameId)).map((row) => row.reason),
            ),
          ],
        };
        save();
        await poll(config.focusPollMs);
        continue;
      }
      delete state.focusWaiting;
      const number = state.records.length + 1;
      const attemptId = String(number).padStart(5, '0') + '-' + (choice.candidate ? 'join' : 'create');
      const output = path.join(config.output, 'runs', attemptId);
      fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
      const room = choice.candidate
        ? {
            gameId: choice.candidate.gameId,
            opponentName: choice.candidate.opponentName,
            name: choice.candidate.name,
            gameType: choice.candidate.gameType,
            gameFormat: 'normal',
          }
        : { ...config.seat.room };
      const attemptConfig = { ...config.seat, output, room };
      const attemptFile = path.join(config.output, attemptId + '.json');
      atomicCampaignJson(attemptFile, attemptConfig);
      atomicCampaignJson(path.join(config.output, attemptId + '-selection.json'), {
        snapshot,
        choice,
        runtime: state.runtime,
      });
      if (dispatchCancelled() || completeBudget()) break;
      state.attemptsStarted = (state.attemptsStarted ?? state.records.length) + 1;
      const startedAt = new Date().toISOString();
      state.activeAttempt = {
        attemptId,
        output,
        entry: choice.candidate ? 'join' : 'create',
        gameId: choice.candidate?.gameId ?? null,
        opponentName: choice.candidate?.opponentName ?? null,
        startedAt,
        pid: null,
        state: 'starting',
      };
      state.phase = 'running-attempt';
      save();
      const log = fs.openSync(path.join(config.output, attemptId + '.log'), 'a', 0o600);
      const args = [
        path.join(REPO_ROOT, 'tools/keyteki-live-campaign-worker.mjs'),
        '--config',
        attemptFile,
        ...(choice.candidate ? [] : ['--create-public']),
      ];
      const child = (dependencies.spawnWorker ?? spawn)(process.execPath, args, {
        cwd: REPO_ROOT,
        stdio: ['ignore', log, log],
        env: process.env,
      });
      fs.closeSync(log);
      state.activeAttempt.pid = child.pid;
      save();
      let exitCode = null,
        exited = false,
        holdSince = null;
      child.once('error', () => {
        exitCode = 1;
        exited = true;
      });
      child.once('exit', (code) => {
        exitCode = code ?? 1;
        exited = true;
      });
      while (!exited) {
        const handoff = json(path.join(output, 'handoff.json'));
        if (handoff) {
          Object.assign(state.activeAttempt, {
            phase: handoff.phase,
            gameId: handoff.gameId,
            opponentName:
              handoff.participants?.find((name) => name !== config.selfName) ??
              state.activeAttempt.opponentName,
            fullVerified: handoff.fullVerified === true,
            finished: handoff.finished === true,
            publicView: handoff.finalPublicView ?? null,
            gameplayDiagnostics: handoff.gameplayDiagnostics ?? null,
            held: handoff.held === true,
            holdReason: handoff.holdReason ?? null,
            hostRestarts: handoff.hostRestarts ?? 0,
            watchdogPhase: handoff.watchdog?.phase ?? null,
            disconnectedOpponentExit: handoff.disconnectedOpponentExit ? {
              phase: handoff.disconnectedOpponentExit.phase,
              reasonCode: handoff.disconnectedOpponentExit.reasonCode ?? null,
              leaveUiAttempts: handoff.disconnectedOpponentExit.leaveUiAttempts,
            } : null,
            createdPendingExit: handoff.createdPendingExit
              ? { phase: handoff.createdPendingExit.phase, reason: handoff.createdPendingExit.reason ?? null,
                  readiness: handoff.createdPendingExit.readiness ?? null,
                  uiLeaveAttempts: handoff.createdPendingExit.uiLeaveAttempts,
                  nativeLeaveSends: handoff.createdPendingExit.nativeLeaveSends }
              : null,
            joinedPendingExit: handoff.joinedPendingExit
              ? {
                  phase: handoff.joinedPendingExit.phase,
                  reason: handoff.joinedPendingExit.reason ?? null,
                  uiLeaveAttempts: handoff.joinedPendingExit.uiLeaveAttempts,
                  nativeLeaveSends: handoff.joinedPendingExit.nativeLeaveSends,
                }
              : null,
          });
          if (handoff.disconnectedOpponentExit?.phase === 'blocked-preserved')
            setPause('opponent-disconnect-retirement-unconfirmed');
          if (handoff.joinedPendingExit?.phase === 'blocked-preserved')
            setPause('joined-pending-retirement-unconfirmed');
          if (handoff.createdPendingExit?.phase === 'blocked-preserved')
            setPause('created-pending-retirement-unconfirmed');
          if (handoff.evidenceWriteFailures > 0) setPause('evidence-write-failure');
          if (handoff.operatorPaused) setPause('operator-paused-current-game');
          if (handoff.held && !handoff.finished) holdSince ??= Date.now();
          else holdSince = null;
          if (holdSince && Date.now() - holdSince >= config.heldGraceMs) setPause('current-game-unresolved');
          if (handoff.roomExit?.phase === 'leave-unconfirmed' || handoff.finishRetirementError)
            setPause('room-retirement-unconfirmed');
          if (
            !handoff.fullVerified &&
            !handoff.finishedNoOpponent &&
            Date.now() - Date.parse(startedAt) > config.setupDeadlineMs
          )
            setPause('setup-not-completed');
        }
        if (!lease.healthy()) setPause('account-lease-lost');
        if (json(controlFile)?.pauseAfterCurrent) setPause('operator-pause-after-current');
        save();
        // Keep the binding-owning child alive during an unresolved game. A pause stops only new matchmaking.
        await pause(2000);
      }
      const handoff = json(path.join(output, 'handoff.json'), {});
      const record = classifyCampaignAttempt({
        handoff,
        selfName: config.selfName,
        origin: config.origin,
        noOpponent: json(path.join(output, 'no-opponent.json')),
        watchdogEvents: readWatchdog(path.join(output, 'watchdog-events.jsonl')),
        expectedGameId: state.activeAttempt.gameId,
        exitCode,
        attemptId,
        startedAt,
        endedAt: new Date().toISOString(),
      });
      Object.assign(record, {
        entry: state.activeAttempt.entry,
        output,
        codePolicy: config.seat.self.codePolicy,
        runtimeManifestSha256: config.runtimeManifestSha256,
        hostRestarts: handoff.hostRestarts ?? 0,
        matchDetails: json(path.join(output, 'match-details.json')),
        lastGameplayFault: handoff.lastGameplayFault ?? null,
        gameplayDiagnostics: handoff.gameplayDiagnostics ?? null,
        evidenceWriteFailures: handoff.evidenceWriteFailures ?? 0,
      });
      atomicCampaignJson(path.join(config.output, attemptId + '-result.json'), record);
      state.records.push(record);
      if (record.canContinue || (record.preparationFailure && record.finalized && record.seatReleased &&
          record.runtimeRetired && exitCode === 0)) state.activeAttempt = null;
      if (!record.canContinue) setPause(record.continuationBlock ?? 'attempt-not-retired');
      const nextHealth = campaignHealth(state.records);
      if (nextHealth.pause) for (const reason of nextHealth.reasons) setPause(reason);
      save();
      if (!state.paused && !completeBudget() && !focusedCampaignProgress(state.records, config)?.targetReached)
        await poll(
          ['no-opponent', 'joined-pending-departure', 'created-pending-departure'].includes(record.outcome)
            ? config.emptyRetryMs
            : config.betweenGamesMs,
        );
    }
    save();
    return state;
  } catch (error) {
    const code = /^[A-Z0-9_-]+$/.test(error?.code ?? error?.message ?? '')
      ? (error.code ?? error.message)
      : 'SUPERVISOR_FAILURE';
    try {
      setPause(code);
    } catch {}
    throw error;
  } finally {
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    lease.close();
  }
}

export function campaignControl(input, action) {
  const config = normalizeCampaignConfig(input),
    file = path.join(config.output, 'checkpoint.json');
  const state = json(file);
  if (!state) fail('CAMPAIGN_NOT_STARTED');
  const controlFile = path.join(config.output, 'control.json'),
    old = json(controlFile, {});
  if (action === 'pause') {
    atomicCampaignJson(controlFile, { ...old, pauseAfterCurrent: true, updatedAt: new Date().toISOString() });
  } else if (action === 'enable-unattended') {
    if (campaignBudget(config, state).reached) fail('CAMPAIGN_BUDGET_EXHAUSTED');
    if (
      state.activeAttempt ||
      !campaignHealth(state.records).stable ||
      state.pauseReasons.some((reason) => reason !== 'observation-complete-awaiting-operator-inspection')
    )
      fail('STABLE_OBSERVATION_REQUIRED');
    atomicCampaignJson(controlFile, {
      ...old,
      unattendedEnabled: true,
      pauseAfterCurrent: false,
      updatedAt: new Date().toISOString(),
    });
    atomicCampaignJson(file, {
      ...state,
      paused: false,
      pauseReasons: [],
      phase: 'ready-for-unattended',
      reviewedAt: new Date().toISOString(),
    });
    const summaryFile = path.join(config.output, 'summary.json'),
      summary = json(summaryFile);
    if (summary)
      atomicCampaignJson(summaryFile, {
        ...summary,
        paused: false,
        pauseReasons: [],
        phase: 'ready-for-unattended',
        updatedAt: new Date().toISOString(),
      });
  } else if (action !== 'status') fail('CAMPAIGN_CONTROL_UNKNOWN');
  return json(path.join(config.output, 'summary.json'), state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void (async () => {
    const args = process.argv.slice(2),
      i = args.indexOf('--config');
    if (i < 0 || !args[i + 1]) fail('CAMPAIGN_CONFIG_REQUIRED');
    const input = json(path.resolve(args[i + 1]));
    if (args.includes('--run')) await runLiveCampaign(input);
    else {
      const action = args.includes('--pause')
        ? 'pause'
        : args.includes('--enable-unattended')
          ? 'enable-unattended'
          : 'status';
      console.log(JSON.stringify(campaignControl(input, action), null, 2));
    }
  })().catch((error) => {
    console.error(
      JSON.stringify({
        event: 'live-campaign-failed',
        code: /^[A-Z0-9_-]+$/.test(error?.code ?? error?.message ?? '')
          ? (error.code ?? error.message)
          : 'CAMPAIGN_FAILURE',
      }),
    );
    process.exitCode = 1;
  });
}
