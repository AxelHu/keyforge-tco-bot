import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  recordHostOperatorIntent,
  hostStopWasRequested,
  hostOperatorIntentFingerprint,
} from "../../tools/keyteki-host-operator-intent.mjs";
import { acceptAutomaticUnjoinedStop } from "../../tools/keyteki-unjoined-host-stop.mjs";
import { installHumanWatchdog, createHumanHoldController } from "../../tools/keyteki-human-watchdog-browser.mjs";
import { createOneSeatBridgeBinding } from "../../tools/keyteki-human-bridge-callback.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = 'http://fixture.test',
  gameId = 'runtime-game',
  names = ['Self', 'Visitor'];
const raw = () => ({
  id: gameId,
  started: true,
  manualMode: false,
  messages: [],
  players: Object.fromEntries(
    names.map((name, i) => [
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

async function runtimeHarness(
  t,
  {
    enabled = true,
    observationEnabled = enabled,
    profile,
    quarantine,
    reconcileDelivery,
    clearHold,
    hostRequest,
    maxRecoveries = 1,
    pageOrigin = origin,
    transportPath = pageOrigin + '/node/socket.io',
    initialNative = true,
  } = {},
) {
  const connection = { url: 'http://127.0.0.1:32123', token: 'a'.repeat(64), runId: 'a'.repeat(32) };
  const snap = {
    enabled: observationEnabled,
    gameId,
    playerName: 'Self',
    documentId: 'doc-1',
    ownerEpoch: 1,
    nativeSequence: 1,
    frameToken: 'frame-1',
    transportPath,
    connected: true,
    invalid: false,
    operatorPaused: false,
    unknownSend: false,
  };
  const callbacks = {},
    events = [],
    state = {},
    calls = { reload: 0, quarantine: 0, restart: 0, host: 0, act: 0, receipt: 0 },
    context = {};
  const frame = { url: () => pageOrigin + '/play' };
  context.window = {
    __kfHumanFaultGuardian: observationEnabled
      ? {
          snapshot: () => structuredClone(snap),
          quarantine: (ticket) => {
            calls.quarantine++;
            return quarantine ? quarantine({ ticket, snap, calls }) : true;
          },
          reconcileDelivery: async (ticket, expiresAt) => {
            calls.receipt++;
            return reconcileDelivery
              ? reconcileDelivery({ ticket, expiresAt, snap, calls, connection })
              : { ok: false };
          },
          act: () => {
            calls.act++;
            return { queued: true, attempted: true };
          },
        }
      : undefined,
  };
  vm.createContext(context);
  const page = {
    mainFrame: () => frame,
    url: frame.url,
    evaluate: async (fn, arg) => {
      context.__arg = arg;
      return vm.runInContext('(' + fn.toString() + ')(__arg)', context);
    },
    exposeBinding: async (name, fn) => {
      callbacks[name] = fn;
    },
    reload: async () => {
      calls.reload++;
    },
  };
  const config = {
    origin: pageOrigin,
    profile,
    room: { gameId },
    self: { name: 'Self' },
    participants: names,
    watchdog: {
      enabled,
      stallMs: 10,
      recoveryGraceMs: 10,
      modelGraceMs: 20,
      pollMs: 600000,
      apologyEchoMs: 10,
      terminalAckMs: 10,
      maxRecoveries,
    },
  };
  const runtime = await installHumanWatchdog({
    page,
    config,
    observationEnabled,
    connection,
    state,
    observer: {},
    save: () => {},
    onEvent: (e) => events.push(e),
    validateFull: () => {},
    hostRequest: async () => {
      calls.host++;
      return hostRequest
        ? hostRequest({ snap, calls })
        : {
            paused: false,
            sessions: [
              {
                gameId,
                playerName: 'Self',
                documentId: snap.documentId,
                ownerEpoch: 1,
                status: 'ready',
                sendPending: null,
              },
            ],
          };
    },
    restartHost: async () => {
      calls.restart++;
    },
    clearAutomaticHold: async () => {
      await clearHold?.({ snap, calls, connection });
      state.held = false;
    },
  });
  t.after(() => runtime.close());
  const nativeFrame = (doc = 'doc-1', sequence = 1, delta = raw()) => ({
    gameId,
    playerName: 'Self',
    documentId: doc,
    ownerEpoch: 1,
    nativeSequence: sequence,
    frameToken: 'frame-' + sequence,
    transportPath: snap.transportPath,
    newEngineHandshake: true,
    delta,
  });
  const receive = (f) => callbacks.__kfWatchdogFrame({ page, frame }, f);
  if (observationEnabled && initialNative) await receive(nativeFrame());
  return {
    runtime,
    page,
    frame,
    config,
    connection,
    snap,
    calls,
    events,
    state,
    receive,
    nativeFrame,
    context,
  };
}

const fuzhouTransport = {
  pageOrigin: 'http://fixture.test',
  transportPath: 'http://fixture.test:9500/node1/socket.io',
};

test('the observed secondary game origin binds through the current native guardian and still recovers', async (t) => {
  const h = await runtimeHarness(t, fuzhouTransport);
  assert.equal(h.runtime.watchdog.status().receipt.transportPath, fuzhouTransport.transportPath);
  assert.notEqual(h.runtime.watchdog.status().phase, 'disarmed');
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.quarantine, 1);
  assert.equal(h.calls.reload, 1);
});

test('only the exact current game endpoint is accepted, even when a different endpoint shares the page origin', async (t) => {
  for (const transportPath of [
    fuzhouTransport.pageOrigin + '/node1/socket.io',
    'http://fixture.test:9501/node1/socket.io',
    'http://fixture.test:9500/node2/socket.io',
    'http://other.test:9500/node1/socket.io',
  ]) {
    const h = await runtimeHarness(t, fuzhouTransport);
    const result = await h.receive({ ...h.nativeFrame('doc-1', 2), transportPath });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'native-observation-invalid');
    assert.equal(h.runtime.watchdog.status().phase, 'disarmed');
    assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 1);
    assert.equal(h.calls.act + h.calls.reload, 0);
  }
});

test('secondary game origin does not authorize a different source page origin', async (t) => {
  const h = await runtimeHarness(t, fuzhouTransport);
  h.frame.url = () => 'http://fixture.test:9500/play';
  assert.equal((await h.receive(h.nativeFrame('doc-1', 2))).accepted, false);
  assert.equal(h.runtime.watchdog.status().phase, 'disarmed');
  assert.ok(h.events.some((event) => event.reason === 'native-source-scope-invalid'));
  assert.equal(h.calls.act + h.calls.reload, 0);
});

test('current guardian identity and invalidation remain required for a secondary origin', async (t) => {
  for (const change of [
    { gameId: 'other-game' },
    { playerName: 'Visitor' },
    { enabled: false },
    { invalid: true },
    { transportPath: null },
  ]) {
    const h = await runtimeHarness(t, fuzhouTransport);
    const frame = h.nativeFrame('doc-1', 2);
    Object.assign(h.snap, change);
    assert.equal((await h.receive(frame)).accepted, false);
    assert.equal(h.runtime.watchdog.status().phase, 'disarmed');
  }
});

test('secondary origin cannot bypass clean endpoint syntax even if the guardian matches it', async (t) => {
  for (const transportPath of [
    'ftp://fixture.test:9500/node1/socket.io',
    'http://name:password@fixture.test:9500/node1/socket.io',
    fuzhouTransport.transportPath + '?sid=fixture',
    fuzhouTransport.transportPath + '#fragment',
    fuzhouTransport.transportPath + '/',
    'http://fixture.test:9500/socket.io',
  ]) {
    const h = await runtimeHarness(t, { ...fuzhouTransport, transportPath });
    assert.equal(h.runtime.watchdog.status().receipt, null);
    assert.equal(h.runtime.watchdog.status().phase, 'disarmed');
  }
});

test('retired secondary-origin callbacks cannot poison the replacement document binding', async (t) => {
  const h = await runtimeHarness(t, fuzhouTransport);
  const retired = h.nativeFrame('doc-1', 2);
  h.snap.documentId = 'doc-2';
  h.snap.transportPath = 'http://fixture.test:9500/node2/socket.io';
  assert.equal((await h.receive(retired)).reason, 'retired-document');
  assert.equal((await h.receive(h.nativeFrame('doc-2'))).accepted, true);
  assert.equal(h.runtime.watchdog.status().receipt.documentId, 'doc-2');
  assert.equal(h.runtime.watchdog.status().receipt.transportPath, h.snap.transportPath);
  assert.equal((await h.receive(retired)).ignored, true);
  assert.notEqual(h.runtime.watchdog.status().phase, 'disarmed');
});

test('secondary transport binding preserves owner and exact native-frame action fences', async (t) => {
  for (const change of [{ ownerEpoch: 2 }, { nativeSequence: 2 }, { frameToken: 'newer-frame' }]) {
    const h = await runtimeHarness(t, { ...fuzhouTransport, maxRecoveries: 0 });
    Object.assign(h.snap, change);
    await pause(15);
    await h.runtime.tick();
    assert.equal(h.calls.act, 0);
    assert.equal(h.calls.quarantine + h.calls.reload + h.calls.restart, 0);
  }
});

test('queued native frames remain observable when the guardian has already advanced', async (t) => {
  const h = await runtimeHarness(t, fuzhouTransport);
  h.snap.nativeSequence = 3;
  h.snap.frameToken = 'frame-3';
  assert.equal(
    (await h.receive(h.nativeFrame('doc-1', 2, { players: { Self: { stats: { amber: [0, 1] } } } })))
      .accepted,
    true,
  );
  assert.equal(
    (await h.receive(h.nativeFrame('doc-1', 3, { players: { Self: { stats: { amber: [1, 2] } } } })))
      .accepted,
    true,
  );
  assert.equal(h.runtime.native.snapshot().players.Self.stats.amber, 2);
  assert.equal(h.runtime.watchdog.status().receipt.frameToken, 'frame-3');
  assert.notEqual(h.runtime.watchdog.status().phase, 'disarmed');
});

test('native secondary-origin terminal delta updates launcher handoff after strategy quarantine', async (t) => {
  const h = await runtimeHarness(t, fuzhouTransport);
  h.state.held = true;
  h.state.phase = 'held-for-inspection';
  h.snap.strategyPaused = true;
  assert.equal(await h.runtime.quarantine(), true);
  h.snap.nativeSequence = 2;
  h.snap.frameToken = 'frame-2';
  assert.equal((await h.receive(h.nativeFrame('doc-1', 2, { winner: ['Visitor'] }))).accepted, true);
  assert.equal(h.state.finished, true);
  assert.equal(h.state.phase, 'finished-preserved');
  assert.equal(h.state.finalPublicView.winner, 'Visitor');
  assert.equal(h.state.watchdogPublicView.winner, 'Visitor');
  assert.equal(h.calls.act + h.calls.reload, 0);
});

test('explicit stop is atomic, secret-free and scoped to this profile and run; later start releases it', (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-stop-intent-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const old = { runId: 'a'.repeat(32), token: 'never-persist-this-token' },
    next = { runId: 'b'.repeat(32) };
  assert.equal(hostStopWasRequested(profile, old), false);
  recordHostOperatorIntent(profile, old, 'stop');
  assert.equal(hostStopWasRequested(profile, old), true);
  assert.equal(hostStopWasRequested(profile, next), false);
  const file = path.join(profile, 'operator-intent.json'),
    contents = fs.readFileSync(file, 'utf8');
  assert.equal(contents.includes(old.token), false);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  recordHostOperatorIntent(profile, next, 'start');
  assert.equal(hostStopWasRequested(profile, next), false);
  recordHostOperatorIntent(profile, old, 'start');
  assert.equal(hostStopWasRequested(profile, old), false);
});

test('watchdog honors stopped current run without restarting or touching the native game', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-stop-guard-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const h = await runtimeHarness(t, { profile });
  recordHostOperatorIntent(profile, h.connection, 'stop');
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.host, 0);
});

