import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import jsondiffpatch from 'jsondiffpatch';
import { userscriptBootstrap } from "../../tools/keyteki-browser-bootstrap.mjs";
import { createOneSeatBridgeBinding } from "../../tools/keyteki-human-bridge-callback.mjs";
import { installHumanWatchdog } from "../../tools/keyteki-human-watchdog-browser.mjs";
import { KeytekiManagedSessions } from "../../tools/keyteki-managed-sessions.mjs";
import { KeytekiStateStream, KeytekiWireSession } from "../../tools/keyteki-wire-session.mjs";

const origin = 'http://fixture.test';
const gameId = 'observed-receipt-integration';
const participants = ['alpha', 'beta'];
const connection = { url: 'http://127.0.0.1:32123', token: 'a'.repeat(64), runId: 'b'.repeat(32) };
const source = fs.readFileSync(new URL("../../tools/keyteki-shared-strategy.user.js", import.meta.url), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  for (let n = 0; n < 8; n++) await new Promise((resolve) => setImmediate(resolve));
};

function initialState() {
  const player = (name, index) => ({
    name,
    houses: ['brobnar', 'dis', 'untamed'],
    activePlayer: index === 0,
    activeHouse: null,
    phase: 'setup',
    disconnected: false,
    stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 36,
    numArchivesCards: 0,
    buttons: [],
    controls: [],
    deckData: { id: 101 + index, uuid: 'deck-' + name, name: 'Deck ' + name },
  });
  const raw = {
    id: gameId,
    started: true,
    manualMode: false,
    messages: [],
    players: Object.fromEntries(participants.map((name, index) => [name, player(name, index)])),
  };
  raw.players.alpha.menuTitle = 'Start the Game';
  raw.players.alpha.buttons = [{ text: 'Start the Game', uuid: 'start-prompt' }];
  return raw;
}

/** Real bootstrap, guardian, manager, wire, callback and watchdog. Only native/HTTP/page boundaries
 * are in memory. The accepted effect and observed receipt are never fabricated by the fixture. */
