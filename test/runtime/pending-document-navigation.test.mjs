import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mockPendingDocumentSession } from '../helpers/pending-document-session.mjs';
import { PublicRoomObserver } from '../../tools/keyteki-human-public-room-ui.mjs';
import { lockCreatedPublicPair } from '../../tools/keyteki-human-create-public.mjs';
import { normalizeHumanConfig } from '../../tools/keyteki-human-config.mjs';
import { observePageDocuments } from '../../tools/keyteki-document-observer.mjs';

const origin = 'https://navigation-fixture.invalid', self = 'FixtureBot', other = 'FixtureHuman';
const gameId = 'navigation-fixture-room', frame = (...args) => '42' + JSON.stringify(args);
const input = () => ({ schema: 'keyteki-human-one-seat-draft-v1', origin,
  self: { name: self, serverDeckId: 23, deckName: 'Fixture Deck' }, ownAccountNames: [self],
  room: { name: 'AI fixture', gameType: 'casual', gameFormat: 'normal' },
  credentialsPath: '/fixture/credentials.json', output: '/fixture/attempt', setupTimeoutMs: 1000,
});
const native = (selected = true, names = [self, other]) => ({ id: gameId, name: 'AI fixture',
  owner: self, started: false, gamePrivate: false, needsPassword: false,
  gameType: 'casual', gameFormat: 'normal', players: Object.fromEntries(names.map(name => [name,
    { name, id: name === self ? 'own-socket' : 'other-socket',
      deck: { selected: name === self && selected, name: name === self ? 'Fixture Deck' : 'Other Deck' } }])) });
function setup(options) {
  const page = new EventEmitter();
  page.url = () => origin + '/decks';
  const session = mockPendingDocumentSession(page, options);
  const observer = new PublicRoomObserver(page, normalizeHumanConfig(input(), { createPublic: true }));
  const socket = new EventEmitter();
  socket.url = () => origin.replace('https:', 'wss:') + '/socket.io/?transport=websocket';
  const receive = payload => socket.emit('framereceived', { payload });
  const send = payload => socket.emit('framesent', { payload });
  const open = () => {
    page.emit('websocket', socket);
    receive('0{"sid":"native-transport","pingInterval":25000,"pingTimeout":20000}');
    receive('40{"sid":"own-socket"}');
  };
  const populate = () => {
    observer.creationRequested = true;
    receive(frame('gamestate', native(false, [self])));
    send(frame('selectdeck', gameId, 23, false));
    receive(frame('gamestate', native()));
  };
  const bind = () => lockCreatedPublicPair(input(), observer);
  return { page, session, observer, socket, receive, send, open, populate, bind };
}
function sameDocument(f, url) {
  f.session.emit('Page.navigatedWithinDocument', { frameId: f.session.frame.id, url });
  f.page.emit('framenavigated', f.page.mainFrame());
}
function polling(f, method, payload) {
  const request = { url: () => origin + '/socket.io/?transport=polling&sid=native-transport',
    method: () => method, postData: () => payload };
  f.page.emit('request', request);
  return body => f.observer.onResponse({ url: request.url, request: () => request, status: () => 200, text: async () => body });
}

test('same-document routing preserves the original WebSocket and exact created-pair selection', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open();
    const initialEpoch = f.observer.documentEpoch;
    for (const route of ['/play', '/play#pending', '/decks', '/play']) sameDocument(f, origin + route);
    f.populate(); f.bind();
    assert.equal(f.observer.documentEpoch, initialEpoch);
    assert.equal(f.observer.createdPending.snapshot().createdPair.selection.serverDeckId, 23);
    assert.equal(f.observer.createdPending.checkContinuity().verified, true);
    assert.equal(f.session.calls.filter(method => method === 'Page.enable').length, 1);
  } finally { await f.observer.dispose(); }
});

test('a polling response already in flight survives same-document routing and records one selection', async () => {
  const f = setup();
  try {
    await f.observer.ready;
    await polling(f, 'GET')('0{"sid":"native-transport","pingInterval":25000,"pingTimeout":20000}\x1e40{"sid":"own-socket"}');
    f.observer.creationRequested = true;
    const complete = polling(f, 'GET');
    sameDocument(f, origin + '/play');
    await complete(frame('gamestate', native(false, [self])));
    await polling(f, 'POST', frame('selectdeck', gameId, 23, false))('ok');
    await polling(f, 'GET')(frame('gamestate', native()));
    f.bind();
    assert.equal(f.observer.commandSequence, 1);
    assert.equal(f.observer.createdPending.snapshot().createdPair.selection.serverDeckId, 23);
    assert.equal(f.observer.createdPending.checkContinuity().kind, 'polling');
  } finally { await f.observer.dispose(); }
});

