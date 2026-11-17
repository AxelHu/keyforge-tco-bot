import test from 'node:test';
import assert from 'node:assert/strict';
import { knownRecoveredForge } from '../../dist/src/ai/recovery-forge.js';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';

const enabled = { publicRecoveryWindow: true };
function card(definition, id = definition, owner = 0) {
  const spec = structuredClone(ALL_DEFINITIONS[definition]);
  assert.ok(spec, definition);
  return { id, definition, owner, controller: owner, spec, ready: false, damage: 0, armorUsed: 0,
    elusiveUsed: false, captured: 0, stunned: false, powerCounters: 0, attachedTo: null,
    enteredController: owner, foreignArchiveHolder: null, usesThisTurn: 0,
    effective: { house: spec.house, power: spec.power, armor: spec.armor,
      keywords: spec.keywords ?? [], assault: spec.assault ?? 0, hazardous: spec.hazardous ?? 0 } };
}
function fixture(trigger = 'reap') {
  const source = card('witch-of-the-eye', 'source'), key = card('key-charge', 'key');
  const troll = card('troll', 'troll');
  source.usesThisTurn = 1;
  if (trigger === 'play') {
    source.definition = source.spec.id = 'public-recovery-source';
    source.spec.name = 'Public recovery source';
    source.spec.kind = 'action'; source.spec.power = source.effective.power = 0;
    source.spec.abilities = { play: source.spec.abilities.reap };
    source.usesThisTurn = 0;
  }
  const player = () => ({ houses: ['untamed', 'brobnar', 'dis'], amber: 0, keys: [], keyCost: 6,
    chains: 0, skipForgeTurn: null, lastForgedTurn: null, forgedOn: {}, forgeAvailable: 0,
    deckList: [], deckCount: 30, handCount: 0, archiveCount: 0, battleline: [], artifacts: [],
    upgrades: [], purged: [], discard: [] });
  const me = { ...player(), amber: 7, forgeAvailable: 7, keys: ['red', 'blue'], hand: [], archives: [],
    battleline: trigger === 'reap' ? [source] : [], discard: [key, troll] };
  const o = { schemaVersion: 2, engineVersion: 'public-recovery-fixture', rulesVersion: '18.4',
    catalogVersion: 'public-static-knowledge', revision: 1, turn: 3, you: 0, firstPlayer: 0,
    turnUsage: trigger === 'reap' ? { [source.spec.name]: 1 } : {}, handOperations: 0,
    playedThisTurn: 0, creaturesPlayedThisTurn: 0, activePlayer: 0, phase: 'choice',
    activeHouse: 'untamed', players: [me, player()],
    legalActions: [key, troll].map((c) => ({ id: `select:${c.id}`, action: { kind: 'select', target: c.id } })),
    resolving: trigger === 'play' ? [source] : [], promptCards: [key, troll], underCards: [],
    spanglerCards: [], controlLayers: [], nextReady: [], leaveEffects: [],
    publicCounters: { playedByHouse: {}, discardedHouses: [[], []], creaturesPlayedLastTurn: [0, 0],
      enemyFightDeaths: 0, creaturesUsed: trigger === 'reap' ? [{ use: 1, currentCard: source.id }] : [] },
    pending: { kind: 'target', source: source.id, actor: 0, amount: 0, reward: 0, min: 1, max: 1,
      selectedCount: 0, selected: [], intent: { kind: 'target-operation', operation: 'returnHand' } },
    lasting: [], knowledge: [], permissions: [], cardEffects: [], houseRestrictions: [],
    futureHouseRestrictions: [], winner: null };
  return { o, source, key, troll };
}
function proof(f, options = enabled) {
  const before = structuredClone(f.o);
  const result = knownRecoveredForge(f.o, f.key, f.o.players[0].amber, options);
  assert.deepEqual(f.o, before, 'recovery proof must not mutate the observation or award a key');
  return result;
}
function lasting(o, rule, extra = {}) {
  o.lasting.push({ source: 'public-control', actor: 1, appliesTo: 0, turn: o.turn, rule, amount: 0, ...extra });
}

test('single printed Reap recovery admits the public next-play third-key route only when enabled', () => {
  const f = fixture();
  assert.equal(knownRecoveredForge(f.o, f.key, 7), false, 'historical source mode stays unchanged');
  assert.equal(proof(f, {}), false);
  assert.equal(proof(f), true);
  assert.equal(f.o.players[0].keys.length, 2, 'the recovery is still not a forge');
  assert.equal(f.o.players[0].handCount, 0, 'the selected card is not already in hand');
  assert.equal(knownRecoveredForge(f.o, f.troll, 7, enabled), false);
});

