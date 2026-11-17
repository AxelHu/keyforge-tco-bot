import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { cardSemanticFeatures } from '../../dist/src/knowledge/semantic-features.js';
import { assessAlgorithm, rankAlgorithm } from '../../dist/src/ai/algorithm-policies.js';
import { COMPETITIVE_PROFILES, rankCompetitive } from '../../dist/src/ai/competitive-policy.js';
import { STYLES, rankStyled } from '../../dist/src/ai/persona-styles.js';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';

const structured = { contextualEffects: true, publicHouseChoices: true, targetIntent: true };
function definition(extra = {}) {
  return {
    id: 'semantic-fixture',
    name: 'Semantic fixture',
    house: 'logos',
    kind: 'action',
    power: 0,
    armor: 0,
    amber: 0,
    traits: [],
    summary: 'same display text',
    ...extra,
  };
}
function features(effects, extra = {}, scope = 'any') {
  return cardSemanticFeatures(definition({ abilities: { play: effects }, ...extra }), scope);
}
function card(id, spec, controller = 0) {
  return {
    id,
    definition: spec.id,
    spec,
    owner: controller,
    controller,
    ready: true,
    damage: 0,
    armorUsed: 0,
    elusiveUsed: false,
    captured: 0,
    stunned: false,
    powerCounters: 0,
    attachedTo: null,
    enteredController: controller,
    foreignArchiveHolder: null,
    printedHouse: spec.house,
    effective: {
      house: spec.house,
      power: spec.power,
      armor: spec.armor,
      keywords: spec.keywords ?? [],
      assault: spec.assault ?? 0,
      hazardous: spec.hazardous ?? 0,
    },
    usesThisTurn: 0,
  };
}
function observation() {
  const player = (name) => ({
    name,
    houses: ['brobnar', 'dis', 'logos'],
    activePlayer: name === 'alpha',
    activeHouse: null,
    phase: 'main',
    optionSettings: { confirmOneClick: true },
    stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 30,
    numArchivesCards: 0,
    buttons: [],
    controls: [],
  });
  const alpha = player('alpha'),
    beta = player('beta');
  alpha.menuTitle = 'Choose Active House';
  alpha.controls = [{ type: 'house-select', houses: ['brobnar', 'dis', 'logos'] }];
  alpha.buttons = alpha.houses.map((house) => ({ text: house, uuid: 'house-' + house, arg: house }));
  const o = projectKeytekiState(
    {
      id: 'structured-semantic-fixture',
      started: true,
      manualMode: false,
      players: { alpha, beta },
      messages: [],
    },
    { playerName: 'alpha', revision: 1, turn: 3 },
  ).observation;
  delete o.publicStateCoverage;
  o.phase = 'main';
  return o;
}
function rewriteDisplay(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(rewriteDisplay);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'summary' || key === 'label'
        ? '任意显示文字 / completely unrelated display'
        : key === 'summaryFeatures'
          ? 4095
          : rewriteDisplay(child),
    ]),
  );
}
function scores(rows) {
  return rows.map(({ actionId, score, estimatedAmber, projectedKey, deniesKey }) => ({
    actionId,
    score,
    estimatedAmber,
    projectedKey,
    deniesKey,
  }));
}
function choiceFixture(effects, intent) {
  const o = observation();
  o.phase = 'choice';
  o.resolving = [card('source', definition({ abilities: { play: effects } }))];
  o.pending = {
    kind: 'option',
    actor: 0,
    source: 'source',
    amount: 0,
    reward: 0,
    label: 'unrelated current display',
    options: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    intent,
  };
  o.legalActions = ['a', 'b'].map((option) => ({
    id: 'choose:' + option,
    action: { kind: 'choose', option },
  }));
  return o;
}
const choice = (amount, label = 'same caption') => ({
  kind: 'choose',
  label,
  options: [
    { key: 'a', label: 'first', effects: [{ kind: 'gain', amount }] },
    { key: 'b', label: 'second', effects: [{ kind: 'gain', amount: 0 }] },
  ],
});

