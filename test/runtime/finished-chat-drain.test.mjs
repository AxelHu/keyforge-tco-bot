import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForFinishedChat } from '../../tools/keyteki-finished-chat-drain.mjs';
import { installFinishedRoomExit } from '../../tools/keyteki-finished-room-exit.mjs';

const identity = { origin: 'http://fixture.invalid:4000', gameId: 'finished-fixture', playerName: 'FixtureBot' };

test('explicit disabled social skips the chat wait without a read, timer, or fabricated drain proof', async () => {
  let reads = 0, waits = 0, cancellationChecks = 0;
  const result = await waitForFinishedChat({ identity, socialEnabled: false,
    readStatus: async () => { reads++; throw Error('disabled path must not poll'); },
    wait: async () => { waits++; throw Error('disabled path must not wait'); },
    cancelled: () => { cancellationChecks++; return null; }, clock: () => 100 });
  assert.equal(result.outcome, 'skipped'); assert.equal(result.reason, 'social-disabled');
  assert.equal(result.checks, 0); assert.equal(result.budgetMs, 0); assert.equal(result.elapsedMs, 0);
  assert.equal(result.serverEchoConfirmed, false); assert.equal(result.last.drained, false);
  assert.equal(result.last.observable, false); assert.equal(Object.hasOwn(result.last, 'terminalObserved'), false);
  assert.equal(reads, 0); assert.equal(waits, 0); assert.equal(cancellationChecks, 1);
});

test('operator cancellation precedes even an explicitly disabled chat skip', async () => {
  for (const reason of ['operator-paused', 'exit-closed', 'terminal-context-changed']) {
    const result = await waitForFinishedChat({ identity, socialEnabled: false,
      readStatus: () => { throw Error('must not read'); }, wait: () => { throw Error('must not wait'); },
      cancelled: () => reason, clock: () => 100 });
    assert.equal(result.outcome, 'cancelled'); assert.equal(result.reason, reason);
    assert.equal(result.checks, 0); assert.equal(result.budgetMs, 0);
    assert.equal(result.serverEchoConfirmed, false);
  }
});

test('enabled and unknown social configurations retain bounded polling for an unobserved same-seat session', async () => {
  for (const socialEnabled of [true, undefined, null, 0, '', 'false', {}]) {
    let now = 0, reads = 0, waits = 0;
    const result = await waitForFinishedChat({ identity, socialEnabled, timeoutMs: 100, pollMs: 25,
      readStatus: async () => { reads++; return { social: [] }; },
      clock: () => now, wait: async ms => { waits++; now += ms; } });
    assert.equal(result.outcome, 'timed-out'); assert.equal(result.reason, 'same-seat-session-unobserved');
    assert.equal(result.budgetMs, 100); assert.equal(result.elapsedMs, 100);
    assert.equal(result.checks, 4); assert.equal(reads, 4); assert.equal(waits, 4);
    assert.equal(result.serverEchoConfirmed, false);
  }
});

test('enabled social still requires settled scheduling metadata for this exact terminal seat', async () => {
  let now = 0, reads = 0;
  const row = { ...identity, phase: 'idle', terminalObserved: true, pending: 0, pendingIssuedCount: 0 };
  const result = await waitForFinishedChat({ identity, socialEnabled: true, timeoutMs: 100, pollMs: 25,
    readStatus: async () => ({ social: [reads++ ? row : { ...row, playerName: 'Other' }] }),
    clock: () => now, wait: async ms => { now += ms; } });
  assert.equal(result.outcome, 'drained'); assert.equal(result.reason, 'no-unsettled-local-chat-work');
  assert.equal(result.checks, 2); assert.equal(result.elapsedMs, 25); assert.equal(result.serverEchoConfirmed, false);
});

