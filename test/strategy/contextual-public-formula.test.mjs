import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePublicValue,
  evaluatePublicCondition,
  selectPublicCards,
  projectPublicFormulaContext,
  expectedPublicValue,
  exactPublicValue,
} from '../../dist/src/knowledge/public-formula.js';
import { cardSemanticFeatures } from '../../dist/src/knowledge/semantic-features.js';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';

function definition(extra = {}) {
  return {
    id: 'public-formula-fixture',
    name: 'Public formula fixture',
    kind: 'creature',
    house: 'mars',
    power: 3,
    armor: 0,
    amber: 0,
    traits: [],
    summary: 'Display only',
    ...extra,
  };
}
function card(id, extra = {}, seat = 0) {
  const spec = definition(extra);
  return {
    id,
    definition: spec.id,
    spec,
    owner: seat,
    controller: seat,
    ready: true,
    damage: 0,
    armorUsed: 0,
    elusiveUsed: false,
    captured: 0,
    stunned: false,
    powerCounters: 0,
    attachedTo: null,
    enteredController: seat,
    foreignArchiveHolder: null,
    printedHouse: spec.house,
    usesThisTurn: 0,
    effective: {
      house: spec.house,
      houses: [spec.house],
      power: spec.power,
      armor: spec.armor,
      keywords: spec.keywords ?? [],
      assault: spec.assault ?? 0,
      hazardous: spec.hazardous ?? 0,
    },
  };
}
function observation() {
  const player = (seat) => ({
    seat,
    name: 'player-' + seat,
    deckId: 'fixture-' + seat,
    houses: ['mars', 'logos', 'sanctum'],
    amber: 0,
    keys: [],
    chains: 0,
    keyCost: 6,
    canForge: false,
    lastForgedTurn: null,
    handCount: 0,
    archiveCount: 0,
    deckCount: 20,
    hand: seat === 0 ? [] : undefined,
    archives: seat === 0 ? [] : undefined,
    battleline: [],
    artifacts: [],
    upgrades: [],
    discard: [],
    purged: [],
  });
  return {
    schemaVersion: 2,
    engineVersion: 'test',
    rulesVersion: 'test',
    catalogVersion: 'test',
    revision: 1,
    turn: 4,
    you: 0,
    firstPlayer: 0,
    turnUsage: {},
    handOperations: 0,
    playedThisTurn: 0,
    creaturesPlayedThisTurn: 0,
    activePlayer: 0,
    phase: 'main',
    activeHouse: 'mars',
    players: [player(0), player(1)],
    legalActions: [],
    resolving: [],
    promptCards: [],
    underCards: [],
    spanglerCards: [],
    controlLayers: [],
    nextReady: [],
    leaveEffects: [],
    publicCounters: {
      playedByHouse: {},
      discardedHouses: [[], []],
      creaturesPlayedLastTurn: [0, 0],
      enemyFightDeaths: 0,
      creaturesUsed: [],
    },
    pending: null,
    lasting: [],
    knowledge: [],
    permissions: [],
    cardEffects: [],
    houseRestrictions: [],
    futureHouseRestrictions: [],
    winner: null,
    worldsCollide: {
      version: 2,
      fought: [0, 0],
      stolenFrom: [0, 0],
      previousStolenFrom: [0, 0],
    },
    creatureUseHistory: [],
    friendlyExaltedThisTurn: [false, false],
    interactionCounters: { reaps: 0, discarded: [0, 0] },
  };
}
function exact(formula, context, expected) {
  const result = evaluatePublicValue(formula, context);
  assert.equal(result.kind, 'exact', JSON.stringify(result));
  assert.equal(result.value, expected);
  return result;
}
function interval(result, lower, upper) {
  assert.equal(result.kind, 'interval', JSON.stringify(result));
  assert.equal(result.lower, lower);
  assert.equal(result.upper, upper);
}
const context = (o, source, extra = {}) => ({
  observation: o,
  actor: 0,
  source,
  ...extra,
});

