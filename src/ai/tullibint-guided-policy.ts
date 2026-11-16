/** User-guided Well/Island timing. Frozen V1–V3 implementations and identities are unchanged. */
import type { Action, CardView, Effect, House, Observation, Value } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { Policy } from './policies.js';
import { planBurstExchange, rankBurstIsland, type WellExchangePlan } from './tullibint-burst-policy.js';
import { rankTullibint } from './tullibint-policy.js';
import { publicRefillForecast } from './public-refill-planning.js';
import { publicCards, publicValue } from './season-utility.js';

const WELL = 'well-of-memory';
const ISLAND = 'island-of-misfit-toys';
const WITCH = 'haunting-witch';
const matches = (c: CardView, h: House) => (c.effective.houses ?? [c.effective.house]).includes(h);
const amberIcons = (c: CardView) =>
  (c.resolvedBonusIcons ?? c.bonusIcons ?? Array<string>(c.spec.amber).fill('amber')).filter(
    (x) => x === 'amber',
  ).length;

export interface GuidedIslandPlan {
  returning: string[];
  mustDestroyWell: boolean;
  wellReachable: boolean;
  witchReachable: boolean;
  burstCreatures: number;
  discardAfterExchange: number;
  hauntedAfterKnownPreparation: boolean;
  discardValue: number;
  valuable: boolean;
  visibleEctoFinish: boolean;
  exchange: WellExchangePlan | null;
}