async function harness(
  t,
  { effectReachesHost = true, tamperProof = null, failReceiptStorage = false, deliveryOnly = false } = {},
) {
  const storage = new Map(),
    bindings = new Map(),
    sessions = [],
    writes = [],
    http = [],
    browserReplies = [],
    events = [],
    evidence = [],
    receiptResults = [],
    holds = [],
    state = {},
    calls = { reload: 0, restart: 0, health: 0, clearHold: 0, storageFailures: 0 },
    storageKey = 'kf-local-session:' + connection.url + ':alpha',
    mirror = new KeytekiStateStream(),
    patcher = jsondiffpatch.create({
      objectHash: (value, index) => value.uuid || value.name || value.id || index,
    });
  let context,
    intervals,
    ws,
    native = initialState(),
    documentCount = 0,
    unavailableFence = false,
    responseFaultArmed = true,
    receiptPersistenceArmed = false,
    beforeReload = null,
    releaseSentReply;
  const sentReplyGate = new Promise((resolve) => {
    releaseSentReply = resolve;
  });
  t.after(() => releaseSentReply());
  const manager = new KeytekiManagedSessions({
    createSession: ({ origin, playerName }) => {
      const wire = new KeytekiWireSession({
        origin,
        playerName,
        participants,
        strategy: { codePolicy: 'tempo-v3' },
      });
      sessions.push(wire);
      return wire;
    },
  });
  const config = {
    origin,
    room: { gameId, opponentName: 'beta' },
    self: {
      name: 'alpha',
      serverDeckId: 101,
      deckName: 'Deck alpha',
      deckSelector: 'deck-alpha',
      codePolicy: 'tempo-v3',
    },
    participants,
    watchdog: {
      enabled: true,
      stallMs: 10,
      recoveryGraceMs: 600000,
      modelGraceMs: 20,
      pollMs: 600000,
      apologyEchoMs: 10,
      terminalAckMs: 10,
      maxRecoveries: 1,
    },
  };
  const observer = { joinRequested: true, selection: { serverDeckId: 101, isStandalone: false } };
  class NativeSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 1;
      this.events = new Map();
    }
    addEventListener(name, fn) {
      this.events.set(name, [...(this.events.get(name) ?? []), fn]);
    }
    send(data) {
      writes.push(JSON.parse(data.slice(2)));
    }
    emit(data) {
      for (const fn of this.events.get('message') ?? []) fn({ data });
    }
  }
  const frame = { url: () => origin + '/play' };
  const installBinding = (name, fn) => {
    context[name] = async (value) => fn({ page, frame }, value);
  };
  const page = {
    mainFrame: () => frame,
    url: frame.url,
    evaluate: async (fn, argument) => {
      context.__argument = argument;
      const result = await vm.runInContext('(' + fn.toString() + ')(__argument)', context);
      if (result?.reason === 'observed-delivery-proven' || result?.reason === 'receipt-proof-unavailable')
        receiptResults.push(structuredClone(result));
      return result;
    },
    exposeBinding: async (name, fn) => {
      bindings.set(name, fn);
      if (context) installBinding(name, fn);
    },
    reload: async () => {
      calls.reload++;
      beforeReload = {
        snapshot: structuredClone(context.__kfHumanFaultGuardian.snapshot()),
        storage: JSON.parse(storage.get(storageKey)),
        stats: structuredClone(sessions[0].stats),
      };
      // Navigation retires this fixture document, retaining the tab's actual sessionStorage.
      ws.readyState = 3;
      installDocument();
      await flush();
    },
  };
  const runtime = await installHumanWatchdog({
    page,
    config,
    connection,
    state,
    observer,
    save() {},
    onEvent: (event) => events.push(structuredClone(event)),
    hostRequest: async (route) => {
      assert.equal(route, '/status');
      calls.health++;
      return { ...manager.summary(), paused: false, stopping: false, runId: connection.runId };
    },
    restartHost: async () => {
      calls.restart++;
      throw Error('This live host must not be restarted by receipt reconciliation');
    },
    clearAutomaticHold: async () => {
      calls.clearHold++;
      state.held = false;
    },
  });
  t.after(() => runtime.close());
  const bridge = createOneSeatBridgeBinding({
    page,
    config,
    connection,
    observer,
    state,
    mirror,
    save() {},
    hold: async (reason) => {
      holds.push(reason);
      state.held = true;
    },
    onEvidence: (row) => evidence.push(row),
    watchdog: {
      ...runtime,
      isCurrentDocument: async (documentId) => {
        if (unavailableFence) {
          unavailableFence = false;
          return null;
        }
        return runtime.isCurrentDocument(documentId);
      },
    },
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname,
        input = JSON.parse(options.body);
      let status = 200,
        answer;
      try {
        switch (route) {
          case '/attach':
            answer = manager.attach(input);
            break;
          case '/state':
            answer = manager.receive(input);
            break;
          case '/decision':
            answer = manager.offer(input);
            break;
          case '/send-intent':
            answer = manager.authorize(input);
            break;
          case '/sent':
            answer = manager.confirmSent(input);
            break;
          case '/reject':
            answer = manager.reject(input);
            break;
          case '/unknown':
            answer = manager.unknown(input);
            break;
          case '/detach':
            answer = manager.detach(input);
            break;
          default:
            throw Error('Unexpected fixture HTTP route: ' + route);
        }
      } catch (error) {
        if (!error.managed) throw error;
        status = 409;
        answer = { code: error.code, error: error.message, managed: true };
      }
      const actualAnswer = structuredClone(answer);
      if (route === '/state' && responseFaultArmed && effectReachesHost) {
        responseFaultArmed = false;
        // The real manager has already accepted the effect. Only the subsequent document fence fails.
        unavailableFence = true;
      }
      if (route === '/sent' && input.receiptOnly === true) {
        if (tamperProof) tamperProof(answer);
        if (failReceiptStorage) receiptPersistenceArmed = true;
      }
      http.push({ route, input, status, actualAnswer, returnedAnswer: structuredClone(answer) });
      return {
        status,
        ok: status === 200,
        text: async () => {
          if (deliveryOnly && route === '/sent' && input.receiptOnly !== true) {
            await sentReplyGate;
            // This queued-send reply fails only after the separate state request proved its effect.
            unavailableFence = true;
          }
          return JSON.stringify(answer);
        },
      };
    },
  });
  await page.exposeBinding('__kfGMRequest', async (source, request) => {
    const route = new URL(request.url).pathname;
    if (route === '/state' && responseFaultArmed && !effectReachesHost) {
      responseFaultArmed = false;
      unavailableFence = true;
    }
    const response = await bridge(source, request);
    browserReplies.push({ route, status: response.status, body: JSON.parse(response.responseText) });
    return response;
  });
  function installDocument() {
    documentCount++;
    intervals = [];
    context = {
      WebSocket: NativeSocket,
      URL,
      crypto: webcrypto,
      Date,
      location: { origin, href: origin + '/play' },
      console: { warn() {}, info() {} },
      setInterval: (fn) => intervals.push(fn),
      setTimeout,
      clearTimeout,
      addEventListener() {},
      sessionStorage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => {
          if (key === storageKey && receiptPersistenceArmed && JSON.parse(value).deliveryLedger === null) {
            receiptPersistenceArmed = false;
            calls.storageFailures++;
            throw Error('Fixture sessionStorage failed while persisting the observed receipt');
          }
          storage.set(key, value);
        },
      },
    };
    context.window = context;
    context.top = context;
    vm.createContext(context);
    for (const [name, fn] of bindings) installBinding(name, fn);
    vm.runInContext(
      userscriptBootstrap(
        {
          ...connection,
          playerName: 'alpha',
          managedSessions: true,
          humanWatchdog: { enabled: true, gameId, participants },
        },
        source,
      ),
      context,
    );
    ws = new context.WebSocket('ws://fixture.test/node/socket.io/?transport=websocket');
    ws.emit('0' + JSON.stringify({ sid: 'fixture-engine-' + documentCount }));
    ws.emit('42' + JSON.stringify(['gamestate', native]));
  }
  const emit = (next) => {
    const delta = patcher.diff(native, next);
    native = structuredClone(next);
    ws.emit('42' + JSON.stringify(['gamestate', delta ?? {}]));
  };
  installDocument();
  await flush();
  assert.equal(sessions.length, 1, 'a real managed attach creates exactly one wire session');
  assert.equal(state.fullVerified, true);
  assert.equal(intervals.length, 1);
  const originalPoll = intervals[0]();
  if (!deliveryOnly) await originalPoll;
  await flush();
  assert.equal(writes.length, 1, 'the production poll queues the original native command once');
  assert.deepEqual(writes[0].slice(0, 2), ['game', 'menuButton']);
  assert.equal(sessions[0].stats.commands, 1);
  assert.equal(sessions[0].stats.queuedCommands, 1);
  assert.equal(sessions[0].stats.acknowledged, 0);
  const queued = JSON.parse(storage.get(storageKey)).deliveryLedger;
  assert.equal(queued.stage, 'queued');
  assert.equal(queued.queuedCount, 1);
  assert.equal(context.__kfHumanFaultGuardian.snapshot().deliveryPresent, deliveryOnly);

  const effect = structuredClone(native);
  Object.assign(effect.players.alpha, {
    menuTitle: 'Keep Starting Hand?',
    promptTitle: 'Mulligan',
    buttons: [
      { text: 'Keep', arg: 'keep', uuid: 'mulligan-prompt' },
      { text: 'Mulligan', arg: 'mulligan', uuid: 'mulligan-prompt' },
    ],
  });
  emit(effect);
  await flush();
  assert.equal(browserReplies.find((row) => row.route === '/state')?.status, 503);
  assert.equal(context.__kfHumanFaultGuardian.snapshot().pauseReason, 'current-document-unavailable');
  assert.deepEqual(JSON.parse(storage.get(storageKey)).deliveryLedger, queued);
  assert.equal(state.nodeSequence, 1, 'a fenced response never publishes its newer ordinary diagnostics');
  assert.equal(state.gameplayDiagnostics.stats.acknowledged, 0);
  assert.equal(sessions[0].stats.acknowledged, effectReachesHost ? 1 : 0);
  const ingress = evidence.filter((row) => row.type === 'ingress-diagnostics').at(-1).diagnostics;
  assert.equal(ingress.phase, effectReachesHost ? 'response-document-fence' : 'initial-document-fence');
  assert.equal(ingress.result, 'document-unavailable');
  if (effectReachesHost) assert.equal(ingress.hostResponseStatus, 200);
  assert.equal(ingress.replyStatus, 503);
  if (deliveryOnly) {
    assert.equal(sessions[0].stats.acknowledged, 1, 'the effect is observed before losing the send reply');
    releaseSentReply();
    await originalPoll;
    await flush();
    assert.equal(browserReplies.find((row) => row.route === '/sent')?.status, 503);
    const unknown = http.find((row) => row.route === '/unknown');
    assert.equal(unknown?.status, 200);
    assert.equal(unknown.actualAnswer.lastDelivery.stage, 'observed');
    assert.equal(unknown.actualAnswer.lastDelivery.decisionId, queued.decisionId);
    assert.equal(unknown.actualAnswer.sendPending, null);
    assert.deepEqual(unknown.actualAnswer.pendingDeliveries, []);
    assert.equal(JSON.parse(storage.get(storageKey)).deliveryLedger, null);
    const residual = context.__kfHumanFaultGuardian.snapshot();
    assert.equal(residual.deliveryLedgerPresent, false);
    assert.equal(residual.deliveryPresent, true);
    assert.equal(residual.unknownSend, true);
    assert.equal(residual.strategyPaused, true);
  }

  // Independent native ingress continues while the ordinary document lane is paused.
  const later = structuredClone(native);
  later.messages.push({ id: 'fixture-native-log', message: ['The start effect was accepted.'] });
  emit(later);
  await flush();
  assert.equal(context.__kfHumanFaultGuardian.snapshot().ordinarySequence, 2);
  assert.equal(context.__kfHumanFaultGuardian.snapshot().nativeSequence, 3);
  assert.equal(context.__kfHumanFaultGuardian.snapshot().ordinaryIngress.skippedNative, 1);
  assert.equal(runtime.watchdog.status().receipt.nativeSequence, 3);
  assert.equal(holds.length, 0);
  return {
    manager,
    sessions,
    runtime,
    state,
    calls,
    http,
    writes,
    events,
    holds,
    queued,
    receiptResults,
    snapshot: () => structuredClone(context.__kfHumanFaultGuardian.snapshot()),
    ledger: () => JSON.parse(storage.get(storageKey)).deliveryLedger,
    api: () => context.__kfHumanFaultGuardian,
    beforeReload: () => beforeReload,
    recover: async () => {
      await delay(25);
      await runtime.tick();
      await flush();
    },
  };
}

