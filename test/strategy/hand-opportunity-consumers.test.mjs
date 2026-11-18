import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { assessAlgorithm } from '../../dist/src/ai/algorithm-policies.js';
const features = { contextualEffects: true, netResources: true, physicalBonuses: true,
  publicCardLifecycle: true, publicHandOpportunityGroups: true, publicDestroyedRefunds: true,
  publicDestructionPayments: true, publicIntegerThirds: true, publicHouseChoices: true,
  publicAmberIconBindings: true };
function card(id, extra = {}, owner = 0) {
  const spec = { id, name: id, kind: 'action', house: 'logos', amber: 0, power: 0, armor: 0,
    traits: [], summary: 'Display only', abilities: {}, ...extra };
  return { id, definition: spec.id, owner, controller: owner, spec, ready: false,
    damage: 0, armorUsed: 0, elusiveUsed: false, captured: 0, stunned: false, powerCounters: 0,
    attachedTo: null, enteredController: owner, foreignArchiveHolder: null, usesThisTurn: 0,
    effective: { house: spec.house, power: spec.power, armor: spec.armor, keywords: [], assault: 0, hazardous: 0 } };
}
function observation() {
  const player = () => ({ houses: ['logos', 'untamed', 'brobnar'], amber: 0, keys: [], keyCost: 6,
    chains: 0, skipForgeTurn: null, lastForgedTurn: null, forgedOn: {}, forgeAvailable: 0,
    deckList: [], deckCount: 30, handCount: 0, archiveCount: 0, battleline: [], artifacts: [],
    upgrades: [], purged: [], discard: [] });
  return { schemaVersion: 2, engineVersion: 'public-hand-group-fixture', rulesVersion: '18.4',
    catalogVersion: 'public-static-knowledge', revision: 1, turn: 3, you: 0, firstPlayer: 0,
    turnUsage: {}, handOperations: 0, playedThisTurn: 0, creaturesPlayedThisTurn: 0,
    activePlayer: 0, phase: 'main', activeHouse: 'logos', players: [{ ...player(), hand: [], archives: [] }, player()],
    legalActions: [], resolving: [], promptCards: [], underCards: [], spanglerCards: [], controlLayers: [],
    nextReady: [], leaveEffects: [], publicCounters: { playedByHouse: {}, discardedHouses: [[], []],
      creaturesPlayedLastTurn: [0, 0], enemyFightDeaths: 0, creaturesUsed: [] }, pending: null,
    lasting: [], knowledge: [], permissions: [], cardEffects: [], houseRestrictions: [], futureHouseRestrictions: [],
    turnStep: { step: 3, performed: [0, 0], omega: false }, winner: null };
}
function play(effects, held = []) {
  const o = observation(), source = card('source', { abilities: { play: effects } });
  o.players[0].hand = [source, ...held]; o.players[0].handCount = 1 + held.length;
  o.legalActions = [{ id: 'play', action: { kind: 'play', card: source.id } },
    { id: 'discard', action: { kind: 'discard', card: source.id } }, { id: 'end', action: { kind: 'endTurn' } }];
  return o;
}
function assess(o, id = 'play', enabled = true) {
  const saved = structuredClone(o);
  const r = assessAlgorithm(o, id, 'tactical-v1', { ...features, publicHandOpportunityGroups: enabled });
  assert.deepEqual(o, saved); return r;
}
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);
const refill = (r) => r.reasons.filter((s) => s.includes('normal refill displacement settled'));
const current = (r) => r.reasons.some((s) => s.includes('shared current hand opportunity'));
const target = (operation, id, zone) => ({ kind: 'target', operation,
  filter: { side: 'friendly', zone, definition: id } });

test('ordinary Play and Discard receive the same single released refill slot; harmless Play wins', () => {
  const o=play([]), p=assess(o), d=assess(o,'discard');
  close(p.score-assess(o,'play',false).score,.9);
  assert.equal(refill(p).length,1); assert.equal(refill(d).length,1);
  assert.ok(p.score>d.score); close(p.score,1.2);
  assert.equal(refill(assess(o,'end')).length,0);
  const full=play([],Array.from({length:6},(_,i)=>card('held'+i,{house:'brobnar'})));
  close(assess(full).score-assess(full,'play',false).score,0);
});

test('play departure is not subtracted twice, and non-hand play receives no hand-slot credit', () => {
  const held=Array.from({length:6},(_,i)=>card('held'+i,{house:'brobnar'}));
  const o=play([{kind:'gain',amount:{metric:'handSize'}}],held);
  assert.deepEqual(assess(o).estimatedAmber,[6,0]);
  for(const zone of ['discard','archives']) {
    const x=play([]), c=x.players[0].hand[0]; x.players[0].hand=[]; x.players[0].handCount=0;
    x.players[0][zone]=[c]; if(zone==='archives')x.players[0].archiveCount=1;
    close(assess(x).score-assess(x,'play',false).score,0);
    assert.equal(refill(assess(x)).length,0);
  }
});