/** Evaluate only identities already in this player's hand, public discard or public battlefield. */
export function planGuidedIsland(o: Observation): GuidedIslandPlan {
  const me = o.players[o.you];
  const hand = me.hand ?? [];
  const well = me.artifacts.find((c) => c.definition === WELL);
  const island = me.artifacts.find((c) => c.definition === ISLAND);
  const heldWell = hand.find((c) => c.definition === WELL);
  const graveWell = me.discard.find((c) => c.definition === WELL);
  const canDestroyWell =
    !!well && !well.warded && !well.spec.invulnerable && !well.spec.invulnerableCondition;
  const mustDestroyWell = !heldWell && !graveWell && canDestroyWell;
  const grave = [...me.discard, ...(mustDestroyWell && well ? [well] : [])];
  const returning = grave.filter((c) => matches(c, 'geistoid'));
  const afterIslandGrave = grave.filter((c) => !matches(c, 'geistoid'));
  const afterIslandHand = [...hand, ...returning];
  const nextWell = afterIslandHand.find((c) => c.definition === WELL);
  const boardWitch = me.battleline.some((c) => c.definition === WITCH && c.spec.reactions?.length);
  const possibleWitch = boardWitch || [...hand, ...afterIslandGrave].some((c) => c.definition === WITCH);
  const preparedHand = afterIslandHand.filter((c) => c.id !== nextWell?.id);
  const projected: Observation = {
    ...o,
    activeHouse: 'geistoid',
    haunted: [
      o.haunted?.[0] ?? o.players[0].discard.length >= 10,
      o.haunted?.[1] ?? o.players[1].discard.length >= 10,
    ],
    players: [{ ...o.players[0] }, { ...o.players[1] }],
  };
  projected.players[o.you] = {
    ...me,
    hand: preparedHand,
    handCount: preparedHand.length,
    discard: afterIslandGrave,
    artifacts: me.artifacts.filter((c) => c.id !== island?.id && c.id !== well?.id),
  };
  projected.haunted![o.you] = afterIslandGrave.length >= 10;
  // Do not run the expensive package optimizer when the visible prerequisites already fail.
  const exchange =
    nextWell && possibleWitch && returning.filter((c) => c.definition !== WELL).length >= 2
      ? planBurstExchange(projected, 'core')
      : null;
  const purge = new Set(exchange?.purge ?? []);
  const recover = new Set(exchange?.recover ?? []);
  const futureHand = [
    ...preparedHand.filter((c) => !purge.has(c.id)),
    ...afterIslandGrave.filter((c) => recover.has(c.id)),
  ];
  const futureGrave = afterIslandGrave.filter((c) => !recover.has(c.id));
  const witchReachable =
    boardWitch || futureHand.some((c) => c.definition === WITCH && matches(c, 'untamed'));
  const burstCreatures = futureHand.filter((c) => c.spec.kind === 'creature' && matches(c, 'untamed')).length;
  // These are visible actions available before the following Untamed creature sequence.
  // A Festival mills at most the currently remaining deck; an empty deck does not manufacture fuel.
  const geistoidActions = futureHand.filter(
    (c) => matches(c, 'geistoid') && c.spec.kind === 'action' && c.definition !== 'ecto-charge',
  );
  const festival = geistoidActions.some((c) => c.definition === 'hallowed-eve-festival')
    ? Math.min(5, me.deckCount)
    : 0;
  const untamedSetup = futureHand.filter(
    (c) => matches(c, 'untamed') && c.spec.kind === 'action' && c.definition !== 'regrowth',
  ).length;
  const hauntedAfterKnownPreparation =
    futureGrave.length + geistoidActions.length + festival + untamedSetup >= 10;
  const discardValue =
    returning.reduce((n, c) => n + 1 + amberIcons(c) * 1.5 + (c.spec.kind === 'creature' ? 1 : 0), 0) +
    Math.max(0, exchange?.improvement ?? 0);
  const intercepted = o.players[1 - o.you].battleline
    .concat(o.players[1 - o.you].artifacts)
    .some((c) => c.spec.capturesIncomingAmber);
  const ecto = afterIslandHand.find((c) => c.definition === 'ecto-charge');
  const noActions = o.lasting.some(
    (e) => e.turn === o.turn && e.appliesTo === o.you && ['noPlay', 'noActions'].includes(e.rule),
  );
  const visibleEctoFinish =
    !!ecto &&
    !!island?.ready &&
    o.phase === 'main' &&
    o.activeHouse === 'geistoid' &&
    me.keys.length === 2 &&
    !me.forgeBlocked &&
    !intercepted &&
    !noActions &&
    me.amber + amberIcons(ecto) >= Math.max(6, me.keyCost + 20 - afterIslandGrave.length);
  const valuable =
    !!nextWell &&
    witchReachable &&
    burstCreatures >= (boardWitch ? 2 : 3) &&
    returning.filter((c) => c.definition !== WELL).length >= 2 &&
    hauntedAfterKnownPreparation &&
    discardValue >= 8 &&
    (!!exchange?.purge.length || preparedHand.filter((c) => matches(c, 'untamed')).length >= 3);
  return {
    returning: returning.map((c) => c.id),
    mustDestroyWell,
    wellReachable: !!nextWell,
    witchReachable,
    burstCreatures,
    discardAfterExchange: futureGrave.length,
    hauntedAfterKnownPreparation,
    discardValue,
    valuable,
    visibleEctoFinish,
    exchange,
  };
}

export interface GuidedDeckRunway {
  immediateDraws: number;
  nonDrawTopRemovals: number;
  handAfterAction: number;
  refillDraws: number;
  reshuffles: boolean;
  known: boolean;
}

