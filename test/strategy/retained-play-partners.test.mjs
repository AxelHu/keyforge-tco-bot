import assert from 'node:assert/strict';
import test from 'node:test';
import { assessHandOpportunityGroup } from '../../dist/src/ai/hand-opportunity-group.js';
import { CATALOG } from '../../dist/src/knowledge/catalog.js';

function card(definition, id = definition, extra = {}) {
  const spec = CATALOG[definition];
  return { id, definition, owner: 0, controller: 0, effective: { house: spec.house }, spec, ...extra };
}
function view(hand = [], activePlayer = 0) {
  const board = () => ({ battleline: [], artifacts: [], upgrades: [] });
  return { you: 0, activePlayer, turn: 6,
    players: [{ ...board(), hand, archives: [], archiveCount: 0, houses: ['logos', 'untamed', 'sanctum'] },
      { ...board(), get hand() { throw Error('enemy hand'); }, get archives() { throw Error('enemy archives'); } }] };
}
const move = (card, from = 'discard', to = 'hand') => ({ card, from: { zone: from, seat: 0 }, to: { zone: to, seat: 0 } });
const score = (o, moves, extra) => assessHandOpportunityGroup(o, moves, { semanticPlayPartners: true, ...extra }).score;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' vs ' + expected);

test('real gain rules distinguish a later creature, artifact, or action from a generic same-house partner', () => {
  for (const [source, match, miss] of [
    ['full-moon', 'dust-pixie', 'vigor'],
    ['hunting-witch', 'snufflegator', 'vigor'],
    ['hayyel-the-merchant', 'sigil-of-brotherhood', 'champion-anaphiel'],
    ['science', 'archon-s-callback', 'titan-mechanic'],
    ['crystalline-harvest', 'vigor', 'dust-pixie'],
  ]) {
    const s = card(source);
    for (const active of [0, 1]) {
      close(score(view([s], active), [move(card(match))]), 1.25);
      close(score(view([s], active), [move(card(miss))]), 0.3);
    }
    close(score(view([s, card(match)]), [move(s, 'hand', 'purged')]), -1.25);
    close(score(view([s]), [move(card(match))], { semanticPlayPartners: false }), 0.3);
  }
  // Full Moon can be played first even when Hunting Witch was already held.
  close(score(view([card('hunting-witch')]), [move(card('full-moon'))]), 1.25);
  close(score(view([card('harmonia')]), [move(card('snufflegator'))]), 0.3);
});

test('one enabler and two physical followers maximum, one house per candidate', () => {
  const s = card('full-moon'), followers = Array.from({ length: 10 }, (_, i) => card('dust-pixie', 'p' + i));
  close(score(view([s]), [move(followers[0]), move(followers[0])]), 1.25);
  close(score(view([s]), followers.slice(0, 2).map((c) => move(c))), 2.5);
  close(score(view([s]), followers.map((c) => move(c))), 3.1);
  const shared = { effective: { house: 'untamed', houses: ['untamed', 'logos'] } };
  const dual = card('full-moon', 'dual', shared), dualFollower = card('dust-pixie', 'dual2', shared);
  close(score(view([dual]), [move(dualFollower)]), 1.25);
  close(score(view([s]), [move(card('full-moon', 'second')), move(followers[0])]), 1.55);
});

test('excluded current plays, incomplete effects and board sources never add a retained trigger', () => {
  const s = card('full-moon'), f = card('snufflegator');
  for (const id of [s.id, f.id]) close(score(view([s]), [move(f)], { excludedImmediateIds: new Set([id]) }), 0);
  const o = view([s]);
  o.publicStateCoverage = { effectsComplete: false, turnHistoryComplete: true };
  close(score(o, [move(f)]), 0.3);
  const witch = card('hunting-witch');
  const returned = view([f]);
  returned.players[0].battleline.push(witch);
  close(score(returned, [move(witch, 'battleline')]), 0.3);
  const archive = view([s]);
  archive.players[0].archives = [f];
  archive.players[0].archiveCount = 1;
  close(score(archive, [move(f, 'archives')]), 1.25 - 0.15);
  close(score(view([s]), [move(f, 'discard', 'archives')]), 0.15);
});

test('typed links require a viable order and pool income under visible restrictions', () => {
  const s = card('full-moon'), f = card('snufflegator');
  const withSpec = (c, extra) => ({ ...c, spec: { ...c.spec, ...extra } });
  for (const change of [{ alpha: true }, { playCondition: {} }, { playAmberCost: 1 }, { unmodeled: true }])
    close(score(view([s]), [move(withSpec(f, change))]), 0.3);
  close(score(view([withSpec(s, { omega: true })]), [move(f)]), 0.3);
  const end = withSpec(f, { omega: true });
  close(score(view([s]), [move(end), move({ ...end, id: 'end2' })]), 1.55);
  for (const blocker of [{ playLimitOpponent: 1 }, { capturesIncomingAmber: true }, { grantsEnemyOmega: true }]) {
    const o = view([blocker.grantsEnemyOmega ? card('hunting-witch') : s]);
    o.players[1].artifacts.push({ controller: 1, spec: blocker });
    close(score(o, [move(f)]), 0.3);
  }
  const o = view([s]);
  o.futureHouseRestrictions = [{ player: 0, house: 'untamed', rule: 'cannotHouse', turn: 8 }];
  close(score(o, [move(f)]), 0.3);
  o.futureHouseRestrictions[0].turn = 7;
  close(score(o, [move(f)]), 1.25);
});
