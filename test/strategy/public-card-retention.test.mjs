import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPublicCardRetention } from '../../dist/src/ai/public-card-retention.js';
import { assessLifecycleRefillDelta } from '../../dist/src/ai/card-lifecycle-value.js';
import { assessPublicHandWindow, publicHandCardPlayable } from '../../dist/src/ai/public-hand-window.js';

function card(id, house = 'dis', owner = 0, fields = {}) {
  return { id, owner, controller: owner, definition: id, effective: { house }, spec: { id, name: id,
    house, kind: 'action', amber: 0 }, ...fields };
}
function observation(hand, you = 0) {
  const common = { houses: ['dis', 'logos', 'mars'], amber: 0, chains: 0, handCount: 0, deckCount: 12,
    discard: [], archives: [], archiveCount: 0, battleline: [], artifacts: [], upgrades: [] };
  const me = { ...common, hand, handCount: hand.length };
  const foe = { ...common, get hand() { throw Error('private opposing hand read'); },
    get archives() { throw Error('private opposing archives read'); },
    get deckList() { throw Error('deck identities read'); } };
  return { you, activePlayer: you, turn: 4, activeHouse: 'logos', phase: 'main', handOperations: 0,
    turnStep: { step: 3, performed: [0, 0], omega: false }, turnUsage: {}, playedThisTurn: 0,
    players: you === 0 ? [me, foe] : [foe, me], houseRestrictions: [], futureHouseRestrictions: [],
    lasting: [], permissions: [], legalActions: [], pending: null };
}
const material = (score, playableNow = false) => () => ({ score, playableNow, approximate: true });
const score = (o, cards = o.players[o.you].hand, use = material(12), excluded) =>
  assessPublicCardRetention(o, cards, use, excluded).score;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' vs ' + expected);
const restriction = (o, house, turn, rule = 'cannotHouse') => ({ source: 'public',
  player: o.you, house, turn, rule });

test('the same forced discard has different timing on own and opposing turns, from either seat', () => {
  for (const you of [0, 1]) {
    const active = card('active', 'logos', you), other = card('off-house', 'dis', you);
    const o = observation([active, other], you);
    o.phase = 'choice';
    o.pending = { actor: you, kind: 'target' };
    close(score(o, [active]), 0);
    close(score(o, [other]), 12 / 2.5 - 6);
    const enemyTurn = { ...o, activePlayer: 1 - you };
    close(score(enemyTurn, [active, other]), 0);
    close(score({ ...o, phase: 'forge', activeHouse: null }, [active, other]), 0);
    close(score({ ...o, turnStep: { ...o.turnStep, step: 5 } }, [active]), 12 / 2.5 - 6);
  }
});

test('a pending prompt preserves only a possible active route under observed amber and shared caps', () => {
  const ordinary = card('ordinary', 'logos');
  const costly = card('costly', 'logos');
  costly.spec.minAmberToPlay = 6;
  const o = observation([ordinary, costly]);
  o.phase = 'choice';
  o.pending = { actor: 0, kind: 'target' };
  close(score(o, [ordinary]), 0);
  close(score(o, [costly]), -1.2);
  assert.equal(o.players[0].amber, 0);
  o.lasting = [{ rule: 'playLimit', appliesTo: 0, turn: 4, amount: 0 }];
  close(score(o, [ordinary]), -1.2);
  o.lasting = [];
  o.turnStep.omega = true;
  close(score(o, [ordinary]), -1.2);
});

test('a legal active-house play with a negative present return waits when joint allocation is known', () => {
  const c = card('costlier-than-return', 'logos'), o = observation([c]);
  const options = { projected: true };
  const use = () => ({ score: 12, currentScore: -3, playableNow: true, approximate: true });
  assert.equal(publicHandCardPlayable(o, c, options), true);
  const current = assessPublicHandWindow(o, [c], use, options);
  assert.deepEqual(current.selectedIds, []);
  close(score(o, [c], use, new Set(current.selectedIds)), -1.2);
  // An unresolved prompt has no joint allocation, and its return to main may still open this route.
  o.phase = 'choice';
  o.pending = { actor: 0, kind: 'target' };
  close(score(o, [c], material(12, false), undefined), 0);
});

test('one shared remaining play preserves just its allocation among two individually legal plays', () => {
  const better = card('better', 'logos'), displaced = card('displaced', 'logos');
  const hand = [displaced, better], o = observation(hand);
  o.lasting = [{ rule: 'playLimit', appliesTo: 0, turn: o.turn, amount: 1 }];
  const options = { projected: true };
  const use = (c) => ({ score: 12, currentScore: c.id === better.id ? 11 : 8, playableNow: true, approximate: true });
  assert.ok(hand.every((c) => publicHandCardPlayable(o, c, options)));
  const current = assessPublicHandWindow(o, hand, use, options);
  assert.deepEqual(current.selectedIds, [better.id]);
  const allocated = new Set(current.selectedIds);
  close(score(o, [better], use, allocated), 0);
  close(score(o, [displaced], use, allocated), -1.2);
  close(score(o, hand, use, allocated), -1.2);
});