/** Bounded count forecast, not a second game engine. Unknown effects do not assert a safe line. */
export function guidedDeckRunway(o: Observation, a: Action): GuidedDeckRunway {
  const me = o.players[o.you];
  const cards = publicCards(o);
  const c = 'card' in a ? cards.find((x) => x.id === a.card) : undefined;
  let draws = 0;
  let removals = 0;
  let remainingDeck = me.deckCount;
  let immediateShuffle = false;
  let known = true;
  const draw = (n: number) => {
    if (n > remainingDeck && me.discard.length > 0) immediateShuffle = true;
    draws += n;
    remainingDeck = Math.max(0, remainingDeck - n);
  };
  const removeTop = (n: number) => {
    const actual = Math.min(remainingDeck, n);
    removals += actual;
    remainingDeck -= actual;
  };
  const amount = (v: Value | undefined) => {
    const n = publicValue(o, v, o.you, c);
    if (n === null) known = false;
    return Math.max(0, n ?? 0);
  };
  function walk(effects: readonly Effect[], depth = 0): void {
    if (depth > 5) {
      known = false;
      return;
    }
    for (const e of effects) {
      if (e.kind === 'draw') draw(amount(e.amount));
      else if (e.kind === 'resource' && e.operation === 'draw' && (!e.side || e.side === 'self'))
        draw(amount(e.amount));
      else if (e.kind === 'discardDeckEdge' && (!e.side || e.side === 'self')) removeTop(amount(e.count));
      else if (e.kind === 'archiveTop' && (!e.side || e.side === 'self')) removeTop(1);
      else if (e.kind === 'cauldronStart') {
        removeTop(1);
        known = false;
      } else if (e.kind === 'if') {
        const l = publicValue(o, e.condition.left, o.you, c);
        const r = publicValue(o, e.condition.right, o.you, c);
        if (l === null || r === null) {
          known = false;
          continue;
        }
        const cmp = e.condition.comparison;
        const yes =
          cmp === 'eq'
            ? l === r
            : cmp === 'gt'
              ? l > r
              : cmp === 'gte'
                ? l >= r
                : cmp === 'lt'
                  ? l < r
                  : l <= r;
        walk(yes ? e.then : (e.otherwise ?? []), depth + 1);
      } else if (e.kind === 'forEach' || e.kind === 'recur') {
        const n = Math.min(36, amount(e.count));
        for (let i = 0; i < n; i++) walk(e.effects, depth + 1);
      } else if (e.kind === 'asPlayer') {
        if (!e.side || e.side === 'self') walk(e.effects, depth + 1);
        else if (e.side !== 'opponent') known = false;
      } else if (
        [
          'refill',
          'millUntil',
          'inspectTop',
          'choose',
          'chooseCards',
          'bindDeckEdge',
          'playBound',
          'topCard',
          'shuffleZones',
          'randomArchive',
        ].includes(e.kind)
      )
        known = false;
    }
  }
  let leavesHand = 0;
  if (
    ['play', 'discard', 'activateProphecy'].includes(a.kind) &&
    c &&
    (me.hand ?? []).some((x) => x.id === c.id)
  )
    leavesHand = 1;
  if (a.kind === 'play' && c) {
    draw((c.resolvedBonusIcons ?? c.bonusIcons ?? []).filter((x) => x === 'draw').length);
    // Well exchanges preserve hand size after its own play when selected returns exist.
    if (c.definition !== WELL) walk(c.spec.abilities?.play ?? []);
    if (c.spec.drawBonus || c.spec.drawBonusValue || c.spec.globalDrawBonus || c.spec.globalHauntedDrawBonus)
      known = false;
  } else if (a.kind === 'use' && c) {
    const entry = o.legalActions.find((x) => x.action === a);
    walk(entry?.useDescription?.effects ?? c.spec.abilities?.action ?? c.spec.abilities?.omni ?? []);
  } else if (a.kind === 'reap' && c) walk(c.spec.abilities?.reap ?? []);
  else if (a.kind === 'discard' && c) walk(c.spec.abilities?.scrap ?? []);
  const handAfterAction = Math.max(0, me.handCount - leavesHand + draws);
  const refill = publicRefillForecast(o, handAfterAction, remainingDeck);
  return {
    immediateDraws: draws,
    nonDrawTopRemovals: removals,
    handAfterAction,
    refillDraws: refill.draws,
    reshuffles: immediateShuffle || refill.reshuffles,
    known: known && refill.knownModifiers,
  };
}

function visibleSource(o: Observation): CardView | undefined {
  return publicCards(o).find((c) => c.id === o.pending?.source);
}

