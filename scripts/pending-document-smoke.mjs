#!/usr/bin/env node
/** Optional Chromium + loopback Socket.IO fixture; no real site, account, or gameplay. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'socket.io';
import { AgentBrowser, inspectBrowserProcess, browserProcessDisposition } from '../tools/browser-provider.mjs';
import { browserRecordPath } from '../tools/browser-paths.mjs';
import { PublicRoomObserver, waitForObserved } from '../tools/keyteki-human-public-room-ui.mjs';
import { normalizeHumanConfig } from '../tools/keyteki-human-config.mjs';
import { lockCreatedPublicPair } from '../tools/keyteki-human-create-public.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyforge-document-smoke-'));
process.env.KF_BOT_BROWSER_REGISTRY = path.join(directory, 'registry');
const profileDir = path.join(directory, 'profile');
const pool = new AgentBrowser({ keepAlive: false, cleanupOnExit: false });
const self = 'DocFixtureBot', other = 'DocFixtureHuman', gameId = 'local-document-fixture';
let origin, browserBinding, context, observer, failure, externalRequestsBlocked = 0;
const checks = {}, localCommands = [];
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (request.url === '/frame') { response.end('<!doctype html><title>Local iframe</title>'); return; }
  response.end(`<!doctype html><title>Local document fixture</title><body>Loopback only; no real game.
    <script>
      window.fixtureSocket = new WebSocket('ws://' + location.host + '/socket.io/?EIO=4&transport=websocket');
      window.fixtureSocket.onmessage = event => {
        if (event.data.startsWith('0{')) window.fixtureSocket.send('40');
        if (event.data.startsWith('40{')) window.fixtureReady = true;
        if (event.data === '2') window.fixtureSocket.send('3');
      };
      window.fixtureSend = args => window.fixtureSocket.send('42' + JSON.stringify(args));
    </script></body>`);
});
const io = new Server(server, { transports: ['websocket'], serveClient: false });
io.on('connection', socket => {
  const room = (selected, names = [self]) => ({ id: gameId, name: 'AI document fixture', owner: self,
    started: false, gamePrivate: false, needsPassword: false, gameType: 'casual', gameFormat: 'normal',
    players: Object.fromEntries(names.map(name => [name, { name, id: name === self ? socket.id : 'other-socket',
      deck: { selected: name === self && selected, name: name === self ? 'Fixture Deck' : 'Other Deck' } }])) });
  socket.on('fixturecreate', () => { localCommands.push('fixturecreate'); socket.emit('gamestate', room(false)); });
  socket.on('selectdeck', (id, deck, standalone) => {
    assert.equal(id, gameId); assert.equal(deck, 23); assert.equal(standalone, false);
    localCommands.push('selectdeck'); socket.emit('gamestate', room(true, [self, other]));
  });
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
  const input = { schema: 'keyteki-human-one-seat-draft-v1', origin,
    self: { name: self, serverDeckId: 23, deckName: 'Fixture Deck' }, ownAccountNames: [self],
    room: { name: 'AI document fixture', gameType: 'casual', gameFormat: 'normal' },
    credentialsPath: '/fixture/unused-credentials.json', output: '/fixture/unused-output', setupTimeoutMs: 5000 };
  const config = normalizeHumanConfig(input, { createPublic: true });
  const instance = await pool.getBrowser('keyforge-tco-bot:document-smoke', { mode: 'per-agent', profileDir, headless: true });
  browserBinding = JSON.parse(fs.readFileSync(browserRecordPath(profileDir), 'utf8')).process;
  context = await instance.page.context().browser().newContext();
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequestsBlocked++;
    return route.abort();
  });
  const page = await context.newPage();
  observer = new PublicRoomObserver(page, config);
  await observer.ready;
  await page.goto(origin + '/decks', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.fixtureReady === true);
  const epoch = observer.documentEpoch;
  assert.equal(epoch, 1);
  const originalSocket = await page.evaluateHandle(() => window.fixtureSocket);
  await page.evaluate(() => {
    history.pushState({}, '', '/play');
    history.replaceState({}, '', '/play?gameId=local-document-fixture');
    location.hash = 'pending';
  });
  await page.waitForURL(url => url.pathname === '/play' && url.hash === '#pending');
  assert.equal(observer.documentEpoch, epoch);
  assert.equal(await page.evaluate(socket => socket === window.fixtureSocket, originalSocket), true);
  observer.creationRequested = true;
  await page.evaluate(() => window.fixtureSend(['fixturecreate']));
  await waitForObserved(() => observer.createdPending.snapshot().joined, 5000, 'LOCAL_PENDING_NOT_OBSERVED');
  await page.evaluate(id => window.fixtureSend(['selectdeck', id, 23, false]), gameId);
  await waitForObserved(() => observer.pending?.ownSelected && observer.candidateName, 5000, 'LOCAL_SELECTION_NOT_OBSERVED');
  lockCreatedPublicPair(input, observer);
  assert.equal(observer.createdPending.snapshot().createdPair.selection.serverDeckId, 23);
  assert.equal(observer.createdPending.checkContinuity().verified, true);
  checks.historyRoutingKeepsNativeSocketAndCreatedSelection = true;

  await page.evaluate(() => { const iframe = document.createElement('iframe'); iframe.src = '/frame'; document.body.append(iframe); });
  await waitForObserved(() => page.frames().some(frame => frame.url() === origin + '/frame'), 5000, 'LOCAL_IFRAME_NOT_LOADED');
  assert.equal(observer.documentEpoch, epoch);
  assert.equal(observer.createdPending.checkContinuity().verified, true);
  checks.iframeNavigationKeepsMainDocument = true;

  await page.reload({ waitUntil: 'domcontentloaded' });
  assert.ok(observer.documentEpoch > epoch);
  assert.equal(observer.createdPending.snapshot().blockedReason, 'JOINED_PENDING_DOCUMENT_CHANGED');
  assert.throws(() => observer.createdPending.checkContinuity(), /DOCUMENT_CHANGED/);
  checks.sameUrlReloadInvalidatesOldNativeEvidence = true;
  assert.deepEqual(localCommands, ['fixturecreate', 'selectdeck']);
  assert.equal(externalRequestsBlocked, 0);
  checks.onlyLoopbackCommands = true;
} catch (error) { failure = error; }
finally {
  await observer?.dispose();
  try { await context?.close(); } catch (error) { failure ??= error; }
  try {
    await pool.closeAll();
    if (browserBinding) assert.equal(browserProcessDisposition(browserBinding, inspectBrowserProcess(browserBinding.pid)), 'gone');
    assert.equal(fs.existsSync(browserRecordPath(profileDir)), false);
    checks.ownedBrowserAndLeaseReleased = true;
  } catch (error) { failure ??= error; }
  await new Promise(resolve => io.close(resolve));
  if (failure) {
    console.error(JSON.stringify({ retainedDiagnosticDirectory: directory }));
    throw failure;
  }
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ schema: 'keyforge-pending-document-smoke-v1', result: 'passed',
  evidenceKind: 'real Chromium and native Socket.IO on a local loopback fixture',
  realSiteOrAccountUsed: false, liveGameVerified: false, checks, externalRequestsBlocked }, null, 2));
