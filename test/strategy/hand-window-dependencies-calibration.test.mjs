import assert from 'node:assert/strict';
import test from 'node:test';
import { assessPublicHandWindow } from '../../dist/src/ai/public-hand-window.js';
import { CATALOG } from '../../dist/src/knowledge/catalog.js';

function card(definition,id,owner=0) {
  const spec=CATALOG[definition];
  assert.ok(spec,definition);
  return {id,definition,spec,owner,controller:owner,damage:0,armorUsed:0,captured:0,
    effective:{house:spec.house,power:spec.power,armor:spec.armor}};
}
function menu(hand,enemy) {
  const me={hand,handCount:hand.length,amber:0,battleline:[],artifacts:[],upgrades:[]};
  return {you:0,activePlayer:0,turn:3,phase:'main',activeHouse:'brobnar',turnUsage:{},playedThisTurn:0,
    handOperations:0,permissions:[],lasting:[],players:[me,{...me,hand:undefined,handCount:0,battleline:[enemy]}],
    legalActions:hand.map(c=>({id:c.id,action:{kind:'play',card:c.id}}))};
}
test('two Punches cannot collect two lethal premiums from one visible creature',()=>{
  const punch1=card('punch','first'),punch2=card('punch','second'),enemy=card('witch-of-the-eye','enemy',1);
  const neutral=card('gauntlet-of-command','gauntlet'),hand=[punch1,punch2,neutral],o=menu(hand,enemy);
  // At the initial observation each Punch is quoted 6.94 on the single 3-power target.
  // The neutral artifact is priced separately to check that an unrelated predecessor survives.
  const price=c=>({score:c===neutral?4:6.94,currentScore:c===neutral?4:6.94,playableNow:true,approximate:true});
  const singleton=assessPublicHandWindow(o,[punch1],price);
  const pair=assessPublicHandWindow(o,[punch1,punch2],price);
  const withNeutral=assessPublicHandWindow(o,hand,price);
  assert.equal(singleton.score,3.47);
  // The conservative static allocator can price one damage move before requiring a fresh board.
  assert.equal(pair.score,singleton.score);
  assert.ok(withNeutral.selectedIds.includes(neutral.id));
  assert.ok(Math.abs(withNeutral.score-pair.score-2)<1e-8);
});