test('an empty host internal stop does not become a sticky operator pause before any native receipt', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-internal-stop-health-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const runId = 'a'.repeat(32),
    configSha256 = 'b'.repeat(64);
  recordHostOperatorIntent(profile, { runId }, 'start');
  const automaticRetirement = acceptAutomaticUnjoinedStop({
    profile,
    runId,
    configSha256,
    status: { sessions: [], restoredSessions: [], paused: false, stopping: false },
    request: {
      expectedRunId: runId,
      configSha256,
      retirementId: 'c'.repeat(32),
      operatorIntentFingerprint: hostOperatorIntentFingerprint(profile),
    },
  });
  const h = await runtimeHarness(t, {
    profile,
    initialNative: false,
    hostRequest: async () => ({
      runId,
      configSha256,
      automaticRetirement,
      sessions: [],
      restoredSessions: [],
      paused: false,
      stopping: true,
    }),
  });
  await h.runtime.tick();
  assert.equal(h.calls.host, 1);
  assert.equal(h.runtime.watchdog.status().receipt, null);
  assert.notEqual(h.runtime.watchdog.status().phase, 'operator-paused');
  assert.notEqual(h.state.operatorPaused, true);
  assert.equal(h.calls.act + h.calls.reload + h.calls.restart, 0);
});

