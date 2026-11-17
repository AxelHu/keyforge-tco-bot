import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';
import { KeytekiAllocationTracker } from '../../dist/src/adapters/keyteki-allocation.js';

const clone = value => structuredClone(value);
const locales = {
  en: [' uses ', ' to '],
  zhhans: [' 使用 ', ' 来 '],
};
const sources = ['bring-low', 'hypnotic-command'];

function card(definition, uuid, extra = {}) {
  const d = ALL_DEFINITIONS[definition];
  assert.ok(d, definition);
  return { id: definition, uuid, name: d.name, type: d.kind, printedHouse: d.house,
    cardPrintedAmber: d.amber, powerPrinted: d.power, modifiedPower: d.power,
    armorPrinted: d.armor, enhancements: [], exhausted: true, facedown: false,
    controlled: false, copying: false, tokens: {}, upgrades: [], childCards: [],
    selectable: false, unselectable: true, ...extra };
}

/** The five-part Bring Low effect and its two preceding public events follow an
 * owned Fuzhou observation on 2026-11-17. Actor, game, card and event identities
 * are synthetic; unused translation metadata is omitted. The outer connective
 * pair is localized while the nested effect remains English.
 * Hypnotic below is a constructed branch fixture, not a recorded live trigger. */
function fixture(definition, locale = 'zhhans') {
  const hypnotic = definition === 'hypnotic-command', sourceId = 'source-' + definition;
  const player = name => ({ name, houses: ['mars', 'sanctum', 'brobnar'],
    activePlayer: name === 'alpha', activeHouse: name === 'alpha' ? (hypnotic ? 'mars' : 'sanctum') : null,
    phase: 'main', disconnected: false, left: false, optionSettings: { confirmOneClick: true },
    stats: { amber: name === 'alpha' ? 4 : (hypnotic ? 1 : 6), chains: 0,
      keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 20, numArchivesCards: 0, selectCard: false, selectOrder: false,
    buttons: [], controls: [] });
  const before = { id: 'synthetic-localized-allocation', started: true, manualMode: false,
    players: { alpha: player('alpha'), beta: player('beta') },
    messages: [{ id: 'prior-public-event', activePlayer: 'alpha', message: ['Previous public action'] }] };
  Object.assign(before.players.alpha, { menuTitle: 'Choose a card to play, discard or use',
    buttons: [{ text: 'End Turn', arg: 'endturn', uuid: 'main-prompt' }] });
  before.players.alpha.cardPiles.hand = [card(definition, sourceId, { canPlay: true, location: 'hand',
    selectable: true, unselectable: false })];
  before.players.alpha.cardPiles.cardsInPlay = [card('nyzyk-resonator', 'friendly-one')];
  before.players.beta.cardPiles.cardsInPlay = [card('troll', 'enemy-one')];
  const summary = { id: definition, image: definition, label: ALL_DEFINITIONS[definition].name,
    name: ALL_DEFINITIONS[definition].name, facedown: false, type: 'action',
    cardPrintedAmber: ALL_DEFINITIONS[definition].amber, activeProphecy: false };
  const allocation = clone(before), [use, to] = locales[locale];
  allocation.players.alpha.cardPiles.hand = [];
  Object.assign(allocation.players.alpha, { selectCard: true, selectOrder: false,
    menuTitle: hypnotic ? 'Choose a creature to capture 1 amber from its controller' : 'Choose a creature to capture 1 amber',
    promptTitle: { text: '{{card}}', values: { card: summary.name } }, buttons: [],
    controls: [{ type: 'targeting', source: { ...summary, uuid: sourceId }, targets: [], uuid: 'capture-prompt:0' }] });
  const recipient = hypnotic ? allocation.players.beta : allocation.players.alpha;
  for (const target of recipient.cardPiles.cardsInPlay) Object.assign(target, { selectable: true, unselectable: false });
  const actor = { name: 'alpha', argType: 'nonAvatarPlayer', role: 'user' };
  const opponent = { name: 'beta', argType: 'nonAvatarPlayer', role: 'user' };
  const source = { argType: 'card', ...summary };
  if (!hypnotic) {
    allocation.players.alpha.stats.amber = 5;
    allocation.messages.push(
      { id: 'fresh-play', activePlayer: 'alpha', message: [actor, ' 打出了 ', source] },
      { id: 'fresh-bonus', activePlayer: 'alpha', message: [actor, ' 使用 ', source, '的琥珀奖励图标获得1琥珀'] },
    );
  }
  allocation.messages.push({ id: 'fresh-effect', activePlayer: 'alpha', message: [
    actor, use, source, to, { message: hypnotic
      ? ['force an enemy creature to capture 1 amber for each mars creature they control']
      : ['have friendly creatures capture ', 1, ' amber from ', opponent] }] });
  return { before, allocation, sourceId, hypnotic };
}

function project(raw, f, revision) {
  return projectKeytekiState(raw, { playerName: 'alpha', revision, turn: 4, sourceCardId: f.sourceId });
}
function observe(f, requireSupportedProjection = true) {
  const tracker = new KeytekiAllocationTracker();
  assert.equal(tracker.observe(f.before, project(f.before, f, 1)).status, 'none');
  const projection = project(f.allocation, f, 2);
  if (requireSupportedProjection) assert.deepEqual(projection.unsupported, [], 'positive fixture must reach the allocation evidence gate');
  return tracker.observe(f.allocation, projection);
}

for (const definition of sources) {
  for (const locale of Object.keys(locales)) {
    test(definition + ' accepts the complete ' + locale + ' effect connective pair with the same bound quota', () => {
      const f = fixture(definition, locale), result = observe(f);
      assert.equal(result.status, 'ready', result.reason);
      assert.equal(result.descriptor.amount, 1);
      assert.equal(result.descriptor.sourceCardId, f.sourceId);
      assert.equal(result.descriptor.sourceDefinition, definition);
      assert.deepEqual(result.descriptor.allowedTargets, [f.hypnotic ? 'enemy-one' : 'friendly-one']);
      assert.equal(result.descriptor.amountEvidence.kind, f.hypnotic
        ? 'new-public-hypnotic-effect-and-single-opponent-amber'
        : 'new-public-effect-message-and-opponent-amber');
      assert.equal(result.descriptor.amountEvidence.messageId, 'fresh-effect');
      assert.equal(result.descriptor.amountEvidence.opponentName, 'beta');
      assert.equal(result.descriptor.amountEvidence.opponentAmber, f.hypnotic ? 1 : 6);
    });
  }

  test(definition + ' localized effect retains exact actor, source, freshness and paired-connective guards', () => {
    const changes = {
      'wrong event actor': f => { f.allocation.messages.at(-1).activePlayer = 'beta'; },
      'wrong typed actor': f => { f.allocation.messages.at(-1).message[0].name = 'beta'; },
      'untyped actor': f => { f.allocation.messages.at(-1).message[0].argType = 'player'; },
      'wrong card': f => { f.allocation.messages.at(-1).message[2].id = 'another-card'; },
      'wrong source type': f => { f.allocation.messages.at(-1).message[2].type = 'creature'; },
      'hidden source': f => { f.allocation.messages.at(-1).message[2].facedown = true; },
      'old effect': f => { f.before.messages.push(clone(f.allocation.messages.at(-1))); },
      'duplicate effects': f => { f.allocation.messages.push({ ...clone(f.allocation.messages.at(-1)), id: 'duplicate-effect' }); },
      'lost history anchor': f => { f.allocation.messages.shift(); },
      'changed history anchor': f => { f.allocation.messages[0].message = ['Changed event']; },
      'English use and Chinese to': f => { f.allocation.messages.at(-1).message[1] = ' uses '; },
      'Chinese use and English to': f => { f.allocation.messages.at(-1).message[3] = ' to '; },
      'unspaced near-use': f => { f.allocation.messages.at(-1).message[1] = '使用'; },
      'suffixed near-to': f => { f.allocation.messages.at(-1).message[3] = ' 来 capture '; },
      'prefixed near-use': f => { f.allocation.messages.at(-1).message[1] = 'also 使用 '; },
      'effect with another field': f => { f.allocation.messages.at(-1).message[4].extra = true; },
      'wrong effect prose': f => { f.allocation.messages.at(-1).message[4].message[0] = 'capture some amber'; },
    };
    if (definition === 'bring-low') {
      Object.assign(changes, {
        'wrong recipient pool owner': f => { f.allocation.messages.at(-1).message[4].message[3].name = 'alpha'; },
        'string quota': f => { f.allocation.messages.at(-1).message[4].message[1] = '1'; },
        'quota disagrees with pool': f => { f.allocation.messages.at(-1).message[4].message[1] = 2; },
      });
    } else {
      Object.assign(changes, {
        'larger enemy pool': f => { f.allocation.players.beta.stats.amber = 2; },
        'nonnumeric enemy pool': f => { f.allocation.players.beta.stats.amber = '1'; },
        'manual mode': f => { f.allocation.manualMode = true; },
        'copied control source': f => { f.allocation.players.alpha.controls[0].source.copying = true; },
        'mismatched physical source': f => { f.allocation.players.alpha.controls[0].source.uuid = 'wrong-source'; },
      });
    }
    for (const [name, change] of Object.entries(changes)) {
      const f = fixture(definition); change(f);
      assert.equal(observe(f, false).status, 'unsupported', name);
    }
  });
}
