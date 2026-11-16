/** Small, bounded public-information utilities. This is NOT another rules executor. */
import type { CardView, Effect, Filter, House, Observation, Seat, Side, Value } from '../contracts/observation.js';
export type TriggerTiming = 'early' | 'main' | 'end';
export const other = (seat:Seat):Seat => seat===0?1:0;
export const actualSide = (actor:Seat, side?:Side):Seat|null => !side||side==='self'?actor:side==='opponent'?other(actor):null;
const knownZones=['hand','archives','battleline','artifacts','upgrades','discard','purged'] as const;
export function boardValue(c:CardView):number {
 return 2.8+Math.min(10,c.effective.power)*0.22+(c.spec.drawBonus??0)*2+(c.spec.opponentKeyTax??0)*2+(c.spec.opponentDrawPenalty??0)*1.3-(c.spec.prohibitOwnCreatures?9:0)-(c.spec.skipForgeStep?12:0);
}
export function publicCards(o:Observation):CardView[] {
 return [...new Map([...o.players.flatMap(p=>knownZones.flatMap(z=>p[z]??[])),...o.resolving,...o.promptCards,...o.underCards.flatMap(x=>x.cards??[])].map(c=>[c.id,c])).values()];
}
/** Unsupported binding/relative filters do not become an unrestricted target set. */
export function publicTargets(o:Observation,filter:Filter,actor:Seat,source?:CardView):CardView[]|null {
 const admitted=new Set(['zone','side','kind','house','notHouse','definition','trait','notTrait','other','flank','flankSide','ready','stunned','damaged','withAmber','warded','enraged','powerMin','powerMax','powerExtreme','keyword','any','tokenCreature','hasArmor','hasPowerCounters','hostSide']);
 if(Object.keys(filter).some(k=>!admitted.has(k)))return null;
 if(filter.house==='chosenHouse'||filter.notHouse==='chosenHouse')return null;
 const zones=filter.zone?[filter.zone].flat():['play'];
 if(zones.includes('deck'))return null;
 let list=publicCards(o).filter(c=>{
  const p=o.players[c.controller],line=p.battleline, ix=line.findIndex(x=>x.id===c.id);
  const zone=zones.some(z=>z==='play'?[...p.battleline,...p.artifacts,...p.upgrades].some(x=>x.id===c.id):knownZones.includes(z as typeof knownZones[number])&&o.players.some(q=>(q[z as typeof knownZones[number]]??[]).some(x=>x.id===c.id)));
  const hs=c.effective.houses??[c.effective.house];
  return zone&&(!filter.side||filter.side==='any'||(filter.side==='friendly'?c.controller===actor:c.controller!==actor))
   &&(!filter.kind||filter.kind===c.spec.kind)&&(!filter.house||hs.includes(filter.house as House))&&(!filter.notHouse||!hs.includes(filter.notHouse as House))
   &&(!filter.definition||c.definition===filter.definition)&&(!filter.trait||c.spec.traits?.includes(filter.trait))&&(!filter.notTrait||!c.spec.traits?.includes(filter.notTrait))
   &&(!filter.other||c.id!==source?.id)&&(filter.ready===undefined||c.ready===filter.ready)&&(filter.stunned===undefined||c.stunned===filter.stunned)
   &&(filter.damaged===undefined||(c.damage>0)===filter.damaged)&&(filter.withAmber===undefined||(c.captured>0)===filter.withAmber)
   &&(filter.warded===undefined||c.warded===filter.warded)&&(filter.enraged===undefined||c.enraged===filter.enraged)
   &&(filter.powerMin===undefined||c.effective.power>=filter.powerMin)&&(filter.powerMax===undefined||c.effective.power<=filter.powerMax)
   &&(!filter.keyword||c.effective.keywords.includes(filter.keyword))&&(filter.flank===undefined||((ix===0||ix===line.length-1)&&ix>=0)===filter.flank)
   &&(!filter.flankSide||ix===(filter.flankSide==='left'?0:line.length-1))
   &&(filter.hasArmor===undefined||(c.effective.armor>0)===filter.hasArmor)&&(filter.hasPowerCounters===undefined||(c.powerCounters>0)===filter.hasPowerCounters)
   &&(filter.tokenCreature===undefined||!!c.tokenCreature===filter.tokenCreature)
   &&(!filter.hostSide||!!c.attachedTo&&o.players[filter.hostSide==='friendly'?actor:other(actor)].battleline.some(x=>x.id===c.attachedTo));
 });
 if(filter.any){const sets=filter.any.map(f=>publicTargets(o,{...filter,any:undefined,...f},actor,source));if(sets.some(x=>x===null))return null;const ids=new Set(sets.flatMap(x=>x!.map(c=>c.id)));list=list.filter(c=>ids.has(c.id));}
 if(filter.powerExtreme&&list.length){const p=Math[filter.powerExtreme](...list.map(c=>c.effective.power));list=list.filter(c=>c.effective.power===p);}
 return list;
}
export function publicValue(o:Observation,v:Value|undefined,actor:Seat,source?:CardView):number|null {
 if(v===undefined)return 0;if(typeof v==='number')return v;
 const side='side'in v?actualSide(actor,v.side):actor;if(side===null)return null;
 const p=o.players[side];
 if('haunted'in v)return Number(o.haunted?.[side]??p.discard.length>=10);
 if('tide'in v)return Number(v.tide==='neutral'?o.tide?.highFor===null:v.tide==='high'?o.tide?.highFor===side:o.tide?.highFor===other(side));
 if('discardAtLeast'in v)return Number(p.discard.length>=v.discardAtLeast);
 if('sourceAmber'in v)return source?.captured??null;
 if('sourcePower'in v)return source?.effective.power??null;
 if('sourceArmor'in v)return source?.effective.armor??null;
 if('sourcePowerCounters'in v)return source?.powerCounters??null;
 if('sourceDamage'in v)return source?.damage??null;
 if('friendlyExaltedThisTurn'in v)return Number(o.friendlyExaltedThisTurn?.[side]??false);
 if('tokenReferenceIs'in v)return Number(o.tokenReferences?.[side]?.id===v.tokenReferenceIs);
 if('ownTurn'in v)return Number(o.activePlayer===actor);
 if('activeIsController'in v)return Number(o.activePlayer===(source?.controller??actor));
 if('metric'in v){switch(v.metric){case 'amber':return p.amber;case 'keys':return p.keys.length;case 'handSize':return p.handCount;case 'archives':return p.archiveCount;case 'forgedThisTurn':return Number(p.lastForgedTurn===o.turn);case 'forgedLastTurn':return Number(p.lastForgedTurn===o.turn-1);case 'playedThisTurn':return o.playedThisTurn;case 'creaturesPlayedThisTurn':return o.creaturesPlayedThisTurn;case 'enemyFightDeaths':return o.publicCounters.enemyFightDeaths;default:return null;}}
 if('count'in v){const t=publicTargets(o,v.count,actor,source);return t===null?null:t.length*(v.multiplier??1);}
 if('add'in v){const xs=v.add.map(x=>publicValue(o,x,actor,source));return xs.some(x=>x===null)?null:xs.reduce<number>((n,x)=>n+x!,0);}
 if('subtract'in v){const [a,b]=v.subtract.map(x=>publicValue(o,x,actor,source));return a===null||b===null?null:a-b;}
 for(const kind of ['half','ceilHalf','floorThird','ceilThird','negate'] as const)if(kind in v){const n=publicValue(o,(v as Record<typeof kind,Value>)[kind],actor,source);if(n===null)return null;return kind==='half'?Math.floor(n/2):kind==='ceilHalf'?Math.ceil(n/2):kind==='floorThird'?Math.floor(n/3):kind==='ceilThird'?Math.ceil(n/3):-n;}
 return null;
}
export function operationUtility(o:Observation,c:CardView,operation:string,n:number,actor:Seat):number {
 const sign=c.controller===o.you?1:-1, worth=boardValue(c);
 if(['destroy','purge','shuffleDeck','returnHand','archive'].includes(operation)){
  if(operation==='destroy'&&(c.spec.invulnerable||c.spec.invulnerableCondition))return 0;
  if(c.warded&&['destroy','returnHand','shuffleDeck','archive'].includes(operation))return -sign*1.5;
  const inPlay=o.players.some(p=>[...p.battleline,...p.artifacts,...p.upgrades].some(x=>x.id===c.id));
  if(!inPlay)return operation==='returnHand'?sign*(2+(c.spec.amber??0)):operation==='purge'?-sign*0.5:0;
  return -sign*(worth+(operation==='archive'||operation==='returnHand'?-1:0)+c.captured*3);
 }
 if(operation==='damage'){
  if(c.spec.invulnerable||c.spec.cannotBeDamagedCondition||c.spec.invulnerableCondition)return 0;
  if(c.warded)return n>0?-sign*1.5:0;
  const hit=Math.max(0,n-Math.max(0,c.effective.armor-c.armorUsed));
  return -sign*(hit>=c.effective.power-c.damage?worth+c.captured*3:hit*0.45);
 }
 if(operation==='heal')return sign*Math.min(n,c.damage)*0.45;
 if(operation==='ward')return sign*(c.warded?0:Math.min(3,worth*0.6));
 if(operation==='unward')return -sign*(c.warded?Math.min(3,worth*0.6):0);
 if(operation==='power')return sign*n*0.55;
 if(operation==='ready')return sign*(c.ready||c.readiness?.cannotReadyByEffect?0:3);
 if(operation==='exhaust')return -sign*(c.ready?2.6:0);
 if(operation==='stun'||operation==='stunExhaust')return -sign*(c.stunned?0:3);
 if(operation==='capture')return sign*Math.min(n,o.players[other(actor)].amber)*2;
 if(operation==='captureOwn')return -sign*Math.min(n,o.players[actor].amber)*2.5;
 if(operation==='exalt')return -sign*Math.max(1,n)*1.6;
 if(operation==='discard')return -sign*(1.7+c.spec.amber);
 return 0;
}
export function effectUtility(o:Observation,effects:readonly Effect[],actor:Seat,source?:CardView,timing:TriggerTiming='main',depth=0):number {
 if(depth>8)return 0;
 const sign=(seat:Seat)=>seat===o.you?1:-1;
 const val=(v:Value|undefined)=>publicValue(o,v,actor,source);
 let total=0;
 const choose=(xs:number[],optional=false)=>{const values=optional?[...xs,0]:xs;return values.length?(actor===o.you?Math.max(...values):Math.min(...values)):0;};
 for(const e of effects){
  if(['gain','loseOpponent','draw','chains','steal','capture'].includes(e.kind)){
   const n=val((e as {amount:Value}).amount);if(n===null)continue;
   if(e.kind==='gain')total+=sign(actor)*n*3.5;
   if(e.kind==='loseOpponent')total-=sign(other(actor))*Math.min(n,o.players[other(actor)].amber)*3.4;
   if(e.kind==='draw')total+=sign(actor)*n*1.5;
   if(e.kind==='chains')total-=sign(actor)*n*1.3;
   if(e.kind==='steal')total+=sign(actor)*Math.min(n,o.players[other(actor)].amber)*6;
   if(e.kind==='capture')total+=sign(actor)*Math.min(n,o.players[other(actor)].amber)*1.7;
  } else if(e.kind==='resource'){
   const seat=actualSide(actor,e.side),n=val(e.amount);if(seat===null||n===null)continue;
   total+=sign(seat)*(e.operation==='gain'?n*3.5:e.operation==='lose'?-Math.min(n,o.players[seat].amber)*3.4:e.operation==='steal'?Math.min(n,o.players[other(seat)].amber)*6:e.operation==='draw'?n*1.5:e.operation==='chains'?-n*1.3:0);
  } else if(e.kind==='if'){
   const l=val(e.condition.left),r=val(e.condition.right);if(l===null||r===null)continue;
   const cmp=e.condition.comparison,yes=cmp==='eq'?l===r:cmp==='gt'?l>r:cmp==='gte'?l>=r:cmp==='lt'?l<r:l<=r;
   total+=effectUtility(o,yes?e.then:e.otherwise??[],actor,source,timing,depth+1);
  } else if(e.kind==='all'||e.kind==='target'){
   const targets=publicTargets(o,e.filter,actor,source),n=val(e.amount);if(targets===null||n===null)continue;
   const values=targets.map(c=>operationUtility(o,c,e.operation,n,actor));
   total+=e.kind==='all'?values.reduce((a,b)=>a+b,0):choose(values);
  } else if(e.kind==='self'){
   if(source)total+=operationUtility(o,source,e.operation,val(e.amount)??0,actor);
  } else if(e.kind==='makeToken'||e.kind==='makeTokens'){
   const seat=actualSide(actor,e.side),n=e.kind==='makeToken'?1:val(e.count);if(seat===null||n===null)continue;
   const ref=o.tokenReferences?.[seat];total+=sign(seat)*Math.min(12,Math.max(0,n))*Math.max(1,2.3+(ref?.power??1)*0.15-(ref?.prohibitOwnCreatures?4:0));
  } else if(e.kind==='randomDiscard'){
   const seat=actualSide(actor,e.side);if(seat===null)continue;
   total-=sign(seat)*Math.min(e.amount,e.zone==='discard'?o.players[seat].discard.length:o.players[seat].handCount)*(e.zone==='discard'?0.4:1.8);
  } else if(e.kind==='asPlayer'){
   const seat=actualSide(actor,e.side);if(seat!==null)total+=effectUtility(o,e.effects,seat,source,timing,depth+1);
  } else if(e.kind==='eachPlayer'){
   total+=effectUtility(o,e.effects,0,source,timing,depth+1)+effectUtility(o,e.effects,1,source,timing,depth+1);
  } else if(e.kind==='forEach'||e.kind==='recur'){
   const n=val(e.count);if(n!==null)total+=Math.min(12,Math.max(0,n))*effectUtility(o,e.effects,actor,source,timing,depth+1);
  } else if(e.kind==='payOpponent'){
   const n=val(e.amount);if(n!==null)total+=sign(other(actor))*Math.min(n,o.players[actor].amber)*6;
  } else if(e.kind==='putSource'&&source){
   const seat=e.controller==='owner'?source.owner:actualSide(actor,e.controller);if(seat!==null)total+=sign(seat)*boardValue(source);
  } else if(e.kind==='forgeEffect'){
   const p=o.players[actor],delta=val(e.delta),reduction=val(e.reduction);if(delta===null||reduction===null)continue;
   const cost=Math.max(e.minimumCost??0,e.fixedCost??p.keyCost+delta-reduction);
   if(!p.forgeBlocked&&p.forgeAvailable>=cost)total+=sign(actor)*(p.keys.length===2?100:20);
  } else if(e.kind==='lasting'){
   const seat=actualSide(actor,e.side);if(seat===null)continue;
   const p=o.players[seat],timingScale=timing==='early'?1:timing==='main'?0.65:0;
   const useValue=Math.min(6,p.battleline.filter(c=>!c.stunned).length)*1.6;
   const bodyPlayValue=Math.min(6,p.handCount)*1.1;
   const value=e.rule==='noPlay'?bodyPlayValue*1.5:e.rule==='noCreatures'?bodyPlayValue:e.rule==='noReap'?useValue:e.rule==='noFight'?useValue*0.4:e.rule==='skipReadyStep'?useValue:e.rule==='pvActionPlayLose'?Math.min(4,p.handCount)*1.4:e.rule==='pvUseNeighborsDamage'?useValue*0.6:0;
   total-=sign(seat)*value*timingScale;
  } else if(e.kind==='archiveTop'){
   const seat=actualSide(actor,e.side);if(seat!==null)total+=sign(seat)*1.4;
  }
 }
 return Math.max(-100,Math.min(100,total));
}
/** Fold only known current public seasonal Value leaves. Historical policies are not edited. */
export function normalizeSeasonObservation(o:Observation):Observation {
 function fold(x:unknown,actor:Seat):unknown {
  if(!x||typeof x!=='object')return x;
  if(Array.isArray(x)){const n=x.map(v=>fold(v,actor));return n.every((v,i)=>v===x[i])?x:n;}
  const obj=x as Record<string,unknown>;
  if(obj.kind==='eachPlayer')return x; // One shared subtree has two different value perspectives.
  if(obj.kind==='asPlayer'){const seat=actualSide(actor,obj.side as Side);if(seat===null)return x;const e=fold(obj.effects,seat);return e===obj.effects?x:{...obj,effects:e};}
  if((Object.hasOwn(obj,'haunted')&&obj.haunted===true)||(Object.hasOwn(obj,'tide')&&typeof obj.tide==='string')||Object.hasOwn(obj,'discardAtLeast')||Object.hasOwn(obj,'friendlyExaltedThisTurn')||Object.hasOwn(obj,'tokenReferenceIs')){
   const value=publicValue(o,obj as Value,actor);if(value!==null)return value;
  }
  const entries=Object.entries(obj).map(([k,v])=>[k,fold(v,actor)] as const);
  return entries.every(([k,v])=>v===obj[k])?x:Object.fromEntries(entries);
 }
 const card=(c:CardView):CardView=>{const spec=fold(c.spec,c.controller) as CardView['spec'];return spec===c.spec?c:{...c,spec};};
 const player=(p:Observation['players'][0])=>({...p,...Object.fromEntries(knownZones.map(z=>[z,p[z]?.map(card)])),...(p.revealedTop?{revealedTop:card(p.revealedTop)}:{})});
 return {...o,legalActions:o.legalActions.map(a=>a.useDescription?{...a,useDescription:{...a.useDescription,effects:fold(a.useDescription.effects,o.you) as Effect[]}}:a),players:[player(o.players[0]),player(o.players[1])],resolving:o.resolving.map(card),promptCards:o.promptCards.map(card),underCards:o.underCards.map(r=>({...r,...(r.cards?{cards:r.cards.map(card)}:{})}))};
}