test('a real pause or stop arriving during internal-stop health remains sticky without a native receipt', async (t) => {
  for (const action of ['pause', 'stop']) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-manual-stop-health-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const runId = 'a'.repeat(32),
      configSha256 = 'b'.repeat(64);
    recordHostOperatorIntent(profile, { runId }, 'start');
    const automaticRetirement = acceptAutomaticUnjoinedStop({
      profile,
      runId,
      configSha256,
      status: { sessions: [], restoredSessions: [], paused: false, stopping: false },
      request: {
        expectedRunId: runId,
        configSha256,
        retirementId: 'c'.repeat(32),
        operatorIntentFingerprint: hostOperatorIntentFingerprint(profile),
      },
    });
    let entered, release;
    const pending = new Promise((resolve) => {
      entered = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const h = await runtimeHarness(t, {
      profile,
      initialNative: false,
      hostRequest: async () => {
        entered();
        await resume;
        return { runId, configSha256, automaticRetirement, sessions: [], paused: false, stopping: true };
      },
    });
    const tick = h.runtime.tick();
    await pending;
    recordHostOperatorIntent(profile, { runId }, action);
    release();
    await tick;
    assert.equal(h.state.operatorPaused, true);
    assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
    assert.equal(h.calls.act + h.calls.reload + h.calls.restart, 0);
  }
});

test('a false quarantine is bounded and cannot reload an active automatic lane', async (t) => {
  const h = await runtimeHarness(t, { quarantine: () => false });
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.quarantine, 3);
  assert.equal(h.calls.reload, 0);
  assert.ok(h.events.some((e) => e.reason === 'quarantine-binding-changed'));
});

