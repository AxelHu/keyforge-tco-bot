import { getPublicCaptureReference, getVerifiedVeilConfiguration, configurePublicCaptureFacts } from '../../dist/src/adapters/keyteki-public-capture-facts.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS, registerCardKnowledge, validateCardKnowledge, cardKnowledgeIsPartial, KNOWLEDGE_COVERAGE } from '../../dist/src/knowledge/catalog.js';
import { PRINTED_TEXT_BY_DEFINITION } from '../../dist/src/knowledge/printed-text.js';
import { guidedDeckRunway } from '../../dist/src/ai/tullibint-guided-policy.js';
import { TULLIBINT_CARDS } from '../../dist/src/ai/tullibint-policy.js';
import { assessPublicHouseDefense } from '../../dist/src/ai/public-house-defense.js';
import { buildJevInput } from '../../dist/src/ai/jev-input.js';
import { summaryFeature } from '../../dist/src/knowledge/text-features.js';
import { canonical } from '../../dist/src/shared/canonical.js';
import { projectKeytekiState, compileKeytekiCommand } from '../../dist/src/adapters/keyteki.js';
import { createCodePolicy, CODE_POLICY_IDS } from '../../dist/src/ai/code-strategies.js';
import { assessStyleUpgrade } from '../../dist/src/ai/style-policy-upgrades.js';
import { refillGuidanceStatus } from '../../dist/src/ai/public-guidance-guards.js';
import { StrategyController, strategyFrameHash } from '../../dist/src/ai/strategy-controller.js';

function nativeView() {
  const player = (name) => ({ name, houses: ['brobnar', 'dis', 'logos'], activePlayer: name === 'alpha', activeHouse: null, phase: 'main', optionSettings: { confirmOneClick: true }, stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 }, cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] }, numDeckCards: 30, numArchivesCards: 0, buttons: [], controls: [] });
  const alpha = player('alpha'), beta = player('beta');
  alpha.menuTitle = 'Choose Active House';
  alpha.controls = [{ type: 'house-select', houses: ['brobnar', 'dis', 'logos'] }];
  alpha.buttons = ['brobnar', 'dis', 'logos'].map(house => ({ text: house, uuid: 'house-' + house, arg: house }));
  return { id: 'synthetic-public-strategy', started: true, manualMode: false, players: { alpha, beta }, messages: [] };
}
function observation() {
  return projectKeytekiState(nativeView(), { playerName: 'alpha', revision: 1, turn: 3 }).observation;
}
function card(id, definition, owner = 0) {
  const spec = ALL_DEFINITIONS[definition];
  assert.ok(spec, 'known public metadata: ' + definition);
  return { id, definition, owner, controller: owner, ready: true, damage: 0, armorUsed: 0, elusiveUsed: false, captured: 0, stunned: false, powerCounters: 0, attachedTo: null, enteredController: owner, foreignArchiveHolder: null, printedHouse: spec.house, spec, effective: { house: spec.house, power: spec.power, armor: spec.armor, keywords: spec.keywords ?? [], assault: spec.assault ?? 0, hazardous: spec.hazardous ?? 0 }, usesThisTurn: 0 };
}

