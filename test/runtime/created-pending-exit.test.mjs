import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mockPendingDocumentSession } from '../helpers/pending-document-session.mjs';
import { createJoinedPendingRoomTracker } from '../../tools/keyteki-joined-pending-exit.mjs';
import { createdPendingReadiness, createdPendingSeatReleased, retireCreatedPendingRoom } from '../../tools/keyteki-created-pending-exit.mjs';
import { PublicRoomObserver, startOwnBoundRoomUi } from '../../tools/keyteki-human-public-room-ui.mjs';
import { lockCreatedPublicPair } from '../../tools/keyteki-human-create-public.mjs';
import { normalizeHumanConfig } from '../../tools/keyteki-human-config.mjs';
import { classifyCampaignAttempt, campaignHealth } from '../../tools/keyteki-live-campaign-policy.mjs';
import { runLiveCampaign } from '../../tools/keyteki-live-campaign.mjs';

const self = 'ExampleBot', opponent = 'ExampleHuman', gameId = 'created-room-fixture';
const frame = (...args) => '42' + JSON.stringify(args);
const origin = 'https://thecrucible.online';
const rawConfig = () => ({ schema: 'keyteki-human-one-seat-draft-v1', origin,
  self: { name: self, deckName: 'Example Deck', serverDeckId: 23 }, ownAccountNames: [self],
  room: { name: 'AI fixture', gameType: 'beginner', gameFormat: 'normal' },
  credentialsPath: '/fixture/credentials.json', output: '/fixture/attempt', setupTimeoutMs: 1000,
  leaveAfterFinish: true,
});
const native = ({ names = [self, opponent], selected = true, otherSelected = false, deckName = 'Example Deck',
  owner = self, started = false } = {}) => ({ id: gameId, name: 'AI fixture', owner, started,
  gamePrivate: false, needsPassword: false, gameType: 'beginner', gameFormat: 'normal',
  players: Object.fromEntries(names.map(name => [name, { name, id: name === self ? 'own-socket' : 'other-socket',
    deck: { selected: name === self ? selected : otherSelected, name: name === self ? deckName : 'Other Deck' } }])) });

function fixture(options = {}) {
  const initial = normalizeHumanConfig({ ...rawConfig(), ...(options.origin ? { origin: options.origin } : {}) }, { createPublic: true });
  const config = normalizeHumanConfig({ ...rawConfig(), origin: initial.origin,
    room: { ...rawConfig().room, gameId, opponentName: opponent } });
  const clock = { value: 100000 };
  const tracker = createJoinedPendingRoomTracker(initial, { created: true, now: () => clock.value });
  const metadata = { transportKey: 'native-transport', transportKind: 'websocket', channelId: 'native-channel' };
  const ingest = (payload, more = {}) => tracker.ingest(payload, { ...metadata, creationRequested: true, ...more });
  tracker.observeTransport('socket-open', metadata);
  ingest('0{"sid":"native-transport","pingInterval":25000,"pingTimeout":20000}');
  ingest('40{"sid":"own-socket"}');
  ingest(frame('gamestate', native({ names: [self], selected: false })));
  ingest(frame('selectdeck', gameId, 23, false), { sent: true });
  ingest(frame('gamestate', native()));
  tracker.bindCreatedPair(config);
  const state = { gameId, participants: [self, opponent], phase: 'waiting-for-human-deck',
    fullVerified: false, finished: false, held: false, bridgeStatus: null, finalPublicView: null,
    createdPreparationWait: { code: 'HUMAN_DECK_NOT_READY', startedAt: 98000, deadlineAt: 99000, expiredAt: 100000 } };
  const calls = { clicks: 0, probes: 0, hosts: 0, stop: 0, release: 0, quiesce: 0, dispose: 0 };
  const context = { browser: () => ({ fixture: true }) };
  const page = { url: () => config.origin + '/play', context: () => context,
    getByRole: (role, { name }) => {
      assert.equal(role, 'button'); assert.equal(name.test('Leave'), true); assert.equal(name.test('Leave Game'), false);
      assert.equal(name.test('Concede'), false);
      return { isVisible: async () => true, isEnabled: async () => true, click: async () => {
        calls.clicks++;
        options.beforeClick?.(f);
        ingest(options.leaveFrame ?? frame('leavegame', gameId), { sent: true });
        if (options.ack !== false) {
          ingest(frame('cleargamestate'));
          // A remaining opponent owns the original pending room after our normal Leave.
          ingest(frame('updategame', [native({ names: [opponent], owner: opponent })]));
        }
        if (options.clickThrows) throw Error('UI click response lost');
      } };
    } };
  const hostIdentity = { runId: 'a'.repeat(32), pid: 12345 };
  const deps = { page, config, state, tracker, hostIdentity, now: () => clock.value,
    wait: async ms => { clock.value += ms; }, timings: { proofMs: 1000, ackMs: 300, maxAgeMs: 30000 },
    inspectHost: async () => {
      calls.hosts++; await options.onHost?.(f);
      return { ...hostIdentity, paused: false, stopping: false, sessions: [], restoredSessions: [] };
    },
    probe: async () => {
      calls.probes++; await options.onProbe?.(f);
      return { source: 'native-lobby', nativeFullRoster: true, anonymous: true, origin: config.origin,
        fullObservedAt: clock.value, rooms: calls.probes === 1 ? [native(options.current)]
          : options.stillSeated ? [native()] : [native({ names: [opponent], owner: opponent })] };
    },
    externalCancellation: () => options.cancelled?.(f) ?? false,
    quiesce: async () => { calls.quiesce++; },
    stopHost: async () => { calls.stop++; await options.onStop?.(f); return { stopped: true, ...hostIdentity,
      retirementId: 'b'.repeat(32), operatorUnchanged: () => !options.operatorChanged?.(f) }; },
    release: async () => {
      calls.release++; await options.onRelease?.(f);
      tracker.observeTransport('socket-close', metadata);
      return { managed: true, leaseReleased: true, agentId: 'fixture-agent' };
    },
    afterRetired: async () => { calls.dispose++; }, save: () => {},
  };
  const f = { config, initial, clock, tracker, metadata, ingest, state, page, calls, deps,
    retire: () => retireCreatedPendingRoom(deps),
    classify: (exitCode = 0) => classifyCampaignAttempt({ handoff: state, selfName: self, origin: config.origin, exitCode }),
    released: () => createdPendingSeatReleased(state.createdPendingExit,
      { origin: config.origin, gameId, selfName: self, participants: [self, opponent] }),
  };
  if (options.current) ingest(frame('gamestate', native(options.current)));
  return f;
}

