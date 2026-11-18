import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../../dist/src/knowledge/catalog.js';
import { publicFuturePlayRestriction, publicNextHouseChoices, publicNextHouseTurn } from '../../dist/src/ai/future-house-play-rules.js';
import { retainedPlayPartnerCount } from '../../dist/src/ai/retained-play-partners.js';

function card(definition, extra = {}) {
  const spec = CATALOG[definition];
  return {id: definition, definition, spec, owner: 0, controller: 0, effective: {house: spec.house}, ...extra};
}
function view() {
  const player = () => ({houses:['untamed','logos','sanctum'], battleline:[], artifacts:[], upgrades:[]});
  return {you:0, activePlayer:1, turn:6, phase:'main', activeHouse:'logos',
    players:[player(),player()], lasting:[], houseRestrictions:[], futureHouseRestrictions:[], legalActions:[]};
}
const links = (o,source,follower,house='untamed') =>
  retainedPlayPartnerCount(o,house,[card(source),card(follower)],new Set());
const effect = (rule, extra = {}) => ({rule,actor:1,appliesTo:0,turn:7,amount:0,...extra});

test('future typed links distinguish exactly which member is forbidden or blanked',()=>{
  const o=view();
  // Scrambler Storm says no actions. Hunting Witch and Ancient Bear are both creatures.
  o.lasting=[effect('noActions')];
  assert.equal(links(o,'hunting-witch','ancient-bear'),1);
  assert.equal(links(o,'full-moon','ancient-bear'),0);
  o.lasting=[effect('noCreatures')];
  assert.equal(links(o,'hunting-witch','ancient-bear'),0);
  assert.equal(links(o,'science','archon-s-callback','logos'),1);
  o.lasting=[effect('blankCreatures')];
  assert.equal(links(o,'hunting-witch','ancient-bear'),0);
  assert.equal(links(o,'full-moon','ancient-bear'),1);
  o.lasting=[effect('noNamedPlayUse',{appliesTo:1,affectedName:'Ancient Bear'})];
  assert.equal(links(o,'hunting-witch','ancient-bear'),0);
  assert.equal(links(o,'hunting-witch','snufflegator'),1);
  o.lasting=[effect('poolIncomeBecomesTokens')];
  assert.equal(links(o,'full-moon','ancient-bear'),0);
});

test('future permissions are not assumed; effective and printed house filters follow separate referee rules',()=>{
  const o=view(),dual=card('ancient-bear',{effective:{house:'untamed',houses:['untamed','logos']}});
  o.lasting=[effect('noMatchingPlay',{countFilter:{kind:'creature'},house:'logos'})];
  assert.equal(publicFuturePlayRestriction(o,dual,7,'untamed'),'blocked');
  assert.equal(publicFuturePlayRestriction(o,card('snufflegator'),7,'untamed'),'allowed');
  assert.equal(publicFuturePlayRestriction(o,card('full-moon'),7,'untamed'),'allowed');
  o.lasting=[effect('onlyPlayHouse',{house:'logos'})];
  assert.equal(publicFuturePlayRestriction(o,dual,7,'logos'),'blocked');
  o.lasting=[effect('onlyPlayHouse',{house:'untamed'})];
  assert.equal(publicFuturePlayRestriction(o,dual,7,'logos'),'allowed');
  o.lasting=[effect('noMatchingPlay',{countFilter:{kind:'creature',side:'friendly'}})];
  assert.equal(publicFuturePlayRestriction(o,dual,7,'untamed'),'unknown');
  o.lasting=[effect('noMatchingPlay',{countFilter:{kind:'creature'},expiresAtTurnStart:{player:0,turn:7}})];
  assert.equal(publicFuturePlayRestriction(o,dual,7,'untamed'),'allowed');
  o.lasting=[effect('noActions',{turn:8})];
  assert.equal(publicFuturePlayRestriction(o,card('full-moon'),7,'untamed'),'allowed');
});

test('choose among permitted mandatory houses and use the recorded previous choice',()=>{
  const o=view();
  o.activePlayer=0; o.activeHouse='sanctum';
  o.previousChosenHouses=['logos','untamed'];
  o.players[1].artifacts=[card('world-tree',{controller:1,spec:{...CATALOG['world-tree'],forbidsPreviousHouse:true}})];
  assert.deepEqual([...publicNextHouseChoices(o,8)].sort(),['sanctum','untamed']);
  o.futureHouseRestrictions=[{player:0,turn:8,rule:'mustHouse',house:'logos'}];
  assert.deepEqual([...publicNextHouseChoices(o,8)].sort(),['sanctum','untamed']);
  o.futureHouseRestrictions.push({player:0,turn:8,rule:'mustHouse',house:'untamed'});
  assert.deepEqual([...publicNextHouseChoices(o,8)],['untamed']);
  o.futureHouseRestrictions.push({player:0,turn:8,rule:'mustHouse',house:'sanctum'});
  assert.deepEqual([...publicNextHouseChoices(o,8)].sort(),['sanctum','untamed']);
  o.futureHouseRestrictions=[];o.players[1].artifacts=[];
  for(const h of o.players[0].houses)o.futureHouseRestrictions.push({player:0,turn:8,rule:'cannotHouse',house:h});
  assert.equal(publicNextHouseChoices(o,8).size,0);
  o.phase='house';o.activeHouse=null;o.legalActions=[{action:{kind:'house',house:null}}];
  assert.equal(publicNextHouseTurn(o),6);assert.equal(publicNextHouseChoices(o,6).size,0);
});

test('future play caps apply to enabler and followers together',()=>{
  const o=view(),source=card('full-moon'),followers=[card('snufflegator'),card('ancient-bear')];
  const count=()=>retainedPlayPartnerCount(o,'untamed',[source,...followers],new Set());
  for(const [amount,expected] of [[0,0],[1,0],[2,1],[3,2],[4,2]]){
    o.lasting=[effect('playLimit',{amount})];
    assert.equal(count(),expected);
  }
  o.lasting=[effect('playLimit',{amount:1,appliesTo:1})];
  assert.equal(count(),2);
  o.activePlayer=0;o.phase='choice';o.activeHouse=null;
  assert.equal(publicNextHouseTurn(o),undefined);
  o.turnStep={step:2};assert.equal(publicNextHouseTurn(o),6);
});

test('the opening house choice cannot allocate two ordinary plays from hand',()=>{
  const o=view();
  o.activePlayer=o.you; o.turn=1; o.phase='house'; o.activeHouse=null; o.handOperations=0;
  o.legalActions=[{action:{kind:'house',house:'untamed'}}];
  assert.equal(publicNextHouseTurn(o),1);
  assert.equal(links(o,'full-moon','ancient-bear'),0);
  o.turn=3;
  assert.equal(links(o,'full-moon','ancient-bear'),1);
});
