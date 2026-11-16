/** Core-preserving Well + Island burst sequencing. V1 and the rejected V2 trial remain immutable. */
import { rankTullibint } from './tullibint-policy.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { CardView, House, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';

export type BurstIslandMode = 'core' | 'burst' | 'sequence';
const WELL = 'well-of-memory',
  ISLAND = 'island-of-misfit-toys',
  WITCH = 'haunting-witch';
const houses: House[] = ['untamed', 'geistoid', 'staralliance'];
const matches = (c: CardView, h: House | null) =>
  !!h && (c.effective.houses ?? [c.effective.house]).includes(h);
const icons = (c: CardView) =>
  (c.resolvedBonusIcons ?? c.bonusIcons ?? Array<string>(c.spec.amber).fill('amber')).filter(
    (x) => x === 'amber',
  ).length;
const idOrder = (a: CardView, b: CardView) => a.id.localeCompare(b.id, 'en');
function visible(o: Observation): Map<string, CardView> {
  return new Map(
    [
      ...o.players.flatMap((p) => [
        ...(p.hand ?? []),
        ...(p.archives ?? []),
        ...p.battleline,
        ...p.artifacts,
        ...p.upgrades,
        ...p.discard,
        ...p.purged,
      ]),
      ...o.promptCards,
      ...o.resolving,
      ...o.underCards.flatMap((x) => x.cards ?? []),
    ].map((c) => [c.id, c]),
  );
}
/** A bounded two-turn utility, not a simulated future hand or an asserted guaranteed payout. */
function handValue(o: Observation, hand: CardView[], discard: CardView[], h: House): number {
  const me = o.players[o.you],
    foe = o.players[1 - o.you];
  const own = hand.filter((c) => matches(c, h));
  const nowActions =
    h === o.activeHouse
      ? []
      : hand.filter(
          (c) => matches(c, o.activeHouse) && c.spec.kind === 'action' && c.definition !== 'ecto-charge',
        );
  const festival = nowActions.some((c) => c.definition === 'hallowed-eve-festival')
    ? Math.min(5, me.deckCount)
    : 0;
  const laterActions = own.filter((c) => c.definition === 'rotfeast').length;
  const houseMill =
    h !== o.activeHouse && me.deckCount > 0 && me.artifacts.some((c) => c.definition === 'haunted-house')
      ? 1
      : 0;
  const haunted = discard.length + nowActions.length + festival + laterActions + houseMill >= 10;
  const boardWitches = me.battleline.filter((c) => c.definition === WITCH && c.spec.reactions?.length).length;
  const witches = own.filter((c) => c.definition === WITCH).length;
  const creatures = own.filter((c) => c.spec.kind === 'creature').length;
  const regrowths = own.filter((c) => c.definition === 'regrowth').length;
  const recoverableCreatures = discard.filter((c) => c.spec.kind === 'creature' && matches(c, h)).length;
  const replayable = Math.min(regrowths, recoverableCreatures);
  const witchIncome = haunted
    ? boardWitches * (creatures + replayable) +
      (witches * (witches + 1)) / 2 +
      witches * Math.max(0, creatures - witches + replayable)
    : 0;
  const intercepted = [...foe.battleline, ...foe.artifacts].some((c) => c.spec.capturesIncomingAmber);
  let value = own.reduce((n, c) => n + 1.6 + icons(c) * 2.1 + (c.spec.kind === 'creature' ? 2.3 : 0), 0);
  value += witchIncome * (intercepted ? 0.2 : 2.4);
  if ((witches || boardWitches) && !haunted) value -= (witches + boardWitches) * 15;
  if (own.some((c) => c.definition === 'ecto-charge')) {
    const cost = Math.max(6, me.keyCost + 20 - discard.length);
    value += me.keys.length === 2 ? Math.max(1, 14 - (cost - me.amber) * 1.4) : 3;
  }
  // Other houses are retained resources, not worthless purge fodder. Avoid keeping every old core
  // card at all costs, however: a complete burst package can legitimately replace a partial engine.
  value += hand
    .filter((c) => !matches(c, h))
    .reduce((n, c) => n + icons(c) * 0.9 + (c.spec.kind === 'creature' ? 1.1 : 0.4), 0);
  const retained: Record<string, number> = {
    'dimo-elderghast': 8,
    'haunting-witch': 6,
    'ecto-charge': me.keys.length === 2 ? 14 : 8,
    cauldron: 6,
    'haunted-house': 5,
    'hallowed-eve-festival': !haunted ? 7 : 2,
    'be-our-geist': 3,
    regrowth: 3,
    'chief-engineer-walls': 3,
  };
  value += hand.reduce((n, c) => n + (retained[c.definition] ?? 0), 0);
  return value;
}
function keepCost(o: Observation, c: CardView, h: House): number {
  if ([WELL, ISLAND].includes(c.definition)) return 1000;
  const me = o.players[o.you];
  if (['ecto-charge', 'dimo-elderghast', WITCH, 'cauldron', 'haunted-house'].includes(c.definition))
    return 100;
  let n = icons(c) * 1.0 + (c.spec.kind === 'creature' ? 1.2 : 0.4) + (matches(c, h) ? 3 : 0);
  if (c.definition === WITCH) n += 9;
  if (c.definition === 'ecto-charge') n += 6;
  if (c.definition === 'hallowed-eve-festival' && me.discard.length < 15) n += 4;
  if (c.definition === 'cauldron' && !me.artifacts.some((x) => x.definition === 'cauldron')) n += 5;
  if (c.definition === 'haunted-house') n += 3;
  if (c.definition === 'dimo-elderghast')
    n += me.battleline.some((x) => x.definition === 'dimo-elderghast') ? 1 : 3;
  if (c.definition === 'regrowth') n += 4;
  if (c.definition === 'chief-engineer-walls') n += 2;
  return n;
}
export interface WellExchangePlan {
  house: House;
  purge: string[];
  recover: string[];
  improvement: number;
}
export function planBurstExchange(o: Observation, mode: BurstIslandMode = 'core'): WellExchangePlan {
  const me = o.players[o.you],
    hand = [...(me.hand ?? [])].sort(idOrder),
    discard = [...me.discard].sort(idOrder);
  let best: WellExchangePlan = { house: 'untamed', purge: [], recover: [], improvement: 0 };
  for (const h of houses) {
    const offerings = hand
      .filter((c) => keepCost(o, c, h) < 100)
      .sort((a, b) => keepCost(o, a, h) - keepCost(o, b, h) || idOrder(a, b));
    const initial = handValue(o, hand, discard, h);
    for (let k = 1; k <= Math.min(offerings.length, discard.length); k++) {
      const purge = offerings.slice(0, k),
        removed = new Set(purge.map((c) => c.id));
      const held = hand.filter((c) => !removed.has(c.id)),
        remaining = [...discard],
        recovered: CardView[] = [];
      for (let n = 0; n < k; n++) {
        let winner = remaining[0],
          score = -Infinity;
        for (const c of remaining) {
          const v = handValue(
            o,
            [...held, ...recovered, c],
            remaining.filter((x) => x.id !== c.id),
            h,
          );
          if (v > score + 1e-9 || (Math.abs(v - score) < 1e-9 && idOrder(c, winner) < 0)) {
            score = v;
            winner = c;
          }
        }
        recovered.push(winner);
        remaining.splice(remaining.indexOf(winner), 1);
      }
      const thinning = purge.reduce((n, c) => n + Math.max(0, 3 - keepCost(o, c, h)) * 0.35, 0);
      const improvement =
        handValue(o, [...held, ...recovered], remaining, h) -
        initial +
        thinning -
        k * (mode === 'burst' ? 0.8 : 1.8);
      if (improvement > best.improvement + 1e-9)
        best = { house: h, purge: purge.map((c) => c.id), recover: recovered.map((c) => c.id), improvement };
    }
  }
  return best;
}
function recoveryValues(o: Observation): Map<string, number> {
  const me = o.players[o.you],
    hand = me.hand ?? [],
    grave = me.discard;
  const base = Math.max(...houses.map((h) => handValue(o, hand, grave, h)));
  return new Map(
    grave.map((c) => [
      c.id,
      Math.max(
        ...houses.map((h) =>
          handValue(
            o,
            [...hand, c],
            grave.filter((x) => x.id !== c.id),
            h,
          ),
        ),
      ) - base,
    ]),
  );
}
export function rankBurstIsland(
  o: Observation,
  mode: BurstIslandMode = 'core',
  committed?: WellExchangePlan,
): ActionAssessment[] {
  const rows = rankTullibint(o),
    me = o.players[o.you],
    hand = me.hand ?? [],
    cards = visible(o);
  const legal = new Map(o.legalActions.map((a) => [a.id, a.action]));
  const island = me.artifacts.find((c) => c.definition === ISLAND),
    well = me.artifacts.find((c) => c.definition === WELL);
  const heldWell = hand.find((c) => c.definition === WELL),
    graveWell = me.discard.find((c) => c.definition === WELL);
  const wellAvailable = !!(heldWell || graveWell || well);
  const returning = me.discard.filter((c) => matches(c, 'geistoid'));
  const limit = mode === 'burst' ? 10 : 6;
  const late = me.deckCount <= limit;
  const window = late && returning.length >= 4 && me.discard.length >= 14 && wellAvailable;
  const islandSpent = me.purged.some((c) => c.definition === ISLAND);
  const rebuilding = mode !== 'sequence' && islandSpent;
  const activeIsland = !!island?.ready && matches(island, o.activeHouse);
  const source = cards.get(o.pending?.source ?? '');
  const wellSelecting =
    source?.definition === WELL &&
    o.legalActions.some(
      (x) => x.action.kind === 'select' && hand.some((c) => c.id === (x.action as { target: string }).target),
    );
  const exchange = rebuilding
    ? wellSelecting
      ? (committed ?? planBurstExchange(o, mode))
      : heldWell && o.legalActions.some((x) => x.action.kind === 'play' && x.action.card === heldWell.id)
        ? planBurstExchange(o, mode)
        : null
    : null;
  const recovery =
    rebuilding && source?.definition === WELL && !wellSelecting
      ? recoveryValues(o)
      : new Map<string, number>();
  return rows
    .map((row) => {
      const a = legal.get(row.actionId)!;
      if (row.score >= 5000 || a.kind === 'forge' || a.kind === 'payForge') return row;
      const c = 'card' in a ? cards.get(a.card) : undefined;
      let score = row.score;
      const why: string[] = [];
      const set = (n: number, reason: string) => {
        score = n;
        why.push(reason);
      };
      if (a.kind === 'house' && a.house === 'geistoid' && island?.ready && window)
        set(score + 10, 'late-deck Well + Island option without overriding a strong current-house burst');
      if (rebuilding && a.kind === 'house' && a.house === 'untamed') {
        const val = handValue(o, hand, me.discard, 'untamed');
        if (hand.filter((x) => matches(x, 'untamed')).length >= 4 && val >= 30)
          set(Math.max(score, val), 'cash assembled Untamed burst rather than fragmenting the large hand');
      }
      if (a.kind === 'play' && c?.definition === ISLAND)
        set(Math.max(score, 6), 'deploy Island as setup without outranking immediate income engines');
      if (
        a.kind === 'discard' &&
        c?.definition === WELL &&
        (island || hand.some((x) => x.definition === ISLAND))
      )
        set(-20, 'keep Well when its Island partner is actually accessible');
      if (a.kind === 'use' && c?.definition === WELL && activeIsland && window && !well?.warded)
        set(0.8, 'first finish profitable current actions; then destroy Well before the Island refill');
      if (a.kind === 'use' && c?.definition === ISLAND && window) {
        if (well?.ready && !well.warded)
          set(-2, 'first destroy Well; Island cannot recover a Well still in play');
        else set(0.7, 'cash existing Haunted work before Island changes the discard threshold');
      }
      if (a.kind === 'play' && c?.definition === WELL) {
        if (activeIsland && window) set(-2, 'activate Island before paying the Well hand-exchange cost');
        else if (exchange && exchange.improvement >= 3)
          set(
            Math.max(18, 20 + exchange.improvement),
            'purge selected expendable cards to assemble a coherent next-house burst',
          );
      }
      if (rebuilding && wellSelecting && a.kind === 'select') {
        const selected = o.pending?.selected ?? [];
        set(
          selected.includes(a.target) ? -100 : exchange?.purge.includes(a.target) ? 25 : -20,
          'bounded complete-package purge plan, no arbitrary twenty-card floor and no toggle loop',
        );
      }
      if (rebuilding && wellSelecting && a.kind === 'done')
        set(0, 'finish exactly the selected profitable exchange');
      if (
        rebuilding &&
        source?.definition === WELL &&
        !wellSelecting &&
        a.kind === 'select' &&
        recovery.has(a.target)
      ) {
        const index = committed?.recover.indexOf(a.target) ?? -1;
        set(
          index >= 0 ? 100 - index : 10 + recovery.get(a.target)!,
          'follow the observable committed whole-hand exchange package, rather than changing goals midway',
        );
      }
      if (
        rebuilding &&
        a.kind === 'discard' &&
        c?.definition === 'hallowed-eve-festival' &&
        me.discard.length < 10 &&
        late
      )
        set(-25, 'use Festival to rebuild Haunted after mass retrieval, not merely discard it');
      if (
        rebuilding &&
        a.kind === 'play' &&
        c?.definition === 'hallowed-eve-festival' &&
        me.discard.length < 10 &&
        late &&
        me.deckCount > 0
      )
        set(
          Math.max(score, 35),
          'restore the actual Haunted threshold after Island/Well before creature payout',
        );
      if (
        rebuilding &&
        a.kind === 'play' &&
        c &&
        matches(c, 'untamed') &&
        me.discard.length < 10 &&
        c.definition !== WITCH &&
        c.spec.kind === 'action'
      ) {
        if (hand.some((x) => x.definition === WITCH) && me.discard.length >= 8)
          set(Math.max(score, 22), 'discard-resolving actions before the Haunted Witch burst');
      }
      return {
        ...row,
        score,
        reasons: [...row.reasons, ...why],
        approximate: row.approximate || why.length > 0,
      };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
/** The only memory is a plan made from the player's own visible hand and discard. It is
 * scoped to one actual Well choice window; no state, shuffle, seed or opponent hand is stored. */
export function burstIslandPolicy(mode: BurstIslandMode = 'core'): Policy {
  let window: { turn: number; source: string; plan: WellExchangePlan } | undefined;
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    const me = o.players[o.you],
      source = visible(o).get(o.pending?.source ?? '');
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
      mode !== 'sequence' &&
      me.purged.some((c) => c.definition === ISLAND) &&
      (!window || window.source !== o.pending!.source)
    )
      window = { turn: o.turn, source: o.pending!.source, plan: planBurstExchange(o, mode) };
    const committed =
      window?.turn === o.turn && window.source === o.pending?.source ? window.plan : undefined;
    return rankBurstIsland(o, mode, committed)[0].actionId;
  };
}
