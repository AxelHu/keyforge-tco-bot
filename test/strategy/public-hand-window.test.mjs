import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPublicHandWindow } from '../../dist/src/ai/public-hand-window.js';

function card(id, changes = {}) {
  return { id, owner: 0, controller: 0, definition: id, effective: { house: 'logos' },
    spec: { id, name: id, house: 'logos', kind: 'action', ...changes } };
}
function fixture(cards) {
  const player = () => ({ hand: [], amber: 2, battleline: [], upgrades: [], artifacts: [], discard: [] });
  return { you: 0, activePlayer: 0, turn: 3, handOperations: 0, turnUsage: {}, playedThisTurn: 0,
    turnStep: { step: 3, performed: [0,0], omega: false }, phase: 'main', activeHouse: 'logos',
    players: [{ ...player(), hand: cards }, player()], permissions: [], lasting: [], resolving: [],
    legalActions: [], leaveEffects: [] };
}
const value = (c) => ({ score: c.value ?? 6, currentScore: c.value ?? 6, playableNow: true, approximate: true });
const assess = (o) => assessPublicHandWindow(o, o.players[0].hand, value, { projected: true });
test('public hand premium shares amber, remaining plays and six-per-name capacity', () => {
  const a = card('a',{playAmberCost: 2}), b = card('b',{playAmberCost: 2}), c = card('c');
  a.value = 8;
  const o = fixture([a,b,c]);
  assert.deepEqual(assess(o).selectedIds,['a','c']);
  o.lasting.push({rule:'playLimit', appliesTo:0, turn:3, amount:1});
  assert.deepEqual(assess(o).selectedIds,['a']);
  o.lasting = [];
  a.spec.name = c.spec.name = 'duplicate';
  o.turnUsage.duplicate = 5;
  assert.deepEqual(assess(o).selectedIds,['b','c']);
});
test('a single finite permission cannot play two off-house cards, even across copies', () => {
  const a = card('a'), b = card('b');
  a.effective.house = b.effective.house = 'dis';
  const o = fixture([a,b]);
  o.permissions = [{ id: 7, mode:'play', filter:{kind:'action'}, bound:null,
    used:[], uniqueRemaining:null, remaining:1 }];
  assert.equal(assess(o).score,3);
  o.permissions[0].remaining = 2;
  assert.equal(assess(o).score,6);
  o.permissions[0].uniqueRemaining = 1;
  assert.equal(assess(o).score,3);
});
test('a finite mandatory allowance leaves later ordinary active-house plays available', () => {
  const a = card('a'), b = card('b'), c = card('c');
  c.effective.house = 'dis';
  const o = fixture([a,b,c]);
  o.permissions = [{ id:7, mode:'play', remaining:1, uniqueRemaining:null, used:[], bound:null, filter:{} }];
  assert.equal(assess(o).score,9);
  o.turn = 1;
  assert.equal(assess(o).score,3);
});
test('Alpha after Reap, a missing attachment host, restrictions and granted Omega', () => {
  const a = card('a',{alpha:true}), b = card('b',{kind:'upgrade',upgrade:{attachToArtifact:true}});
  const o = fixture([a,b]);
  o.turnStep.performed[0] = 1;
  assert.equal(assess(o).score,0);
  const artifact = card('host',{kind:'artifact'});
  o.players[1].artifacts.push({...artifact, controller:1});
  assert.deepEqual(assess(o).selectedIds,['b']);
  b.spec.kind = 'action';
  o.lasting.push({rule:'noMatchingPlay', appliesTo:0, turn:3, countFilter:{kind:'action'},house:'logos'});
  assert.equal(assess(o).score,0);
  o.lasting = [];
  o.players[1].artifacts[0].spec.grantsEnemyOmega = true;
  a.spec = {...a.spec,alpha:false,kind:'artifact'};
  b.spec.kind = 'creature';
  assert.equal(assess(o).selectedIds.length,1);
});
test('terminal multi-target recovery may lead back to main; an unresolved caller or follow-up suppresses it', () => {
  const source = card('source');
  source.spec.abilities = {play:[{kind:'target', operation:'returnHand',max:2}]};
  const o = fixture([card('a'),card('b')]);
  o.phase = 'choice'; o.resolving = [source];
  o.pending = {source:source.id,actor:0,kind:'target',intent:{kind:'target-operation',operation:'returnHand'},max:2};
  assert.equal(assess(o).score,6);
  o.resolving.push(card('parent'));
  assert.equal(assess(o).score,0);
  o.resolving.pop();
  source.spec.abilities.play[0].after = {when:'affected',effects:[]};
  assert.equal(assess(o).score,0);
});
test('native menu and projected hand have separate authority, and duplicates add no material', () => {
  const a = card('a');
  const o = fixture([a,a]);
  assert.equal(assessPublicHandWindow(o,o.players[0].hand,value).score,0);
  assert.equal(assess(o).score,3);
  o.turnStep.omega = true;
  assert.equal(assess(o).score,0);
});

test('live permanent permissions cease after the first opening-turn hand operation or source departure', () => {
  const a = card('a'), b = card('b');
  a.effective.house = b.effective.house = 'dis';
  const o = fixture([a,b]); o.turn = 1;
  const source = card('source',{kind:'artifact',grantsOutOfHousePlayKind:'action'});
  o.players[0].artifacts = [source];
  o.permissions = [{ id:-50000, source:'source',mode:'play', remaining:null,uniqueRemaining:null,
    used:[],bound:null,filter:{kind:'action'} }];
  assert.equal(assess(o).selectedIds.length,1);
  o.turn = 3;
  assert.equal(assess(o).selectedIds.length,2);
  o.players[0].artifacts = [];
  assert.equal(assess(o).selectedIds.length,0);
});

test('a right-flank restriction also blocks an empty battleline', () => {
  const c = card('c',{kind:'creature'});
  const o = fixture([c]);
  o.players[1].artifacts = [{...card('wall',{kind:'artifact',forbidsEnemyRightFlankPlay:true}),controller:1}];
  assert.equal(assess(o).score,0);
  o.players[0].battleline = [card('host',{kind:'creature'})];
  assert.equal(assess(o).score,3);
});

test('two cards that shut down later plays cannot both earn immediate play value', () => {
  const stops = { play:[{kind:'lasting',rule:'noPlay',duration:'turn'}] };
  const o = fixture([card('a',{abilities:stops}),card('b',{abilities:stops}),card('c')]);
  assert.deepEqual(assess(o).selectedIds,['c','a']);
  o.players[0].hand = [card('a',{kind:'creature',prohibitOwnCreatures:true}),
    card('b',{kind:'creature',prohibitOwnCreatures:true})];
  assert.equal(assess(o).score,3);
});