function fixture(t) {
  const config = { origin: identity.origin, self: { name: identity.playerName },
    room: { gameId: identity.gameId }, participants: ['FixtureBot', 'Visitor'],
    social: { enabled: false }, leaveAfterFinish: true };
  const state = { finished: true, fullVerified: true, phase: 'finished-preserved',
    finalPublicView: { gameId: identity.gameId, playerName: identity.playerName,
      started: true, winner: identity.playerName, players: { FixtureBot: {}, Visitor: {} } } };
  const receipt = { documentId: 'document-1', frameToken: 'frame-1', transportPath: '/socket.io', nativeSequence: 7, ownerEpoch: 1 };
  const native = { id: identity.gameId, started: true, winner: identity.playerName, players: { FixtureBot: {}, Visitor: {} } };
  const snap = { ...receipt, gameId: identity.gameId, playerName: identity.playerName,
    enabled: true, invalid: false, connected: true, operatorPaused: false };
  const calls = { reads: 0, snapshots: 0, prepared: 0, quiesced: 0, leaves: 0, verified: 0, monitorClosed: 0, completed: 0 };
  const f = { config, state, receipt, native, snap, calls, operatorPaused: false, watchdogPhase: 'terminal',
    membershipPresent: true, confirmAbsence: true, onSave: () => {}, onQuiesce: () => {} };
  const before = () => ({ gameId: identity.gameId, playerName: identity.playerName, seatPresent: f.membershipPresent,
    ownSeatPreviouslyObserved: true, source: 'games', ordinal: 1 });
  const page = { url: () => identity.origin + '/play?gameId=' + identity.gameId,
    getByRole: (role, options) => {
      assert.equal(role, 'button'); assert.equal(options.name.test('Leave Game'), true);
      return { isVisible: async () => true,
        click: async () => { calls.leaves++; }, waitFor: async options => { assert.equal(options.state, 'hidden'); } };
    } };
  const watchdog = { snapshot: async () => { calls.snapshots++; return f.snap; },
    watchdog: { status: () => ({ phase: f.watchdogPhase, receipt: f.receipt }) },
    native: { snapshot: () => f.native } };
  f.install = () => {
    const controller = installFinishedRoomExit({ config, state, page, watchdog, delayMs: 0,
      chatDrainMs: 5, save: () => f.onSave(), externalCancellation: () => f.operatorPaused,
      inspectChat: async () => { calls.reads++; return { social: [] }; },
      prepareSeatCheck: async () => { calls.prepared++; return {
        currentMembership: before,
        verify: async () => { calls.verified++; return { ...before(), source: 'removegame', ordinal: 2,
          seatPresent: !f.confirmAbsence, serverSeatAbsent: f.confirmAbsence, anonymous: true }; },
        close: async () => { calls.monitorClosed++; },
      }; },
      quiesce: async () => { calls.quiesced++; await f.onQuiesce(); return { chatCancellationConfirmed: true }; },
      onComplete: async () => { calls.completed++; },
    });
    t.after(() => controller.close()); return controller;
  };
  return f;
}

test('disabled installer keeps current terminal, positive membership, quiescence, single Leave and absence before completion', async t => {
  const f = fixture(t), controller = f.install();
  await controller.tick(); await controller.tick();
  assert.equal(f.state.finishChatDrain.outcome, 'skipped');
  assert.equal(f.state.finishChatDrain.reason, 'social-disabled');
  assert.equal(f.state.finishChatDrain.checks, 0); assert.equal(f.state.finishChatDrain.budgetMs, 0);
  assert.equal(f.state.finishChatDrain.chatCancellationConfirmed, true);
  assert.equal(f.state.roomExit.phase, 'left-confirmed'); assert.equal(f.state.roomExit.leaveCommandAttempts, 1);
  assert.deepEqual(f.calls, { reads: 0, snapshots: 2, prepared: 1, quiesced: 1, leaves: 1, verified: 1, monitorClosed: 1, completed: 1 });
});