test('unknown send appearing after quarantine is re-read before reload', async (t) => {
  const h = await runtimeHarness(t, {
    quarantine: ({ snap }) => {
      snap.unknownSend = true;
      return true;
    },
  });
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.restart, 0);
  assert.ok(h.events.some((e) => e.reason === 'uncertain-send-preserved'));
});

test('host pending intent appearing after quarantine also blocks reload', async (t) => {
  const h = await runtimeHarness(t, {
    hostRequest: ({ snap, calls }) => ({
      paused: false,
      sessions: [
        {
          gameId,
          playerName: 'Self',
          documentId: snap.documentId,
          ownerEpoch: 1,
          status: 'ready',
          sendPending: calls.quarantine ? { sendTicket: 'pending' } : null,
        },
      ],
    }),
  });
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.reload, 0);
  assert.ok(h.events.some((e) => e.reason === 'uncertain-send-preserved'));
});

test('closed socket still permits same-document recovery; no live-send precondition is imposed on reload', async (t) => {
  const h = await runtimeHarness(t);
  h.snap.connected = false;
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.quarantine, 1);
  assert.equal(h.calls.reload, 1);
});

test('snapshot failure from retiring document does not disarm new native full', async (t) => {
  const h = await runtimeHarness(t);
  let reject;
  const evaluate = h.page.evaluate;
  h.page.evaluate = () =>
    new Promise((_, r) => {
      reject = r;
    });
  const pending = h.receive(h.nativeFrame('doc-1', 2, { messages: [[], []] }));
  await new Promise((r) => setImmediate(r));
  h.snap.documentId = 'doc-2';
  h.snap.nativeSequence = 1;
  h.page.evaluate = evaluate;
  reject(Error('Execution context was destroyed'));
  assert.equal((await pending).ignored, true);
  await h.receive(h.nativeFrame('doc-2'));
  assert.notEqual(h.runtime.watchdog.status().phase, 'disarmed');
  assert.equal(h.runtime.watchdog.status().receipt.documentId, 'doc-2');
});

