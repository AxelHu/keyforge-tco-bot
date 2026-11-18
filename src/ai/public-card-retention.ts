/** Adjustment to the existing Q/2 hand region for ordinary future house access. */
import type { CardView, Observation } from '../contracts/observation.js';
import type { PublicCardUseValue } from './card-lifecycle-value.js';
import { publicHandCardPlayable } from './public-hand-window.js';
import { publicNextHouseChoices, publicNextHouseTurn, publicFuturePlayRestriction } from './future-house-play-rules.js';

const houses = (card: CardView) => card.effective.houses ?? [card.effective.house];

function ordinaryFace(card: CardView): boolean {
  return card.definition === card.spec.id && !card.spec.cannotPlay && !card.spec.unmodeled &&
    !card.tokenCreature && !card.copiedDefinition && !card.copiedHouse && !card.copiedCharacteristics &&
    !card.copiedBonusHouses && !card.copiedBonusIcons && !card.form && !card.copiedForm &&
    !card.temporaryAnimation && !card.animatedArtifact && !card.copiedAnimation &&
    !card.gainedTextBoxes?.length && card.physicalParts === undefined && card.giganticBonusIcons === undefined;
}

/** Denominators for the fallback of actually retaining an unallocated physical card.
 * Missing entries carry the existing Q/2 value. Restriction uncertainty alone
 * cannot establish that every route in the next house window is blocked. */
function waitingDivisors(o: Observation): Map<string, number> | undefined {
  const me = o.players[o.you];
  if (o.publicStateCoverage?.effectsComplete === false || o.publicStateCoverage?.turnHistoryComplete === false ||
    !Array.isArray(me.houses) || !me.hand || me.hand.length !== me.handCount || new Set(me.hand.map((c) => c.id)).size !== me.handCount ||
    !Number.isSafeInteger(o.turn) || o.turn < 1) return;
  const turn = publicNextHouseTurn(o);
  if (turn === undefined) return;
  const available = publicNextHouseChoices(o, turn);
  if (!available) return;
  const committed = o.activePlayer === o.you && turn > o.turn;
  const values = new Map<string, number>();
  for (const card of me.hand) {
    if (card.owner !== o.you || !ordinaryFace(card)) continue;
    const delayed = houses(card).every((h) => !available.has(h) ||
      publicFuturePlayRestriction(o, card, turn, h) === 'blocked');
    if (delayed || committed) values.set(card.id, delayed ? 3 : 2.5);
  }
  return values;
}

function adjustment(divisor: number | undefined, use: PublicCardUseValue | undefined): number {
  const q = use?.score;
  return divisor && q !== undefined && Number.isFinite(q) && q > 0 && q < 5000 ? q / divisor - q / 2 : 0;
}

/** Fixed to the entering observation, including when an opener reprices the remaining plays.
 * A joint window uses this fallback only as its selection objective. Its selected material
 * still settles against Q/2, since the retention consumer prices only unselected cards. */
export function publicHandWaitingAdjustment(o: Observation,
  useValue: (card: CardView) => PublicCardUseValue | undefined): ((card: CardView) => number) | undefined {
  const divisors = waitingDivisors(o);
  if (!divisors?.size) return;
  return (card) => divisors.has(card.id) ? adjustment(divisors.get(card.id), useValue(card)) : 0;
}

/** Price only the indicated physical cards actually present in this observer's hand.
 * Subtract the two state scores once, after coalescing first-to-final moves, including
 * cards displaced from a shared immediate allocation. Archives do not occupy hand.
 * The independent refill ledger prices the actual capped deck + discard supply.
 * Supply a set, even an empty one, when the current joint allocation is known.
 * Omit it for an unproven continuation where individual routes may still open. */
export function assessPublicCardRetention(
  o: Observation, cards: readonly CardView[], useValue: (card: CardView) => PublicCardUseValue | undefined,
  allocatedImmediateIds?: ReadonlySet<string>,
): { score: number; approximate: boolean; reasons: string[] } {
  const empty = { score: 0, approximate: false, reasons: [] as string[] };
  if (!cards.length || o.phase === 'mulligan' || o.phase === 'finished') return empty;
  const divisors = waitingDivisors(o);
  if (!divisors) return { ...empty, approximate: true };
  if (!divisors.size) return empty;
  const allocationKnown = allocatedImmediateIds !== undefined;
  const nextCall = publicNextHouseTurn(o);
  const committed = o.activePlayer === o.you && nextCall !== undefined && nextCall > o.turn;
  const possibleMain = !allocationKnown && committed && o.phase === 'choice' && o.turnStep?.step === 3
    ? { ...o, phase: 'main' as const, pending: null } : undefined;
  const requested = new Set(cards.map((c) => c.id));
  let score = 0;
  for (const c of o.players[o.you].hand ?? []) {
    if (!requested.has(c.id) || allocatedImmediateIds?.has(c.id) || !divisors.has(c.id) ||
      possibleMain && publicHandCardPlayable(possibleMain, c, { projected: true })) continue;
    const use = useValue(c);
    if (!allocationKnown && committed && use?.playableNow) continue;
    score += adjustment(divisors.get(c.id), use);
  }
  return score ? { score, approximate: true, reasons: ['retained hand material discounted for delayed house access'] } : empty;
}
