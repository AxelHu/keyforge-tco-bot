import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mockPendingDocumentSession } from '../helpers/pending-document-session.mjs';
import { AgentBrowser } from '../../tools/browser-provider.mjs';
import { runCreatePublic } from '../../tools/keyteki-human-create-public.mjs';

const origin = 'https://preparation-fixture.invalid';
const own = 'FixtureBot';
const password = 'fixture-password-must-not-be-recorded';

async function failedPreparation(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-public-prepare-failure-'));
  const credentialsPath = path.join(directory, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({ origin, accounts: { [own]: { password } } }), { mode: 0o600 });
  const output = path.join(directory, 'attempt');
  const config = {
    schema: 'keyteki-human-one-seat-draft-v1', origin,
    self: { name: own, serverDeckId: 23, deckName: 'Fixture Deck', codePolicy: 'tactical-style-engine-v3' },
    room: { name: 'AI fixture', gameType: 'casual', gameFormat: 'normal' },
    credentialsPath, output, setupTimeoutMs: 1000, social: { enabled: false },
  };
  const page = new EventEmitter(), socket = new EventEmitter(), calls = [];
  mockPendingDocumentSession(page);
  let currentUrl = origin + '/login';
  page.url = () => currentUrl;
  page.addInitScript = async () => {};
  page.setViewportSize = async () => {};
  page.setDefaultTimeout = () => {};
  socket.url = () => origin.replace('https:', 'wss:') + '/socket.io/?transport=websocket';
  page.goto = async url => {
    calls.push('navigate-login'); currentUrl = url;
    if (mode === 'navigate') throw Object.assign(Error('raw browser fill detail: ' + password), { name: 'TimeoutError' });
    if (mode !== 'initial-lobby') {
      page.emit('websocket', socket);
      socket.emit('framereceived', { payload: '40{"sid":"fixture-lobby"}' });
    }
  };
  page.locator = selector => ({
    fill: async value => {
      calls.push(selector === 'input[name="password"]' ? 'fill-password' : 'fill-username');
      if (selector === 'input[name="password"]' && mode === 'fill') throw Error('raw fill argument: ' + value);
    },
    click: async () => {
      if (selector === 'form button[type="submit"]') { calls.push('submit-login'); currentUrl = origin + '/'; return; }
      assert.equal(selector, 'a[href="/play"]:visible');
      calls.push('post-login-create');
      throw Object.assign(Error('raw unrelated detail: ' + password), { code: 'POST_LOGIN_FIXTURE_FAILURE' });
    },
  });
  page.waitForResponse = async predicate => {
    const response = { url: () => origin + '/api/account/login', request: () => ({ method: () => 'POST' }),
      status: () => 200, json: async () => ({ success: true, user: { username: own } }) };
    assert.equal(predicate(response), true);
    return response;
  };
  page.waitForURL = async predicate => { assert.equal(predicate(new URL(currentUrl)), true); };
  page.getByText = () => ({});
  page.getByRole = () => ({ filter: () => ({ waitFor: async () => {} }) });
  const getBrowser = AgentBrowser.prototype.getBrowser;
  const log = console.log, logs = [];
  const signals = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, new Set(process.listeners(signal))]));
  let result;
  try {
    AgentBrowser.prototype.getBrowser = async function(agentId) { return { page, agentId, cdpEndpoint: 'http://127.0.0.1:1' }; };
    console.log = (...args) => logs.push(args.join(' '));
    result = await runCreatePublic(config);
    const handoff = JSON.parse(fs.readFileSync(path.join(output, 'handoff.json'), 'utf8'));
    const persisted = fs.readdirSync(output).map(name => fs.readFileSync(path.join(output, name), 'utf8')).join('');
    assert.equal(persisted.includes(password), false);
    assert.equal(logs.join('').includes(password), false);
    assert.equal(handoff.held, true);
    assert.equal(handoff.hostStarted, false);
    assert.equal(handoff.gameStarted, false);
    assert.equal(handoff.gameId, null);
    assert.equal(fs.existsSync(path.join(output, 'host')), false);
    return { handoff, calls };
  } finally {
    AgentBrowser.prototype.getBrowser = getBrowser;
    console.log = log;
    result?.observer?.dispose();
    page.removeAllListeners(); socket.removeAllListeners();
    for (const [signal, before] of signals) {
      for (const listener of process.listeners(signal)) if (!before.has(listener)) process.removeListener(signal, listener);
    }
    await result?.pool?.closeAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [mode, stage, safeCode, errorKind, initialLobbyConnected] of [
  ['navigate', 'navigate-login', 'UI_OPERATION_FAILED', 'timeout', false],
  ['initial-lobby', 'wait-initial-lobby', 'INITIAL_LOBBY_CONNECTION_NOT_READY', 'condition', false],
  ['fill', 'fill-credentials', 'UI_OPERATION_FAILED', 'operation', true],
]) {
  test('public creation preserves the safe preparePlayer receipt at ' + stage, async () => {
    const { handoff, calls } = await failedPreparation(mode);
    assert.equal(handoff.holdReason, 'PUBLIC_ROOM_PREPARATION_UNVERIFIED');
    assert.deepEqual(Object.keys(handoff.setupFailure).sort(), ['at', 'confirmed', 'errorKind', 'safeCode', 'stage']);
    assert.equal(handoff.setupFailure.stage, stage);
    assert.equal(handoff.setupFailure.safeCode, safeCode);
    assert.equal(handoff.setupFailure.errorKind, errorKind);
    assert.equal(Number.isFinite(Date.parse(handoff.setupFailure.at)), true);
    assert.deepEqual(handoff.setupFailure.confirmed, {
      initialLobbyConnected, responseIdentityConfirmed: false, rootRouteConfirmed: false,
      usernameButtonConfirmed: false, singleLobbySocketConfirmed: false,
    });
    assert.equal(calls.includes('submit-login'), false);
    if (!initialLobbyConnected) assert.equal(calls.includes('fill-username'), false);
  });
}

test('failure after preparePlayer completes preserves its own code without a false login receipt', async () => {
  const { handoff, calls } = await failedPreparation('after-login');
  assert.equal(handoff.holdReason, 'POST_LOGIN_FIXTURE_FAILURE');
  assert.equal(Object.hasOwn(handoff, 'setupFailure'), false);
  assert.deepEqual(calls, ['navigate-login', 'fill-username', 'fill-password', 'submit-login', 'post-login-create']);
});