test('built-in knowledge is nonempty, immutable, and contains current specialist estimates', () => {
  assert.equal(Object.keys(ALL_DEFINITIONS).length, KNOWLEDGE_COVERAGE.cards);
  assert.ok(KNOWLEDGE_COVERAGE.cards > 100);
  for (const id of ['unity-prism', 'sir-jaune', 'they-tell-no-tales', 'infurnace']) {
    assert.ok(ALL_DEFINITIONS[id]);
    assert.ok(Object.isFrozen(ALL_DEFINITIONS[id]));
    assert.ok(ALL_DEFINITIONS[id].summary.length > 0);
    assert.notEqual(ALL_DEFINITIONS[id].summary, 'Heuristic card knowledge; printed rules text is not included.');
    assert.equal(ALL_DEFINITIONS[id].summaryFeatures, undefined);
    validateCardKnowledge(ALL_DEFINITIONS[id]);
  }
  assert.throws(() => { ALL_DEFINITIONS.troll = ALL_DEFINITIONS.urchin; }, /Read-only public knowledge/);
  assert.throws(() => { delete ALL_DEFINITIONS.troll; }, /Read-only public knowledge/);
  assert.equal(KNOWLEDGE_COVERAGE.omittedEffectNodes, 0);
  assert.equal(KNOWLEDGE_COVERAGE.generatedUnmodeledMarkers, 0);
  assert.equal(ALL_DEFINITIONS['kiri-giltspine'].unmodeled, undefined);
  assert.equal(ALL_DEFINITIONS['kiri-giltspine'].ruleInterpretations[0].status, 'research-convention');
  assert.equal(ALL_DEFINITIONS['kiri-giltspine'].ruleInterpretations[0].officialRulingConfirmed, false);
  assert.equal(cardKnowledgeIsPartial(ALL_DEFINITIONS['kiri-giltspine']), true);
  assert.equal(ALL_DEFINITIONS.silvertooth.entersReady, true);
  assert.equal(typeof ALL_DEFINITIONS['lava-ball'].abilities.play[0].splash, 'number');
  const filter = ALL_DEFINITIONS.chronometer.abilities.endTurn[1].then[0].then[0].then[0].then[0].filter;
  assert.equal(Object.hasOwn(filter, 'kind'), true);
  assert.equal(filter.kind, undefined);
});

test('knowledge extensions reject runtime continuation state, extra root fields, and atomic duplicate packs', () => {
  const base = { ...ALL_DEFINITIONS.troll, id: 'synthetic-owned-fact', name: 'Synthetic owned fact' };
  assert.throws(() => validateCardKnowledge({ ...base, abilities: { play: [{ kind: 'resumePaidUse', previous: null }] } }), /effect kind/);
  assert.throws(() => validateCardKnowledge({ ...base, queue: [] }), /Unknown card knowledge field/);
  for (const effect of [{ kind: 'target', filter: { side: 'enemy' }, operation: 'destroy' }, { kind: 'all', filter: {}, operation: 'damage', amount: 1 }, { kind: 'self', operation: 'heal', amount: 1 }, { kind: 'bound', key: 'public-choice', operation: 'purge' }])
    assert.doesNotThrow(() => validateCardKnowledge({ ...base, abilities: { play: [effect] } }));
  assert.throws(() => validateCardKnowledge({ ...base, abilities: { play: [null] } }), /effect object/);
  assert.throws(() => validateCardKnowledge({ ...base, abilities: { play: [{ kind: 'useChoice', mode: 'reap', filter: {}, after: [{ kind: 'resumePaidUse', previous: null }] }] } }), /effect kind/);
  assert.throws(() => registerCardKnowledge([base, base]), /Duplicate card knowledge/);
  assert.equal(ALL_DEFINITIONS[base.id], undefined);
  registerCardKnowledge([base]);
  assert.ok(ALL_DEFINITIONS[base.id]);
  assert.throws(() => registerCardKnowledge([base]), /Duplicate card knowledge/);
});

test('legacy summary predicates read original text and retain an explicit custom-mask override', () => {
  assert.equal(ALL_DEFINITIONS.troll.summaryFeatures, undefined);
  assert.equal(summaryFeature(ALL_DEFINITIONS.troll, 3), true);
  assert.equal(summaryFeature(ALL_DEFINITIONS.troll, 4), false);
  const c = { ...ALL_DEFINITIONS.troll, summary: 'Deliberately irrelevant authored description', summaryFeatures: (1 << 3) | (1 << 4) };
  assert.equal(summaryFeature(c, 3), true);
  assert.equal(summaryFeature(c, 4), true);
  assert.equal(summaryFeature(c, 6), false);
  assert.equal(summaryFeature(undefined, 3), false);
});

test('canonical serialization preserves explicit undefined and stable key order', () => {
  assert.equal(canonical({ z: undefined, a: 1 }), '{"a":1,"z":undefined}');
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }));
  assert.notEqual(canonical({ a: undefined }), canonical({}));
});