test('disabled watchdog has no guardian but leaves actual managed bridge decisions operational', async (t) => {
  const h = await runtimeHarness(t, { enabled: false });
  assert.equal(await h.runtime.snapshot(), null);
  assert.equal(await h.runtime.isCurrentDocument('any-managed-document'), true);
  let requests = 0;
  const holds = [];
  const callback = createOneSeatBridgeBinding({
    page: h.page,
    config: h.config,
    connection: h.connection,
    observer: {},
    state: {},
    mirror: {},
    save: () => {},
    hold: async (x) => holds.push(x),
    watchdog: h.runtime,
    fetchImpl: async () => {
      requests++;
      return new Response('{"status":"waiting-for-opponent"}');
    },
  });
  const answer = await callback(
    { page: h.page, frame: h.frame },
    {
      url: h.connection.url + '/decision',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + h.connection.token },
      data: JSON.stringify({ origin, playerName: 'Self', gameId, documentId: 'normal-doc' }),
    },
  );
  assert.equal(answer.status, 200);
  assert.equal(requests, 1);
  assert.deepEqual(holds, []);
});

test('temporary document-read failure is 503 rather than a false superseded-owner fence', async (t) => {
  const h = await runtimeHarness(t);
  const holds = [],
    invalid = [];
  let requests = 0;
  const callback = createOneSeatBridgeBinding({
    page: h.page,
    config: h.config,
    connection: h.connection,
    observer: {},
    state: {},
    mirror: {},
    save: () => {},
    hold: async (x) => holds.push(x),
    watchdog: { isCurrentDocument: async () => null, invalidate: (x) => invalid.push(x) },
    fetchImpl: async () => {
      requests++;
      return new Response('{}');
    },
  });
  const answer = await callback(
    { page: h.page, frame: h.frame },
    {
      url: h.connection.url + '/decision',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + h.connection.token },
      data: JSON.stringify({ origin, playerName: 'Self', gameId, documentId: 'doc-1' }),
    },
  );
  assert.equal(answer.status, 503);
  assert.equal(JSON.parse(answer.responseText).code, 'current-document-unavailable');
  assert.equal(requests, 0);
  assert.deepEqual(holds, []);
  assert.deepEqual(invalid, []);
});

test('a stop written during a failing status request is rechecked before automatic restart', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-stop-during-status-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const h = await runtimeHarness(t, {
    profile,
    hostRequest: () => {
      recordHostOperatorIntent(profile, { runId: 'a'.repeat(32) }, 'stop');
      throw Error('Host stopped during request');
    },
  });
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
  assert.equal(h.calls.restart, 0);
  assert.equal(h.calls.reload, 0);
});

