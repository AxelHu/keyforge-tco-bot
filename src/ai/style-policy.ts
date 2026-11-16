/**
 * Bounded style variants of card-effects V3. Features describe visible opportunities,
 * never a simulated continuation, guaranteed draw, kill, or lasting restriction.
 */
import type { Action, CardView, Effect, LegalAction, Observation, Trigger } from '../contracts/observation.js';
import type { ActionAssessment, PublicActionCorrections } from './algorithm-policies.js';
import { rankCardAwareV3 } from './card-aware-v3-policy.js';
import type { Policy } from './policies.js';
import { publicPlayEndsStep } from './public-card-value.js';
import { publicTargets } from './season-utility.js';

export const STYLE_POLICY_IDS = [
  'tactical-style-cycle-v1',
  'tactical-style-engine-v1',
  'tactical-style-control-v1',
] as const;
export type StylePolicyId = (typeof STYLE_POLICY_IDS)[number];
export const STYLE_POLICY_LIMITS = Object.freeze({ maximumBaseGap: 4, maximumBonus: 4 });
const CRITICAL = 5000;
const SPECIALIZED = new Set(['unity-prism', 'sir-jaune', 'they-tell-no-tales', 'infurnace']);
const MAIN_ACTIONS = new Set<Action['kind']>([
  'play',
  'discard',
  'reap',
  'fight',
  'use',
  'unstun',
  'endTurn',
]);
const REPEAT_TRIGGERS: readonly Trigger[] = [
  'reap',
  'action',
  'omni',
  'endTurn',
  'startTurn',
  'startDrawStep',
  'afterUse',
];
const CONTROL_OPERATIONS = new Set([
  'destroy',
  'purge',
  'returnHand',
  'deckTop',
  'deckBottom',
  'stun',
  'exhaust',
  'stunExhaust',
  'foreignArchive',
]);
const finitePositive = (n: number, cap = 3): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(cap, n)) : 0;

export interface StyleFeatures {
  /** Current own-hand action / house composition, not a future refill. */
  turnover: number;
  /** Literal, unconditional draw text; does not promise a successful draw. */
  drawText: number;
  /** V3's net amber estimate, capped by the presently unfunded next-key amount. */
  amberProgress: number;
  /** Friendly creature/artifact deployment or matching-house composition. */
  deployment: number;
  /** Public recurring text on friendly assets, not projected future income. */
  recurringText: number;
  /** A currently legal use/reap of an asset with recurring text. */
  engineUse: number;
  /** V3's estimated decrease in the opponent pool; no new outcome simulation. */
  denial: number;
  /** A legal opposing-target fight already valued by V3 near its reap alternative. */
  boardPressure: number;
  /** Explicit disruption text, not a prediction that a target/filter will succeed. */
  controlText: number;
}
export type StyleGuard =
  | 'critical-baseline'
  | 'funded-opponent-third-key'
  | 'effect-or-special-decision'
  | 'specialized-sequence'
  | 'timing-sensitive-play'
  | 'none';
export interface StyleScore {
  actionId: string;
  baseScore: number;
  bonus: number;
  score: number;
  eligible: boolean;
  features: StyleFeatures;
}
export interface StylePolicyAssessment {
  policyId: StylePolicyId;
  baselineActionId: string;
  selectedActionId: string;
  guard: StyleGuard;
  /** Difference between V3 scores, not measured or proved game-value regret. */
  baseScoreGap: number;
  scores: StyleScore[];
  ranked: ActionAssessment[];
}
const emptyFeatures = (): StyleFeatures => ({
  turnover: 0,
  drawText: 0,
  amberProgress: 0,
  deployment: 0,
  recurringText: 0,
  engineUse: 0,
  denial: 0,
  boardPressure: 0,
  controlText: 0,
});