for (const [label, event] of [
  ['new-document navigation', { frame: { id: 'fixture-main-frame', loaderId: 'new-loader', url: origin + '/other' } }],
  ['same-URL reload', { frame: { id: 'fixture-main-frame', loaderId: 'reload-loader', url: origin + '/decks' } }],
  ['back/forward-cache restore reusing the old loader', { type: 'BackForwardCacheRestore',
    frame: { id: 'fixture-main-frame', loaderId: 'fixture-loader', url: origin + '/decks' } }],
]) test(label + ' invalidates a bound room and ignores stale socket evidence', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open(); f.populate(); f.bind();
    const before = f.observer.createdPending.snapshot();
    f.session.emit('Page.frameNavigated', event);
    f.send(frame('selectdeck', gameId, 999, false));
    f.receive(frame('gamestate', native()));
    const after = f.observer.createdPending.snapshot();
    assert.equal(f.observer.documentEpoch, 1);
    assert.equal(after.blockedReason, 'JOINED_PENDING_DOCUMENT_CHANGED');
    assert.deepEqual(after.ownSelection, before.ownSelection);
    assert.throws(() => f.observer.createdPending.checkContinuity(), /DOCUMENT_CHANGED/);
    assert.throws(() => f.observer.createdPending.beginLeave(), /LEAVE_NOT_ELIGIBLE/);
  } finally { await f.observer.dispose(); }
});

test('a real document change before binding discards old handshake and pending frames', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open();
    f.session.emit('Page.frameNavigated', { frame: { ...f.session.frame, loaderId: 'new-loader' } });
    f.populate();
    assert.equal(f.observer.createdPending.snapshot().joined, null);
    assert.throws(f.bind, /CREATED_PENDING_PAIR_NOT_VERIFIED/);
  } finally { await f.observer.dispose(); }
});

test('an iframe document commit does not invalidate the main-page connection', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open(); f.populate(); f.bind();
    f.session.emit('Page.frameNavigated', { frame: { id: 'iframe', parentId: f.session.frame.id, loaderId: 'child-loader' } });
    assert.equal(f.observer.documentEpoch, 0);
    assert.equal(f.observer.createdPending.checkContinuity().verified, true);
  } finally { await f.observer.dispose(); }
});

test('document monitoring is required before preparation and catches a commit during initialization', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup({ send: async (method, session) => {
    if (method === 'Page.enable') {
      session.emit('Page.frameNavigated', { frame: { ...session.frame, loaderId: 'during-enable' } });
      await gate;
    }
  } });
  try {
    assert.throws(() => f.observer.assertHealthy(), /OBSERVER_NOT_READY/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.observer.documentEpoch, 1);
    release(); await f.observer.ready;
    assert.equal(f.observer.documentEpoch, 1);
    assert.equal(f.observer.documentIdentity.loaderId, 'during-enable');
    f.open(); f.populate(); f.bind();
    assert.equal(f.observer.createdPending.snapshot().createdPair.documentEpoch, 1);
  } finally { release(); await f.observer.dispose(); }
});

for (const [label, options, expected] of [
  ['CDP session unavailable', { create: () => { throw Error('unsupported'); } }, 'PENDING_DOCUMENT_OBSERVER_UNAVAILABLE'],
  ['Page.enable rejects', { send: method => { if (method === 'Page.enable') throw Error('session unavailable'); } }, 'PENDING_DOCUMENT_OBSERVER_UNAVAILABLE'],
  ['initial document identity is incomplete', { send: method => method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'main' } } } : undefined }, 'PENDING_DOCUMENT_IDENTITY_UNVERIFIED'],
  ['session closes during initialization', { send: (method, session) => { if (method === 'Page.enable') session.emit('close'); } }, 'PENDING_DOCUMENT_OBSERVER_CLOSED'],
]) test(label + ' fails closed without unhandled initialization rejection', async () => {
  const f = setup(options);
  try {
    await assert.rejects(f.observer.ready, { code: expected });
    assert.throws(() => f.observer.assertHealthy(), { code: expected });
    assert.equal(f.observer.createdPending.snapshot().blockedReason, 'JOINED_PENDING_DOCUMENT_OBSERVATION_LOST');
    f.open(); f.populate();
    assert.throws(f.bind, { code: expected });
  } finally { await f.observer.dispose(); }
});

test('an unexpected monitor close before joining stays blocked through later valid frames', async () => {
  const f = setup();
  try {
    await f.observer.ready;
    f.session.emit('close');
    f.open(); f.populate();
    f.session.emit('Page.frameNavigated', { frame: { ...f.session.frame, loaderId: 'later' } });
    assert.throws(f.bind, /OBSERVER_CLOSED/);
    assert.equal(f.observer.documentReady, false);
    assert.equal(f.observer.createdPending.snapshot().blockedReason, 'JOINED_PENDING_DOCUMENT_OBSERVATION_LOST');
  } finally { await f.observer.dispose(); }
});

test('an unverifiable main-document commit cannot preserve cleanup eligibility', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open(); f.populate(); f.bind();
    f.session.emit('Page.frameNavigated', { frame: { id: f.session.frame.id } });
    assert.throws(() => f.observer.assertHealthy(), /IDENTITY_UNVERIFIED/);
    assert.throws(() => f.observer.createdPending.checkContinuity(), /DOCUMENT_OBSERVATION_LOST/);
  } finally { await f.observer.dispose(); }
});

