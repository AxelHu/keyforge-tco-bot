import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { createWatchdogNativeObserver } from '../../tools/keyteki-human-watchdog.mjs';
import { userscriptBootstrap } from '../../tools/keyteki-browser-bootstrap.mjs';
import { normalizeHumanConfig } from '../../tools/keyteki-human-config.mjs';
import { installDisconnectedOpponentExit, currentDisconnectedOpponentProof } from '../../tools/keyteki-disconnected-opponent-exit.mjs';
import { normalizeDisconnectedOpponentExit, verifiedDisconnectedDeparture } from '../../tools/keyteki-disconnected-exit-contract.mjs';
import { acceptAutomaticDisconnectedStop, stopDisconnectedHost } from '../../tools/keyteki-disconnected-host-stop.mjs';
import { recordHostOperatorIntent, hostOperatorIntentFingerprint } from '../../tools/keyteki-host-operator-intent.mjs';
import { classifyCampaignAttempt, campaignHealth } from '../../tools/keyteki-live-campaign-policy.mjs';

const origin = 'https://thecrucible.online', gameId = 'disconnect-fixture';
const identity = { gameId, playerName: 'Self', participants: ['Self', 'Visitor'] };
const hostIdentity = { runId: 'a'.repeat(32), pid: 12345, configSha256: 'b'.repeat(64) };
const waitingRaw = () => ({ id: gameId, started: true, manualMode: false, winner: null, turn: 1, messages: [],
  players: { Self: { name: 'Self', activePlayer: false, disconnected: false, phase: 'setup',
    menuTitle: 'Waiting for opponent...', buttons: [], controls: [], stats: { amber: 0, keys: {} },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] } },
  Visitor: { name: 'Visitor', activePlayer: true, disconnected: true, phase: 'setup',
    menuTitle: 'Mulligan?', buttons: [], controls: [], stats: { amber: 0, keys: {} },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] } } } });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const notice = 'Visitor has disconnected. Self may wait for them to reconnect, or after 30 seconds may leave without recording a loss.';

