/** Public ToC utility only. No card catalogue, hidden reverse face, rating, or simulator access. */
import type { CardView, Condition, Effect, Filter, Observation, Seat, Value, House } from '../contracts/observation.js';
import { publicTargets, publicValue } from './season-utility.js';

const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
const sign = (o: Observation, seat: Seat) => (seat === o.you ? 1 : -1);

/** Existing season helpers are given an explicitly public view even if a caller injects private fields. */
function publicOnly(o: Observation, removed: ReadonlySet<string> = new Set()): Observation {
  return {
    ...o,
    players: o.players.map((p, seat) => ({
      ...p,
      hand: seat === o.you ? p.hand : undefined,
      archives: seat === o.you ? p.archives : undefined,
      battleline: p.battleline.filter((c) => !removed.has(c.id)),
      artifacts: p.artifacts.filter((c) => !removed.has(c.id)),
      upgrades: p.upgrades.filter((c) => !removed.has(c.id) && !removed.has(c.attachedTo ?? '')),
    })) as Observation['players'],
  };
}
function targets(o: Observation, filter: Filter, actor: Seat, source?: CardView): CardView[] | null {
  const { sourceOnly, name, ...rest } = filter;
  const found = publicTargets(o, rest, actor, source);
  return found === null
    ? null
    : found.filter((c) => (!sourceOnly || c.id === source?.id) && (!name || c.spec.name === name));
}
export function tocPublicValue(o: Observation, value: Value, actor: Seat, source?: CardView): number | null {
  const visible = publicOnly(o);
  if (typeof value === 'number') return value;
  if ('count' in value) {
    const xs = targets(visible, value.count, actor, source);
    return xs === null ? null : xs.length * (value.multiplier ?? 1);
  }
  if ('keyForged' in value) {
    const side =
      value.side === undefined || value.side === 'self'
        ? actor
        : value.side === 'opponent'
          ? other(actor)
          : value.side === 'active'
            ? o.activePlayer
            : null;
    return side === null ? null : Number(o.players[side].keys.includes(value.keyForged));
  }
  return publicValue(visible, value, actor, source);
}
function condition(o: Observation, c: Condition, actor: Seat, source?: CardView): boolean | null {
  const l = tocPublicValue(o, c.left, actor, source),
    r = tocPublicValue(o, c.right, actor, source);
  if (l === null || r === null) return null;
  return c.comparison === 'eq'
    ? l === r
    : c.comparison === 'gt'
      ? l > r
      : c.comparison === 'gte'
        ? l >= r
        : c.comparison === 'lt'
          ? l < r
          : l <= r;
}

/** One exhausted body minus a bounded cycle/opportunity cost.
 * Values are heuristic units, not promised amber or knowledge of the physical reverse face.
 * Alpha-Gamma-like self-archive retains part of the unknown card's future value.
 */
export function tokenUnitValue(o: Observation, controller: Seat): number {
  const d = o.tokenReferences?.[controller];
  if (!d?.tokenReference) return 0;
  const recovery = d.abilities?.destroyed?.some((e) => e.kind === 'self' && e.operation === 'archive')
    ? 0.45
    : 0;
  const bodies = o.players[controller].battleline.length;
  const entry = d.entryEnragedCondition ? condition(o, d.entryEnragedCondition, controller) : false;
  const globallyEnraged = board(o).some((c) => c.spec.enragesEnteringCreatures);
  const enrageCost = entry === true || globallyEnraged ? 0.7 : entry === null ? 0.35 : 0;
  const resilience =
    Math.min(3, d.armor ?? 0) * 0.2 +
    Number(!!d.keywords?.includes('elusive')) * 0.2 +
    Number(!!d.keywords?.includes('skirmish')) * 0.2;
  const worth = (2.6 + Math.min(10, d.power ?? 0) * 0.18 + resilience) * 0.85 - 0.8 + recovery - enrageCost;
  return Math.max(0, Math.min(4, worth) * Math.max(0.45, 1 - Math.max(0, bodies - 5) * 0.05));
}

