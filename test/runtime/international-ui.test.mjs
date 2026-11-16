import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  KEYTEKI_UI_NAMES,
  keytekiUiName,
  keytekiUiButton,
  pendingLeaveFrameMatches,
} from '../../tools/keyteki-ui-contract.mjs';
import {
  PublicRoomObserver,
  leaveUnjoinedOwnRoomUi,
  startOwnBoundRoomUi,
} from '../../tools/keyteki-human-public-room-ui.mjs';
import { createJoinedPendingRoomTracker } from '../../tools/keyteki-joined-pending-exit.mjs';

const origin = 'https://thecrucible.online';
const frame = (...args) => '42' + JSON.stringify(args);
const own = 'Fixture Bot';
const other = 'Fixture Human';
const gameId = 'fixture-room-1';
const base = {
  origin,
  setupTimeoutMs: 20,
  self: { name: own, deckName: 'Fixture Deck', serverDeckId: 23 },
  ownAccountNames: [own],
  participants: [own, other],
  room: { gameId, name: 'Fixture room', opponentName: other, gameType: 'beginner', gameFormat: 'normal' },
};
const native = (names = [own], owner = own) => ({
  id: gameId,
  name: base.room.name,
  started: false,
  gamePrivate: false,
  needsPassword: false,
  gameType: 'beginner',
  gameFormat: 'normal',
  owner,
  players: Object.fromEntries(names.map(name => [name, {
    name,
    id: name === own ? 'fixture-own-socket' : 'fixture-other-socket',
    deck: { selected: true, name: name === own ? base.self.deckName : 'Other Fixture Deck' },
  }])),
});

test('UI names accept only the observed exact names and keep dangerous actions separate', () => {
  const observedNames = {
    newGame: ['New Game', '新游戏'],
    start: ['Start', '开始'],
    join: ['Join', '加入'],
    leavePending: ['Leave', '离开'],
    leaveFinished: ['Leave Game', '离开游戏'],
    allowSpectators: ['Allow spectators', '允许观战'],
  };
  assert.deepEqual(KEYTEKI_UI_NAMES, observedNames);
  for (const [control, names] of Object.entries(observedNames)) {
    const pattern = keytekiUiName(control);
    for (const name of names) {
      assert.equal(pattern.test(name), true);
      assert.equal(pattern.test('Other ' + name), false);
      assert.equal(pattern.test(name + ' now'), false);
    }
  }
  assert.equal(keytekiUiName('newGame').test('Quick Join'), false);
  assert.equal(keytekiUiName('leavePending').test('Leave Game'), false);
  assert.equal(keytekiUiName('leaveFinished').test('Leave'), false);
  assert.equal(keytekiUiName('leaveFinished').test('Concede'), false);
  assert.equal(keytekiUiName('start').test('Restart'), false);
  assert.throws(() => keytekiUiName('toString'), /UI_CONTROL_UNKNOWN/);
  assert.throws(() => keytekiUiButton({}, 'allowSpectators'), /UI_BUTTON_UNKNOWN/);
});

test('button helper returns the strict action-specific role locator without picking a first match', () => {
  const result = {};
  const calls = [];
  const page = { getByRole: (role, options) => { calls.push({ role, options }); return result; } };
  assert.equal(keytekiUiButton(page, 'leavePending'), result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'button');
  assert.equal(calls[0].options.name.test('Leave'), true);
  assert.equal(calls[0].options.name.test('离开'), true);
  assert.equal(calls[0].options.name.test('Leave Game'), false);
});

test('pending leave wire matching accepts old or exactly bound new shape only', () => {
  assert.equal(pendingLeaveFrameMatches(frame('leavegame'), gameId), true);
  assert.equal(pendingLeaveFrameMatches(frame('leavegame', gameId), gameId), true);
  for (const payload of [
    frame('leavegame', 'another-room'),
    frame('leavegame', gameId, 'extra'),
    frame('leavegame', { id: gameId }),
    frame('leavegame', null),
    frame('concede', gameId),
    frame('gamestate', {}),
    '40{"token":"fixture-not-a-credential"}',
  ]) assert.equal(pendingLeaveFrameMatches(payload, gameId), false);
  assert.equal(pendingLeaveFrameMatches(frame('leavegame'), null), false);
  assert.equal(pendingLeaveFrameMatches(frame('leavegame'), ''), false);
});

function publicFixture({ sentFrame, acknowledge = true, caption = 'Leave', names = [own], pageOrigin = origin } = {}) {
  const config = { ...base, createPublic: true, room: { ...base.room, gameId: null } };
  const page = new EventEmitter();
  page.url = () => pageOrigin + '/play';
  let observer;
  const calls = { clicks: 0 };
  page.getByRole = (role, { name }) => {
    assert.equal(role, 'button');
    assert.equal(name.test(caption), true);
    return {
      waitFor: async () => {},
      click: async () => {
        calls.clicks++;
        observer.ingest(sentFrame ?? frame('leavegame', gameId), true);
        if (acknowledge) observer.ingest(frame('cleargamestate'));
      },
    };
  };
  observer = new PublicRoomObserver(page, config);
  observer.creationRequested = true;
  observer.ingest('40{"sid":"fixture-own-socket"}');
  observer.ingest(frame('gamestate', native(names)));
  return { config, page, observer, calls };
}

