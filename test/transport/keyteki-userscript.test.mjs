import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';
import { keytekiTransportBinding } from "../../tools/keyteki-transport-recovery.mjs";
const code = fs.readFileSync(new URL("../../tools/keyteki-shared-strategy.user.js", import.meta.url), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness({
  failSendAt,
  origin = 'https://thecrucible.online',
  playerName = 'alpha',
  browserCrypto = webcrypto,
  respond,
  managed = false,
} = {}) {
  const calls = [],
    sends = [],
    diagnostics = [],
    storage = new Map();
  let interval,
    decision = null,
    held = null,
    holdDecision = false,
    gameSendAttempts = 0,
    now = Date.now();
  class Socket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.events = new Map();
    }
    addEventListener(name, fn) {
      const a = this.events.get(name) ?? [];
      a.push(fn);
      this.events.set(name, a);
    }
    emit(data) {
      for (const f of this.events.get('message') ?? []) f({ data });
    }
    send(data) {
      if (data.startsWith('42') && ++gameSendAttempts === failSendAt) throw Error('fixture send interrupted');
      sends.push({ url: this.url, data });
    }
    close(event = {}) {
      this.readyState = 3;
      for (const f of this.events.get('close') ?? []) f(event);
    }
  }
  class XHR {
    constructor() {
      this.events = [];
      this.responseType = '';
    }
    addEventListener(name, f) {
      if (name === 'load') this.events.push(f);
    }
    open(_method, url) {
      this.url = url;
    }
    send(body) {
      this.body = body;
    }
    emit(data) {
      this.responseText = data;
      for (const f of this.events) f();
    }
  }
  const win = { WebSocket: Socket, XMLHttpRequest: XHR };
  const context = {
    unsafeWindow: win,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    URL,
    crypto: browserCrypto,
    Date: { now: () => now },
    location: { origin, href: origin + '/play' },
    console: {
      warn() {},
      info(message) {
        diagnostics.push(message);
      },
    },
    setInterval: (f) => {
      interval = f;
    },
    prompt() {
      throw Error('No prompts during background operation');
    },
    alert() {},
    GM_getValue: () => ({
      url: 'http://127.0.0.1:55422',
      token: 'a'.repeat(64),
      playerName,
      managedSessions: managed,
    }),
    GM_setValue() {},
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(req) {
      const data = JSON.parse(req.data),
        route = new URL(req.url).pathname;
      calls.push({ route, data });
      const finish = async () => {
        const body = await (respond?.(route, data) ?? (route === '/decision' ? { decision } : {}));
        req.onload({ status: 200, responseText: JSON.stringify(body) });
      };
      if (route === '/decision' && holdDecision) held = finish;
      else queueMicrotask(finish);
    },
  };
  vm.runInNewContext(code, context);
  return {
    win,
    calls,
    sends,
    diagnostics,
    storage,
    run: () => interval(),
    advanceMs: (ms) => {
      now += ms;
    },
    decision: (x) => {
      decision = x;
    },
    hold: () => {
      holdDecision = true;
    },
    release: () => held?.(),
  };
}
const gameUrl = 'https://thecrucible.online/node1/socket.io/?transport=polling';
const wsUrl = 'wss://thecrucible.online/node1/socket.io/?transport=websocket';
const state = { id: 'match', players: { alpha: { name: 'alpha' }, beta: { name: 'beta' } } };
const command = (sequence) => ({
  decisionId: 'd1',
  sequence,
  activity: 0,
  gameId: 'match',
  command: { message: 'menuButton', args: [null, 'start'], navigation: false },
});
test('polling full state is retained before WebSocket upgrade; only one ordinary game message is sent', async () => {
  const h = harness(),
    xhr = new h.win.XMLHttpRequest();
  xhr.open('GET', gameUrl);
  xhr.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  assert.equal(h.calls[0].route, '/state');
  assert.deepEqual(h.calls[0].data.delta, state);
  const ws = new h.win.WebSocket(wsUrl);
  ws.send('5');
  h.decision(command(1));
  await h.run();
  await tick();
  assert.equal(h.sends.filter((s) => s.data.startsWith('42')).length, 1);
  assert.equal(h.sends.at(-1).data, '42["game","menuButton",null,"start"]');
  assert.equal(h.calls.at(-1).route, '/sent');
});
test('HTTP without randomUUID still delivers commands and rotates opaque session IDs after clear', async () => {
  const origin = 'http://fixture.test';
  const h = harness({
    origin,
    browserCrypto: { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) },
  });
  const ws = new h.win.WebSocket('ws://fixture.test/node1/socket.io/?transport=websocket');
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const first = h.calls.find((call) => call.route === '/state').data;
  assert.equal(first.origin, origin);
  assert.match(first.sessionId, /^[a-f0-9]{32}$/);
  h.decision(command(1));
  await h.run();
  await tick();
  assert.equal(h.sends.at(-1).data, '42["game","menuButton",null,"start"]');
  assert.equal(h.calls.find((call) => call.route === '/sent').data.sessionId, first.sessionId);
  ws.emit('42["cleargamestate"]');
  await tick();
  ws.emit('42' + JSON.stringify(['gamestate', { ...state, id: 'next-match' }]));
  await tick();
  const next = h.calls.filter((call) => call.route === '/state').at(-1).data;
  assert.match(next.sessionId, /^[a-f0-9]{32}$/);
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(h.calls.find((call) => call.route === '/clear').data.sessionId, first.sessionId);
});
// A historical-recording test is intentionally not part of this synthetic public suite.


