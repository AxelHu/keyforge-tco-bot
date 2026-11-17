import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAlgorithm } from '../../dist/src/ai/algorithm-policies.js';
import { rankCardAwareV3 } from '../../dist/src/ai/card-aware-v3-policy.js';
import { rankStyleUpgrade } from '../../dist/src/ai/style-policy-upgrades.js';
import { assessPublicCardUse } from '../../dist/src/ai/public-card-opportunity.js';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
const current = { contextualEffects: true, netResources: true, physicalBonuses: true,
  publicCardLifecycle: true, publicDestroyedRefunds: true, publicDestructionPayments: true,
  publicIntegerThirds: true, publicHouseChoices: true, publicAmberIconBindings: true };
function card(id, extra = {}, owner = 0) {
  const spec = { id, name: id, kind: 'action', house: 'logos', amber: 0, power: 0, armor: 0,
    traits: [], summary: 'Display only', abilities: {}, ...extra };
  return { id, definition: spec.id, owner, controller: owner, spec, ready: false,
    damage: 0, armorUsed: 0, elusiveUsed: false, captured: 0, stunned: false, powerCounters: 0,
    attachedTo: null, enteredController: owner, foreignArchiveHolder: null, usesThisTurn: 0,
    effective: { house: spec.house, power: spec.power, armor: spec.armor, keywords: [], assault: 0, hazardous: 0 } };
}
function printed(id, definition, owner = 0) { return card(id, structuredClone(ALL_DEFINITIONS[definition]), owner); }
function observation() {
  const player = () => ({ houses: ['logos', 'untamed', 'brobnar'], amber: 0, keys: [], keyCost: 6,
    chains: 0, skipForgeTurn: null, lastForgedTurn: null, forgedOn: {}, forgeAvailable: 0,
    deckList: [], deckCount: 30, handCount: 0, archiveCount: 0, battleline: [], artifacts: [],
    upgrades: [], purged: [], discard: [] });
  return { schemaVersion: 2, engineVersion: 'public-lifecycle-fixture', rulesVersion: '18.4',
    catalogVersion: 'public-static-knowledge', revision: 1, turn: 3, you: 0, firstPlayer: 0,
    turnUsage: {}, handOperations: 0, playedThisTurn: 0, creaturesPlayedThisTurn: 0,
    activePlayer: 0, phase: 'main', activeHouse: 'logos', players: [{ ...player(), hand: [], archives: [] }, player()],
    legalActions: [], resolving: [], promptCards: [], underCards: [], spanglerCards: [], controlLayers: [],
    nextReady: [], leaveEffects: [], publicCounters: { playedByHouse: {}, discardedHouses: [[], []],
      creaturesPlayedLastTurn: [0, 0], enemyFightDeaths: 0, creaturesUsed: [] }, pending: null,
    lasting: [], knowledge: [], permissions: [], cardEffects: [], houseRestrictions: [], futureHouseRestrictions: [],
    turnStep: { step: 3, performed: [0, 0], omega: false }, winner: null };
}
function play(effects, held = []) {
  const o = observation(), source = card('source', { abilities: { play: effects } });
  o.players[0].hand = [source, ...held]; o.players[0].handCount = 1 + held.length;
  o.legalActions = [{ id: 'play', action: { kind: 'play', card: source.id } }, { id: 'end', action: { kind: 'endTurn' } }];
  return o;
}
function assess(o, id = 'play') { const old = structuredClone(o); const r = assessAlgorithm(o, id, 'tactical-v1', current);
  assert.deepEqual(o, old); return r; }
