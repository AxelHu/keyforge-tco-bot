import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';
import { assessAlgorithm } from '../../dist/src/ai/algorithm-policies.js';
import { assessPublicOperation } from '../../dist/src/ai/public-card-value.js';
import { rankCompetitive } from '../../dist/src/ai/competitive-policy.js';
import { rankStyled } from '../../dist/src/ai/persona-styles.js';
import { rankCardAwareV3 } from '../../dist/src/ai/card-aware-v3-policy.js';
import { rankStyleUpgrade } from '../../dist/src/ai/style-policy-upgrades.js';
import { cardSemanticFeatures } from '../../dist/src/knowledge/semantic-features.js';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';

const current = { contextualEffects: true, netResources: true, publicHouseChoices: true,
  publicAmberIconBindings: true, publicIntegerThirds: true };
function spec(id, abilities = {}, extra = {}) {
  return { id, name: id, kind: 'action', house: 'logos', amber: 0, power: 0, armor: 0,
    traits: [], summary: 'Display text never identifies a formula.', abilities, ...extra };
}
function card(id, definition, owner = 0, extra = {}) {
  return { id, definition: definition.id, spec: definition, owner, controller: owner,
    ready: true, damage: 0, armorUsed: 0, elusiveUsed: false, captured: 0, stunned: false,
    warded: false, powerCounters: 0, attachedTo: null, enteredController: owner,
    foreignArchiveHolder: null, printedHouse: definition.house, usesThisTurn: 0,
    effective: { house: definition.house, power: definition.power, armor: definition.armor,
      keywords: [], assault: 0, hazardous: 0 }, ...extra };
}
function body(id, owner = 0, power = 3, house = 'logos') {
  return card(id, spec(id, {}, { kind: 'creature', power, house }), owner);
}
function observation() {
  const player = (name) => ({ name, houses: ['brobnar', 'dis', 'logos'], activePlayer: name === 'alpha',
    activeHouse: 'logos', phase: 'main', optionSettings: { confirmOneClick: true },
    stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 30, numArchivesCards: 0, buttons: [], controls: [] });
  const o = projectKeytekiState({ id: 'formula-consumer-fixture', started: true, manualMode: false,
    players: { alpha: player('alpha'), beta: player('beta') }, messages: [] },
    { playerName: 'alpha', revision: 1, turn: 3 }).observation;
  delete o.publicStateCoverage;
  o.phase = 'main'; o.activeHouse = 'logos'; o.pending = null; o.legalActions = [];
  return o;
}
function fixture(effects, { held = [], sourceExtra = {}, own = [], enemy = [], amber = 0, opponentAmber = 0 } = {}) {
  const o = observation(), source = card('source', spec('source', { play: effects }, sourceExtra));
  o.players[0].hand = [source, ...held]; o.players[0].handCount = 1 + held.length;
  o.players[0].battleline = own; o.players[1].battleline = enemy;
  o.players[0].amber = o.players[0].forgeAvailable = amber;
  o.players[1].amber = o.players[1].forgeAvailable = opponentAmber;
  o.legalActions = [{ id: 'play', action: { kind: 'play', card: source.id } },
    { id: 'end', action: { kind: 'endTurn' } }];
  return o;
}
const assess = (o) => {
  const before = structuredClone(o);
  const result = assessAlgorithm(o, 'play', 'tactical-v1', current);
  assert.deepEqual(o, before, 'action estimation must not mutate its shared public observation');
  return result;
};
function blank(o) {
  const copy = structuredClone(o);
  const source = copy.players[0].hand.find((c) => c.id === 'source') ?? copy.players[0].discard.find((c) => c.id === 'source');
  source.spec.abilities.play = [];
  return copy;
}
function close(actual, expected, message) { assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''}: ${actual} != ${expected}`); }

// Category 1: public formulas recover meaningful capability flags and actual style bonuses.
test('contextual capability flags enter competitive and persona house ranking without changing weights', () => {
  const control = card('control', spec('control', { play: [{ kind: 'steal', amount: { count: { side: 'friendly' } } }] }));
  const quiet = card('quiet', spec('quiet', {}, { house: 'dis' }));
  const o = observation(); o.phase = 'house'; o.activeHouse = null;
  o.players[0].hand = [control, quiet]; o.players[0].handCount = 2;
  o.players[0].battleline = [body('friendly')];
  o.legalActions = ['logos', 'dis'].map((house) => ({ id: house, action: { kind: 'house', house } }));
  const semantic = cardSemanticFeatures(control.spec, 'play', { observation: o, source: control,
    action: { kind: 'play', card: control.id }, phase: 'after-play' });
  assert.equal(semantic.amberControl, true);
  const base = new Map(rankCompetitive(o, 'tactical').map((row) => [row.actionId, row.score]));
  close(rankCompetitive(o, 'control').find((row) => row.actionId === 'logos').score - base.get('logos'), 0.4);
  const foundation = o.legalActions.map((entry) => ({ actionId: entry.id, score: 0, estimatedAmber: [0, 0],
    projectedKey: false, deniesKey: false, approximate: false, reasons: [] }));
  close(rankStyled(o, 'control', foundation).ranked.find((row) => row.actionId === 'logos').styleBonus, 0.65);
  o.players[0].battleline = [];
  assert.equal(cardSemanticFeatures(control.spec, 'play', { observation: o, source: control,
    action: { kind: 'play', card: control.id }, phase: 'after-play' }).amberControl, false,
    'the dynamic result must not reuse a previous scene from the definition cache');
});

// Category 2: quantities reach the real action estimator, preserving core arithmetic and timing.
test('subtract clamps before surrounding arithmetic, while negate remains signed', () => {
  const o = fixture([{ kind: 'gain', amount: { add: [{ subtract: [1, 3] }, 3] } }]);
  assert.deepEqual(assess(o).estimatedAmber, [3, 0]);
  const signed = fixture([{ kind: 'gain', amount: { add: [5, { negate: 2 }] } }]);
  assert.deepEqual(assess(signed).estimatedAmber, [3, 0]);
});
test('new public aggregates and integer thirds change current action ranking in both tested families', () => {
  const o = fixture([{ kind: 'gain', amount: { distinctHouses: { side: 'friendly' } } }],
    { own: [body('a', 0, 3, 'logos'), body('b', 0, 3, 'dis'), body('c', 0, 3, 'brobnar')] });
  assert.deepEqual(assess(o).estimatedAmber, [3, 0]);
  for (const rows of [rankCardAwareV3(o), rankStyleUpgrade(o, 'tactical-style-engine-v3')]) {
    assert.equal(rows[0].actionId, 'play');
    assert.deepEqual(rows.find((row) => row.actionId === 'play').estimatedAmber, [3, 0]);
  }
  const third = fixture([{ kind: 'gain', amount: { ceilThird: { count: { side: 'friendly' } } } }],
    { own: [body('a'), body('b'), body('c'), body('d')] });
  assert.equal(assess(third).estimatedAmber[0], 2);
});
test('play projection removes physical source from hand and adds an exhausted creature exactly once', () => {
  const held = [card('held', spec('held'))];
  assert.equal(assess(fixture([{ kind: 'gain', amount: { count: { side: 'friendly', zone: 'hand' } } }], { held })).estimatedAmber[0], 1);
  assert.equal(assess(fixture([{ kind: 'gain', amount: { count: { side: 'friendly' } } }],
    { sourceExtra: { kind: 'creature', power: 3 } })).estimatedAmber[0], 1);
  const ready = fixture([{ kind: 'gain', amount: { count: { side: 'friendly', house: 'mars', ready: true } } }],
    { sourceExtra: { kind: 'creature', power: 3, house: 'mars' }, own: [body('ready-mars', 0, 3, 'mars')] });
  assert.equal(assess(ready).estimatedAmber[0], 1, 'raw ready=true on a hand CardView must not become ready entry');
});
test('playing from a public discard pile does not subtract another card from hand size', () => {
  const o = fixture([{ kind: 'gain', amount: { metric: 'handSize' } }],
    { held: [card('held1', spec('held1')), card('held2', spec('held2'))] });
  o.players[0].discard = [o.players[0].hand.shift()]; o.players[0].handCount = 2;
  assert.equal(assess(o).estimatedAmber[0], 2);
});
test('sequence pool and capped captured-amber projections remain current instead of rereading the observation', () => {
  assert.equal(assess(fixture([{ kind: 'gain', amount: 2 }, { kind: 'gain', amount: { metric: 'amber' } }], { amber: 1 })).estimatedAmber[0], 6);
  const o = fixture([{ kind: 'capture', amount: 5 }, { kind: 'capture', amount: 5 },
    { kind: 'gain', amount: { sourceAmber: true } }], { sourceExtra: { kind: 'creature', power: 3 }, opponentAmber: 3 });
  assert.deepEqual(assess(o).estimatedAmber, [3, 0], 'two captures cannot spend the same enemy pool twice');
});
test('scalar snapshots, nested lastAmount and forEach iterations obey local frame scope', () => {
  const scalar = fixture([{ kind: 'withValue', bind: 'n', value: 2, then: [{ kind: 'gain', amount: { storedValue: 'n' } }] },
    { kind: 'gain', amount: { storedValue: 'n' } }]);
  assert.equal(assess(scalar).estimatedAmber[0], 2);
  assert.equal(assess(scalar).approximate, true, 'the outer frame has no n binding');
  const loop = fixture([{ kind: 'loseThen', amount: 2, then: [{ kind: 'forEach', count: { lastAmount: true }, effects: [
    { kind: 'gain', amount: 1 }, { kind: 'loseThen', amount: 1, then: [] }, { kind: 'gain', amount: { lastAmount: true } },
  ] }] }], { amber: 2 });
  assert.equal(assess(loop).estimatedAmber[0], 4);
});
test('unprojected field mutation stays unknown instead of reading old source power as current', () => {
  const o = fixture([{ kind: 'self', operation: 'power', amount: 2 }, { kind: 'gain', amount: { sourcePower: true } }],
    { sourceExtra: { kind: 'creature', power: 3 } });
  const result = assess(o);
  assert.equal(result.estimatedAmber[0], 0);
  assert.equal(result.approximate, true);
  assert.ok(result.reasons.some((reason) => reason.includes('source-field-changed') || reason.includes('power')));
});
test('exact zero target damage and capture are not replaced by a nonzero default', () => {
  for (const operation of ['damage', 'capture']) {
    const o = fixture([{ kind: 'target', filter: { side: operation === 'damage' ? 'enemy' : 'friendly' },
      operation, amount: { subtract: [1, 3] } }], { own: [body('own')], enemy: [body('enemy', 1)], opponentAmber: 4 });
    close(assess(o).score, assess(blank(o)).score, operation);
    assert.deepEqual(assess(o).estimatedAmber, [0, 4]);
  }
});

// Category 3: probability over public outcomes, never an invented hidden card distribution.
test('randomDiscard defaults to self and uses archives instead of the opposing hand count', () => {
  const empty = fixture([{ kind: 'randomDiscard', amount: 1 }]); empty.players[1].handCount = 7;
  close(assess(empty).score, assess(blank(empty)).score, 'the only own hand card is already being played');
  const archive = fixture([{ kind: 'randomDiscard', amount: 1, zone: 'archives' }]);
  archive.players[0].archives = [card('stored', spec('stored', {}, { amber: 2 }))]; archive.players[0].archiveCount = 1;
  assert.ok(assess(archive).score < assess(blank(archive)).score);
  assert.ok(assess(archive).reasons.some((reason) => reason.includes('self archives')));
});
test('random discard averages existing public-card utilities and caps at the available population', () => {
  const held = [card('cheap', spec('cheap')), card('valuable', spec('valuable', {}, { amber: 3 }))];
  const one = fixture([{ kind: 'randomDiscard', amount: 1 }], { held });
  const all = fixture([{ kind: 'randomDiscard', amount: 9 }], { held });
  const sum = held.reduce((n, c) => n + assessPublicOperation(one, c, 'discard', 0, { inPlay: false }).score, 0);
  close(assess(one).score - assess(blank(one)).score, sum / 2);
  close(assess(all).score - assess(blank(all)).score, sum);
});
test('uniform random bindings apply resource caps separately: E[min(X,5)] = 3 for X in {1,9}', () => {
  const held = [body('one', 0, 1), body('nine', 0, 9)];
  for (const kind of ['randomCard', 'bindRandom']) {
    const o = fixture([{ kind, zone: 'hand', bind: 'picked', then: [
      { kind: 'steal', amount: { bindingPower: 'picked' } },
    ] }], { held, opponentAmber: 5 });
    assert.deepEqual(assess(o).estimatedAmber, [3, 2]);
    assert.ok(assess(o).reasons.some((reason) => reason.includes('2 equally likely public outcomes')));
  }
});
test('random conditional and forEach branches are evaluated before averaging', () => {
  const held = [body('one', 0, 1), body('nine', 0, 9)];
  const conditional = fixture([{ kind: 'randomCard', zone: 'hand', bind: 'picked', then: [{ kind: 'if',
    condition: { left: { bindingPower: 'picked' }, comparison: 'gt', right: 5 },
    then: [{ kind: 'gain', amount: 9 }], otherwise: [{ kind: 'gain', amount: 1 }],
  }] }], { held });
  assert.equal(assess(conditional).estimatedAmber[0], 5);
  const loop = fixture([{ kind: 'randomCard', zone: 'hand', bind: 'picked', then: [{ kind: 'forEach',
    count: { bindingPower: 'picked' }, effects: [{ kind: 'steal', amount: 1 }],
  }] }], { held, opponentAmber: 5 });
  assert.deepEqual(assess(loop).estimatedAmber, [3, 2]);
});
test('an averaged pool is not reused as a certain threshold by a later sibling effect', () => {
  const o = fixture([{ kind: 'randomCard', zone: 'hand', bind: 'picked', then: [
    { kind: 'steal', amount: { bindingPower: 'picked' } },
  ] }, { kind: 'if', condition: { left: { metric: 'amber' }, comparison: 'gte', right: 3 },
    then: [{ kind: 'gain', amount: 100 }] }], { held: [body('one', 0, 1), body('nine', 0, 9)], opponentAmber: 5 });
  const result = assess(o);
  assert.deepEqual(result.estimatedAmber, [3, 2]);
  assert.equal(result.projectedKey, false);
  assert.ok(result.reasons.some((reason) => reason.includes('resource-pool-depends-on-random-outcome')));
});
test('hidden random identities and visible Scrap responses retain explicit uncertainty', () => {
  const hidden = fixture([{ kind: 'randomCard', side: 'opponent', zone: 'hand', bind: 'secret',
    then: [{ kind: 'gain', amount: { bindingPower: 'secret' } }] }]); hidden.players[1].handCount = 5;
  const result = assess(hidden);
  assert.equal(result.estimatedAmber[0], 0);
  assert.equal(result.approximate, true);
  assert.ok(result.reasons.some((reason) => reason.includes('hidden or incomplete')));
  const scrap = card('scrap', spec('scrap', { scrap: [{ kind: 'draw', amount: 2 }] }));
  const uncertain = assess(fixture([{ kind: 'randomDiscard', amount: 2 }], { held: [scrap, body('other')] }));
  assert.ok(uncertain.reasons.some((reason) => reason.includes('intervening reactions')));
});
test('randomDeckTop moves every matching creature; randomness concerns only order', () => {
  const options = { own: [body('own')], enemy: [body('one', 1), body('two', 1)] };
  const random = fixture([{ kind: 'randomDeckTop', filter: {} }], options);
  const all = fixture([{ kind: 'all', operation: 'deckTop', filter: {} }], options);
  close(assess(random).score, assess(all).score);
  assert.deepEqual(assess(random).estimatedAmber, assess(all).estimatedAmber);
});


test('both physical gigantic halves leave their actual public zones exactly once', () => {
  const second = card('second-half', spec('second-half', {}, { giganticHalf: true }));
  const o = fixture([{ kind: 'gain', amount: { metric: 'handSize' } }],
    { sourceExtra: { kind: 'creature', power: 10, giganticHalf: true }, held: [second, card('kept', spec('kept'))] });
  o.legalActions[0].action.otherHalf = 'second-half';
  assert.equal(assess(o).estimatedAmber[0], 1);
});
test('known ready, exhaust and stun results update following public filter counts', () => {
  for (const [operation, filter, expected] of [
    ['ready', { ready: true }, 1], ['exhaust', { ready: true }, 0], ['stun', { stunned: true }, 1],
  ]) {
    const target = body('target'); target.ready = operation === 'ready' ? false : true;
    const o = fixture([{ kind: 'all', filter: { side: 'friendly' }, operation },
      { kind: 'gain', amount: { count: { side: 'friendly', ...filter } } }], { own: [target] });
    assert.equal(assess(o).estimatedAmber[0], expected, operation);
  }
});


test('unknown event recipients do not default constant resources to self; active uses observed activePlayer', () => {
  for (const side of ['eventOwner', 'eventController', 'lastOwner']) {
    const result = assess(fixture([{ kind: 'resource', side, operation: 'gain', amount: 5 }]));
    assert.deepEqual(result.estimatedAmber, [0, 0]);
    assert.equal(result.approximate, true);
    assert.ok(result.reasons.some((reason) => reason.includes('recipient')));
  }
  const active = fixture([{ kind: 'resource', side: 'active', operation: 'gain', amount: 2 }]);
  active.activePlayer = 1;
  assert.deepEqual(assess(active).estimatedAmber, [0, 2]);
});


test('a fresh random binding after return-to-hand uses the new zone and does not restore old exact identities', () => {
  for (const publicDestroyedRefunds of [false, true]) {
    const o = fixture([{ kind: 'all', filter: { side: 'friendly' }, operation: 'returnHand' },
      { kind: 'randomCard', zone: 'hand', bind: 'again', then: [{ kind: 'bound', key: 'again', operation: 'purge' }] },
      { kind: 'gain', amount: { count: { side: 'friendly', zone: 'hand' } } },
    ], { own: [body('x'), body('y')] });
    const before = structuredClone(o);
    const result = assessAlgorithm(o, 'play', 'tactical-v1', { ...current, publicDestroyedRefunds });
    assert.deepEqual(result.estimatedAmber, [1, 0], 'exactly one of the two freshly returned cards remains');
    assert.ok(result.reasons.some((reason) => reason.includes('2 equally likely public outcomes')));
    assert.deepEqual(o, before);
    const stale = fixture([{ kind: 'chooseCards', filter: { side: 'friendly' }, bind: 'old', then: [
      { kind: 'bound', key: 'old', operation: 'returnHand' }, { kind: 'bound', key: 'old', operation: 'purge' },
    ] }, { kind: 'gain', amount: { count: { side: 'friendly', zone: 'hand' } } }], { own: [body('old-card')] });
    assert.equal(assessAlgorithm(stale, 'play', 'tactical-v1', { ...current, publicDestroyedRefunds }).estimatedAmber[0], 1,
      'an old binding must not follow the physical card into its new public entry');
    const unchanged = fixture([{ kind: 'all', filter: { side: 'friendly' }, operation: 'returnHand' },
      { kind: 'randomCard', zone: 'hand', bind: 'picked', then: [{ kind: 'gain', amount: 1 }] },
      { kind: 'gain', amount: { count: { side: 'friendly', zone: 'hand', kind: 'creature' } } },
    ], { own: [body('kept-x'), body('kept-y')] });
    assert.equal(assessAlgorithm(unchanged, 'play', 'tactical-v1', { ...current, publicDestroyedRefunds }).estimatedAmber[0], 3,
      'random selection alone does not erase the identities of cards unchanged in every branch');
  }
});


test('shuffleDeck preserves public destination counts without reviving stale deck sizes or fabricating discard changes', () => {
  const real = ALL_DEFINITIONS['techno-shade'], original = structuredClone(real);
  const movement = real.abilities.reap[0];
  assert.deepEqual(movement, { kind: 'randomDiscard', side: 'opponent', amount: 1, operation: 'shuffleDeck' });
  assert.deepEqual(real.abilities.afterFight, [movement]);
  assert.equal(real.abilities.reap.length, 1);
  const count = (zone, side = 'enemy') => ({ count: { side, zone } });
  // The following tails are synthetic legal Effect compositions, not the real
  // Techno-Shade subtree. Opposing hand faces never enter this public fixture.
  function setup(effects) {
    const o = observation();
    o.publicStateCoverage = { turnHistoryComplete: true, effectsComplete: true, turnOrdinalKnown: true };
    o.activePlayer = 0; o.activeHouse = real.house;
    const definition = effects === undefined ? real : { ...structuredClone(real), id: 'synthetic-shuffle-followup',
      name: 'Synthetic public effect composition', abilities: { reap: effects } };
    o.players[0].battleline = [card('source', definition)];
    o.players[0].hand = []; o.players[0].handCount = 0; o.players[0].deckCount = 35;
    delete o.players[1].hand;
    o.players[1].handCount = 1; o.players[1].deckCount = 34;
    o.players[1].discard = [card('public-discard', ALL_DEFINITIONS.troll, 1)];
    o.legalActions = [{ id: 'reap', action: { kind: 'reap', card: 'source' } }];
    return o;
  }
  for (const publicDestroyedRefunds of [false, true]) {
    const features = { ...current, publicDestroyedRefunds };
    const run = (o, actionId = 'reap', extra = {}) => {
      const before = structuredClone(o);
      const result = assessAlgorithm(o, actionId, 'tactical-v1', { ...features, ...extra });
      assert.deepEqual(o, before, 'shuffle estimation must not mutate its shared observation');
      return result;
    };
    assert.equal(run(setup()).estimatedAmber[0], 1, 'unchanged real-card reap control');
    assert.equal(run(setup([movement, { kind: 'gain', amount: count('deck') }])).estimatedAmber[0], 36,
      'one hidden hand card adds exactly one to its owner deck before the follow-up amount');
    assert.equal(run(setup([movement, { kind: 'if',
      condition: { left: count('deck'), comparison: 'eq', right: 34 },
      then: [{ kind: 'gain', amount: 100 }], otherwise: [{ kind: 'gain', amount: 1 }],
    }])).estimatedAmber[0], 2, 'the previous deck size must not select the 100-amber branch');
    assert.equal(run(setup([movement, { kind: 'gain', amount: count('discard') }])).estimatedAmber[0], 2,
      'shuffling from hand leaves the public discard pile unchanged');

    const twice = setup([movement, movement, { kind: 'gain', amount: count('deck') }]);
    twice.players[1].handCount = 2; twice.players[1].deckCount = 33;
    assert.equal(run(twice).estimatedAmber[0], 36, 'two known arrivals accumulate exactly once each');
    for (const prior of [
      { kind: 'resource', side: 'opponent', operation: 'draw', amount: 1 },
      { kind: 'all', filter: { side: 'enemy' }, operation: 'deckTop' },
    ]) {
      const o = setup([prior, movement, { kind: 'gain', amount: count('deck') }]);
      if (prior.kind === 'all') o.players[1].battleline = [body('returned', 1)];
      const result = run(o);
      assert.equal(result.estimatedAmber[0], 1, 'an unmodeled earlier deck change must remain unknown');
      assert.ok(result.reasons.some((reason) => reason.includes('zone-count-depends-on-random-or-unmodeled')));
    }
    const bonus = fixture([{ ...movement, side: 'self' }, { kind: 'gain', amount: count('deck', 'friendly') }],
      { held: [body('held')] });
    bonus.players[0].hand[0].bonusIcons = ['draw'];
    assert.equal(run(bonus, 'play', { physicalBonuses: true }).estimatedAmber[0], 0,
      'a draw icon not projected by this consumer cannot restore an exact old deck count');

    const prophecy = setup([{ ...movement, side: 'self' }, { kind: 'gain', amount: count('deck', 'friendly') }]);
    prophecy.players[0].hand = [body('held')]; prophecy.players[0].handCount = 1;
    prophecy.players[0].deckCount = 34;
    prophecy.prophecies = [{ id: 'public-prophecy', owner: 1,
      faces: ['expect-the-unexpected', 'bad-omen'], face: 0, active: true, count: 1, revealed: false }];
    const uncertain = run(prophecy);
    assert.equal(uncertain.estimatedAmber[0], 1, 'a real deckShuffled Fate window keeps subsequent deck counts unknown');
    assert.ok(uncertain.reasons.some((reason) => reason.includes('intervening reactions')));
  }
  assert.deepEqual(real, original, 'the actual catalog definition is never rewritten by the synthetic composition');
});


test('captured changes refresh intrinsic power for every known stored-amber operation', () => {
  const cases = [
    { effects: [{ kind: 'capture', amount: 1 }], amber: 0, expected: [3, 2] },
    { effects: [{ kind: 'self', operation: 'captureOwn', amount: 1 }], amber: 3, expected: [5, 3] },
    { effects: [{ kind: 'self', operation: 'addAmber', amount: 2 }], amber: 0, expected: [4, 3] },
    { effects: [{ kind: 'capture', amount: 2 }, { kind: 'self', operation: 'takeAmber', amount: 1 }], amber: 0, expected: [4, 1] },
    { effects: [{ kind: 'capture', amount: 2 }, { kind: 'self', operation: 'removeAmber', amount: 1 }], amber: 0, expected: [3, 1] },
  ];
  for (const row of cases) {
    const o = fixture([...row.effects, { kind: 'gain', amount: { sourcePower: true } }],
      { sourceExtra: { kind: 'creature', power: 2, selfPower: 'captured' }, amber: row.amber, opponentAmber: 3 });
    assert.deepEqual(assess(o).estimatedAmber, row.expected, JSON.stringify(row.effects));
  }
  const centurion = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Centurion Stenopius');
  const o = fixture([{ kind: 'capture', amount: 2 }, { kind: 'gain', amount: { sourcePower: true } }],
    { sourceExtra: { kind: 'creature', power: centurion.power, powerBonus: centurion.powerBonus }, opponentAmber: 3 });
  assert.equal(assess(o).estimatedAmber[0], centurion.power + 6);
});

test('captured-dependent power preserves existing counters and current copied characteristics', () => {
  const o = fixture([], { opponentAmber: 3 });
  const source = o.players[0].hand[0];
  source.spec = spec('current-copy', { reap: [{ kind: 'capture', amount: 1 },
    { kind: 'gain', amount: { sourcePower: true } }] }, { kind: 'creature', power: 2, selfPower: 'captured' });
  source.definition = 'a-different-printed-definition'; source.copiedDefinition = 'yxili-marauder';
  source.powerCounters = 4; source.effective.power = 6;
  o.players[0].hand = []; o.players[0].handCount = 0; o.players[0].battleline = [source];
  o.legalActions[0].action = { kind: 'reap', card: source.id };
  assert.deepEqual(assess(o).estimatedAmber, [8, 2]);
});

test('uncertain captured branches do not revive old dependent power or hard-calculate external modifiers', () => {
  const random = fixture([{ kind: 'randomCard', zone: 'hand', bind: 'picked', then: [
    { kind: 'capture', amount: { bindingPower: 'picked' } },
  ] }, { kind: 'gain', amount: { sourcePower: true } }],
  { sourceExtra: { kind: 'creature', power: 2, selfPower: 'captured' },
    held: [body('one', 0, 1), body('three', 0, 3)], opponentAmber: 5 });
  assert.deepEqual(assess(random).estimatedAmber, [0, 3]);
  assert.ok(assess(random).approximate);
  const aura = body('aura'); aura.spec.auras = [{ property: 'power', amount: 5, filter: { side: 'friendly' } }];
  const external = fixture([{ kind: 'capture', amount: 1 }, { kind: 'gain', amount: { sourcePower: true } }],
    { sourceExtra: { kind: 'creature', power: 2, selfPower: 'captured' }, own: [aura], opponentAmber: 3 });
  assert.equal(assess(external).estimatedAmber[0], 0);
  assert.ok(assess(external).approximate);
});

test('Stratowise recomputes Haunted after its actual discard and preserves unresolved pile counts', () => {
  const real = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Stratowise');
  const source = card('stratowise', real), held = body('held');
  const o = fixture([], { own: [source], held: [held], opponentAmber: 3 });
  o.players[0].hand = [held]; o.players[0].handCount = 1;
  o.players[0].discard = Array.from({ length: 9 }, (_, i) => body('old-' + i));
  o.haunted = [false, false]; o.legalActions[0].action = { kind: 'reap', card: source.id };
  assert.deepEqual(assess(o).estimatedAmber, [1, 2], 'discarding the tenth card makes this real Reap capture one');
  const fallen = fixture([{ kind: 'target', filter: { side: 'friendly', zone: 'discard' }, operation: 'returnHand' },
    { kind: 'gain', amount: { haunted: true } }]);
  fallen.players[0].discard = Array.from({ length: 10 }, (_, i) => body('stored-' + i));
  fallen.haunted = [true, false];
  assert.equal(assess(fallen).estimatedAmber[0], 0, 'leaving ten cards also clears the old cached flag');
  const unknown = fixture([{ kind: 'randomDiscard', side: 'opponent', amount: 1 },
    { kind: 'gain', amount: { haunted: true, side: 'opponent' } }]);
  unknown.players[1].handCount = 1; unknown.players[1].discard = Array.from({ length: 9 }, (_, i) => body('enemy-' + i, 1));
  unknown.haunted = [false, false];
  const result = assess(unknown);
  assert.equal(result.estimatedAmber[0], 0);
  assert.ok(result.reasons.some((reason) => reason.includes('projected-haunted-discard-count-unresolved')));
});


test('Haunted does not certify an old blanked provider spec after its blanking source leaves', () => {
  const cemetery = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Junkyard Cemetery');
  const blossom = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Blossom Drake');
  const blankProvider = () => {
    const { id, name, number, house, kind, power, armor, amber, traits } = cemetery;
    return card('cemetery', { id, name, number, house, kind, power, armor, amber, traits,
      summary: 'Only an already blanked public spec is available.', abilities: {} });
  };
  const make = ({ remainingBlanker = false, discardCount = 9, moveBlanker = true } = {}) => {
    const effects = moveBlanker ? [{ kind: 'target', filter: { side: 'enemy', definition: blossom.id }, operation: 'purge' }] :
      [{ kind: 'target', filter: { side: 'friendly', zone: 'discard' }, operation: 'returnHand' }];
    const o = fixture([...effects, { kind: 'gain', amount: { haunted: true } }],
      { enemy: [card('blanker', blossom, 1)] });
    o.players[0].artifacts = [blankProvider()];
    o.players[0].discard = Array.from({ length: discardCount }, (_, i) => body('old-' + i));
    o.players[0].purged = [body('purged')];
    o.haunted = [discardCount >= 10, false];
    if (remainingBlanker) o.players[0].battleline = [card('remaining-blanker', blossom)];
    return o;
  };
  const changed = assess(make());
  assert.equal(changed.estimatedAmber[0], 0);
  assert.ok(changed.reasons.some((reason) => reason.includes('provider-text-may-return-after-blanking-source-departure')),
    'removing real Blossom Drake restores the real Cemetery text, so an old blanked spec cannot certify false Haunted');
  const stillBlanked = assess(make({ remainingBlanker: true }));
  assert.equal(stillBlanked.estimatedAmber[0], 0);
  assert.ok(!stillBlanked.reasons.some((reason) => reason.includes('provider-text-may-return')),
    'a surviving known global blanker keeps the observed text blank');
  const ten = assess(make({ discardCount: 10 }));
  assert.equal(ten.estimatedAmber[0], 1, 'ten actual discard cards establish Haunted without any provider text');
  assert.ok(!ten.reasons.some((reason) => reason.includes('provider-text-may-return')));
  const unchanged = assess(make({ discardCount: 10, moveBlanker: false }));
  assert.equal(unchanged.estimatedAmber[0], 0, 'ordinary ten-to-nine movement with an unchanged blanker remains exact');
  assert.ok(!unchanged.reasons.some((reason) => reason.includes('provider-text-may-return')));
});
