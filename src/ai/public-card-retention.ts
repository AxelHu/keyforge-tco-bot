/** Adjustment to the existing Q/2 hand region for ordinary future house access. */
import type { CardView, House, Observation } from '../contracts/observation.js';
import type { PublicCardUseValue } from './card-lifecycle-value.js';
import { publicHandCardPlayable } from './public-hand-window.js';

const houses = (card: CardView) => card.effective.houses ?? [card.effective.house];

function ordinaryFace(card: CardView): boolean {
  return card.definition === card.spec.id && !card.spec.cannotPlay && !card.spec.unmodeled &&
    !card.tokenCreature && !card.copiedDefinition && !card.copiedHouse && !card.copiedCharacteristics &&
    !card.copiedBonusHouses && !card.copiedBonusIcons && !card.form && !card.copiedForm &&
    !card.temporaryAnimation && !card.animatedArtifact && !card.copiedAnimation &&
    !card.gainedTextBoxes?.length && card.physicalParts === undefined && card.giganticBonusIcons === undefined;
}

/** A one-call outlook with the public table held fixed. An unsupported or contradictory
 * house restriction does not prove a delay. No preference between selectable houses. */
function nextHouseChoices(o: Observation, turn: number): Set<House> | undefined {
  if (o.phase === 'house' && o.activePlayer === o.you) {
    const actual = o.legalActions.flatMap(({ action: a }) => a.kind === 'house' ? [a.house] : []);
    if (actual.length) return new Set(actual.filter((h): h is House => h !== null));
  }
  const own = o.players[o.you];
  const permanents = [...own.battleline, ...own.artifacts, ...own.upgrades];
  const available = new Set([...own.houses, ...permanents.flatMap(houses)]);
  const table = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  const boxes = table.flatMap((c) => [c.spec, ...(c.gainedTextBoxes ?? [])]);
  if (boxes.some((d) => d.unmodeled)) return undefined;
  const restrictions = [...o.houseRestrictions, ...o.futureHouseRestrictions].filter((r) =>
    r.player === o.you && (r.turn === null || r.turn === turn));
  const forced = new Set(restrictions.filter((r) => r.rule === 'mustHouse').map((r) => r.house));
  for (const c of permanents)
    for (const d of [c.spec, ...(c.gainedTextBoxes ?? [])]) if (d.mustHouse) forced.add(d.mustHouse);
  for (const r of restrictions) if (r.rule === 'cannotHouse') available.delete(r.house);
  if (boxes.some((d) => d.forbidsPreviousHouse)) {
    const previous = o.activePlayer === o.you && o.activeHouse && turn > o.turn
      ? o.activeHouse : o.previousChosenHouses?.[o.you];
    if (previous === undefined) return undefined;
    if (previous) available.delete(previous);
  }
  if (!available.size) return undefined;
  if (!forced.size) return available;
  const allowed = new Set([...forced].filter((h) => available.has(h)));
  return allowed.size ? allowed : undefined;
}

function blocksOrdinaryPlay(o: Observation, card: CardView, turn: number): boolean {
  return o.lasting.some((e) => {
    if ((e.begins ?? o.turn) > turn || e.turn < turn ||
      e.expiresAtTurnStart && (e.expiresAtTurnStart.turn < turn ||
        e.expiresAtTurnStart.turn === turn && e.expiresAtTurnStart.player === o.you)) return false;
    if (e.rule === 'noNamedPlayUse') return e.affectedName === card.spec.name;
    if (e.appliesTo !== o.you) return false;
    return e.rule === 'noPlay' || e.rule === 'noCreatures' && card.spec.kind === 'creature' ||
      e.rule === 'noActions' && card.spec.kind === 'action' ||
      e.rule === 'onlyPlayHouse' && e.house !== undefined && !houses(card).includes(e.house) ||
      e.rule === 'playLimit' && e.amount === 0;
  });
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
  const me = o.players[o.you];
  if (o.publicStateCoverage?.effectsComplete === false || o.publicStateCoverage?.turnHistoryComplete === false ||
    !me.hand || me.hand.length !== me.handCount || !Number.isSafeInteger(o.turn) || o.turn < 1)
    return { ...empty, approximate: true };
  const ownTurn = o.activePlayer === o.you;
  const beforeCall = ownTurn && !o.activeHouse && (o.phase === 'forge' || o.phase === 'house' ||
    o.phase === 'choice' && o.turnStep !== undefined && o.turnStep.step < 3);
  if (ownTurn && !o.activeHouse && o.phase === 'choice' && !o.turnStep)
    return { ...empty, approximate: true };
  const committed = ownTurn && !beforeCall;
  const nextCall = o.turn + (committed ? 2 : ownTurn ? 0 : 1);
  const available = nextHouseChoices(o, nextCall);
  if (!available) return { ...empty, approximate: true };
  const requested = new Set(cards.map((c) => c.id));
  const hand = new Map(me.hand.map((c) => [c.id, c]));
  if (hand.size !== me.handCount) return { ...empty, approximate: true };
  // A public action-step prompt can have an unknown tail. Protect a possible route
  // under the observed resources and restrictions; it receives no current premium.
  const allocationKnown = allocatedImmediateIds !== undefined;
  const possibleMain = !allocationKnown && committed && o.phase === 'choice' && o.turnStep?.step === 3
    ? { ...o, phase: 'main' as const, pending: null } : undefined;
  let score = 0;
  for (const id of requested) {
    const c = hand.get(id);
    if (!c || c.owner !== o.you || allocatedImmediateIds?.has(id) || !ordinaryFace(c)) continue;
    const restricted = !houses(c).some((h) => available.has(h)) || blocksOrdinaryPlay(o, c, nextCall);
    if (!restricted && !committed) continue;
    if (possibleMain && publicHandCardPlayable(possibleMain, c, { projected: true })) continue;
    const use = useValue(c);
    if (!use || !Number.isFinite(use.score) || use.score <= 0 || use.score >= 5000 ||
      !allocationKnown && committed && use.playableNow) continue;
    // d=1 is the existing next-call Q/2 baseline. Intervening opposition gives
    // d=1.5; missing the next ordinary call gives d=2. These are utility horizons,
    // not predicted turn counts. Even the longest wait preserves Q/3.
    const delay = restricted ? 2 : 1.5;
    score += use.score / (1 + delay) - use.score / 2;
  }
  return score ? { score, approximate: true, reasons: ['retained hand material discounted for delayed house access'] } : empty;
}