/** Strict future-production subset. An unsupported attached cost never becomes a free engine.
 * This only values repeatable text on a card; the current activation is assessed by the normal evaluator.
 */
function production(
  o: Observation,
  actor: Seat,
  source: CardView,
  effects: readonly Effect[],
  depth = 0,
): number | null {
  if (depth > 4 || effects.length > 12) return null;
  let total = 0;
  for (const e of effects) {
    if (e.kind === 'makeToken' || e.kind === 'makeTokens') {
      const controller = !e.side || e.side === 'self' ? actor : e.side === 'opponent' ? other(actor) : null;
      if (controller === null || e.then?.length) return null;
      const ref = o.tokenReferences?.[controller];
      if (!ref || (e.named && ref.name !== e.named)) continue;
      const n = e.kind === 'makeToken' ? 1 : tocPublicValue(o, e.count, actor, source);
      if (n === null) return null;
      const supply = o.players[controller].deckCount + o.players[controller].discard.length;
      total +=
        (controller === actor ? 1 : -1) * Math.min(6, supply, Math.max(0, n)) * tokenUnitValue(o, controller);
    } else if (e.kind === 'if') {
      const known = condition(o, e.condition, actor, source);
      if (known === null) return null;
      const n = production(o, actor, source, known ? e.then : (e.otherwise ?? []), depth + 1);
      if (n === null) return null;
      total += n;
    } else return null;
  }
  return total;
}
function permanentlyCannotReap(o: Observation, c: CardView): boolean {
  return (
    boxes(c).some((d) => d.cannotReap) ||
    board(o).some((u) => u.attachedTo === c.id && boxes(u).some((d) => d.upgrade?.cannotReap))
  );
}
export function tokenEngineValue(o: Observation, c: CardView): number {
  const a = c.spec.abilities;
  const reap = permanentlyCannotReap(o, c) ? 0 : (production(o, c.controller, c, a?.reap ?? []) ?? 0);
  const action = production(o, c.controller, c, a?.action ?? []) ?? 0;
  const omni = production(o, c.controller, c, a?.omni ?? []) ?? 0;
  // An Action competes with ordinary reap. Only the excess is a premium.
  return Math.min(3, Math.max(0, reap, action - 3.5, omni - 3.5) * 0.4);
}
export function tokenHouseWork(o: Observation, house: string): number {
  const me = o.players[o.you];
  let work = 0;
  for (const c of [...(me.hand ?? []), ...(me.archives ?? [])]) {
    if (c.controller !== o.you || !(c.effective.houses ?? [c.effective.house]).includes(house as House))
      continue;
    work += Math.max(0, production(o, o.you, c, c.spec.abilities?.play ?? []) ?? 0);
  }
  for (const c of me.battleline) {
    if (
      !c.ready ||
      c.stunned ||
      publicReapBlocked(o, c) !== false ||
      !(c.effective.houses ?? [c.effective.house]).includes(house as House)
    )
      continue;
    work += Math.max(0, production(o, o.you, c, c.spec.abilities?.reap ?? []) ?? 0);
  }
  return Math.min(10, work * 0.5);
}

