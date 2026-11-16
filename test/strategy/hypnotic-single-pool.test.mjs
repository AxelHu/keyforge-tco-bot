import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import jsondiffpatch from 'jsondiffpatch';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { canonical } from '../../dist/src/shared/canonical.js';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';
import { KeytekiAllocationTracker, prepareKeytekiAllocationPlan, validateKeytekiAllocationPlan } from '../../dist/src/adapters/keyteki-allocation.js';
import { configurePublicCaptureFacts } from '../../dist/src/adapters/keyteki-public-capture-facts.js';
import { StrategyController } from '../../dist/src/ai/strategy-controller.js';
import { KeytekiWireSession } from '../../tools/keyteki-wire-session.mjs';

const gameId = 'synthetic-hypnotic-single-pool', sourceId = 'played-hypnotic';
const effectText = 'force an enemy creature to capture 1 amber for each mars creature they control';
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const clone = value => structuredClone(value);
const patcher = jsondiffpatch.create({ objectHash: (value, index) => value.uuid || value.name || value.id || index });
const flush = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
function card(definition, uuid, extra = {}) {
  const d = ALL_DEFINITIONS[definition]; assert.ok(d, definition);
  return { id: definition, uuid, name: d.name, type: d.kind, printedHouse: d.house, cardPrintedAmber: d.amber,
    powerPrinted: d.power, modifiedPower: d.power, armorPrinted: d.armor, enhancements: [], exhausted: true,
    facedown: false, controlled: false, copying: false, tokens: {}, upgrades: [], childCards: [],
    selectable: false, unselectable: true, ...extra };
}
/** Synthetic identities on the recorded international prompt schema. These fixtures
 * contain no account, deck, credential, hidden opponent card or live game identifiers. */
