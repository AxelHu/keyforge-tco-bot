import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jsondiffpatch from 'jsondiffpatch';
import { KeytekiManagedSessions } from "../../tools/keyteki-managed-sessions.mjs";
import { KeytekiWireSession, validateKeytekiManagedFullState } from "../../tools/keyteki-wire-session.mjs";

const origin = 'http://127.0.0.1:9988';
const path = origin + '/kf-lab/socket.io';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const patcher = jsondiffpatch.create({
  objectHash: (value, index) => value.uuid || value.id || value.name || index,
});
function full(gameId = 'managed-match') {
  const player = (name) => ({
    name,
    houses: ['brobnar', 'dis', 'untamed'],
    activePlayer: name === 'alpha',
    activeHouse: null,
    phase: 'setup',
    disconnected: false,
    stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 36,
    numArchivesCards: 0,
    buttons: [],
    controls: [],
    deckData: { uuid: 'deck-' + name, name: 'Deck ' + name },
  });
  const raw = {
    id: gameId,
    started: true,
    manualMode: false,
    players: { alpha: player('alpha'), beta: player('beta') },
    messages: [],
  };
  raw.players.alpha.menuTitle = 'Start the Game';
  raw.players.alpha.buttons = [{ text: 'Start the Game', uuid: 'start-prompt' }];
  return raw;
}
function mulligan(before = full()) {
  const raw = structuredClone(before);
  Object.assign(raw.players.alpha, {
    menuTitle: 'Keep Starting Hand?',
    promptTitle: 'Mulligan',
    buttons: [
      { text: 'Keep', arg: 'keep', uuid: 'mulligan-prompt' },
      { text: 'Mulligan', arg: 'mulligan', uuid: 'mulligan-prompt' },
    ],
  });
  return raw;
}
function create(options = {}) {
  const sessions = [];
  const manager = new KeytekiManagedSessions({
    checkpoint: options.checkpoint,
    createSession: ({ origin, playerName }) => {
      const wire = new KeytekiWireSession({
        origin,
        playerName,
        participants: ['alpha', 'beta'],
        strategy: options.strategy ?? { codePolicy: 'tempo-v3' },
      });
      sessions.push(wire);
      return wire;
    },
  });
  return { manager, sessions };
}
function attach(manager, raw = full(), extra = {}) {
  const input = {
    origin,
    playerName: 'alpha',
    gameId: raw.id,
    tabId: 'fixture-tab-0001',
    documentId: 'fixture-document-0001',
    sequence: 1,
    nativeFullState: true,
    newEngineHandshake: true,
    transport: { epoch: 0, path },
    fullState: raw,
    ...extra,
  };
  const state = manager.attach(input);
  return { input, state, context: { ...input, ownerEpoch: state.ownerEpoch } };
}
function issue(manager, context) {
  const draft = manager.offer(context).decision;
  assert.ok(draft);
  assert.equal(draft.sendAuthorized, false);
  const response = manager.authorize({
    ...context,
    sequence: draft.sequence,
    decisionId: draft.decisionId,
    activity: draft.activity,
  });
  assert.equal(response.decision.sendAuthorized, true);
  return response.decision;
}
const code = (expected) => (error) => error.code === expected;

test('an own-turn ready offer survives refresh as the same Node session and fences every old route', async () => {
  const { manager, sessions } = create(),
    first = attach(manager);
  await tick();
  const draft = manager.offer(first.context).decision,
    wire = sessions[0];
  assert.ok(draft);
  assert.equal(wire.sent, undefined);
  const retained = [wire.controller, wire.stream.history, wire.navigation, wire.allocation];
  const next = attach(manager, full(), {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
  });
  await tick();
  assert.equal(sessions.length, 1);
  assert.deepEqual([wire.controller, wire.stream.history, wire.navigation, wire.allocation], retained);
  assert.equal(next.state.nodeSequence, 2);
  assert.equal(next.state.sequence, 1);
  assert.equal(next.state.resumeReady, true);
  for (const method of ['offer', 'detach', 'clear', 'externalActivity', 'getSession'])
    assert.throws(() => manager[method](first.context), code('superseded-owner'), method);
  assert.throws(
    () => manager.authorize({ ...first.context, decisionId: draft.decisionId }),
    code('superseded-owner'),
  );
  assert.throws(() => manager.attach(first.input), code('superseded-owner'));
  const issued = issue(manager, next.context);
  assert.notEqual(issued.decisionId, draft.decisionId);
  assert.equal(issued.nodeSequence, 2);
  assert.equal(wire.stats.commands, 1);
  assert.throws(
    () => manager.authorize({ ...next.context, decisionId: issued.decisionId }),
    code('managed-send-intent-already-issued'),
  );
});

