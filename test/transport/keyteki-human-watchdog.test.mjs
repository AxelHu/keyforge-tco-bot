import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import {
  createHumanWatchdog,
  createWatchdogNativeObserver,
  watchdogResponsibility,
  watchdogProgressHashes,
  WATCHDOG_APOLOGY,
} from "../../tools/keyteki-human-watchdog.mjs";
import { watchdogApology } from '../../tools/keyteki-language.mjs';
import { userscriptBootstrap } from "../../tools/keyteki-browser-bootstrap.mjs";
import { createOneSeatBridgeBinding } from "../../tools/keyteki-human-bridge-callback.mjs";

const identity = { gameId: 'verified-game', playerName: 'Self', participants: ['Self', 'Visitor'] };
const player = (name, active) => ({
  name,
  activePlayer: active,
  phase: 'main',
  activeHouse: active ? 'logos' : null,
  stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false } },
  numDeckCards: 30,
  numArchivesCards: 0,
  cardPiles: {
    hand: [],
    archives: [],
    discard: [],
    purged: [],
    cardsInPlay: [{ uuid: 'card-1', name: 'Creature', exhausted: false, damage: 0 }],
  },
  menuTitle: active ? 'Play cards or use creatures' : 'Waiting for opponent...',
  buttons: active ? [{ text: 'End Turn', arg: 'endturn' }] : [],
  controls: [],
});
const raw = () => ({
  id: identity.gameId,
  started: true,
  manualMode: false,
  messages: [],
  players: { Self: player('Self', true), Visitor: player('Visitor', false) },
});
const receipt = (n = 1, doc = 'document-1') => ({
  documentId: doc,
  ownerEpoch: 1,
  nativeSequence: n,
  frameToken: 'frame-' + n,
  transportPath: 'http://fixture.test/node/socket.io',
});
function harness(overrides = {}) {
  let now = 0,
    seq = 0;
  const actions = [],
    recoveries = [],
    events = [];
  const w = createHumanWatchdog({
    identity,
    clock: () => now,
    config: {
      stallMs: 100,
      modelGraceMs: 400,
      recoveryGraceMs: 50,
      apologyEchoMs: 30,
      terminalAckMs: 60,
      pollMs: 10,
      ...overrides.config,
    },
    inspect: async (scope) => ({ valid: true, binding: scope }),
    recover: async (x) => {
      recoveries.push(x);
      return { ok: false };
    },
    act: async (kind, proof) => {
      actions.push({ kind, proof });
      return { queued: true, attempted: true, outcome: 'native-queued' };
    },
    onEvent: (e) => events.push(e),
    ...overrides,
    config: {
      stallMs: 100,
      modelGraceMs: 400,
      recoveryGraceMs: 50,
      apologyEchoMs: 30,
      terminalAckMs: 60,
      pollMs: 10,
      ...overrides.config,
    },
  });
  return {
    w,
    actions,
    recoveries,
    events,
    set: (t) => {
      now = t;
    },
    advance: (ms) => {
      now += ms;
    },
    observe: (x = raw(), doc = 'document-1') => w.observe(x, receipt(++seq, doc)),
  };
}

test('responsibility follows actionable own prompts, localized waiting and agreement Back', () => {
  const x = raw(),
    me = x.players.Self;
  assert.equal(watchdogResponsibility(x, 'Self').ours, true);
  me.menuTitle = { text: 'Waiting for opponent...', values: [] };
  me.buttons = [];
  assert.equal(watchdogResponsibility(x, 'Self').ours, false);
  me.buttons = [{ text: { text: 'Back' }, arg: 'back' }];
  assert.equal(watchdogResponsibility(x, 'Self').ours, false);
  me.activePlayer = false;
  me.controls = [{ type: 'targeting', source: { uuid: 'a' } }];
  assert.equal(watchdogResponsibility(x, 'Self').ours, false);
  me.controls = [{ type: 'card-name', command: 'menuButton', method: 'choose' }];
  assert.equal(watchdogResponsibility(x, 'Self').ours, true);
  x.winner = { name: 'Visitor' };
  assert.equal(watchdogResponsibility(x, 'Self').reason, 'terminal');
});

