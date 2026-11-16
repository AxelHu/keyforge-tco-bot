/** Count-only planning for the next normal refill. Never reads a deck order or simulates hidden draws. */
import type { Observation, Seat } from '../contracts/observation.js';
import { publicValue } from './season-utility.js';

export interface PublicRefillForecast {
  target: number;
  draws: number;
  deckCount: number;
  reshuffles: boolean;
  /** False when a public dynamic modifier cannot be evaluated by the bounded helper. */
  knownModifiers: boolean;
}

export function publicRefillForecast(
  o: Observation,
  handCount = o.players[o.you].handCount,
  deckCount = o.players[o.you].deckCount,
  seat: Seat = o.you,
): PublicRefillForecast {
  const p = o.players[seat];
  let limit = 6;
  let knownModifiers = true;
  for (const player of o.players) {
    for (const c of [...player.battleline, ...player.artifacts, ...player.upgrades]) {
      const spec = c.spec;
      const line = o.players[c.controller].battleline;
      const index = line.findIndex((x) => x.id === c.id);
      const center = index >= 0 && line.length % 2 === 1 && index === Math.floor(line.length / 2);
      const flank = index >= 0 && (index === 0 || index === line.length - 1);
      if (c.controller === seat) {
        limit += (spec.drawBonus ?? 0) + (center ? (spec.centralDrawBonus ?? 0) : 0);
        if (o.players[1 - seat].amber > p.amber) limit += spec.drawBonusIfOpponentRicher ?? 0;
        if (spec.drawBonusValue) {
          const amount = publicValue(o, spec.drawBonusValue, seat, c);
          if (amount === null) knownModifiers = false;
          else limit += amount;
        }
      } else {
        limit -= (spec.opponentDrawPenalty ?? 0) + (!flank ? (spec.offFlankDrawPenalty ?? 0) : 0);
        if (spec.opponentDrawPenaltyValue) {
          const amount = publicValue(o, spec.opponentDrawPenaltyValue, c.controller, c);
          if (amount === null) knownModifiers = false;
          else limit -= amount;
        }
      }
      limit += spec.globalDrawBonus ?? 0;
      if (o.haunted?.[seat] ?? p.discard.length >= 10) limit += spec.globalHauntedDrawBonus ?? 0;
    }
  }
  const target = Math.max(0, limit - Math.ceil(p.chains / 6));
  const draws = Math.max(0, target - handCount);
  return {
    target,
    draws,
    deckCount,
    // Consuming the final existing card does not shuffle. A subsequent draw does.
    reshuffles: draws > deckCount && p.discard.length > 0,
    knownModifiers,
  };
}