// These are calculations over public observations; no game/referee hidden state is created.
test('public quantities respond exactly to current ready Mars, captured amber, armor and houses', () => {
  const o = observation(),
    mars = card('mars'),
    other = card('other', { house: 'logos' });
  mars.captured = 2;
  other.captured = 3;
  o.players[0].battleline = [mars, other];
  const ctx = context(o, mars);
  exact({ count: { side: 'friendly', house: 'mars', ready: true } }, ctx, 1);
  exact({ creatureAmberTotal: { side: 'friendly' } }, ctx, 5);
  exact({ distinctHouses: { side: 'friendly' } }, ctx, 2);
  mars.ready = false;
  mars.effective.armor = 4;
  exact({ count: { side: 'friendly', house: 'mars', ready: true } }, ctx, 0);
  exact({ sourceArmor: true }, ctx, 4);
  exact({ distinctHouses: { side: 'friendly', notHouse: 'mars' } }, ctx, 1);
});

test('real dynamic cards are recognized as contextual capabilities without summary parsing', () => {
  const psychic = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Psychic Network');
  assert.ok(psychic);
  const source = card('psychic', psychic),
    o = observation();
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  const ctx = context(o, source, {
    action: { kind: 'play', card: source.id },
    phase: 'after-play',
  });
  assert.equal(cardSemanticFeatures(psychic, 'play', ctx).amberControl, false);
  o.players[0].battleline.push(card('ready-mars'));
  assert.equal(
    cardSemanticFeatures(
      { ...psychic, summary: 'Unrelated words', summaryFeatures: 0 },
      'play',
      ctx,
    ).amberControl,
    true,
  );
  o.players[0].battleline[0].ready = false;
  assert.equal(cardSemanticFeatures(psychic, 'play', ctx).amberControl, false);
});

test('selection defaults to battleline and uses archive holder instead of card controller', () => {
  const o = observation(),
    creature = card('creature'),
    artifact = card('artifact', { kind: 'artifact' });
  o.players[0].battleline = [creature];
  o.players[0].artifacts = [artifact];
  const foreign = card('foreign', { house: 'logos' }, 1);
  o.players[0].archives = [foreign];
  o.players[0].archiveCount = 1;
  exact({ count: { side: 'friendly' } }, context(o), 1);
  exact({ count: { side: 'friendly', zone: 'play' } }, context(o), 2);
  assert.deepEqual(
    selectPublicCards({ side: 'friendly', zone: 'archives' }, context(o)).cards.map((c) => c.id),
    ['foreign'],
  );
  exact({ count: { side: 'enemy', zone: 'archives' } }, context(o), 0);
});

test('hidden enemy faces are ignored while public counts and bounded filtered counts remain available', () => {
  const o = observation();
  o.players[1].handCount = 4;
  o.players[1].hand = [card('injected-secret', { house: 'mars' }, 1)];
  exact({ count: { side: 'enemy', zone: 'hand' } }, context(o), 4);
  interval(
    evaluatePublicValue({ count: { side: 'enemy', zone: 'hand', house: 'mars' } }, context(o)),
    0,
    4,
  );
  assert.deepEqual(selectPublicCards({ side: 'enemy', zone: 'hand' }, context(o)).cards, []);
  const features = cardSemanticFeatures(
    definition({
      abilities: {
        play: [
          {
            kind: 'steal',
            amount: { count: { side: 'enemy', zone: 'hand', house: 'mars' } },
          },
        ],
      },
    }),
    'play',
    context(o),
  );
  assert.equal(features.amberControl, true);
  assert.equal(features.conditional, true);
  assert.equal(features.unknown, true);
});

test('after-play removes the physical source once and makes an ordinary entrant exhausted', () => {
  const o = observation(),
    source = card('entering'),
    ally = card('ally');
  source.warded = true;
  source.damage = 2;
  source.captured = 3;
  source.powerCounters = 4;
  o.players[0].hand = [source, card('other-hand')];
  o.players[0].handCount = 2;
  o.players[0].battleline = [ally];
  const ctx = context(o, source, {
    action: { kind: 'play', card: source.id, flank: 'right' },
    phase: 'after-play',
  });
  exact({ count: { side: 'friendly', zone: 'hand' } }, ctx, 1);
  exact({ count: { side: 'friendly', ready: true, house: 'mars' } }, ctx, 1);
  exact({ count: { side: 'friendly' } }, ctx, 2);
  const prepared = projectPublicFormulaContext(ctx);
  assert.equal(prepared.source.ready, false);
  assert.equal(prepared.source.warded, false);
  assert.equal(prepared.source.damage, 0);
  assert.equal(prepared.source.captured, 0);
  exact({ sourcePowerCounters: true }, prepared, 0);
  exact({ count: { side: 'friendly', zone: 'hand' } }, projectPublicFormulaContext(prepared), 1);
  assert.equal(o.players[0].handCount, 2);
  assert.equal(source.ready, true);
});

