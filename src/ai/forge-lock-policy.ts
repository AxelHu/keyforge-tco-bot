/** Public-information corrections for forging locks. A heuristic layer, never an engine-state oracle. */
import { rankCompetitive, type CompetitiveProfile } from './competitive-policy.js';
import type { ActionAssessment, AlgorithmFeatures } from './algorithm-policies.js';
import type { CardView, Effect, Filter, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
import { assessPublicOperation } from './public-card-value.js';

/** Follow only an explicit current-step locator inside this already-visible source definition. */
function currentHouseEffect(
  o: Observation,
  source: CardView,
): Extract<Effect, { kind: 'chooseHouse' }> | undefined {
  const intent = o.pending?.intent;
  if (
    (intent?.kind !== 'house-choice' && intent?.kind !== 'house-restriction') ||
    !intent.selection
  )
    return;
  const { ability, path } = intent.selection,
    abilities = source.spec.abilities;
  if (
    !abilities ||
    !Object.prototype.hasOwnProperty.call(abilities, ability) ||
    !Array.isArray(path) ||
    path.length < 1 ||
    path.length > 24 ||
    typeof path[0] !== 'number'
  )
    return;
  let value: unknown = abilities[ability];
  for (const key of path) {
    if (
      !value ||
      typeof value !== 'object' ||
      (typeof key === 'number'
        ? !Array.isArray(value) || !Number.isSafeInteger(key) || key < 0
        : Array.isArray(value) || ['__proto__', 'constructor', 'prototype'].includes(key)) ||
      !Object.prototype.hasOwnProperty.call(value, key)
    )
      return;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value && typeof value === 'object' && (value as Effect).kind === 'chooseHouse'
    ? (value as Extract<Effect, { kind: 'chooseHouse' }>)
    : undefined;
}

export function rankForgeAware(
  o: Observation,
  profile: CompetitiveProfile = 'tactical',
  corrections: AlgorithmFeatures = {},
): ActionAssessment[] {
  const me = o.players[o.you],
    foe = o.players[1 - o.you];
  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts]);
  const cards = new Map(
    [...board, ...(me.hand ?? []), ...(me.archives ?? []), ...o.promptCards, ...o.resolving].map(
      (c) => [c.id, c],
    ),
  );
  const funded = (seat: number) => o.players[seat].forgeAvailable >= o.players[seat].keyCost;
  const hardStop = (c: CardView, seat: number) => {
    const p = o.players[seat];
    return (
      !!c.spec.prohibitsForging ||
      c.spec.forbiddenKeyOrdinal === p.keys.length + 1 ||
      (!!c.spec.cannotForgeAhead && p.keys.length > o.players[1 - seat].keys.length)
    );
  };
  const stops = (c: CardView, seat: number) =>
    hardStop(c, seat) || (!!c.spec.skipForgeStep && c.controller === seat);
  const hardLocks = [0, 1].map((seat) => board.filter((c) => hardStop(c, seat)));
  const locks = [0, 1].map((seat) => board.filter((c) => stops(c, seat)));
  function removalValue(c: CardView, hypothetical = false): number {
    const own = stops(c, o.you),
      enemy = stops(c, 1 - o.you);
    const ownCount = locks[o.you].length + Number(hypothetical);
    const enemyCount = locks[1 - o.you].length + Number(hypothetical);
    let value = own && funded(o.you) ? (me.keys.length === 2 ? 38 : 24) / Math.max(1, ownCount) : 0;
    if (enemy && funded(1 - o.you) && foe.skipForgeTurn !== o.turn + 1) {
      // Removing the last third-key lock gives the opponent the first normal forge.
      value -= foe.keys.length === 2 && enemyCount <= 1 ? 160 : 7 / Math.max(1, enemyCount);
    }
    return value;
  }
  const useful = board.some((c) => removalValue(c) > 0);
  const supportedFilters = new Set([
    'side',
    'kind',
    'house',
    'notHouse',
    'other',
    'trait',
    'notTrait',
    'definition',
    'name',
    'zone',
    'flank',
    'ready',
    'stunned',
    'damaged',
    'powerMin',
    'powerMax',
  ]);
  function matches(f: Filter, c: CardView, source: CardView): boolean {
    if (Object.entries(f).some(([k, v]) => v !== undefined && !supportedFilters.has(k)))
      return false;
    if (f.side && f.side !== 'any' && (f.side === 'friendly') !== (c.controller === o.you))
      return false;
    if (f.kind && f.kind !== c.spec.kind) return false;
    if (f.house && !(c.effective.houses ?? [c.effective.house]).includes(f.house as never))
      return false;
    if (f.notHouse && (c.effective.houses ?? [c.effective.house]).includes(f.notHouse as never))
      return false;
    if (f.other && c.id === source.id) return false;
    if (f.trait && !c.spec.traits?.includes(f.trait)) return false;
    if (f.notTrait && c.spec.traits?.includes(f.notTrait)) return false;
    if (f.definition && f.definition !== c.definition) return false;
    if (f.name && f.name !== c.spec.name) return false;
    if (f.ready !== undefined && f.ready !== c.ready) return false;
    if (f.stunned !== undefined && f.stunned !== c.stunned) return false;
    if (f.damaged !== undefined && f.damaged !== c.damage > 0) return false;
    if (f.powerMin !== undefined && c.effective.power < f.powerMin) return false;
    if (f.powerMax !== undefined && c.effective.power > f.powerMax) return false;
    {
      const zones: string[] = Array.isArray(f.zone) ? f.zone : [f.zone ?? 'battleline'];
      const zone = c.spec.kind === 'artifact' ? 'artifacts' : 'battleline';
      if (!zones.includes(zone) && !zones.includes('play')) return false;
    }
    if (f.flank !== undefined) {
      const line = o.players[c.controller].battleline;
      if (f.flank !== (line[0]?.id === c.id || line.at(-1)?.id === c.id)) return false;
    }
    return true;
  }
  function lethalDamage(c: CardView, amount: unknown): boolean {
    return (
      typeof amount === 'number' &&
      !c.warded &&
      !c.spec.invulnerable &&
      !c.spec.cannotBeDamagedCondition &&
      amount >= c.effective.power - c.damage + Math.max(0, c.effective.armor - c.armorUsed)
    );
  }
  function operationValue(c: CardView, op: string, amount?: unknown): number {
    if (!board.some((x) => x.id === c.id)) return 0;
    if (
      [
        'destroy',
        'purge',
        'returnHand',
        'archive',
        'foreignArchive',
        'shuffleIntoDeck',
        'sacrifice',
      ].includes(op)
    ) {
      if (op !== 'sacrifice' && (c.warded || (op === 'destroy' && c.spec.invulnerable))) return 0;
      return removalValue(c);
    }
    return op === 'damage' && lethalDamage(c, amount) ? removalValue(c) : 0;
  }
  function combat(a: CardView, target: CardView): number {
    if (a.spec.noCombatDamage || target.spec.noCombatDamage) return 0;
    const elusive =
      target.effective.keywords.includes('elusive') &&
      !target.elusiveUsed &&
      !a.spec.ignoreTauntElusive;
    let result = 0;
    if (
      !elusive &&
      !a.effective.keywords.includes('skirmish') &&
      !target.spec.noDefenseDamage &&
      lethalDamage(a, target.effective.power)
    )
      result += removalValue(a);
    if (!elusive && lethalDamage(target, a.effective.power)) result += removalValue(target);
    return result;
  }
  function effectsImpact(effects: readonly Effect[], source: CardView): number {
    let sum = 0;
    for (const e of effects) {
      if (e.kind === 'sacrificeSelf') sum += removalValue(source);
      else if (e.kind === 'self') sum += operationValue(source, e.operation, e.amount);
      else if (e.kind === 'all')
        sum += board
          .filter((c) => matches(e.filter, c, source))
          .reduce((n, c) => n + operationValue(c, e.operation, e.amount), 0);
      else if (e.kind === 'target') {
        const xs = board
          .filter((c) => matches(e.filter, c, source))
          .map((c) => operationValue(c, e.operation, e.amount));
        if (xs.length) sum += Math.max(...xs, ...(e.optional ? [0] : []));
      } else if (e.kind === 'damageChoice')
        sum += Math.max(0, ...board.map((c) => operationValue(c, 'damage', e.amount)));
      else if (e.kind === 'choose')
        sum += Math.max(0, ...e.options.map((x) => effectsImpact(x.effects, source)));
      else if (e.kind === 'if')
        sum += Math.min(effectsImpact(e.then, source), effectsImpact(e.otherwise ?? [], source));
      else if (e.kind === 'useChoice' && e.mode === 'fight') {
        sum += Math.max(
          0,
          ...me.battleline
            .filter((c) => matches(e.filter, c, source))
            .flatMap((c) => foe.battleline.map((t) => combat(c, t))),
        );
      } else if (
        e.kind === 'useChoice' &&
        e.mode === 'artifact' &&
        e.after?.some((x) => x.kind === 'bound' && x.operation === 'destroy')
      ) {
        sum += Math.max(
          0,
          ...board
            .filter((c) => c.spec.kind === 'artifact' && matches(e.filter, c, source))
            .map((c) => removalValue(c)),
        );
      }
    }
    return sum;
  }
  const rows = rankCompetitive(o, profile, corrections).map((original) => {
    const item = o.legalActions.find((a) => a.id === original.actionId)!,
      a = item.action;
    const source =
      'card' in a
        ? cards.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card)
        : corrections.publicHouseChoices && a.kind === 'choose'
          ? cards.get(o.pending?.source ?? '')
          : undefined;
    let score = original.score,
      projectedKey = original.projectedKey,
      deniesKey = original.deniesKey;
    const reasons = [...original.reasons];
    if (
      hardLocks[o.you].length &&
      projectedKey &&
      (!source || effectsImpact(source.spec.abilities?.play ?? [], source) <= 0)
    ) {
      projectedKey = false;
      score = -4;
      reasons.push('v3: a visible forge lock also blocks off-step key effects');
    }
    if (hardLocks[o.you].length && score >= 7000 && score < 100000) score -= 7000;
    if (deniesKey && (foe.forgeBlocked || locks[1 - o.you].length)) {
      score -= 5000;
      deniesKey = false;
    }
    let delta = 0;
    if (score < 5000) {
      if (a.kind === 'play' && source) {
        delta += effectsImpact(source.spec.abilities?.play ?? [], source);
        if (source.spec.kind === 'creature' || source.spec.kind === 'artifact')
          delta -= removalValue(source, true);
        if (
          !foe.forgeBlocked &&
          !locks[1 - o.you].length &&
          foe.keys.length === 2 &&
          funded(1 - o.you) &&
          foe.skipForgeTurn !== o.turn + 1 &&
          stops(source, 1 - o.you)
        ) {
          delta += 5000;
          deniesKey = true;
          reasons.push('v3: deploy an explicit public third-key restriction');
        }
      } else if (a.kind === 'use' && source)
        delta += effectsImpact(
          item.useDescription?.effects ?? source.spec.abilities?.action ?? [],
          source,
        );
      else if (a.kind === 'fight' && source && cards.has(a.target))
        delta += combat(source, cards.get(a.target)!);
      else if (a.kind === 'select' && cards.has(a.target)) {
        const target = cards.get(a.target)!;
        if (o.pending?.intent?.kind === 'target-operation')
          delta += operationValue(target, o.pending.intent.operation, o.pending.amount);
        else if (o.pending?.kind === 'damage')
          delta += operationValue(target, 'damage', o.pending.amount);
      } else if (
        corrections.publicHouseChoices &&
        a.kind === 'choose' &&
        source &&
        o.pending?.kind === 'option'
      ) {
        const intent = o.pending.intent,
          options = o.pending.options;
        const houseIntent =
          intent?.kind === 'house-choice' || intent?.kind === 'house-restriction'
            ? intent
            : undefined;
        const choice = currentHouseEffect(o, source);
        const matched =
          houseIntent &&
          options &&
          options.length === houseIntent.options.length &&
          new Set(options.map((x) => x.id)).size === options.length &&
          options.every(
            (x) =>
              x.house &&
              houseIntent.options.filter(
                (meaning) => meaning.id === x.id && meaning.house === x.house,
              ).length === 1,
          );
        const chosenHouse = matched ? options?.find((x) => x.id === a.option)?.house : undefined;
        if (choice && chosenHouse) {
          // This is the currently legal house, not the best hypothetical future
          // branch. Reuse the existing Ward/lock removal correction unchanged.
          const effects = choice.then.map(
            (e): Effect =>
              e.kind === 'all' || e.kind === 'target'
                ? {
                    ...e,
                    filter: {
                      ...e.filter,
                      ...(e.filter.house === 'chosenHouse' ? { house: chosenHouse } : {}),
                      ...(e.filter.notHouse === 'chosenHouse' ? { notHouse: chosenHouse } : {}),
                    },
                  }
                : e,
          );
          delta += effectsImpact(effects, source);
          const removed = new Set(
            effects.flatMap((e) =>
              e.kind === 'all'
                ? board
                    .filter((c) => matches(e.filter, c, source))
                    .filter((c) => {
                      const r = assessPublicOperation(
                        o,
                        c,
                        e.operation,
                        typeof e.amount === 'number' ? e.amount : 0,
                      );
                      return r.removed && !r.approximate;
                    })
                    .map((c) => c.id)
                : [],
            ),
          );
          const enemyLocks = locks[1 - o.you];
          const remainingStorage = foe.forgeSources
            ? Object.entries(foe.forgeSources).reduce(
                (n, [id, amount]) => n + (id !== 'pool' && !removed.has(id) ? amount : 0),
                0,
              )
            : Math.max(0, foe.forgeAvailable - foe.amber);
          const remainingCost = Math.max(
            0,
            foe.keyCost -
              board.reduce(
                (n, c) =>
                  n +
                  (c.controller === o.you && removed.has(c.id) ? (c.spec.opponentKeyTax ?? 0) : 0),
                0,
              ),
          );
          if (
            enemyLocks.length &&
            foe.keys.length === 2 &&
            foe.skipForgeTurn !== o.turn + 1 &&
            enemyLocks.every((c) => removed.has(c.id)) &&
            original.estimatedAmber[1] + remainingStorage >= remainingCost
          ) {
            // Per-card removalValue assumes other locks survive. Replace its
            // summed 7-point multi-lock risk with the existing last-lock risk;
            // also include amber released by this very same house sweep.
            const alreadyCharged = funded(1 - o.you) ? (enemyLocks.length === 1 ? 160 : 7) : 0;
            delta += alreadyCharged - 160;
            reasons.push(
              'card-effects v3: this actual house sweep removes every remaining third-key lock',
            );
          }
        }
      } else if (a.kind === 'house' && useful) {
        const inHouse = (c: CardView) =>
          (c.effective.houses ?? [c.effective.house]).includes(a.house!);
        const opportunities = [
          ...(me.hand ?? [])
            .filter(inHouse)
            .map((c) => effectsImpact(c.spec.abilities?.play ?? [], c)),
          ...me.artifacts
            .filter((c) => c.ready && inHouse(c))
            .map((c) => effectsImpact(c.spec.abilities?.action ?? [], c)),
          ...me.battleline
            .filter((c) => c.ready && !c.stunned && inHouse(c))
            .flatMap((c) => foe.battleline.map((t) => combat(c, t))),
        ];
        delta += Math.max(0, ...opportunities) * 0.75;
      } else if (a.kind === 'unstun' && source && useful)
        delta += Math.max(0, removalValue(source)) * 0.3;
    }
    if (delta)
      reasons.push('v3: public forge-lock opportunity cost, with opponent third-key protection');
    return {
      ...original,
      score: score + delta,
      projectedKey,
      deniesKey,
      reasons,
      approximate: original.approximate || delta !== 0,
    };
  });
  return rows.sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export function forgeAwarePolicy(profile: CompetitiveProfile = 'tactical'): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankForgeAware(o, profile)[0].actionId;
  };
}
