/** Effects-only V3 candidate. V2 remains a frozen baseline; no future-state or rating input. */
import type { CardView, Observation } from '../contracts/observation.js';
import type { ActionAssessment, PublicActionCorrections } from './algorithm-policies.js';
import { rankCardAwareV2 } from './card-aware-v2-policy.js';
import { rankForgeAware } from './forge-lock-policy.js';
import type { Policy } from './policies.js';

export const CARD_EFFECTS_V3_POLICY_IDS = ['tactical-card-effects-v3'] as const;
const CRITICAL = 5000;
const TARGETS = new Set(['they-tell-no-tales', 'infurnace']);
const corrections = { netResources: true, contextualEffects: true } as const;
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');

/** Only actual card plays and their actual visible prompts are recomputed.
 * House selection, Prism's hypothetical future hand work, and prophecy retention
 * keep V2 behavior so the effects correction can be measured independently.
 */
export function rankCardAwareV3(
  o: Observation,
  publicCorrections: PublicActionCorrections = {},
): ActionAssessment[] {
  publicCorrections = { publicCardLifecycle: true, publicHandOpportunityGroups: true, ...publicCorrections };
  const inherited = rankCardAwareV2(o, publicCorrections);
  const cards = new Map<string, CardView>(
    [
      ...(o.players[o.you].hand ?? []),
      ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades, ...p.discard]),
      ...o.resolving,
      ...o.promptCards,
    ].map((c) => [c.id, c]),
  );
  const affected = new Set(
    o.legalActions.flatMap((item) => {
      const a = item.action;
      const source =
        a.kind === 'play'
          ? cards.get(a.copy ?? a.card)
          : ['choose', 'select', 'done'].includes(a.kind)
            ? cards.get(o.pending?.source ?? '')
            : undefined;
      return source && TARGETS.has(source.definition) ? [item.id] : [];
    }),
  );
  if (!affected.size) return inherited;
  const previous = new Map(
    rankForgeAware(o, 'tactical', { ...corrections, ...publicCorrections }).map((r) => [r.actionId, r]),
  );
  const corrected = new Map(
    rankForgeAware(o, 'tactical', {
      ...corrections,
      ...publicCorrections,
      publicHouseChoices: true,
      publicAmberIconBindings: true,
    }).map((r) => [r.actionId, r]),
  );
  return inherited
    .map((original) => {
      if (!affected.has(original.actionId)) return original;
      const base = previous.get(original.actionId)!;
      const next = corrected.get(original.actionId)!;
      // Keep V2's ordinary sequencing/public-prophecy adjustments, without
      // carrying a stale certainty bonus into a newly uncertain assessment.
      const retained = base.score < CRITICAL && original.score < CRITICAL ? original.score - base.score : 0;
      return {
        ...next,
        score: next.score >= CRITICAL ? next.score : Math.min(CRITICAL - 1, next.score + retained),
        approximate: next.approximate || original.approximate,
        reasons: [
          ...next.reasons,
          ...original.reasons.filter((r) => !base.reasons.includes(r)),
          'card-effects v3: current TTNT house branch or Infurnace public amber-icon binding; V2 future plans unchanged',
        ],
      };
    })
    .sort(compare);
}

export function cardAwarePolicyV3(): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankCardAwareV3(o)[0].actionId;
  };
}