function fixture() {
  const player = name => ({ name, houses: ['mars', 'shadows', 'geistoid'], activePlayer: name === 'alpha',
    activeHouse: name === 'alpha' ? 'mars' : null, phase: 'main', disconnected: false, left: false,
    optionSettings: { confirmOneClick: true }, stats: { amber: name === 'beta' ? 1 : 0, chains: 0,
      keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 28, numArchivesCards: 0, selectCard: false, selectOrder: false, buttons: [], controls: [] });
  const before = { id: gameId, started: true, manualMode: false, players: { alpha: player('alpha'), beta: player('beta') },
    messages: [{ id: 'prior-public-event', activePlayer: 'alpha', message: ['Prior public action'] }] };
  before.players.alpha.menuTitle = 'Play cards or use cards in play';
  before.players.alpha.buttons = [{ text: 'End Turn', arg: 'endturn', uuid: 'main-prompt' }];
  before.players.alpha.cardPiles.hand = [card('hypnotic-command', sourceId, { canPlay: true, location: 'hand', selectable: true, unselectable: false })];
  before.players.alpha.cardPiles.cardsInPlay = [card('nyzyk-resonator', 'own-mars-one'),
    card('nyzyk-resonator', 'own-mars-two'), card('the-watch', 'own-shadow'),
    card('nightmare-urchin', 'own-prior-capture', { tokens: { amber: 1 } })];
  before.players.beta.cardPiles.cardsInPlay = [card('badgemagus', 'enemy-one', { tokens: { amber: 2 } }), card('troll', 'enemy-two')];
  const summary = { id: 'hypnotic-command', type: 'action', name: 'Hypnotic Command', facedown: false };
  const menu = clone(before);
  menu.players.alpha.menuTitle = 'Choose an action';
  menu.players.alpha.controls = [{ type: 'targeting', source: summary, targets: [], uuid: 'card-menu:0' }];
  menu.players.alpha.buttons = [{ text: 'Play this card', arg: 'play', uuid: 'card-menu' },
    { text: 'Discard this card', arg: 'discard', uuid: 'card-menu' }];
  const allocation = clone(before);
  allocation.players.alpha.cardPiles.hand = [];
  Object.assign(allocation.players.alpha, { selectCard: true, selectOrder: false,
    menuTitle: 'Choose a creature to capture 1 amber from its controller',
    promptTitle: { text: '{{card}}', values: { card: 'Hypnotic Command' } }, buttons: [],
    controls: [{ type: 'targeting', source: summary, targets: [], uuid: 'hypnotic-allocation:0' }] });
  for (const target of allocation.players.beta.cardPiles.cardsInPlay) Object.assign(target, { selectable: true, unselectable: false });
  allocation.messages.push({ id: 'fresh-hypnotic-effect', activePlayer: 'alpha', message: [
    { argType: 'nonAvatarPlayer', name: 'alpha' }, ' uses ', { ...summary, argType: 'card' }, ' to ', { message: [effectText] }] });
  return { before, menu, allocation };
}
function project(raw, revision = 2, extra = {}) {
  return projectKeytekiState(raw, { playerName: 'alpha', revision, turn: 4, sourceCardId: sourceId, ...extra });
}
function observe(f, options) {
  const tracker = new KeytekiAllocationTracker(options);
  assert.equal(tracker.observe(f.before, project(f.before, 1)).status, 'none');
  const p = project(f.allocation);
  return { tracker, p, result: tracker.observe(f.allocation, p) };
}

test('fresh Hypnotic prompt and a single opposing amber prove one click without an effective-house count', async () => {
  const f = fixture(), { p, result } = observe(f);
  assert.equal(result.status, 'ready', result.reason);
  const d = result.descriptor;
  assert.equal(d.amount, 1);
  assert.equal(d.sourceCardId, sourceId);
  assert.equal(d.sourceDefinition, 'hypnotic-command');
  assert.deepEqual(d.allowedTargets.sort(), ['enemy-one', 'enemy-two']);
  assert.equal(d.amountEvidence.kind, 'new-public-hypnotic-effect-and-single-opponent-amber');
  assert.equal(d.amountEvidence.opponentName, 'beta');
  assert.equal(d.amountEvidence.opponentAmber, 1);
  assert.match(d.amountEvidence.messageSha256, /^[a-f0-9]{64}$/);
  const controller = new StrategyController({ codePolicy: 'tactical-style-engine-v3' });
  const plan = await prepareKeytekiAllocationPlan(controller, { matchId: gameId, observation: p.observation }, p, d);
  validateKeytekiAllocationPlan(plan, p);
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.decisions.length, 1);
  assert.equal(plan.commands[0].message, 'cardClicked');
  assert.ok(d.allowedTargets.includes(plan.commands[0].args[0]));
  assert.deepEqual(p.observation.players[1].battleline.map(c => c.captured), [2, 0], 'draft does not apply a capture');
  controller.discard(plan.finalDecision.id);
  // The proof relies on the positive prompt, not on counting printed Mars.
  for (const c of f.allocation.players.alpha.cardPiles.cardsInPlay) c.printedHouse = 'geistoid';
  assert.equal(observe(f).result.descriptor.amount, 1);
});

test('zero, multiple, missing, fractional and nonnumeric opposing pools remain unsupported', () => {
  for (const amber of [0, 2, 5, undefined, null, '1', 0.5, -1]) {
    const f = fixture(); f.allocation.players.beta.stats.amber = amber;
    const { result } = observe(f);
    assert.equal(result.status, 'unsupported', String(amber));
    assert.match(result.reason, /public-quota-unreported/, String(amber));
  }
});