/** Production userscript, native observer, page action, and exit coordinator; native transport and lobby are isolated fixtures. */
async function fixture(t, options = {}) {
  let time = 1000000, latestReceipt, ws, operator = false, fingerprint = 'c'.repeat(64), raw = waitingRaw();
  let dropNextNativeFrame = false;
  const calls = [], sends = [], storage = new Map();
  const config = { origin, participants: identity.participants, self: { name: 'Self' }, room: { gameId },
    profile: '/fixture/profile', disconnectedOpponentExit: { enabled: true, waitMs: 120000 } };
  const state = { gameId, participants: identity.participants, fullVerified: true, finished: false, held: false,
    finalPublicView: { gameId, playerName: 'Self', started: true, winner: null,
      players: { Self: { keys: [] }, Visitor: { keys: [] } } } };
  const observer = createWatchdogNativeObserver({ identity, validateFull: () => {}, onState: (_raw, receipt) => { latestReceipt = receipt; } });
  class NativeSocket {
    constructor() { this.readyState = 1; this.events = new Map(); }
    addEventListener(name, fn) { this.events.set(name, [...(this.events.get(name) ?? []), fn]); }
    send(value) { for (const part of value.split('\x1e')) sends.push(JSON.parse(part.slice(part.indexOf('[')))); }
    emit(value) { for (const fn of this.events.get('message') ?? []) fn({ data: value }); }
  }
  class NativeXHR {
    open() {}
    addEventListener() {}
    send(value) { for (const part of value.split('\x1e')) sends.push(JSON.parse(part.slice(part.indexOf('[')))); }
  }
  class FixtureDate extends Date { static now() { return time; } }
  const element = (text) => ({ textContent: text, disabled: false, getClientRects: () => [{}], getAttribute: () => null });
  const alert = element(notice), leave = element('Leave Game');
  leave.click = () => { calls.push('ui-leave'); ws.send('42["game","leavegame"]'); };
  const context = { WebSocket: NativeSocket, XMLHttpRequest: NativeXHR, URL, crypto: webcrypto, Date: FixtureDate,
    location: { origin, href: origin + '/play' }, console: { info() {}, warn() {} },
    setInterval: () => 1, setTimeout, clearTimeout, addEventListener() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { querySelectorAll: (selector) => selector === 'button' ? [leave] : [alert] },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    __kfWatchdogFrame: (frame) => {
      if (dropNextNativeFrame) { dropNextNativeFrame = false; return { accepted: false }; }
      return observer.receive(frame);
    },
    __kfGMRequest: async (request) => {
      const data = JSON.parse(request.data);
      return { status: 200, responseText: JSON.stringify({ gameId, documentId: data.documentId ?? data.sessionId,
        ownerEpoch: 1, receiptOrdinal: 1, sendPending: null, status: 'waiting-for-opponent' }) };
    },
  };
  context.window = context; context.top = context; vm.createContext(context);
  vm.runInContext(userscriptBootstrap({ url: 'http://127.0.0.1:32123', token: 'd'.repeat(64),
    playerName: 'Self', managedSessions: true,
    humanWatchdog: { enabled: true, gameId, participants: identity.participants, language: 'en',
      allowDisconnectedOpponentExit: true } },
    fs.readFileSync(new URL('../../tools/keyteki-shared-strategy.user.js', import.meta.url), 'utf8')), context);
  ws = new context.WebSocket('wss://thecrucible.online/node-1/socket.io/?transport=websocket');
  ws.emit('0{"sid":"fixture-engine"}'); ws.emit('42' + JSON.stringify(['gamestate', raw])); await flush();
  ws.emit('42' + JSON.stringify(['gamestate', raw])); await flush();
  const guardian = context.__kfHumanFaultGuardian;
  const host = () => ({ ...hostIdentity, paused: false, stopping: false, restoredSessions: [], sessions: [{
    origin, gameId, playerName: 'Self', documentId: guardian.snapshot().documentId, ownerEpoch: 1,
    status: 'waiting-for-opponent', sendPending: null, pendingDeliveries: [], modelInFlight: false,
    stats: { commands: 2, queuedCommands: 2, acknowledged: 2 } }] });
  const page = { url: () => origin + '/play', evaluate: async (fn, arg) => {
    if (options.beforeEvaluate) await options.beforeEvaluate(fn, arg, f);
    context.__arg = arg;
    return vm.runInContext('(' + fn.toString() + ')(__arg)', context);
  } };
  const membership = (present, ordinal) => ({ gameId, playerName: 'Self', seatPresent: present,
    ownSeatPreviouslyObserved: true, source: present ? 'games' : 'updategame', ordinal,
    ...(present ? {} : { serverSeatAbsent: true }) });
  const watchdog = { snapshot: async () => guardian.snapshot(), native: observer,
    watchdog: { status: () => ({ enabled: true, phase: 'waiting-for-opponent', receipt: latestReceipt }) } };
  const args = { config, state, page, watchdog, inspectHost: async () => host(), getHostIdentity: () => hostIdentity,
    connection: { runId: hostIdentity.runId }, now: () => time, autoPoll: false,
    operatorChanged: () => operator, operatorFingerprint: () => fingerprint,
    prepareSeatCheck: async () => {
      calls.push('prepare-membership'); await options.onPrepare?.(f);
      return { currentMembership: () => membership(true, 1), verify: async () => {
        calls.push('native-absence'); await options.onVerify?.(f);
        return membership(options.absenceMissing === true, 2);
      }, close: async () => { calls.push('monitor-close'); } };
    },
    stopHost: async () => { calls.push('host-stop'); await options.onStop?.(f);
      return { ...hostIdentity, stopped: true, operatorUnchanged: () => !operator, retirementId: 'e'.repeat(32) }; },
    releaseBrowser: async () => { calls.push('browser-release'); return { leaseReleased: true }; },
    closePeers: () => calls.push('close-peer-observers'), afterRetired: () => calls.push('retired'),
    save: () => {},
  };
  const f = { config, state, args, guardian, observer, sends, calls, context, leave, alert, ws, host,
    advance: (ms) => { time += ms; }, setOperator: (next) => { operator = next; fingerprint = next ? 'f'.repeat(64) : 'c'.repeat(64); },
    emit: async (next) => { raw = next; ws.emit('42' + JSON.stringify(['gamestate', raw])); await flush(); },
    raw: () => structuredClone(raw), receipt: () => latestReceipt,
    dropNextNativeFrame: () => { dropNextNativeFrame = true; },
  };
  f.exit = installDisconnectedOpponentExit(args); t.after(() => f.exit.close());
  return f;
}
const eligible = (f) => currentDisconnectedOpponentProof(f.config, f.state, f.guardian.snapshot(), f.receipt(),
  f.observer.snapshot(), f.host(), hostIdentity);
