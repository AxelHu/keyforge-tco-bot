/** V5 vetoes for bounded public planning; older policy/helper versions stay immutable. */
import type { CardDefinition, CardView, Observation, Trigger } from '../contracts/observation.js';
import { publicRefillForecast } from './public-refill-planning.js';

const beforeRefill = ['endReadyStep', 'startDrawStep', 'playerReadiedCard'] as const;
type BeforeRefillTrigger = (typeof beforeRefill)[number];

const inPlay = (o: Observation): CardView[] =>
  o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);

export interface PublicPlayCapacity {
  /** Requires complete public counters and effect state; false is not permission to play. */
  known: boolean;
  /** Null means no public cap was found, not that all other play restrictions are satisfied. */
  limit: number | null;
  remaining: number | null;
  blocked: boolean | null;
}

/** Island is a use, so recovering a card cannot free a spent play under these caps. */
export function publicPlayCapacity(o: Observation): PublicPlayCapacity {
  const limits = inPlay(o)
    .filter((c) => c.controller !== o.you)
    .map((c) => c.spec.playLimitOpponent)
    .filter((n): n is number => n !== undefined && Number.isFinite(n));
  for (const e of o.lasting)
    if (e.rule === 'playLimit' && e.turn === o.turn && e.appliesTo === o.you && Number.isFinite(e.amount))
      limits.push(e.amount);
  const limit = limits.length ? Math.min(...limits) : null;
  const known =
    o.publicStateCoverage?.turnHistoryComplete !== false && o.publicStateCoverage?.effectsComplete !== false;
  const remaining = !known || limit === null ? null : Math.max(0, limit - o.playedThisTurn);
  return { known, limit, remaining, blocked: known ? remaining === 0 : null };
}

export interface RefillGuidanceStatus {
  /** True only for the existing bounded count model, not a proof of future turn state. */
  known: boolean;
  reasons: string[];
}

const hasAbility = (
  abilities: Partial<Record<Trigger, unknown[]>> | undefined,
  trigger: BeforeRefillTrigger,
) => (abilities?.[trigger]?.length ?? 0) > 0;

function boxHasHook(box: CardDefinition, trigger: BeforeRefillTrigger): boolean {
  return (
    hasAbility(box.abilities, trigger) ||
    (box.conditionalAbilities ?? []).some((g) => hasAbility(g.abilities, trigger))
  );
}

/**
 * Do not run another rules interpreter. Visible unmodeled hooks make refill-dependent
 * guidance unavailable, even when their conditions or grant filters might later fail.
 * Direct step hooks use their controller; ready responses can come from either side.
 */
export function refillGuidanceStatus(o: Observation): RefillGuidanceStatus {
  const reasons: string[] = [];
  if (o.publicStateCoverage?.turnHistoryComplete === false) reasons.push('incomplete public turn history');
  if (o.publicStateCoverage?.effectsComplete === false) reasons.push('incomplete public effect state');
  if (!publicRefillForecast(o).knownModifiers) reasons.push('unknown public refill modifier');
  const cards = inPlay(o);
  const byId = new Map(cards.map((c) => [c.id, c]));
  for (const c of cards) {
    const boxes = [c.spec, ...(c.gainedTextBoxes ?? [])];
    for (const trigger of beforeRefill) {
      if (
        (trigger === 'playerReadiedCard' || c.controller === o.you) &&
        boxes.some((box) => boxHasHook(box, trigger))
      )
        reasons.push(c.id + ': unmodeled ' + trigger);
      // Grants are public but their complete conditions/target filters are outside this helper.
      if (
        boxes.some((box) => (box.grantsAbilities ?? []).some((grant) => hasAbility(grant.abilities, trigger)))
      )
        reasons.push(c.id + ': possible granted ' + trigger);
      const host = c.attachedTo ? byId.get(c.attachedTo) : undefined;
      if (
        host &&
        (trigger === 'playerReadiedCard' || host.controller === o.you) &&
        boxes.some((box) => hasAbility(box.upgrade?.abilities, trigger))
      )
        reasons.push(c.id + ': host has unmodeled ' + trigger);
    }
    if (c.controller !== o.you && c.spec.replacesEnemyCreatureReadyStep)
      reasons.push(c.id + ': unmodeled enemy ready-step replacement');
  }
  return { known: reasons.length === 0, reasons };
}