function prompt(operation, held, discard = [], source = card('source', { abilities: {
  play: [{ kind: 'target', operation, filter: { zone: ['hand', 'discard'] } }] } })) {
  const o = observation(); o.phase = 'choice'; o.resolving = [source];
  o.players[0].hand = held; o.players[0].handCount = held.length; o.players[0].discard = discard;
  o.pending = { kind: 'target', source: source.id, actor: 0, amount: 0, reward: 0, min: 1, max: 1,
    selected: [], selectedCount: 0, intent: { kind: 'target-operation', operation } };
  o.legalActions = [...held, ...discard].map((c) => ({ id: c.id, action: { kind: 'select', target: c.id } }));
  return o;
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('whole-candidate refill counts batch hand seven to five as one slot, including bound continuation', () => {
  const held = Array.from({ length: 7 }, (_, i) => card(`held-${i}`, { house: 'dis' }));
  for (const amount of [1, 2]) {
    const effects = [{ kind: 'chooseCards', filter: { side: 'friendly', zone: 'hand' }, bind: 'chosen', max: amount,
      then: [{ kind: 'bound', key: 'chosen', operation: 'archive' }] }];
    const o = play(effects, held), blank = play([], held);
    close(assess(o).score - assess(blank).score, amount === 1 ? 0 : 0.9);
  }
});

test('Labwork current prompt retains a strong same-house action before an off-house card in both final families', () => {
  const active = card('a-strong', { abilities: { play: [{ kind: 'gain', amount: 3 }] } });
  const later = card('z-later', { kind: 'creature', power: 8, house: 'brobnar' });
  const o = prompt('archive', [active, later], [], printed('lab', 'labwork'));
  o.pending.kind = 'archive'; delete o.pending.min; delete o.pending.max;
  for (const rank of [rankCardAwareV3(o), rankStyleUpgrade(o, 'tactical-style-engine-v3')]) {
    assert.equal(rank[0].actionId, later.id);
    assert.ok(rank.find((r) => r.actionId === active.id).score < rank.find((r) => r.actionId === later.id).score);
  }
});

test('post-refill endTurn archive does not claim another normal refill slot or immediate play', () => {
  const c = card('held', { abilities: { play: [{ kind: 'gain', amount: 3 }] } });
  const o = prompt('archive', [c]); o.turnStep.step = 5;
  o.pending.intent.selection = { ability: 'endTurn', path: [0] };
  const r = assess(o, c.id); close(r.score, 0);
  assert.ok(!r.reasons.some((x) => x.includes('normal current play opportunity')));
  assert.ok(!r.reasons.some((x) => x.includes('refill displacement settled')));
});

test('discard and purge preserve different reuse options, without granting a discard-pile hand slot', () => {
  const c = card('valuable', { abilities: { play: [{ kind: 'gain', amount: 3 }] } });
  const d = assess(prompt('discard', [c]), c.id), p = assess(prompt('purge', [c]), c.id);
  assert.ok(d.score > p.score);
  const pile = assess(prompt('purge', [], [c]), c.id);
  assert.ok(pile.score < 0); assert.ok(!pile.reasons.some((x) => x.includes('refill displacement settled')));
});

test('native discard resolves actual Scrap effects with the discarded source, without Play icons', () => {
  const c = card('scrap', { amber: 2, abilities: { scrap: [{ kind: 'gain', amount: 2 },
    { kind: 'gain', amount: { count: { side: 'friendly', zone: 'discard', sourceOnly: true } } }] } });
  const o = observation(); o.players[0].hand = [c]; o.players[0].handCount = 1;
  o.legalActions = [{ id: 'discard', action: { kind: 'discard', card: c.id } }];
  const r = assess(o, 'discard'); assert.deepEqual(r.estimatedAmber, [3, 0]);
  assert.ok(r.reasons.some((x) => x.includes('resolves its public Scrap')));
  const archive = assess(prompt('archive', [c]), c.id); assert.deepEqual(archive.estimatedAmber, [0, 0]);
  const mill = assess(prompt('discard', [], [c]), c.id); assert.deepEqual(mill.estimatedAmber, [0, 0]);
  const inactive = prompt('discard', [c]); inactive.activePlayer = 1;
  assert.deepEqual(assess(inactive, c.id).estimatedAmber, [0, 0]);
});

test('lifecycle moves refresh Haunted across both nine-to-ten and ten-to-nine thresholds', () => {
  const held = card('held', { house: 'dis' });
  const o = play([{ kind: 'target', operation: 'discard', filter: { zone: 'hand', side: 'friendly', definition: held.definition } },
    { kind: 'gain', amount: { haunted: true } }], [held]);
  o.players[0].discard = Array.from({ length: 9 }, (_, i) => card(`old-${i}`)); o.haunted = [false, false];
  assert.deepEqual(assess(o).estimatedAmber, [1, 0]);
  const r = play([{ kind: 'target', operation: 'returnHand', filter: { zone: 'discard', side: 'friendly', definition: held.definition } },
    { kind: 'gain', amount: { haunted: true } }]);
  r.players[0].discard = [held, ...o.players[0].discard]; r.haunted = [true, false];
  assert.deepEqual(assess(r).estimatedAmber, [0, 0]);
});

test('foreign archive departure projects owner hand while failed purge does not pay an affected continuation', () => {
  const foreign = card('foreign', {}, 1); foreign.foreignArchiveHolder = 0;
  const o = play([{ kind: 'all', operation: 'purge', filter: { side: 'friendly', zone: 'archives' },
    after: { when: 'affected', effects: [{ kind: 'gain', amount: 99 }] } },
    { kind: 'gain', amount: { metric: 'handSize', side: 'opponent' } }]);
  o.players[0].archives = [foreign]; o.players[0].archiveCount = 1;
  assert.deepEqual(assess(o).estimatedAmber, [1, 0]);
});

test('unknown foreign archive holder does not become a fabricated self archive or successful payment', () => {
  const body = card('body', { kind: 'creature', power: 3 });
  const o = play([{ kind: 'all', operation: 'foreignArchive', archiveTo: 'eventOwner',
    filter: { side: 'friendly', kind: 'creature' } }, { kind: 'gain', amount: { metric: 'archives' } },
    { kind: 'gain', amount: 1 }]); o.players[0].battleline = [body];
  const r = assess(o); assert.deepEqual(r.estimatedAmber, [1, 0]); assert.equal(r.approximate, true);
  assert.ok(r.reasons.some((x) => x.includes('archive holder')));
  o.players[0].hand[0].spec.abilities.play[0].archiveTo = 'self';
  assert.deepEqual(assess(o).estimatedAmber, [2, 0]);
});

test('combining public bindings deduplicates physical cards and scores the resulting archive', () => {
  const held = card('old', { abilities: { play: [{ kind: 'gain', amount: 2 }] } });
  const o = play([{ kind: 'chooseCards', filter: { side: 'friendly', zone: 'discard' }, bind: 'first', max: 1, then: [
    { kind: 'chooseCards', filter: { side: 'friendly', zone: 'discard' }, bind: 'second', max: 1, then: [
      { kind: 'combineBindings', keys: ['first', 'second'], bind: 'combined', then: [
        { kind: 'bound', key: 'combined', operation: 'archive' }, { kind: 'gain', amount: { metric: 'archives' } }] }] }] }]);
  o.players[0].discard = [held]; const r = assess(o);
  assert.deepEqual(r.estimatedAmber, [1, 0]); assert.ok(r.score > 3.8);
});

test('future material probe conserves revealed-top and public archive counts and removes duplicate public indexes', () => {
  for (const zone of ['deck', 'archives']) {
    const o = observation(), c = card('visible');
    if (zone === 'deck') { o.players[0].deckCount = 1; o.players[0].revealedTop = c; }
    else { o.players[1].archiveCount = 1; o.players[1].faceupArchives = [c]; }
    const seen = [];
    assessPublicCardUse(o, c, 0, (view) => { seen.push(view); return { score: 2, approximate: false, unresolvedValues: false }; });
    assert.equal(seen.length, 1); assert.equal(seen[0].players[0].handCount, 1);
    if (zone === 'deck') { assert.equal(seen[0].players[0].deckCount, 0); assert.equal(seen[0].players[0].revealedTop, undefined); }
    else { assert.equal(seen[0].players[1].archiveCount, 0); assert.deepEqual(seen[0].players[1].faceupArchives, []); }
  }
});

test('public current-play estimate respects printed resource requirements and paid play costs', () => {
  for (const requirement of [{ minAmberToPlay: 7 }, { playAmberCost: 3 }]) {
    const c = card('expensive', requirement), o = prompt('returnHand', [], [c]);
    const evaluate = () => ({ score: 20, approximate: false, unresolvedValues: false });
    assert.equal(assessPublicCardUse(o, c, 0, evaluate).playableNow, false);
    o.players[0].amber = 8;
    assert.equal(assessPublicCardUse(o, c, 0, evaluate).playableNow, true);
  }
});

test('archive pickup uses available same-house work while off-house bulk pickup pays one hand cost', () => {
  const active = card('active', { abilities: { play: [{ kind: 'gain', amount: 3 }] } });
  const o = observation(); o.phase = 'archives'; o.turnStep.step = 2;
  o.players[0].archives = [active]; o.players[0].archiveCount = 1;
  o.legalActions = [{ id: 'take', action: { kind: 'takeArchives' } }, { id: 'leave', action: { kind: 'leaveArchives' } }];
  assert.ok(assess(o, 'take').score > assess(o, 'leave').score);
  active.effective.house = active.spec.house = 'dis';
  assert.ok(assess(o, 'take').score < assess(o, 'leave').score);
});

test('injected opposing private arrays and display summaries do not change either final family ranking', () => {
  const c = card('own', { abilities: { play: [{ kind: 'gain', amount: 2 }] } });
  const o = prompt('archive', [], [c]), polluted = structuredClone(o);
  polluted.players[1].hand = [card('secret', { amber: 100, abilities: { play: [{ kind: 'gain', amount: 999 }] } }, 1)];
  polluted.players[1].archives = [card('secret-archive', { amber: 100 }, 1)];
  polluted.pending.label = 'misleading translated label'; polluted.players[0].discard[0].spec.summary = 'discard me now';
  const signature = (rank) => rank.map((r) => [r.actionId, r.score, r.estimatedAmber, r.projectedKey]);
  for (const rank of [(x) => rankCardAwareV3(x), (x) => rankStyleUpgrade(x, 'tactical-style-engine-v3')])
    assert.deepEqual(signature(rank(polluted)), signature(rank(o)));
});

test('unmodeled hand-discard reaction keeps independent known income and does not award a speculative refill', () => {
  const held = card('held', { house: 'dis' });
  const o = play([{ kind: 'gain', amount: 1 }, { kind: 'all', operation: 'discard', filter: { side: 'friendly', zone: 'hand' } }], [held]);
  o.players[1].artifacts = [card('reactor', { kind: 'artifact', reactions: [
    { event: 'handDiscarded', effects: [{ kind: 'unmodeled' }] }] }, 1)];
  const r = assess(o); assert.deepEqual(r.estimatedAmber, [1, 0]); assert.equal(r.approximate, true);
  assert.ok(!r.reasons.some((x) => x.includes('refill displacement settled')));
});

test('both final families choose the real Witch third-key recovery opportunity without prematurely forging', () => {
  const witch = printed('witch', 'witch-of-the-eye'), key = printed('key', 'key-charge'), troll = printed('troll', 'troll');
  const o = prompt('returnHand', [], [key, troll], witch);
  o.resolving = []; o.players[0].battleline = [witch]; witch.usesThisTurn = 1;
  o.activeHouse = 'untamed'; o.players[0].amber = o.players[0].forgeAvailable = 7;
  o.players[0].keys = ['red', 'blue']; o.turnUsage[witch.spec.name] = 1;
  o.publicCounters.creaturesUsed = [{ use: 1, currentCard: witch.id }];
  const rankings = [(x) => rankCardAwareV3(x), (x) => rankStyleUpgrade(x, 'tactical-style-engine-v3')];
  for (const rank of rankings) {
    const next = rank(o)[0]; assert.equal(next.actionId, key.id); assert.ok(next.score >= 7000);
    assert.equal(next.projectedKey, false); assert.deepEqual(next.estimatedAmber, [7, 0]);
    for (const rule of ['noPlay', 'noActions']) {
      const blocked = structuredClone(o); blocked.lasting.push({ source: 'restriction', actor: 1, appliesTo: 0,
        turn: blocked.turn, rule, amount: 0 });
      assert.ok(rank(blocked).every((r) => r.score < 5000));
    }
  }
});

test('material recovery value does not grant forge utility through a visible Gold Key Imp restriction', () => {
  const witch = printed('witch', 'witch-of-the-eye'), key = printed('key', 'key-charge');
  const o = prompt('returnHand', [], [key], witch); o.resolving = []; o.players[0].battleline = [witch];
  o.activeHouse = 'untamed'; o.players[0].amber = o.players[0].forgeAvailable = 7;
  o.players[0].keys = ['red', 'blue']; witch.usesThisTurn = 1;
  o.turnUsage[witch.spec.name] = 1; o.publicCounters.creaturesUsed = [{ use: 1, currentCard: witch.id }];
  const available = assess(o, key.id);
  o.players[1].battleline = [printed('imp', 'gold-key-imp', 1)]; o.players[0].forgeBlocked = true;
  const blocked = assess(o, key.id);
  assert.ok(available.score > 7000); assert.ok(blocked.score < 5); assert.equal(blocked.projectedKey, false);
});


test('a simultaneous discard group finishes moving before its Scrap child counts the discard pile', () => {
  const scrap = card('scrap', { house: 'dis', abilities: { scrap: [{ kind: 'gain', amount: { count: { side: 'friendly', zone: 'discard' } } }] } });
  const other = card('other', { house: 'dis' });
  const o = play([{ kind: 'all', operation: 'discard', filter: { side: 'friendly', zone: 'hand' } }], [scrap, other]);
  assert.deepEqual(assess(o).estimatedAmber, [2, 0]);
});


test('new chains in the same candidate do not reuse the old six-card refill target', () => {
  const held = Array.from({ length: 6 }, (_, i) => card(`held-${i}`, { house: 'dis' }));
  const archive = { kind: 'target', filter: { side: 'friendly', zone: 'hand' }, operation: 'archive' };
  const o = play([archive, { kind: 'chains', amount: 1 }], held);
  const control = play([{ kind: 'chains', amount: 1 }], held);
  close(assess(o).score, assess(control).score);
  assert.ok(assess(o).reasons.some((x) => x.includes('changed chains')));
});


test('Scrap child retains the parent play departure and public turn counters', () => {
  const scrap = card('scrap', { kind: 'creature', power: 2, house: 'dis', abilities: { scrap: [
    { kind: 'gain', amount: { count: { side: 'friendly', zone: 'hand' } } },
    { kind: 'gain', amount: { metric: 'playedThisTurn' } },
    { kind: 'gain', amount: { playedHouse: 'logos' } }] } });
  const o = play([{ kind: 'all', operation: 'discard', filter: { side: 'friendly', zone: 'hand' } }], [scrap]);
  assert.deepEqual(assess(o).estimatedAmber, [2, 0]);
  const body = play([{ kind: 'all', operation: 'discard', filter: { side: 'friendly', zone: 'hand' } }],
    [card('scrap-body', { kind: 'creature', power: 2, house: 'dis', abilities: { scrap: [
      { kind: 'gain', amount: { count: { side: 'friendly', kind: 'creature' } } }] } })]);
  body.players[0].hand[0].spec.kind = 'creature'; body.players[0].hand[0].spec.power = 3;
  body.players[0].hand[0].effective.power = 3;
  assert.deepEqual(assess(body).estimatedAmber, [1, 0]);
});
