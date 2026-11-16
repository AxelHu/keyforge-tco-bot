/** Curated evaluation entries. Versioned policy IDs remain the rating identity. */
export const STRATEGY_BASELINE_CATALOG = Object.freeze([
  Object.freeze({
    policyId: 'tactical-ladder-balanced',
    label: '均衡战术',
    role: 'trained-general-control',
    scope: 'Established generic comparator; its existing deck ratings retain their original runtime.',
  }),
  Object.freeze({
    policyId: 'tempo-ladder-balanced',
    label: '节奏过牌',
    role: 'trained-general-control',
    scope: 'Established tempo-family comparator, not a newly selected winner.',
  }),
  Object.freeze({
    policyId: 'economy-ladder-balanced',
    label: '琥珀效率',
    role: 'trained-general-control',
    scope: 'Established economy-family comparator, not a newly selected winner.',
  }),
  Object.freeze({
    policyId: 'tactical-card-effects-v3',
    label: '公开效果 V3',
    role: 'code-strategy',
    scope: 'Original strategy identity; this extracted package has no independent live win-rate claim.',
  }),
  Object.freeze({
    policyId: 'tactical-toc-v1',
    label: 'Token 与收获限制',
    role: 'retained-experiment',
    scope: 'Combined ToC candidate retained; prior holdout did not establish a stable general improvement.',
  }),
  Object.freeze({
    policyId: 'tactical-style-cycle-v1',
    label: '循环抢速',
    role: 'style-experiment',
    scope: 'V3-based style candidate; evaluate both behavior and paired game outcomes.',
  }),
  Object.freeze({
    policyId: 'tactical-style-engine-v1',
    label: '场面引擎',
    role: 'style-experiment',
    scope: 'V3-based style candidate; evaluate both behavior and paired game outcomes.',
  }),
  Object.freeze({
    policyId: 'tactical-style-engine-v2',
    label: '场面引擎 / Scythe 回收保护',
    role: 'unrated-loop-guard-candidate',
    scope:
      'Engine-v1 with a per-turn observed-recovery guard. Not included in the frozen six-policy league; no strength promotion is implied.',
  }),
  Object.freeze({
    policyId: 'tactical-style-control-v1',
    label: '干扰控制',
    role: 'style-experiment',
    scope: 'V3-based style candidate; evaluate both behavior and paired game outcomes.',
  }),
  Object.freeze({
    policyId: 'tactical-ladder-balanced-v2',
    label: '均衡战术 V2 / 净资源',
    role: 'strength-candidate',
    scope:
      'Retains the balanced Ladder priorities with net-resource and contextual-effect corrections; compare against its predecessor under the same loop guard.',
  }),
  Object.freeze({
    policyId: 'tactical-card-effects-v4',
    label: '公开效果 V4 / 家族机会与收获时序',
    role: 'strength-candidate',
    scope:
      'Bounded public hand-effect opportunities and ready-work preservation above V3; The extracted package has no independent strength claim.',
  }),
  Object.freeze({
    policyId: 'tactical-toc-v2',
    label: 'Token 与收获限制 V2',
    role: 'strength-candidate',
    scope:
      'Retains ToC token economy and conditional locks, with the strengthened common house/ready-work layer.',
  }),
  Object.freeze({
    policyId: 'tactical-style-cycle-v2',
    label: '循环抢速 V2 / 档案补手',
    role: 'strength-candidate',
    scope:
      'Retains Cycle main-phase choices and discounts archive packets that displace known normal refill slots.',
  }),
  Object.freeze({
    policyId: 'tactical-style-engine-v3',
    label: '场面引擎 V3 / 兑现现成资产',
    role: 'strength-candidate',
    scope:
      'Retains permanent deployment while valuing current productive activations instead of generic recurring text.',
  }),
  Object.freeze({
    policyId: 'tactical-style-control-v2',
    label: '干扰控制 V2 / 钥匙机会成本',
    role: 'strength-candidate',
    scope:
      'Retains denial preference while removing generic combat premium when the same creature can fund the next key by reaping.',
  }),
] as const);

/** No private deck IDs or historical strength claims are published as recommendations. */
export const DECK_STRATEGY_RECOMMENDATIONS: readonly { deckId: string; policyId: string }[] = [];
export function recommendedCodePolicyForDeck(deckId: string): string | undefined {
 return DECK_STRATEGY_RECOMMENDATIONS.find(x => x.deckId === deckId)?.policyId;
}
