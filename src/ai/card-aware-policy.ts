/** Versioned public-state tactics: effects/targets plus optional action-order planning. */
import { rankForgeAware } from './forge-lock-policy.js';
import { adjustCardAwareSequence } from './card-aware-sequence.js';
import type { ActionAssessment, PublicActionCorrections } from './algorithm-policies.js';
import type { Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';

export const CARD_AWARE_POLICY_IDS = ['tactical-card-effects-v1', 'tactical-card-aware-v1'] as const;
export function rankCardAware(
  o: Observation,
  sequence = true,
  corrections: PublicActionCorrections = {},
): ActionAssessment[] {
  const rows = rankForgeAware(o, 'tactical', { netResources: true, contextualEffects: true, ...corrections });
  return sequence ? adjustCardAwareSequence(o, rows, 'tactical') : rows;
}
export function cardAwarePolicy(sequence = true): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankCardAware(o, sequence)[0].actionId;
  };
}