test('a competing live tab cannot steal ownership and a detached owner can be replaced', async () => {
  const { manager } = create(),
    first = attach(manager);
  assert.throws(
    () => attach(manager, full(), { tabId: 'other-tab-0001', documentId: 'other-document-0001' }),
    code('owner-already-attached'),
  );
  manager.detach(first.context);
  const second = attach(manager, full(), { tabId: 'other-tab-0001', documentId: 'other-document-0001' });
  assert.equal(second.state.ownerEpoch, first.state.ownerEpoch + 1);
  assert.equal(second.state.resumeReady, true);
});

test('receipts order same-node-sequence state changes independently of strategy revision', async () => {
  const { manager } = create(),
    first = attach(manager);
  await tick();
  const ready = manager.offer(first.context),
    issued = issue(manager, first.context),
    after = manager.describe(first.context);
  assert.equal(after.ownerEpoch, ready.ownerEpoch);
  assert.equal(after.nodeSequence, ready.nodeSequence);
  assert.equal(after.revision, ready.revision);
  assert.ok(after.receiptOrdinal > ready.receiptOrdinal);
  const queued = manager.confirmSent({ ...first.context, ...issued, queuedCount: 1 });
  assert.equal(queued.nodeSequence, after.nodeSequence);
  assert.ok(queued.receiptOrdinal > after.receiptOrdinal);
  assert.equal(Object.hasOwn(manager.exportCheckpoint().sessions[0], 'receiptOrdinal'), false);
});

test('same-document native reconnect requires detach, new transport epoch and next browser sequence', async () => {
  const { manager, sessions } = create(),
    first = attach(manager);
  const request = { ...first.context, sequence: 2, transport: { epoch: 1, path } };
  assert.throws(() => manager.attach(request), code('managed-same-document-reattach-invalid'));
  manager.detach(first.context);
  assert.throws(
    () => manager.attach({ ...request, transport: { epoch: 0, path } }),
    code('managed-same-document-reattach-invalid'),
  );
  const resumed = manager.attach(request);
  assert.equal(resumed.ownerEpoch, first.state.ownerEpoch + 1);
  assert.equal(resumed.sequence, 2);
  assert.equal(resumed.nodeSequence, 2);
  assert.equal(resumed.transport.epoch, 1);
  assert.equal(sessions.length, 1);
});

test('only a fully queued old ordinary command permits a fresh typed refusal lane during takeover', async () => {
  for (const receiptState of ['queued', 'unconfirmed', 'partial']) {
    const { manager, sessions } = create(),
      raw = full(),
      first = attach(manager, raw);
    await tick();
    const ordinary = issue(manager, first.context);
    if (receiptState === 'queued') manager.confirmSent({ ...first.context, ...ordinary, queuedCount: 1 });
    if (receiptState === 'partial')
      manager.unknown({ ...first.context, ...ordinary, queuedCount: 0, reason: 'partial-send' });
    const overlay = structuredClone(raw);
    Object.assign(overlay.players.alpha, {
      selectCard: false,
      selectOrder: false,
      controls: [],
      menuTitle: { text: '{{player}} requests to enable manual mode. Allow?', values: { player: 'beta' } },
      buttons: [
        { command: 'menuButton', text: 'Yes', arg: 'yes', uuid: 'managed-manual-prompt' },
        { command: 'menuButton', text: 'No', arg: 'no', uuid: 'managed-manual-prompt' },
      ],
    });
    const second = attach(manager, overlay, {
      documentId: 'fixture-document-0002',
      previousOwnerEpoch: first.state.ownerEpoch,
    });
    await tick();
    const offered = manager.offer(second.context);
    assert.equal(offered.resumeReady, false, receiptState);
    assert.equal(offered.administrativeOnly, receiptState === 'queued', receiptState);
    if (receiptState !== 'queued') {
      assert.equal(offered.decision, null, receiptState);
      assert.throws(
        () => manager.authorize({ ...second.context, decisionId: sessions[0].offer().decisionId }),
        code('managed-send-lane-held'),
      );
      continue;
    }
    const refusal = issue(manager, second.context);
    assert.match(refusal.decisionId, /^administrative:/);
    assert.deepEqual(refusal.command.args, ['no', 'managed-manual-prompt']);
    assert.equal(manager.describe(second.context).pendingDeliveries.length, 2);
    manager.confirmSent({ ...second.context, ...refusal, queuedCount: 1 });
    const refused = structuredClone(raw);
    refused.messages.push({
      id: 'managed-refusal-result',
      activePlayer: 'beta',
      message: {
        alert: {
          type: 'info',
          message: [{ name: 'alpha', argType: 'nonAvatarPlayer' }, ' disallows enabling manual mode'],
        },
      },
    });
    manager.receive({ ...second.context, sequence: 2, delta: patcher.diff(overlay, refused) });
    await tick();
    assert.equal(sessions[0].stats.acknowledged, 0);
    assert.equal(sessions[0].administrative.stats.refusalsConfirmed, 1);
    assert.equal(manager.offer(second.context).decision, null);
    // The refusal's ledger may still be in browser storage while another old
    // delivery remains pending. Its already observed receipt must not block attach.
    const third = attach(manager, refused, {
      documentId: 'fixture-document-0003',
      previousOwnerEpoch: second.state.ownerEpoch,
      deliveryLedger: { ...refusal, stage: 'queued', queuedCount: 1 },
    });
    assert.equal(third.state.resumeReady, false);
    const progressed = mulligan(refused);
    manager.receive({ ...third.context, sequence: 2, delta: patcher.diff(refused, progressed) });
    await tick();
    assert.equal(sessions[0].stats.acknowledged, 1);
    assert.equal(manager.describe(third.context).sendPending, null);
    assert.ok(manager.offer(third.context).decision);
  }
});