// All released definitions are checked, so a rare card's display field cannot
// silently remain a dependency even if the small tactical fixtures do not use it.
test('every built-in static feature is invariant to summary, labels and legacy masks', () => {
  for (const spec of Object.values(ALL_DEFINITIONS)) {
    const edited = rewriteDisplay(spec);
    edited.summaryFeatures = 4095;
    for (const scope of ['any', 'play', 'use'])
      assert.deepEqual(
        cardSemanticFeatures(edited, scope),
        cardSemanticFeatures(spec, scope),
        spec.id + ':' + scope,
      );
  }
});

test('beneficiary and capture funding are derived from operations, not identical prose', () => {
  assert.equal(
    features([{ kind: 'resource', operation: 'steal', side: 'self', amount: 1 }]).amberControl,
    true,
  );
  assert.equal(
    features([{ kind: 'resource', operation: 'steal', side: 'opponent', amount: 1 }]).amberControl,
    false,
  );
  assert.equal(features([{ kind: 'resource', operation: 'draw', side: 'opponent', amount: 2 }]).draw, false);
  assert.equal(
    features([{ kind: 'resource', operation: 'lose', side: 'self', amount: 2 }]).amberControl,
    false,
  );
  for (const [operation, side, expected] of [
    ['capture', 'friendly', true],
    ['capture', 'enemy', false],
    ['captureOwn', 'friendly', false],
    ['captureOwn', 'enemy', true],
  ]) {
    const value = features([{ kind: 'target', filter: { side }, operation, amount: 1 }]);
    assert.equal(value.amberControl, expected, operation + ':' + side);
    assert.equal(value.gain, false, 'captured amber is not spendable pool income');
  }
  const sourceCapture = features([
    { kind: 'asPlayer', side: 'opponent', effects: [{ kind: 'capture', amount: 1 }] },
  ]);
  assert.equal(sourceCapture.amberControl, true, 'changing actor does not change the source controller');
  assert.equal(
    features([{ kind: 'asPlayer', side: 'opponent', effects: [{ kind: 'gain', amount: 1 }] }]).gain,
    false,
  );
});

test('structured binding, trigger and quantity semantics preserve relevant distinctions', () => {
  const bound = (side) =>
    features([
      {
        kind: 'chooseCards',
        bind: 'picked',
        max: 1,
        filter: { side },
        then: [{ kind: 'bound', key: 'picked', operation: 'destroy' }],
      },
    ]);
  assert.equal(bound('enemy').boardControl, true);
  assert.equal(bound('friendly').boardControl, false);
  assert.equal(
    features([{ kind: 'target', filter: { side: 'enemy' }, operation: 'damage', amount: 0 }]).boardControl,
    false,
  );
  assert.equal(
    features([{ kind: 'target', filter: { side: 'enemy' }, operation: 'destroy', amount: 0 }]).boardControl,
    true,
  );
  const healing = features([{ kind: 'self', operation: 'heal', amount: 0, fullHeal: true }]);
  assert.equal(healing.heal, true);
  assert.equal(healing.fullHeal, true);
  const spec = definition({
    kind: 'creature',
    abilities: { reap: [{ kind: 'steal', amount: 1 }], destroyed: [{ kind: 'forgeEffect', fixedCost: 0 }] },
  });
  assert.equal(cardSemanticFeatures(spec, 'play').amberControl, false);
  assert.equal(cardSemanticFeatures(spec, 'use').amberControl, true);
  assert.equal(cardSemanticFeatures(spec, 'use').forge, false);
  assert.equal(cardSemanticFeatures(spec).forge, true);
  assert.equal(cardSemanticFeatures(spec).conditional, true);
  assert.equal(
    features([{ kind: 'permission', mode: 'play', filter: { side: 'friendly' } }]).readyUse,
    false,
  );
});