test('chat, clocks, receipt polls and card selection previews do not renew board progress', () => {
  const x = raw(),
    initial = watchdogProgressHashes(x);
  x.messages.push({ id: 'chat', message: ['hello'] });
  x.players.Self.clock = { timeLeft: 7 };
  Object.assign(x.players.Self.cardPiles.cardsInPlay[0], {
    selected: true,
    selectable: true,
    unselectable: true,
    pseudoDamage: 4,
    wardBroken: true,
  });
  assert.deepEqual(watchdogProgressHashes(x), initial);
});

test('continuous chat still reaches one recovery and one fault concession', async () => {
  const h = harness();
  h.observe();
  for (let t = 10; t <= 100; t += 10) {
    h.set(t);
    const x = raw();
    x.messages = [{ id: 'chat' + t, message: ['hello'] }];
    h.observe(x);
    h.w.bridge({ status: 'thinking', receiptOrdinal: t, nodeSequence: t });
    await h.w.tick();
  }
  assert.equal(h.recoveries.length, 1);
  h.advance(50);
  await h.w.tick();
  h.advance(30);
  await h.w.tick();
  await h.w.tick();
  assert.deepEqual(
    h.actions.map((x) => x.kind),
    ['apology', 'concede'],
  );
});

test('meaningful same-turn changes continue without a false stall', async () => {
  const h = harness();
  const x = raw();
  h.observe(x);
  for (let i = 1; i <= 20; i++) {
    h.advance(90);
    x.players.Self.stats.amber = i;
    h.observe(structuredClone(x));
    await h.w.tick();
  }
  assert.equal(h.recoveries.length, 0);
  assert.equal(h.actions.length, 0);
});

test('real selection preview plus menu/cancel UUID cycles cannot extend the deadline', async () => {
  const h = harness();
  h.observe();
  for (let i = 1; i <= 12; i++) {
    h.advance(20);
    const x = raw(),
      select = !!(i % 2);
    x.players.Self.menuTitle = select ? 'Choose a target' : 'Play cards or use creatures';
    x.players.Self.selectCard = select;
    x.players.Self.buttons = [
      {
        text: select ? 'Cancel' : 'End Turn',
        arg: select ? 'cancel' : 'endturn',
        uuid: '00000000-0000-0000-0000-' + String(i).padStart(12, '0'),
      },
    ];
    Object.assign(x.players.Self.cardPiles.cardsInPlay[0], {
      unselectable: select,
      pseudoDamage: select ? 2 : 0,
      wardBroken: select,
    });
    h.observe(x);
    await h.w.tick();
  }
  assert.equal(h.recoveries.length, 1);
  assert.ok(h.events.some((e) => e.type === 'stall-confirmed'));
});

test('opponent prompt wait, manual mode, operator pause and natural terminal never escalate', async () => {
  for (const kind of ['waiting', 'manual', 'operator', 'terminal']) {
    const h = harness(),
      x = raw();
    if (kind === 'waiting') {
      x.players.Self.menuTitle = 'Waiting for opponent...';
      x.players.Self.buttons = [];
    }
    if (kind === 'manual') x.manualMode = true;
    if (kind === 'terminal') x.winner = 'Visitor';
    h.observe(x);
    if (kind === 'operator') h.w.operatorPause();
    h.advance(10000);
    await h.w.tick();
    assert.equal(h.actions.length, 0, kind);
    assert.equal(h.recoveries.length, 0, kind);
  }
});

test('actual model flag gets one finite budget; generic thinking and repeated false/true cannot renew it', async () => {
  const h = harness();
  h.observe();
  h.w.bridge({ modelInFlight: true });
  h.set(350);
  await h.w.tick();
  assert.equal(h.recoveries.length, 0);
  h.w.bridge({ modelInFlight: false });
  h.w.bridge({ modelInFlight: true });
  h.set(401);
  await h.w.tick();
  assert.equal(h.recoveries.length, 1);
  const code = harness();
  code.observe();
  code.w.bridge({ status: 'thinking' });
  code.set(100);
  await code.w.tick();
  assert.equal(code.recoveries.length, 1);
});

test('a genuine state change during awaited recovery cancels escalation', async () => {
  let complete;
  const h = harness({
    recover: () =>
      new Promise((r) => {
        complete = r;
      }),
  });
  h.observe();
  h.advance(100);
  const pending = h.w.tick();
  await new Promise((r) => setImmediate(r));
  const x = raw();
  x.players.Self.stats.amber = 1;
  h.observe(x);
  complete({ ok: true });
  await pending;
  h.advance(51);
  await h.w.tick();
  assert.equal(h.actions.length, 0);
  assert.equal(h.w.status().episode, null);
});