const runTimeout = async (f) => { await f.exit.tick(); f.advance(120000); await f.exit.tick(); };

test('disconnected exit is opt-in and cannot shorten the server grace or bypass observation', () => {
  assert.deepEqual(normalizeDisconnectedOpponentExit(), { enabled: false, waitMs: 120000 });
  for (const value of [null, [], { enabled: 'true' }, { waitMs: 30000 }, { waitMs: 119999 }, { waitMs: 900001 }, { anything: true }])
    assert.throws(() => normalizeDisconnectedOpponentExit(value), /DISCONNECTED_EXIT_CONFIG_INVALID/);
  const base = { schema: 'keyteki-human-one-seat-draft-v1', origin,
    self: { name: 'Self', serverDeckId: 123, deckName: 'Fixture Deck' },
    room: { name: 'AI game', gameType: 'casual', gameFormat: 'normal' },
    credentialsPath: '/local/credentials.json', output: '/local/output' };
  assert.equal(normalizeHumanConfig(base, { createPublic: true }).disconnectedOpponentExit.enabled, false);
  assert.equal(normalizeHumanConfig({ ...base, disconnectedOpponentExit: { enabled: true } }, { createPublic: true }).disconnectedOpponentExit.enabled, true);
  for (const changed of [{ watchdog: { enabled: false } }, { leaveAfterFinish: false }, { origin: 'https://different.invalid' }])
    assert.throws(() => normalizeHumanConfig({ ...base, ...changed, disconnectedOpponentExit: { enabled: true } }, { createPublic: true }), /DISCONNECTED_EXIT_LIFECYCLE_REQUIRED/);
});

test('real entry performs one normal native leave after 120s and does not create a result or bot fault', async (t) => {
  const f = await fixture(t); assert.ok(eligible(f));
  await f.exit.tick(); f.advance(119999); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(1); await f.exit.tick();
  assert.deepEqual(f.sends, [['game', 'leavegame']]);
  assert.equal(f.guardian.snapshot().operatorPaused, false);
  assert.equal(f.guardian.snapshot().unknownSend, false);
  assert.equal(f.state.runtimeRetired, true); assert.equal(f.state.finished, false);
  assert.equal(f.state.finalPublicView.winner, null);
  assert.ok(f.calls.indexOf('native-absence') < f.calls.indexOf('host-stop'));
  assert.ok(f.calls.indexOf('host-stop') < f.calls.indexOf('browser-release'));
  assert.ok(verifiedDisconnectedDeparture(f.state.disconnectedOpponentExit,
    { origin, gameId, playerName: 'Self', participants: identity.participants, requireRetired: true }));
  await f.exit.tick(); f.advance(120000); await f.exit.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.guardian.prepareDisconnectedLeave(f.guardian.snapshot()), false);
  const row = classifyCampaignAttempt({ handoff: f.state, origin, selfName: 'Self', expectedGameId: gameId, exitCode: 0 });
  assert.equal(row.outcome, 'opponent-disconnected-departure'); assert.equal(row.terminal, false);
  assert.equal(row.natural, false); assert.equal(row.technicalFailure, false); assert.equal(row.won, null);
  assert.equal(row.canContinue, true); assert.equal(row.seatReleased, true);
  const health = campaignHealth([row]); assert.equal(health.completedGames, 0);
  assert.equal(health.disconnectedOpponentDepartures, 1); assert.equal(health.naturalGames, 0);
});