function visibleCards(o: Observation): Map<string, CardView> {
  return new Map(
    [
      ...(o.players[o.you].hand ?? []),
      ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades, ...p.discard]),
      ...o.resolving,
      ...o.promptCards,
    ].map((c) => [c.id, c]),
  );
}
function effectsFor(item: LegalAction, c: CardView | undefined): readonly Effect[] {
  if (!c) return [];
  const a = item.action;
  if (a.kind === 'play') return c.spec.abilities?.play ?? [];
  if (a.kind === 'discard') return c.spec.abilities?.scrap ?? [];
  if (a.kind === 'reap') return c.spec.abilities?.reap ?? [];
  if (a.kind === 'use') {
    // The legal menu can identify an Action vs Omni or granted ability exactly.
    if (item.useDescription) return item.useDescription.effects;
    if (a.ability !== undefined) return [];
    return c.spec.abilities?.action ?? c.spec.abilities?.omni ?? [];
  }
  return [];
}
function directDraw(effects: readonly Effect[]): number {
  return finitePositive(
    effects.reduce((sum, e) => {
      if (e.kind === 'draw' && typeof e.amount === 'number') return sum + finitePositive(e.amount);
      if (
        e.kind === 'resource' &&
        e.operation === 'draw' &&
        (!e.side || e.side === 'self') &&
        typeof e.amount === 'number'
      )
        return sum + finitePositive(e.amount);
      return sum;
    }, 0),
  );
}
function controlText(o: Observation, source: CardView, effects: readonly Effect[]): number {
  const foe = o.players[o.you === 0 ? 1 : 0];
  return finitePositive(
    effects.reduce((sum, e) => {
      if (
        (e.kind === 'steal' || e.kind === 'loseOpponent' || e.kind === 'capture') &&
        typeof e.amount === 'number' &&
        e.amount > 0 &&
        foe.amber > 0
      )
        return sum + 1;
      if (
        e.kind === 'resource' &&
        typeof e.amount === 'number' &&
        e.amount > 0 &&
        foe.amber > 0 &&
        ((e.operation === 'lose' && e.side === 'opponent') ||
          (e.operation === 'steal' && (!e.side || e.side === 'self')))
      )
        return sum + 1;
      if (e.kind === 'randomDiscard' && e.side === 'opponent' && e.amount > 0 && foe.handCount > 0)
        return sum + 1;
      if (
        (e.kind === 'target' || e.kind === 'all') &&
        e.filter.side === 'enemy' &&
        CONTROL_OPERATIONS.has(e.operation)
      ) {
        const targets = publicTargets(o, e.filter, o.you, source);
        if (targets !== null && targets.length > 0) return sum + 1;
      }
      return sum;
    }, 0),
  );
}
function recurringText(c: CardView): number {
  // Capabilities only. Conditional/gained text and future responses are not interpreted.
  const abilities = REPEAT_TRIGGERS.filter((t) => (c.spec.abilities?.[t]?.length ?? 0) > 0).length;
  const passiveDraw = (c.spec.drawBonus ?? 0) > 0 || (c.spec.globalDrawBonus ?? 0) > 0 ? 1 : 0;
  const reactions = c.spec.reactions?.length ? 1 : 0;
  return finitePositive(abilities + passiveDraw + reactions);
}
function friendlyPermanent(c: CardView): boolean {
  return (c.spec.kind === 'creature' || c.spec.kind === 'artifact') && !c.spec.entersOpponentControl;
}
function timingSensitive(o: Observation, item: LegalAction | undefined, c: CardView | undefined): boolean {
  if (item?.action.kind !== 'play' || !c) return false;
  const a = item.action;
  return !!(
    c.spec.alpha ||
    publicPlayEndsStep(o, c, a.asUpgrade) ||
    a.copy ||
    a.otherHalf ||
    a.permission !== undefined ||
    effectsFor(item, c).some(
      (e) =>
        e.kind === 'lasting' &&
        ['cardPlayDraw', 'creaturePlayGain', 'reapGain', 'actionPlayGain'].includes(e.rule),
    )
  );
}
function guardFor(
  o: Observation,
  base: ActionAssessment[],
  cards: Map<string, CardView>,
  legal: Map<string, LegalAction>,
): StyleGuard {
  if (base[0].score >= CRITICAL) return 'critical-baseline';
  const foe = o.players[o.you === 0 ? 1 : 0];
  // Conservatively preserve V3 even when a visible lock/skip may already prevent forging.
  // Several actions can be needed to defend; an individual deniesKey flag is insufficient.
  if (foe.keys.length === 2 && foe.forgeAvailable >= foe.keyCost) return 'funded-opponent-third-key';
  const housesOnly = o.legalActions.every((x) => x.action.kind === 'house');
  // Keyteki exposes the rules tide button alongside ordinary main-phase work.
  // Its Yes/No confirmation has no End Turn and still remains a special choice.
  const ordinaryTideEntry =
    o.phase === 'main' &&
    o.activePlayer === o.you &&
    o.pending === null &&
    o.legalActions.some((x) => x.action.kind === 'endTurn');
  if (
    !housesOnly &&
    (o.phase !== 'main' ||
      o.legalActions.some(
        (x) => !MAIN_ACTIONS.has(x.action.kind) && !(ordinaryTideEntry && x.action.kind === 'raiseTide'),
      ))
  )
    return 'effect-or-special-decision';
  if (
    housesOnly &&
    ((o.players[o.you].hand ?? []).some((c) => c.definition === 'unity-prism') ||
      (o.prophecies ?? []).some((p) => p.active))
  )
    return 'specialized-sequence';
  const item = legal.get(base[0].actionId);
  const a = item?.action;
  const c = a && 'card' in a ? cards.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card) : undefined;
  if (c && SPECIALIZED.has(c.definition)) return 'specialized-sequence';
  if (timingSensitive(o, item, c)) return 'timing-sensitive-play';
  return 'none';
}
function featuresFor(
  o: Observation,
  item: LegalAction,
  row: ActionAssessment,
  cards: Map<string, CardView>,
  reapScores: Map<string, number>,
): StyleFeatures {
  const f = emptyFeatures(),
    a = item.action,
    me = o.players[o.you],
    foe = o.players[o.you === 0 ? 1 : 0];
  const completeEffects = o.publicStateCoverage?.effectsComplete !== false;
  if (a.kind === 'house') {
    if (a.house === null) return f;
    const matches = (c: CardView) => (c.effective.houses ?? [c.effective.house]).includes(a.house!);
    const hand = (me.hand ?? []).filter(matches);
    const permanent = hand.filter(friendlyPermanent);
    const ready = [...me.battleline, ...me.artifacts].filter(
      (c) => c.controller === o.you && c.ready && !c.stunned && matches(c),
    );
    f.turnover = finitePositive(hand.length * 0.6, 4);
    f.drawText =
      me.deckCount + me.discard.length > 0
        ? finitePositive(hand.reduce((n, c) => n + directDraw(c.spec.abilities?.play ?? []), 0) * 0.6)
        : 0;
    f.deployment = finitePositive(permanent.length * 0.7);
    if (completeEffects) {
      f.recurringText = finitePositive(
        permanent.reduce((n, c) => n + recurringText(c), 0) * 0.45 +
          ready.reduce((n, c) => n + recurringText(c), 0) * 0.6,
      );
      f.engineUse = finitePositive(ready.filter((c) => recurringText(c) > 0).length * 0.4);
    }
    f.controlText = finitePositive(
      hand.reduce((n, c) => n + controlText(o, c, c.spec.abilities?.play ?? []), 0) * 0.65,
    );
    return f;
  }
  const c = 'card' in a ? cards.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card) : undefined;
  if (!c || c.controller !== o.you) return f;
  // No bonuses for an alternate copy/permission/composite interpretation or a specialist row.
  if (
    SPECIALIZED.has(c.definition) ||
    timingSensitive(o, item, c) ||
    ('permission' in a && a.permission !== undefined)
  )
    return f;
  const inHand = (me.hand ?? []).some((x) => x.id === c.id);
  if (inHand && a.kind === 'play') f.turnover = 1;
  if (inHand && a.kind === 'discard') f.turnover = 0.6;
  if (a.kind === 'play' && !a.asUpgrade && inHand && friendlyPermanent(c)) f.deployment = 1;
  const textKnown = inHand || completeEffects;
  if (textKnown && ['play', 'reap', 'use', 'discard'].includes(a.kind)) {
    const effects = effectsFor(item, c);
    f.drawText = me.deckCount + me.discard.length > 0 ? directDraw(effects) : 0;
    f.controlText = controlText(o, c, effects);
    if (f.deployment) f.recurringText = recurringText(c);
    if ((a.kind === 'use' || a.kind === 'reap') && recurringText(c) > 0) {
      f.engineUse = 1;
      f.recurringText = recurringText(c) * 0.5;
    }
  }
  if (['play', 'reap', 'use', 'discard', 'fight'].includes(a.kind)) {
    f.amberProgress = finitePositive(
      Math.min(row.estimatedAmber[0] - me.amber, Math.max(0, me.keyCost - me.forgeAvailable)),
    );
    f.denial = finitePositive(foe.amber - row.estimatedAmber[1]);
  }
  if (a.kind === 'fight') {
    const target = cards.get(a.target),
      reap = reapScores.get(a.card);
    if (
      target &&
      target.controller !== o.you &&
      row.score > 0 &&
      (reap === undefined || row.score >= reap - 1.5)
    )
      f.boardPressure = 1 + (completeEffects ? recurringText(target) * 0.25 : 0);
  }
  return f;
}
function styleBonus(policy: StylePolicyId, f: StyleFeatures): number {
  const n =
    policy === 'tactical-style-cycle-v1'
      ? f.turnover * 1.45 + f.drawText + f.amberProgress * 0.65
      : policy === 'tactical-style-engine-v1'
        ? f.deployment * 2.3 + f.recurringText * 0.65 + f.engineUse * 0.75 + f.amberProgress * 0.15
        : f.denial * 1.25 + f.boardPressure * 1.2 + f.controlText * 0.65;
  return finitePositive(n, STYLE_POLICY_LIMITS.maximumBonus);
}