test('only next-own-call public restrictions delay future access, with one best ordinary house', () => {
  const a = card('a'), dual = card('dual', 'dis', 0, { effective: { house: 'dis', houses: ['dis', 'mars'] } });
  const o = observation([a, dual]);
  o.futureHouseRestrictions = [restriction(o, 'mars', 6, 'mustHouse')];
  close(score(o, [a]), -2);
  close(score(o, [dual]), -1.2);
  o.futureHouseRestrictions[0].turn = 5;
  close(score(o, [a]), -1.2);
  o.activePlayer = 1;
  close(score(o, [a]), -2);
  close(score(o, [dual]), 0);
  o.futureHouseRestrictions[0].player = 1;
  close(score(o, [a]), 0);
  o.houseRestrictions = [restriction(o, 'dis', null)];
  close(score(o, [a]), -2);
  o.houseRestrictions = [restriction(o, 'dis', null), restriction(o, 'dis', 5, 'mustHouse')];
  close(score(o, [a]), 0);
});

test('actual own house menu, preceding house and lasting play bans are scoped to the coming call', () => {
  const a = card('a'), o = observation([a]);
  o.phase = 'house';
  o.activeHouse = null;
  o.legalActions = [{ action: { kind: 'house', house: 'mars' } }];
  close(score(o), -2);
  o.phase = 'main';
  o.activeHouse = 'dis';
  const lock = card('lock', 'logos', 1);
  lock.spec.forbidsPreviousHouse = true;
  o.players[1].artifacts = [lock];
  o.previousChosenHouses = ['mars', 'logos'];
  close(score(o), -2);
  o.players[1].artifacts = [];
  o.activePlayer = 1;
  o.lasting = [{ rule: 'noActions', appliesTo: 0, begins: 5, turn: 5 }];
  close(score(o), -2);
  o.lasting[0].expiresAtTurnStart = { player: 0, turn: 5 };
  close(score(o), 0);
  o.lasting[0] = { rule: 'noActions', appliesTo: 0, turn: 4 };
  close(score(o), 0);
});

test('allocated plays, current material defense, unknown input and non-hand physical cards add no discount', () => {
  const defense = card('defense', 'logos'), a = card('off'), o = observation([a, defense]);
  close(score(o, [defense], material(12, true)), 0);
  close(score(o, [a], () => { throw Error('allocated card repriced'); }, new Set([a.id])), 0);
  close(score(o, [a, a]), -1.2);
  close(score(o, [a], material(5000)), 0);
  close(score(o, [a], material(NaN)), 0);
  close(score(o, [a], () => undefined), 0);
  o.players[0].archives = [card('archive')];
  close(score(o, o.players[0].archives), 0);
  close(score(o, [card('other-side', 'dis', 1)]), 0);
  for (const fields of [{ form: 'upgrade' }, { copiedHouse: 'dis' }, { physicalParts: [] },
    { giganticBonusIcons: [] }, { tokenCreature: { reference: 'unknown' } }, { definition: 'reverse' }]) {
    const unknown = { ...a, ...fields };
    close(score(observation([unknown])), 0);
  }
  o.publicStateCoverage = { effectsComplete: false, turnHistoryComplete: true };
  close(score(o), 0);
  o.publicStateCoverage = { effectsComplete: true, turnHistoryComplete: false };
  close(score(o), 0);
  delete o.publicStateCoverage;
  o.players[0].handCount++;
  close(score(o), 0);
});

test('normal refill alone settles throughput, with no duplicate quality credit at either endpoint', () => {
  const a = card('a'), o = observation([a]);
  const before = [{ hand: 1, deck: 12, discard: 0 }, { hand: 0, deck: 0, discard: 0 }];
  const afterDiscard = [{ hand: 0, deck: 12, discard: 1 }, before[1]];
  const slot = assessLifecycleRefillDelta(o, before, afterDiscard).score;
  close(slot, 0.9);
  // At 12 cards and a six-card target, ordinary discard access is Q/5.
  const discard = (q) => slot + q / 5 - q / 2 - score(o, [a], material(q));
  assert.ok(discard(1) > 0);
  assert.ok(discard(12) < 0);
  const archiveSlot = (deck) => assessLifecycleRefillDelta(o,
    [{ ...before[0], deck }, before[1]], [{ hand: 0, deck, discard: 0 }, before[1]]).score;
  close(archiveSlot(0), 0);
  close(archiveSlot(5), 0);
  close(archiveSlot(6), 0.9);
  const old = score(o);
  o.players[0].deckCount = 0;
  close(score(o), old); // No second draw/supply term inside the time discount.
  o.players[0].hand = [];
  o.players[0].handCount = 0;
  close(score(o, [a]), 0);
  const release = score(o, [a]) - old;
  o.players[0].hand.push(a);
  o.players[0].handCount++;
  close(release + (score(o, [a]) - 0), 0);
});