test('a normal UI leave flushed after its callback is confirmed from its actual outgoing ledger', async (t) => {
  const f = await fixture(t);
  f.leave.click = () => { f.calls.push('ui-leave'); queueMicrotask(() => f.ws.send('42["game","leavegame"]')); };
  await runTimeout(f);
  assert.deepEqual(f.sends, [['game', 'leavegame']]); assert.equal(f.state.runtimeRetired, true);
  assert.equal(f.state.disconnectedOpponentExit.nativeLeaveObserved, true);
});

test('chat and polling do not reset the continuous native-disconnect timer', async (t) => {
  const f = await fixture(t); await f.exit.tick(); f.advance(119000);
  const raw = f.raw(); raw.messages.push({ message: 'Fixture spectator chat' }); raw.players.Visitor.clock = { timeLeft: 1 };
  await f.emit(raw); await f.exit.tick(); f.advance(1000); await f.exit.tick();
  assert.deepEqual(f.sends, [['game', 'leavegame']]);
});

test('a real reconnection resets the timer and requires a fresh full waiting interval', async (t) => {
  const f = await fixture(t); await f.exit.tick(); f.advance(119000);
  const raw = f.raw(); raw.players.Visitor.disconnected = false; await f.emit(raw); await f.exit.tick();
  f.advance(5000); raw.players.Visitor.disconnected = true; await f.emit(raw); await f.exit.tick();
  f.advance(119999); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 1);
});

test('native reconnect then disconnect between two polls starts a new complete wait interval', async (t) => {
  const f = await fixture(t); await f.exit.tick(); f.advance(119999);
  const raw = f.raw(); raw.players.Visitor.disconnected = false; await f.emit(raw);
  raw.players.Visitor.disconnected = true; await f.emit(raw);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(119999); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 1);
});

test('native reconnect then disconnect during the awaited lobby probe cancels the old deadline', async (t) => {
  let probes = 0;
  const f = await fixture(t, { onPrepare: async (f) => {
    if (++probes > 1) return;
    const raw = f.raw(); raw.players.Visitor.disconnected = false; await f.emit(raw);
    raw.players.Visitor.disconnected = true; await f.emit(raw);
  } });
  await runTimeout(f); assert.equal(f.sends.length, 0); assert.equal(f.guardian.snapshot().strategyPaused, false);
  await f.exit.tick(); f.advance(119999); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 1);
});

test('a native full resynchronization across a lost reconnect frame starts a new wait interval', async (t) => {
  const f = await fixture(t); await f.exit.tick(); f.advance(119999);
  f.dropNextNativeFrame();
  const raw = f.raw(); raw.players.Visitor.disconnected = false; await f.emit(raw);
  raw.players.Visitor.disconnected = true; await f.emit(raw);
  assert.ok(eligible(f));
  assert.equal(f.receipt().nativeSequence, 4);
  assert.equal(f.guardian.snapshot().nativeSequence, 4);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(119999); await f.exit.tick(); assert.equal(f.sends.length, 0);
  f.advance(1); await f.exit.tick(); assert.equal(f.sends.length, 1);
});

for (const phase of ['disarmed', 'closed', 'operator-paused'])
  test('an observer in ' + phase + ' cannot reuse its old matching receipt', async (t) => {
    const f = await fixture(t); await f.exit.tick(); f.advance(120000);
    f.args.watchdog.watchdog.status = () => ({ enabled: true, phase, receipt: f.receipt() });
    await f.exit.tick(); assert.equal(f.sends.length, 0); assert.equal(f.state.runtimeRetired, undefined);
  });