test('shared launcher hold barrier is cleared only after fault work and never clears operator pause', async () => {
  let release;
  const state = {},
    controller = createHumanHoldController({
      state,
      hostRequest: async () => {},
      save: () => {},
      getWatchdog: () => ({
        quarantine: () =>
          new Promise((r) => {
            release = r;
          }),
        fault() {},
        operatorPause() {},
      }),
    });
  const held = controller.hold('TEST_FAULT');
  let cleared = false;
  const clear = controller.clearAutomaticHold().then(() => {
    cleared = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(cleared, false);
  release();
  await held;
  await clear;
  assert.equal(state.held, false);
  const operator = controller.hold('OPERATOR_STOP', { operator: true });
  await new Promise((r) => setImmediate(r));
  release();
  await operator;
  await assert.rejects(controller.clearAutomaticHold(), /Operator pause/);
  assert.equal(state.operatorPaused, true);
});

test('actual host CLI records stop before request; automatic start cannot erase an intervening stop', async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-host-cli-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const runId = 'c'.repeat(32),
    config = { origins: [], players: [] },
    configFile = path.join(profile, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const configSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  let stoppingOnStatus = true,
    stopWasRecordedBeforeRequest = false;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') {
      if (stoppingOnStatus) recordHostOperatorIntent(profile, { runId }, 'stop');
      setTimeout(() => res.end(JSON.stringify({ runId, configSha256, pid: process.pid, paused: false })), 15);
    } else {
      stopWasRecordedBeforeRequest = hostStopWasRequested(profile, { runId });
      res.end(JSON.stringify({ runId, stopping: true, pid: 99999999 }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  fs.writeFileSync(
    path.join(profile, 'connection.json'),
    JSON.stringify({
      url: 'http://127.0.0.1:' + server.address().port,
      token: 'd'.repeat(64),
      runId,
      managedSessions: true,
    }),
  );
  const cli = new URL("../../tools/keyteki-session-host.mjs", import.meta.url).pathname,
    execute = promisify(execFile);
  await assert.rejects(
    execute(
      process.execPath,
      [cli, 'start', '--profile', profile, '--config', configFile, '--recover-from-run-id', runId],
      { timeout: 10000 },
    ),
    /operator-stop-requested/,
  );
  assert.equal(hostStopWasRequested(profile, { runId }), true);
  stoppingOnStatus = false;
  await execute(process.execPath, [cli, 'start', '--profile', profile, '--config', configFile], {
    timeout: 10000,
  });
  assert.equal(hostStopWasRequested(profile, { runId }), false);
  await execute(process.execPath, [cli, 'stop', '--profile', profile], { timeout: 10000 });
  assert.equal(stopWasRecordedBeforeRequest, true);
});

test('successful stale status cannot authorize apology or concession after an intervening operator stop', async (t) => {
  for (const stage of ['apology', 'concede']) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-stop-before-' + stage + '-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    let stopOnRequest = stage === 'apology' ? 2 : Infinity;
    const actions = [];
    const h = await runtimeHarness(t, {
      profile,
      maxRecoveries: 0,
      hostRequest: async ({ snap, calls }) => {
        const stale = {
          paused: false,
          sessions: [
            {
              gameId,
              playerName: 'Self',
              documentId: snap.documentId,
              ownerEpoch: 1,
              status: 'ready',
              sendPending: null,
            },
          ],
        };
        if (calls.host === stopOnRequest) {
          await pause(1);
          recordHostOperatorIntent(profile, { runId: 'a'.repeat(32) }, 'stop');
        }
        return stale;
      },
    });
    h.context.window.__kfHumanFaultGuardian.act = (kind) => {
      actions.push(kind);
      return { queued: true, attempted: true };
    };
    await pause(15);
    await h.runtime.tick();
    if (stage === 'concede') {
      assert.deepEqual(actions, ['apology']);
      stopOnRequest = h.calls.host + 2;
      await pause(15);
      await h.runtime.tick();
    }
    assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
    assert.deepEqual(actions, stage === 'apology' ? [] : ['apology']);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.restart, 0);
  }
});

test('operator stop persisted during the final snapshot prevents the actual native fault write', async (t) => {
  for (const stage of ['apology', 'concede']) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-stop-during-snapshot-'));
    t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
    const h = await runtimeHarness(t, { profile, maxRecoveries: 0 });
    const evaluate = h.page.evaluate,
      actions = [];
    let snapshots = 0,
      stopOnSnapshot = stage === 'apology' ? 2 : Infinity;
    h.page.evaluate = async (fn, arg) => {
      const value = await evaluate(fn, arg);
      if (fn.toString().includes('.snapshot') && ++snapshots === stopOnSnapshot) {
        await pause(1);
        recordHostOperatorIntent(profile, h.connection, 'stop');
      }
      return value;
    };
    h.context.window.__kfHumanFaultGuardian.act = (kind) => {
      actions.push(kind);
      return { queued: true, attempted: true };
    };
    await pause(15);
    await h.runtime.tick();
    if (stage === 'concede') {
      assert.deepEqual(actions, ['apology']);
      stopOnSnapshot = snapshots + 2;
      await pause(15);
      await h.runtime.tick();
    }
    assert.equal(h.runtime.watchdog.status().phase, 'operator-paused');
    assert.deepEqual(actions, stage === 'apology' ? [] : ['apology']);
    assert.equal(h.calls.reload, 0);
    assert.equal(h.calls.restart, 0);
  }
});

test('observation-only mode retains terminal frame replay and document fences without any fault action', async (t) => {
  const h = await runtimeHarness(t, { enabled: false, observationEnabled: true, ...fuzhouTransport });
  assert.equal(h.runtime.watchdog.status().enabled, false);
  assert.equal(await h.runtime.isCurrentDocument('doc-1'), true);
  assert.equal(await h.runtime.isCurrentDocument('retired-doc'), false);
  await pause(15);
  await h.runtime.tick();
  assert.equal(h.calls.reload + h.calls.restart + h.calls.quarantine + h.calls.act, 0);
  h.snap.nativeSequence = 2;
  h.snap.frameToken = 'frame-2';
  h.snap.observationPending = 1;
  const acknowledgements = [];
  h.context.window.__kfHumanFaultGuardian.observations = () => ({
    snapshot: { ...h.snap },
    frames: [h.nativeFrame('doc-1', 2, { winner: ['Visitor'] })],
  });
  h.context.window.__kfHumanFaultGuardian.acknowledgeObservation = (receipt) => {
    acknowledgements.push(receipt.nativeSequence);
    return true;
  };
  await h.runtime.tick();
  assert.equal(h.state.finished, true);
  assert.equal(h.state.finalPublicView.winner, 'Visitor');
  assert.equal(h.runtime.watchdog.status().receipt.nativeSequence, 2);
  assert.deepEqual(acknowledgements, [2]);
  assert.equal(h.calls.reload + h.calls.restart + h.calls.quarantine + h.calls.act, 0);
  let requests = 0;
  const callback = createOneSeatBridgeBinding({
    page: h.page,
    config: h.config,
    connection: h.connection,
    observer: {},
    state: {},
    mirror: {},
    save: () => {},
    hold: async () => {},
    watchdog: h.runtime,
    fetchImpl: async () => {
      requests++;
      return new Response('{"status":"finished"}');
    },
  });
  const call = (documentId) =>
    callback(
      { page: h.page, frame: h.frame },
      {
        url: h.connection.url + '/decision',
        method: 'POST',
        headers: { Authorization: 'Bearer ' + h.connection.token },
        data: JSON.stringify({ origin: h.config.origin, playerName: 'Self', gameId, documentId }),
      },
    );
  assert.equal((await call('retired-doc')).status, 409);
  assert.equal(requests, 0);
  assert.equal((await call('doc-1')).status, 200);
  assert.equal(requests, 1);
});

async function receiptRecoveryHarness(
  t,
  { afterProofHealth, afterHoldHealth, duringProof, proofAccepted = true } = {},
) {
  let afterProofReads = 0,
    holdCleared = false;
  const h = await runtimeHarness(t, {
    quarantine: ({ snap }) => {
      snap.strategyPaused = true;
      return true;
    },
    reconcileDelivery: ({ ticket, expiresAt, snap, calls, connection }) => {
      assert.ok(Number.isSafeInteger(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 5000);
      if (!proofAccepted) return { ok: false, reason: 'receipt-proof-unavailable' };
      snap.unknownSend = false;
      duringProof?.({ snap, calls, connection });
      return {
        ok: true,
        reason: 'observed-delivery-proven',
        documentId: ticket.documentId,
        ownerEpoch: ticket.ownerEpoch,
      };
    },
    clearHold: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      holdCleared = true;
    },
    hostRequest: ({ snap, calls }) => {
      const pending = calls.quarantine ? null : { sendTicket: 'captured-earlier-pending' };
      const result = {
        runId: 'a'.repeat(32),
        paused: false,
        stopping: false,
        restoredSessions: [],
        sessions: [
          {
            gameId,
            playerName: 'Self',
            documentId: snap.documentId,
            ownerEpoch: 1,
            status: 'ready',
            lifecycle: 'attached',
            sendPending: pending,
            pendingDeliveries: pending ? [pending] : [],
          },
        ],
      };
      if (calls.receipt) afterProofHealth?.(result, ++afterProofReads);
      if (holdCleared) afterHoldHealth?.(result);
      return result;
    },
  });
  h.snap.unknownSend = true;
  await pause(15);
  await h.runtime.tick();
  return h;
}

test('only an exact observed proof replaces captured unknown and reloads the quarantined same owner once', async (t) => {
  const h = await receiptRecoveryHarness(t);
  assert.equal(h.calls.receipt, 1);
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.restart + h.calls.act, 0);
  assert.equal(h.snap.strategyPaused, true);
  assert.ok(
    h.events.some(
      (row) => row.type === 'recovery-send-check' && row.cachedUnknown && row.observedReceiptProven,
    ),
  );
});

