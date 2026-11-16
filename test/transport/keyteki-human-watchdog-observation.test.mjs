import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import jsondiffpatch from 'jsondiffpatch';
import { installHumanWatchdog } from "../../tools/keyteki-human-watchdog-browser.mjs";
import { createWatchdogNativeObserver, WATCHDOG_APOLOGY } from "../../tools/keyteki-human-watchdog.mjs";
import { watchdogApology } from '../../tools/keyteki-language.mjs';
import { userscriptBootstrap } from "../../tools/keyteki-browser-bootstrap.mjs";

const identity = { gameId: 'observation-fixture', playerName: 'Self', participants: ['Self', 'Visitor'] };
const origin = 'http://fixture.test',
  localUrl = 'http://127.0.0.1:32123';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  for (let n = 0; n < 6; n++) await new Promise((resolve) => setImmediate(resolve));
};
const raw = () => ({
  id: identity.gameId,
  started: true,
  manualMode: false,
  messages: [],
  players: Object.fromEntries(
    identity.participants.map((name, i) => [
      name,
      {
        name,
        activePlayer: i === 0,
        phase: 'main',
        stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false } },
        cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
        numDeckCards: 30,
        numArchivesCards: 0,
        buttons: i ? [] : [{ text: 'End Turn', arg: 'endturn' }],
        controls: [],
        menuTitle: i ? 'Waiting for opponent...' : 'Play cards',
      },
    ]),
  ),
});

/** Actual production userscript and watchdog, with in-memory native/server and page-boundary fixtures. */
async function harness(t, { operatorPaused = false, dropFirst = false, callbackUnavailable = false, language, apologyEchoMs = 10 } = {}) {
  const storage = new Map(),
    storageKey = 'kf-local-session:' + localUrl + ':Self',
    ledger = {
      decisionId: 'pending-fixture',
      sendTicket: 'fixture-only',
      stage: 'queued',
      queuedCount: 1,
      sequence: 1,
      ownerEpoch: 1,
    },
    writes = [],
    events = [],
    callbacks = [],
    intervals = [],
    state = {},
    calls = { reload: 0, restart: 0 };
  let failedReads = 0,
    loseReply = false,
    holdReply = false,
    releaseReply = null,
    native = raw(),
    ws,
    time = Date.now(),
    unavailable = callbackUnavailable;
  storage.set(
    storageKey,
    JSON.stringify({
      tabId: 'a'.repeat(32),
      gameId: identity.gameId,
      ownerEpoch: 1,
      operatorPaused,
      deliveryLedger: ledger,
    }),
  );
  const patcher = jsondiffpatch.create({ objectHash: (x, i) => x.uuid || x.name || x.id || '$$index:' + i });
  const emit = (next, full = false) => {
    const delta = full ? next : patcher.diff(native, next);
    native = structuredClone(next);
    ws.emit('42' + JSON.stringify(['gamestate', delta ?? {}]));
  };
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
      const command = JSON.parse(data.slice(2));
      writes.push(command);
      // Native server echoes are separate received frames, never fabricated client receipts.
      queueMicrotask(() => {
        const next = structuredClone(native);
        if (command[1] === 'chat')
          next.messages.push({
            id: 'echo-' + next.messages.length,
            message: [{ name: 'Self', argType: 'player' }, ' ', command[2]],
          });
        else if (command[1] === 'concede') next.winner = 'Visitor';
        else return;
        emit(next);
      });
    }
    emit(data) {
      for (const fn of this.events.get('message') ?? []) fn({ data });
    }
  }
  class FixtureDate extends Date {
    static now() {
      return time;
    }
  }
  const context = {
    WebSocket: NativeSocket,
    URL,
    crypto: webcrypto,
    Date: FixtureDate,
    location: { origin, href: origin + '/play' },
    console: { warn() {}, info() {} },
    setInterval: (fn) => intervals.push(fn),
    setTimeout,
    clearTimeout,
    addEventListener() {},
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    __kfGMRequest: async () => ({ status: 503, responseText: '{"code":"fixture-host-unavailable"}' }),
  };
  context.window = context;
  context.top = context;
  vm.createContext(context);
  const frame = { url: () => origin + '/play' };
  const page = {
    mainFrame: () => frame,
    url: frame.url,
    evaluate: async (fn, arg) => {
      if (failedReads > 0) {
        failedReads--;
        throw Error('Transient page read failure');
      }
      context.__arg = arg;
      return vm.runInContext('(' + fn.toString() + ')(__arg)', context);
    },
    exposeBinding: async (name, fn) => {
      context[name] = async (value) => {
        callbacks.push(structuredClone(value));
        if (unavailable) return { ignored: true, reason: 'fixture-binding-unavailable' };
        const result = await fn({ page, frame }, value);
        if (loseReply) {
          loseReply = false;
          throw Error('Lost accepted observation ACK');
        }
        if (holdReply) {
          holdReply = false;
          await new Promise((resolve) => {
            releaseReply = resolve;
          });
        }
        return result;
      };
    },
    reload: async () => {
      calls.reload++;
    },
  };
  const runtime = await installHumanWatchdog({
    page,
    config: {
      origin,
      room: { gameId: identity.gameId },
      self: { name: 'Self' },
      participants: identity.participants,
      social: { enabled: false, ...(language !== undefined ? { language } : {}) },
      watchdog: {
        enabled: true,
        stallMs: 10,
        recoveryGraceMs: 10,
        modelGraceMs: 20,
        pollMs: 600000,
        apologyEchoMs,
        terminalAckMs: 10,
        maxRecoveries: 1,
      },
    },
    connection: { url: localUrl, token: 'a'.repeat(64) },
    state,
    observer: {},
    save() {},
    validateFull() {},
    onEvent: (event) => events.push(event),
    hostRequest: async () => {
      throw Error('Fixture host unavailable');
    },
    restartHost: async () => {
      calls.restart++;
    },
    clearAutomaticHold: async () => {},
  });
  t.after(() => runtime.close());
  vm.runInContext(
    userscriptBootstrap(
      {
        url: localUrl,
        token: 'a'.repeat(64),
        playerName: 'Self',
        managedSessions: true,
        humanWatchdog: { enabled: true, gameId: identity.gameId, participants: identity.participants, ...(language !== undefined ? { language } : {}) },
      },
      fs.readFileSync(new URL("../../tools/keyteki-shared-strategy.user.js", import.meta.url), 'utf8'),
    ),
    context,
  );
  ws = new context.WebSocket('ws://fixture.test:9500/node/socket.io/?transport=websocket');
  ws.emit('0{"sid":"fixture-engine"}');
  if (dropFirst) failedReads = 1;
  emit(native, true);
  await flush();
  const api = context.__kfHumanFaultGuardian;
  return {
    runtime,
    context,
    page,
    api,
    state,
    calls,
    events,
    callbacks,
    writes,
    emit,
    native: () => structuredClone(native),
    failNextRead: () => {
      failedReads++;
    },
    loseNextReply: () => {
      loseReply = true;
    },
    holdNextReply: () => {
      holdReply = true;
    },
    releaseReply: () => releaseReply(),
    setUnavailable: (value) => {
      unavailable = value;
    },
    ledger: () => JSON.parse(storage.get(storageKey)).deliveryLedger,
    initialLedger: structuredClone(ledger),
    advanceAndPoll: async () => {
      time += 10000;
      for (const fn of intervals) await fn();
      await flush();
    },
  };
}

