import type { CardView, House, LastingEffect, Observation } from '../contracts/observation.js';

const houses = (c: CardView) => c.effective.houses ?? [c.effective.house];
const table = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);

/** The next ordinary house call under the public turn order, with today's board held fixed. */
export function publicNextHouseTurn(o: Observation): number | undefined {
  if (!Number.isSafeInteger(o.turn) || o.turn < 1 || o.phase === 'mulligan' || o.phase === 'finished') return;
  const own = o.activePlayer === o.you;
  if (own && !o.activeHouse) {
    if (o.phase === 'forge' || o.phase === 'house' || o.phase === 'choice' && o.turnStep && o.turnStep.step < 3)
      return o.turn;
    if (o.phase === 'choice' && !o.turnStep) return;
  }
  if ((o.lasting ?? []).some((e) => e.rule === 'anotherTurn' && e.turn === o.turn)) return;
  return o.turn + (own ? 2 : 1);
}

export function publicFutureEffectActive(o: Observation, e: LastingEffect, turn: number): boolean {
  if ((e.begins ?? o.turn) > turn || e.turn < turn) return false;
  const expiry = e.expiresAtTurnStart;
  if (expiry && (expiry.turn < turn || expiry.turn === turn && expiry.player === o.you)) return false;
  // Named locks and creature blanking persist through their end turn. Ordinary
  // nextTurn play/house locks have one matching turn, not an interval beginning now.
  return e.turn === turn || e.rule === 'noNamedPlayUse' || e.rule === 'blankCreatures' ||
    e.rule === 'noMatchingPlay' && !!expiry;
}

/** A real house menu is authoritative. Otherwise apply current public restrictions to that call.
 * A forbidden forced house falls back to all permitted choices, as in the referee. */
export function publicNextHouseChoices(o: Observation, turn: number): Set<House> | undefined {
  if (turn === o.turn && o.phase === 'house' && o.activePlayer === o.you) {
    const actual = o.legalActions.flatMap(({ action }) => action.kind === 'house' ? [action.house] : []);
    if (actual.length) return new Set(actual.filter((h): h is House => h !== null));
  }
  const me = o.players[o.you], cards = table(o);
  if (cards.some((c) => c.spec.unmodeled || c.gainedTextBoxes?.some((d) => d.unmodeled))) return;
  const options = new Set([...me.houses, ...[...me.battleline, ...me.artifacts, ...me.upgrades].flatMap(houses)]);
  const locks = [...(o.houseRestrictions ?? []), ...(o.futureHouseRestrictions ?? [])]
    .filter((r) => r.player === o.you && (r.turn === null || r.turn === turn));
  const must = new Set(locks.filter((r) => r.rule === 'mustHouse').map((r) => r.house));
  for (const c of me.battleline) {
    const blank = (o.lasting ?? []).some((e) => e.appliesTo === o.you && publicFutureEffectActive(o,e,turn) &&
      (e.rule === 'blankCreatures' || e.rule === 'blankBoostNamed' && e.affectedName === c.spec.name));
    if (!blank) for (const box of [c.spec, ...(c.gainedTextBoxes ?? [])]) if (box.mustHouse) must.add(box.mustHouse);
  }
  for (const r of locks) if (r.rule === 'cannotHouse') options.delete(r.house);
  if (cards.some((c) => c.spec.forbidsPreviousHouse)) {
    const previous = o.previousChosenHouses?.[o.you];
    if (previous === undefined) return;
    if (previous !== null) options.delete(previous);
  }
  const forced = [...options].filter((h) => must.has(h));
  return forced.length ? new Set(forced) : options;
}

/** Cap on ordinary plays in this house call, before either retained partner is played. */
export function publicFuturePlayLimit(o: Observation, turn: number): number {
  const enemyLimits = table(o).filter((c) => c.controller !== o.you).map((c) => c.spec.playLimitOpponent ?? Infinity);
  const turnLimits = (o.lasting ?? []).filter((e) => e.rule === 'playLimit' && e.appliesTo === o.you &&
    publicFutureEffectActive(o,e,turn)).map((e) => e.amount);
  // A normal opening-turn house call permits a single hand operation; a
  // special opening-turn permission is outside this ordinary-house estimate.
  const openingLimit = turn === 1 ? Math.max(0, 1 - o.handOperations) : Infinity;
  return Math.min(openingLimit, ...enemyLimits, ...turnLimits);
}

/** Only the represented ordinary play restrictions. No future permissions or board changes are supplied. */
export function publicFuturePlayRestriction(o: Observation, card: CardView, turn: number, house: House): 'blocked' | 'allowed' | 'unknown' {
  if (!houses(card).includes(house) || card.spec.cannotPlay || publicFuturePlayLimit(o,turn) <= 0 ||
    card.spec.kind === 'creature' && o.players[o.you].battleline.some((c) => c.spec.prohibitOwnCreatures)) return 'blocked';
  let unknown = false;
  for (const e of o.lasting ?? []) {
    if (!publicFutureEffectActive(o,e,turn)) continue;
    if (e.rule === 'noNamedPlayUse' && e.affectedName === card.spec.name) return 'blocked';
    if (e.appliesTo !== o.you) continue;
    // onlyPlayHouse compares the play definition's house, whereas noMatchingPlay checks
    // all effective houses of the card through hasHouse, including a second house.
    if (e.rule === 'noPlay' || e.rule === 'noCreatures' && card.spec.kind === 'creature' ||
      e.rule === 'noActions' && card.spec.kind === 'action' ||
      e.rule === 'onlyPlayHouse' && e.house !== card.spec.house) return 'blocked';
    if (e.rule === 'noMatchingPlay') {
      if (!e.countFilter?.kind || Object.keys(e.countFilter).some((k) => k !== 'kind')) unknown = true;
      else if (e.countFilter.kind === card.spec.kind && (!e.house || houses(card).includes(e.house))) return 'blocked';
    }
  }
  return unknown ? 'unknown' : 'allowed';
}
