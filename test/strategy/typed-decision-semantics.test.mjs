import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';
import { rankForgeAware } from '../../dist/src/ai/forge-lock-policy.js';
import { rankSeason } from '../../dist/src/ai/season-policy.js';
import { rankTullibint, TULLIBINT_CARDS } from '../../dist/src/ai/tullibint-policy.js';

function observation() {
  const player = (name) => ({
    name,
    houses: ['brobnar', 'dis', 'logos'],
    activePlayer: name === 'alpha',
    activeHouse: null,
    phase: 'main',
    optionSettings: { confirmOneClick: true },
    stats: {
      amber: 0,
      chains: 0,
      keys: { red: false, blue: false, yellow: false },
      keyCost: 6,
    },
    cardPiles: {
      hand: [],
      archives: [],
      discard: [],
      purged: [],
      cardsInPlay: [],
    },
    numDeckCards: 30,
    numArchivesCards: 0,
    buttons: [],
    controls: [],
  });
  const alpha = player('alpha'),
    beta = player('beta');
  alpha.menuTitle = 'Choose Active House';
  alpha.buttons = alpha.houses.map((house, i) => ({
    text: house,
    icon: house,
    uuid: 'public-house-menu',
    arg: i,
  }));
  const o = projectKeytekiState(
    {
      id: 'typed-policy-witness',
      started: true,
      manualMode: false,
      players: { alpha, beta },
      messages: [],
    },
    { playerName: 'alpha', revision: 1, turn: 3 },
  ).observation;
  o.phase = 'choice';
  o.activeHouse = 'logos';
  o.pending = null;
  o.legalActions = [];
  return o;
}
function card(id, definition, owner = 0) {
  const spec = ALL_DEFINITIONS[definition];
  assert.ok(spec, 'known public card: ' + definition);
  return {
    id,
    definition,
    owner,
    controller: owner,
    ready: true,
    damage: 0,
    armorUsed: 0,
    elusiveUsed: false,
    captured: 0,
    stunned: false,
    powerCounters: 0,
    attachedTo: null,
    enteredController: owner,
    foreignArchiveHolder: null,
    printedHouse: spec.house,
    spec,
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
function choose(o, source, options, intent) {
  o.pending = {
    kind: 'option',
    actor: 0,
    source,
    amount: 0,
    reward: 0,
    label: 'Choose a house',
    options,
    ...(intent ? { intent } : {}),
  };
  o.legalActions = options.map((option) => ({
    id: 'choose-' + option.id,
    action: { kind: 'choose', option: option.id },
  }));
  return o;
}
function relabel(o) {
  const copy = structuredClone(o);
  copy.pending.label = '与规则无关的提示；显示文案可以替换';
  for (const option of copy.pending.options ?? []) option.label = '相同显示文字 / unrelated';
  for (const action of copy.legalActions) action.label = 'display only';
  return copy;
}
const scores = (rows) =>
  rows.map(({ actionId, score, projectedKey, deniesKey }) => ({
    actionId,
    score,
    projectedKey,
    deniesKey,
  }));

function houseSweep() {
  const o = observation(),
    source = card('visible-sweep', 'arise');
  // A deliberately synthetic public rule witness: choose the house of a visible forge lock to destroy.
  source.spec = {
    ...source.spec,
    id: 'synthetic-house-sweep',
    abilities: {
      play: [
        {
          kind: 'chooseHouse',
          then: [
            {
              kind: 'all',
              filter: { house: 'chosenHouse' },
              operation: 'destroy',
            },
          ],
        },
      ],
    },
  };
  o.resolving = [source];
  o.players[0].artifacts = [card('my-forge-lock', 'the-sting')];
  o.players[0].amber = 6;
  o.players[0].forgeAvailable = 6;
  o.players[0].keys = ['red', 'blue'];
  const options = [
    { id: 'opaque-a', label: 'Logos', house: 'shadows' },
    { id: 'opaque-b', label: 'Shadows', house: 'logos' },
  ];
  return choose(o, source.id, options, {
    kind: 'house-choice',
    options: options.map(({ id, house }) => ({ id, house })),
    selection: { ability: 'play', path: [0] },
  });
}

test('Forge-aware house scoring follows the current public continuation and opaque typed house IDs', () => {
  const o = houseSweep(),
    rank = (view) =>
      rankForgeAware(view, 'tactical', {
        publicHouseChoices: true,
        contextualEffects: true,
      });
  const rows = rank(o);
  assert.equal(
    rows[0].actionId,
    'choose-opaque-a',
    'destroy the real Shadows forge lock, regardless of the misleading label',
  );
  assert.deepEqual(scores(rank(relabel(o))), scores(rows));
  const noLocator = structuredClone(o);
  delete noLocator.pending.intent.selection;
  const invalidLocator = structuredClone(o);
  invalidLocator.pending.intent.selection.path = ['__proto__'];
  assert.deepEqual(
    scores(rank(invalidLocator)),
    scores(rank(noLocator)),
    'an invalid path cannot borrow a source-card continuation',
  );
  const mismatched = structuredClone(o);
  mismatched.pending.options[0].house = 'logos';
  const mismatchWithoutLocator = structuredClone(mismatched);
  delete mismatchWithoutLocator.pending.intent.selection;
  assert.deepEqual(
    scores(rank(mismatched)),
    scores(rank(mismatchWithoutLocator)),
    'conflicting machine option fields do not acquire lock-removal value',
  );
});

test('Seasonal prophecy flipping uses physical face operations instead of IDs or translated labels', () => {
  const o = observation();
  o.prophecies = [
    {
      id: 'physical-slot',
      owner: 0,
      faces: ['heads-i-win', 'tails-you-lose'],
      face: 0,
      active: true,
      count: 1,
      revealed: false,
    },
  ];
  choose(
    o,
    'unrelated-display-source',
    [
      { id: 'opaque-a', label: 'Flip to Tails You Lose' },
      { id: 'opaque-b', label: 'Keep current face' },
    ],
    {
      kind: 'prophecy-face-choice',
      slot: 'physical-slot',
      options: [
        { id: 'opaque-a', operation: 'keep' },
        { id: 'opaque-b', operation: 'flip' },
      ],
    },
  );
  const rows = rankSeason(o);
  assert.equal(rows[0].actionId, 'choose-opaque-b');
  assert.deepEqual(scores(rankSeason(relabel(o))), scores(rows));
  const swapped = structuredClone(o);
  swapped.pending.intent.options.reverse();
  swapped.pending.intent.options[0].id = 'opaque-a';
  swapped.pending.intent.options[1].id = 'opaque-b';
  assert.equal(
    rankSeason(swapped)[0].actionId,
    'choose-opaque-a',
    'the structured operation changes the selected physical action',
  );
});

for (const face of ['ask-again-later', 'trust-your-feelings']) {
  test('Seasonal ' + face + ' uses typed houses and exact public prophecy identity', () => {
    const o = observation(),
      owner = face === 'ask-again-later' ? 1 : 0;
    o.prophecies = [
      {
        id: 'physical-slot',
        owner,
        faces: [face, 'stars-aligned'],
        face: 0,
        active: true,
        count: 1,
        revealed: false,
      },
    ];
    o.players[1].revealedTop = card('revealed-top', 'mother', 1);
    o.players[1].battleline = [
      card('public-logos-a', 'mother', 1),
      card('public-logos-b', 'mother', 1),
    ];
    const options = [
      { id: 'opaque-a', label: 'Brobnar', house: 'logos' },
      { id: 'opaque-b', label: 'Logos', house: 'brobnar' },
    ];
    choose(o, 'physical-slot', options, {
      kind: 'house-choice',
      options: options.map(({ id, house }) => ({ id, house })),
    });
    const rows = rankSeason(o);
    assert.equal(rows[0].actionId, 'choose-opaque-a');
    assert.deepEqual(scores(rankSeason(relabel(o))), scores(rows));
    const unknown = structuredClone(o);
    delete unknown.pending.intent;
    assert.ok(
      rankSeason(unknown).every(
        (row) =>
          !row.reasons.some(
            (reason) => reason.startsWith('season: guess') || reason.startsWith('season: declare'),
          ),
      ),
      'a recognizable display string without typed house evidence does not enable the prophecy branch',
    );
  });
}

function cauldron() {
  const o = observation();
  o.players[0].deckList = Object.entries(TULLIBINT_CARDS).map(([definition, count]) => ({
    definition,
    count,
    house: ALL_DEFINITIONS[definition].house,
  }));
  o.players[0].houses = ['geistoid', 'staralliance', 'untamed'];
  o.activeHouse = 'untamed';
  const source = card('physical-cauldron', 'cauldron'),
    witch = card('held-witch', 'haunting-witch'),
    regrowth = card('held-regrowth', 'regrowth');
  o.players[0].artifacts = [source];
  o.underCards = [{ source: source.id, count: 2, cards: [regrowth, witch], faceUp: true }];
  return choose(
    o,
    source.id,
    [
      { id: 'opaque-a', source: regrowth.id, label: 'Haunting Witch' },
      { id: 'opaque-b', source: witch.id, label: 'Regrowth' },
    ],
    { kind: 'play-from-under' },
  );
}

test('Tullibint Cauldron choices bind to physical public under-cards, independent of prompt or button text', () => {
  const o = cauldron(),
    rows = rankTullibint(o);
  assert.equal(
    rows[0].actionId,
    'choose-opaque-b',
    'play Haunting Witch before the other held card',
  );
  assert.deepEqual(scores(rankTullibint(relabel(o))), scores(rows));
  const physicalIDs = structuredClone(o);
  for (const option of physicalIDs.pending.options) {
    option.id = option.source;
    delete option.source;
  }
  physicalIDs.legalActions = physicalIDs.pending.options.map((option) => ({
    id: 'choose-' + option.id,
    action: { kind: 'choose', option: option.id },
  }));
  assert.equal(
    rankTullibint(physicalIDs)[0].actionId,
    'choose-held-witch',
    'the local engine physical option IDs need no text bridge',
  );
  const unknown = structuredClone(o);
  delete unknown.pending.intent;
  unknown.pending.label = 'Cauldron: play a card';
  assert.deepEqual(scores(rankTullibint(relabel(unknown))), scores(rankTullibint(unknown)));
  const foreign = structuredClone(o);
  foreign.pending.options[1].source = 'card-not-held-here';
  const foreignWithoutMeaning = structuredClone(foreign);
  delete foreignWithoutMeaning.pending.intent;
  assert.equal(
    rankTullibint(foreign).find((row) => row.actionId === 'choose-opaque-b').score,
    rankTullibint(foreignWithoutMeaning).find((row) => row.actionId === 'choose-opaque-b').score,
    'an option source outside this artifact cannot receive its Cauldron play score',
  );
});

test('Tullibint direct Cauldron selections use the same structured current-step meaning', () => {
  const o = cauldron();
  o.pending.kind = 'target';
  delete o.pending.options;
  o.legalActions = ['held-regrowth', 'held-witch'].map((target) => ({
    id: 'select-' + target,
    action: { kind: 'select', target },
  }));
  assert.equal(rankTullibint(o)[0].actionId, 'select-held-witch');
  assert.deepEqual(scores(rankTullibint(relabel(o))), scores(rankTullibint(o)));
});