test('only the existing expected-owned-browser-close boundary permits monitor shutdown', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open(); f.populate(); f.bind();
    f.observer.createdPending.expectOwnedBrowserClose();
    f.session.emit('close'); f.socket.emit('close');
    assert.equal(f.observer.createdPending.snapshot().blockedReason, null);
    assert.throws(() => f.observer.assertHealthy(), /OBSERVER_CLOSED/);
  } finally { await f.observer.dispose(); }
});

test('synchronous disposal during asynchronous session creation detaches once and rejects readiness', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = setup({ create: () => gate });
  await f.observer.dispose();
  release();
  await assert.rejects(f.observer.ready, /OBSERVER_CLOSED/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.session.detaches, 1);
  assert.equal(f.session.listenerCount('Page.frameNavigated'), 0);
  assert.equal(f.page.listenerCount('websocket'), 0);
});

test('disposing a ready observer removes listeners and detaches its owned CDP session', async () => {
  const f = setup();
  await f.observer.ready; f.open();
  await f.observer.dispose(); await f.observer.dispose();
  assert.equal(f.session.detaches, 1);
  assert.equal(f.session.listenerCount('Page.frameNavigated'), 0);
  assert.equal(f.session.listenerCount('close'), 0);
  assert.equal(f.page.listenerCount('request'), 0);
  assert.equal(f.socket.listenerCount('framereceived'), 0);
});


for (const phase of ['create', 'enable', 'frame-tree']) {
  test('a stalled ' + phase + ' has a finite initialization deadline and cannot recover from late results', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const page = new EventEmitter(), unavailable = [];
    const session = mockPendingDocumentSession(page, {
      create: phase === 'create' ? () => gate : undefined,
      send: async method => {
        if ((phase === 'enable' && method === 'Page.enable') ||
            (phase === 'frame-tree' && method === 'Page.getFrameTree')) await gate;
      },
    });
    const monitor = observePageDocuments(page, { timeoutMs: 20, onUnavailable: code => unavailable.push(code) });
    await assert.rejects(monitor.ready, { code: 'PENDING_DOCUMENT_OBSERVER_TIMEOUT' });
    assert.deepEqual(unavailable, ['PENDING_DOCUMENT_OBSERVER_TIMEOUT']);
    assert.equal(monitor.snapshot().ready, false);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.detaches, 1);
    assert.equal(session.listenerCount('Page.frameNavigated'), 0);
    assert.equal(monitor.snapshot().ready, false);
    assert.deepEqual(unavailable, ['PENDING_DOCUMENT_OBSERVER_TIMEOUT']);
    if (phase !== 'frame-tree') assert.equal(session.calls.includes('Page.getFrameTree'), false);
    assert.throws(() => monitor.assertReady(), /OBSERVER_TIMEOUT/);
    await monitor.dispose();
  });
}

for (const cleanup of ['rejects', 'stalls']) {
  test('initialization timeout settles before detach ' + cleanup, async () => {
    const page = new EventEmitter(), unavailable = [];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const session = mockPendingDocumentSession(page, { send: method => method === 'Page.enable' ? gate : undefined });
    session.detach = async () => {
      session.detaches++;
      if (cleanup === 'rejects') throw Error('detachment unavailable');
      await new Promise(() => {});
    };
    const monitor = observePageDocuments(page, { timeoutMs: 20, onUnavailable: code => unavailable.push(code) });
    await assert.rejects(monitor.ready, /OBSERVER_TIMEOUT/);
    assert.equal(session.detaches, 1);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unavailable, ['PENDING_DOCUMENT_OBSERVER_TIMEOUT']);
    assert.equal(monitor.snapshot().ready, false);
    await monitor.dispose();
  });
}

test('disposal during stalled initialization rejects ready immediately even if detach stalls', async () => {
  const page = new EventEmitter(), unavailable = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const session = mockPendingDocumentSession(page, { send: method => method === 'Page.enable' ? gate : undefined });
  session.detach = () => { session.detaches++; return new Promise(() => {}); };
  const monitor = observePageDocuments(page, { timeoutMs: 1000, onUnavailable: code => unavailable.push(code) });
  await new Promise(resolve => setImmediate(resolve));
  void monitor.dispose();
  await assert.rejects(monitor.ready, /OBSERVER_CLOSED/);
  assert.equal(session.detaches, 1);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unavailable, ['PENDING_DOCUMENT_OBSERVER_CLOSED']);
  assert.equal(session.calls.includes('Page.getFrameTree'), false);
});

test('expected browser release does not waive an unverifiable document identity', async () => {
  const f = setup();
  try {
    await f.observer.ready; f.open(); f.populate(); f.bind();
    f.observer.createdPending.expectOwnedBrowserClose();
    f.session.emit('Page.frameNavigated', { frame: { id: f.session.frame.id } });
    assert.equal(f.observer.createdPending.snapshot().blockedReason, 'JOINED_PENDING_DOCUMENT_OBSERVATION_LOST');
    assert.throws(() => f.observer.assertHealthy(), /IDENTITY_UNVERIFIED/);
  } finally { await f.observer.dispose(); }
});