test('departure classification waits for actual driver exit and preserves a nonzero exit as unresolved', async (t) => {
  const f = await fixture(t); await runTimeout(f);
  const classify = (exitCode) => classifyCampaignAttempt({ handoff: f.state, origin, selfName: 'Self', expectedGameId: gameId, exitCode });
  const pending = classify(null);
  assert.equal(pending.awaitingDriverExit, true); assert.equal(pending.finalized, false); assert.equal(pending.canContinue, false);
  const failed = classify(2);
  assert.equal(failed.finalized, true); assert.equal(failed.canContinue, false);
  assert.equal(failed.continuationBlock, 'driver-exit-not-clean');
  const done = classify(0);
  assert.equal(done.finalized, true); assert.equal(done.canContinue, true); assert.equal(done.awaitingDriverExit, false);
});

test('a failed optional native subscriber is removed without losing the main accepted native state', async (t) => {
  const f = await fixture(t); let failures = 0, notifications = 0;
  f.observer.subscribeNative(() => { notifications++; throw Error('Fixture listener failure'); }, () => { failures++; });
  const raw = f.raw(); raw.players.Visitor.stats.amber = 1; await f.emit(raw);
  assert.equal(f.observer.snapshot().players.Visitor.stats.amber, 1);
  assert.equal(failures, 1); assert.equal(notifications, 1);
  assert.equal(f.exit.status().observationBroken, false);
});

test('a runtime without a continuous native subscription cannot enable automatic departure', async (t) => {
  const f = await fixture(t); f.exit.close();
  f.exit = installDisconnectedOpponentExit({ ...f.args,
    watchdog: { ...f.args.watchdog, native: { snapshot: () => f.observer.snapshot() } } });
  await runTimeout(f); assert.equal(f.sends.length, 0); assert.equal(f.exit.status().observationBroken, true);
});

for (const scenario of ['own-prompt', 'own-disconnected', 'opponent-connected', 'manual-mode', 'terminal', 'operator-paused', 'unknown-send', 'pending-deliveries', 'missing-deliveries', 'wrong-owner', 'missing-no-loss-offer'])
  test('no leave for ' + scenario, async (t) => {
    const f = await fixture(t);
    if (scenario === 'operator-paused') f.setOperator(true);
    const raw = f.raw();
    if (scenario === 'own-prompt') { raw.players.Self.selectCard = true; raw.players.Self.menuTitle = 'Choose a target'; }
    if (scenario === 'own-disconnected') raw.players.Self.disconnected = true;
    if (scenario === 'opponent-connected') raw.players.Visitor.disconnected = false;
    if (scenario === 'manual-mode') raw.manualMode = true;
    if (scenario === 'terminal') raw.winner = 'Visitor';
    await f.emit(raw);
    if (scenario === 'missing-no-loss-offer') f.alert.textContent = 'Your game is not finished. Leaving will concede.';
    if (['unknown-send', 'pending-deliveries', 'missing-deliveries', 'wrong-owner'].includes(scenario)) {
      f.exit.close(); const host = f.host();
      if (scenario === 'unknown-send') host.sessions[0].sendPending = { decisionId: 'unresolved' };
      else if (scenario === 'pending-deliveries') host.sessions[0].pendingDeliveries = [{ stage: 'queued' }];
      else if (scenario === 'missing-deliveries') delete host.sessions[0].pendingDeliveries;
      else host.sessions[0].ownerEpoch = 2;
      f.exit = installDisconnectedOpponentExit({ ...f.args, inspectHost: async () => host });
    }
    await runTimeout(f); assert.equal(f.sends.length, 0); assert.equal(f.state.runtimeRetired, undefined);
  });