test('lobby upgrade and gamestate never become the gameplay command socket', async () => {
  const h = harness(),
    ws = new h.win.WebSocket('wss://thecrucible.online/socket.io/?transport=websocket');
  ws.send('5');
  await h.run();
  await tick();
  assert.equal(h.calls.length, 0);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  await h.run();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(
    h.sends.map((send) => send.data),
    ['5'],
  );
  const game = new h.win.WebSocket(wsUrl);
  game.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  await h.run();
  await tick();
  assert.equal(h.calls.find((call) => call.route === '/state').data.delta.id, 'match');
  assert.equal(h.sends.at(-1).url, wsUrl);
  assert.equal(h.sends.at(-1).data, '42["game","menuButton",null,"start"]');
});
test('a newer incoming player state suppresses an already requested stale command', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  h.hold();
  const poll = h.run();
  await tick();
  ws.emit('42' + JSON.stringify(['gamestate', { players: { beta: { amber: [0, 1] } } }]));
  await tick();
  h.release();
  await poll;
  await tick();
  assert.equal(h.sends.length, 0);
  assert.ok(h.calls.some((c) => c.route === '/reject'));
});
test('clear-game keeps the old session identity and cannot send its delayed decision into a new game', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const oldId = h.calls[0].data.sessionId;
  h.decision(command(1));
  h.hold();
  const poll = h.run();
  await tick();
  ws.emit('42["cleargamestate"]');
  await tick();
  h.release();
  await poll;
  await tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.calls.find((c) => c.route === '/clear').data.sessionId, oldId);
});

test('actual browser bootstrap parses and returns the configured object', async () => {
  const { userscriptBootstrap } = await import("../../tools/keyteki-browser-bootstrap.mjs");
  const settings = { url: 'http://127.0.0.1:1234', token: 'a'.repeat(64), playerName: 'sample_name' };
  const code = userscriptBootstrap(settings, 'globalThis.result=GM_getValue("kf-bridge-settings",null);');
  const scope = {};
  scope.window = scope;
  vm.runInNewContext(code, scope);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.result)), settings);
  assert.equal(typeof scope.GM_xmlhttpRequest, 'function');
});