const amber = (h, value) => {
  const next = h.native();
  next.players.Self.stats.amber = value;
  h.emit(next);
};

test('single lost native callback plus unresolved send recovers observation and confirms exactly one fault exit', async (t) => {
  const h = await harness(t);
  h.failNextRead();
  amber(h, 1);
  amber(h, 2);
  amber(h, 3);
  await flush();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
  assert.equal(h.api.snapshot().nativeSequence, 4);
  assert.equal(h.api.snapshot().observationPending, 3);
  // Deliberately make the callback lane remain unavailable: recovery must pull original deltas.
  h.setUnavailable(true);
  await h.runtime.tick();
  assert.equal(h.runtime.native.snapshot().players.Self.stats.amber, 3);
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 4);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.equal(h.state.watchdogObservationGap, false);
  assert.ok(h.state.watchdogObservationReplay.acceptedFrames >= 3);
  await delay(20);
  await h.runtime.tick();
  await delay(20);
  await h.runtime.tick();
  await flush();
  assert.deepEqual(h.writes, [['game', 'chat', WATCHDOG_APOLOGY]]);
  await h.runtime.tick();
  await flush();
  assert.equal(h.runtime.watchdog.status().episode.apologyEcho, true);
  assert.deepEqual(h.writes, [
    ['game', 'chat', WATCHDOG_APOLOGY],
    ['game', 'concede'],
  ]);
  await h.runtime.tick();
  assert.equal(h.state.finished, true);
  assert.equal(h.state.finalPublicView.winner, 'Visitor');
  assert.equal(h.runtime.watchdog.status().episode.phase, 'terminal-confirmed');
  await h.runtime.tick();
  await h.advanceAndPoll();
  await h.runtime.tick();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.calls, { reload: 0, restart: 0 });
  assert.deepEqual(h.ledger(), h.initialLedger);
  assert.ok(h.events.some((event) => event.reason === 'uncertain-send-preserved'));
});