test('unknown wrappers, formulas and unmodeled effects are not fabricated benefits or known zeroes', () => {
  for (const effect of [
    { kind: 'futureSpecialMechanism', then: [{ kind: 'steal', amount: 3 }] },
    { kind: 'steal', amount: { unseenCounter: true } },
    { kind: 'steal', amount: 3, unmodeled: true },
  ]) {
    const result = features([effect]);
    assert.equal(result.amberControl, false);
    assert.equal(result.unknown, true);
    assert.ok(result.unknownKinds.length > 0);
  }
  assert.equal(features([{ kind: 'steal', amount: 0 }]).unknown, false);
  const unsupportedField = features([], { futureStaticMechanism: true });
  assert.deepEqual(unsupportedField.unknownFields, ['futureStaticMechanism']);
  const conditional = features([
    { kind: 'if', condition: { futureCondition: true }, then: [{ kind: 'steal', amount: 1 }] },
  ]);
  assert.equal(conditional.amberControl, true, 'flag describes a conditional potential');
  assert.equal(conditional.conditional, true);
});

test('only deeply immutable definitions are memoized', () => {
  const mutable = definition({ abilities: { play: [{ kind: 'steal', amount: 1 }] } });
  const first = cardSemanticFeatures(mutable);
  mutable.abilities.play[0] = { kind: 'resource', operation: 'steal', side: 'opponent', amount: 1 };
  assert.equal(first.amberControl, true);
  assert.equal(cardSemanticFeatures(mutable).amberControl, false);
  const shallow = Object.freeze(definition({ abilities: { play: [{ kind: 'draw', amount: 1 }] } }));
  assert.equal(cardSemanticFeatures(shallow).draw, true);
  shallow.abilities.play.length = 0;
  assert.equal(cardSemanticFeatures(shallow).draw, false);
  const frozen = ALL_DEFINITIONS.troll;
  assert.strictEqual(cardSemanticFeatures(frozen), cardSemanticFeatures(frozen));
});

test('algorithm, competitive profiles and persona styles ignore display-only edits', () => {
  const o = observation();
  o.phase = 'house';
  o.players[0].hand = [
    card(
      'control',
      definition({ id: 'control', house: 'dis', abilities: { play: [{ kind: 'steal', amount: 1 }] } }),
    ),
    card(
      'draw',
      definition({ id: 'draw', house: 'logos', abilities: { play: [{ kind: 'draw', amount: 2 }] } }),
    ),
    card('blank', definition({ id: 'blank', house: 'brobnar' })),
  ];
  o.players[0].handCount = 3;
  o.legalActions = ['brobnar', 'dis', 'logos'].map((house) => ({
    id: house,
    action: { kind: 'house', house },
  }));
  const edited = rewriteDisplay(o);
  assert.deepEqual(scores(rankAlgorithm(edited)), scores(rankAlgorithm(o)));
  for (const profile of COMPETITIVE_PROFILES)
    assert.deepEqual(scores(rankCompetitive(edited, profile)), scores(rankCompetitive(o, profile)), profile);
  for (const style of STYLES) assert.deepEqual(rankStyled(edited, style), rankStyled(o, style), style);
});

test('unknown static rules do not receive the known-empty discard bonus', () => {
  const o = observation();
  o.players[0].hand = [
    card('empty', definition()),
    card(
      'unknown',
      definition({
        id: 'unknown',
        abilities: { play: [{ kind: 'futureSpecialMechanism' }] },
      }),
    ),
  ];
  o.players[0].handCount = 2;
  o.legalActions = ['empty', 'unknown'].map((card) => ({ id: card, action: { kind: 'discard', card } }));
  assert.ok(assessAlgorithm(o, 'empty').score > assessAlgorithm(o, 'unknown').score);
  assert.equal(assessAlgorithm(o, 'unknown').approximate, true);
});