const allocation = (sequence = 1) => ({
  decisionId: 'allocation-final-decision',
  sequence,
  activity: 0,
  gameId: 'match',
  plan: {
    kind: 'keyteki-allocation-plan-v1',
    id: 'complete-plan',
    promptUuid: 'allocation-prompt',
    sourceCardId: 'festival-source',
    amount: 3,
    allowedTargets: ['creature-a', 'creature-b'],
    targets: ['creature-a', 'creature-b', 'creature-a'],
    commands: ['creature-a', 'creature-b', 'creature-a'].map((target) => ({
      message: 'cardClicked',
      args: [target],
      sourceCardId: 'festival-source',
      navigation: false,
    })),
  },
});

test('a complete draft queues its ordered ordinary card clicks on the original socket only once', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  await h.run();
  await tick();
  assert.deepEqual(
    h.sends.map((s) => JSON.parse(s.data.slice(2))),
    [
      ['game', 'cardClicked', 'creature-a'],
      ['game', 'cardClicked', 'creature-b'],
      ['game', 'cardClicked', 'creature-a'],
    ],
  );
  assert.ok(h.sends.every((s) => s.url === wsUrl));
  const receipt = h.calls.find((c) => c.route === '/sent').data;
  assert.equal(receipt.queuedCount, 3);
  assert.equal(receipt.planId, 'complete-plan');
  assert.ok(!h.calls.some((c) => c.route === '/activity'));
  await h.run();
  await tick();
  assert.equal(h.sends.length, 3);
});

test('a partial synchronous send stops with its precise locally queued prefix and never retries it', async () => {
  const h = harness({ failSendAt: 2 }),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  await h.run();
  await tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.calls.find((c) => c.route === '/unknown').data.queuedCount, 1);
  assert.equal(h.calls.find((c) => c.route === '/unknown').data.planId, 'complete-plan');
  assert.ok(!h.calls.some((c) => c.route === '/sent'));
  await h.run();
  assert.equal(h.sends.length, 1);
});

test('manual original-socket input while a decision is pending pauses the unsent allocation', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  h.hold();
  const pending = h.run();
  await tick();
  ws.send('42["game","cardClicked","manual-target"]');
  h.release();
  await pending;
  await tick();
  assert.deepEqual(
    h.sends.map((s) => JSON.parse(s.data.slice(2))),
    [['game', 'cardClicked', 'manual-target']],
  );
  assert.equal(h.calls.find((c) => c.route === '/activity').data.epoch, 1);
  assert.ok(!h.calls.some((c) => c.route === '/sent'));
});

test('manual polling-transport input is observed without copying its content to the bridge', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const xhr = new h.win.XMLHttpRequest();
  xhr.open('POST', gameUrl);
  xhr.send('42["game","cardClicked","manual-target"]');
  await tick();
  h.decision(allocation());
  await h.run();
  assert.equal(h.sends.length, 0);
  const data = h.calls.find((c) => c.route === '/activity').data;
  assert.equal(data.epoch, 1);
  assert.equal(data.reason, 'external-game-command');
  assert.ok(!JSON.stringify(data).includes('manual-target'));
});

test('a current game socket closing pauses further commands and reports unknown outcome', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  await h.run();
  await tick();
  ws.close();
  await tick();
  await h.run();
  assert.equal(h.sends.length, 3);
  assert.ok(h.calls.some((c) => c.route === '/disconnect' && c.data.reason === 'game-transport-closed'));
});

test('a malformed allocation target binding is rejected before the first socket send', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const d = allocation();
  d.plan.commands[1].args[0] = 'outside-offered-targets';
  h.decision(d);
  await h.run();
  await tick();
  assert.equal(h.sends.length, 0);
  assert.ok(!h.calls.some((c) => c.route === '/sent'));
  assert.ok(h.calls.some((c) => c.route === '/disconnect'));
});

