/** Explicitly versioned seasonal decisions, layered on unchanged tempo/tactical/economy families. */
import {rankLadder,type LadderFamily} from './ladder-policy.js';
import type {ActionAssessment} from './algorithm-policies.js';
import type {CardView,Effect,Observation} from '../contracts/observation.js';
import type {Policy} from './policies.js';
import {effectUtility,normalizeSeasonObservation,other,publicCards,publicValue,operationUtility} from './season-utility.js';
import {prophecyActivationScore,prophecyOpportunity,directlyTriggers,declaredHouseScore} from './prophecy-policy.js';
export const SEASON_POLICY_IDS=['tempo-season-v1','tactical-season-v1','economy-season-v1'] as const;
function supplementary(o:Observation,effects:readonly Effect[],source:CardView|undefined,depth=0):number {
 if(depth>6)return 0;let score=0;
 for(const e of effects){
  if(e.kind==='makeToken'||e.kind==='makeTokens')score+=effectUtility(o,[e],o.you,source);
  if(e.kind==='if'){
   const l=publicValue(o,e.condition.left,o.you,source),r=publicValue(o,e.condition.right,o.you,source);if(l===null||r===null)continue;
   const cmp=e.condition.comparison,yes=cmp==='eq'?l===r:cmp==='gt'?l>r:cmp==='gte'?l>=r:cmp==='lt'?l<r:l<=r;
   score+=supplementary(o,yes?e.then:e.otherwise??[],source,depth+1);
  }
  if(e.kind==='recur'||e.kind==='forEach') {const n=publicValue(o,e.count,o.you,source);if(n!==null)score+=Math.min(12,Math.max(0,n))*supplementary(o,e.effects,source,depth+1);}
 }
 return score;
}
export function rankSeason(o:Observation,family:LadderFamily='tactical'):ActionAssessment[] {
 const normalized=normalizeSeasonObservation(o),rows=rankLadder(normalized,family,'balanced'),
 legal=new Map(o.legalActions.map(x=>[x.id,x])),cards=new Map(publicCards(o).map(c=>[c.id,c])),me=o.players[o.you],foe=o.players[other(o.you)];
 const bestPlay=new Map<string,number>();
 for(const r of rows){const a=legal.get(r.actionId)!.action;if(a.kind==='play')bestPlay.set(a.card,Math.max(bestPlay.get(a.card)??-Infinity,r.score));}
 let tideScore=-Infinity;
 if(o.legalActions.some(x=>x.action.kind==='raiseTide')&&o.tide){
  const raised=normalizeSeasonObservation({...o,tide:{...o.tide,highFor:o.you,status:'high'}}),high=rankLadder(raised,family,'balanced'),best=new Map<string,number>();
  for(const r of high){const a=legal.get(r.actionId)!.action;if(!['play','reap','use'].includes(a.kind)||!('card'in a))continue;
   const before=rows.find(x=>x.actionId===r.actionId)!;
   const delta=r.score>=5000?Math.min(20,Math.max(0,r.score-before.score)):Math.max(0,r.score-before.score);
   best.set(a.card,Math.max(best.get(a.card)??0,delta));
  }
  const triggers=me.battleline.concat(me.artifacts).reduce((n,c)=>n+effectUtility(raised,c.spec.abilities?.tideRaised??[],o.you,c),0);
  tideScore=[...best.values()].reduce((a,b)=>a+b,0)*0.8+triggers-4.2;
 }
 return rows.map(row=>{
  const entry=legal.get(row.actionId)!,a=entry.action,c='card'in a?cards.get(a.card):undefined;
  if(row.score>=5000||a.kind==='forge'||a.kind==='payForge')return row;
  let score=row.score;const why:string[]=[];
  if(a.kind==='activateProphecy') {score=prophecyActivationScore(o,a,bestPlay.get(a.card)??0);why.push('season: match the actual Fate effect, opponent-perspective targets and trigger timing');}
  if(a.kind==='raiseTide'){score=tideScore;why.push('season: evaluate current high-tide work and raised triggers against the three-chain cost');}
  if(a.kind==='discard'&&c?.spec.abilities?.scrap){
   const afterDiscard:Observation={...o,haunted:[o.haunted?.[0]??o.players[0].discard.length>=10,o.haunted?.[1]??o.players[1].discard.length>=10],players:[{...o.players[0]},{...o.players[1]}]};
   afterDiscard.players[o.you]={...me,hand:(me.hand??[]).filter(x=>x.id!==c.id),handCount:me.handCount-1,discard:[...me.discard,c]};afterDiscard.haunted![o.you]=me.discard.length+1>=10;
   const value=effectUtility(afterDiscard,c.spec.abilities.scrap,o.you,c),opportunity=Math.max(0,bestPlay.get(c.id)??0)*0.3;
   score+=value-opportunity;why.push('season: Scrap is a real discard effect, not printed bonus icons');
  }
  if(c&&['play','use','reap','fight'].includes(a.kind)) {
   const effects=a.kind==='play'?c.spec.abilities?.play??[]:a.kind==='reap'?c.spec.abilities?.reap??[]:a.kind==='fight'?c.spec.abilities?.afterFight??[]:entry.useDescription?.effects??c.spec.abilities?.action??[];
   const added=supplementary(o,effects,c);if(added){score+=added*(family==='tempo'?1.15:family==='economy'?0.85:1);why.push('season: token creation has public board value, independently of hidden backing cards');}
  }
  if(a.kind==='house'){
   const work=[...(me.hand??[]),...me.battleline.filter(c=>c.ready&&!c.stunned),...me.artifacts.filter(c=>c.ready)].filter(c=>(c.effective.houses??[c.effective.house]).includes(a.house!));
   const tokenWork=work.reduce((n,c)=>n+((me.hand??[]).some(x=>x.id===c.id)?supplementary(o,c.spec.abilities?.play??[],c):Math.max(supplementary(o,c.spec.abilities?.reap??[],c),supplementary(o,c.spec.abilities?.action??[],c))),0);
   if(tokenWork){score+=Math.min(10,tokenWork)*(family==='tempo'?0.7:0.5);why.push('season: chosen house includes explicitly available token production');}
  }
  if(a.kind==='select'&&o.pending?.intent?.kind==='target-operation'&&['exalt','enrage','unward'].includes(o.pending.intent.operation)){
   const target=cards.get(a.target);if(target){score=operationUtility(o,target,o.pending.intent.operation,o.pending.amount,o.you);why.push('season: resource/ward cost of the explicit target operation');}
  }
  if(a.kind==='choose'&&o.pending){
   const option=o.pending.options?.find(x=>x.id===a.option),source=o.pending.source,intent=o.pending.intent;
   const slot=intent?.kind==='prophecy-face-choice'?o.prophecies?.find(p=>p.id===intent.slot):o.prophecies?.find(p=>p.id===source||p.cards?.some(c=>c.id===source));
   const faceChoice=intent?.kind==='prophecy-face-choice'?intent.options.find(x=>x.id===a.option):undefined;
   const houseChoice=intent?.kind==='house-choice'||intent?.kind==='house-restriction'?intent.options.find(x=>x.id===a.option)?.house:undefined;
   const selectedHouse=houseChoice&&option?.house===houseChoice?houseChoice:undefined;
   if(slot&&option&&faceChoice){
    const targetFace=faceChoice.operation==='flip'?slot.faces[slot.face===0?1:0]:slot.faces[slot.face];
    score=prophecyOpportunity(o,targetFace,slot.owner).probability;why.push('season: choose the available physical face, not an invented third prophecy');
   }
   if(slot&&option&&slot.faces[slot.face]==='ask-again-later'&&slot.owner!==o.you){
    const h=selectedHouse,p=o.players[slot.owner];
    if(h&&p.houses.includes(h)){
     const top=p.revealedTop,known=publicCards(o).filter(c=>c.owner===slot.owner&&!c.tokenCreature),
       original=p.deckList.filter(c=>c.house===h).reduce((n,c)=>n+c.count,0),
       exposed=known.filter(c=>(c.effective.houses??[c.effective.house]).includes(h)).length;
     score=top?((top.effective.houses??[top.effective.house]).includes(h)?100:0):Math.max(0,original-exposed);
     why.push('season: guess from revealed top or remaining public composition; unseen hand and order remain unknown');
    }
   }
   if(slot&&option&&slot.faces[slot.face]==='trust-your-feelings'&&slot.owner===o.you){
    const h=selectedHouse;
    if(h&&foe.houses.includes(h)){score=declaredHouseScore(o,h,o.you);why.push('season: declare opponent house from public board work, not hidden hand');}
   }
  }
  if(a.kind!=='activateProphecy')for(const p of o.prophecies??[]){
   if(p.active&&p.owner!==o.you&&!p.revealed&&directlyTriggers(o,a,p.faces[p.face])){
    score-=family==='tactical'?1.1:family==='tempo'?0.55:0.8;why.push('season: modest public-trigger risk; opposing latent Fate remains unknown');
   }
  }
  if(!Number.isFinite(score))throw Error('Nonfinite seasonal score');
  return {...row,score,reasons:[...row.reasons,...why],approximate:row.approximate||why.length>0};
 }).sort((a,b)=>b.score-a.score||a.actionId.localeCompare(b.actionId,'en'));
}
export function seasonPolicy(family:LadderFamily='tactical'):Policy{return o=>{if(!o.legalActions.length)throw Error('No legal decision');return rankSeason(o,family)[0].actionId;};}