const deliveries = (h) => h.http.filter((row) => row.route === '/sent');
const probes = (h) => deliveries(h).filter((row) => row.input.receiptOnly === true);
const counters = (h) =>
  Object.fromEntries(
    ['commands', 'queuedCommands', 'acknowledged'].map((key) => [key, h.sessions[0].stats[key]]),
  );

test('an observed effect behind a lost state reply reconciles its real ledger and reloads once without replay', async (t) => {
  const h = await harness(t),
    oldSnapshot = h.snapshot(),
    before = counters(h);
  assert.equal(h.manager.summary().sessions[0].sendPending, null);
  assert.equal(oldSnapshot.unknownSend, true);
  await h.recover();
  assert.equal(probes(h).length, 1);
  const probe = probes(h)[0];
  assert.equal(probe.status, 200);
  assert.equal(probe.input.decisionId, h.queued.decisionId);
  assert.equal(probe.input.sendTicket, h.queued.sendTicket);
  assert.equal(probe.actualAnswer.observedDelivery.stage, 'observed');
  for (const key of ['decisionId', 'sendTicket', 'sequence', 'documentId', 'ownerEpoch', 'queuedCount'])
    assert.equal(probe.actualAnswer.observedDelivery[key], h.queued[key], key);
  assert.ok(probe.actualAnswer.receiptOrdinal > deliveries(h)[0].actualAnswer.receiptOrdinal);
  assert.deepEqual(h.receiptResults, [
    {
      ok: true,
      reason: 'observed-delivery-proven',
      documentId: oldSnapshot.documentId,
      ownerEpoch: oldSnapshot.ownerEpoch,
    },
  ]);
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.clearHold, 1);
  assert.equal(h.beforeReload().snapshot.documentId, oldSnapshot.documentId);
  assert.equal(
    h.beforeReload().snapshot.strategyPaused,
    true,
    'proof does not resume a skipped-delta document',
  );
  assert.equal(h.beforeReload().snapshot.unknownSend, false);
  assert.equal(h.beforeReload().storage.deliveryLedger, null);
  assert.equal(h.ledger(), null);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before, 'a receipt probe and full reattach add no send or effect ACK');
  assert.equal(h.sessions.length, 1);
  assert.equal(h.http.filter((row) => row.route === '/attach').length, 2);
  assert.notEqual(h.snapshot().documentId, oldSnapshot.documentId);
  assert.equal(h.snapshot().ownerEpoch, oldSnapshot.ownerEpoch + 1);
  assert.equal(h.snapshot().ordinarySequence, 1);
  assert.equal(h.snapshot().strategyPaused, false);
  assert.equal(h.snapshot().unknownSend, false);
  assert.ok(h.events.some((row) => row.type === 'recovery-send-check' && row.observedReceiptProven === true));
  assert.deepEqual(h.holds, []);
});