test('a different game transport path reports unknown and cannot receive a delayed old plan', async () => {
  const h = harness(),
    old = new h.win.WebSocket(wsUrl);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  h.hold();
  const pending = h.run();
  await tick();
  const next = new h.win.WebSocket('wss://thecrucible.online/node2/socket.io/?transport=websocket');
  next.emit('42' + JSON.stringify(['gamestate', { ...state, id: 'next-match' }]));
  await tick();
  h.release();
  await pending;
  await tick();
  await h.run();
  assert.equal(h.sends.length, 0);
  assert.ok(!h.calls.some((c) => c.route === '/sent'));
  assert.ok(
    h.calls.some((c) => c.route === '/disconnect' && c.data.reason === 'game-transport-path-changed'),
  );
});

test('automatic search-popup close leaves a pending ordinary strategy choice sendable', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  h.hold();
  const pending = h.run();
  await tick();
  ws.send('42["game","showDrawDeck",false]');
  h.release();
  await pending;
  await tick();
  assert.deepEqual(
    h.sends.map((s) => JSON.parse(s.data.slice(2))),
    [
      ['game', 'showDrawDeck', false],
      ['game', 'menuButton', null, 'start'],
    ],
  );
  assert.equal(h.calls.filter((c) => c.route === '/sent').length, 1);
  assert.ok(!h.calls.some((c) => c.route === '/activity'));
  assert.deepEqual(h.diagnostics, ['[KF bridge presentation] showDrawDeck(false)']);
});

test('presentation close never masks a later real action in the same polling write', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(allocation());
  h.hold();
  const pending = h.run();
  await tick();
  const xhr = new h.win.XMLHttpRequest();
  xhr.open('POST', gameUrl);
  xhr.send('42["game","showDrawDeck",false]\x1e42["game","cardClicked","private-target"]');
  h.release();
  await pending;
  await tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.calls.filter((c) => c.route === '/activity').length, 1);
  assert.ok(!h.calls.some((c) => c.route === '/sent'));
  assert.deepEqual(h.diagnostics, [
    '[KF bridge presentation] showDrawDeck(false)',
    '[KF bridge external-command] cardClicked',
  ]);
  assert.ok(!JSON.stringify(h.calls).includes('private-target'));
  assert.ok(!JSON.stringify(h.diagnostics).includes('private-target'));
});

test('only exact boolean-false deck close is presentational; all near matches still pause', async () => {
  for (const event of [
    ['game', 'showDrawDeck', true],
    ['game', 'showDrawDeck'],
    ['game', 'showDrawDeck', 'false'],
    ['game', 'showDrawDeck', false, 'extra-private-value'],
    ['game', 'showDeck', false],
    ['game', 'shuffleDeck', false],
    ['game', 'unknown-private-opcode', false],
  ]) {
    const h = harness(),
      ws = new h.win.WebSocket(wsUrl);
    ws.emit('42' + JSON.stringify(['gamestate', state]));
    await tick();
    ws.send('42' + JSON.stringify(event));
    h.decision(command(1));
    await h.run();
    await tick();
    assert.equal(h.calls.filter((c) => c.route === '/activity').length, 1);
    assert.ok(!h.calls.some((c) => c.route === '/sent'));
    assert.equal(h.sends.length, 1);
    assert.ok(!JSON.stringify(h.diagnostics).includes('private'));
  }
});

test('a newer frame still rejects an unsent choice after a presentation close', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl);
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  h.hold();
  const pending = h.run();
  await tick();
  ws.send('42["game","showDrawDeck",false]');
  ws.emit('42' + JSON.stringify(['gamestate', { players: { beta: { amber: [0, 1] } } }]));
  await tick();
  h.release();
  await pending;
  await tick();
  assert.equal(h.sends.length, 1);
  assert.ok(h.calls.some((c) => c.route === '/reject'));
  assert.ok(!h.calls.some((c) => c.route === '/sent' || c.route === '/activity'));
});