test('entry conditions use pre-insertion creature ordinals and retain unknown readiness when required', () => {
  const o = observation();
  const source = card('conditional-entry', {
    entryReadyCondition: {
      left: { metric: 'creaturesPlayedThisTurn' },
      comparison: 'eq',
      right: 0,
    },
  });
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  const ctx = context(o, source, {
    action: { kind: 'play', card: source.id, flank: 'right' },
    phase: 'after-play',
  });
  exact({ count: { side: 'friendly', ready: true } }, ctx, 1);
  o.creaturesPlayedThisTurn = 1;
  exact({ count: { side: 'friendly', ready: true } }, ctx, 0);
  o.publicStateCoverage = { turnHistoryComplete: false, effectsComplete: true };
  interval(evaluatePublicValue({ count: { side: 'friendly', ready: true } }, ctx), 0, 1);
});

test('ready entry rules and known nextReady selectors are evaluated from public structure', () => {
  const o = observation(),
    source = card('entrant'),
    provider = card('provider', {
      kind: 'artifact',
      readyEntryRules: [{ kind: 'creature', notHouse: 'logos' }],
    });
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  o.players[0].artifacts = [provider];
  const ctx = context(o, source, {
    phase: 'after-play',
    action: { kind: 'play', card: source.id, flank: 'right' },
  });
  exact({ count: { side: 'friendly', ready: true } }, ctx, 1);
  provider.spec.readyEntryRules = [];
  o.nextReady = [
    {
      source: provider.id,
      actor: 0,
      turn: o.turn,
      filter: { side: 'friendly', kind: 'creature' },
    },
  ];
  exact({ count: { side: 'friendly', ready: true } }, ctx, 1);
});

test('public archive and deck entry update counts and aliases, and removed sources are not reinserted', () => {
  const o = observation(),
    source = card('from-archives');
  o.players[0].archives = [source];
  o.players[0].faceupArchives = [source];
  o.players[0].archiveCount = 1;
  const prepared = projectPublicFormulaContext(
    context(o, source, {
      phase: 'after-play',
      action: { kind: 'play', card: source.id, flank: 'right' },
    }),
  );
  exact({ metric: 'archives' }, prepared, 0);
  assert.deepEqual(prepared.observation.players[0].faceupArchives, []);
  const removed = {
    ...prepared,
    observation: {
      ...prepared.observation,
      players: prepared.observation.players.map((p) => ({
        ...p,
        battleline: [],
      })),
    },
    phase: 'after-play',
  };
  exact({ count: { side: 'friendly' } }, removed, 0);
  const deck = observation(),
    top = card('public-top', { kind: 'action' });
  deck.players[0].revealedTop = top;
  const fromDeck = projectPublicFormulaContext(
    context(deck, top, {
      phase: 'after-play',
      action: { kind: 'play', card: top.id },
    }),
  );
  assert.equal(fromDeck.observation.players[0].deckCount, 19);
  assert.equal(fromDeck.observation.players[0].revealedTop, undefined);
});

test('physical source is independent of candidate target and copied ability donor', () => {
  const o = observation(),
    physical = card('physical', { armor: 2 }),
    target = card('target', { armor: 9 }, 1),
    donor = card('donor', { armor: 7 });
  o.players[0].battleline = [physical, donor];
  o.players[1].battleline = [target];
  exact(
    { sourceArmor: true },
    context(o, donor, {
      action: { kind: 'use', card: physical.id, ability: 'action' },
      target,
    }),
    2,
  );
  exact({ sourceArmor: true }, context(o, physical, { target }), 2);
});