for (const [name, tamperProof] of [
  [
    'missing proof',
    (reply) => {
      delete reply.observedDelivery;
    },
  ],
  [
    'wrong ticket',
    (reply) => {
      reply.observedDelivery.sendTicket = 'c'.repeat(32);
    },
  ],
  [
    'old receipt ordinal',
    (reply) => {
      reply.receiptOrdinal = 0;
    },
  ],
  [
    'pending send in the reply',
    (reply) => {
      reply.sendPending = { decisionId: 'another-send' };
    },
  ],
]) {
  test('an observed response with ' + name + ' cannot clear the real queued ledger', async (t) => {
    const h = await harness(t, { tamperProof }),
      before = counters(h),
      oldDocument = h.snapshot().documentId;
    await h.recover();
    assert.equal(probes(h).length, 1);
    assert.equal(probes(h)[0].actualAnswer.observedDelivery.stage, 'observed');
    assert.deepEqual(h.receiptResults, [{ ok: false, reason: 'receipt-proof-unavailable' }]);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.restart, 0);
    assert.equal(h.calls.clearHold, 0);
    assert.equal(h.snapshot().documentId, oldDocument);
    assert.equal(h.snapshot().strategyPaused, true);
    assert.equal(h.snapshot().unknownSend, true);
    assert.deepEqual(h.ledger(), h.queued, 'generic owner acceptance must not clear a failed proof');
    assert.equal(h.writes.length, 1);
    assert.deepEqual(counters(h), before);
    assert.ok(
      h.events.some(
        (row) => row.type === 'recovery-attempt-finished' && row.reason === 'uncertain-send-preserved',
      ),
    );
    assert.deepEqual(h.holds, []);
  });
}

