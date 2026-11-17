import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { projectKeytekiState, compileKeytekiCommand } from '../../dist/src/adapters/keyteki.js';
import { keytekiTargetMeaning } from '../../dist/src/adapters/keyteki-native-semantics.js';

const sourceId = 'synthetic-source';
function card(definition, uuid, extra = {}) {
  const d = ALL_DEFINITIONS[definition];
  assert.ok(d, definition);
  return { id: definition, uuid, name: d.name, type: d.kind, printedHouse: d.house,
    cardPrintedAmber: d.amber, powerPrinted: d.power, modifiedPower: d.power,
    armorPrinted: d.armor, enhancements: [], exhausted: true, facedown: false,
    controlled: false, copying: false, tokens: {}, upgrades: [], childCards: [],
    selectable: false, unselectable: true, ...extra };
}
function base() {
  const player = name => ({ name, houses: ['brobnar', 'dis', 'logos'], activePlayer: name === 'alpha',
    activeHouse: name === 'alpha' ? 'brobnar' : null, phase: 'main',
    optionSettings: { confirmOneClick: true }, stats: { amber: name === 'alpha' ? 4 : 7,
      chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 20, numArchivesCards: 0, selectCard: false, selectOrder: false,
    buttons: [], controls: [], promptedPiles: [] });
  return { id: 'synthetic-native-semantics', started: true, manualMode: false,
    players: { alpha: player('alpha'), beta: player('beta') }, messages: [] };
}
function selection(menuTitle, definition = 'troll') {
  const raw = base(), me = raw.players.alpha, d = ALL_DEFINITIONS[definition];
  Object.assign(me, { selectCard: true, menuTitle, promptTitle: d.name,
    controls: [{ type: 'targeting', source: { id: definition, type: d.kind, name: d.name,
      facedown: false }, targets: [], uuid: 'target-prompt:0' }] });
  if (d.kind === 'artifact' || d.kind === 'creature')
    me.cardPiles.cardsInPlay.push(card(definition, sourceId));
  me.cardPiles.cardsInPlay.push(card('badgemagus', 'own-target', { selectable: true, unselectable: false }));
  raw.players.beta.cardPiles.cardsInPlay.push(card('troll', 'enemy-target', { selectable: true, unselectable: false }));
  return raw;
}
const project = (raw, extra = {}) => projectKeytekiState(raw, {
  playerName: 'alpha', revision: 4, turn: 7, sourceCardId: sourceId, ...extra,
});
const operation = p => p.observation.pending?.intent?.kind === 'target-operation'
  ? p.observation.pending.intent.operation : undefined;
const targets = p => p.observation.legalActions.filter(a => a.action.kind === 'select').map(a => a.action.target).sort();

test('current native menu supplies target meaning independently of the displayed source name', () => {
  for (const [title, expected] of [
    ['Choose a creature to capture 2 amber', 'capture'],
    ['Choose a creature to destroy', 'destroy'],
    ['Choose a creature to purge', 'purge'],
    ['Choose a creature to stun', 'stun'],
    ['Choose a creature to exhaust', 'exhaust'],
    ['Choose a card to discard', 'discard'],
    ['Choose a creature to archive', 'archive'],
  ]) {
    const raw = selection(title);
    raw.players.alpha.promptTitle = 'Destroy Purge Archive Stun';
    raw.players.alpha.controls[0].source.name = 'Destroy Purge Archive Stun';
    const p = project(raw);
    assert.equal(operation(p), expected, title);
    assert.equal(p.observation.pending.kind, expected === 'archive' ? 'archive' : 'target');
    assert.deepEqual(targets(p), ['enemy-target', 'own-target'], 'native targets remain authoritative');
  }
});

test('source-only keywords, negation and composite prompts are never flattened into positive effects', () => {
  for (const title of [
    'Choose a creature',
    'Choose an enemy creature to not destroy',
    'Choose a friendly creature to not destroy',
    'Choose a creature to destroy or archive',
    'Choose a creature to capture 1 amber from its controller',
    'Choose a card to not discard',
  ]) {
    const raw = selection(title);
    raw.players.alpha.promptTitle = 'Destroy Purge Stun Archive';
    assert.equal(operation(project(raw)), undefined, title);
    assert.equal(project(raw).observation.pending.kind, 'target', title);
  }
});

test('numeric native parameters stay numeric and per-click amounts never become an allocation quota', () => {
  const numeric = amount => ({ text: 'Choose a creature to deal {{amount}} damage to', values: { amount } });
  const good = project(selection(numeric(2)));
  assert.equal(operation(good), 'damage');
  assert.equal(good.observation.pending.amount, 2);
  assert.equal(keytekiTargetMeaning(numeric(2)).basis, 'native-parameter');
  for (const amount of ['2', undefined, null, 0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(operation(project(selection(numeric(amount)))), undefined, String(amount));
  for (const [title, expected] of [
    ['Choose a creature to deal 3 damage to', 3],
    ['Choose a creature to capture 2 amber', 2],
    ['Choose a creature to capture 1 amber', 1],
    ['Choose a creature to capture amber due to bonus icon', 1],
    ['Choose a creature to damage due to bonus icon', 1],
  ]) {
    const p = project(selection(title));
    assert.equal(p.observation.pending.amount, expected, title);
    assert.equal(p.observation.pending.max, undefined, 'one click amount is not a total or maximum');
  }
});

test('a physically bound Hypnotic selector exposes captureOwn and preserves the actual recipient sides', () => {
  const raw = selection('Choose a creature to capture 1 amber from its controller', 'hypnotic-command');
  // Actual Hypnotic offers enemy creatures. The projected controller and unchanged
  // target command make the funding pool explicit to the strategy.
  raw.players.alpha.cardPiles.cardsInPlay[0].selectable = false;
  raw.players.alpha.cardPiles.cardsInPlay[0].unselectable = true;
  raw.players.alpha.promptTitle = 'Misleading Destroy and Capture';
  const p = project(raw);
  assert.deepEqual(p.observation.pending.intent, { kind: 'target-operation', operation: 'captureOwn' });
  assert.equal(p.observation.pending.amount, 1);
  assert.deepEqual(targets(p), ['enemy-target']);
  assert.equal(p.observation.players[1].battleline.find(c => c.id === 'enemy-target').controller, 1);
  assert.deepEqual(p.observation.players.map(player => player.amber), [4, 7]);
  const a = p.observation.legalActions.find(entry => entry.action.kind === 'select');
  assert.deepEqual(compileKeytekiCommand(p, a.id, { revision: 4, fingerprint: p.fingerprint }).args, ['enemy-target']);
  const ordinary = project(selection('Choose a creature to capture 1 amber', 'hypnotic-command'));
  assert.equal(operation(ordinary), 'capture', 'the source alone cannot change another current step');
});

test('Hypnotic meaning requires current exact source identity and a physical binding', () => {
  const mutate = {
    'wrong source with the same display name': raw => {
      Object.assign(raw.players.alpha.controls[0].source, { id: 'bring-low', name: 'Hypnotic Command' });
    },
    'missing native source': raw => { raw.players.alpha.controls = []; },
    'copied source': raw => { raw.players.alpha.controls[0].source.copying = true; },
    'hidden source': raw => { raw.players.alpha.controls[0].source.facedown = true; },
    'source type mismatch': raw => { raw.players.alpha.controls[0].source.type = 'creature'; },
    'conflicting physical source': raw => { raw.players.alpha.controls[0].source.uuid = 'another-source'; },
    'multiple targeting sources': raw => { raw.players.alpha.controls.push(structuredClone(raw.players.alpha.controls[0])); },
  };
  for (const [name, change] of Object.entries(mutate)) {
    const raw = selection('Choose a creature to capture 1 amber from its controller', 'hypnotic-command');
    change(raw);
    assert.equal(operation(project(raw)), undefined, name);
  }
  const raw = selection('Choose a creature to capture 1 amber from its controller', 'hypnotic-command');
  assert.equal(operation(project(raw, { sourceCardId: undefined })), undefined, 'a diagnostic source is not physical evidence');
});

function houseChoice() {
  const raw = base();
  Object.assign(raw.players.alpha, { menuTitle: '请选择一个派系', promptTitle: '任意显示标题',
    controls: [{ type: 'house-select', houses: ['brobnar', 'dis', 'logos'] }],
    buttons: ['Done', 'Destroy', 'Purge'].map((text, arg) => ({
      text, arg, uuid: 'actual-house-prompt', command: 'menuButton',
    })) });
  return raw;
}

test('house-select uses native indices and declared houses despite translated or misleading labels', () => {
  const p = project(houseChoice(), { sourceCardId: undefined });
  assert.equal(p.observation.pending.intent.kind, 'house-choice');
  const expected = ['brobnar', 'dis', 'logos'].map((house, index) => ({ id: 'keyteki-button-' + index, house }));
  assert.deepEqual(p.observation.pending.intent.options, expected);
  assert.deepEqual(p.observation.pending.options.map(({ id, house }) => ({ id, house })), expected);
  assert.deepEqual(p.observation.legalActions.map(a => a.action.kind), ['choose', 'choose', 'choose']);
  for (let index = 0; index < 3; index++) {
    const action = p.observation.legalActions.find(a => a.action.option === 'keyteki-button-' + index);
    assert.deepEqual(compileKeytekiCommand(p, action.id, { revision: 4, fingerprint: p.fingerprint }).args,
      [index, 'actual-house-prompt']);
  }
});

test('house metadata is withheld when its native domain, indices or prompt binding is inconsistent', () => {
  const changes = {
    'duplicate indices': raw => { raw.players.alpha.buttons[1].arg = 0; },
    'out of range': raw => { raw.players.alpha.buttons[1].arg = 3; },
    'string index': raw => { raw.players.alpha.buttons[1].arg = '1'; },
    'another prompt UUID': raw => { raw.players.alpha.buttons[1].uuid = 'other-prompt'; },
    'missing UUID': raw => { delete raw.players.alpha.buttons[1].uuid; },
    'unknown house': raw => { raw.players.alpha.controls[0].houses[1] = 'unknown-house'; },
    'duplicate house': raw => { raw.players.alpha.controls[0].houses[1] = 'brobnar'; },
    'different native method': raw => { raw.players.alpha.buttons[1].method = 'another-method'; },
    'different native command': raw => { raw.players.alpha.buttons[1].command = 'clickTide'; },
    'disabled option': raw => { raw.players.alpha.buttons[1].disabled = true; },
    'additional option': raw => { raw.players.alpha.buttons.push({ text: 'Fourth', arg: 3, uuid: 'actual-house-prompt' }); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const raw = houseChoice(); change(raw);
    const p = project(raw, { sourceCardId: undefined });
    assert.notEqual(p.observation.pending?.intent?.kind, 'house-choice', name);
    assert.ok((p.observation.pending?.options ?? []).every(option => option.house === undefined), name);
  }
});

test('active-house native icons take priority while legacy icon-free views keep their narrow fallback', () => {
  const raw = base();
  Object.assign(raw.players.alpha, { phase: 'house', promptTitle: 'House Choice',
    menuTitle: 'Choose which house you want to activate this turn',
    buttons: [
      { text: 'Done', icon: 'logos', arg: 0, uuid: 'house-prompt' },
      { text: 'brobnar', icon: 'mars', arg: 1, uuid: 'house-prompt' },
    ] });
  const p = project(raw, { sourceCardId: undefined });
  assert.deepEqual(p.observation.legalActions.map(a => a.action), [
    { kind: 'house', house: 'logos' }, { kind: 'house', house: 'mars' },
  ]);
  assert.deepEqual(compileKeytekiCommand(p, p.observation.legalActions[1].id,
    { revision: 4, fingerprint: p.fingerprint }).args, [1, 'house-prompt']);
  raw.players.alpha.buttons = [{ text: 'untamed', arg: 0, uuid: 'legacy-house' }];
  assert.deepEqual(project(raw).observation.legalActions[0].action, { kind: 'house', house: 'untamed' });
});

test('Cauldron projects a bound play-from-under step without manufacturing a semantic display label', () => {
  const raw = selection('Choose a card to play', 'cauldron'), me = raw.players.alpha;
  const source = me.cardPiles.cardsInPlay.find(c => c.uuid === sourceId);
  source.childCards = [card('troll', 'under-one', { selectable: true, unselectable: false })];
  me.cardPiles.cardsInPlay.find(c => c.uuid === 'own-target').selectable = false;
  raw.players.beta.cardPiles.cardsInPlay[0].selectable = false;
  const p = project(raw);
  assert.deepEqual(p.observation.pending.intent, { kind: 'play-from-under' });
  assert.equal(p.observation.pending.source, sourceId);
  assert.equal(p.observation.pending.label, 'Choose a card to play');
  assert.deepEqual(p.observation.underCards.find(group => group.source === sourceId).cards.map(c => c.id), ['under-one']);
  assert.deepEqual(targets(p), ['under-one']);
  source.copying = true;
  assert.notEqual(project(raw).observation.pending?.intent?.kind, 'play-from-under', 'copied text is not the native Cauldron step');
});

test('an unbound same-name Cauldron cannot authorize the other physical copy or another current menu', () => {
  const raw = selection('Choose a card to play', 'cauldron');
  raw.players.alpha.cardPiles.cardsInPlay.push(card('cauldron', 'other-cauldron'));
  assert.notEqual(project(raw, { sourceCardId: undefined }).observation.pending?.intent?.kind, 'play-from-under');
  raw.players.alpha.menuTitle = 'Choose a card';
  assert.notEqual(project(raw).observation.pending?.intent?.kind, 'play-from-under');
  const named = selection('Choose a card to play', 'troll');
  named.players.alpha.promptTitle = 'Cauldron';
  named.players.alpha.controls[0].source.name = 'Cauldron';
  assert.notEqual(project(named).observation.pending?.intent?.kind, 'play-from-under');
});
