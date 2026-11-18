import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPublicHandWindow, projectPublicPlaySequenceOpener, publicHandWindowAvailable } from '../../dist/src/ai/public-hand-window.js';

function card(id, spec = {}) {
  const definition = { id, name: id, kind: 'action', house: 'logos', power: 0, armor: 0, amber: 0,
    traits: [], ...spec };
  return { id, owner: 0, controller: 0, definition: id, spec: definition, ready: false, usesThisTurn: 0,
    effective: { house: definition.house, power: definition.power, armor: definition.armor, keywords: [] } };
}
function view(cards, amber = 0) {
  const player = () => ({ amber, forgeAvailable: amber, forgeSources: {pool: amber}, handCount: 0,
    battleline: [], artifacts: [], upgrades: [], purged: [], discard: [] });
  return { you: 0, activePlayer: 0, turn: 3, phase: 'main', activeHouse: 'logos',
    turnUsage: {}, playedThisTurn: 0, creaturesPlayedThisTurn: 0, handOperations: 0,
    publicCounters: { playedByHouse: {}, creaturesUsed: [] }, playedTypes: [{},{}],
    players: [{ ...player(), hand: cards, handCount: cards.length }, player()],
    legalActions: cards.map((c) => ({ id: c.id, action: {kind:'play',card:c.id} })),
    resolving: [], leaveEffects: [], lasting: [], permissions: [], cardEffects: [],
    turnStep: {step:3,omega:false,performed:[0,0]} };
}
const price = (n = 6) => ({ score: n, currentScore: n, playableNow: true, approximate: true });
const window = (o, reprice = () => price(), options = {}) => assessPublicHandWindow(o,o.players[0].hand,
  () => price(), { projected: true, reprice, ...options });
const grant = (fields = {}) => ({ kind:'permission', mode:'play', filter:{notHouse:'logos'}, limit:1, ...fields });

test('one funding play moves the physical card and pays a newly affordable follow-up at the new price', () => {
  const earn = card('fund',{amber:1, abilities:{play:[{kind:'gain',amount:1}]}});
  const expensive = card('recovered',{playAmberCost:2}), o = view([expensive,earn]);
  const original = structuredClone(o);
  assert.deepEqual(window(o,(next,c) => {
    assert.equal(c.id,expensive.id);
    assert.deepEqual(next.players[0].hand.map((x) => x.id),[expensive.id]);
    assert.equal(next.players[0].discard[0].id, earn.id);
    assert.equal(next.publicCounters.playedByHouse.logos,1);
    assert.equal(next.turnUsage.fund,1);
    return price(next.players[0].amber * 5);
  }).selectedIds,[earn.id,expensive.id]);
  assert.equal(window(o,(next) => price(next.players[0].amber * 5)).score,8);
  assert.equal(assessPublicHandWindow(o,o.players[0].hand,() => price(),{projected:true}).score,3);
  assert.deepEqual(o,original);
});

test('physical amber icons replace the printed list, and payment including the artifact tax precedes income', () => {
  const producer = card('artifact',{kind:'artifact',amber:4,playAmberCost:1});
  producer.resolvedBonusIcons = ['amber','amber','amber'];
  const follower = card('threshold',{minAmberToPlay:3});
  const o = view([producer,follower],2);
  const tax = card('tax',{kind:'artifact',opponentArtifactPlayTax:1});
  o.players[1].artifacts = [{ ...tax,controller:1,owner:1 }];
  const next = projectPublicPlaySequenceOpener(o,producer);
  assert.equal(next.players[0].amber,3);
  assert.equal(next.players[1].amber,3);
  assert.equal(next.players[1].forgeSources.pool,3);
  assert.equal(next.players[0].forgeAvailable,3);
  assert.equal(next.players[0].artifacts[0].id,producer.id);
  o.players[0].amber = 1;
  assert.equal(projectPublicPlaySequenceOpener(o,producer),undefined);
  producer.spec.playAmberCost = 0;
  producer.resolvedBonusIcons = [];
  assert.equal(projectPublicPlaySequenceOpener(o,producer),undefined);
});

