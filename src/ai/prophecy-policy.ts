/** Prophecy choices use public face conditions and own visible Fate text, never hidden opposing Fate. */
import type { Action, CardView, House, Observation, Seat } from '../contracts/observation.js';
import { effectUtility, other, type TriggerTiming } from './season-utility.js';
export interface ProphecyOpportunity { probability:number; timing:TriggerTiming; }
export function prophecyOpportunity(o:Observation,face:string,owner:Seat):ProphecyOpportunity {
 const me=o.players[owner],foe=o.players[other(owner)],ready=foe.battleline.filter(c=>!c.stunned),
 counts=foe.houses.map(h=>ready.filter(c=>(c.effective.houses??[c.effective.house]).includes(h)).length),best=Math.max(0,...counts);
 switch(face){
 case 'stars-aligned':return {probability:me.battleline.length===foe.battleline.length?0.94:0.08,timing:'early'};
 case 'forge-ahead-with-confidence':return {probability:foe.keys.length===2||foe.forgeBlocked?0:foe.forgeAvailable>=foe.keyCost?0.95:0.15,timing:'early'};
 case 'ask-again-later':return {probability:me.deckCount>0?0.62:0.05,timing:'early'};
 case 'trust-your-feelings':return {probability:best>=3?0.65:0.38,timing:'early'};
 case 'outlook-not-so-good':return {probability:foe.houses.every(h=>o.players.some(p=>[...p.battleline,...p.artifacts,...p.upgrades].some(c=>(c.effective.houses??[c.effective.house]).includes(h))))?0.05:0.5,timing:'early'};
 case 'overreach':return {probability:ready.length?0.88:0.25,timing:'main'};
 case 'go-forth-and-conquer':return {probability:ready.length&&me.battleline.length?0.65:0.12,timing:'main'};
 case 'look-how-far-you-ve-come':return {probability:foe.handCount>=4?0.9:0.5,timing:'main'};
 case 'heads-i-win':return {probability:foe.battleline.length?0.75:0.2,timing:'main'};
 case 'tails-you-lose':return {probability:new Set(foe.battleline.map(c=>c.effective.house)).size>=2?0.6:0.3,timing:'main'};
 case 'fate-laughs-at-your-plans':return {probability:foe.archiveCount>=3?0.8:foe.archiveCount?0.5:0.05,timing:'early'};
 case 'expect-the-unexpected':return {probability:foe.deckCount<=3?0.85:foe.deckCount<=8?0.5:0.08,timing:'end'};
 case 'bad-omen':return {probability:foe.amber>=3&&foe.amber<=6?0.3:0.1,timing:'end'};
 case 'signs-point-to-yes':return {probability:foe.amber>=foe.keyCost-3?0.7:0.3,timing:'end'};
 case 'the-early-bird':return {probability:foe.amber+best>me.amber?0.75:0.2,timing:'end'};
 case 'the-second-mouse':return {probability:foe.amber+best<me.amber?0.7:0.2,timing:'end'};
 case 'the-cards-will-tell':return {probability:foe.houses.includes('logos')?0.75:0.4,timing:'main'};
 case 'it-only-gets-worse':return {probability:foe.houses.includes('shadows')&&me.amber>0?0.72:0.2,timing:'main'};
 case 'the-end-is-nigh':return {probability:me.battleline.length+foe.battleline.length>=7?0.4:0.1,timing:'main'};
 case 'treat-each-action-as-your-last':return {probability:foe.handCount>=5?0.5:0.2,timing:'main'};
 case 'wasteful-regret':return {probability:foe.handCount>=5?0.55:0.25,timing:'main'};
 case 'wounds-into-wisdom':return {probability:me.battleline.length&&(ready.length||foe.handCount>=4)?0.7:0.1,timing:'main'};
 default:return {probability:0,timing:'main'};
 }
}
export function fateBenefit(o:Observation,card:CardView,face:string,owner:Seat=o.you):number {
 const t=prophecyOpportunity(o,face,owner);
 return effectUtility(o,card.spec.abilities?.fate??[],other(owner),card,t.timing)*t.probability;
}
export function prophecyActivationScore(o:Observation,a:Extract<Action,{kind:'activateProphecy'}>,bestPlayScore:number):number {
 const card=o.players[o.you].hand?.find(c=>c.id===a.card),slot=o.prophecies?.find(p=>p.id===a.slot);
 if(!card||!slot||slot.owner!==o.you)return -100;
 const face=slot.faces[a.face],t=prophecyOpportunity(o,face,o.you),raw=fateBenefit(o,card,face);
 const printed=(card.resolvedBonusIcons??card.bonusIcons??Array<string>(card.spec.amber).fill('amber')).filter(x=>x==='amber').length;
 const offHouse=!(card.effective.houses??[card.effective.house]).includes(o.activeHouse!);
 const cost=Math.max(0,bestPlayScore)*0.3+printed*0.7+(offHouse?0:0.5);
 // A merely playable non-Fate card is not sacrificed to fill a slot. A low-cost off-house
 // discard-like cycle can be used only for a reasonably likely trigger and an overfull hand.
 if(!card.spec.abilities?.fate?.length)return offHouse&&o.players[o.you].handCount>7&&t.probability>0.7?0.4:-15;
 return raw-cost+(offHouse?0.8:0.1);
}
/** Only public trigger conditions are inferred; the opponent's facedown card is not inspected. */
export function directlyTriggers(o:Observation,a:Action,face:string):boolean {
 const me=o.players[o.you],foe=o.players[other(o.you)],card='card'in a?[...(me.hand??[]),...me.battleline,...me.artifacts].find(c=>c.id===a.card):undefined;
 if(face==='overreach')return a.kind==='reap';
 if(face==='go-forth-and-conquer')return a.kind==='fight';
 if(face==='wasteful-regret')return a.kind==='discard';
 if(face==='fate-laughs-at-your-plans')return a.kind==='takeArchives';
 if(face==='look-how-far-you-ve-come')return a.kind==='play'&&card?.spec.kind==='creature';
 if(face==='treat-each-action-as-your-last')return a.kind==='play'&&card?.spec.kind==='action'&&(o.playedTypes?.[o.you]?.action??0)===1;
 if(face==='outlook-not-so-good')return a.kind==='house'&&!!a.house&&!o.players.some(p=>[...p.battleline,...p.artifacts,...p.upgrades].some(c=>(c.effective.houses??[c.effective.house]).includes(a.house!)));
 if(a.kind==='play'&&card?.spec.kind==='creature'&&['heads-i-win','tails-you-lose'].includes(face)){
  const i=a.position??(a.flank==='left'?0:me.battleline.length),ns=[me.battleline[i-1],me.battleline[i]].filter((c):c is CardView=>!!c),hs=card.effective.houses??[card.effective.house];
  return ns.some(n=>(n.effective.houses??[n.effective.house]).some(h=>face==='heads-i-win'?hs.includes(h):!hs.includes(h)));
 }
 if(a.kind==='endTurn'){
  if(face==='bad-omen')return me.amber===6;
  if(face==='signs-point-to-yes')return me.amber>=me.keyCost;
  if(face==='the-early-bird')return me.amber>foe.amber;
  if(face==='the-second-mouse')return me.amber<foe.amber;
 }
 return false;
}
export function declaredHouseScore(o:Observation,house:House,owner:Seat):number {
 const foe=o.players[other(owner)];
 return foe.battleline.filter(c=>!c.stunned&&(c.effective.houses??[c.effective.house]).includes(house)).length*3+
   foe.deckList.filter(c=>c.house===house).reduce((n,c)=>n+c.count,0)*0.1;
}