test('game close diagnostics preserve code/clean flag but never arbitrary reason or transport query', async () => {
  const h = harness(),
    ws = new h.win.WebSocket(wsUrl + '&sid=private-engine-id&token=private-token');
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  ws.close({ code: 1006, wasClean: false, reason: 'private-token in arbitrary close detail' });
  await tick();
  assert.deepEqual(h.diagnostics, [
    '[KF bridge transport-close] ' +
      JSON.stringify({
        epoch: 0,
        code: 1006,
        wasClean: false,
        reason: 'nonempty-redacted',
      }),
  ]);
  assert.ok(h.calls.some((c) => c.route === '/disconnect'));
  assert.ok(!JSON.stringify(h.calls).includes('private-token'));
  assert.ok(!JSON.stringify(h.diagnostics).includes('private-engine-id'));
  await h.run();
  assert.equal(h.sends.length, 0);
});

function recoveryResponder(route, data) {
  if (route === '/transport-close')
    return {
      status: 'waiting-for-transport',
      sequence: data.sequence,
      activity: data.activity,
      gameId: data.gameId,
      transportRecovery: { epoch: data.nextEpoch },
    };
  if (route === '/transport-resume')
    return {
      status: 'waiting-for-opponent',
      sequence: data.sequence,
      activity: data.activity,
      gameId: data.gameId,
      transport: data.transport,
      transportRecovery: null,
    };
  return undefined;
}
function nativeSocket(h, sid = 'engine-old') {
  const ws = new h.win.WebSocket(wsUrl);
  ws.emit('0' + JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 }));
  return ws;
}
function pollingReconnect(h, { sid = 'engine-new', full = state, deltas = [] } = {}) {
  const handshake = new h.win.XMLHttpRequest();
  handshake.open('GET', gameUrl);
  handshake.emit(
    '0' + JSON.stringify({ sid, upgrades: ['websocket'], pingInterval: 25000, pingTimeout: 20000 }),
  );
  const poll = new h.win.XMLHttpRequest();
  poll.open('GET', gameUrl + '&sid=' + sid);
  poll.emit('42' + JSON.stringify(['gamestate', full]));
  for (const delta of deltas) {
    const next = new h.win.XMLHttpRequest();
    next.open('GET', gameUrl + '&sid=' + sid);
    next.emit('42' + JSON.stringify(['gamestate', delta]));
  }
  const ws = new h.win.WebSocket(wsUrl + '&sid=' + sid);
  ws.send('5');
  return ws;
}

test('native reconnect buffers its polling full state until a new same-engine WS and retains session/sequence', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const id = h.calls[0].data.sessionId;
  old.close({ code: 1006, wasClean: false, reason: '' });
  await tick();
  assert.ok(h.calls.some((c) => c.route === '/transport-close'));
  await h.run();
  assert.equal(h.calls.filter((c) => c.route === '/decision').length, 0);
  const next = pollingReconnect(h, { deltas: [{ clock: [1] }] });
  await tick();
  await tick();
  const resumed = h.calls.find((c) => c.route === '/transport-resume');
  assert.deepEqual(resumed.data.fullState, state);
  assert.equal(resumed.data.sequence, 2);
  assert.equal(resumed.data.transport.epoch, 1);
  assert.equal(resumed.data.nativeFullState, true);
  assert.equal(resumed.data.newEngineHandshake, true);
  assert.deepEqual(
    h.calls.filter((c) => c.route === '/state').map((c) => c.data.sequence),
    [1, 3],
  );
  assert.equal(new Set(h.calls.map((c) => c.data.sessionId)).size, 1);
  assert.equal(resumed.data.sessionId, id);
  assert.ok(!JSON.stringify(h.calls).includes('engine-new'));
  h.decision({ ...command(3), decisionId: 'fresh-after-resync' });
  await h.run();
  await tick();
  assert.equal(h.sends.filter((s) => s.data.startsWith('42')).length, 1);
  assert.equal(h.sends.at(-1).url, next.url);
  assert.equal(h.calls.at(-1).route, '/sent');
});