test('current-step bindings distinguish absence from empty and never borrow pending amount', () => {
  const o = observation(),
    source = card('source', { armor: 2, traits: ['human', 'giant'] });
  o.players[0].battleline = [source];
  assert.equal(evaluatePublicValue({ bindingCount: 'chosen' }, context(o)).kind, 'unknown');
  exact({ bindingCount: 'chosen' }, context(o, source, { bindings: new Map([['chosen', []]]) }), 0);
  const ctx = context(o, source, {
    bindings: new Map([['chosen', [source]]]),
    scalarBindings: new Map([['stored', 8]]),
  });
  exact({ bindingCount: 'chosen' }, ctx, 1);
  exact({ bindingTraits: 'chosen' }, ctx, 2);
  exact({ storedValue: 'stored' }, ctx, 8);
  o.pending = { amount: 99 };
  assert.equal(evaluatePublicValue({ eventAmount: true }, ctx).kind, 'unknown');
  exact({ eventAmount: true }, { ...ctx, eventAmount: 4 }, 4);
  assert.equal(evaluatePublicValue({ maximumBoundHouseCount: 'chosen' }, ctx).kind, 'unknown');
});

test('resolved traits stay authoritative instead of discarding original traits for copied traits', () => {
  const o = observation(),
    source = card('copy', { traits: ['human', 'giant'] });
  source.copiedCharacteristics = { traits: ['giant'] };
  o.players[0].battleline = [source];
  exact({ bindingTraits: 'x' }, context(o, source, { bindings: new Map([['x', [source]]]) }), 2);
  exact({ count: { side: 'friendly', trait: 'human' } }, context(o), 1);
  exact({ count: { side: 'friendly', trait: 'giant' } }, context(o), 1);
});

test('haunted fallback uses the ten-card total and includes enabled upgrade text', () => {
  const o = observation(),
    upgrade = card('haunted-upgrade', {
      kind: 'upgrade',
      hauntedWithPurged: true,
    });
  o.players[0].upgrades = [upgrade];
  o.players[0].purged = [card('purged')];
  exact({ haunted: true }, context(o), 0);
  o.players[0].discard = Array.from({ length: 9 }, (_, i) => card('discard-' + i));
  exact({ haunted: true }, context(o), 1);
});

test('usedCreatureCount defaults to distinct identities; false counts every use', () => {
  const o = observation();
  o.creatureUseHistory = [
    { actor: 0, houses: ['mars'], traits: ['human'], distinctKey: 1 },
    { actor: 0, houses: ['mars'], traits: ['human'], distinctKey: 1 },
    { actor: 0, houses: ['mars'], traits: ['human'], distinctKey: 2 },
  ];
  exact({ usedCreatureCount: { side: 'self', house: 'mars' } }, context(o), 2);
  exact({ usedCreatureCount: { side: 'self', house: 'mars', distinct: false } }, context(o), 3);
});

test('incomplete histories and unavailable private frame quantities do not silently become zero', () => {
  const o = observation(),
    source = card('source');
  o.players[0].battleline = [source];
  o.publicStateCoverage = { turnHistoryComplete: false, effectsComplete: true };
  for (const formula of [
    { metric: 'playedThisTurn' },
    { sourceUsesThisTurn: true },
    { friendlyExaltedThisTurn: true },
    { stolenThisTurn: true },
    { wasStolenFromPreviousTurn: true },
    { creatureFightsThisTurn: true },
    { usedCreatureCount: { side: 'self' } },
    { friendlyDestroyedThisTurn: true },
    { enemyDestroyedThisTurn: true },
    { drawnInDrawStep: true },
  ])
    assert.equal(
      evaluatePublicValue(formula, context(o, source)).kind,
      'unknown',
      JSON.stringify(formula),
    );
  exact({ metric: 'amber' }, context(o, source), 0);
  exact({ count: { side: 'friendly' } }, context(o, source), 1);
});

test('public projection overrides retain sequence pools and identify uncertain source fields', () => {
  const o = observation(),
    source = card('source');
  o.players[0].battleline = [source];
  const ctx = context(o, source, {
    resolveLeaf: (value) =>
      'metric' in value && value.metric === 'amber' ? exactPublicValue(7) : undefined,
    projection: {
      uncertainCardFields: new Map([[source.id, new Set(['damage', 'captured'])]]),
    },
  });
  exact({ subtract: [{ metric: 'amber' }, 2] }, ctx, 5);
  assert.equal(evaluatePublicValue({ sourceDamage: true }, ctx).kind, 'unknown');
  interval(evaluatePublicValue({ count: { side: 'friendly', damaged: true } }, ctx), 0, 1);
  interval(evaluatePublicValue({ count: { side: 'friendly', withAmber: true } }, ctx), 0, 1);
});