for (const [label, sentFrame, caption] of [
  ['international exact game ID', frame('leavegame', gameId), 'Leave'],
  ['legacy no-argument form', frame('leavegame'), '离开'],
]) {
  test('own empty-room leave accepts ' + label + ' only after native acknowledgement', async () => {
    const fixture = publicFixture({ sentFrame, caption });
    try {
      const result = await leaveUnjoinedOwnRoomUi(fixture.page, fixture.observer, fixture.config);
      assert.equal(fixture.calls.clicks, 1);
      assert.equal(result.serverLeaveConfirmed, true);
      assert.equal(result.serverLeaveReceipt.gameId, gameId);
      assert.equal(result.serverLeaveReceipt.source, 'cleargamestate');
    } finally { fixture.observer.dispose(); }
  });
}

for (const [label, options] of [
  ['wrong room ID', { sentFrame: frame('leavegame', 'another-room') }],
  ['extra arguments', { sentFrame: frame('leavegame', gameId, 'extra') }],
  ['missing native acknowledgement', { acknowledge: false }],
]) {
  test('own empty-room leave keeps unknown outcome for ' + label, async () => {
    const fixture = publicFixture(options);
    try {
      await assert.rejects(
        leaveUnjoinedOwnRoomUi(fixture.page, fixture.observer, fixture.config),
        { code: 'EMPTY_ROOM_SERVER_LEAVE_UNCONFIRMED' },
      );
      assert.equal(fixture.calls.clicks, 1);
      assert.equal(fixture.observer.serverLeaveReceipt, null);
    } finally { fixture.observer.dispose(); }
  });
}

test('own empty-room leave keeps the opponent and origin guards before any click', async () => {
  for (const [options, code] of [
    [{ names: [own, other] }, 'ONLY_UNJOINED_OWN_PENDING_ROOM_MAY_CLOSE'],
    [{ pageOrigin: 'https://other.invalid' }, 'UI_ORIGIN_CHANGED'],
  ]) {
    const fixture = publicFixture(options);
    try {
      await assert.rejects(leaveUnjoinedOwnRoomUi(fixture.page, fixture.observer, fixture.config), { code });
      assert.equal(fixture.calls.clicks, 0);
    } finally { fixture.observer.dispose(); }
  }
});

function joinedFixture() {
  const tracker = createJoinedPendingRoomTracker({ ...base, createPublic: false }, { now: () => 1000 });
  const metadata = { transportKey: 'fixture-transport', transportKind: 'websocket', channelId: 'fixture-channel' };
  tracker.observeTransport('socket-open', metadata);
  tracker.ingest('0{"sid":"fixture-transport","pingInterval":25000,"pingTimeout":20000}', metadata);
  tracker.ingest('40{"sid":"fixture-own-socket"}', metadata);
  tracker.ingest(frame('gamestate', native([own, other], other)), { ...metadata, joinRequested: true });
  tracker.ingest(frame('gamestate', native()), metadata);
  assert.equal(tracker.snapshot().current.owner, own);
  return { tracker, metadata };
}

test('joined-pending tracker accepts both observed leave shapes and still requires native acknowledgement', () => {
  for (const payload of [frame('leavegame'), frame('leavegame', gameId)]) {
    const { tracker, metadata } = joinedFixture();
    tracker.beginLeave();
    tracker.ingest(payload, { ...metadata, sent: true });
    assert.equal(tracker.snapshot().leave.sent, 1);
    assert.equal(tracker.snapshot().leave.acknowledgement, null);
    tracker.ingest(frame('cleargamestate'), metadata);
    assert.equal(tracker.snapshot().leave.acknowledgement.gameId, gameId);
  }
});

test('joined-pending tracker cannot certify wrong ID or extra-argument leave from a later clear', () => {
  for (const payload of [frame('leavegame', 'another-room'), frame('leavegame', gameId, 'extra')]) {
    const { tracker, metadata } = joinedFixture();
    tracker.beginLeave();
    tracker.ingest(payload, { ...metadata, sent: true });
    tracker.ingest(frame('cleargamestate'), metadata);
    assert.equal(tracker.snapshot().leave.sent, 0);
    assert.equal(tracker.snapshot().leave.acknowledgement, null);
  }
});

test('international pending-leave shape preserves intent and transport identity guards', () => {
  const one = joinedFixture();
  one.tracker.ingest(frame('leavegame', gameId), { ...one.metadata, sent: true });
  assert.equal(one.tracker.snapshot().blockedReason, 'JOINED_PENDING_UNEXPECTED_LEAVE');
  const two = joinedFixture();
  two.tracker.beginLeave();
  two.tracker.ingest(frame('leavegame', gameId), { ...two.metadata, transportKey: 'replaced', sent: true });
  assert.equal(two.tracker.snapshot().blockedReason, 'JOINED_PENDING_TRANSPORT_CHANGED');
  assert.equal(two.tracker.snapshot().leave.sent, 0);
});

test('bound Start preserves disabled-control rejection for both exact UI names', async () => {
  for (const caption of ['Start', '开始']) {
    let clicked = false;
    const page = { getByRole: (role, { name }) => {
      assert.equal(role, 'button');
      assert.equal(name.test(caption), true);
      return { isVisible: async () => true, isEnabled: async () => false, click: async () => { clicked = true; } };
    } };
    const observer = { assertHealthy: () => {}, active: false, pending: {
      gameId, owner: own, participants: [own, other], allSelected: true, ownSelected: true, ownDeckName: base.self.deckName,
    } };
    await assert.rejects(startOwnBoundRoomUi(page, observer, base), { code: 'BOUND_HOST_START_NOT_READY' });
    assert.equal(clicked, false);
  }
});
