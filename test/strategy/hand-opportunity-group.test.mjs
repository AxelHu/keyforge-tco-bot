import assert from 'node:assert/strict';
import test from 'node:test';
import { assessHandOpportunityGroup } from '../../dist/src/ai/hand-opportunity-group.js';

function card(id, house, extra = {}) {
  return { id, definition: id, owner: 0, controller: 0, effective: { house }, spec: { id, house }, ...extra };
}
function observation(hand = [], archives = []) {
  const me = { hand, archives, archiveCount: archives.length, houses: ['logos', 'dis', 'mars'],
    battleline: [], artifacts: [], upgrades: [] };
  const foe = { battleline: [], artifacts: [], upgrades: [],
    get hand() { throw new Error('opponent hand read'); },
    get archives() { throw new Error('opponent archives read'); } };
  return { you: 0, players: [me, foe] };
}
const move = (card, from = 'discard', to = 'hand') => ({ card, from: { zone: from, seat: 0 }, to: { zone: to, seat: 0 } });
const score = (o, moves, options) => assessHandOpportunityGroup(o, moves, options).score;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' vs ' + expected);

test('recovering a pair adds a future partner even beside a larger unrelated house', () => {
  const o = observation(Array.from({ length: 5 }, (_, i) => card('d' + i, 'dis')));
  const a = card('a', 'logos'), b = card('b', 'logos'), m = card('m', 'mars');
  close(score(o, [move(a), move(b)]), 0.3);
  close(score(o, [move(a), move(m)]), 0);
  close(score(o, Array.from({ length: 12 }, (_, i) => move(card('l' + i, 'logos')))), 1.2);
  close(score(o, [move(a)]), 0);
});

test('effective and additional houses provide one best gain per candidate', () => {
  const dual = { effective: { house: 'logos', houses: ['logos', 'dis', 'dis'] } };
  const a = card('a', 'mars', dual), b = card('b', 'mars', dual);
  close(score(observation(), [move(a), move(b)]), 0.3);
  close(score(observation([card('l', 'logos')]), [move(a)]), 0.3);
  close(score(observation([card('m', 'mars')]), [move(a)]), 0);
  const bounced = card('bounce', 'dis', { printedHouse: 'mars', effective: { house: 'logos' } });
  close(score(observation([card('m', 'mars')]), [move(bounced, 'battleline')]), 0.3);
  close(score(observation([card('l', 'logos')]), [move(bounced, 'battleline')]), 0);
});

test('spending a partner costs cohesion, including when another house gains a pair', () => {
  const a = card('a', 'dis'), b = card('b', 'dis'), x = card('x', 'logos'), y = card('y', 'logos');
  const o = observation([a, b, x]);
  close(score(o, [move(b, 'hand', 'discard')]), -0.3);
  close(score(o, [move(b, 'hand', 'discard'), move(y)]), 0);
  close(score(o, [move(y)]), 0.3);
  assert.deepEqual(o.players[0].hand, [a, b, x]);
});

test('actual final destinations, physical identity and jointly played cards govern the batch', () => {
  const a = card('a', 'logos'), b = card('b', 'logos'), o = observation([a]);
  close(score(o, [move(b), move(b)]), 0.3);
  close(score(o, [move(b), move(b, 'hand', 'purged')]), 0);
  close(score(o, [move(a, 'hand', 'discard'), move(a)]), 0);
  close(score(o, [move(b)], { excludedImmediateIds: new Set(['b']) }), 0);
  close(score(o, [move(b)], { excludedImmediateIds: new Set(['a']) }), 0);
  close(score(o, [move(b)]), 0.3);
  close(score(o, [move(card('enemy', 'logos', { owner: 1 }))]), 0);
  close(score(o, [{ ...move(b), to: { zone: 'archives', seat: 1 } }]), 0);
});

test('own archives can supply one discounted partner when the visible pile can be taken', () => {
  const a = card('a', 'logos'), b = card('b', 'logos'), c = card('c', 'logos');
  const foreign = card('foe', 'logos', { owner: 1 });
  const o = observation([], [a, c, foreign]);
  close(score(o, [move(b)]), 0.15);
  close(score(observation([], [foreign]), [move(b)]), 0);
  o.players[0].artifacts.push(card('lock', 'dis', { spec: { locksForeignArchives: true } }));
  close(score(o, [move(b)]), 0.15); // Foreign lock applies only to the foreign card.
  o.players[0].artifacts.length = 0;
  o.players[1].artifacts.push(card('ban', 'mars', { spec: { forbidsArchiveStep: true }, controller: 1 }));
  close(score(o, [move(b)]), 0);
  o.players[1].artifacts.length = 0;
  o.players[0].archiveCount++;
  close(score(o, [move(b)]), 0);
  o.players[0].archiveCount--;
  o.publicStateCoverage = { effectsComplete: false };
  close(score(o, [move(b)]), 0);
});

test('an unresolved physical face or incomplete joined entity contributes no future partner', () => {
  const o = observation([card('anchor', 'logos')]);
  for (const extra of [
    { definition: 'physical-reverse' }, { form: 'upgrade' }, { tokenCreature: { reference: 'token' } },
    { copiedHouse: 'dis' }, { giganticBonusIcons: [] }, { physicalParts: [] },
    { physicalParts: [{ id: 'one-known-part', definition: 'front', owner: 0 }] },
  ]) {
    const face = card('front', 'logos', extra);
    close(score(o, [move(face, 'battleline')]), 0);
  }
});

test('an arrival can take the immediate slot and leave the displaced play as a future partner', () => {
  const a = card('former-play', 'logos'), b = card('partner', 'logos'), incoming = card('new-play', 'dis');
  const o = observation([a, b]);
  const allocation = { beforeExcludedImmediateIds: new Set([a.id]), excludedImmediateIds: new Set([incoming.id]) };
  close(score(o, [move(incoming)], allocation), 0.3);
  close(score(o, [move(incoming)], { excludedImmediateIds: allocation.excludedImmediateIds }), 0);
  close(score(o, [], allocation), 0);
});