test('a simple current Play recovery remains available in historical and strict modes', () => {
  const f = fixture('play');
  assert.equal(proof(f, {}), true);
  assert.equal(proof(f), true);
});

test('recovery proof follows structural rules and public identities, never display names or summaries', () => {
  const f = fixture();
  f.source.spec.name = 'Translated source'; f.source.spec.summary = 'Display text says nothing useful.';
  f.key.spec.name = 'Translated payload'; f.key.spec.summary = 'Display text is deliberately misleading.';
  f.o.turnUsage = { 'Translated source': 1 };
  assert.equal(proof(f), true);
});

test('noActions and noPlay prevent the following action even after a legal recovery prompt', () => {
  for (const rule of ['noActions', 'noPlay']) {
    const f = fixture(); lasting(f.o, rule);
    assert.equal(proof(f), false, rule);
  }
});

test('the recovered card must fit the current house and current public play restrictions', () => {
  const f = fixture(); f.o.activeHouse = 'dis';
  assert.equal(proof(f), false);
  const restricted = fixture(); lasting(restricted.o, 'onlyPlayHouse', { house: 'logos' });
  assert.equal(proof(restricted), false);
});

test('public forge blocking and Gold Key Imp forbid the third-key opportunity', () => {
  const blocked = fixture(); blocked.o.players[0].forgeBlocked = true;
  assert.equal(proof(blocked), false);
  const imp = fixture(); imp.o.players[1].battleline.push(card('gold-key-imp', 'imp', 1));
  assert.equal(proof(imp), false);
});

test('Murmook current tax is paid after the real Key Charge loss, not from the starting pool', () => {
  const f = fixture(); f.o.players[1].battleline.push(card('murmook', 'tax', 1));
  f.o.players[0].keyCost = 7;
  assert.equal(proof(f), false, 'seven minus one cannot pay a seven-amber key');
  f.o.players[0].amber = f.o.players[0].forgeAvailable = 8;
  assert.equal(proof(f), true);
});

test('Gravid Cycle and an already active Omega step never certify a subsequent normal play', () => {
  const f = fixture('play');
  const omega = card('gravid-cycle', 'source');
  f.o.resolving = [omega]; f.source = omega;
  assert.equal(proof(f), false);
  const step = fixture(); step.o.turnStep = { step: 3, performed: [1, 0], omega: true };
  assert.equal(proof(step), false);
});

test('remaining public play capacity and the first-turn hand operation limit are respected', () => {
  const f = fixture(); lasting(f.o, 'playLimit', { amount: 1 });
  f.o.playedThisTurn = 1;
  assert.equal(proof(f), false);
  f.o.playedThisTurn = 0;
  assert.equal(proof(f), true);
  const first = fixture(); first.o.turn = 1; first.o.handOperations = 1;
  assert.equal(proof(first), false);
});

test('Rule of Six and forbidden-name effects are not reset by changing zones', () => {
  const f = fixture(); f.o.turnUsage[f.key.spec.name] = 6;
  assert.equal(proof(f), false);
  f.o.turnUsage[f.key.spec.name] = 5;
  assert.equal(proof(f), true);
  lasting(f.o, 'noNamedPlayUse', { affectedName: f.key.spec.name });
  assert.equal(proof(f), false);
});

test('incomplete public counters or effect state never certify a hard future route', () => {
  for (const coverage of [
    { turnHistoryComplete: false, effectsComplete: true },
    { turnHistoryComplete: true, effectsComplete: false },
  ]) {
    const f = fixture(); f.o.publicStateCoverage = coverage;
    assert.equal(proof(f), false);
  }
  const complete = fixture();
  complete.o.publicStateCoverage = { turnHistoryComplete: true, effectsComplete: true };
  assert.equal(proof(complete), true);
});

test('foreign or ordinary archive exits do not masquerade as this discard-recovery proof', () => {
  for (const holder of [null, 0, 1]) {
    const f = fixture(); f.o.players[0].discard = [f.troll];
    f.o.players[0].archives = [f.key]; f.o.players[0].archiveCount = 1;
    f.key.foreignArchiveHolder = holder;
    assert.equal(proof(f), false, String(holder));
  }
  const stale = fixture(); stale.key.foreignArchiveHolder = 0;
  assert.equal(proof(stale), false, 'a contradictory retained archive marker is not a proven discard source');
  const foreign = fixture(); foreign.key.owner = 1;
  assert.equal(proof(foreign), false);
});

