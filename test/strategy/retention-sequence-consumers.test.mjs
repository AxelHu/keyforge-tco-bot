import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { assessAlgorithm } from '../../dist/src/ai/algorithm-policies.js';
const features = { contextualEffects: true, netResources: true, physicalBonuses: true,
  publicCardLifecycle: true, publicHandOpportunityGroups: true, publicDestroyedRefunds: true,
  publicCardRetention: true, publicPlaySequences: true, publicSemanticPlayPartners: true, publicMinimumForgeCost: true,
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
function assess(o, id = 'play', overrides = {}) {
  const saved = structuredClone(o);
  const r = assessAlgorithm(o, id, 'tactical-v1', { ...features, ...overrides });
  assert.deepEqual(o, saved); return r;
}
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-8, `${a} != ${b}`);
const refill = (r) => r.reasons.filter((s) => s.includes('normal refill displacement settled'));
const current = (r) => r.reasons.some((s) => s.includes('shared current hand opportunity'));
const target = (operation, id, zone) => ({ kind: 'target', operation,
  filter: { side: 'friendly', zone, definition: id } });


function discardPrompt(held, max=1, selected=[], optional=false) {
  const o=observation();o.phase='choice';
  const effect={kind:'target',operation:'discard',filter:{side:'friendly',zone:'hand'},max,optional};
  const source=card('forced-source',{abilities:{play:[effect]}});
  o.resolving=[source];o.players[0].hand=held;o.players[0].handCount=held.length;
  o.handOperations=1;o.playedThisTurn=1;o.turnStep.performed[0]=1;
  o.pending={kind:'target',actor:0,source:source.id,min:optional?0:max,max,selected,
    selectedCount:selected.length,amount:0,reward:0,
    intent:{kind:'target-operation',operation:'discard',selection:{ability:'play',path:[0]}}};
  o.legalActions=held.filter(c=>!selected.includes(c.id)).map(c=>({id:c.id,action:{kind:'select',target:c.id}}));
  if(optional || selected.length>=max)o.legalActions.push({id:'done',action:{kind:'done'}});
  return o;
}
const earning=(id,house='logos',amount=2)=>card(id,{house,abilities:{play:[{kind:'gain',amount}]}});
const hasTiming=r=>r.reasons.some(x=>x.includes('retained hand timing'));
const hasSequence=r=>r.reasons.some(x=>x.includes('remaining hand route repriced'));

test('effect discard preserves a current-house play ahead of the same off-house material',()=>{
  const active=earning('active'),later=earning('later','untamed');
  const o=discardPrompt([active,later]);
  const a=assess(o,'active'),b=assess(o,'later');
  assert.ok(b.score>a.score+1);assert.ok(current(a));assert.ok(hasTiming(b));
  const old={publicCardRetention:false,publicPlaySequences:false,publicSemanticPlayPartners:false};
  close(assess(o,'active',old).score,assess(o,'later',old).score);
  const other=structuredClone(o);other.activePlayer=1;
  close(assess(other,'active').score,assess(other,'later').score);
});

test('direct target locators preserve terminal discard opportunity; malformed locators remain uncertain',()=>{
  const o=discardPrompt([earning('active'),earning('later','untamed')]);
  const withLocator=assess(o,'active');assert.ok(current(withLocator));
  const without=structuredClone(o);delete without.pending.intent.selection;
  close(withLocator.score,assess(without,'active').score);
  const malformed=structuredClone(o);malformed.pending.intent.selection.path=[99];
  assert.equal(current(assess(malformed,'active')),false);
});

test('direct multi-discard Select and Done settle the same full visible prefix',()=>{
  const held=[earning('a','untamed'),earning('b','untamed'),earning('c','brobnar')];
  const selecting=discardPrompt(held,3,['a'],true);
  const done=discardPrompt(held,3,['a','b'],true);
  close(assess(selecting,'b').score,assess(done,'done').score);
  const noPrefix=discardPrompt(held,3,[],true);
  assert.notEqual(assess(selecting,'b').score,assess(noPrefix,'b').score);
});