test('a storage failure while clearing a proven receipt preserves the ledger and owner ordinal', async (t) => {
  const h = await harness(t, { failReceiptStorage: true }),
    before = counters(h),
    oldSnapshot = h.snapshot();
  assert.ok(Number.isSafeInteger(oldSnapshot.ownerReceiptOrdinal));
  await h.recover();
  assert.equal(probes(h).length, 1);
  assert.equal(probes(h)[0].actualAnswer.observedDelivery.stage, 'observed');
  assert.deepEqual(h.receiptResults, [{ ok: false, reason: 'receipt-proof-unavailable' }]);
  assert.equal(h.calls.storageFailures, 1);
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.clearHold, 0);
  assert.equal(h.snapshot().ownerReceiptOrdinal, oldSnapshot.ownerReceiptOrdinal);
  assert.equal(h.snapshot().documentId, oldSnapshot.documentId);
  assert.equal(h.snapshot().strategyPaused, true);
  assert.equal(h.snapshot().unknownSend, true);
  assert.deepEqual(h.ledger(), h.queued);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before);
  assert.deepEqual(h.holds, []);
});

test('a queued command whose effect never reached the host remains pending through watchdog and receipt probe', async (t) => {
  const h = await harness(t, { effectReachesHost: false }),
    before = counters(h);
  assert.equal(h.manager.summary().sessions[0].sendPending.decisionId, h.queued.decisionId);
  assert.deepEqual(before, { commands: 1, queuedCommands: 1, acknowledged: 0 });
  await h.recover();
  assert.equal(probes(h).length, 0, 'fresh host pending state prevents automatic reconciliation');
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.restart, 0);
  const api = h.api(),
    ticket = h.snapshot();
  assert.equal(api.quarantine(ticket), true);
  const result = await api.reconcileDelivery(ticket, Date.now() + 5000);
  assert.deepEqual(structuredClone(result), { ok: false, reason: 'receipt-proof-unavailable' });
  assert.equal(probes(h).length, 1);
  assert.equal(probes(h)[0].status, 409);
  assert.equal(probes(h)[0].actualAnswer.code, 'managed-observed-receipt-unavailable');
  assert.deepEqual(h.ledger(), h.queued);
  assert.equal(h.snapshot().unknownSend, true);
  assert.equal(h.snapshot().strategyPaused, true);
  assert.equal(h.manager.summary().sessions[0].sendPending.decisionId, h.queued.decisionId);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before);
  assert.deepEqual(h.holds, []);
});

