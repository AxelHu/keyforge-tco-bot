import { guidedIslandPolicyV5 } from './tullibint-guided-v5-policy.js';
import { prophecyGuidedPolicyV5, PROPHECY_GUIDED_V5_POLICY_IDS } from './prophecy-guided-v5-policy.js';
import { guidedIslandPolicy } from './tullibint-guided-policy.js';
import { prophecyGuidedPolicy, PROPHECY_GUIDED_POLICY_IDS } from './prophecy-guided-policy.js';
import { seasonFilteredPolicy, SEASON_FILTER_POLICY_IDS } from './season-filter-policy.js';
import { seasonTidePolicy, SEASON_TIDE_POLICY_IDS } from './season-tide-policy.js';
import { burstIslandPolicy } from './tullibint-burst-policy.js';
import { seasonPolicy, SEASON_POLICY_IDS } from './season-policy.js';
/** Reusable pure-code opponents for arenas, deck evaluation and observation-based model benchmarks. */
import { wellIslandPolicy } from './tullibint-combo-policy.js';
import { tullibintPolicy } from './tullibint-policy.js';
import { greedyPolicy, randomPolicy, type Policy } from './policies.js';
import { guardPolicy, type GuardPolicyOptions } from './loop-guard.js';
import { tacticalPolicy, tempoPolicy } from './algorithm-policies.js';
import { economyPolicy } from './economy-policy.js';
import { rankStyled, type Style } from './persona-styles.js';
import { COMPETITIVE_PROFILES, competitivePolicy, type CompetitiveProfile } from './competitive-policy.js';
import { forgeAwarePolicy } from './forge-lock-policy.js';
import { CARD_AWARE_POLICY_IDS, cardAwarePolicy } from './card-aware-policy.js';
import { CARD_AWARE_V2_POLICY_IDS, cardAwarePolicyV2 } from './card-aware-v2-policy.js';
import { CARD_EFFECTS_V3_POLICY_IDS, cardAwarePolicyV3 } from './card-aware-v3-policy.js';
import { TOC_POLICY_IDS, tocPolicy } from './toc-policy.js';
import { STYLE_POLICY_IDS, stylePolicy } from './style-policy.js';
import { ENGINE_RECOVERY_POLICY_IDS, engineRecoveryPolicyV2 } from './style-engine-recovery-policy.js';
import { TACTICAL_STRENGTH_POLICY_IDS, tacticalStrengthPolicy } from './tactical-strength-policy.js';
import { STYLE_UPGRADE_POLICY_IDS, styleUpgradePolicy } from './style-policy-upgrades.js';
import { cardAwarePolicyV3Sequence } from './card-aware-v3-sequence.js';
import { DOK_POLICY_IDS, dokTacticalPolicy, type CodeStrategyContext } from './dok-policy.js';
export type { CodeStrategyContext } from './dok-policy.js';
export {
  STRATEGY_BASELINE_CATALOG,
  DECK_STRATEGY_RECOMMENDATIONS,
  recommendedCodePolicyForDeck,
} from './strategy-catalog.js';
import { neutralBattlelineReorder } from './reorder-policy.js';
import { OPENING_POLICY_IDS, openingPolicy, type OpeningPolicyId } from './opening-policy.js';
import { LADDER_POLICY_IDS, ladderPolicy, type LadderFamily, type LadderVariant } from './ladder-policy.js';
/** Compatibility entrypoints for version-pinned historical controls. This is not a recommendation. */
export const CURRENT_CODE_BASELINES = Object.freeze({
  tempo: 'tempo-v3',
  tactical: 'tactical-v3',
  economy: 'economy-v3',
} as const);
export const HISTORICAL_CODE_BASELINES = CURRENT_CODE_BASELINES;
/** Parallel current tactical candidates; order does not assert a statistically established winner. */
export const CURRENT_TACTICAL_CANDIDATES = Object.freeze([
  'tactical-ladder-balanced',
  'tactical-card-aware-v1',
] as const);
/** Targeted mechanism candidates; no head-to-head win-rate promotion is implied. */
export const EXPERIMENTAL_TACTICAL_CANDIDATES = Object.freeze([
  'tactical-card-aware-v2',
  'tactical-card-effects-v3',
  'tactical-card-aware-v3',
  ...TOC_POLICY_IDS,
  ...STYLE_POLICY_IDS,
  ...ENGINE_RECOVERY_POLICY_IDS,
  ...TACTICAL_STRENGTH_POLICY_IDS,
  ...STYLE_UPGRADE_POLICY_IDS,
  ...OPENING_POLICY_IDS,
] as const);
/** Training-selected versions used by the deck×policy rating campaign, not a silently promoted champion. */
export const TRAINED_CODE_POLICIES = Object.freeze({
  tempo: 'tempo-ladder-balanced',
  tactical: 'tactical-ladder-balanced',
  economy: 'economy-ladder-balanced',
} as const);
export type BaselineFamily = keyof typeof CURRENT_CODE_BASELINES;
export function createBaselinePolicy(
  family: BaselineFamily,
  explorationSeed = 1,
  guardOptions: GuardPolicyOptions = {},
): Policy {
  if (!Object.hasOwn(CURRENT_CODE_BASELINES, family)) throw Error('Unknown baseline family: ' + family);
  return createCodePolicy(CURRENT_CODE_BASELINES[family], explorationSeed, undefined, guardOptions);
}
export const CODE_POLICY_IDS = [
  'tactical-card-aware-v3',
  ...CARD_EFFECTS_V3_POLICY_IDS,
  ...CARD_AWARE_V2_POLICY_IDS,
  ...CARD_AWARE_POLICY_IDS,
  ...DOK_POLICY_IDS,
  ...PROPHECY_GUIDED_V5_POLICY_IDS,
  'tullibint-well-island-guided-v5',
  ...PROPHECY_GUIDED_POLICY_IDS,
  'tullibint-well-island-guided-v4',
  ...LADDER_POLICY_IDS,
  ...SEASON_POLICY_IDS,
  ...SEASON_TIDE_POLICY_IDS,
  ...SEASON_FILTER_POLICY_IDS,
  'tullibint-well-island-core-v3',
  'tullibint-well-island-burst-v3',
  'tullibint-well-island-sequence-v3',
  'tullibint-well-island-v2',
  'tullibint-well-island-patient-v2',
  'tullibint-well-island-cycle-v2',
  'tullibint-engine-v1',
  'tullibint-conservative-v1',
  'random',
  'explore',
  'greedy',
  'tempo',
  'tactical',
  'economy',
  'style-race',
  'style-control',
  'style-develop',
  'style-combo',
  ...COMPETITIVE_PROFILES.map((p) => `${p}-v2`),
  ...COMPETITIVE_PROFILES.map((p) => `${p}-v3`),
  ...COMPETITIVE_PROFILES.map((p) => `${p}-v4`),
  ...TOC_POLICY_IDS,
  ...STYLE_POLICY_IDS,
  ...ENGINE_RECOVERY_POLICY_IDS,
  ...TACTICAL_STRENGTH_POLICY_IDS,
  ...STYLE_UPGRADE_POLICY_IDS,
  ...OPENING_POLICY_IDS,
] as const;
/** The optional seed controls exploration only. Never pass the engine's RNG state to a policy. */
export function createCodePolicy(
  id: string,
  explorationSeed = 1,
  strategyContext?: CodeStrategyContext,
  guardOptions: GuardPolicyOptions = {},
): Policy {
  const original = createRegisteredCodePolicy(id, explorationSeed, strategyContext);
  return guardPolicy((o) => {
    // Preserve the registered policy's validation, state and exploration stream, even on a reorder.
    const originalChoice = original(o);
    return neutralBattlelineReorder(o)?.actionId ?? originalChoice;
  }, guardOptions);
}
function createRegisteredCodePolicy(
  id: string,
  explorationSeed: number,
  strategyContext?: CodeStrategyContext,
): Policy {
  if (!CODE_POLICY_IDS.includes(id)) throw Error('Unknown code strategy: ' + id);
  if (!Number.isSafeInteger(explorationSeed) || explorationSeed < 0 || explorationSeed > 0xffffffff)
    throw Error('Invalid exploration seed');
  let rng = explorationSeed >>> 0 || 1;
  const next = () => {
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    return (rng >>> 0) / 4294967296;
  };
  const explore = randomPolicy(next);
  if (OPENING_POLICY_IDS.includes(id as OpeningPolicyId))
    return openingPolicy(id as OpeningPolicyId, strategyContext?.opening);
  if (id === 'tullibint-well-island-guided-v5') return guidedIslandPolicyV5();
  if (id.endsWith('-prophecy-guided-v5')) return prophecyGuidedPolicyV5(id.split('-')[0] as LadderFamily);
  if (id === 'tullibint-well-island-guided-v4') return guidedIslandPolicy();
  if (id.endsWith('-prophecy-guided-v4')) return prophecyGuidedPolicy(id.split('-')[0] as LadderFamily);
  if (id === 'tullibint-well-island-core-v3') return burstIslandPolicy();
  if (id === 'tullibint-well-island-burst-v3') return burstIslandPolicy('burst');
  if (id === 'tullibint-well-island-sequence-v3') return burstIslandPolicy('sequence');
  if (id === 'tullibint-well-island-v2') return wellIslandPolicy();
  if (id === 'tullibint-well-island-patient-v2') return wellIslandPolicy('patient');
  if (id === 'tullibint-well-island-cycle-v2') return wellIslandPolicy('cycle');
  if (id === 'tullibint-engine-v1') return tullibintPolicy('engine');
  if (id === 'tullibint-conservative-v1') return tullibintPolicy('conservative');
  if (TACTICAL_STRENGTH_POLICY_IDS.includes(id as (typeof TACTICAL_STRENGTH_POLICY_IDS)[number]))
    return tacticalStrengthPolicy(id as (typeof TACTICAL_STRENGTH_POLICY_IDS)[number]);
  if (STYLE_UPGRADE_POLICY_IDS.includes(id as (typeof STYLE_UPGRADE_POLICY_IDS)[number]))
    return styleUpgradePolicy(id as (typeof STYLE_UPGRADE_POLICY_IDS)[number]);
  if (id.includes('-ladder-')) {
    const [family, variant] = id.split('-ladder-');
    return ladderPolicy(family as LadderFamily, variant as LadderVariant);
  }
  if (id.endsWith('-season-v3')) return seasonFilteredPolicy(id.split('-')[0] as LadderFamily);
  if (id.endsWith('-season-v2')) return seasonTidePolicy(id.split('-')[0] as LadderFamily);
  if (id.endsWith('-season-v1')) return seasonPolicy(id.split('-')[0] as LadderFamily);
  if (id === 'tactical-card-aware-v2') return cardAwarePolicyV2();
  if (id === 'tactical-card-effects-v3') return cardAwarePolicyV3();
  if (TOC_POLICY_IDS.includes(id as (typeof TOC_POLICY_IDS)[number]))
    return tocPolicy(id as (typeof TOC_POLICY_IDS)[number]);
  if (STYLE_POLICY_IDS.includes(id as (typeof STYLE_POLICY_IDS)[number]))
    return stylePolicy(id as (typeof STYLE_POLICY_IDS)[number]);
  if (id === 'tactical-style-engine-v2') return engineRecoveryPolicyV2();
  if (id === 'tactical-card-aware-v3') return cardAwarePolicyV3Sequence();
  if (id === 'tactical-card-aware-v1') return cardAwarePolicy();
  if (id === 'tactical-card-effects-v1') return cardAwarePolicy(false);
  if (id === 'tactical-dok-card-v1') return dokTacticalPolicy('card', strategyContext);
  if (id === 'tactical-dok-deck-v1') return dokTacticalPolicy('deck', strategyContext);
  if (id === 'tactical-dok-combined-v1') return dokTacticalPolicy('combined', strategyContext);
  if (id === 'random') return explore;
  if (id === 'explore') return (o) => (next() < 0.25 ? explore(o) : tacticalPolicy(o));
  if (id === 'greedy') return greedyPolicy;
  if (id === 'tempo') return tempoPolicy;
  if (id === 'tactical') return tacticalPolicy;
  if (id === 'economy') return economyPolicy;
  if (id.startsWith('style-')) return (o) => rankStyled(o, id.slice(6) as Style).actionId;
  if (id.endsWith('-v2')) return competitivePolicy(id.slice(0, -3) as CompetitiveProfile);
  if (id.endsWith('-v3')) return forgeAwarePolicy(id.slice(0, -3) as CompetitiveProfile);
  if (id.endsWith('-v4'))
    return competitivePolicy(id.slice(0, -3) as CompetitiveProfile, { netResources: true });
  throw Error('Code strategy registry mismatch');
}