for (const scenario of ['reconnect-during-probe', 'own-prompt-during-probe', 'operator-pause-during-probe', 'stale-page-binding'])
  test('fresh pre-click proof rejects ' + scenario, async (t) => {
    const options = { onPrepare: async (f) => {
      if (scenario === 'operator-pause-during-probe') f.setOperator(true);
      else if (scenario !== 'stale-page-binding') {
        const raw = f.raw();
        if (scenario === 'reconnect-during-probe') raw.players.Visitor.disconnected = false;
        else raw.players.Self.buttons = [{ text: 'Resolve', arg: 'resolve' }];
        await f.emit(raw);
      }
    } };
    if (scenario === 'stale-page-binding') options.beforeEvaluate = async (_fn, arg, f) => {
      if (arg?.click) { const raw = f.raw(); raw.messages.push({ message: 'frame changed' }); await f.emit(raw); }
    };
    const f = await fixture(t, options); await runTimeout(f);
    assert.equal(f.sends.length, 0); assert.equal(f.state.runtimeRetired, undefined);
    assert.equal(f.guardian.snapshot().strategyPaused, false);
  });

test('missing native absence preserves the game resources and prevents a replayed leave', async (t) => {
  const f = await fixture(t, { absenceMissing: true }); await runTimeout(f);
  assert.equal(f.sends.length, 1); assert.equal(f.state.disconnectedOpponentExit.phase, 'blocked-preserved');
  assert.equal(f.calls.includes('host-stop'), false); assert.equal(f.calls.includes('browser-release'), false);
  await f.exit.tick(); f.advance(100000); await f.exit.tick(); assert.equal(f.sends.length, 1);
  assert.equal(f.state.runtimeRetired, undefined);
});

test('a human pause during host stop still prevents browser retirement and is never cleared', async (t) => {
  const f = await fixture(t, { onStop: (f) => f.setOperator(true) }); await runTimeout(f);
  assert.equal(f.calls.includes('host-stop'), true); assert.equal(f.calls.includes('browser-release'), false);
  assert.equal(f.state.runtimeRetired, undefined); assert.equal(f.state.disconnectedOpponentExit.phase, 'blocked-preserved');
});

test('the departure permit does not suppress another command or duplicate Leave', async (t) => {
  for (const opcode of ['concede', 'forcePass']) {
    const f = await fixture(t); assert.equal(f.guardian.prepareDisconnectedLeave(f.guardian.snapshot()), true);
    f.ws.send('42' + JSON.stringify(['game', opcode]));
    assert.equal(f.guardian.snapshot().operatorPaused, true);
    assert.equal(f.guardian.snapshot().departureLedger.nativeLeaveObserved, false);
  }
  const f = await fixture(t); await runTimeout(f);
  f.ws.send('42["game","leavegame"]'); assert.equal(f.guardian.snapshot().operatorPaused, true);
});

test('an expired permit and mixed polling packets retain ordinary external-command protection', async (t) => {
  const f = await fixture(t); assert.equal(f.guardian.prepareDisconnectedLeave(f.guardian.snapshot()), true);
  f.advance(5001); f.ws.send('42["game","leavegame"]');
  assert.equal(f.guardian.snapshot().operatorPaused, true);
  const mixed = await fixture(t); assert.equal(mixed.guardian.prepareDisconnectedLeave(mixed.guardian.snapshot()), true);
  // A polling payload may contain more than one Socket.IO packet.
  mixed.ws.send('42["game","leavegame"]\x1e42["game","concede"]');
  assert.equal(mixed.guardian.snapshot().operatorPaused, true);
});

test('the actual XMLHttpRequest polling interceptor consumes only its one exact normal UI leave', async (t) => {
  const f = await fixture(t); assert.equal(f.guardian.prepareDisconnectedLeave(f.guardian.snapshot()), true);
  const xhr = new f.context.XMLHttpRequest();
  xhr.open('POST', origin + '/node-1/socket.io/?transport=polling');
  xhr.send('42["game","leavegame"]');
  assert.equal(f.guardian.snapshot().departureLedger.nativeLeaveObserved, true);
  assert.equal(f.guardian.snapshot().operatorPaused, false);
  xhr.send('42["game","leavegame"]');
  assert.equal(f.guardian.snapshot().operatorPaused, true);
});