/** True/false is a proven public restriction; null is an unmodeled rule, never a promised unlock. */
export function publicReapBlocked(
  o: Observation,
  target: CardView,
  removed: ReadonlySet<string> = new Set(),
): boolean | null {
  const incomplete =
    o.publicStateCoverage?.effectsComplete === false || o.publicStateCoverage?.turnHistoryComplete === false;
  // A current ordinary native Reap is positive evidence, even when printed
  // catalogue text was blanked by an effect the wire does not serialize.
  // It proves nothing after a hypothetical departure or about borrowed enemy use.
  if (
    incomplete &&
    removed.size === 0 &&
    target.controller === o.you &&
    o.activePlayer === o.you &&
    o.legalActions.some(
      (x) => x.action.kind === 'reap' && x.action.card === target.id && x.action.permission === undefined,
    )
  )
    return false;
  const visible = publicOnly(o, removed);
  if (permanentlyCannotReap(visible, target)) return true;
  const line = visible.players[target.controller].battleline;
  const position = line.findIndex((c) => c.id === target.id);
  if (
    position >= 0 &&
    [line[position - 1], line[position + 1]].some((c) => c && boxes(c).some((d) => d.prohibitsNeighborReap))
  )
    return true;
  // Missing effect/history fields are not a known absence of lasting locks,
  // gained text or next-use restrictions. Missing Reap in a UI menu is not a lock.
  let unknown = incomplete;
  const enemies = visible.players[other(target.controller)].battleline;
  const forcedFight = target.enraged || board(visible).some((c) => boxes(c).some((d) => d.globalFightIfAble));
  if (forcedFight && enemies.length) {
    const enemyIds = new Set(enemies.map((c) => c.id));
    // Enrage requires a fight only when a fight is possible. Do not invent a
    // future target or claim that a temporary restriction applies next turn.
    const provenFight = o.legalActions.some(
      (x) => x.action.kind === 'fight' && x.action.card === target.id && enemyIds.has(x.action.target),
    );
    if (provenFight) return true;
    // A hypothetical departure may change fight eligibility; the old menu is then stale.
    const provenReap =
      removed.size === 0 &&
      o.legalActions.some((x) => x.action.kind === 'reap' && x.action.card === target.id);
    if (!provenReap) unknown = true;
  }
  // The single-use restriction belongs to the active turn; it is not an opponent's
  // next-turn restriction. Borrowed-use permissions are not projected as future reaps.
  if (
    target.controller === o.activePlayer &&
    o.nextCreatureUseRestriction?.turn === o.turn &&
    (o.nextCreatureUseRestriction.cannot === 'reap' || o.nextCreatureUseRestriction.alsoCannot === 'reap')
  )
    return true;
  const houses = target.effective.houses ?? [target.effective.house];
  if (
    o.lasting.some(
      (e) =>
        e.turn === o.turn &&
        e.appliesTo === target.controller &&
        (e.rule === 'noReap' || (e.rule === 'noReapHouse' && e.house && houses.includes(e.house))),
    )
  )
    return true;
  for (const source of board(visible))
    for (const d of boxes(source)) {
      if (d.prohibitsEnemyReap && source.controller !== target.controller) return true;
      for (const rule of d.reapRestrictions ?? []) {
        const ts = targets(visible, rule.filter, source.controller, source);
        if (ts === null) {
          unknown = true;
          continue;
        }
        if (!ts.some((c) => c.id === target.id)) continue;
        const onSource = rule.sourceCondition
          ? condition(visible, rule.sourceCondition, source.controller, source)
          : true;
        const onTarget = rule.condition
          ? condition(visible, rule.condition, target.controller, target)
          : true;
        if (onSource === true && onTarget === true) {
          // This restriction is gained text and disappears on a blanked recipient.
          // Observation has no stable public blanked flag; do not assert a lock or
          // its hypothetical removal from an unknown recipient text state.
          if (rule.gainedText) unknown = true;
          else return true;
        }
        if (onSource !== false && onTarget !== false && (onSource === null || onTarget === null))
          unknown = true;
      }
    }
  return unknown ? null : false;
}

/** Compare before/after a known simultaneous departure, so two locks or a last token are handled once.
 * Current-house, unused ready creatures have concrete follow-up work; future turns are discounted.
 */
export function reapUnlockDelta(
  o: Observation,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  consumed?: string,
): number {
  let gain = 0;
  for (const p of o.players)
    for (const c of p.battleline) {
      if (after.has(c.id) || c.id === consumed || c.stunned) continue;
      const was = publicReapBlocked(o, c, before),
        now = publicReapBlocked(o, c, after);
      if (was !== true || now !== false) continue;
      const immediate =
        c.controller === o.you &&
        o.activePlayer === o.you &&
        c.ready &&
        (c.effective.houses ?? [c.effective.house]).includes(o.activeHouse as House);
      gain += sign(o, c.controller) * (immediate ? 3.2 : c.ready ? 0.8 : 0.45);
    }
  return Math.max(-18, Math.min(18, gain));
}
