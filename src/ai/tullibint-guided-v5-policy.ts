/** V5 adds public correctness vetoes without changing the frozen V4 heuristics. */
import type { Observation } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { Policy } from './policies.js';
import { publicPlayCapacity, refillGuidanceStatus } from './public-guidance-guards.js';
import { publicCards } from './season-utility.js';
import { planBurstExchange, rankBurstIsland, type WellExchangePlan } from './tullibint-burst-policy.js';
import { planGuidedIsland, rankGuidedIsland, type GuidedIslandPlan } from './tullibint-guided-policy.js';
import { rankTullibint } from './tullibint-policy.js';

const ISLAND = 'island-of-misfit-toys';
const WELL = 'well-of-memory';

export interface GuidedIslandPlanV5 extends GuidedIslandPlan {
  ectoBlockedByPlayCap: boolean;
  playCapacityKnown: boolean;
  refillGuidanceKnown: boolean;
}

export function planGuidedIslandV5(o: Observation): GuidedIslandPlanV5 {
  const plan = planGuidedIsland(o);
  const capacity = publicPlayCapacity(o);
  const ectoBlockedByPlayCap = plan.visibleEctoFinish && capacity.blocked === true;
  return {
    ...plan,
    visibleEctoFinish: plan.visibleEctoFinish && capacity.known && !ectoBlockedByPlayCap,
    ectoBlockedByPlayCap,
    playCapacityKnown: capacity.known,
    refillGuidanceKnown: refillGuidanceStatus(o).known,
  };
}

function baseline(o: Observation, committed?: WellExchangePlan): ActionAssessment[] {
  return o.players[o.you].purged.some((c) => c.definition === ISLAND)
    ? rankBurstIsland(o, 'core', committed)
    : rankTullibint(o);
}

export function rankGuidedIslandV5(o: Observation, committed?: WellExchangePlan): ActionAssessment[] {
  // An unknown forecast cannot justify V4's refill/anti-reshuffle adjustments.
  if (!refillGuidanceStatus(o).known) return baseline(o, committed);
  const rows = rankGuidedIsland(o, committed);
  if (!publicPlayCapacity(o).blocked || !planGuidedIsland(o).visibleEctoFinish) return rows;
  const fallback = new Map(baseline(o, committed).map((row) => [row.actionId, row]));
  const islands = new Set(o.players[o.you].artifacts.filter((c) => c.definition === ISLAND).map((c) => c.id));
  const uses = new Set(
    o.legalActions
      .filter((entry) => entry.action.kind === 'use' && islands.has(entry.action.card))
      .map((entry) => entry.id),
  );
  return rows
    .map((row) => {
      if (!uses.has(row.actionId)) return row;
      const original = fallback.get(row.actionId)!;
      return {
        ...original,
        reasons: [
          ...original.reasons,
          'V5: public play cap is reached; Island recovery does not make Ecto playable, so retain baseline',
        ],
      };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}

/** Preserve the original prompt-scoped exchange memory when a baseline fallback is required. */
export function guidedIslandPolicyV5(): Policy {
  let window: { turn: number; source: string; plan: WellExchangePlan } | undefined;
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    const me = o.players[o.you];
    const source = publicCards(o).find((c) => c.id === o.pending?.source);
    const selecting =
      source?.definition === WELL &&
      o.legalActions.some(
        (x) =>
          x.action.kind === 'select' &&
          (me.hand ?? []).some((c) => x.action.kind === 'select' && c.id === x.action.target),
      );
    if (window && (window.turn !== o.turn || (!o.pending && o.phase === 'main'))) window = undefined;
    if (
      selecting &&
      me.purged.some((c) => c.definition === ISLAND) &&
      (!window || window.source !== source!.id)
    )
      window = { turn: o.turn, source: source!.id, plan: planBurstExchange(o, 'core') };
    const committed =
      window?.turn === o.turn && window.source === o.pending?.source ? window.plan : undefined;
    return rankGuidedIslandV5(o, committed)[0].actionId;
  };
}