for (const [label, site, leaveFrame] of [
  ['international game-bound Leave', origin, frame('leavegame', gameId)],
  ['Fuzhou legacy Leave', 'https://keyforge.example', frame('leavegame')],
]) test('a verified own-created preparation timeout retires through ' + label, async () => {
  const f = fixture({ origin: site, leaveFrame });
  assert.equal(await f.retire(), true);
  assert.deepEqual(f.calls, { clicks: 1, probes: 2, hosts: 3, stop: 1, release: 1, quiesce: 1, dispose: 1 });
  assert.equal(f.released(), true);
  assert.equal(f.state.phase, 'created-pending-retired');
  assert.equal(f.state.createdPendingExit.readiness.reason, 'opponent-deck-not-ready');
  const waiting = f.classify(null);
  assert.equal(waiting.canContinue, false); assert.equal(waiting.finalized, false);
  assert.equal(waiting.continuationBlock, 'awaiting-driver-exit');
  const completed = f.classify(0);
  assert.equal(completed.outcome, 'created-pending-departure'); assert.equal(completed.canContinue, true);
  assert.equal(completed.started, false); assert.equal(completed.natural, false); assert.equal(completed.won, null);
  const health = campaignHealth([completed]);
  assert.equal(health.waitingAttempts, 1); assert.equal(health.completedGames, 0);
  assert.equal(health.naturalGames, 0); assert.equal(health.technicalFailures, 0); assert.equal(health.pause, false);
  assert.equal(f.classify(1).canContinue, false); assert.equal(f.classify(1).continuationBlock, 'driver-exit-not-clean');
});

test('the real compound Start readiness timeout enters cancellation without clicking Start', async () => {
  const f = fixture();
  const observer = { assertHealthy: () => {}, active: false, pending: f.tracker.snapshot().current };
  await assert.rejects(startOwnBoundRoomUi(f.page, observer, { ...f.config, setupTimeoutMs: 1 }),
    { code: 'HUMAN_DECK_NOT_READY' });
  assert.equal(f.calls.clicks, 0);
  assert.equal(await f.retire(), true); assert.equal(f.calls.clicks, 1);
});