test('drawing into the released slot does not also earn normal-refill credit', () => {
  const held=Array.from({length:5},(_,i)=>card('held'+i,{house:'brobnar'}));
  const o=play([{kind:'draw',amount:1}],held);
  assert.equal(refill(assess(o)).length,0);
  close(assess(o).score-assess(o,'play',false).score,0);
});

test('passing through hand before purge or discard leaves no phantom immediate play premium', () => {
  const gift=card('gift',{abilities:{play:[{kind:'gain',amount:3}]}});
  for(const destination of ['purge','discard']) {
    const via=play([target('returnHand','gift','discard'),target(destination,'gift','hand')]);
    const direct=play(destination==='purge'?[target('purge','gift','discard')]:[]);
    via.players[0].discard=[gift];direct.players[0].discard=[gift];
    close(assess(via).score,assess(direct).score);
    assert.equal(current(assess(via)),false);
  }
});

test('the parent Play consumes its play cap before recovered cards get an immediate premium', () => {
  const gift=card('gift',{abilities:{play:[{kind:'gain',amount:3}]}});
  const o=play([target('returnHand','gift','discard')]);o.players[0].discard=[gift];
  const cap=card('cap',{kind:'artifact',playLimitOpponent:1},1);o.players[1].artifacts=[cap];
  const closed=assess(o);assert.equal(current(closed),false);
  cap.spec.playLimitOpponent=2;const open=assess(o);
  assert.equal(current(open),true);assert.ok(open.score>closed.score+1);
});

test('Reap activity prevents a recovered Alpha even when no hand operation occurred', () => {
  const o=observation(),gift=card('gift',{alpha:true,abilities:{play:[{kind:'gain',amount:3}]}});
  const source=card('source',{kind:'creature',power:3,abilities:{reap:[target('returnHand','gift','discard')]}});
  source.ready=true;o.players[0].battleline=[source];o.players[0].discard=[gift];
  o.legalActions=[{id:'reap',action:{kind:'reap',card:source.id}}];
  assert.equal(current(assess(o,'reap')),false);
  delete o.turnStep;assert.equal(current(assess(o,'reap')),false);
  gift.spec.alpha=false;assert.equal(current(assess(o,'reap')),true);
});

function multiplePrompt(kind='target') {
  const o=observation();o.phase='choice';
  const a=card('selected',{house:'untamed'}),b=card('same',{house:'untamed'}),c=card('different',{house:'brobnar'});
  const effect=kind==='target'?{kind:'target',operation:'returnHand',max:2,filter:{side:'friendly',zone:'discard'}}:
    {kind:'chooseCards',max:2,bind:'selected',filter:{side:'friendly',zone:'discard'},then:[{kind:'bound',key:'selected',operation:'returnHand'}]};
  const source=card('source',{abilities:{play:[effect]}});o.resolving=[source];o.players[0].discard=[a,b,c];
  o.pending={kind:'target',actor:0,source:source.id,amount:0,reward:0,min:0,max:2,selected:[a.id],selectedCount:1,
    intent:{kind:'target-operation',operation:'returnHand',selection:{ability:'play',path:[0]}}};
  o.legalActions=[b,c].map(c=>({id:c.id,action:{kind:'select',target:c.id}}));
  o.legalActions.push({id:'done',action:{kind:'done'}});return o;
}

test('multi-recovery Select includes the committed prefix and favors a same-house partner', () => {
  const o=multiplePrompt(),same=assess(o,'same'),different=assess(o,'different');
  close(same.score-different.score,.3);
  assert.ok(same.reasons.some(s=>s.includes('same-house')));
  assert.ok(!different.reasons.some(s=>s.includes('same-house')));
  const done=assess(o,'done'),single=multiplePrompt();
  single.pending.selected=[];single.pending.selectedCount=0;single.pending.max=1;
  single.legalActions=[{id:'only',action:{kind:'select',target:'selected'}}];
  close(done.score,assess(single,'only').score);
  const continuation=multiplePrompt('chooseCards');
  close(assess(continuation,'same').score,same.score);
  close(assess(continuation,'done').score,done.score);
});