test('identical full views never turn an authorized command into a known-unsent command', async () => {
  const { manager, sessions } = create(),
    first = attach(manager);
  await tick();
  const issued = issue(manager, first.context);
  const second = attach(manager, full(), {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
  });
  await tick();
  assert.equal(second.state.status, 'awaiting-send-outcome');
  assert.equal(second.state.resumeReady, false);
  assert.equal(manager.offer(second.context).decision, null);
  assert.equal(sessions[0].stats.acknowledged, 0);
  assert.equal(sessions[0].stats.commands, 1);
  assert.equal(second.state.sendPending.decisionId, issued.decisionId);
  assert.throws(
    () => manager.confirmSent({ ...first.context, ...issued, queuedCount: 1 }),
    code('superseded-owner'),
  );
});

test('a complete exact queued ledger plus fresh relevant progress settles across a lost send receipt', async () => {
  const { manager, sessions } = create(),
    raw = full(),
    first = attach(manager, raw);
  await tick();
  const issued = issue(manager, first.context);
  manager.unknown({ ...first.context, ...issued, queuedCount: 1, reason: 'sent-http-response-lost' });
  assert.equal(sessions[0].blocked, false);
  const second = attach(manager, mulligan(raw), {
    documentId: 'fixture-document-0002',
    deliveryLedger: { ...issued, stage: 'queued', queuedCount: 1 },
  });
  await tick();
  assert.equal(second.state.resumeReady, true);
  assert.equal(second.state.sendPending, null);
  assert.equal(sessions[0].stats.acknowledged, 1);
  assert.equal(sessions[0].stats.queuedCommands, 1);
  assert.ok(manager.offer(second.context).decision);
});

test('queued receipt alone and unrelated updates cannot settle a previous owner command', async () => {
  const { manager, sessions } = create(),
    raw = full(),
    first = attach(manager, raw);
  await tick();
  const issued = issue(manager, first.context);
  const unrelated = structuredClone(raw);
  unrelated.players.beta.stats.amber++;
  const second = attach(manager, unrelated, {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
    deliveryLedger: { ...issued, stage: 'queued', queuedCount: 1 },
  });
  assert.equal(second.state.status, 'awaiting-send-outcome');
  assert.equal(sessions[0].stats.acknowledged, 0);
  assert.equal(manager.offer(second.context).decision, null);
  const progressed = mulligan(unrelated);
  const state = manager.receive({
    ...second.context,
    sequence: 2,
    delta: patcher.diff(unrelated, progressed),
  });
  await tick();
  assert.equal(state.resumeReady, true);
  assert.equal(state.sendPending, null);
  assert.equal(sessions[0].stats.acknowledged, 1);
});