test('original native full is retained if even the initial callback is lost', async (t) => {
  const h = await harness(t, { dropFirst: true });
  assert.equal(h.runtime.watchdog.status().receipt, null);
  assert.equal(h.api.snapshot().observationPending, 1);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.equal(h.writes.length, 0);
});

test('lost observation ACK retries the identical ingress frame without renewing liveness or emitting twice', async (t) => {
  const h = await harness(t);
  h.loseNextReply();
  amber(h, 1);
  await flush();
  const prior = h.runtime.watchdog.status(),
    original = h.callbacks.at(-1);
  assert.equal(h.api.snapshot().observationPending, 1);
  await h.advanceAndPoll();
  assert.deepEqual(h.callbacks.at(-1), original);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.equal(h.runtime.watchdog.status().lastProgressAt, prior.lastProgressAt);
  assert.deepEqual(h.runtime.watchdog.status().receipt, prior.receipt);
  assert.deepEqual(h.ledger(), h.initialLedger);
  assert.equal(h.writes.length, 0);
});

test('six failed push attempts retain bounded original evidence for the independent pull', async (t) => {
  const h = await harness(t, { callbackUnavailable: true });
  for (let n = 0; n < 9; n++) await h.advanceAndPoll();
  assert.equal(h.callbacks.length, 6);
  assert.equal(h.api.snapshot().observationPending, 1);
  assert.equal(h.runtime.watchdog.status().receipt, null);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.equal(h.writes.length, 0);
});

test('overflow never invents a full; only a newly received native full repairs a missing suffix', async (t) => {
  const h = await harness(t);
  h.setUnavailable(true);
  for (let n = 1; n <= 140; n++) amber(h, n);
  await flush();
  assert.equal(h.api.snapshot().observationPending, 128);
  assert.equal(h.api.snapshot().observationOverflow, true);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 129);
  assert.equal(h.api.snapshot().nativeSequence, 141);
  assert.equal(h.writes.length, 0);
  // No guessed reconstruction is emitted for the dropped suffix. The server now sends a genuine full.
  h.emit(h.native(), true);
  await flush();
  await h.runtime.tick();
  assert.equal(h.api.snapshot().observationOverflow, false);
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 142);
  assert.equal(h.runtime.native.snapshot().players.Self.stats.amber, 140);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.deepEqual(h.ledger(), h.initialLedger);
});

test('full compaction preserves the initial native anchor when its ACK has never arrived', async (t) => {
  const h = await harness(t, { callbackUnavailable: true });
  amber(h, 1);
  amber(h, 2);
  h.emit(h.native(), true);
  await flush();
  assert.deepEqual(
    Array.from(h.api.observations().frames, (frame) => frame.nativeSequence),
    [1, 4],
  );
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 4);
  assert.equal(h.runtime.native.snapshot().players.Self.stats.amber, 2);
  assert.equal(h.api.snapshot().observationPending, 0);
});

test('observation ACK must exactly match a retained original frame and never clears the strategy ledger', async (t) => {
  const h = await harness(t, { callbackUnavailable: true });
  const original = h.api.observations().frames[0];
  for (const change of [
    { documentId: 'another-document' },
    { ownerEpoch: 3 },
    { nativeSequence: 100 },
    { frameToken: 'another-token' },
    { transportPath: 'http://fixture.test:9501/node/socket.io' },
  ]) {
    assert.equal(h.api.acknowledgeObservation({ ...original, ...change }), false);
    assert.equal(h.api.snapshot().observationPending, 1);
  }
  await h.runtime.tick();
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.deepEqual(h.ledger(), h.initialLedger);
});

test('operator pause still permits honest observation recovery while prohibiting every native fault write', async (t) => {
  const h = await harness(t, { operatorPaused: true });
  h.failNextRead();
  amber(h, 1);
  amber(h, 2);
  await flush();
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 3);
  await delay(20);
  await h.runtime.tick();
  await h.advanceAndPoll();
  assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.calls, { reload: 0, restart: 0 });
  assert.deepEqual(h.ledger(), h.initialLedger);
});