test('one-amber proof retains actor, source, native start and offered enemy-target bindings', () => {
  const changes = {
    'manual mode': f => { f.allocation.manualMode = true; },
    'previous manual mode': f => { f.before.manualMode = true; },
    'not started': f => { f.allocation.started = false; },
    'different game': f => { f.before.id = 'other-game'; },
    'wrong actor': f => { f.allocation.players.alpha.activePlayer = false; },
    'both active': f => { f.allocation.players.beta.activePlayer = true; },
    'friendly target': f => { Object.assign(f.allocation.players.alpha.cardPiles.cardsInPlay[0], { selectable: true, unselectable: false }); },
    'hidden source': f => { f.allocation.players.alpha.controls[0].source.facedown = true; },
    'copied source': f => { f.allocation.players.alpha.controls[0].source.copying = true; },
    'conflicting source UUID': f => { f.allocation.players.alpha.controls[0].source.uuid = 'another-source'; },
    'another allocation already open': f => { f.before = clone(f.allocation); f.before.players.alpha.controls[0].uuid = 'older-allocation:0'; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture(); change(f);
    const tracker = new KeytekiAllocationTracker(); tracker.observe(f.before, project(f.before, 1));
    assert.equal(tracker.observe(f.allocation, project(f.allocation)).status, 'unsupported', name);
  }
  const f = fixture();
  assert.match(new KeytekiAllocationTracker().observe(f.allocation, project(f.allocation)).reason, /allocation-start-unobserved/);
  const tracker = new KeytekiAllocationTracker(); tracker.observe(f.before, project(f.before, 1));
  assert.match(tracker.observe(f.allocation, project(f.allocation, 2, { sourceCardId: undefined })).reason, /physical-source-unbound/);
});

test('only one fresh exact typed Hypnotic effect in a continuous message window can authorize the bound', () => {
  const changes = {
    'missing effect': f => f.allocation.messages.pop(),
    'stale effect': f => f.before.messages.push(clone(f.allocation.messages.at(-1))),
    'duplicate effects': f => f.allocation.messages.push({ ...clone(f.allocation.messages.at(-1)), id: 'duplicate-effect' }),
    'missing anchor': f => f.allocation.messages.shift(),
    'changed anchor': f => { f.allocation.messages[0].message = ['Changed public event']; },
    'reused event id': f => { f.allocation.messages.at(-1).id = f.before.messages[0].id; },
    'different event actor': f => { f.allocation.messages.at(-1).activePlayer = 'beta'; },
    'different typed actor': f => { f.allocation.messages.at(-1).message[0].name = 'beta'; },
    'untyped player': f => { f.allocation.messages.at(-1).message[0].argType = 'player'; },
    'another card': f => { f.allocation.messages.at(-1).message[2].id = 'bring-low'; },
    'wrong source type': f => { f.allocation.messages.at(-1).message[2].type = 'creature'; },
    'hidden effect source': f => { f.allocation.messages.at(-1).message[2].facedown = true; },
    'other effect prose': f => { f.allocation.messages.at(-1).message[4].message = ['capture 1 amber']; },
    'mixed effect schema': f => { f.allocation.messages.at(-1).message[4].extra = true; },
  };
  for (const [name, change] of Object.entries(changes)) {
    const f = fixture(); change(f);
    assert.equal(observe(f).result.status, 'unsupported', name);
  }
});

test('a ready one-point descriptor is revoked if the same-prompt event or public pool changes', () => {
  for (const change of [f => f.allocation.messages.pop(), f => { f.allocation.messages.at(-1).message[0].name = 'beta'; }, f => { f.allocation.players.beta.stats.amber = 2; }, f => { f.allocation.players.beta.stats.amber = '1'; }]) {
    const f = fixture(), { tracker, result } = observe(f); assert.equal(result.status, 'ready');
    change(f);
    assert.equal(tracker.observe(f.allocation, project(f.allocation, 3)).status, 'unsupported');
  }
});

function failingContract() {
  const referenceRules = { commit: '361c085bcd401c20976ee9bcc4e4e5b8c061d56c', sourceManifestSha256: 'a'.repeat(64), serverDeploymentAttestation: false };
  const participants = ['alpha', 'beta'].map((playerName, index) => {
    const definition = index ? 'badgemagus' : 'hypnotic-command', d = ALL_DEFINITIONS[definition];
    const physicalCards = [{ definition, upstreamId: definition, house: d.house, kind: d.kind, enhancements: [], count: 36 }];
    return { playerName, deckId: 'synthetic-deck-' + playerName, deckName: 'Synthetic ' + playerName,
      serverDeckId: index + 1, importReceiptCanonicalSha256: 'b'.repeat(64),
      publicCompositionSha256: hash([[definition, d.house, 36]]), physicalConfigurationSha256: hash(physicalCards), physicalCards };
  });
  configurePublicCaptureFacts({ referenceRules,
    decks: Object.fromEntries(participants.map((p, index) => [p.deckId, { expansion: index ? 479 : 928,
      publicCompositionSha256: p.publicCompositionSha256, physicalConfigurationSha256: p.physicalConfigurationSha256 }])),
    pairs: { 'dm-mm-visible-poltergeistoids': participants.map(p => p.deckId) } });
  const binding = { origin: 'https://fixture.test', frontendBundleSha256: 'c'.repeat(64) };
  const body = { kind: 'keyteki-public-capture-rule-contract-v1', ...binding, backendRuleVersion: 'unreported', referenceRules,
    profile: 'dm-mm-visible-poltergeistoids', participants };
  return { ...binding, publicCaptureRuleContract: { ...body, id: 'public-capture-contract-' + hash(body) } };
}

test('an explicitly selected contract that cannot verify this public composition never falls back to the one-pool proof', () => {
  const f = fixture(), options = failingContract(), { result } = observe(f, options);
  assert.equal(result.status, 'unsupported');
  assert.match(result.reason, /^public-capture-/);
});

test('wire sends one complete allocation, waits for its native effect, and never invents a prefix acknowledgement', async () => {
  const f = fixture();
  const model = { id: 'synthetic-hypnotic-protocol-provider', async choose(input) {
    const entries = Object.entries(input.questions.decision.criteria);
    const chosen = entries.find(([, label]) => /Hypnotic Command|Play this card/.test(label) && !/Discard/.test(label)) ?? entries[0];
    return { status: 'accepted', choice: chosen[0], plan: 'Synthetic local protocol fixture', reason: null };
  } };
  const session = new KeytekiWireSession({ playerName: 'alpha', participants: ['alpha', 'beta'],
    strategy: { codePolicy: 'tactical-style-engine-v3', mode: 'model-all', model } });
  session.receive(f.before, 1); await flush();
  const select = session.take(); assert.equal(select?.command?.args[0], sourceId, JSON.stringify(session.describe()));
  session.confirmSent(select.decisionId, select.sequence);
  session.receive(patcher.diff(f.before, f.menu), 2); await flush();
  const play = session.take(); assert.equal(play?.command?.message, 'menuButton');
  session.confirmSent(play.decisionId, play.sequence);
  session.receive(patcher.diff(f.menu, f.allocation), 3); await flush();
  const beforeAck = session.describe().stats.acknowledged;
  const draft = session.take(); assert.equal(draft?.plan?.amount, 1, session.describe().error);
  assert.equal(draft.plan.commands.length, 1);
  assert.equal(session.describe().stats.acknowledged, beforeAck);
  session.confirmSent(draft.decisionId, draft.sequence, { planId: draft.plan.id, queuedCount: 1 });
  assert.equal(session.take(), null);
  assert.equal(session.describe().stats.acknowledged, beforeAck);
  const settled = clone(f.allocation), targetId = draft.plan.targets[0];
  Object.assign(settled.players.alpha, { selectCard: false, controls: [], menuTitle: 'Play cards or use cards in play', promptTitle: '' });
  settled.players.alpha.cardPiles.discard.push(card('hypnotic-command', sourceId));
  settled.players.beta.stats.amber = 0;
  for (const target of settled.players.beta.cardPiles.cardsInPlay) {
    Object.assign(target, { selectable: false, unselectable: true });
    if (target.uuid === targetId) target.tokens.amber = (target.tokens.amber ?? 0) + 1;
  }
  session.receive(patcher.diff(f.allocation, settled), 4); await flush();
  assert.equal(session.describe().stats.acknowledged, beforeAck + 1);
  assert.equal(session.describe().stats.allocationPlansObserved, 1);
  assert.equal(session.describe().stats.allocationPlansUnknown, 0);
});