test('native discard keeps the original first-turn and Alpha window in its before state',()=>{
  for(const first of [true,false]) {
    const o=play([{kind:'gain',amount:3}]);
    if(first)o.turn=1;else o.players[0].hand[0].spec.alpha=true;
    const old=assess(o,'discard',{publicCardRetention:false});
    const next=assess(o,'discard');
    assert.ok(next.score<old.score-1);assert.ok(current(next));assert.equal(hasTiming(next),false);
    assert.ok(assess(o).score>next.score);
  }
});

test('an individually legal negative-value native Play still incurs waiting when retained',()=>{
  const o=play([{kind:'resource',side:'self',operation:'lose',amount:2}]);
  o.players[0].amber=o.players[0].forgeAvailable=2;
  const next=assess(o,'discard'),old=assess(o,'discard',{publicCardRetention:false});
  assert.ok(next.score>old.score);assert.ok(hasTiming(next));
  assert.equal(current(next),false);assert.ok(next.score>assess(o).score);
});

test('an actual funding Play receives only the incremental remaining-hand route',()=>{
  const paid=card('paid',{playAmberCost:2,amber:3});
  const o=play([{kind:'gain',amount:2}],[paid]);
  const next=assess(o),old=assess(o,'play',{publicPlaySequences:false});
  assert.ok(next.score>old.score);assert.ok(hasSequence(next));
  assert.deepEqual(next.estimatedAmber,[2,0]);assert.equal(next.projectedKey,false);
  o.players[0].hand=[o.players[0].hand[0]];o.players[0].handCount=1;
  close(assess(o).score,assess(o,'play',{publicPlaySequences:false}).score);
});

test('supported pure-play allowance replaces the fixed estimate and an unused grant has no premium',()=>{
  const grant={kind:'permission',mode:'play',filter:{side:'friendly',house:'untamed'}};
  const o=play([grant],[earning('follower','untamed',3)]);
  assert.ok(hasSequence(assess(o)));assert.ok(assess(o).score>assess(o,'play',{publicPlaySequences:false}).score);
  const empty=play([grant]);
  close(assess(empty).score,assess(empty,'play',{publicPlaySequences:false}).score-1.5);
  const flexible=play([{...grant,mode:'playOrUse'}],[earning('follower','untamed',3)]);
  close(assess(flexible).score,assess(flexible,'play',{publicPlaySequences:false}).score);
});

test('a recovered funding pair is allocated in sequence and respects the already-used parent cap',()=>{
  const fund=earning('fund','logos',2),paid=card('paid',{playAmberCost:2,amber:3});
  const o=play([{kind:'target',operation:'returnHand',max:2,filter:{side:'friendly',zone:'discard'}}]);
  o.players[0].discard=[fund,paid];
  assert.ok(assess(o).score>assess(o,'play',{publicPlaySequences:false}).score);
  o.players[1].artifacts=[card('cap',{kind:'artifact',playLimitOpponent:2},1)];
  close(assess(o).score,assess(o,'play',{publicPlaySequences:false}).score);
});

test('recovering a typed future partner replaces only that generic pair contribution',()=>{
  const definition=id=>ALL_DEFINITIONS[id];
  const moon=card('moon',definition('full-moon')),pixie=card('pixie',definition('dust-pixie'));
  const o=play([{kind:'target',operation:'returnHand',max:2,filter:{side:'friendly',zone:'discard'}}]);
  o.players[0].discard=[moon,pixie];
  close(assess(o).score-assess(o,'play',{publicSemanticPlayPartners:false}).score,.95);
});

test('transient hand visits still have no retention, sequence or semantic residue',()=>{
  const gift=earning('gift','untamed',3);
  for(const destination of ['purge','discard']) {
    const via=play([target('returnHand','gift','discard'),target(destination,'gift','hand')]);
    const direct=play(destination==='purge'?[target('purge','gift','discard')]:[]);
    via.players[0].discard=[gift];direct.players[0].discard=[gift];
    close(assess(via).score,assess(direct).score);
  }
});