test('partial sending ledger remains held and cannot be promoted by a forged ticket', async () => {
  const { manager, sessions } = create(),
    first = attach(manager);
  await tick();
  const issued = issue(manager, first.context);
  assert.throws(
    () =>
      attach(manager, full(), {
        documentId: 'fixture-document-0002',
        previousOwnerEpoch: first.state.ownerEpoch,
        deliveryLedger: { ...issued, sendTicket: 'wrong', stage: 'queued', queuedCount: 1 },
      }),
    code('managed-delivery-receipt-mismatch'),
  );
  assert.equal(manager.describe(first.context).ownerEpoch, first.state.ownerEpoch);
  const second = attach(manager, full(), {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
    deliveryLedger: { ...issued, stage: 'sending', queuedCount: 0 },
  });
  assert.equal(second.state.status, 'awaiting-send-outcome');
  assert.equal(second.state.sendPending.confirmed, false);
  assert.equal(sessions[0].stats.acknowledged, 0);
});

test('a repeated exact receipt or uncertain-response report cannot poison an already observed command', async () => {
  const { manager, sessions } = create(),
    raw = full(),
    first = attach(manager, raw);
  await tick();
  const issued = issue(manager, first.context),
    receipt = { ...first.context, ...issued, queuedCount: 1 };
  manager.confirmSent(receipt);
  manager.confirmSent(receipt);
  manager.receive({ ...first.context, sequence: 2, delta: patcher.diff(raw, mulligan(raw)) });
  assert.equal(manager.confirmSent(receipt).sendPending, null);
  assert.equal(manager.unknown(receipt).sendPending, null);
  assert.equal(sessions[0].blocked, false);
  assert.equal(sessions[0].stats.acknowledged, 1);
  assert.equal(sessions[0].stats.queuedCommands, 1);
});

test('held model work is canceled on non-idle attach and its late reply does not overwrite the fresh choice', async () => {
  let release;
  const histories = [];
  const { manager, sessions } = create({
    strategy: {
      codePolicy: 'tempo-v3',
      mode: 'model-all',
      model: {
        id: 'held-managed-model',
        choose(_content, profile) {
          histories.push(profile.history.length);
          if (histories.length === 1)
            return new Promise((resolve) => {
              release = resolve;
            });
          return Promise.resolve({ status: 'accepted', choice: 'a0', plan: 'fresh view', reason: null });
        },
      },
    },
  });
  const raw = mulligan(),
    first = attach(manager, raw);
  assert.equal(manager.describe(first.context).status, 'thinking');
  const next = attach(manager, raw, {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
  });
  await tick();
  const fresh = manager.offer(next.context).decision;
  assert.ok(fresh);
  release({ status: 'accepted', choice: 'a1', plan: 'old view', reason: null });
  await tick();
  assert.equal(manager.offer(next.context).decision.decisionId, fresh.decisionId);
  assert.deepEqual(histories, [0, 0]);
  assert.equal(sessions[0].stats.acknowledged, 0);
  assert.equal(sessions[0].preparingTasks, 0);
});

test('fresh full validation rejects identity/deck changes before replacing owner and marks missing history', async () => {
  const { manager, sessions } = create(),
    raw = full();
  raw.messages = [{ id: 'before', message: ['start'] }];
  const first = attach(manager, raw),
    changed = structuredClone(raw);
  changed.players.alpha.deckData.uuid = 'wrong-deck';
  assert.throws(
    () =>
      attach(manager, changed, {
        documentId: 'fixture-document-0002',
        previousOwnerEpoch: first.state.ownerEpoch,
      }),
    /deck-identity-changed/,
  );
  assert.equal(manager.describe(first.context).ownerEpoch, first.state.ownerEpoch);
  changed.players.alpha.deckData.uuid = raw.players.alpha.deckData.uuid;
  changed.messages = [{ id: 'after-gap', message: ['later'] }];
  const second = attach(manager, changed, {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
  });
  await tick();
  assert.equal(second.state.resumeReady, true);
  assert.equal(second.state.resumeReceipt.publicWindowContinuous, false);
  assert.equal(sessions[0].stream.history.snapshot().currentTurn, null);
  assert.ok(manager.offer(second.context).decision);
  assert.throws(
    () =>
      validateKeytekiManagedFullState(
        raw,
        { ...changed, manualMode: true },
        { playerName: 'alpha', participants: ['alpha', 'beta'] },
      ),
    /identity-invalid/,
  );
});