test('one Phase Shift-style permission is shared between competing off-house cards, preserving the chosen house', () => {
  const helper = card('helper',{kind:'creature',abilities:{play:[grant()]}});
  const a = card('offA',{house:'dis'}), b = card('offB',{house:'mars'});
  const o = view([b,a,helper]);
  const next = projectPublicPlaySequenceOpener(o,helper);
  assert.equal(next.activeHouse,'logos');
  assert.equal(next.players[0].battleline[0].id,helper.id);
  assert.equal(next.permissions[0].remaining,1);
  assert.deepEqual(window(o,(_view,c) => price(c.id === a.id ? 10 : 4)).selectedIds,[helper.id,a.id]);
  helper.spec.abilities.play = [grant({limit:2,uniqueLimit:1})];
  assert.equal(window(o).selectedIds.length,2);
  helper.spec.abilities.play = [grant({bound:'choice'})];
  assert.equal(projectPublicPlaySequenceOpener(o,helper),undefined);
});

test('the opener consumes its own mandatory permission, and new grants can work on opening turn', () => {
  const source = card('source',{house:'mars',abilities:{play:[grant({filter:{house:'dis'}})]}});
  const other = card('other',{house:'dis'}), o = view([source,other]);
  o.turn = 1; o.handOperations = 1;
  o.permissions = [{id:7,source:'prior',mode:'play',remaining:1,uniqueRemaining:1,
    used:[],filter:{house:'mars'},bound:null}];
  o.legalActions = [{id:'play-source',action:{kind:'play',card:source.id,permission:7}}];
  const next = projectPublicPlaySequenceOpener(o,source,7);
  assert.equal(next.permissions[0].remaining,0);
  assert.equal(next.permissions[0].uniqueRemaining,0);
  assert.deepEqual(next.permissions[0].used,[source.id]);
  assert.deepEqual(window(o).selectedIds,[source.id,other.id]);
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
});

test('Alpha, Omega, name limits, remaining play cap and ordinary opening-turn limit each veto the pair', () => {
  const checks = [
    (o,source,other) => { other.spec.alpha = true; },
    (o,source) => { source.spec.omega = true; },
    (o,source,other) => { source.spec.name = other.spec.name; o.turnUsage[other.spec.name] = 5; },
    (o) => { o.lasting = [{rule:'playLimit',turn:3,appliesTo:0,amount:1}]; },
    (o) => { o.turn = 1; },
    (o) => { o.publicStateCoverage = {turnHistoryComplete:false,effectsComplete:true}; },
  ];
  for (const change of checks) {
    const source = card('source',{amber:2}), other = card('other',{playAmberCost:2}), o = view([source,other]);
    change(o,source,other);
    assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
    assert.ok(window(o).selectedIds.length < 2);
  }
});

test('a draw, contingent gain, replacement, active trigger or absent native action cannot create a funded play', () => {
  const checks = [
    (o,source) => { source.bonusIcons = ['amber','draw']; },
    (o,source) => { source.spec.abilities = {play:[{kind:'draw',amount:1}]}; },
    (o,source) => { source.spec.abilities = {play:[{kind:'gain',amount:{metric:'amber'}}]}; },
    (o) => { o.players[1].artifacts = [{...card('spider',{capturesIncomingAmber:true}),controller:1}]; },
    (o) => { o.players[1].artifacts = [{...card('blocker',{blocksOpponentBonusIcons:true}),controller:1}]; },
    (o) => { o.players[1].artifacts = [card('hook',{reactions:[{event:'cardPlayed',effects:[]}]})]; },
    (o) => { o.legalActions = []; },
  ];
  for (const change of checks) {
    const source = card('source',{amber:1}), other = card('other',{playAmberCost:1}), o = view([source,other]);
    change(o,source);
    assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
  }
});