const initialGuards = {
  'unfinished game': f => { f.state.finished = false; },
  'never started game': f => { f.state.finalPublicView.started = false; },
  'foreign game': f => { f.state.finalPublicView.gameId = 'other-game'; },
  'foreign player': f => { f.state.finalPublicView.playerName = 'Visitor'; },
  'unknown winner': f => { f.state.finalPublicView.winner = 'Other'; },
  'changed participants': f => { f.state.finalPublicView.players = { FixtureBot: {}, Other: {} }; },
  'state operator pause': f => { f.state.operatorPaused = true; },
  'watchdog operator pause': f => { f.watchdogPhase = 'operator-paused'; },
  'external operator pause': f => { f.operatorPaused = true; },
  'leave disabled': f => { f.config.leaveAfterFinish = false; },
  'already attempted Leave': f => { f.state.roomExit = { attempted: true }; },
};
for (const [condition, mutate] of Object.entries(initialGuards)) {
  test('disabled chat cannot bypass ' + condition, async t => {
    const f = fixture(t); mutate(f); await f.install().tick();
    assert.equal(f.state.finishChatDrain, undefined);
    assert.deepEqual(f.calls, { reads: 0, snapshots: 0, prepared: 0, quiesced: 0, leaves: 0, verified: 0, monitorClosed: 0, completed: 0 });
  });
}

test('a new operator pause after the disabled receipt still prevents any Leave', async t => {
  const f = fixture(t);
  f.onSave = () => { if (f.state.finishChatDrain?.outcome === 'skipped') f.operatorPaused = true; };
  await f.install().tick();
  assert.equal(f.state.finishChatDrain.reason, 'social-disabled');
  assert.equal(f.state.operatorPaused, true); assert.equal(f.calls.leaves, 0); assert.equal(f.calls.completed, 0);
});

test('disabled chat cannot replace a current native document identity proof', async t => {
  const f = fixture(t); f.snap.documentId = 'unverified-document';
  await f.install().tick();
  assert.equal(f.state.finishChatDrain.reason, 'social-disabled');
  assert.equal(f.state.roomExit.reason, 'CURRENT_TERMINAL_VIEW_REQUIRED');
  assert.equal(f.calls.quiesced, 0); assert.equal(f.calls.leaves, 0); assert.equal(f.calls.completed, 0);
});

test('disabled chat cannot replace positive anonymous server membership', async t => {
  const f = fixture(t); f.membershipPresent = false;
  await f.install().tick();
  assert.equal(f.state.roomExit.reason, 'INITIAL_SERVER_SEAT_NOT_CONFIRMED');
  assert.equal(f.calls.quiesced, 0); assert.equal(f.calls.leaves, 0); assert.equal(f.calls.completed, 0);
});

test('host or command quiescence refusal still prevents Leave with disabled social', async t => {
  const f = fixture(t); f.onQuiesce = () => { throw Error('HOST_QUIESCENCE_REFUSED'); };
  await f.install().tick();
  assert.equal(f.state.roomExit.reason, 'HOST_QUIESCENCE_REFUSED');
  assert.equal(f.calls.quiesced, 1); assert.equal(f.calls.leaves, 0); assert.equal(f.calls.completed, 0);
});

test('operator pause arriving during quiescence still prevents disabled-chat retirement', async t => {
  const f = fixture(t); f.onQuiesce = () => { f.operatorPaused = true; };
  await f.install().tick();
  assert.equal(f.state.roomExit.reason, 'FINISHED_LEAVE_CONTEXT_CHANGED');
  assert.equal(f.calls.leaves, 0); assert.equal(f.calls.completed, 0);
});

test('disabled chat still requires server absence before the retirement callback', async t => {
  const f = fixture(t); f.confirmAbsence = false;
  await f.install().tick();
  assert.equal(f.state.roomExit.phase, 'leave-unconfirmed');
  assert.equal(f.calls.leaves, 1); assert.equal(f.calls.verified, 1); assert.equal(f.calls.completed, 0);
});

for (const enabled of [true, undefined]) {
  test('installer retains the chat budget for ' + (enabled === true ? 'enabled' : 'unknown') + ' social', async t => {
    const f = fixture(t);
    if (enabled === undefined) delete f.config.social; else f.config.social.enabled = enabled;
    await f.install().tick();
    assert.equal(f.state.finishChatDrain.outcome, 'timed-out');
    assert.equal(f.state.finishChatDrain.reason, 'same-seat-session-unobserved');
    assert.equal(f.state.finishChatDrain.budgetMs, 5); assert.ok(f.calls.reads > 0);
    assert.equal(f.state.roomExit.phase, 'left-confirmed'); assert.equal(f.calls.completed, 1);
  });
}