test('actual adapter uses only offered house actions and excludes opponent hidden faces', () => {
  const native = nativeView();
  native.players.beta.cardPiles.hand = [{ uuid: 'private-canary', id: 'troll', name: 'Troll' }];
  native.players.beta.cardPiles.archives = [{ uuid: 'private-archive', id: 'troll', name: 'Troll' }];
  const projected = projectKeytekiState(native, { playerName: 'alpha', revision: 2, turn: 3 });
  assert.equal(projected.observation.players[1].hand, undefined);
  assert.equal(projected.observation.players[1].archives, undefined);
  assert.ok(!JSON.stringify(projected.observation).includes('private-canary'));
  assert.deepEqual(projected.observation.legalActions.map(x => x.action.house).sort(), ['brobnar', 'dis', 'logos']);
  const choice = createCodePolicy('tactical-style-engine-v3')(projected.observation);
  assert.ok(projected.observation.legalActions.some(x => x.id === choice));
  assert.equal(compileKeytekiCommand(projected, choice, { revision: projected.observation.revision, fingerprint: projected.fingerprint }).message, 'menuButton');
});

test('unmapped visible faces remain unsupported instead of inventing a rule', () => {
  const native = nativeView();
  native.players.alpha.cardPiles.hand = [{ uuid: 'unmapped', id: 'not-in-knowledge-pack', name: 'Unmapped', canPlay: true }];
  const projected = projectKeytekiState(native, { playerName: 'alpha', revision: 1, turn: 3 });
  assert.ok(projected.unsupported.some(x => x.startsWith('unmapped-visible-card:')));
});

test('EngineV3 keeps real ranking and selects public ready amber before ending the turn', () => {
  const o = observation();
  o.phase = 'main'; o.activeHouse = 'brobnar'; o.pending = null;
  o.players[0].amber = 5; o.players[0].forgeAvailable = 5; o.players[0].keys = ['red', 'blue'];
  o.players[0].battleline = [card('ready-source', 'troll')];
  o.legalActions = [{ id: 'reap', action: { kind: 'reap', card: 'ready-source' } }, { id: 'end', action: { kind: 'endTurn' } }];
  const report = assessStyleUpgrade(o, 'tactical-style-engine-v3');
  assert.equal(report.selectedActionId, 'reap');
  assert.equal(createCodePolicy('tactical-style-engine-v3')(o), 'reap');
  assert.equal(report.ranked.length, 2);
  assert.ok(report.ranked.every(x => Number.isFinite(x.score)));
  assert.ok(CODE_POLICY_IDS.includes('tactical-card-aware-v3'));
  assert.ok(CODE_POLICY_IDS.includes('tactical-style-engine-v3'));
});

test('unmodeled before-refill hooks retain the conservative planning veto', () => {
  const o = observation();
  o.publicStateCoverage = { turnHistoryComplete: true, effectsComplete: true, turnOrdinalKnown: true };
  const c = card('uncertain-hook', 'troll');
  c.spec = { ...c.spec, abilities: { endReadyStep: [{ kind: 'unmodeled' }] } };
  o.players[0].battleline = [c];
  const report = refillGuidanceStatus(o);
  assert.equal(report.known, false);
  assert.ok(report.reasons.some(x => x.includes('endReadyStep')));
});

test('shared controller rejects injected hidden opponent zones before preparing', () => {
  const controller = new StrategyController({ codePolicy: 'tactical-style-engine-v3' });
  const o = observation(); o.players[1].hand = [];
  const frame = { matchId: 'synthetic-controller', observation: o };
  assert.equal(typeof strategyFrameHash(frame), 'string');
  assert.throws(() => controller.prepare(frame), /Opponent hidden zones/);
});

