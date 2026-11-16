import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { webcrypto } from 'node:crypto';
import { userscriptBootstrap } from "../../tools/keyteki-browser-bootstrap.mjs";

const flush = async () => {
  for (let n = 0; n < 6; n++) await new Promise((resolve) => setImmediate(resolve));
};
function clock() {
  let now = 0,
    next = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++next;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter(([, row]) => row.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
    pending: () => timers.size,
  };
}
function shim(binding) {
  const time = clock(),
    context = { ...time, __kfGMRequest: binding };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(userscriptBootstrap({}, ''), context);
  return { request: context.GM_xmlhttpRequest, time };
}

test('production bridge shim delivers one response and cancels its deadline', async () => {
  const calls = [];
  const { request, time } = shim(async (data) => {
    assert.equal(data.timeout, 15000);
    assert.equal('onload' in data, false);
    return { status: 200, responseText: '{}' };
  });
  request({
    timeout: 15000,
    onload: (value) => calls.push(value.status),
    ontimeout: () => calls.push('timeout'),
  });
  await flush();
  assert.deepEqual(calls, [200]);
  assert.equal(time.pending(), 0);
  time.advance(15000);
  assert.deepEqual(calls, [200]);
});

for (const late of ['resolve', 'reject'])
  test(`production bridge deadline suppresses late ${late} before any callback mutation`, async () => {
    let resolve, reject;
    const calls = [],
      ledger = { present: true };
    const { request, time } = shim(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    request({
      timeout: 15000,
      onload: () => {
        ledger.present = false;
        calls.push('load');
      },
      onerror: () => calls.push('error'),
      ontimeout: () => calls.push('timeout'),
    });
    time.advance(14999);
    assert.deepEqual(calls, []);
    time.advance(1);
    assert.deepEqual(calls, ['timeout']);
    if (late === 'resolve') resolve({ status: 200, responseText: '{}' });
    else reject(Error('late exposed-binding failure'));
    await flush();
    time.advance(15000);
    assert.deepEqual(calls, ['timeout']);
    assert.equal(ledger.present, true);
    assert.equal(time.pending(), 0);
  });

test('production bridge shim routes synchronous binding errors through onerror once', async () => {
  const calls = [];
  const { request, time } = shim(() => {
    throw Error('binding unavailable');
  });
  assert.doesNotThrow(() =>
    request({ timeout: 15000, onerror: () => calls.push('error'), ontimeout: () => calls.push('timeout') }),
  );
  await flush();
  time.advance(15000);
  assert.deepEqual(calls, ['error']);
  assert.equal(time.pending(), 0);
});

async function queuedOrdinaryHarness() {
  const time = clock(),
    routes = [],
    writes = [],
    warnings = [],
    storage = new Map();
  let release;
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
      writes.push(data);
    }
    emit(data) {
      for (const fn of this.events.get('message') ?? []) fn({ data });
    }
  }
  const settings = {
    url: 'http://127.0.0.1:32123',
    token: 'fixture-token',
    playerName: 'Self',
    managedSessions: true,
    humanWatchdog: { enabled: true, gameId: 'queue-fixture', participants: ['Self', 'Visitor'] },
  };
  const context = {
    ...time,
    WebSocket: NativeSocket,
    URL,
    crypto: webcrypto,
    location: { origin: 'http://fixture.test', href: 'http://fixture.test/play' },
    console: { warn: (...args) => warnings.push(args), info() {} },
    setInterval() {},
    addEventListener() {},
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    __kfWatchdogFrame: async (frame) => ({ accepted: true, receipt: frame }),
    __kfGMRequest: async (request) => {
      const route = new URL(request.url).pathname,
        data = JSON.parse(request.data);
      routes.push({ route, sequence: data.sequence });
      const reply = {
        status: 200,
        responseText: JSON.stringify({
          gameId: data.gameId,
          documentId: data.documentId,
          ownerEpoch: 1,
          receiptOrdinal: data.sequence,
          sendPending: null,
        }),
      };
      if (data.sequence === 2)
        return new Promise((resolve) => {
          release = () => resolve(reply);
        });
      return reply;
    },
  };
  context.window = context;
  context.top = context;
  vm.createContext(context);
  vm.runInContext(
    userscriptBootstrap(
      settings,
      fs.readFileSync(new URL("../../tools/keyteki-shared-strategy.user.js", import.meta.url), 'utf8'),
    ),
    context,
  );
  const ws = new context.WebSocket('ws://fixture.test:9500/node/socket.io/?transport=websocket');
  ws.emit('0{"sid":"fixture-engine"}');
  const full = { id: 'queue-fixture', players: { Self: {}, Visitor: {} }, started: true };
  ws.emit('42' + JSON.stringify(['gamestate', full]));
  await flush();
  ws.emit('42' + JSON.stringify(['gamestate', { turn: [1, 2] }]));
  await flush();
  return {
    time,
    ws,
    routes,
    writes,
    warnings,
    guardian: context.__kfHumanFaultGuardian,
    release: () => release(),
  };
}

test('actual userscript exits a hung ordinary queue while native observation continues without replay', async () => {
  const { time, ws, routes, writes, warnings, guardian, release } = await queuedOrdinaryHarness();
  ws.emit('42' + JSON.stringify(['gamestate', { turn: [2, 3] }]));
  await flush();
  assert.equal(guardian.snapshot().nativeSequence, 3);
  assert.equal(guardian.snapshot().strategyPaused, false);
  assert.deepEqual(routes, [
    { route: '/attach', sequence: 1 },
    { route: '/state', sequence: 2 },
  ]);
  time.advance(15000);
  await flush();
  assert.equal(guardian.snapshot().strategyPaused, true, 'declared deadline must settle the queued post');
  assert.equal(warnings.length, 1);
  release();
  await flush();
  ws.emit('42' + JSON.stringify(['gamestate', { turn: [3, 4] }]));
  await flush();
  assert.equal(guardian.snapshot().nativeSequence, 4);
  assert.equal(guardian.snapshot().strategyPaused, true);
  assert.equal(guardian.snapshot().observationAck, 4);
  assert.deepEqual(routes, [
    { route: '/attach', sequence: 1 },
    { route: '/state', sequence: 2 },
  ]);
  assert.deepEqual(writes, []);
});

test('an already submitted state stays accepted in diagnostics when quarantine occurs before its successful reply', async () => {
  const { guardian, release, routes, writes, warnings } = await queuedOrdinaryHarness();
  assert.equal(guardian.snapshot().ordinaryIngress.lastResult, 'pending');
  assert.equal(guardian.quarantine(guardian.snapshot()), true);
  release();
  await flush();
  const snap = guardian.snapshot();
  assert.equal(snap.strategyPaused, true);
  assert.equal(snap.ordinaryIngress.startedSequence, 2);
  assert.equal(snap.ordinaryIngress.settledSequence, 2);
  assert.equal(snap.ordinaryIngress.lastResult, 'accepted');
  assert.equal(snap.ordinaryIngress.skippedQueued, 0);
  assert.deepEqual(routes, [
    { route: '/attach', sequence: 1 },
    { route: '/state', sequence: 2 },
  ]);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, []);
});
