import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPublicCardRetention, publicHandWaitingAdjustment } from '../../dist/src/ai/public-card-retention.js';
import { assessPublicCardUse } from '../../dist/src/ai/public-card-opportunity.js';
import { assessPublicHandWindow } from '../../dist/src/ai/public-hand-window.js';

function card(id, fields = {}) {
  const spec = { id, name: id, house: 'logos', kind: 'action', amber: 0, ...fields };
  return { id, definition: id, owner: 0, controller: 0, spec, effective: { house: spec.house, power: spec.power ?? 0, armor: spec.armor ?? 0, keywords: [] } };
}

function view(hand) {
  const p = () => ({ houses: ['logos', 'dis'], amber: 0, forgeAvailable: 0, handCount: 0, deckCount: 12,
    archiveCount: 0, archives: [], discard: [], purged: [], battleline: [], artifacts: [], upgrades: [] });
  return { you: 0, activePlayer: 0, turn: 3, activeHouse: 'logos', phase: 'main',
    turnStep: { step: 3, performed: [0, 0], omega: false }, handOperations: 0, playedThisTurn: 0,
    creaturesPlayedThisTurn: 0, turnUsage: {}, lasting: [], permissions: [], houseRestrictions: [],
    futureHouseRestrictions: [], legalActions: [], pending: null, resolving: [], leaveEffects: [],
    publicCounters: { playedByHouse: {}, creaturesUsed: [] },
    players: [{ ...p(), hand, handCount: hand.length }, p()] };
}

const value = (quality, current, playableNow = true) => ({ score: quality, currentScore: current, playableNow, approximate: true });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function price(o, use, options = {}) {
  const cards = o.players[o.you].hand;
  const w = assessPublicHandWindow(o, cards, use, {
    projected: true, waitingAdjustment: publicHandWaitingAdjustment(o, use), ...options,
  });
  const held = cards.reduce((sum, c) => sum + use(c).score / 2, 0);
  const wait = assessPublicCardRetention(o, cards, use, new Set(w.selectedIds));
  return { ...w, total: held + wait.score + w.score };
}

test('an immediate play between Q/2.5 and Q/2 wins over waiting without a second retention credit', () => {
  const c = card('A'), o = view([c]), use = () => value(10, 4.5);
  const priced = price(o, use);
  assert.deepEqual(priced.selectedIds, ['A']);
  close(priced.total, 4.5);
  close(priced.gainOverWaiting, 0.5);
  close(priced.score, -0.5);
  for (const now of [-1, 3.99, 4]) {
    const held = price(o, () => value(10, now));
    assert.deepEqual(held.selectedIds, []);
    close(held.total, 4);
  }
});

test('the jointly selected play maximizes the whole remaining hand, irrespective of physical order', () => {
  const a = card('A'), b = card('B');
  const use = c => c.id === 'A' ? value(2, 2) : value(10, 5.9);
  for (const hand of [[a, b], [b, a]]) {
    const o = view(hand);
    o.lasting = [{ rule: 'playLimit', appliesTo: 0, turn: o.turn, amount: 1 }];
    const result = price(o, use);
    assert.deepEqual(result.selectedIds, ['B']);
    close(result.total, Math.max(0.8 + 4, 2 + 4, 0.8 + 5.9));
    close(result.score, 0.9);
  }
});

test('a terminal discard prompt and a main window respect the same proven next-call block', () => {
  const c = card('future-blocked'), o = view([c]), use = () => value(12, 4.5);
  o.lasting = [{ rule: 'noMatchingPlay', appliesTo: 0, turn: 5, countFilter: {kind: 'action'}, house: 'logos' }];
  const main = price(o, use);
  close(main.total, 4.5);
  close(main.gainOverWaiting, 0.5);
  const q = card('discard-source', { abilities: { play: [{ kind: 'target', operation: 'discard',
    filter: { side: 'friendly', zone: 'hand' } }] } });
  o.phase = 'choice'; o.resolving = [q];
  o.pending = { actor: 0, kind: 'target', source: q.id, intent: { kind: 'target-operation', operation: 'discard' },
    min: 1, max: 1, selected: [], selectedCount: 0 };
  o.legalActions = [{ id: 'select', action: {kind: 'select', target: c.id} }];
  close(price(o, use, { terminalDiscard: true }).total, main.total);
});