test('historical audited deck defaults are absent and invalid registration does not grant a scope', () => {
  assert.throws(() => getPublicCaptureReference(), /explicitly registered/);
  assert.throws(() => getVerifiedVeilConfiguration(), /explicitly registered/);
  assert.throws(() => configurePublicCaptureFacts({ referenceRules: { commit: 'unverified', sourceManifestSha256: '0'.repeat(64), serverDeploymentAttestation: false }, decks: {}, pairs: {} }), /Invalid local/);
  assert.throws(() => getPublicCaptureReference(), /explicitly registered/);
});

test('only actually consumed third-party text is separated and empty printed text stays empty', () => {
  assert.equal(Object.keys(PRINTED_TEXT_BY_DEFINITION).length, 108);
  assert.equal(Object.values(PRINTED_TEXT_BY_DEFINITION).filter(row => row.text.length > 0).length, 107);
  for (const [id, row] of Object.entries(PRINTED_TEXT_BY_DEFINITION)) {
    assert.equal(ALL_DEFINITIONS[id].summary, row.text);
    assert.equal(ALL_DEFINITIONS[id].sourceId, undefined, 'provenance is not injected into a card definition');
  }
  assert.equal(ALL_DEFINITIONS['toc-token-guardian'].summary, '');
  assert.equal(ALL_DEFINITIONS['woe-token-grunt'].summary, 'No additional printed abilities.');
});

test('model input receives original descriptions and unconfirmed research-convention labels', () => {
  const o = observation();
  o.players[0].hand = [card('model-troll', 'troll'), card('model-kiri', 'kiri-giltspine')];
  o.players[0].handCount = 2;
  const result = buildJevInput(o, 'baseline');
  assert.equal(result.state.hand[0].rules, 'After reaping, heal three damage from itself.');
  assert.deepEqual(result.state.hand[1].ruleInterpretations, ALL_DEFINITIONS['kiri-giltspine'].ruleInterpretations);
  assert.equal(result.state.hand[1].ruleInterpretations[0].officialRulingConfirmed, false);
});

test('Tullibint Survey keeps its inspect-top uncertainty in the actual guided runway helper', () => {
  const o = observation();
  o.phase = 'main'; o.pending = null; o.activeHouse = 'staralliance';
  o.players[0].houses = ['geistoid', 'staralliance', 'untamed'];
  o.players[0].deckList = Object.entries(TULLIBINT_CARDS).map(([definition, count]) => ({ definition, count, name: ALL_DEFINITIONS[definition].name, house: ALL_DEFINITIONS[definition].house }));
  o.players[0].hand = [card('survey-source', 'survey')]; o.players[0].handCount = 1;
  o.players[0].deckCount = 4;
  const action = { kind: 'play', card: 'survey-source' };
  o.legalActions = [{ id: 'survey-play', action }, { id: 'end', action: { kind: 'endTurn' } }];
  assert.equal(ALL_DEFINITIONS.survey.abilities.play[0].kind, 'inspectTop');
  const result = guidedDeckRunway(o, action);
  assert.equal(result.known, false, 'selective top-card information must not become a certified safe count');
});

test('Etans Jar retains the named-lock veto before public house-defense projections', () => {
  const o = observation();
  o.phase = 'house'; o.pending = null; o.activeHouse = null;
  o.publicStateCoverage = { turnHistoryComplete: true, effectsComplete: true, turnOrdinalKnown: true };
  o.players[0].hand = [card('charette-source', 'charette')]; o.players[0].handCount = 1;
  o.players[1].keys = ['red', 'blue']; o.players[1].amber = o.players[1].forgeAvailable = 6;
  let projections = 0;
  const project = () => { projections++; return { opponentAmber: 3, opponentKeyCost: 6, skipsOpponentForge: false, unresolvedValues: false }; };
  assert.ok(assessPublicHouseDefense(o, 'dis', project).score > 0, 'control fixture contains a real bounded defense opportunity');
  assert.ok(projections > 0);
  o.players[1].artifacts = [card('jar-source', 'etan-s-jar', 1)];
  projections = 0;
  assert.equal(assessPublicHouseDefense(o, 'dis', project).score, 0);
  assert.equal(projections, 0, 'the named-lock guard must veto the future-action probe');
});