test('new document full with identical gameplay does not erase failed recovery timer', async () => {
  const h = harness();
  h.observe();
  h.advance(100);
  await h.w.tick();
  h.advance(25);
  h.observe(raw(), 'document-2');
  h.advance(25);
  await h.w.tick();
  assert.deepEqual(
    h.actions.map((x) => x.kind),
    ['apology'],
  );
});

test('unknown gameplay send reaches recovery hook without replay or clearing', async () => {
  const h = harness();
  h.observe();
  h.w.bridge({ status: 'send-outcome-unknown', sendPending: { sendTicket: 'unknown' } });
  h.advance(100);
  await h.w.tick();
  assert.equal(h.recoveries[0].unknownSend, true);
  assert.equal(h.actions.length, 0);
  assert.equal(h.w.status().episode.recoveries, 1);
});

test('apology failure is bounded and does not block one native concession attempt', async () => {
  const actions = [];
  const h = harness({
    config: { maxRecoveries: 0, stallMs: 100, apologyEchoMs: 30 },
    act: async (kind) => {
      actions.push(kind);
      if (kind === 'apology') throw Error('transport unavailable');
      return { queued: true };
    },
  });
  h.observe();
  h.advance(100);
  await h.w.tick();
  h.advance(30);
  await h.w.tick();
  h.advance(1000);
  await h.w.tick();
  await h.w.tick();
  assert.deepEqual(actions, ['apology', 'concede']);
  assert.equal(h.w.status().episode.phase, 'terminal-unconfirmed');
});

test('explicit not-attempted chat race is retried; unknown/native-queued writes are never replayed', async () => {
  const attempts = { apology: 0, concede: 0 },
    sent = [];
  const h = harness({
    config: { maxRecoveries: 0, stallMs: 100, apologyEchoMs: 30 },
    act: async (kind) => {
      if (++attempts[kind] === 1) return { queued: false, attempted: false, reason: 'stale-frame' };
      sent.push(kind);
      return { queued: true, attempted: true };
    },
  });
  h.observe();
  h.advance(100);
  await h.w.tick();
  await h.w.tick();
  h.advance(30);
  await h.w.tick();
  await h.w.tick();
  h.advance(1000);
  await h.w.tick();
  assert.deepEqual(sent, ['apology', 'concede']);
  assert.deepEqual(attempts, { apology: 2, concede: 2 });
});

test('own native apology echo permits prompt concession; terminal proof is recorded once', async () => {
  const h = harness({ config: { maxRecoveries: 0, stallMs: 100, apologyEchoMs: 1000 } });
  h.observe();
  h.advance(100);
  await h.w.tick();
  const x = raw();
  x.messages = [{ id: 'native-chat', message: [{ name: 'Self', argType: 'player' }, ' ', WATCHDOG_APOLOGY] }];
  h.observe(x);
  await h.w.tick();
  x.winner = { name: 'Visitor' };
  h.observe(x);
  h.observe(x);
  await h.w.tick();
  assert.deepEqual(
    h.actions.map((x) => x.kind),
    ['apology', 'concede'],
  );
  assert.equal(h.events.filter((e) => e.type === 'terminal-confirmed').length, 1);
});

test('progress/opponent turn while apology awaits never sends a late concession', async () => {
  let done;
  const h = harness({
    config: { maxRecoveries: 0, stallMs: 100 },
    act: () =>
      new Promise((r) => {
        done = r;
      }),
  });
  h.observe();
  h.advance(100);
  const pending = h.w.tick();
  await new Promise((r) => setImmediate(r));
  const x = raw();
  x.players.Self.activePlayer = false;
  x.players.Self.menuTitle = 'Waiting for opponent...';
  x.players.Self.buttons = [];
  h.observe(x);
  done({ queued: true });
  await pending;
  h.advance(1000);
  await h.w.tick();
  assert.equal(h.w.status().episode, null);
});