test('core arithmetic clamps subtraction and preserves explicit negate and rounding', () => {
  exact({ subtract: [2, 5] }, undefined, 0);
  exact({ negate: 3 }, undefined, -3);
  exact({ half: 5 }, undefined, 2);
  exact({ ceilHalf: 5 }, undefined, 3);
  exact({ floorThird: 5 }, undefined, 1);
  exact({ ceilThird: 5 }, undefined, 2);
  exact({ add: [1, { subtract: [7, 3] }, { atMost: 2, value: 9 }] }, undefined, 7);
});

test('explicit random outcomes are transformed before expectation for caps, subtraction and rounding', () => {
  const o = observation(),
    draw = expectedPublicValue(
      [
        { value: 0, probability: 0.5 },
        { value: 4, probability: 0.5 },
      ],
      ['public-uniform-choice'],
    );
  const ctx = context(o, undefined, { lastAmount: draw });
  const capped = evaluatePublicValue({ atMost: 2, value: { lastAmount: true } }, ctx);
  assert.equal(capped.kind, 'expected');
  assert.equal(capped.expected, 1);
  const subtracted = evaluatePublicValue({ subtract: [{ lastAmount: true }, 2] }, ctx);
  assert.equal(subtracted.kind, 'expected');
  assert.equal(subtracted.expected, 1);
  const rounded = evaluatePublicValue(
    { half: { lastAmount: true } },
    {
      ...ctx,
      lastAmount: expectedPublicValue([
        { value: 1, probability: 0.5 },
        { value: 3, probability: 0.5 },
      ]),
    },
  );
  assert.equal(rounded.kind, 'expected');
  assert.equal(rounded.expected, 0.5);
  const condition = evaluatePublicCondition(
    { left: { lastAmount: true }, comparison: 'gte', right: 3 },
    ctx,
  );
  assert.equal(condition.kind, 'unknown');
  assert.equal(condition.probability, 0.5);
});

test('correlated uncertain inputs are never fabricated as independent random draws', () => {
  const random = expectedPublicValue([
    { value: 0, probability: 0.5 },
    { value: 4, probability: 0.5 },
  ]);
  const result = evaluatePublicValue(
    { subtract: [{ lastAmount: true }, { lastAmount: true }] },
    context(observation(), undefined, { lastAmount: random }),
  );
  assert.ok(
    result.kind === 'interval' ||
      result.kind === 'unknown' ||
      (result.kind === 'exact' && result.value === 0),
  );
  assert.notEqual(result.kind, 'expected');
});

test('current semantic flags do not cache dynamic results by immutable card alone', () => {
  const effect = Object.freeze({
    kind: 'steal',
    amount: Object.freeze({
      count: Object.freeze({ side: 'friendly', house: 'mars', ready: true }),
    }),
  });
  const spec = Object.freeze(
    definition({ abilities: Object.freeze({ play: Object.freeze([effect]) }) }),
  );
  const o = observation();
  assert.equal(cardSemanticFeatures(spec, 'play', context(o)).amberControl, false);
  o.players[0].battleline.push(card('ready'));
  assert.equal(cardSemanticFeatures(spec, 'play', context(o)).amberControl, true);
  o.players[0].battleline[0].ready = false;
  assert.equal(cardSemanticFeatures(spec, 'play', context(o)).amberControl, false);
});

test('later semantic conditions never select a false branch from a stale pre-instruction pool', () => {
  const o = observation();
  o.players[0].amber = 5;
  const spec = definition({
    abilities: {
      play: [
        { kind: 'gain', amount: 1 },
        {
          kind: 'if',
          condition: { left: { metric: 'amber' }, comparison: 'gte', right: 6 },
          then: [{ kind: 'draw', amount: 1 }],
        },
      ],
    },
  });
  const result = cardSemanticFeatures(spec, 'play', context(o));
  assert.equal(result.draw, true);
  assert.equal(result.conditional, true);
  assert.ok(
    result.unknownKinds.some((reason) => reason.includes('earlier-instruction-needs-projection')),
  );
  const unaffected = definition({
    abilities: {
      play: [
        { kind: 'gain', amount: 1 },
        {
          kind: 'steal',
          amount: { count: { side: 'friendly', house: 'mars' } },
        },
      ],
    },
  });
  assert.equal(cardSemanticFeatures(unaffected, 'play', context(o)).amberControl, false);
});