export function rankGuidedIsland(o: Observation, committed?: WellExchangePlan): ActionAssessment[] {
  const me = o.players[o.you];
  const hand = me.hand ?? [];
  const spent = me.purged.some((c) => c.definition === ISLAND);
  const rows = spent ? rankBurstIsland(o, 'core', committed) : rankTullibint(o);
  const cards = new Map(publicCards(o).map((c) => [c.id, c]));
  const legal = new Map(o.legalActions.map((entry) => [entry.id, entry.action]));
  const island = me.artifacts.find((c) => c.definition === ISLAND);
  const partner = island ?? hand.find((c) => c.definition === ISLAND);
  const plan = !spent && partner ? planGuidedIsland(o) : null;
  const preserving = !!plan && plan.wellReachable && plan.witchReachable && plan.returning.length >= 3;
  const runways = new Map(rows.map((row) => [row.actionId, guidedDeckRunway(o, legal.get(row.actionId)!)]));
  const hasSafeAction = rows.some((row) => {
    const a = legal.get(row.actionId)!;
    const runway = runways.get(row.actionId)!;
    return (
      ['endTurn', 'play', 'use', 'reap', 'discard'].includes(a.kind) && runway.known && !runway.reshuffles
    );
  });
  return rows
    .map((row) => {
      const a = legal.get(row.actionId)!;
      if (row.score >= 5000 || a.kind === 'forge' || a.kind === 'payForge') return row;
      const c = 'card' in a ? cards.get(a.card) : undefined;
      let score = row.score;
      const reasons: string[] = [];
      const set = (n: number, reason: string) => {
        score = n;
        reasons.push(reason);
      };
      if (plan && a.kind === 'house' && a.house === 'geistoid' && island?.ready && plan.valuable)
        set(
          score + Math.min(12, plan.discardValue * 0.3),
          'guided Island: choose a house for an actually assembled Witch package',
        );
      if (!spent && a.kind === 'play' && c?.definition === ISLAND)
        set(
          Math.max(score, 4),
          'guided Island: deploy the exhausted artifact ahead of its future action window',
        );
      if (!spent && a.kind === 'play' && c?.definition === WELL && partner) {
        if (island?.ready && plan?.valuable)
          set(-8, 'guided Well: retrieve with the ready Island before exchanging the enlarged hand');
        else
          set(
            Math.max(score, 3),
            'guided Well: earlier deployment is preparation, separate from Island activation',
          );
      }
      if (!spent && a.kind === 'discard' && c && [WELL, ISLAND].includes(c.definition) && partner)
        set(Math.min(score, -18), 'guided Well/Island: retain visible complementary pieces');
      if (
        !spent &&
        a.kind === 'use' &&
        c?.definition === WELL &&
        plan &&
        island?.ready &&
        plan.valuable &&
        plan.mustDestroyWell
      )
        set(
          9 + Math.min(8, plan.discardValue * 0.1),
          'guided Well: put the recoverable Well in discard before the ready Island',
        );
      if (!spent && a.kind === 'use' && c?.definition === ISLAND && plan) {
        if (plan.visibleEctoFinish)
          set(
            50000,
            'guided Island: visible Ecto third-key line takes priority over waiting for a larger burst',
          );
        else if (plan.valuable && !plan.mustDestroyWell)
          set(
            8 + Math.min(8, plan.discardValue * 0.1),
            'guided Island: sufficient Geistoid fuel, reachable Witch and Haunted preparation justify spending the one-shot',
          );
        else
          set(
            -12,
            plan.mustDestroyWell
              ? 'guided Island: recover Well only after its actual destruction'
              : 'guided Island: missing Witch, fuel or Haunted payoff; keep ordinary play',
          );
      }
      const runway = runways.get(row.actionId)!;
      if (
        preserving &&
        hasSafeAction &&
        runway.known &&
        runway.reshuffles &&
        ['play', 'use', 'reap', 'discard', 'endTurn'].includes(a.kind) &&
        c?.definition !== ISLAND &&
        score < 5000
      )
        set(
          Math.min(score, -25),
          'guided setup: this public draw/mill/refill count would reshuffle the valuable discard before Island',
        );
      return {
        ...row,
        score,
        approximate: row.approximate || reasons.length > 0,
        reasons: [...row.reasons, ...reasons],
      };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}

/** Memory holds only this turn's own-hand/discard Well exchange, scoped to its actual prompt. */
export function guidedIslandPolicy(): Policy {
  let window: { turn: number; source: string; plan: WellExchangePlan } | undefined;
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    const me = o.players[o.you];
    const source = visibleSource(o);
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
    return rankGuidedIsland(o, committed)[0].actionId;
  };
}