test('a visible multi-selection prefix is never invented from a count or duplicated ID', () => {
  const o=multiplePrompt(),base=assess(o,'different');
  o.pending.selected=['selected','selected'];o.pending.selectedCount=2;
  assert.ok(!assess(o,'same').reasons.some(s=>s.includes('same-house')));
  o.pending.selected=[];o.pending.selectedCount=1;
  assert.ok(!assess(o,'same').reasons.some(s=>s.includes('same-house')));
  assert.ok(Number.isFinite(base.score));
});

test('artifact Play pays public enemy tax, and the resulting opponent pool feeds third-key risk', () => {
  const o=play([]);o.players[0].hand[0].spec.kind='artifact';o.players[0].amber=3;
  o.players[1].artifacts=[card('tax',{kind:'artifact',opponentArtifactPlayTax:2},1)];
  assert.deepEqual(assess(o).estimatedAmber,[1,2]);
  assert.deepEqual(assess(o,'play',false).estimatedAmber,[3,0]);
  o.players[1].keys=['red','blue'];o.players[1].amber=4;o.players[1].forgeAvailable=4;
  const r=assessAlgorithm(o,'play','tactical-v1',{...features,publicThirdKeyFundingRisk:true});
  assert.deepEqual(r.estimatedAmber,[1,6]);
  assert.ok(r.reasons.some(s=>s.includes('third-key')));
});

test('legitimate Scrap income can still outweigh Play after refill symmetry', () => {
  const o=play([]);o.players[0].hand[0].spec.abilities.scrap=[{kind:'gain',amount:3}];
  const d=assess(o,'discard');assert.deepEqual(d.estimatedAmber,[3,0]);
  assert.ok(d.score>assess(o).score);assert.ok(d.reasons.some(s=>s.includes('resolves its public Scrap')));
});


test('proven first ordinary Action can supply its end-refill, while its own draw cannot use that future card', () => {
  const held=Array.from({length:5},(_,i)=>card('held'+i,{house:'brobnar'}));
  const o=play([],held);o.players[0].deckCount=0;
  o.publicStateCoverage={turnHistoryComplete:true,effectsComplete:true};
  assert.equal(refill(assess(o)).length,1);assert.equal(refill(assess(o,'discard')).length,1);
  assert.ok(assess(o).score>assess(o,'discard').score);
  o.players[0].hand[0].spec.abilities.play=[{kind:'draw',amount:1}];
  assert.equal(refill(assess(o)).length,0);
  // An unexposed earlier action-return registration is not silently ruled out.
  o.players[0].hand[0].spec.abilities.play=[];o.turnStep.performed[0]=1;
  assert.equal(refill(assess(o)).length,0);
});

test('common random final departures replace a temporary hand arrival in both ledgers', () => {
  const gift=card('gift',{house:'untamed'}),partner=card('partner',{house:'untamed'});
  const random=(effects)=>({kind:'randomCard',zone:'archives',bind:'random',then:effects});
  const via=play([target('returnHand','gift','discard'),random([target('discard','gift','hand')])],[partner]);
  const direct=play([random([])],[partner]);
  for(const o of [via,direct]) {
    o.players[0].discard=[gift];o.players[0].archives=[card('a'),card('b')];o.players[0].archiveCount=2;
  }
  close(assess(via).score,assess(direct).score);
  assert.equal(current(assess(via)),false);
  assert.ok(!assess(via).reasons.some(s=>s.includes('same-house')));
});

test('counterfactual holdings cannot leave the discarded Routine Job duplicated in the old discard pile', () => {
  const o=observation(),a=card('job-a',structuredClone(ALL_DEFINITIONS['routine-job'])),
    b=card('job-b',structuredClone(ALL_DEFINITIONS['routine-job']));
  o.activeHouse='shadows';o.players[0].houses=['shadows','logos','untamed'];
  o.players[0].hand=[a,b];o.players[0].handCount=2;o.players[1].amber=20;
  o.legalActions=[{id:'discard',action:{kind:'discard',card:b.id}},
    {id:'play-a',action:{kind:'play',card:a.id}},{id:'play-b',action:{kind:'play',card:b.id}}];
  const pair=assess(o,'discard');
  o.players[0].hand=[b];o.players[0].handCount=1;o.legalActions=o.legalActions.filter(x=>x.id!=='play-a');
  const single=assess(o,'discard');
  assert.ok(pair.score>single.score+3,`${pair.score} vs ${single.score}`);
});

test('a following public play prohibition prevents a recovered card from earning immediate opportunity', () => {
  const gift=card('gift',{abilities:{play:[{kind:'gain',amount:3}]}});
  const o=play([target('returnHand','gift','discard'),{kind:'lasting',rule:'noPlay',duration:'turn'}]);
  o.players[0].discard=[gift];assert.equal(current(assess(o)),false);
});
