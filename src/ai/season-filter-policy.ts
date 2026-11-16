/** Seasonal V3 explicitly preserves the referee's default creature/battleline filter scope.
 * Frozen V1/V2 remain reproducible. This wrapper changes only private evaluation copies;
 * all emitted actions still refer to the original, unmodified legal-action list.
 */
import { rankSeasonTide } from './season-tide-policy.js';
import type { LadderFamily } from './ladder-policy.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { CardView, Effect, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
export const SEASON_FILTER_POLICY_IDS = [
  'tempo-season-v3',
  'tactical-season-v3',
  'economy-season-v3',
] as const;
function normalizeTree(x: unknown): unknown {
  if (!x || typeof x !== 'object') return x;
  if (Array.isArray(x)) {
    const items = x.map(normalizeTree);
    return items.every((v, i) => v === x[i]) ? x : items;
  }
  const obj = x as Record<string, unknown>;
  const values = Object.entries(obj).map(([key, value]) => {
    let next = normalizeTree(value);
    // Every `filter` member in the public card schema is a Filter. A Value's `count`
    // is likewise a Filter; an Effect's numeric/expression count is not.
    const isFilter = key === 'filter' || (key === 'count' && !Object.hasOwn(obj, 'kind'));
    if (isFilter && next && typeof next === 'object' && !Array.isArray(next)) {
      const filter = next as Record<string, unknown>;
      if (filter.zone === undefined) next = { ...filter, zone: 'battleline' };
    }
    return [key, next] as const;
  });
  return values.every(([k, v]) => v === obj[k]) ? x : Object.fromEntries(values);
}
export function explicitSeasonFilterZones(o: Observation): Observation {
  const card = (c: CardView): CardView => {
    const spec = normalizeTree(c.spec) as CardView['spec'];
    return spec === c.spec ? c : { ...c, spec };
  };
  const player = (p: Observation['players'][0]): Observation['players'][0] => ({
    ...p,
    battleline: p.battleline.map(card),
    artifacts: p.artifacts.map(card),
    upgrades: p.upgrades.map(card),
    discard: p.discard.map(card),
    purged: p.purged.map(card),
    ...(p.hand ? { hand: p.hand.map(card) } : {}),
    ...(p.archives ? { archives: p.archives.map(card) } : {}),
    ...(p.revealedTop ? { revealedTop: card(p.revealedTop) } : {}),
  });
  return {
    ...o,
    players: [player(o.players[0]), player(o.players[1])],
    resolving: o.resolving.map(card),
    promptCards: o.promptCards.map(card),
    underCards: o.underCards.map((r) => ({ ...r, ...(r.cards ? { cards: r.cards.map(card) } : {}) })),
    prophecies: o.prophecies?.map((p) => ({ ...p, ...(p.cards ? { cards: p.cards.map(card) } : {}) })),
    legalActions: o.legalActions.map((a) =>
      a.useDescription
        ? {
            ...a,
            useDescription: {
              ...a.useDescription,
              effects: normalizeTree(a.useDescription.effects) as Effect[],
            },
          }
        : a,
    ),
  };
}
export function rankSeasonFiltered(o: Observation, family: LadderFamily = 'tactical'): ActionAssessment[] {
  return rankSeasonTide(explicitSeasonFilterZones(o), family);
}
export function seasonFilteredPolicy(family: LadderFamily = 'tactical'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankSeasonFiltered(o, family)[0].actionId;
  };
}