function hostFixture(t, departure) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-disconnected-host-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const connection = { runId: hostIdentity.runId, url: 'http://127.0.0.1:32123', token: 'a'.repeat(64), managedSessions: true };
  recordHostOperatorIntent(profile, connection, 'start');
  fs.writeFileSync(path.join(profile, 'connection.json'), JSON.stringify(connection));
  fs.writeFileSync(path.join(profile, 'runtime.lock'), JSON.stringify({ ...hostIdentity }));
  const config = { profile, origin, room: { gameId }, self: { name: 'Self' }, participants: identity.participants };
  const request = { expectedRunId: hostIdentity.runId, expectedPid: hostIdentity.pid,
    configSha256: hostIdentity.configSha256, retirementId: 'd'.repeat(32),
    operatorIntentFingerprint: hostOperatorIntentFingerprint(profile), departure };
  const status = { paused: false, stopping: false, restoredSessions: [], sessions: [{ origin, gameId, playerName: 'Self',
    documentId: departure.binding.documentId, ownerEpoch: departure.binding.ownerEpoch,
    sendPending: null, pendingDeliveries: [], status: 'waiting-for-opponent' }] };
  return { profile, connection, config, request, args: { profile, ...hostIdentity,
    config: { origins: [origin], participants: identity.participants, players: [{ name: 'Self' }] }, request, status } };
}

test('host accepts only the exact proved departed seat and preserves the operator intent', async (t) => {
  const f = await fixture(t); await runTimeout(f);
  const departure = structuredClone(f.state.disconnectedOpponentExit); departure.phase = 'left-confirmed';
  const h = hostFixture(t, departure), fingerprint = hostOperatorIntentFingerprint(h.profile);
  const receipt = acceptAutomaticDisconnectedStop(h.args);
  assert.equal(receipt.source, 'automatic-disconnected-retirement');
  assert.equal(hostOperatorIntentFingerprint(h.profile), fingerprint);
  for (const change of ['run', 'pid', 'absence', 'pending', 'pending-deliveries', 'missing-deliveries', 'operator', 'participant']) {
    const testArgs = structuredClone(h.args);
    if (change === 'run') testArgs.request.expectedRunId = 'f'.repeat(32);
    if (change === 'pid') testArgs.request.expectedPid++;
    if (change === 'absence') testArgs.request.departure.server.seatPresent = true;
    if (change === 'pending') testArgs.status.sessions[0].sendPending = { decisionId: 'pending' };
    if (change === 'pending-deliveries') testArgs.status.sessions[0].pendingDeliveries = [{ stage: 'authorized' }];
    if (change === 'missing-deliveries') delete testArgs.status.sessions[0].pendingDeliveries;
    if (change === 'operator') testArgs.request.operatorIntentFingerprint = '0'.repeat(64);
    if (change === 'participant') testArgs.config.participants = ['Self', 'Other'];
    assert.throws(() => acceptAutomaticDisconnectedStop(testArgs), /DISCONNECTED_HOST/);
  }
});

test('host-stop client sends the bound receipt and refuses a replaced connection before any request', async (t) => {
  const f = await fixture(t); await runTimeout(f);
  const departure = structuredClone(f.state.disconnectedOpponentExit); departure.phase = 'left-confirmed';
  const h = hostFixture(t, departure); let requests = 0;
  const args = { expectedHost: hostIdentity, expectedConnection: h.connection, departure, alive: () => false,
    fetcher: async (_url, options) => { requests++; const request = JSON.parse(options.body);
      const automaticRetirement = acceptAutomaticDisconnectedStop({ ...h.args, request });
      return { ok: true, json: async () => ({ ...hostIdentity, automaticRetirement }) }; } };
  const result = await stopDisconnectedHost(h.config, args); assert.equal(result.stopped, true);
  assert.equal(result.operatorUnchanged(), true); assert.equal(requests, 1);
  fs.writeFileSync(path.join(h.profile, 'connection.json'), JSON.stringify({ ...h.connection, runId: 'e'.repeat(32) }));
  await assert.rejects(stopDisconnectedHost(h.config, args), /DISCONNECTED_HOST_IDENTITY_UNVERIFIED/);
  assert.equal(requests, 1);
});
