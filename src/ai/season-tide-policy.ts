/** Seasonal V2 adds only public tide-unlock and free-raising work to the frozen V1 evaluator. */
import { rankSeason } from './season-policy.js';
import type { LadderFamily } from './ladder-policy.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { CardView, Condition, Effect, Observation, Seat } from '../contracts/observation.js';
import type { Policy } from './policies.js';
import { publicCards, publicTargets, publicValue } from './season-utility.js';
export const SEASON_TIDE_POLICY_IDS = ['tempo-season-v2', 'tactical-season-v2', 'economy-season-v2'] as const;
function condition(o: Observation, c: Condition, actor: Seat, source: CardView): boolean | null {
  const a = publicValue(o, c.left, actor, source),
    b = publicValue(o, c.right, actor, source);
  if (a === null || b === null) return null;
  return c.comparison === 'eq'
    ? a === b
    : c.comparison === 'gt'
      ? a > b
      : c.comparison === 'gte'
        ? a >= b
        : c.comparison === 'lt'
          ? a < b
          : a <= b;
}
function raisesOwnTide(o: Observation, effects: readonly Effect[], source: CardView, depth = 0): boolean {
  if (depth > 6) return false;
  for (const e of effects) {
    if (e.kind === 'tide' && e.operation === 'raise' && (!e.side || e.side === 'self')) return true;
    if (e.kind === 'if') {
      const yes = condition(o, e.condition, o.you, source);
      if (yes !== null && raisesOwnTide(o, yes ? e.then : (e.otherwise ?? []), source, depth + 1))
        return true;
    }
  }
  return false;
}
/** Infer only a currently explicit public low-tide reap restriction being removed. */
export function tideUnlockedReapers(o: Observation): string[] {
  if (
    !o.tide ||
    o.tide.highFor === o.you ||
    !o.activeHouse ||
    o.nextCreatureUseRestriction?.cannot === 'reap' ||
    o.nextCreatureUseRestriction?.alsoCannot === 'reap'
  )
    return [];
  const me = o.players[o.you],
    raised = { ...o, tide: { ...o.tide, highFor: o.you, status: 'high' as const } },
    providers = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  if (
    o.lasting.some(
      (e) =>
        e.appliesTo === o.you &&
        e.turn >= o.turn &&
        ['noReap', 'noReapHouse', 'noUse', 'noUseCreatures'].includes(e.rule),
    )
  )
    return [];
  return me.battleline
    .filter((c) => {
      if (
        !c.ready ||
        c.stunned ||
        c.enraged ||
        c.spec.cannotReap ||
        (o.turnUsage[c.id] ?? 0) >= 6 ||
        !(c.effective.houses ?? [c.effective.house]).includes(o.activeHouse!)
      )
        return false;
      if (me.upgrades.some((u) => u.attachedTo === c.id && u.spec.upgrade?.cannotReap)) return false;
      if (o.legalActions.some((x) => x.action.kind === 'reap' && x.action.card === c.id)) return false;
      let removed = false;
      for (const provider of providers)
        for (const r of provider.spec.reapRestrictions ?? []) {
          const targets = publicTargets(o, r.filter, provider.controller, provider);
          if (targets === null) return false;
          if (!targets.some((x) => x.id === c.id)) continue;
          if (!r.condition) return false;
          const before = condition(o, r.condition, o.you, c),
            after = condition(raised, r.condition, o.you, c);
          if (before === null || after === null || after) return false;
          if (before) removed = true;
        }
      return removed;
    })
    .map((c) => c.id);
}
export function rankSeasonTide(o: Observation, family: LadderFamily = 'tactical'): ActionAssessment[] {
  const rows = rankSeason(o, family),
    legal = new Map(o.legalActions.map((x) => [x.id, x])),
    cards = new Map(publicCards(o).map((c) => [c.id, c]));
  const paid = rows.find((r) => legal.get(r.actionId)!.action.kind === 'raiseTide');
  if (!paid || !o.tide) return rows;
  const unlocked = tideUnlockedReapers(o),
    extra = unlocked.length * 3.2,
    benefit = Math.max(0, paid.score + 4.2 + extra),
    freeIds = new Set<string>();
  const updated = rows.map((row) => {
    const entry = legal.get(row.actionId)!,
      a = entry.action;
    if (row.score >= 5000 || a.kind === 'forge' || a.kind === 'payForge') return row;
    if (a.kind === 'raiseTide')
      return {
        ...row,
        score: row.score + extra,
        approximate: true,
        reasons: [
          ...row.reasons,
          ...(unlocked.length
            ? ['season-v2: high tide unlocks ' + unlocked.length + ' publicly restricted ready reapers']
            : []),
        ],
      };
    if ((a.kind === 'play' || a.kind === 'use') && benefit > 0) {
      const c = cards.get(a.card),
        effects = c
          ? a.kind === 'play'
            ? c.spec.abilities?.play
            : entry.useDescription?.effects
          : undefined;
      if (c && effects && raisesOwnTide(o, effects, c)) {
        const score = row.score + benefit;
        if (score >= 0) freeIds.add(row.actionId);
        return {
          ...row,
          score,
          approximate: true,
          reasons: [
            ...row.reasons,
            'season-v2: obtain useful high tide from a legal card effect instead of paying three chains',
          ],
        };
      }
    }
    return row;
  });
  const bestFree = Math.max(-Infinity, ...updated.filter((r) => freeIds.has(r.actionId)).map((r) => r.score));
  return updated
    .map((r) =>
      r.actionId === paid.actionId && bestFree >= r.score && bestFree >= 0
        ? {
            ...r,
            score: Math.min(-1, r.score),
            reasons: [...r.reasons, 'season-v2: a preferable legal free raise is already available'],
          }
        : r,
    )
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export function seasonTidePolicy(family: LadderFamily = 'tactical'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankSeasonTide(o, family)[0].actionId;
  };
}