test('terminal effect discard opens only with an identified friendly-hand selection free of responses', () => {
  const other = card('held'), o = view([other]);
  const effect = {kind:'target',operation:'discard',filter:{side:'friendly',zone:'hand'}};
  const source = card('source',{abilities:{play:[effect]}});
  o.phase = 'choice'; o.resolving = [source];
  o.legalActions = [{id:'select',action:{kind:'select',target:other.id}}];
  o.pending = {kind:'target',actor:0,source:source.id,intent:{kind:'target-operation',operation:'discard'}};
  assert.equal(window(o, undefined, {terminalDiscard:true}).score,3);
  assert.equal(window(o).score,0);
  other.spec.abilities = {scrap:[{kind:'gain',amount:1}]};
  assert.equal(window(o, undefined, {terminalDiscard:true}).score,0);
  delete other.spec.abilities;
  effect.after = {when:'affected',effects:[{kind:'draw',amount:1}]};
  assert.equal(window(o, undefined, {terminalDiscard:true}).score,0);
});

test('a supported unused pure allowance can be explicitly repriced, with the old generic credit removed once', () => {
  const source = card('source',{abilities:{play:[grant()]}}), o = view([source]);
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
  const unused = projectPublicPlaySequenceOpener(o,source,undefined,'left',false,true);
  assert.equal(unused.permissions.length,1);
  assert.equal(unused.players[0].handCount,0);
  assert.equal(window(o,undefined,{playPermissionEstimate:1.5}).score,1.5);
  const generic = () => price(1.5);
  assert.equal(assessPublicHandWindow(o,[source],generic,{projected:true,playPermissionEstimate:1.5}).score,0);
  assert.equal(assessPublicHandWindow(o,[source],generic,{projected:true}).score,.75);
  const other = card('other',{house:'dis'});
  o.players[0].hand.push(other); o.players[0].handCount++;
  assert.equal(window(o,undefined,{playPermissionEstimate:1.5}).score,4.5);
  o.lasting = [{rule:'playLimit',turn:3,appliesTo:0,amount:1}];
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
  const capped = projectPublicPlaySequenceOpener(o,source,undefined,'left',false,true);
  assert.equal(window(capped).score,0);
  source.spec.abilities.play = [grant({mode:'playOrUse'})];
  assert.equal(projectPublicPlaySequenceOpener(o,source,undefined,'left',false,true),undefined);
});

test('ambiguous scheduled action returns and named play locks do not authorize a speculative route', () => {
  const source = card('source',{amber:2}), other = card('other',{playAmberCost:2}), o = view([source,other]);
  o.players[1].artifacts = [card('source-lock',{abilities:{play:[{kind:'chooseForbiddenName'}]}})];
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
  o.players[1].artifacts = [];
  o.players[0].discard = [card('returner',{abilities:{play:[{kind:'scheduleActionReturn'}]}})];
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
});

test('one shared key-response priority competes for the remaining play and survives zero ordinary premium', () => {
  const a = card('defend'), b = card('forge'), c = card('ordinary'), o = view([a,b,c]);
  const rate = (x) => ({ ...price(x === c ? 36 : 6), currentScore:x === c ? 36 : 3, currentKeyPriority:x !== c });
  const assess = () => assessPublicHandWindow(o,[a,b,c],rate,{projected:true});
  assert.equal(assess().score,178);
  assert.equal(assess().keyPriorityUsed,true);
  assert.equal(assess().selectedIds.filter((id) => id !== c.id).length,1);
  o.lasting = [{rule:'playLimit',turn:3,appliesTo:0,amount:1}];
  const capped = assess();
  assert.equal(capped.score,160);
  assert.equal(capped.selectedIds.length,1);
  assert.notEqual(capped.selectedIds[0],c.id);
  o.phase = 'house';
  assert.equal(publicHandWindowAvailable(o),false);
  assert.equal(assess().score,0);
  assert.equal(assess().keyPriorityUsed,false);
  o.phase = 'main';
  assert.equal(publicHandWindowAvailable(o),true);
  const historic = assessPublicHandWindow(o,[a,b,c],(x) => { const {currentKeyPriority,...value} = rate(x); return value; },{projected:true});
  assert.equal(historic.score,18);
  assert.deepEqual(historic.selectedIds,[c.id]);
  assert.equal(historic.keyPriorityUsed,false);
});

