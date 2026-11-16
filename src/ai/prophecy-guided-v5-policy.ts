/** V5 rejects untrusted refill credits and otherwise delegates unchanged V4 scoring. */
import type { Action, Observation } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { LadderFamily } from './ladder-policy.js';
import type { Policy } from './policies.js';
import { assessGuidedProphecy, rankProphecyGuided } from './prophecy-guided-policy.js';
import { refillGuidanceStatus } from './public-guidance-guards.js';
import { rankSeasonFiltered } from './season-filter-policy.js';

export const PROPHECY_GUIDED_V5_POLICY_IDS = [
  'tempo-prophecy-guided-v5',
  'tactical-prophecy-guided-v5',
  'economy-prophecy-guided-v5',
] as const;

export interface ProphecyGuidanceV5Assessment {
  score: number;
  additionalRefill: number;
  cycleValue: number;
  refillKnown: boolean;
  usedBaseline: boolean;
}

/**
 * In fallback mode score comes from the pre-guidance policy; it is deliberately
 * not presented as the sum of V4's costs. No untrusted extra draw/cycle is credited.
 */
export function assessGuidedProphecyV5(
  o: Observation,
  a: Extract<Action, { kind: 'activateProphecy' }>,
  bestPlayScore = 0,
  family: LadderFamily = 'tactical',
): ProphecyGuidanceV5Assessment {
  if (refillGuidanceStatus(o).known) {
    const evaluation = assessGuidedProphecy(o, a, bestPlayScore);
    return {
      score: evaluation.score,
      additionalRefill: evaluation.additionalRefill,
      cycleValue: evaluation.cycleValue,
      refillKnown: true,
      usedBaseline: false,
    };
  }
  const entry = o.legalActions.find(
    (x) =>
      x.action.kind === 'activateProphecy' &&
      x.action.slot === a.slot &&
      x.action.face === a.face &&
      x.action.card === a.card,
  );
  const original = entry ? rankSeasonFiltered(o, family).find((row) => row.actionId === entry.id) : undefined;
  return {
    score: original?.score ?? -100,
    additionalRefill: 0,
    cycleValue: 0,
    refillKnown: false,
    usedBaseline: true,
  };
}

export function rankProphecyGuidedV5(o: Observation, family: LadderFamily = 'tactical'): ActionAssessment[] {
  return refillGuidanceStatus(o).known ? rankProphecyGuided(o, family) : rankSeasonFiltered(o, family);
}

export function prophecyGuidedPolicyV5(family: LadderFamily = 'tactical'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankProphecyGuidedV5(o, family)[0].actionId;
  };
}