test('unsupported formulas, filters and cyclic trees remain explicit rather than fabricated facts', () => {
  const o = observation();
  o.players[0].battleline = [card('possible')];
  assert.equal(evaluatePublicValue({ unknownFormula: true }, context(o)).kind, 'unknown');
  interval(selectPublicCards({ side: 'friendly', notARealFilter: true }, context(o)).count, 0, 1);
  const cycle = {};
  cycle.add = [cycle];
  assert.equal(evaluatePublicValue(cycle, context(o)).kind, 'unknown');
  const flags = cardSemanticFeatures(
    definition({
      abilities: {
        play: [{ kind: 'steal', amount: { unknownFormula: true } }],
      },
    }),
  );
  assert.equal(flags.amberControl, false);
  assert.equal(flags.unknown, true);
});

test('after-use records the current creature with correct public ordinal mapping and clears unstun', () => {
  const o = observation(),
    a = card('a'),
    b = card('b');
  b.stunned = true;
  o.players[0].battleline = [a, b];
  o.creatureUseHistory = [
    { actor: 0, houses: ['mars'], traits: [], distinctKey: 0 },
    { actor: 0, houses: ['mars'], traits: [], distinctKey: 0 },
    { actor: 0, houses: ['mars'], traits: [], distinctKey: 2 },
  ];
  o.publicCounters.creaturesUsed = [
    { use: 1, currentCard: a.id },
    { use: 2, currentCard: b.id },
  ];
  const ctx = context(o, b, { phase: 'after-use', action: { kind: 'unstun', card: b.id } });
  exact({ usedCreatureCount: { side: 'self' } }, ctx, 2);
  exact({ usedCreatureCount: { side: 'self', distinct: false } }, ctx, 4);
  exact({ metric: 'uniqueCreaturesUsed' }, ctx, 2);
  exact({ count: { sourceOnly: true, stunned: true } }, ctx, 0);
  exact({ sourceUsesThisTurn: true }, ctx, 1);
  const prepared = projectPublicFormulaContext(ctx);
  assert.equal(prepared.observation.creatureUseHistory.at(-1).distinctKey, 2);
  assert.equal(o.creatureUseHistory.length, 3);
  assert.equal(b.stunned, true);
});

test('neighbor ready entry requires receiving player high tide', () => {
  const o = observation(),
    provider = card('neighbor', { readyEnteringNeighbors: true }),
    source = card('new');
  o.players[0].battleline = [provider];
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  const ctx = context(o, source, {
    phase: 'after-play',
    action: { kind: 'play', card: source.id, flank: 'right' },
  });
  o.tide = { highFor: 1 };
  exact({ count: { sourceOnly: true, ready: true } }, ctx, 0);
  o.tide.highFor = null;
  exact({ count: { sourceOnly: true, ready: true } }, ctx, 0);
  o.tide.highFor = 0;
  exact({ count: { sourceOnly: true, ready: true } }, ctx, 1);
});

test('Mimic Gel copies public printed characteristics while keeping its physical identity and Logos house', () => {
  const gelSpec = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Mimic Gel');
  const trollSpec = Object.values(ALL_DEFINITIONS).find((d) => d.name === 'Troll');
  assert.ok(gelSpec && trollSpec);
  const o = observation(),
    source = card('gel', gelSpec),
    donor = card('troll', trollSpec, 1);
  donor.effective.power += 5;
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  o.players[1].battleline = [donor];
  const ctx = context(o, source, {
    phase: 'after-play',
    action: { kind: 'play', card: source.id, copy: donor.id, flank: 'right' },
  });
  exact({ sourcePower: true }, ctx, trollSpec.power);
  const prepared = projectPublicFormulaContext(ctx);
  assert.equal(prepared.source.id, 'gel');
  assert.equal(prepared.source.definition, gelSpec.id);
  assert.equal(prepared.source.effective.house, 'logos');
  assert.equal(prepared.source.spec.id, trollSpec.id);
});