for (const [label, current, selection] of [
  ['our selected flag disappeared', { selected: false }],
  ['our deck name changed', { deckName: 'Unexpected Deck' }],
  ['both selected but readiness still timed out', { otherSelected: true }],
  ['a later selection lacks matching state', {}, 24],
]) test('safe cancellation preserves preparation failure when ' + label, async () => {
  const f = fixture({ current });
  if (selection) f.ingest(frame('selectdeck', gameId, selection, false), { sent: true });
  assert.equal(await f.retire(), true); assert.equal(f.released(), true);
  assert.equal(f.state.preparationFailure, true);
  const row = f.classify();
  assert.equal(row.outcome, 'setup-failure-retired'); assert.equal(row.preparationFailure, true);
  assert.equal(row.seatReleased, true); assert.equal(row.runtimeRetired, true); assert.equal(row.finalized, true);
  assert.equal(row.canContinue, false); assert.equal(row.continuationBlock, 'preparation-failure-retired');
  assert.equal(row.started, false); assert.equal(row.natural, false); assert.equal(row.won, null);
  const health = campaignHealth([row]);
  assert.equal(health.pause, true); assert.deepEqual(health.reasons, ['preparation-failure-retired']);
  assert.equal(health.preparationFailures, 1); assert.equal(health.waitingAttempts, 0);
  assert.equal(health.completedGames, 0); assert.equal(health.naturalGames, 0);
});

test('the original bound opponent may depart without misclassifying our verified deck', async () => {
  const f = fixture({ current: { names: [self] } });
  assert.equal(createdPendingReadiness(f.tracker.snapshot(), f.config).reason, 'opponent-left-before-start');
  assert.equal(await f.retire(), true); assert.equal(f.classify().canContinue, true);
});

test('production observer tracks creation and selection before binding the immutable pair', async () => {
  const input = rawConfig(), config = normalizeHumanConfig(input, { createPublic: true });
  const page = new EventEmitter(), socket = new EventEmitter();
  page.url = () => origin + '/play'; socket.url = () => origin.replace('https:', 'wss:') + '/socket.io/?transport=websocket';
  mockPendingDocumentSession(page);
  const observer = new PublicRoomObserver(page, config);
  await observer.ready;
  try {
    page.emit('websocket', socket); observer.creationRequested = true;
    const receive = payload => socket.emit('framereceived', { payload });
    receive('0{"sid":"engine","pingInterval":25000,"pingTimeout":20000}');
    receive('40{"sid":"own-socket"}');
    receive(frame('gamestate', native({ names: [self], selected: false })));
    socket.emit('framesent', { payload: frame('selectdeck', gameId, 23, false) });
    receive(frame('gamestate', native()));
    const bound = lockCreatedPublicPair(input, observer);
    assert.equal(bound.config.room.gameId, gameId); assert.equal(bound.config.room.opponentName, opponent);
    const tracked = observer.createdPending.snapshot();
    assert.equal(tracked.createdPair.playerName, self); assert.equal(tracked.createdPair.opponentName, opponent);
    assert.equal(tracked.createdPair.selection.serverDeckId, 23);
    assert.equal(observer.createdPending.checkContinuity().verified, true);
    receive(frame('gamestate', native({ started: true })));
    assert.equal(observer.createdPending.snapshot().everStarted, true);
    assert.throws(() => observer.createdPending.beginLeave(), /LEAVE_NOT_ELIGIBLE/);
  } finally { observer.dispose(); }
});

for (const [label, change] of [
  ['native active game', f => f.ingest(frame('gamestate', native({ started: true })))],
  ['Start already requested', f => f.ingest(frame('startgame', gameId), { sent: true })],
  ['replaced native transport', f => f.ingest(frame('selectdeck', gameId, 23, false), { sent: true, transportKey: 'replaced' })],
  ['closed native connection', f => f.tracker.observeTransport('socket-close', f.metadata)],
  ['changed document', f => f.tracker.documentChanged(1)],
  ['silent native connection', f => { f.clock.value += 45001; }],
  ['changed room identity', f => f.ingest(frame('gamestate', { ...native(), id: 'another-room' }))],
  ['a different opponent', f => f.ingest(frame('gamestate', native({ names: [self, 'Replacement'] })))],
  ['operator hold', f => { f.state.operatorPaused = true; }],
  ['unknown game send', f => { f.state.bridgeStatus = 'send-outcome-unknown'; }],
  ['queued gameplay', f => { f.state.gameplayDiagnostics = { stats: { queuedCommands: 1 } }; }],
  ['unexpired readiness deadline', f => { f.state.createdPreparationWait.deadlineAt = f.clock.value + 1; }],
]) test('preparation retirement preserves an unresolved seat after ' + label, async () => {
  const f = fixture(); change(f);
  assert.equal(await f.retire(), false); assert.equal(f.state.createdPendingExit.phase, 'blocked-preserved');
  assert.equal(f.calls.clicks, 0); assert.equal(f.calls.stop, 0); assert.equal(f.calls.release, 0);
  assert.equal(f.state.runtimeRetired, undefined); assert.equal(f.classify().canContinue, false);
});

