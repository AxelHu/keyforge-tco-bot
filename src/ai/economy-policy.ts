import type { Observation } from '../contracts/observation.js';
import { rankAlgorithm, type ActionAssessment } from './algorithm-policies.js';
/** Experimental single-curve adjustment. No game execution, extra hidden info or card-name cases. */
export function rankEconomy(o: Observation): ActionAssessment[] {
  const base = rankAlgorithm(o, 'tactical-v1'),
    me = o.players[o.you],
    foe = o.players[o.you === 0 ? 1 : 0];
  // Preserve the established baseline throughout recognized wins/funding/denial and public third-key danger.
  const danger =
    foe.keys.length === 2 &&
    foe.forgeAvailable >= foe.keyCost &&
    foe.skipForgeTurn !== o.turn + 1 &&
    !foe.artifacts.some((c) => c.spec.skipForgeStep);
  if (base[0].score >= 5000 || danger) return base;
  const shortfall = Math.max(0, me.keyCost - me.forgeAvailable);
  return base
    .map((a) => {
      const gained = Math.max(0, a.estimatedAmber[0] - me.amber),
        surplus = Math.max(0, gained - shortfall);
      return surplus > 0
        ? {
            ...a,
            score: a.score - 1.5 * surplus,
            reasons: [
              ...a.reasons,
              'economy-v1: reduce marginal current amber value after current key is funded',
            ],
          }
        : a;
    })
    .sort((a, b) => b.score - a.score);
}
export const economyPolicy = (o: Observation) => rankEconomy(o)[0].actionId;