test('unresponsive inspection is bounded and cannot authorize stale fallback', async () => {
  const h = harness({ operationTimeoutMs: 10, inspect: () => new Promise(() => {}) });
  h.observe();
  h.advance(100);
  await h.w.tick();
  assert.equal(h.actions.length, 0);
  assert.ok(h.events.some((e) => e.type === 'binding-check-unavailable'));
  h.w.invalidate('superseded-owner');
  await h.w.tick();
  assert.equal(h.w.status().phase, 'disarmed');
});

test('native mirror permits validated new full but fences retired documents and delta gaps', () => {
  const seen = [];
  const observer = createWatchdogNativeObserver({
    identity,
    validateFull: () => {},
    onState: (x, r) => seen.push({ x, r }),
  });
  const frame = (doc, n, delta) => ({
    ...identity,
    documentId: doc,
    nativeSequence: n,
    frameToken: 'f' + n,
    newEngineHandshake: true,
    transportPath: 'http://fixture.test/node/socket.io',
    delta,
  });
  observer.receive(frame('old', 1, raw()));
  observer.receive(frame('old', 2, { players: { Self: { stats: { amber: [0, 1] } } } }));
  assert.equal(observer.snapshot().players.Self.stats.amber, 1);
  assert.throws(() => observer.receive(frame('old', 4, { messages: [] })), /gap/);
  observer.receive(frame('new', 1, raw()));
  assert.equal(observer.receive(frame('old', 3, raw())).ignored, true);
  assert.equal(seen.length, 3);
});

function guardianHarness({
  storage = new Map(),
  hostDown = true,
  pageOrigin = 'http://fixture.test',
  socketOrigin = pageOrigin.replace(/^http/, 'ws'),
  language,
} = {}) {
  const sends = [],
    frames = [],
    warnings = [],
    intervals = [];
  class NativeSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.events = new Map();
    }
    addEventListener(name, fn) {
      this.events.set(name, [...(this.events.get(name) ?? []), fn]);
    }
    send(data) {
      sends.push(data);
    }
    emit(data) {
      for (const fn of this.events.get('message') ?? []) fn({ data });
    }
    close() {
      this.readyState = 3;
      for (const fn of this.events.get('close') ?? []) fn({ code: 1006, wasClean: false, reason: '' });
    }
  }
  const origin = pageOrigin,
    context = {
      WebSocket: NativeSocket,
      URL,
      crypto: webcrypto,
      location: { origin, href: origin + '/play' },
      console: { warn: (...args) => warnings.push(args.join(' ')), info() {} },
      setInterval: (fn) => intervals.push(fn),
      setTimeout,
      clearTimeout,
      addEventListener() {},
      sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
      __kfWatchdogFrame: async (frame) => {
        frames.push(frame);
        return {
          accepted: true,
          receipt: Object.fromEntries(
            ['documentId', 'ownerEpoch', 'nativeSequence', 'frameToken', 'transportPath'].map((key) => [
              key,
              frame[key],
            ]),
          ),
        };
      },
      __kfGMRequest: async (request) => {
        if (hostDown) throw Error('host unavailable');
        const d = JSON.parse(request.data);
        return {
          status: 200,
          responseText: JSON.stringify({
            gameId: identity.gameId,
            documentId: d.sessionId,
            ownerEpoch: 1,
            receiptOrdinal: 1,
            sendPending: null,
          }),
        };
      },
    };
  context.window = context;
  context.top = context;
  vm.createContext(context);
  vm.runInContext(
    userscriptBootstrap(
      {
        url: 'http://127.0.0.1:32123',
        token: 'a'.repeat(64),
        playerName: 'Self',
        managedSessions: true,
        humanWatchdog: { enabled: true, gameId: identity.gameId, participants: identity.participants, ...(language !== undefined ? { language } : {}) },
      },
      fs.readFileSync(new URL("../../tools/keyteki-shared-strategy.user.js", import.meta.url), 'utf8'),
    ),
    context,
  );
  const ws = new context.WebSocket(socketOrigin + '/node/socket.io/?transport=websocket');
  ws.emit('0{"sid":"engine-one"}');
  ws.emit('42' + JSON.stringify(['gamestate', raw()]));
  const api = context.__kfHumanFaultGuardian,
    ticket = () => ({ ...api.snapshot(), episodeId: 'a'.repeat(24), apologyCompleted: true });
  return {
    context,
    ws,
    api,
    ticket,
    sends,
    frames,
    warnings,
    storage,
    flush: () => new Promise((r) => setImmediate(r)),
  };
}