test('a game starting during the independent roster probe blocks even the pending Leave click', async () => {
  const f = fixture({ onProbe: f => { if (f.calls.probes === 1) f.ingest(frame('gamestate', native({ started: true }))); } });
  assert.equal(await f.retire(), false); assert.equal(f.calls.clicks, 0); assert.equal(f.calls.stop, 0);
});

for (const [label, options] of [
  ['missing native acknowledgement', { ack: false }],
  ['wrong room Leave opcode', { leaveFrame: frame('leavegame', 'wrong-room') }],
  ['ambiguous Leave opcode', { leaveFrame: frame('leavegame', gameId, 'extra') }],
  ['account still present in the fresh full roster', { stillSeated: true }],
]) test('a single normal Leave cannot release resources with ' + label, async () => {
  const f = fixture(options);
  assert.equal(await f.retire(), false); assert.equal(f.calls.clicks, 1);
  assert.equal(f.calls.stop, 0); assert.equal(f.calls.release, 0); assert.equal(f.released(), false);
  await assert.rejects(f.retire(), { code: 'CREATED_PENDING_EXIT_ALREADY_ATTEMPTED' });
  assert.equal(f.calls.clicks, 1);
});

test('an uncertain UI click is resolved only by its already observed exact native send and acknowledgement', async () => {
  const f = fixture({ clickThrows: true });
  assert.equal(await f.retire(), true); assert.equal(f.calls.clicks, 1);
  assert.equal(f.state.createdPendingExit.uiClickUnconfirmed, true); assert.equal(f.released(), true);
});

test('late operator stop and changed host identity preserve the remaining resources', async () => {
  const cancelled = fixture({ cancelled: f => f.calls.probes === 2 });
  assert.equal(await cancelled.retire(), false); assert.equal(cancelled.calls.stop, 0); assert.equal(cancelled.calls.release, 0);
  const changed = fixture();
  changed.deps.inspectHost = async () => ({ runId: 'c'.repeat(32), pid: 12345, sessions: [], restoredSessions: [] });
  assert.equal(await changed.retire(), false); assert.equal(changed.calls.clicks, 0);
  const intervened = fixture({ operatorChanged: () => true });
  assert.equal(await intervened.retire(), false); assert.equal(intervened.calls.stop, 1); assert.equal(intervened.calls.release, 0);
});

test('receipt tampering cannot turn a released preparation failure into a neutral or natural game', async () => {
  const f = fixture({ current: { selected: false } }); assert.equal(await f.retire(), true);
  const original = structuredClone(f.state.createdPendingExit);
  for (const mutate of [
    r => { r.readiness.preparationFailure = false; },
    r => { r.readiness.reason = 'opponent-deck-not-ready'; },
    r => { r.beforeLeave.current.ownSelected = true; },
    r => { r.nativeLeave.sentOrdinal = r.leaveIntent.nativeOrdinal; },
    r => { r.nativeLeave.acknowledgement.gameId = 'other'; },
    r => { r.after.roster.fullObservedAt = r.after.probeStartedAt - 1; },
    r => { r.after.native.everStarted = true; },
    r => { r.hostBeforeRetirement.sessionCount = 1; },
    r => { r.hostStopped.runId = 'x'; },
    r => { r.browserReleased.leaseReleased = false; },
    r => { r.beforeLeave.continuity.verified = false; },
    r => { r.timeout.code = 'ANY_OTHER_FAILURE'; },
  ]) {
    f.state.createdPendingExit = structuredClone(original); mutate(f.state.createdPendingExit);
    assert.equal(f.released(), false); assert.equal(f.classify().canContinue, false);
    assert.equal(f.classify().natural, false);
  }
});