test('missing observed proof preserves captured and browser unknown without restarting or reloading', async (t) => {
  const h = await receiptRecoveryHarness(t, { proofAccepted: false });
  assert.equal(h.calls.receipt, 1);
  assert.equal(h.snap.unknownSend, true);
  assert.equal(h.calls.reload + h.calls.restart + h.calls.act, 0);
  assert.ok(h.events.some((row) => row.reason === 'uncertain-send-preserved'));
});

for (const [name, afterProofHealth] of [
  [
    'missing owner',
    (host) => {
      host.sessions = [];
    },
  ],
  [
    'duplicate owner',
    (host) => {
      host.sessions.push({ ...host.sessions[0] });
    },
  ],
  [
    'owner epoch changed',
    (host) => {
      host.sessions[0].ownerEpoch++;
    },
  ],
  [
    'another pending delivery',
    (host) => {
      host.sessions[0].sendPending = { sendTicket: 'new-pending' };
    },
  ],
  [
    'host instance changed',
    (host) => {
      host.runId = 'b'.repeat(32);
    },
  ],
  [
    'host instance omitted',
    (host) => {
      delete host.runId;
    },
  ],
  [
    'restored unknown',
    (host) => {
      host.restoredSessions = [{ gameId, playerName: 'Self' }];
    },
  ],
  [
    'host paused',
    (host) => {
      host.paused = true;
    },
  ],
  [
    'host unavailable',
    () => {
      throw Error('fixture host unavailable after proof');
    },
  ],
  [
    'pending appears at final inspect',
    (host, read) => {
      if (read >= 2) host.sessions[0].sendPending = { sendTicket: 'late-pending' };
    },
  ],
])
  test(`receipt recovery refuses ${name} in fresh health`, async (t) => {
    const h = await receiptRecoveryHarness(t, { afterProofHealth });
    assert.equal(h.calls.receipt, 1);
    assert.equal(h.calls.reload + h.calls.restart + h.calls.act, 0);
    assert.equal(h.snap.strategyPaused, true);
  });