test('actual userscript guardian keeps native receipt and fixed fault lane alive after host failure', async () => {
  const h = guardianHarness();
  await h.flush();
  assert.ok(h.warnings.some((x) => x.includes('paused')));
  assert.equal(h.frames.length, 1);
  assert.equal(h.api.act('anything', h.ticket()).attempted, false);
  assert.equal(h.api.act('apology', h.ticket()).queued, true);
  h.ws.emit(
    '42' +
      JSON.stringify([
        'gamestate',
        {
          messages: [
            [],
            [{ id: 'echo', message: [{ name: 'Self', argType: 'player' }, ' ', WATCHDOG_APOLOGY] }],
          ],
        },
      ]),
  );
  await h.flush();
  assert.equal(h.frames.length, 2);
  assert.equal(h.api.act('concede', h.ticket()).queued, true);
  assert.deepEqual(
    h.sends.map((x) => JSON.parse(x.slice(2))),
    [
      ['game', 'chat', WATCHDOG_APOLOGY],
      ['game', 'concede'],
    ],
  );
  assert.equal(h.api.snapshot().operatorPaused, false);
  assert.equal(h.api.act('concede', h.ticket()).reason, 'already-attempted');
});

test('actual guardian binds the secondary native game endpoint and rejects a competing node', async () => {
  const h = guardianHarness({
    pageOrigin: 'http://fixture.test',
    socketOrigin: 'ws://fixture.test:9500',
  });
  await h.flush();
  const snap = h.api.snapshot();
  assert.equal(snap.transportPath, 'http://fixture.test:9500/node/socket.io');
  assert.equal(snap.connected, true);
  assert.equal(snap.invalid, false);
  assert.equal(h.frames[0].transportPath, snap.transportPath);
  assert.equal(h.frames[0].frameToken, snap.frameToken);
  const competing = new h.context.WebSocket(
    'ws://fixture.test:9500/other-node/socket.io/?transport=websocket',
  );
  competing.emit('0{"sid":"engine-two"}');
  competing.emit('42' + JSON.stringify(['gamestate', raw()]));
  await h.flush();
  assert.equal(h.api.snapshot().invalid, true);
  assert.equal(h.frames.length, 1);
  assert.equal(h.api.act('apology', h.ticket()).attempted, false);
  assert.equal(h.sends.length, 0);
});

test('closed native socket can be quarantined for recovery but cannot send a concession', async () => {
  const h = guardianHarness();
  await h.flush();
  h.ws.close();
  assert.equal(h.api.snapshot().connected, false);
  assert.equal(h.api.quarantine(h.ticket()), true);
  assert.equal(h.api.act('apology', h.ticket()).attempted, false);
  assert.equal(h.sends.length, 0);
});

test('guardian stale token refuses before writing; persisted queued faults survive document replacement', async () => {
  const h = guardianHarness();
  await h.flush();
  const old = h.ticket();
  h.ws.emit('42' + JSON.stringify(['gamestate', { messages: [[], []] }]));
  await h.flush();
  assert.equal(h.api.act('apology', old).attempted, false);
  assert.equal(h.api.snapshot().ledger, null);
  assert.equal(h.api.act('apology', h.ticket()).queued, true);
  assert.equal(h.api.act('concede', h.ticket()).queued, true);
  const next = guardianHarness({ storage: h.storage });
  await next.flush();
  assert.equal(next.api.act('apology', next.ticket()).reason, 'already-attempted');
  assert.equal(next.api.act('concede', next.ticket()).reason, 'already-attempted');
  assert.equal(next.sends.length, 0);
});

test('external manual gameplay marks operator ownership even after strategy host failure', async () => {
  const h = guardianHarness();
  await h.flush();
  h.ws.send('42' + JSON.stringify(['game', 'menuButton', 'endturn']));
  assert.equal(h.api.snapshot().operatorPaused, true);
  assert.equal(h.api.act('apology', h.ticket()).attempted, false);
});

