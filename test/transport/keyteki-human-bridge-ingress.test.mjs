import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneSeatBridgeBinding } from "../../tools/keyteki-human-bridge-callback.mjs";

const origin = 'http://fixture.test',
  connection = { url: 'http://127.0.0.1:32123', token: 'a'.repeat(64) },
  secret = 'private-payload-and-error-canary';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness({ documentCheck, response, sinkThrows = false } = {}) {
  const config = {
      origin,
      self: { name: 'Self' },
      room: { gameId: 'ingress-fixture' },
      participants: ['Self', 'Visitor'],
    },
    frame = { url: () => origin + '/play' },
    page = { mainFrame: () => frame },
    state = { held: false, fullVerified: true },
    evidence = [],
    holds = [],
    calls = { document: 0, fetch: 0, body: 0, bridge: 0, invalid: 0, save: 0 };
  const callback = createOneSeatBridgeBinding({
    page,
    config,
    connection,
    observer: { joinRequested: true },
    mirror: {},
    state,
    watchdog: {
      isCurrentDocument: async (documentId) => {
        calls.document++;
        return documentCheck ? documentCheck(documentId, calls.document) : true;
      },
      bridge: () => calls.bridge++,
      invalidate: () => calls.invalid++,
    },
    hold: async (code) => {
      holds.push(code);
      state.held = true;
    },
    save: () => calls.save++,
    onEvidence: (row) => {
      if (sinkThrows) throw Error(secret);
      evidence.push(row);
    },
    fetchImpl: async () => {
      calls.fetch++;
      if (response) return response(calls);
      return {
        status: 200,
        ok: true,
        text: async () => {
          calls.body++;
          return JSON.stringify({ status: 'ready', unloggedPrivateField: secret });
        },
      };
    },
  });
  const request = (route = '/state', edits = {}) => ({
    url: connection.url + route,
    method: 'POST',
    headers: { Authorization: 'Bearer ' + connection.token },
    data: JSON.stringify({
      origin,
      gameId: config.room.gameId,
      playerName: config.self.name,
      documentId: 'fixture-document-0001',
      sessionId: 'fixture-document-0001',
      ownerEpoch: 1,
      sequence: 234,
      delta: { unloggedPrivateField: secret },
      ...edits,
    }),
  });
  return {
    callback,
    source: { page, frame },
    request,
    state,
    evidence,
    holds,
    calls,
    ingress: () => evidence.filter((row) => row.type === 'ingress-diagnostics').map((row) => row.diagnostics),
  };
}
function assertPrivateFieldsAbsent(value) {
  const serialized = JSON.stringify(value);
  for (const hidden of [secret, connection.token, connection.url, origin])
    assert.equal(serialized.includes(hidden), false, hidden);
}

test('ordinary ingress initial document unavailability records its route without fetching', async () => {
  for (const route of ['/attach', '/state', '/transport-resume']) {
    const h = harness({ documentCheck: () => null });
    const reply = await h.callback(h.source, h.request(route));
    assert.deepEqual(reply, {
      status: 503,
      responseText: '{"code":"current-document-unavailable"}',
    });
    assert.equal(h.calls.fetch, 0);
    assert.equal(h.calls.body, 0);
    assert.equal(h.calls.bridge, 0);
    assert.equal(h.calls.invalid, 0);
    assert.deepEqual(h.holds, []);
    const rows = h.ingress();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].result, 'started');
    assert.deepEqual(rows[1], {
      schema: 'kf-one-seat-ingress-diagnostics-v1',
      requestOrdinal: 1,
      ordinarySequence: 234,
      route,
      phase: 'initial-document-fence',
      result: 'document-unavailable',
      replyStatus: 503,
    });
    assert.deepEqual(h.state.ingressDiagnostics, rows[1]);
    assertPrivateFieldsAbsent(h.evidence);
  }
});