test('minimal restart checkpoint retains unknown authorized sends without storing raw or model history', async () => {
  const { manager } = create(),
    first = attach(manager);
  await tick();
  issue(manager, first.context);
  const checkpoint = manager.exportCheckpoint(),
    serialized = JSON.stringify(checkpoint);
  assert.equal(serialized.includes('cardPiles'), false);
  assert.equal(serialized.includes('memory'), false);
  const restored = create({ checkpoint });
  const next = attach(restored.manager, full(), { documentId: 'fixture-document-0002' });
  await tick();
  assert.equal(next.state.status, 'send-outcome-unknown');
  assert.equal(next.state.resumeReady, false);
  assert.ok(next.state.sendPending);
  assert.equal(restored.manager.offer(next.context).decision, null);
  assert.equal(restored.manager.exportCheckpoint().sessions[0].pendingDeliveries.length, 1);
});

test('restart cannot clear a fatal external-activity stop when there was no issued command', async () => {
  const { manager } = create(),
    first = attach(manager);
  manager.externalActivity({ ...first.context, epoch: 1, reason: 'external-manual-command' });
  const checkpoint = manager.exportCheckpoint();
  assert.equal(checkpoint.sessions[0].pendingDeliveries.length, 0);
  assert.equal(checkpoint.sessions[0].stopped, true);
  assert.equal(checkpoint.sessions[0].stopReason, 'external-manual-command');
  const restored = create({ checkpoint });
  const next = attach(restored.manager, full(), { documentId: 'fixture-document-0002' });
  await tick();
  assert.equal(next.state.status, 'send-outcome-unknown');
  assert.equal(next.state.error, 'external-manual-command');
  assert.equal(next.state.resumeReady, false);
  assert.equal(next.state.sendPending, null);
  assert.equal(restored.manager.offer(next.context).decision, null);
  assert.equal(restored.manager.exportCheckpoint().sessions[0].stopped, true);
});
// A historical-recording test is intentionally not part of this synthetic public suite.


test('clear releases account ownership without inventing a winner and fences the old match from the next one', async () => {
  const { manager } = create(),
    first = attach(manager);
  await tick();
  issue(manager, first.context);
  const released = manager.clear(first.context);
  assert.equal(released.lifecycle, 'released');
  assert.notEqual(released.status, 'finished');
  const next = attach(manager, full('managed-next-game'), { documentId: 'fixture-document-0002' });
  await tick();
  assert.equal(next.state.resumeReady, true);
  assert.equal(manager.summary().sessions.length, 2);
  assert.equal(manager.offer(first.context).decision, null);
  assert.throws(
    () => attach(manager, full(), { documentId: 'fixture-document-0003' }),
    code('player-has-active-game'),
  );
  const checkpoint = manager.exportCheckpoint();
  assert.equal(checkpoint.sessions[0].released, true);
  assert.equal(checkpoint.sessions[0].finished, false);
  assert.equal(checkpoint.sessions[0].pendingDeliveries.length, 1);
});

test('receipt-only proof reads an exact observed delivery without confirming or acknowledging it again', async () => {
  for (const effectFirst of [false, true]) {
    const { manager, sessions } = create(),
      raw = full(),
      first = attach(manager, raw);
    await tick();
    const issued = issue(manager, first.context),
      receipt = { ...first.context, ...issued, queuedCount: 1 };
    const effect = () =>
      manager.receive({ ...first.context, sequence: 2, delta: patcher.diff(raw, mulligan(raw)) });
    if (effectFirst) effect();
    manager.confirmSent(receipt);
    if (!effectFirst) effect();
    const before = structuredClone(sessions[0].stats);
    const proof = manager.confirmSent({ ...receipt, receiptOnly: true });
    assert.equal(proof.sendPending, null);
    assert.deepEqual(proof.pendingDeliveries, []);
    assert.deepEqual(proof.observedDelivery, {
      stage: 'observed',
      decisionId: issued.decisionId,
      sendTicket: issued.sendTicket,
      sequence: issued.sequence,
      documentId: first.context.documentId,
      ownerEpoch: first.context.ownerEpoch,
      queuedCount: 1,
    });
    assert.deepEqual(sessions[0].stats, before);
    assert.equal(sessions[0].stats.acknowledged, 1);
    assert.equal(sessions[0].stats.queuedCommands, 1);
    assert.ok(manager.confirmSent({ ...receipt, receiptOnly: true }).receiptOrdinal > proof.receiptOrdinal);
    assert.deepEqual(sessions[0].stats, before);
  }
});