for (const [name, duringProof] of [
  [
    'new browser unknown',
    ({ snap }) => {
      snap.unknownSend = true;
    },
  ],
  [
    'manual pause',
    ({ snap }) => {
      snap.operatorPaused = true;
    },
  ],
  [
    'replacement document',
    ({ snap }) => {
      snap.documentId = 'replacement-document';
    },
  ],
  [
    'mutated connection instance',
    ({ connection }) => {
      connection.runId = 'b'.repeat(32);
    },
  ],
])
  test(`receipt recovery refuses ${name} during the proof request`, async (t) => {
    const h = await receiptRecoveryHarness(t, { duringProof });
    assert.equal(h.calls.receipt, 1);
    assert.equal(h.calls.reload + h.calls.restart + h.calls.act, 0);
    assert.equal(h.snap.strategyPaused, true);
  });

for (const [name, afterHoldHealth] of [
  [
    'a new pending command',
    (host) => {
      host.sessions[0].sendPending = { sendTicket: 'after-hold' };
    },
  ],
  [
    'another owner',
    (host) => {
      host.sessions[0].ownerEpoch++;
    },
  ],
  [
    'host pause',
    (host) => {
      host.paused = true;
    },
  ],
])
  test(`receipt recovery re-reads ${name} after the asynchronous hold barrier`, async (t) => {
    const h = await receiptRecoveryHarness(t, { afterHoldHealth });
    assert.equal(h.calls.receipt, 1);
    assert.equal(h.calls.reload + h.calls.restart + h.calls.act, 0);
    assert.equal(h.snap.strategyPaused, true);
  });