test('a repriced continuation only replaces the original hand fallback, including a negative ledger delta', () => {
  const opener = card('raise', {amber: 1}), tail = card('pay', {playAmberCost: 1});
  const o = view([opener, tail]);
  const use = c => c.id === opener.id ? value(6, 2.5) : value(10, undefined, false);
  const result = price(o, use, {reprice: (_next, c) => {
    assert.equal(c.id, tail.id);
    return value(20, 4.4);
  }});
  assert.deepEqual(result.selectedIds, [opener.id, tail.id]);
  close(result.total, 2.5 + 4.4);
  close(result.gainOverWaiting, 6.9 - (2.4 + 4));
  close(result.score, 6.9 - (3 + 5));
});

test('an incomplete actor hand cannot supply a hypothetical waiting advantage', () => {
  const c = card('A'), o = view([c]), use = () => value(10, 4.5);
  o.players[0].handCount++;
  assert.equal(publicHandWaitingAdjustment(o, use), undefined);
  assert.deepEqual(price(o, use).selectedIds, []);
  close(price(o, use).total, 5);
});

test('a declared null house in an unresolved action-step prompt keeps the same commitment horizon', () => {
  const c = card('A'), o = view([c]);
  o.activeHouse = null; o.phase = 'choice';
  o.pending = { actor: 0, kind: 'target' };
  const use = () => value(10, 4.5);
  close(assessPublicCardRetention(o, [c], use).score, 0);
  close(assessPublicCardRetention(o, [c], use, new Set()).score, -1);
});

test('an unfunded material probe cannot collect the printed payout without its full price', () => {
  const paid = card('toll', { playAmberCost: 2, amber: 3 });
  const o = view([paid]);
  const priceMaterial = () => assessPublicCardUse(o, paid, 0, () => {
    assert.ok(o.players[0].amber >= 2);
    return { score: 3.8, approximate: false, unresolvedValues: false };
  }, { projected: true, requireFundedMaterial: true });
  for (const pool of [0, 1]) {
    o.players[0].amber = pool;
    const unpriced = priceMaterial();
    close(unpriced.score, 1); // positive option floor, no gross icons from an unpayable action
    assert.equal(unpriced.playableNow, false);
    assert.equal(unpriced.currentScore, undefined);
  }
  o.players[0].amber = 2;
  close(priceMaterial().currentScore, 3.8);
  close(priceMaterial().score, 3.8);
});

test('visible artifact tax enters the same payment once; an unmet minimum never enters the spending ledger', () => {
  const artifact = card('priced', {kind: 'artifact', playAmberCost: 1, amber: 2});
  const threshold = card('threshold', {minAmberToPlay: 3, amber: 2});
  const o = view([artifact, threshold]);
  const tax = card('tax', {kind: 'artifact', opponentArtifactPlayTax: 2});
  o.players[1].artifacts = [{ ...tax, owner: 1, controller: 1 }];
  const use = c => assessPublicCardUse(o, c, 0, () => {
    assert.ok(o.players[0].amber >= 3);
    return { score: 5, approximate: false, unresolvedValues: false, currentKeyPriority: true };
  }, { projected: true, keyTiming: true, requireFundedMaterial: true });
  o.players[0].amber = 2;
  close(use(artifact).score, 1);
  assert.ok(use(threshold).score > 1); // The printed icons retain their physical fallback.
  for (const c of [artifact, threshold]) {
    assert.equal(use(c).currentScore, undefined);
    assert.equal(use(c).currentKeyPriority, undefined);
  }
  o.players[0].amber = 3;
  close(use(artifact).currentScore, 5);
  close(use(threshold).currentScore, 5);
  assert.equal(use(threshold).currentKeyPriority, true);
});
