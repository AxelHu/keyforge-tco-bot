import type { CardKind, CardView, House, Observation } from '../contracts/observation.js';
import { publicPlayEndsStep } from './public-card-value.js';
import { publicFutureEffectActive, publicFuturePlayLimit, publicFuturePlayRestriction, publicNextHouseChoices,
  publicNextHouseTurn } from './future-house-play-rules.js';

const playEvents = new Set(['actionBeforePlay', 'bonusResolved', 'bonusDamage', 'cardPlayed',
  'creatureEntered', 'creaturePlayed', 'artifactPlayed', 'upgradeEntered']);

// Match the structured, unconditional effect only. A nested if, reaction on the enemy's
// play or a play from a particular pile cannot be inferred from a retained hand card.
function rewardKind(c: CardView): CardKind | undefined {
  const d = c.spec;
  for (const e of d.abilities?.play ?? []) {
    if (e.kind !== 'lasting' || e.duration !== 'turn' || e.amount !== 1 ||
      e.side !== undefined && e.side !== 'self' || e.countFilter || e.house || e.unmodeled) continue;
    if (e.rule === 'creaturePlayGain') return 'creature';
    if (e.rule === 'actionPlayGain') return 'action';
  }
  if (d.kind !== 'creature' && d.kind !== 'artifact') return;
  for (const r of d.reactions ?? []) {
    const [e] = r.effects;
    if (r.side !== 'friendly' || r.effects.length !== 1 || e.kind !== 'gain' || e.amount !== 1 ||
      e.unmodeled || Object.keys(r).some((k) => !['event', 'side', 'other', 'effects'].includes(k))) continue;
    if (r.event === 'creaturePlayed') return 'creature';
    if (r.event === 'artifactPlayed') return 'artifact';
  }
}

// Unknown effects can close the play step, spend or remove another held card or
// remove a permanent enabler. They may be last, after the play event has occurred.
function continues(c: CardView): boolean {
  const d = c.spec;
  return !d.onePlayPerType && !d.prohibitOwnCreatures && !d.noPlayCreaturesWhileAhead &&
    !d.creaturePlayLimits?.length && !d.forbidMorePowerfulCreaturePlay && !d.grantsEnemyOmega &&
    !d.opponentArtifactPlayTax && !d.replacesEnemyActionPlayWithOwnLeftDestruction &&
    !d.reactions?.some((r) => playEvents.has(r.event) && !(
      r.effects.every((e) => e.kind === 'gain' && typeof e.amount === 'number'))) &&
    (c.resolvedBonusIcons ?? c.bonusIcons ?? []).every((icon) => icon === 'amber') &&
    (d.abilities?.play ?? []).every((e) => !('unmodeled' in e && e.unmodeled) && (
      e.kind === 'gain' && typeof e.amount === 'number' ||
      e.kind === 'lasting' && ['creaturePlayGain', 'actionPlayGain'].includes(e.rule)
    ));
}

function simple(c: CardView): boolean {
  const d = c.spec;
  return !d.tokenReference && !d.unmodeled && !d.cannotPlay && !d.playCondition && !d.minAmberToPlay && !d.playAmberCost &&
    !d.mimicAction && !d.mimicCreature && !d.requiresUntamedDiscard && !d.entersOpponentControl &&
    !d.conditionalAbilities?.length && !c.gainedTextBoxes?.length && !c.copiedCharacteristics &&
    !c.copiedBonusHouses && !c.copiedBonusIcons;
}

/** Number of distinct later plays earning one extra pool amber from ONE newly played
 * enabler. The input contains only retained, ordinary physical cards in this house.
 * Evaluate a future own house turn against known persistent constraints. Today's
 * temporary limits and counters expire. No intervening plays or draws are predicted. */
export function retainedPlayPartnerCount(o: Observation, h: House, cards: readonly CardView[],
  boardOriginIds: ReadonlySet<string>): number {
  if (cards.length < 2 || o.publicStateCoverage?.effectsComplete === false) return 0;
  const possible = cards.filter((c) => simple(c) && !boardOriginIds.has(c.id) && rewardKind(c) && continues(c));
  if (!possible.length) return 0;

  const table = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  const me = o.players[o.you], enemy = o.players[o.you === 0 ? 1 : 0];
  const future = publicNextHouseTurn(o);
  if (future === undefined || !publicNextHouseChoices(o, future)?.has(h)) return 0;
  const effects = (o.lasting ?? []).filter((e) => e.appliesTo === o.you && publicFutureEffectActive(o,e,future));
  if (effects.some((e) => e.rule === 'poolIncomeBecomesTokens')) return 0;
  // These already-visible sources interfere with routing, gain, or the pair's ordering.
  if (table.some((c) => c.spec.unmodeled || c.gainedTextBoxes?.length || c.spec.onePlayPerType ||
    c.spec.creaturePlayLimits?.length || c.spec.forbidMorePowerfulCreaturePlay ||
    c.spec.upgrade?.hostForbidMorePowerfulEnemyPlay || c.spec.noPlayCreaturesWhileAhead ||
    c.spec.grantsAbilities?.length || c.spec.reactions?.some((r) => playEvents.has(r.event) &&
      !r.effects.every((e) => e.kind === 'gain' && typeof e.amount === 'number')) ||
    c.controller !== o.you && (c.spec.capturesIncomingAmber || c.spec.replacesEnemyActionPlayWithOwnLeftDestruction))) return 0;
  const creatureBlocked = table.some((c) => c.controller === o.you && c.spec.prohibitOwnCreatures ||
      c.controller !== o.you && c.spec.forbidsEnemyRightFlankPlay && !me.battleline.length);
  const artifactTax = enemy.artifacts.concat(enemy.battleline, enemy.upgrades).some((c) => c.spec.opponentArtifactPlayTax);
  const cap = Math.min(3, publicFuturePlayLimit(o, future));
  if (cap < 2) return 0;
  const usable = (c: CardView) => !(c.spec.kind === 'creature' && creatureBlocked || c.spec.kind === 'artifact' && artifactTax) &&
    publicFuturePlayRestriction(o,c,future,h) === 'allowed';
  let best = 0;
  for (const source of possible) {
    if (!usable(source) || publicPlayEndsStep(o, source) || effects.some((e) =>
      source.spec.kind === 'creature' && e.rule === 'blankCreatures' ||
      e.rule === 'blankBoostNamed' && e.affectedName === source.spec.name && source.spec.kind !== 'action')) continue;
    const kind = rewardKind(source);
    let ordinary = 0, final = 0;
    for (const follow of cards) {
      if (follow.id === source.id || follow.spec.kind !== kind || !simple(follow) || follow.spec.alpha || !usable(follow)) continue;
      if (publicPlayEndsStep(o, follow) || !continues(follow)) final = 1;
      else ordinary++;
    }
    best = Math.max(best, Math.min(ordinary + final, cap - 1));
  }
  return best;
}