test('the prompt must be a fresh, singular, zero-reward recovery with no selected predecessor', () => {
  const changes = [
    (q) => { q.max = 2; }, (q) => { q.min = 0; }, (q) => { delete q.max; },
    (q) => { q.selected = ['earlier']; q.selectedCount = 1; },
    (q) => { q.amount = 1; }, (q) => { q.reward = 1; },
    (q) => { q.source = 'absent'; }, (q) => { q.kind = 'archive'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.o.pending);
    assert.equal(proof(f), false);
  }
});

test('advertised ability/path must agree with the unique terminal public source instruction', () => {
  const f = fixture(); f.o.pending.intent.selection = { ability: 'reap', path: [0] };
  assert.equal(proof(f), true);
  f.o.pending.intent.selection = { ability: 'play', path: [0] };
  assert.equal(proof(f), false);
  f.o.pending.intent.selection = { ability: 'reap', path: ['then', 0] };
  assert.equal(proof(f), false);
});

test('multiple instructions, after effects, mismatched filters and ambiguous source abilities remain unproven', () => {
  const changes = [
    (s) => { s.spec.abilities.reap.push({ kind: 'resource', operation: 'lose', amount: 7 }); },
    (s) => { s.spec.abilities.reap[0].after = { when: 'affected', effects: [{ kind: 'chains', amount: 1 }] }; },
    (s) => { s.spec.abilities.reap[0].max = 2; },
    (s) => { s.spec.abilities.reap[0].filter.kind = 'creature'; },
    (s) => { s.spec.abilities.reap[0].filter.zone = 'archives'; },
    (s) => { s.spec.abilities.play = structuredClone(s.spec.abilities.reap); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f.source);
    assert.equal(proof(f), false);
  }
});

test('copied, conditional, granted or unmodeled source and payload rules do not acquire certainty', () => {
  const changes = [
    (c) => { c.copiedDefinition = c.definition; },
    (c) => { c.spec.conditionalAbilities = [{ condition: { left: 1, comparison: 'eq', right: 1 }, abilities: {} }]; },
    (c) => { c.gainedTextBoxes = [structuredClone(c.spec)]; },
    (c) => { c.spec.grantsAbilities = [{ filter: { side: 'friendly' }, abilities: {} }]; },
    (c) => { c.spec.unmodeled = true; },
  ];
  for (const change of changes) for (const target of ['source', 'key']) {
    const f = fixture(); change(f[target]);
    assert.equal(proof(f), false, target);
  }
});

test('visible resolving callers and permanent use/copy continuations block a hard route', () => {
  const parent = fixture(); parent.o.resolving.push(card('inspiration', 'caller'));
  assert.equal(proof(parent), false);
  const actionParent = fixture('play'); actionParent.o.resolving.push(card('phase-shift', 'caller'));
  assert.equal(proof(actionParent), false);
  for (const kind of ['useChoice', 'copyReap', 'repeatPrinted', 'unmodeled']) {
    const f = fixture(); const caller = card('dominator-bauble', 'caller');
    caller.spec.abilities = { action: [{ kind, after: [{ kind: 'resource', operation: 'lose', amount: 7 }] }] };
    f.o.players[0].artifacts.push(caller);
    assert.equal(proof(f), false, kind);
  }
});

test('a Reap source requires current public use evidence and no unresolved grants or response windows', () => {
  const changes = [
    (f) => { f.source.ready = true; },
    (f) => { f.source.usesThisTurn = 0; },
    (f) => { f.o.publicCounters.creaturesUsed = []; },
    (f) => { f.o.publicCounters.creaturesUsed.push({ use: 2, currentCard: 'another' }); },
    (f) => { f.o.permissions = [{ id: 1, source: 'grant', mode: 'play', remaining: 1, uniqueRemaining: null, filter: {}, bound: null, used: [] }]; },
    (f) => { f.o.leaveEffects = [{ source: 'caller', actor: 0, effects: [] }]; },
    (f) => { f.o.prophecies = [{ id: 'slot', active: true }]; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal(proof(f), false);
  }
});

test('hidden opposing identities and stale revelation IDs are never consulted by the proof', () => {
  const f = fixture();
  f.o.players[1].hand = [card('inspiration', 'injected-hidden', 1)];
  f.o.players[1].archives = [card('phase-shift', 'injected-archive', 1)];
  f.o.knowledge = [{ historicalOnly: true, turn: 1, revision: 0, audience: 'all', label: 'Old reveal',
    cards: [{ id: f.source.id, definition: 'inspiration', name: 'Misleading old identity', owner: 1, zone: 'hand' }] }];
  assert.equal(proof(f), true);
});