test('late old-document callback failure cannot pause or disarm current owner', async () => {
  for (const reply of ['fence', 'network']) {
    let finish,
      current = 'old';
    const held = [],
      invalid = [];
    const origin = 'http://fixture.test',
      frame = { url: () => origin + '/play' },
      page = { mainFrame: () => frame };
    const connection = { url: 'http://127.0.0.1:32123', token: 'a'.repeat(64) },
      config = { origin, self: { name: 'Self' }, room: { gameId: identity.gameId } };
    const callback = createOneSeatBridgeBinding({
      page,
      config,
      connection,
      observer: {},
      state: {},
      mirror: {},
      save: () => {},
      hold: async (r) => held.push(r),
      watchdog: { isCurrentDocument: async (doc) => doc === current, invalidate: (r) => invalid.push(r) },
      fetchImpl: () =>
        new Promise((resolve, reject) => {
          finish = () =>
            reply === 'fence'
              ? resolve(new Response('{"code":"superseded-owner"}', { status: 409 }))
              : reject(Error('late timeout'));
        }),
    });
    const pending = callback(
      { page, frame },
      {
        url: connection.url + '/decision',
        method: 'POST',
        headers: { Authorization: 'Bearer ' + connection.token },
        data: JSON.stringify({ origin, playerName: 'Self', gameId: identity.gameId, documentId: 'old' }),
      },
    );
    await new Promise((r) => setImmediate(r));
    current = 'new';
    finish();
    const result = await pending;
    assert.equal(result.status, 409);
    assert.deepEqual(held, []);
    assert.deepEqual(invalid, []);
  }
});

test('explicit no-write concession refusal after real progress cancels the old episode', async () => {
  let refuse;
  const h = harness({
    config: { maxRecoveries: 0, stallMs: 100, apologyEchoMs: 30 },
    act: async (kind) =>
      kind === 'apology'
        ? { queued: true }
        : new Promise((r) => {
            refuse = r;
          }),
  });
  h.observe();
  h.advance(100);
  await h.w.tick();
  h.advance(30);
  const pending = h.w.tick();
  await new Promise((r) => setImmediate(r));
  const x = raw();
  x.players.Self.stats.amber = 1;
  h.observe(x);
  refuse({ queued: false, attempted: false });
  await pending;
  assert.equal(h.w.status().episode, null);
  h.advance(20);
  await h.w.tick();
  assert.equal(h.w.status().episode, null);
  assert.ok(h.events.some((e) => e.type === 'concede-not-sent'));
});


test('English watchdog accepts only the matching own apology echo before conceding', async () => {
  const h = harness({ origin: 'https://thecrucible.online', config: { maxRecoveries: 0, stallMs: 100, apologyEchoMs: 1000 } });
  h.observe();
  h.advance(100);
  await h.w.tick();
  const x = raw();
  x.messages = [{ id: 'wrong-language', message: [{ name: 'Self', argType: 'player' }, ' ', WATCHDOG_APOLOGY] }];
  h.observe(x);
  await h.w.tick();
  assert.deepEqual(h.actions.map(x => x.kind), ['apology']);
  x.messages = [{ id: 'english-echo', message: [{ name: 'Self', argType: 'player' }, ' ', watchdogApology('en')] }];
  h.observe(x);
  await h.w.tick();
  assert.deepEqual(h.actions.map(x => x.kind), ['apology', 'concede']);
  await h.w.tick();
  assert.equal(h.actions.length, 2);
});

test('actual international userscript sends the English fault notice once and keeps its ledger across reload', async () => {
  const h = guardianHarness({ pageOrigin: 'https://thecrucible.online' });
  await h.flush();
  assert.equal(h.api.act('apology', h.ticket()).queued, true);
  assert.deepEqual(h.sends.map(x => JSON.parse(x.slice(2))), [['game', 'chat', watchdogApology('en')]]);
  assert.equal(h.api.act('apology', h.ticket()).reason, 'already-attempted');
  const reloaded = guardianHarness({ pageOrigin: 'https://thecrucible.online', storage: h.storage });
  await reloaded.flush();
  assert.equal(reloaded.api.act('apology', reloaded.ticket()).reason, 'already-attempted');
  assert.equal(reloaded.sends.length, 0);
  const explicit = guardianHarness({ language: 'en' });
  await explicit.flush();
  assert.equal(explicit.api.act('apology', explicit.ticket()).queued, true);
  assert.deepEqual(explicit.sends.map(x => JSON.parse(x.slice(2))), [['game', 'chat', watchdogApology('en')]]);
});