test('late old XHR and WS full packets cannot resync; polling upgrade on the old engine is not a reconnect', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  const late = new h.win.XMLHttpRequest();
  late.open('GET', gameUrl + '&sid=engine-old');
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  old.close();
  await tick();
  late.emit('42' + JSON.stringify(['gamestate', state]));
  old.emit('42' + JSON.stringify(['gamestate', state]));
  const same = new h.win.WebSocket(wsUrl + '&sid=engine-old');
  same.send('5');
  await tick();
  await h.run();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
  assert.equal(h.calls.filter((c) => c.route === '/state').length, 1);
  const next = nativeSocket(h, 'engine-new');
  next.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 1);
  late.emit('42' + JSON.stringify(['gamestate', state]));
  old.emit('42["cleargamestate"]');
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/clear').length, 0);
  assert.equal(h.calls.filter((c) => c.route === '/state').length, 1);
});

test('a new engine delta without its native full packet stops rather than patching the old root', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  old.close();
  await tick();
  const next = nativeSocket(h, 'engine-new');
  next.emit('42' + JSON.stringify(['gamestate', { players: { alpha: { phase: ['main', 'house'] } } }]));
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
  assert.ok(
    h.calls.some(
      (c) => c.route === '/disconnect' && c.data.reason === 'transport-new-generation-needs-full-state',
    ),
  );
  next.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
});

test('a held decision that actually dispatched at close fails closed without trying to reject/replay it', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  h.hold();
  const poll = h.run();
  await tick();
  old.close();
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-close').length, 0);
  h.release();
  await poll;
  await tick();
  assert.equal(h.sends.length, 0);
  assert.equal(h.calls.filter((c) => c.route === '/reject').length, 0);
  assert.ok(
    h.calls.some(
      (c) => c.route === '/disconnect' && c.data.reason === 'transport-close-with-pending-decision',
    ),
  );
  pollingReconnect(h);
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
});

test('an empty in-progress decision poll is drained before the bridge tests idle close', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.hold();
  const poll = h.run();
  await tick();
  old.close();
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-close').length, 0);
  h.release();
  await poll;
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-close').length, 1);
  pollingReconnect(h);
  await tick();
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 1);
});

