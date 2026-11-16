/** User-guided prophecy cycling, versioned separately from frozen seasonal V1–V3. */
import type { Action, CardView, Observation } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { LadderFamily } from './ladder-policy.js';
import type { Policy } from './policies.js';
import { fateBenefit, prophecyOpportunity } from './prophecy-policy.js';
import { publicRefillForecast } from './public-refill-planning.js';
import { explicitSeasonFilterZones, rankSeasonFiltered } from './season-filter-policy.js';
import { effectUtility } from './season-utility.js';

export const PROPHECY_GUIDED_POLICY_IDS = [
  'tempo-prophecy-guided-v4',
  'tactical-prophecy-guided-v4',
  'economy-prophecy-guided-v4',
] as const;

export interface ProphecyGuidanceAssessment {
  score: number;
  triggerProbability: number;
  additionalRefill: number;
  cycleValue: number;
  retentionCost: number;
  slotCost: number;
  fateValue: number;
}

function retention(o: Observation, c: CardView): number {
  const icons = c.resolvedBonusIcons ?? c.bonusIcons ?? Array<string>(c.spec.amber).fill('amber');
  const printed = icons.filter((icon) => icon === 'amber').length;
  const knownPlay = Math.max(0, effectUtility(o, c.spec.abilities?.play ?? [], o.you, c));
  const recurring =
    (c.spec.reactions?.length ?? 0) > 0 ||
    (c.spec.grantsAbilities?.length ?? 0) > 0 ||
    !!c.spec.drawBonus ||
    !!c.spec.drawBonusValue ||
    !!c.spec.opponentKeyTax ||
    Object.entries(c.spec.abilities ?? {}).some(
      ([trigger, effects]) =>
        ['startTurn', 'anyStartTurn', 'endTurn', 'anyEndTurn', 'anyHouseChosen'].includes(trigger) &&
        effects.length > 0,
    );
  const engine = [
    'well-of-memory',
    'island-of-misfit-toys',
    'ecto-charge',
    'cauldron',
    'haunting-witch',
  ].includes(c.definition);
  const creature = c.spec.kind === 'creature' ? 0.45 + Math.min(8, c.effective.power) * 0.05 : 0;
  return printed * 0.8 + Math.min(12, knownPlay) * 0.22 + creature + (recurring ? 2.5 : 0) + (engine ? 4 : 0);
}

/** All values are heuristic public-information utilities. Activation itself never draws a card. */
export function assessGuidedProphecy(
  o: Observation,
  a: Extract<Action, { kind: 'activateProphecy' }>,
  bestPlayScore = 0,
): ProphecyGuidanceAssessment {
  const rejected: ProphecyGuidanceAssessment = {
    score: -100,
    triggerProbability: 0,
    additionalRefill: 0,
    cycleValue: 0,
    retentionCost: 0,
    slotCost: 0,
    fateValue: 0,
  };
  const me = o.players[o.you];
  const card = me.hand?.find((c) => c.id === a.card);
  const slot = o.prophecies?.find((p) => p.id === a.slot);
  if (
    !card ||
    !slot ||
    slot.owner !== o.you ||
    slot.active ||
    slot.count > 0 ||
    o.prophecyActivatedThisTurn?.[o.you]
  )
    return rejected;
  const face = slot.faces[a.face];
  if (!face) return rejected;
  const opportunity = prophecyOpportunity(o, face, o.you);
  const before = publicRefillForecast(o);
  const after = publicRefillForecast(o, Math.max(0, me.handCount - 1));
  const supply = me.deckCount + me.discard.length;
  const additionalRefill = Math.max(0, Math.min(supply, after.draws) - Math.min(supply, before.draws));
  const offHouse = !(card.effective.houses ?? [card.effective.house]).includes(o.activeHouse!);
  // Releasing a low-value off-house card creates room at a normal six-card hand too.
  // A very large hand receives only a small future-liquidity value, not an invented immediate draw.
  const cycleValue = (additionalRefill * 1.9 + (offHouse ? 0.35 : 0)) * opportunity.probability;
  const retentionCost = retention(o, card) + Math.max(0, bestPlayScore) * 0.3 + (offHouse ? 0 : 0.35);
  const openSlots = (o.prophecies ?? []).filter(
    (p) => p.owner === o.you && !p.active && p.count === 0,
  ).length;
  const slotCost = 0.35 + (1 - opportunity.probability) * 1.5 + (openSlots <= 1 ? 0.4 : 0);
  const fateValue = fateBenefit(o, card, face);
  const score = fateValue + cycleValue - retentionCost - slotCost;
  return {
    score: Number.isFinite(score) ? score : -100,
    triggerProbability: opportunity.probability,
    additionalRefill,
    cycleValue,
    retentionCost,
    slotCost,
    fateValue,
  };
}

export function rankProphecyGuided(o: Observation, family: LadderFamily = 'tactical'): ActionAssessment[] {
  const rows = rankSeasonFiltered(o, family);
  const normalized = explicitSeasonFilterZones(o);
  const legal = new Map(o.legalActions.map((a) => [a.id, a.action]));
  const bestPlay = new Map<string, number>();
  for (const row of rows) {
    const a = legal.get(row.actionId)!;
    if (a.kind === 'play') bestPlay.set(a.card, Math.max(bestPlay.get(a.card) ?? -Infinity, row.score));
  }
  return rows
    .map((row) => {
      const a = legal.get(row.actionId)!;
      if (a.kind !== 'activateProphecy' || row.score >= 5000) return row;
      const evaluation = assessGuidedProphecy(normalized, a, bestPlay.get(a.card) ?? 0);
      return {
        ...row,
        score: evaluation.score,
        approximate: true,
        reasons: [
          ...row.reasons,
          'guided prophecy: normal-refill cycling, trigger delay, retained-card value and slot occupancy are separate; activation does not draw',
        ],
      };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}

export function prophecyGuidedPolicy(family: LadderFamily = 'tactical'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankProphecyGuided(o, family)[0].actionId;
  };
}