test('emergency house hints do not mistake a hand creature Reap or a conditional effect for immediate Play denial', () => {
  const o = observation();
  o.players[1].keys = ['red', 'blue'];
  o.players[1].amber = o.players[1].forgeAvailable = 6;
  const body = { kind: 'creature', power: 4 };
  o.players[0].hand = [
    card(
      'reaper',
      definition({
        ...body,
        id: 'reaper',
        house: 'dis',
        abilities: { reap: [{ kind: 'steal', amount: 1 }] },
      }),
    ),
    card('blank', definition({ ...body, id: 'blank', house: 'logos' })),
    card(
      'conditional',
      definition({
        ...body,
        id: 'conditional',
        house: 'brobnar',
        abilities: {
          play: [{ kind: 'if', condition: { futureCondition: true }, then: [{ kind: 'steal', amount: 1 }] }],
        },
      }),
    ),
  ];
  o.players[0].handCount = 3;
  o.legalActions = ['dis', 'logos', 'brobnar'].map((house) => ({
    id: house,
    action: { kind: 'house', house },
  }));
  assert.equal(assessAlgorithm(o, 'dis').score, assessAlgorithm(o, 'logos').score);
  assert.equal(assessAlgorithm(o, 'brobnar').score, assessAlgorithm(o, 'logos').score);
});

test('actual capture and captureOwn choices use the target controller funding pool', () => {
  const o = observation(),
    body = definition({ kind: 'creature', power: 5 });
  o.players[0].amber = 2;
  o.players[1].amber = 5;
  o.players[0].battleline = [card('friendly', body)];
  o.players[1].battleline = [card('enemy', body, 1)];
  o.legalActions = ['friendly', 'enemy'].map((target) => ({
    id: target,
    action: { kind: 'select', target },
  }));
  o.pending = {
    kind: 'target',
    source: '',
    actor: 0,
    amount: 3,
    reward: 0,
    intent: { kind: 'target-operation', operation: 'capture' },
  };
  assert.ok(Math.abs(assessAlgorithm(o, 'friendly').score - 4.2) < 1e-9);
  assert.ok(Math.abs(assessAlgorithm(o, 'enemy').score + 2.8) < 1e-9);
  o.pending.intent.operation = 'captureOwn';
  assert.ok(Math.abs(assessAlgorithm(o, 'friendly').score + 2.8) < 1e-9);
  assert.ok(Math.abs(assessAlgorithm(o, 'enemy').score - 4.2) < 1e-9);
});

test('a target without current operation is not inferred from the source complete prose', () => {
  const o = observation(),
    body = definition({ kind: 'creature', power: 5 });
  o.resolving = [card('source', definition({ summary: 'Heal fully. Destroy a creature. Capture 3.' }))];
  o.players[0].battleline = [card('friendly', body)];
  o.players[1].battleline = [card('enemy', body, 1)];
  o.pending = { kind: 'target', source: 'source', actor: 0, amount: 3, reward: 0, label: 'Heal fully' };
  o.legalActions = ['friendly', 'enemy'].map((target) => ({
    id: target,
    action: { kind: 'select', target },
  }));
  for (const target of ['friendly', 'enemy']) {
    assert.equal(assessAlgorithm(o, target, 'tactical-v1', structured).score, 0);
    assert.equal(assessAlgorithm(o, target, 'tactical-v1', structured).approximate, true);
  }
  o.pending.intent = { kind: 'target-operation', operation: 'destroy' };
  assert.ok(
    assessAlgorithm(o, 'enemy', 'tactical-v1', structured).score >
      assessAlgorithm(o, 'friendly', 'tactical-v1', structured).score,
  );
});

test('choice locator disambiguates repeated option IDs and rejects invalid paths without label fallback', () => {
  const o = choiceFixture([choice(1), choice(5)], { kind: 'effect-choice', ability: 'play', path: [1] });
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).estimatedAmber[0], 5);
  assert.deepEqual(
    scores(rankAlgorithm(rewriteDisplay(o), 'tactical-v1', structured)),
    scores(rankAlgorithm(o, 'tactical-v1', structured)),
  );
  delete o.pending.intent;
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
  o.pending.intent = { kind: 'effect-choice', ability: 'play', path: [99] };
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
  o.pending.intent.path = ['__proto__', 'constructor'];
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
});

