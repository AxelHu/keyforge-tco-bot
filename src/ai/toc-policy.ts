/** Isolated ToC ablations above the frozen card-effects V3 baseline. */
import type { CardView, Observation } from '../contracts/observation.js';
import type { ActionAssessment, AlgorithmFeatures } from './algorithm-policies.js';
import { rankCardAwareV3 } from './card-aware-v3-policy.js';
import { rankForgeAware } from './forge-lock-policy.js';
import type { Policy } from './policies.js';

export const TOC_POLICY_IDS = ['tactical-toc-token-v1', 'tactical-toc-locks-v1', 'tactical-toc-v1'] as const;
export type TocPolicyId = (typeof TOC_POLICY_IDS)[number];
const CRITICAL = 5000;
const V3_EFFECT_TARGETS = new Set(['they-tell-no-tales', 'infurnace']);
const baseFeatures = { netResources: true, contextualEffects: true } as const;
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');

export function rankTocPolicy(o: Observation, policy: TocPolicyId = 'tactical-toc-v1'): ActionAssessment[] {
  if (!TOC_POLICY_IDS.includes(policy)) throw Error('Unknown ToC policy');
  const inherited = rankCardAwareV3(o);
  const features: AlgorithmFeatures = {
    tokenEconomy: policy !== 'tactical-toc-locks-v1',
    conditionalReapLocks: policy !== 'tactical-toc-token-v1',
  };
  const cards = new Map<string, CardView>(
    [
      ...(o.players[o.you].hand ?? []),
      ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades, ...p.discard]),
      ...o.resolving,
      ...o.promptCards,
    ].map((c) => [c.id, c]),
  );
  const v3Rows = new Set(
    o.legalActions.flatMap((item) => {
      const a = item.action;
      const source =
        a.kind === 'play'
          ? cards.get(a.copy ?? a.card)
          : ['choose', 'select', 'done'].includes(a.kind)
            ? cards.get(o.pending?.source ?? '')
            : undefined;
      return source && V3_EFFECT_TARGETS.has(source.definition) ? [item.id] : [];
    }),
  );
  const bank = (extra: AlgorithmFeatures) => {
    const previous = new Map(
      rankForgeAware(o, 'tactical', { ...baseFeatures, ...extra }).map((r) => [r.actionId, r]),
    );
    const corrected = new Map(
      rankForgeAware(o, 'tactical', { ...baseFeatures, ...extra, ...features }).map((r) => [r.actionId, r]),
    );
    return { previous, corrected };
  };
  const ordinary = bank({});
  const v3 = v3Rows.size ? bank({ publicHouseChoices: true, publicAmberIconBindings: true }) : ordinary;
  return inherited
    .map((original) => {
      // A heuristic body/lock premium cannot overturn an existing recognized win or third-key denial.
      if (original.score >= CRITICAL) return original;
      const rows = v3Rows.has(original.actionId) ? v3 : ordinary;
      const before = rows.previous.get(original.actionId)!,
        after = rows.corrected.get(original.actionId)!;
      if (before.score >= CRITICAL) return original;
      const delta = Math.max(-1000, Math.min(1000, after.score - before.score));
      if (Math.abs(delta) < 1e-9) return original;
      return {
        ...original,
        score: Math.min(CRITICAL - 1, original.score + delta),
        estimatedAmber: after.estimatedAmber,
        approximate: true,
        reasons: [
          ...original.reasons,
          ...after.reasons.filter((r) => !before.reasons.includes(r)),
          'toc ablation: bounded public token economy / conditional reap availability',
        ],
      };
    })
    .sort(compare);
}

export function tocPolicy(policy: TocPolicyId = 'tactical-toc-v1'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankTocPolicy(o, policy)[0].actionId;
  };
}