/** Diagnostic scoring entrypoint; feature scores are not behavioral evidence. */
export function assessStylePolicy(
  o: Observation,
  policyId: StylePolicyId,
  publicCorrections: PublicActionCorrections = {},
): StylePolicyAssessment {
  if (!STYLE_POLICY_IDS.includes(policyId)) throw Error('Unknown style policy');
  if (!o.legalActions.length) throw Error('No legal decision');
  const base = rankCardAwareV3(o, publicCorrections),
    cards = visibleCards(o),
    legal = new Map(o.legalActions.map((a) => [a.id, a]));
  const guard = guardFor(o, base, cards, legal);
  const reapScores = new Map<string, number>();
  for (const r of base) {
    const a = legal.get(r.actionId)!.action;
    if (a.kind === 'reap') reapScores.set(a.card, Math.max(reapScores.get(a.card) ?? -Infinity, r.score));
  }
  const scores = base.map((r): StyleScore => {
    const eligible =
      guard === 'none' && r.score >= base[0].score - STYLE_POLICY_LIMITS.maximumBaseGap && r.score < CRITICAL;
    const features = eligible
      ? featuresFor(o, legal.get(r.actionId)!, r, cards, reapScores)
      : emptyFeatures();
    const bonus = eligible ? styleBonus(policyId, features) : 0;
    return {
      actionId: r.actionId,
      baseScore: r.score,
      bonus,
      score: bonus > 0 ? Math.min(CRITICAL - 1, r.score + bonus) : r.score,
      eligible,
      features,
    };
  });
  // Guarded decisions retain every V3 row byte-for-byte, including critical scores.
  const ranked =
    guard !== 'none'
      ? base
      : base
          .map((r, i) =>
            scores[i].bonus === 0
              ? r
              : {
                  ...r,
                  score: scores[i].score,
                  approximate: true,
                  reasons: [
                    ...r.reasons,
                    policyId + ': bounded visible style opportunity +' + scores[i].bonus.toFixed(3),
                  ],
                },
          )
          .sort((a, b) => b.score - a.score); // Stable ties retain V3 order, independent of menu order.
  const selected = ranked[0].actionId;
  return {
    policyId,
    baselineActionId: base[0].actionId,
    selectedActionId: selected,
    guard,
    baseScoreGap: base[0].score - base.find((r) => r.actionId === selected)!.score,
    scores,
    ranked,
  };
}
export function rankStylePolicy(o: Observation, policyId: StylePolicyId): ActionAssessment[] {
  return assessStylePolicy(o, policyId).ranked;
}
export function stylePolicy(policyId: StylePolicyId): Policy {
  if (!STYLE_POLICY_IDS.includes(policyId)) throw Error('Unknown style policy');
  return (o) => rankStylePolicy(o, policyId)[0].actionId;
}