test('ordinary ingress retains in-flight phases and distinguishes a lost post-response document fence', async () => {
  const fetched = deferred(),
    body = deferred();
  const h = harness({
    documentCheck: (_id, ordinal) => (ordinal === 1 ? true : null),
    response: () => fetched.promise,
  });
  const pending = h.callback(h.source, h.request());
  await flush();
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.state.ingressDiagnostics.phase, 'host-fetch');
  assert.equal(h.ingress().length, 1);
  fetched.resolve({
    status: 200,
    ok: true,
    text: () => {
      h.calls.body++;
      return body.promise;
    },
  });
  await flush();
  assert.equal(h.state.ingressDiagnostics.phase, 'response-body');
  assert.equal(h.state.ingressDiagnostics.hostResponseStatus, 200);
  assert.equal(h.ingress().length, 1);
  body.resolve(JSON.stringify({ status: 'ready', unloggedPrivateField: secret }));
  assert.deepEqual(await pending, {
    status: 503,
    responseText: '{"code":"current-document-unavailable"}',
  });
  assert.equal(h.calls.fetch, 1);
  assert.equal(h.calls.body, 1);
  assert.equal(h.calls.document, 2);
  assert.equal(h.calls.bridge, 0);
  assert.equal(h.calls.invalid, 0);
  assert.deepEqual(h.holds, []);
  assert.equal(
    h.evidence.some((row) => row.type === 'gameplay-diagnostics'),
    false,
  );
  assert.equal(
    h.evidence.some((row) => row.type === 'verified-public-state'),
    false,
  );
  assert.equal(h.ingress().length, 2);
  assert.deepEqual(h.ingress().at(-1), {
    schema: 'kf-one-seat-ingress-diagnostics-v1',
    requestOrdinal: 1,
    ordinarySequence: 234,
    route: '/state',
    phase: 'response-document-fence',
    result: 'document-unavailable',
    hostResponseStatus: 200,
    replyStatus: 503,
  });
  assertPrivateFieldsAbsent(h.evidence);
});

test('throwing ingress diagnostics never changes either document-fence reply or adds a hold', async () => {
  for (const afterResponse of [false, true]) {
    const h = harness({
      documentCheck: (_id, ordinal) => (afterResponse && ordinal === 1 ? true : null),
      sinkThrows: true,
    });
    assert.deepEqual(await h.callback(h.source, h.request()), {
      status: 503,
      responseText: '{"code":"current-document-unavailable"}',
    });
    assert.equal(h.calls.fetch, afterResponse ? 1 : 0);
    assert.equal(h.calls.bridge, 0);
    assert.equal(h.calls.invalid, 0);
    assert.equal(h.state.evidenceWriteFailures, 2);
    assert.deepEqual(h.holds, []);
  }
});

test('a late older ingress terminal cannot replace the newest request snapshot', async () => {
  const first = deferred();
  const h = harness({ documentCheck: (_id, ordinal) => (ordinal === 1 ? first.promise : null) });
  const older = h.callback(h.source, h.request('/state', { sequence: 234 }));
  const newer = await h.callback(h.source, h.request('/state', { sequence: 235 }));
  assert.equal(newer.status, 503);
  const newestSnapshot = structuredClone(h.state.ingressDiagnostics);
  assert.equal(newestSnapshot.requestOrdinal, 2);
  assert.equal(newestSnapshot.ordinarySequence, 235);
  first.resolve(null);
  assert.equal((await older).status, 503);
  assert.deepEqual(h.state.ingressDiagnostics, newestSnapshot);
  assert.deepEqual(
    h.ingress().map((row) => row.requestOrdinal),
    [1, 2, 2, 1],
  );
  assert.equal(h.calls.fetch, 0);
});

test('response-body exceptions keep the existing failure hold while ingress evidence stays sanitized', async () => {
  const h = harness({
    response: () => ({
      status: 200,
      ok: true,
      text: async () => {
        throw Error(secret);
      },
    }),
  });
  await assert.rejects(h.callback(h.source, h.request()), /One-seat controller is held/);
  assert.deepEqual(h.holds, ['OWN_BRIDGE_CALLBACK_FAILED']);
  assert.equal(h.ingress().length, 2);
  assert.equal(h.ingress().at(-1).phase, 'response-body');
  assert.equal(h.ingress().at(-1).result, 'exception');
  assertPrivateFieldsAbsent(h.evidence);
});

test('only an exact receiptOnly sent probe treats missing observed proof as an expected refusal', async () => {
  const code = 'managed-observed-receipt-unavailable';
  for (const [route, receiptOnly, expected] of [
    ['/sent', true, true],
    ['/sent', false, false],
    ['/sent', 'true', false],
    ['/state', true, false],
    ['/decision', true, false],
  ]) {
    const h = harness({
      response: () => ({ status: 409, ok: false, text: async () => JSON.stringify({ code }) }),
    });
    const reply = await h.callback(h.source, h.request(route, { receiptOnly }));
    assert.equal(reply.status, 409);
    assert.deepEqual(JSON.parse(reply.responseText), { code });
    assert.equal(h.calls.fetch, 1);
    assert.equal(h.calls.invalid, 0);
    assert.deepEqual(h.holds, expected ? [] : ['HOST_REQUEST_REJECTED']);
    assert.equal(h.state.held, !expected);
  }
});