test('intrinsic entry formulas use current board and receiving controller for their own modifiers', () => {
  const o = observation(),
    ally = card('ally'),
    enemyA = card('enemy-a', {}, 1),
    enemyB = card('enemy-b', {}, 1);
  const source = card('formula-entrant', {
    power: 2,
    armor: 1,
    entersOpponentControl: true,
    powerBonus: { count: { side: 'friendly' } },
    armorBonusValue: { count: { side: 'friendly', ready: true } },
  });
  o.players[0].battleline = [ally];
  o.players[1].battleline = [enemyA, enemyB];
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  const ctx = context(o, source, {
    phase: 'after-play',
    action: { kind: 'play', card: source.id, flank: 'right' },
  });
  exact({ sourcePower: true }, ctx, 5);
  exact({ sourceArmor: true }, ctx, 3);
});

test('withValue scalar snapshots and random binding wrappers preserve structured capability', () => {
  const o = observation();
  o.players[0].hand = [card('sample')];
  o.players[0].handCount = 1;
  const scalar = definition({
    abilities: {
      play: [
        {
          kind: 'withValue',
          value: { count: { side: 'friendly' } },
          bind: 'x',
          then: [{ kind: 'gain', amount: { storedValue: 'x' } }],
        },
      ],
    },
  });
  assert.equal(cardSemanticFeatures(scalar, 'play', context(o)).gain, false);
  o.players[0].battleline.push(card('in-play'));
  assert.equal(cardSemanticFeatures(scalar, 'play', context(o)).gain, true);
  const random = definition({
    abilities: {
      play: [
        {
          kind: 'randomCard',
          side: 'self',
          zone: 'hand',
          bind: 'x',
          then: [{ kind: 'draw', amount: { bindingCount: 'x' } }],
        },
      ],
    },
  });
  const result = cardSemanticFeatures(random, 'play', context(o));
  assert.equal(result.draw, true);
  assert.equal(result.conditional, true);
  o.players[0].hand = [];
  o.players[0].handCount = 0;
  assert.equal(cardSemanticFeatures(random, 'play', context(o)).draw, false);
});

test('formula budget stops before reading the next wide-tree getter', () => {
  const add = Array(5000).fill(1);
  Object.defineProperty(add, 4096, {
    get() {
      throw Error('read past formula budget');
    },
  });
  const result = evaluatePublicValue({ add });
  assert.equal(result.kind, 'unknown');
  assert.ok(result.reasons.includes('formula-budget'));
});

test('binding scalar properties use current public faces while controller receipts retain selection-time control', () => {
  const o = observation(),
    old = card('bound', { kind: 'artifact', name: 'Old', traits: ['human'], amber: 2 });
  const live = card('bound', { kind: 'creature', name: 'Live', traits: ['giant'], amber: 0 }, 1);
  live.resolvedBonusIcons = [];
  const candidate = card('candidate', { name: 'Live', traits: ['giant'], power: 8 });
  o.players[0].battleline = [candidate];
  o.players[1].battleline = [live];
  const ctx = context(o, candidate, {
    bindings: new Map([['x', [old]]]),
    lastKnownPower: new Map([['x:bound', 8]]),
  });
  exact({ bindingBonusSum: 'x' }, ctx, 0);
  exact({ bindingControllerCount: 'x', side: 'self' }, ctx, 1);
  exact({ count: { side: 'friendly', sharesTraits: 'x' } }, ctx, 1);
  exact({ count: { side: 'friendly', sameNameBinding: 'x' } }, ctx, 1);
  exact({ count: { side: 'friendly', sameKindBinding: 'x' } }, ctx, 1);
  exact({ count: { side: 'friendly', powerMatchesBinding: 'x' } }, ctx, 1);
});

test('pending capture assignment preserves captured-dependent power uncertainty until publicly determined', () => {
  const o = observation(),
    source = card('yxili', ALL_DEFINITIONS['yxili-marauder']);
  source.bonusIcons = ['capture'];
  o.players[0].hand = [source];
  o.players[0].handCount = 1;
  o.players[0].battleline = [card('other-recipient')];
  o.players[1].amber = 1;
  const ctx = context(o, source, {
    phase: 'after-play',
    action: { kind: 'play', card: source.id, flank: 'right' },
  });
  const unresolved = evaluatePublicValue({ sourcePower: true }, ctx);
  assert.notEqual(
    unresolved.kind,
    'exact',
    'the capture may be placed on either friendly recipient',
  );
  exact(
    { sourcePower: true },
    { ...ctx, resolveLeaf: (value) => ('sourceAmber' in value ? exactPublicValue(1) : undefined) },
    3,
  );
  source.bonusIcons = [];
  exact({ sourcePower: true }, ctx, 2);
});
