/** Versioned, bounded follow-up improvements; every input is a legal player observation. */
import { rankForgeAware } from './forge-lock-policy.js';
import type { CompetitiveProfile } from './competitive-policy.js';
import type { ActionAssessment, AlgorithmFeatures } from './algorithm-policies.js';
import type { CardView, Effect, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
export const LADDER_FAMILIES = ['tempo', 'tactical', 'economy'] as const;
export type LadderFamily = (typeof LADDER_FAMILIES)[number];
export const LADDER_VARIANTS = ['sequence', 'income', 'reserve', 'threat', 'balanced'] as const;
export type LadderVariant = (typeof LADDER_VARIANTS)[number];
export const LADDER_POLICY_IDS = LADDER_FAMILIES.flatMap((p) =>
  LADDER_VARIANTS.map((v) => `${p}-ladder-${v}`),
);
interface Impact {
  gain: number;
  steal: number;
  capture: number;
  draw: number;
  remove: number;
}
function impact(effects: readonly Effect[], depth = 0): Impact {
  const n: Impact = { gain: 0, steal: 0, capture: 0, draw: 0, remove: 0 };
  if (depth > 4) return n;
  for (const e of effects) {
    if (
      (e.kind === 'gain' || e.kind === 'steal' || e.kind === 'capture' || e.kind === 'draw') &&
      typeof e.amount === 'number'
    )
      n[e.kind] += Math.max(0, e.amount);
    else if (
      e.kind === 'resource' &&
      (!e.side || e.side === 'self') &&
      typeof e.amount === 'number' &&
      ['gain', 'steal', 'draw'].includes(e.operation)
    )
      n[e.operation as 'gain' | 'steal' | 'draw'] += Math.max(0, e.amount);
    else if (
      e.kind === 'target' &&
      ['destroy', 'purge', 'returnHand', 'stun', 'exhaust'].includes(e.operation) &&
      e.filter.side === 'enemy'
    )
      n.remove += 1;
    else if (
      e.kind === 'all' &&
      ['destroy', 'purge', 'returnHand', 'stun', 'exhaust'].includes(e.operation) &&
      e.filter.side === 'enemy'
    )
      n.remove += 2;
    else if (e.kind === 'recur' && typeof e.count === 'number') {
      const v = impact(e.effects, depth + 1);
      for (const k of Object.keys(n) as (keyof Impact)[]) n[k] += v[k] * Math.min(5, Math.max(0, e.count));
    }
    // Conditional, random, optional targeting and nonlinear effects stay uncredited rather than fabricated.
  }
  return n;
}
function valueThreat(c: CardView): number {
  const events = [
    ...(c.spec.abilities?.reap ?? []),
    ...(c.spec.abilities?.action ?? []),
    ...(c.spec.abilities?.afterFight ?? []),
  ];
  const x = impact(events);
  return Math.min(
    7,
    x.gain * 0.65 +
      x.steal * 1.3 +
      x.capture * 0.35 +
      x.draw * 0.65 +
      x.remove * 0.6 +
      (c.spec.opponentKeyTax ?? 0) * 0.6 +
      (c.spec.opponentDrawPenalty ?? 0) * 0.6 +
      Number(!!c.spec.capturesIncomingAmber) * 2.3 +
      Number(!!c.spec.capturesReapIncome) * 2.1 +
      Number(!!c.spec.blocksOpponentBonusIcons) * 2.0 +
      Number(!!c.spec.prohibitOwnCreatures) * -1,
  );
}
export function rankLadder(
  o: Observation,
  family: LadderFamily,
  variant: LadderVariant,
  corrections: AlgorithmFeatures = {},
): ActionAssessment[] {
  if (!LADDER_FAMILIES.includes(family) || !LADDER_VARIANTS.includes(variant))
    throw Error('Unknown ladder family/variant');
  const rows = rankForgeAware(o, family as CompetitiveProfile, corrections),
    me = o.players[o.you],
    foe = o.players[1 - o.you];
  const legal = new Map(o.legalActions.map((x) => [x.id, x]));
  const visible = new Map(
    [
      ...o.players.flatMap((p) => [
        ...(p.hand ?? []),
        ...(p.archives ?? []),
        ...p.battleline,
        ...p.artifacts,
        ...p.upgrades,
        ...p.discard,
      ]),
      ...o.promptCards,
      ...o.resolving,
    ].map((c) => [c.id, c]),
  );
  const sequence = variant === 'sequence' || variant === 'balanced';
  const income = variant === 'income' || variant === 'balanced';
  const reserve = variant === 'reserve' || variant === 'balanced';
  const threat = variant === 'threat' || variant === 'balanced';
  const need = Math.max(0, me.keyCost - me.forgeAvailable);
  const danger =
    foe.keys.length === 2 &&
    !foe.forgeBlocked &&
    foe.skipForgeTurn !== o.turn + 1 &&
    foe.forgeAvailable >= foe.keyCost;
  const choices = rows.filter((r) => {
    const a = legal.get(r.actionId)!.action;
    return ['play', 'use', 'fight', 'reap', 'unstun'].includes(a.kind) && r.score > 0;
  });
  const advertisedControl = Math.min(
    3,
    [...foe.battleline, ...foe.artifacts].reduce(
      (n, c) =>
        n + impact([...(c.spec.abilities?.reap ?? []), ...(c.spec.abilities?.action ?? [])]).steal * 0.5,
      0,
    ),
  );
  return rows
    .map((row) => {
      const entry = legal.get(row.actionId)!,
        a = entry.action;
      if (row.score >= 5000) return row; // Never replace a recognized win or immediate third-key denial.
      const source = 'card' in a ? visible.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card) : undefined;
      let change = 0;
      const reasons = [...row.reasons];
      if (sequence && a.kind === 'play' && source) {
        if (source.spec.alpha && row.score > 0) change += family === 'tempo' ? 5 : 3.5;
        if (source.spec.omega) {
          const other = choices
            .filter((r) => r.actionId !== row.actionId)
            .filter((r) => {
              const x = legal.get(r.actionId)!.action;
              return x.kind !== 'play' || !visible.get(x.card)?.spec.omega;
            });
          if (other.length)
            change -= Math.min(30, other.reduce((n, r) => n + Math.max(0, r.score), 0) * 0.8 + 4);
        }
      }
      if (income && a.kind === 'house' && !danger) {
        const h = a.house!,
          inHouse = (c: CardView) => (c.effective.houses ?? [c.effective.house]).includes(h);
        const hand = [...(me.hand ?? []), ...(me.archives ?? []).filter((c) => c.owner === o.you)].filter(
          inHouse,
        );
        const ready = me.battleline.filter((c) => c.ready && !c.stunned && inHouse(c) && !c.spec.cannotReap);
        const boardLock = [...foe.battleline, ...foe.artifacts].some(
          (c) => c.spec.capturesIncomingAmber || c.spec.capturesReapIncome,
        );
        const generation =
          hand.reduce((n, c) => {
            const v = impact(c.spec.abilities?.play ?? []);
            return n + v.gain + Math.min(foe.amber, v.steal);
          }, 0) +
          ready.reduce((n, c) => {
            const v = impact(c.spec.abilities?.reap ?? []);
            return n + v.gain + Math.min(foe.amber, v.steal);
          }, 0);
        change +=
          Math.min(generation, need + advertisedControl + 2) *
          (family === 'economy' ? 2.3 : family === 'tempo' ? 1.2 : 1.7);
        // A ready board whose base reap is intercepted is not a liquid economy engine.
        if (boardLock) change -= ready.length * 1.4;
      }
      if (reserve && !danger) {
        const gained = Math.max(0, row.estimatedAmber[0] - me.amber);
        if (family === 'economy') {
          // Retain efficient funding as its identity, but bank a small public theft buffer instead
          // of punishing every amber beyond today's exact key cost equally.
          change += Math.min(Math.max(0, gained - need), advertisedControl + 1) * 0.8;
        }
        if (a.kind === 'play' && source) {
          const v = impact(source.spec.abilities?.play ?? []);
          // Capture is temporary control, not permanent loss/steal. Immediate third-key denials
          // were protected above; don't overpay for reversible captures during ordinary development.
          if (v.capture > 0 && v.steal === 0)
            change -=
              Math.min(v.capture, foe.amber) * (family === 'economy' ? 1.4 : family === 'tempo' ? 0.7 : 0.4);
        }
      }
      if (threat && a.kind === 'fight' && source) {
        const target = visible.get(a.target);
        if (
          target &&
          !target.warded &&
          !target.spec.invulnerable &&
          !target.spec.cannotBeDamagedCondition &&
          !source.spec.noCombatDamage
        ) {
          const elusive =
            target.effective.keywords.includes('elusive') &&
            !target.elusiveUsed &&
            !source.spec.ignoreTauntElusive;
          const damage = Math.max(
            0,
            source.effective.power - Math.max(0, target.effective.armor - target.armorUsed),
          );
          if (
            !elusive &&
            (damage >= target.effective.power - target.damage ||
              (damage > 0 && source.effective.keywords.includes('poison')))
          )
            change += valueThreat(target) * (family === 'tactical' ? 1.3 : family === 'tempo' ? 0.8 : 0.55);
        }
      }
      if (threat && a.kind === 'select' && o.pending?.intent?.kind === 'target-operation') {
        const target = visible.get(a.target);
        if (
          target &&
          target.controller !== o.you &&
          ['destroy', 'purge', 'returnHand'].includes(o.pending.intent.operation)
        )
          change += valueThreat(target) * (family === 'tactical' ? 1.3 : 0.6);
      }
      if (threat && a.kind === 'play' && source && source.spec.kind === 'creature')
        change += valueThreat(source) * (family === 'tempo' ? 0.5 : 0.25);
      if (change)
        reasons.push(
          'ladder-' +
            family +
            '/' +
            variant +
            ': bounded public-information correction; original profile retained',
        );
      return { ...row, score: row.score + change, reasons, approximate: row.approximate || change !== 0 };
    })
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export function ladderPolicy(family: LadderFamily, variant: LadderVariant): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankLadder(o, family, variant)[0].actionId;
  };
}