test('receipt-only proof never confirms an authorized, queued or unknown delivery without its observed effect', async () => {
  for (const stage of ['authorized', 'queued', 'unknown']) {
    const { manager, sessions } = create(),
      first = attach(manager);
    await tick();
    const issued = issue(manager, first.context),
      receipt = { ...first.context, ...issued, queuedCount: 1 };
    if (stage !== 'authorized') manager.confirmSent(receipt);
    if (stage === 'unknown') manager.unknown(receipt);
    const before = structuredClone(sessions[0].stats),
      pending = manager.describe(first.context).sendPending;
    assert.throws(
      () => manager.confirmSent({ ...receipt, receiptOnly: true }),
      code('managed-observed-receipt-unavailable'),
    );
    assert.deepEqual(sessions[0].stats, before);
    assert.deepEqual(manager.describe(first.context).sendPending, pending);
    assert.equal(sessions[0].stats.acknowledged, 0);
  }
});

test('observed proof rejects wrong ticket, original sequence, count, plan and owner without weakening normal receipts', async () => {
  const { manager, sessions } = create(),
    raw = full(),
    first = attach(manager, raw);
  await tick();
  const issued = issue(manager, first.context),
    receipt = { ...first.context, ...issued, queuedCount: 1, receiptOnly: true };
  manager.confirmSent({ ...receipt, receiptOnly: false });
  manager.receive({ ...first.context, sequence: 2, delta: patcher.diff(raw, mulligan(raw)) });
  const before = structuredClone(sessions[0].stats);
  for (const patch of [
    { sendTicket: 'wrong-ticket' },
    { sequence: 999 },
    { queuedCount: 0 },
    { queuedCount: 2 },
    { planId: 'unexpected-plan' },
    { decisionId: 'missing-decision' },
  ])
    assert.throws(
      () => manager.confirmSent({ ...receipt, ...patch }),
      code('managed-observed-receipt-unavailable'),
    );
  assert.throws(
    () => manager.confirmSent({ ...receipt, ownerEpoch: receipt.ownerEpoch + 1 }),
    code('superseded-owner'),
  );
  assert.throws(
    () => manager.confirmSent({ ...receipt, documentId: 'other-document' }),
    code('superseded-owner'),
  );
  assert.deepEqual(sessions[0].stats, before);
  const second = attach(manager, mulligan(raw), {
    documentId: 'fixture-document-0002',
    previousOwnerEpoch: first.state.ownerEpoch,
  });
  const afterReattach = structuredClone(sessions[0].stats);
  assert.throws(
    () =>
      manager.confirmSent({
        ...receipt,
        documentId: second.context.documentId,
        ownerEpoch: second.context.ownerEpoch,
      }),
    code('managed-observed-receipt-unavailable'),
  );
  assert.deepEqual(sessions[0].stats, afterReattach);
  for (const key of ['commands', 'queuedCommands', 'acknowledged'])
    assert.equal(sessions[0].stats[key], before[key]);
});

test('neither a restored empty checkpoint nor an evicted closed receipt substitutes for exact observed proof', async () => {
  const { manager } = create(),
    raw = full(),
    first = attach(manager, raw);
  await tick();
  const issued = issue(manager, first.context),
    receipt = { ...first.context, ...issued, queuedCount: 1, receiptOnly: true };
  manager.confirmSent({ ...receipt, receiptOnly: false });
  manager.receive({ ...first.context, sequence: 2, delta: patcher.diff(raw, mulligan(raw)) });
  const restored = create({ checkpoint: manager.exportCheckpoint() }).manager;
  const fresh = attach(restored, mulligan(raw), { documentId: 'fixture-document-restarted' });
  assert.equal(fresh.state.sendPending, null);
  assert.throws(
    () =>
      restored.confirmSent({
        ...receipt,
        documentId: fresh.context.documentId,
        ownerEpoch: fresh.context.ownerEpoch,
      }),
    code('managed-observed-receipt-unavailable'),
  );
  manager.record(first.context).closedDeliveries.clear();
  assert.equal(manager.describe(first.context).sendPending, null);
  assert.throws(() => manager.confirmSent(receipt), code('managed-observed-receipt-unavailable'));
});