test('a forced discard preserves the publicly available third-key response over greater ordinary income',()=>{
  const defense=card('defense',{abilities:{play:[{kind:'steal',amount:1}]}}),income=earning('income','logos',3);
  const o=discardPrompt([defense,income]);o.players[1].keys=['red','blue'];
  o.players[1].amber=o.players[1].forgeAvailable=6;
  const keepDefense=assess(o,'income'),loseDefense=assess(o,'defense');
  assert.ok(keepDefense.score>loseDefense.score+100);
  assert.equal(keepDefense.deniesKey,false);assert.equal(keepDefense.projectedKey,false);
  o.players[1].forgeBlocked=true;
  assert.ok(assess(o,'defense').score>assess(o,'income').score);
  o.players[1].forgeBlocked=false;o.publicStateCoverage={effectsComplete:false,turnHistoryComplete:true};
  assert.ok(Math.abs(assess(o,'defense').score-assess(o,'income').score)<100);
  delete o.publicStateCoverage;o.players[0].keys=['red','blue'];o.players[1].keys=['red'];
  assert.ok(assess(o,'defense').score>assess(o,'income').score);
});

test('printed forge floors and already-forged colors apply to ordinary candidate and material probes',()=>{
  const o=play([{kind:'forgeEffect',fixedCost:0,minimumCost:6}]);
  o.players[0].keys=['red','blue'];o.players[0].amber=o.players[0].forgeAvailable=5;
  assert.equal(assess(o).projectedKey,false);
  assert.equal(assess(o,'play',{publicMinimumForgeCost:false}).projectedKey,true);
  o.players[0].amber=o.players[0].forgeAvailable=6;
  assert.equal(assess(o).projectedKey,true);
  o.players[0].hand[0].spec.abilities.play[0].color='red';
  assert.equal(assess(o).projectedKey,false);
});


test('pool-changing Scrap does not create an asymmetric critical hand reservation',()=>{
  const defense=card('defense',{abilities:{play:[{kind:'steal',amount:1}]}});
  for(const scrap of [{kind:'gain',amount:1},{kind:'steal',amount:1}]) {
    const o=play([], [defense]);
    o.players[0].hand[0].spec.abilities.scrap=[scrap];
    o.players[1].keys=['red','blue'];o.players[1].amber=o.players[1].forgeAvailable=6;
    const next=assess(o,'discard'),without=assess(o,'discard',{publicCardRetention:false});
    assert.ok(Math.abs(next.score-without.score)<20);
    assert.ok(next.score>0);
    assert.equal(next.deniesKey,scrap.kind==='steal');
  }
});


test('spending stored forge amber cannot leave a stale critical recovery bonus',()=>{
  const forge=card('forge',{abilities:{play:[{kind:'forgeEffect'}]}});
  const o=play([]),p=o.players[0];
  p.keys=['red','blue'];p.amber=5;p.forgeAvailable=6;p.forgeSources={pool:5,bank:1};
  const bank=card('bank',{kind:'artifact',spendAmberForKeys:true});bank.captured=1;
  p.artifacts=[bank];p.discard=[forge];
  const recover=target('returnHand','forge','discard');
  const remove={kind:'all',filter:{side:'friendly',zone:'artifacts',kind:'artifact'},operation:'removeAmber',amount:1};
  p.hand[0].spec.abilities.scrap=[recover];
  assert.ok(assess(o,'discard').score-assess(o,'discard',{publicCardRetention:false}).score>150);
  p.hand[0].spec.abilities.scrap=[remove,recover];
  assert.ok(Math.abs(assess(o,'discard').score-assess(o,'discard',{publicCardRetention:false}).score)<20);
  assert.equal(assess(o,'discard').projectedKey,false);
});