test('a retired preparation failure clears the real campaign active attempt but pauses all new dispatch', async t => {
  const f = fixture({ current: { selected: false } }); assert.equal(await f.retire(), true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-created-pending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let spawns = 0, leaseClosed = 0;
  const config = { schema: 'keyteki-live-campaign-v1', id: 'pending-fixture', output: path.join(dir, 'campaign'),
    runtimeManifest: path.join(dir, 'runtime-manifest.json'), runtimeManifestSha256: 'a'.repeat(64),
    minimumFreeBytes: 128 * 1024 ** 2, betweenGamesMs: 1000, emptyRetryMs: 1000, seat: rawConfig() };
  const result = await runLiveCampaign(config, {
    acquire: async () => ({ healthy: () => true, close: () => { leaseClosed++; } }),
    verifyRuntime: () => ({ sourceCommit: 'fixture' }),
    readLobby: async () => ({ source: 'native-lobby', nativeFullRoster: true, observedAt: Date.now(), rooms: [] }),
    spawnWorker: (_exec, args) => {
      spawns++; const child = new EventEmitter(); child.pid = 10000;
      child.kill = () => { throw Error('Do not force-stop a worker'); };
      const attempt = JSON.parse(fs.readFileSync(args[args.indexOf('--config') + 1]));
      setImmediate(() => {
        fs.mkdirSync(attempt.output, { recursive: true });
        fs.writeFileSync(path.join(attempt.output, 'handoff.json'), JSON.stringify(f.state));
        child.emit('exit', 0);
      });
      return child;
    },
  });
  assert.equal(spawns, 1); assert.equal(leaseClosed, 1); assert.equal(result.activeAttempt, null);
  assert.equal(result.paused, true); assert.equal(result.records.length, 1);
  assert.equal(result.records[0].outcome, 'setup-failure-retired');
  assert.equal(result.records[0].finalized, true); assert.equal(result.records[0].canContinue, false);
  assert.deepEqual(result.pauseReasons, ['preparation-failure-retired']);
  assert.equal(result.health.completedGames, 0); assert.equal(result.health.preparationFailures, 1);
});

test('polling POST selection updates the same production observer and immutable created-pair evidence', async () => {
  const input = rawConfig(), config = normalizeHumanConfig(input, { createPublic: true });
  const page = new EventEmitter(); page.url = () => origin + '/play';
  mockPendingDocumentSession(page);
  const observer = new PublicRoomObserver(page, config); await observer.ready; observer.creationRequested = true;
  const exchange = async (method, payload, sid = 'poll-engine') => {
    const url = origin + '/socket.io/?transport=polling' + (sid ? '&sid=' + sid : '');
    const request = { url: () => url, method: () => method, postData: () => payload };
    page.emit('request', request);
    await observer.onResponse({ url: () => url, request: () => request, status: () => 200,
      text: async () => method === 'GET' ? payload : 'ok' });
  };
  try {
    await exchange('GET', '0{"sid":"poll-engine","pingInterval":25000,"pingTimeout":20000}', null);
    await exchange('GET', '40{"sid":"own-socket"}\x1e' + frame('gamestate', native({ names: [self], selected: false })));
    await exchange('POST', frame('selectdeck', gameId, 23, false));
    assert.equal(observer.selection.serverDeckId, 23);
    await exchange('GET', frame('gamestate', native()));
    lockCreatedPublicPair(input, observer);
    assert.equal(observer.createdPending.snapshot().createdPair.selection.serverDeckId, 23);
    assert.equal(observer.createdPending.checkContinuity().kind, 'polling');
  } finally { observer.dispose(); }
});

test('public creation retains private-room and owned-opponent guards', () => {
  for (const [change, ownNames] of [
    [{ gamePrivate: true }, [self]],
    [{ needsPassword: true }, [self]],
    [{}, [self, opponent]],
  ]) {
    const initial = normalizeHumanConfig({ ...rawConfig(), ownAccountNames: ownNames }, { createPublic: true });
    const tracker = createJoinedPendingRoomTracker(initial, { created: true });
    tracker.ingest('40{"sid":"own-socket"}');
    tracker.ingest(frame('gamestate', { ...native(), ...change }), { creationRequested: true });
    assert.equal(tracker.snapshot().joined, null);
    assert.throws(() => tracker.bindCreatedPair({ ...initial, room: { ...initial.room, gameId, opponentName: opponent },
      participants: [self, opponent] }), /CREATED_PENDING_PAIR_NOT_VERIFIED/);
  }
});

test('the original HUMAN_DECK_NOT_READY alone cannot certify a historical room retirement', () => {
  const row = classifyCampaignAttempt({ selfName: self, origin, exitCode: null, handoff: {
    gameId, participants: [self, opponent], fullVerified: false, held: true,
    holdReason: 'HUMAN_DECK_NOT_READY', phase: 'held-for-inspection',
  } });
  assert.equal(row.outcome, 'setup-unresolved'); assert.equal(row.seatReleased, false);
  assert.equal(row.runtimeRetired, false); assert.equal(row.canContinue, false);
  assert.equal(row.natural, false); assert.equal(row.preparationFailure, false);
});