test('native observer idempotent ACK requires the same payload and cannot renew liveness', () => {
  let observations = 0;
  const native = createWatchdogNativeObserver({
    identity,
    validateFull() {},
    onState() {
      observations++;
    },
  });
  const frame = {
    ...identity,
    documentId: 'doc-fixture',
    ownerEpoch: 1,
    nativeSequence: 1,
    frameToken: 'original-token',
    transportPath: origin + '/node/socket.io',
    newEngineHandshake: true,
    delta: raw(),
  };
  const first = native.receive(frame);
  assert.deepEqual(native.receive(structuredClone(frame)), {
    accepted: true,
    duplicate: true,
    receipt: first.receipt,
  });
  assert.equal(observations, 1);
  assert.throws(() => native.receive({ ...frame, frameToken: 'different-token' }), /frame-conflict/);
  const changed = structuredClone(frame);
  changed.delta.players.Self.stats.amber = 9;
  assert.throws(() => native.receive(changed), /frame-conflict/);
  assert.equal(observations, 1);
});

test('late successful push ACK cannot trim newer packets after a concurrent exact pull ACK', async (t) => {
  const h = await harness(t);
  h.holdNextReply();
  amber(h, 1);
  await flush();
  assert.equal(h.api.snapshot().observationPending, 1);
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 2);
  const original = h.callbacks.at(-1);
  await h.runtime.tick();
  assert.equal(h.api.snapshot().observationPending, 0);
  h.setUnavailable(true);
  amber(h, 2);
  assert.equal(h.api.snapshot().observationPending, 1);
  h.releaseReply();
  await flush();
  assert.equal(h.api.snapshot().observationPending, 1);
  assert.equal(h.api.observations().frames[0].nativeSequence, 3);
  assert.equal(h.api.acknowledgeObservation(original), false);
  assert.equal(h.api.snapshot().observationPending, 1);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 3);
  assert.equal(h.api.snapshot().observationPending, 0);
  assert.deepEqual(h.ledger(), h.initialLedger);
});

test('pull cannot accept a packet from a competing game endpoint', async (t) => {
  const h = await harness(t);
  h.setUnavailable(true);
  amber(h, 1);
  await flush();
  const evaluate = h.page.evaluate;
  h.page.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg);
    if (!fn.toString().includes('.observations?.')) return result;
    const forged = structuredClone(result);
    forged.frames[0].transportPath = 'http://fixture.test:9501/node/socket.io';
    return forged;
  };
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().phase, 'disarmed');
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
  assert.equal(h.api.snapshot().observationPending, 1);
  assert.equal(h.writes.length, 0);
});

test('a pulled batch crossed by document replacement is ignored without changing the old receipt', async (t) => {
  const h = await harness(t);
  h.setUnavailable(true);
  amber(h, 1);
  await flush();
  const evaluate = h.page.evaluate;
  let pulled = false;
  h.page.evaluate = async (fn, arg) => {
    const result = await evaluate(fn, arg);
    if (fn.toString().includes('.observations?.')) {
      pulled = true;
      return result;
    }
    if (pulled && fn.toString().includes('.snapshot()')) {
      pulled = false;
      return { ...result, documentId: 'replacement-document' };
    }
    return result;
  };
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
  assert.notEqual(h.runtime.watchdog.status().phase, 'disarmed');
  assert.equal(h.api.snapshot().observationPending, 1);
  assert.equal(h.writes.length, 0);
});


test('browser watchdog and actual userscript agree on English apology, pulled echo and one terminal concession', async (t) => {
  const h = await harness(t, { language: 'en', apologyEchoMs: 1000 });
  // Match the existing callback-failure scenario: consume the native echo through the independent pull.
  h.setUnavailable(true);
  await delay(20);
  await h.runtime.tick();
  await delay(20);
  await h.runtime.tick();
  await flush();
  assert.deepEqual(h.writes, [['game', 'chat', watchdogApology('en')]]);
  await h.runtime.tick();
  await flush();
  assert.equal(h.runtime.watchdog.status().episode.apologyEcho, true);
  assert.deepEqual(h.writes, [['game', 'chat', watchdogApology('en')], ['game', 'concede']]);
  await h.runtime.tick();
  assert.equal(h.state.finished, true);
  assert.equal(h.runtime.watchdog.status().episode.phase, 'terminal-confirmed');
  await h.runtime.tick();
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.calls, { reload: 0, restart: 0 });
  assert.deepEqual(h.ledger(), h.initialLedger);
});