test('one exact external option structure remains usable without requiring an English caption', () => {
  const o = choiceFixture([choice(3)], undefined);
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).estimatedAmber[0], 3);
  o.pending.options[0].id = 'different-native-id';
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
});

test('hypothetical nested choices evaluate their own structure without a current prompt label', () => {
  const o = observation();
  const spec = definition({ abilities: { play: [choice(2, 'caption one'), choice(5, 'caption two')] } });
  o.players[0].hand = [card('play', spec)];
  o.players[0].handCount = 1;
  o.legalActions = [{ id: 'play', action: { kind: 'play', card: 'play' } }];
  assert.equal(assessAlgorithm(o, 'play', 'tactical-v1', structured).estimatedAmber[0], 7);
});

test('house continuation requires a locator and typed option house identity', () => {
  const houseEffect = {
    kind: 'chooseHouse',
    from: 'ownDeck',
    then: [
      { kind: 'gain', amount: { count: { zone: 'battleline', side: 'friendly', house: 'chosenHouse' } } },
    ],
  };
  const o = choiceFixture([houseEffect], {
    kind: 'house-choice',
    selection: { ability: 'play', path: [0] },
    options: [
      { id: 'a', house: 'brobnar' },
      { id: 'b', house: 'logos' },
    ],
  });
  o.pending.options = [
    { id: 'a', label: 'arbitrary A', house: 'brobnar' },
    { id: 'b', label: 'arbitrary B', house: 'logos' },
  ];
  o.players[0].battleline = [
    card('one', definition({ kind: 'creature', house: 'brobnar', power: 3 })),
    card('two', definition({ kind: 'creature', house: 'brobnar', power: 3 })),
    card('three', definition({ kind: 'creature', house: 'logos', power: 3 })),
  ];
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).estimatedAmber[0], 2);
  assert.equal(assessAlgorithm(o, 'choose:b', 'tactical-v1', structured).estimatedAmber[0], 1);
  delete o.pending.intent.selection;
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
  o.pending.intent.selection = { ability: 'play', path: [0] };
  o.pending.options[0].house = 'dis';
  assert.equal(assessAlgorithm(o, 'choose:a', 'tactical-v1', structured).score, 0);
});

test('selection locator distinguishes healing from destruction within the same source', () => {
  const selection = (operation) => ({
    kind: 'chooseCards',
    bind: 'picked',
    max: 1,
    optional: true,
    label: 'same display',
    filter: { side: 'any', zone: 'battleline' },
    then: [{ kind: 'bound', key: 'picked', operation, amount: 2 }],
  });
  const o = observation(),
    body = definition({ kind: 'creature', power: 5 });
  o.phase = 'choice';
  o.resolving = [
    card('source', definition({ abilities: { play: [selection('heal'), selection('destroy')] } })),
  ];
  o.players[0].battleline = [card('friendly', body)];
  o.players[1].battleline = [card('enemy', body, 1)];
  o.players[0].battleline[0].damage = o.players[1].battleline[0].damage = 2;
  o.pending = {
    kind: 'target',
    source: 'source',
    actor: 0,
    amount: 0,
    reward: 0,
    selected: [],
    min: 0,
    max: 1,
    label: 'not Choose cards',
    intent: { kind: 'effect-selection', ability: 'play', path: [1] },
  };
  o.legalActions = ['friendly', 'enemy'].map((target) => ({
    id: target,
    action: { kind: 'select', target },
  }));
  const assess = (target) => assessAlgorithm(o, target, 'tactical-v1', structured).score;
  assert.ok(assess('enemy') > assess('friendly'));
  o.pending.intent.path = [0];
  assert.ok(assess('friendly') > assess('enemy'));
  assert.deepEqual(
    scores(rankAlgorithm(rewriteDisplay(o), 'tactical-v1', structured)),
    scores(rankAlgorithm(o, 'tactical-v1', structured)),
  );
  o.pending.intent.path = [99];
  assert.equal(assess('friendly'), 0);
  assert.equal(assess('enemy'), 0);
});