test('an expired queued page invocation cannot request or commit a real observed receipt', async (t) => {
  const h = await harness(t),
    oldSnapshot = h.snapshot(),
    before = counters(h);
  const ticket = h.snapshot();
  assert.equal(h.api().quarantine(ticket), true);
  // The deadline was created by Node before page.evaluate, not when this queued browser call starts.
  const result = await h.api().reconcileDelivery(ticket, Date.now() - 1);
  assert.deepEqual(structuredClone(result), { ok: false, reason: 'receipt-expired' });
  assert.equal(probes(h).length, 0);
  assert.equal(h.snapshot().ownerReceiptOrdinal, oldSnapshot.ownerReceiptOrdinal);
  assert.equal(h.snapshot().unknownSend, true);
  assert.deepEqual(h.ledger(), h.queued);
  assert.equal(h.calls.reload + h.calls.restart, 0);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before);
});

test('a closed unknown-send receipt clears the ledger while the remaining delivery is reconciled without replay', async (t) => {
  const h = await harness(t, { deliveryOnly: true }),
    oldSnapshot = h.snapshot(),
    before = counters(h);
  assert.equal(h.ledger(), null);
  assert.equal(oldSnapshot.deliveryLedgerPresent, false);
  assert.equal(oldSnapshot.deliveryPresent, true);
  await h.recover();
  assert.equal(probes(h).length, 1);
  const probe = probes(h)[0];
  assert.equal(
    probe.input.stage,
    undefined,
    'the receipt candidate is the real delivery, not the stored ledger',
  );
  assert.equal(probe.input.expectedCount, 1);
  assert.equal(probe.input.queuedCount, probe.input.expectedCount);
  for (const key of ['decisionId', 'sendTicket', 'sequence', 'documentId', 'ownerEpoch', 'queuedCount'])
    assert.equal(probe.actualAnswer.observedDelivery[key], h.queued[key], key);
  assert.deepEqual(h.receiptResults, [
    {
      ok: true,
      reason: 'observed-delivery-proven',
      documentId: oldSnapshot.documentId,
      ownerEpoch: oldSnapshot.ownerEpoch,
    },
  ]);
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.beforeReload().snapshot.strategyPaused, true);
  assert.equal(h.beforeReload().snapshot.deliveryPresent, false);
  assert.equal(h.beforeReload().snapshot.deliveryLedgerPresent, false);
  assert.equal(h.beforeReload().snapshot.unknownSend, false);
  assert.equal(h.ledger(), null);
  assert.equal(h.snapshot().unknownSend, false);
  assert.notEqual(h.snapshot().documentId, oldSnapshot.documentId);
  assert.equal(h.snapshot().ownerEpoch, oldSnapshot.ownerEpoch + 1);
  assert.equal(h.http.filter((row) => row.route === '/attach').length, 2);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before);
  assert.deepEqual(h.holds, []);
});

test('failed receipt persistence preserves a delivery after its stored ledger has already been cleared', async (t) => {
  const h = await harness(t, { deliveryOnly: true, failReceiptStorage: true }),
    oldSnapshot = h.snapshot(),
    before = counters(h);
  assert.equal(oldSnapshot.deliveryLedgerPresent, false);
  assert.equal(oldSnapshot.deliveryPresent, true);
  assert.equal(h.ledger(), null);
  await h.recover();
  assert.equal(probes(h).length, 1);
  assert.equal(probes(h)[0].input.stage, undefined);
  assert.equal(probes(h)[0].input.expectedCount, probes(h)[0].input.queuedCount);
  assert.equal(probes(h)[0].actualAnswer.observedDelivery.stage, 'observed');
  assert.deepEqual(h.receiptResults, [{ ok: false, reason: 'receipt-proof-unavailable' }]);
  assert.equal(h.calls.storageFailures, 1);
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.clearHold, 0);
  assert.equal(h.snapshot().ownerReceiptOrdinal, oldSnapshot.ownerReceiptOrdinal);
  assert.equal(h.snapshot().documentId, oldSnapshot.documentId);
  assert.equal(h.snapshot().deliveryLedgerPresent, false);
  assert.equal(h.snapshot().deliveryPresent, true);
  assert.equal(h.snapshot().unknownSend, true);
  assert.equal(h.snapshot().strategyPaused, true);
  assert.equal(h.ledger(), null);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(counters(h), before);
  assert.deepEqual(h.holds, []);
});