test('a funding opener and its freshly priced successor share the same key priority budget', () => {
  const opener = card('income',{amber:1}), follower = card('response',{playAmberCost:1}), o = view([opener,follower]);
  const assess = (openerPriority,followPriority) => assessPublicHandWindow(o,[opener,follower],
    () => ({ ...price(),currentKeyPriority:openerPriority }),{ projected:true,
      reprice:() => ({...price(),currentKeyPriority:followPriority}) });
  for (const [first,last] of [[true,true],[true,false],[false,true],[false,false]]) {
    const result = assess(first,last);
    assert.equal(result.score,6 + (first || last ? 160 : 0));
    assert.equal(result.keyPriorityUsed,first || last);
    assert.deepEqual(result.selectedIds,[opener.id,follower.id]);
  }
});

test('opposing Chronophage closes a simple creature play grant without leaving a generic or usable follow-up', () => {
  const source = card('helper-bot',{kind:'creature',abilities:{play:[grant()]}}), off = card('other',{house:'dis'});
  const o = view([source,off]);
  const omega = card('chronophage',{kind:'creature',grantsEnemyOmega:true});
  o.players[1].battleline = [{...omega,owner:1,controller:1}];
  assert.equal(projectPublicPlaySequenceOpener(o,source),undefined);
  const closed = projectPublicPlaySequenceOpener(o,source,undefined,'left',false,true);
  assert.equal(closed.turnStep.omega,true);
  assert.equal(publicHandWindowAvailable(closed),false);
  assert.equal(closed.permissions.length,1);
  const generic = () => price(1.5);
  const window = assessPublicHandWindow(o,[source,off],generic,{projected:true,playPermissionEstimate:1.5,reprice:generic});
  assert.equal(window.score,0);
  assert.equal(window.keyPriorityUsed,false);
});

test('a key response priced on the initial table cannot claim that proof after an unmodeled Alpha play', () => {
  const alpha = card('alpha',{alpha:true,abilities:{play:[{kind:'draw',amount:2}]}});
  const key = card('answer'), o = view([alpha,key]);
  const result = assessPublicHandWindow(o,[alpha,key],(c) => c === alpha ? price(24) :
    {...price(6),currentScore:3,currentKeyPriority:true},{projected:true});
  assert.equal(result.score,160);
  assert.deepEqual(result.selectedIds,[key.id]);
});

test('only a witnessed terminal native recovery may finish its projected resolving action before funding', () => {
  const fund = card('fund',{amber:2}), paid = card('paid',{playAmberCost:2});
  const source = card('source',{abilities:{play:[{kind:'target',operation:'returnHand',max:2,
    filter:{side:'friendly',zone:'discard'}}]}});
  const o = view([fund,paid]); o.pending = null;
  o.resolving = [source]; o.legalActions = [{id:'parent',action:{kind:'play',card:source.id}}];
  o.playedThisTurn = o.handOperations = o.turnStep.performed[0] = o.turnUsage.source = 1;
  const projected = () => projectPublicPlaySequenceOpener(o,fund,undefined,'left',true);
  const next = projected();
  assert.deepEqual(next.players[0].discard.map((c) => c.id),[source.id,fund.id]);
  assert.equal(next.playedThisTurn,2);
  assert.deepEqual(next.resolving,[]);
  assert.equal(projectPublicPlaySequenceOpener(o,fund),undefined);
  o.resolving.push(card('caller'));
  assert.equal(projected(),undefined);
  o.resolving.pop();
  o.lasting = [{rule:'playLimit',turn:3,appliesTo:0,amount:2}];
  assert.equal(projected(),undefined);
  o.lasting = [];
  source.spec.abilities.play[0].after = {when:'affected',effects:[{kind:'draw',amount:1}]};
  assert.equal(projected(),undefined);
});