test('a queued command with an unsettled client receipt is never eligible for reconnect', async () => {
  let release;
  const h = harness({
      respond: (route, data) =>
        route === '/sent'
          ? new Promise((resolve) => {
              release = resolve;
            })
          : recoveryResponder(route, data),
    }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  const poll = h.run();
  await tick();
  old.close();
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-close').length, 0);
  assert.ok(h.calls.some((c) => c.route === '/disconnect'));
  release({});
  await poll;
  pollingReconnect(h);
  await tick();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
  assert.equal(h.sends.filter((s) => s.data.startsWith('42')).length, 1);
});

test('completed decision IDs remain deduplicated after a permitted idle reconnect', async () => {
  const h = harness({ respond: recoveryResponder }),
    old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  h.decision(command(1));
  await h.run();
  await tick();
  old.emit('42' + JSON.stringify(['gamestate', { clock: [1] }]));
  await tick();
  old.close();
  await tick();
  pollingReconnect(h);
  await tick();
  await tick();
  h.decision(command(3));
  await h.run();
  await tick();
  assert.equal(h.sends.filter((s) => s.data.startsWith('42')).length, 1);
  assert.ok(h.calls.some((c) => c.route === '/disconnect' && c.data.reason === 'Duplicate command delivery'));
});

test('bounded idle recovery timeout and manual activity do not permit a later full state to resume', async () => {
  for (const kind of ['timeout', 'activity']) {
    const h = harness({ respond: recoveryResponder }),
      old = nativeSocket(h);
    old.emit('42' + JSON.stringify(['gamestate', state]));
    await tick();
    old.close();
    await tick();
    if (kind === 'timeout') {
      h.advanceMs(60001);
      await h.run();
    } else {
      const request = new h.win.XMLHttpRequest();
      request.open('POST', gameUrl + '&sid=engine-new');
      request.send('42["game","cardClicked","external-target"]');
    }
    await tick();
    pollingReconnect(h);
    await tick();
    assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
    assert.ok(h.calls.some((c) => ['/disconnect', '/activity'].includes(c.route)));
  }
});

test('closing after the bridge observed a terminal winner stops quietly without a recovery or replay', async () => {
  const h = harness({
    respond: (route, data) =>
      route === '/transport-close'
        ? { status: 'finished', gameId: data.gameId, sequence: data.sequence }
        : undefined,
  });
  const old = nativeSocket(h);
  old.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  old.close();
  await tick();
  pollingReconnect(h);
  await tick();
  await h.run();
  assert.equal(h.calls.filter((c) => c.route === '/transport-resume').length, 0);
  assert.equal(h.calls.filter((c) => c.route === '/disconnect').length, 0);
  assert.equal(h.sends.filter((s) => s.data.startsWith('42')).length, 0);
});

test('managed late no-pending state cannot erase a newer locally queued send ledger', async () => {
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const delayedState = deferred(),
    delayedDecision = deferred(),
    delayedSent = deferred();
  let identity;
  const reply = (ordinal, pending, sequence = 2) => ({
    managed: true,
    gameId: 'match',
    ownerEpoch: 1,
    documentId: identity.documentId,
    receiptOrdinal: ordinal,
    sequence,
    nodeSequence: sequence,
    activity: 0,
    sendPending: pending,
  });
  const decision = { ...command(2), ownerEpoch: 1 };
  const pending = {
    decisionId: 'd1',
    sendTicket: 'fixture-ticket-1',
    ownerEpoch: 1,
    sequence: 2,
    queuedCount: 0,
    confirmed: false,
  };
  const h = harness({
    managed: true,
    respond: (route, data) => {
      if (route === '/attach') {
        identity = data;
        return reply(1, null, 1);
      }
      if (route === '/decision') return delayedDecision.promise;
      if (route === '/state') return delayedState.promise;
      if (route === '/send-intent')
        return {
          ...reply(4, pending),
          decision: { ...decision, sendAuthorized: true, sendTicket: pending.sendTicket },
        };
      if (route === '/sent') return delayedSent.promise;
      throw Error('Unexpected managed fixture route ' + route);
    },
  });
  const ws = new h.win.WebSocket(wsUrl);
  ws.emit('0' + JSON.stringify({ sid: 'native-session-A' }));
  ws.emit('42' + JSON.stringify(['gamestate', state]));
  await tick();
  const running = h.run();
  await tick();
  assert.equal(h.calls.at(-1).route, '/decision');
  ws.emit('42' + JSON.stringify(['gamestate', { fixture: ['old', 'new'] }]));
  await tick();
  assert.equal(h.calls.at(-1).route, '/state');
  const oldReply = reply(2, null);
  delayedDecision.resolve({ ...reply(3, null), decision });
  await tick();
  assert.equal(h.calls.at(-1).route, '/sent');
  const before = JSON.parse([...h.storage.values()][0]);
  assert.equal(before.deliveryLedger.stage, 'queued');
  assert.equal(before.deliveryLedger.queuedCount, 1);
  delayedState.resolve(oldReply);
  await tick();
  assert.deepEqual(JSON.parse([...h.storage.values()][0]).deliveryLedger, before.deliveryLedger);
  assert.equal(h.sends.filter((row) => row.data.startsWith('42')).length, 1);
  delayedSent.resolve(reply(5, null));
  await running;
  assert.equal(JSON.parse([...h.storage.values()][0]).deliveryLedger, null);
});
