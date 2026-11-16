/**
 * Bounded public sequencing, layered over contextual single-action assessments.
 * This compares retained, currently legal second actions; it is not a referee or
 * a promise that a whole turn can be replayed without newly revealed information.
 */
import type { Action, CardView, Effect, LegalAction, Observation, Reaction } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { CompetitiveProfile } from './competitive-policy.js';
import { publicPlayCapacity } from './public-guidance-guards.js';
import { publicTargets } from './season-utility.js';
import { publicPlayEndsStep } from './public-card-value.js';

const CRITICAL = 5000;
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');
const activity = (a: Action) => ['play', 'discard', 'reap', 'fight', 'use', 'unstun'].includes(a.kind);

interface Option {
  row: ActionAssessment;
  legal: LegalAction;
  source: CardView;
  /** Rules can come from copy; consumption always belongs to the physical card. */
  physical: string;
  consumed: readonly string[];
  alpha: boolean;
  omega: boolean;
}

function visibleCards(o: Observation): Map<string, CardView> {
  const me = o.players[o.you];
  return new Map(
    [
      ...(me.hand ?? []),
      ...(me.archives ?? []),
      ...o.players.flatMap((p) => [
        ...p.battleline,
        ...p.artifacts,
        ...p.upgrades,
        ...p.discard,
        ...p.purged,
      ]),
      ...o.promptCards,
      ...o.resolving,
    ].map((c) => [c.id, c]),
  );
}

function usedTogether(a: Option, b: Option): boolean {
  return a.consumed.some((id) => b.consumed.includes(id));
}

function effectsOf(option: Option): readonly Effect[] {
  const a = option.legal.action;
  if (a.kind === 'play') return option.source.spec.abilities?.play ?? [];
  if (a.kind === 'use')
    return [
      ...(option.legal.useDescription?.effects ?? option.source.spec.abilities?.action ?? []),
      ...(option.source.spec.abilities?.afterUse ?? []),
    ];
  if (a.kind === 'reap')
    return [...(option.source.spec.abilities?.reap ?? []), ...(option.source.spec.abilities?.afterUse ?? [])];
  if (a.kind === 'fight')
    return [
      ...(option.source.spec.abilities?.beforeFight ?? []),
      ...(option.source.spec.abilities?.afterFight ?? []),
      ...(option.source.spec.abilities?.afterUse ?? []),
    ];
  return [];
}

/** Explicitly admit effects that preserve the visible second physical action.
 * Unknown hand movement, choices, house changes or binding do not become a
 * speculative continuation. Public target filters are reused, never widened.
 */
function preserves(o: Observation, first: Option, second: Option): boolean {
  const secondPlay = second.legal.action.kind === 'play';
  const target = 'target' in second.legal.action ? second.legal.action.target : undefined;
  const required = [...second.consumed, ...(target ? [target] : [])];
  const action = first.legal.action;
  if (
    ['reap', 'fight', 'use', 'unstun'].includes(action.kind) &&
    [first.source.spec, ...(first.source.gainedTextBoxes ?? [])].some((box) => box.destroyFriendlyBeforeUse)
  )
    return false;
  const timing = new Set<string>(
    action.kind === 'play'
      ? [
          'cardPlayed',
          ...(first.source.spec.kind === 'creature'
            ? ['creaturePlayed', 'creatureEntered']
            : [first.source.spec.kind === 'artifact' ? 'artifactPlayed' : 'actionBeforePlay']),
        ]
      : action.kind === 'reap'
        ? ['creatureReaped', 'creatureUsed']
        : action.kind === 'fight'
          ? ['creatureFought', 'creatureUsed']
          : action.kind === 'use'
            ? ['creatureUsed', 'artifactUsed']
            : action.kind === 'discard'
              ? ['handDiscarded']
              : [],
  );
  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  // Unmodeled public responses must not certify a retained card or surviving
  // engine. Admit only simple responses that do not move or alter another card.
  for (const c of board)
    for (const box of [c.spec, ...(c.gainedTextBoxes ?? [])])
      for (const r of box.reactions ?? []) {
        if (!timing.has(r.event)) continue;
        if (
          (r.side === 'friendly' && c.controller !== o.you) ||
          (r.side === 'enemy' && c.controller === o.you)
        )
          continue;
        if (
          !r.effects.every(
            (e) =>
              (e.kind === 'gain' || e.kind === 'draw' || e.kind === 'chains') &&
              typeof e.amount === 'number' &&
              e.amount >= 0,
          )
        )
          return false;
      }
  if (first.source.gainedTextBoxes?.length || first.source.spec.conditionalAbilities?.length) return false;
  const safe = (effects: readonly Effect[], depth = 0): boolean => {
    if (depth > 4) return false;
    return effects.every((e) => {
      if (['gain', 'steal', 'loseOpponent', 'draw', 'chains', 'finishAction'].includes(e.kind)) return true;
      if (e.kind === 'resource') return ['gain', 'lose', 'steal', 'draw', 'chains'].includes(e.operation);
      if (e.kind === 'lasting')
        return ['cardPlayDraw', 'creaturePlayGain', 'reapGain', 'keyCost', 'actionPlayGain'].includes(e.rule);
      if (e.kind === 'if') return safe(e.then, depth + 1) && safe(e.otherwise ?? [], depth + 1);
      if (e.kind === 'self')
        return (
          !e.after &&
          (!['purge', 'destroy', 'returnHand'].includes(e.operation) || first.physical !== target) &&
          ['purge', 'destroy', 'returnHand', 'heal', 'power', 'ward', 'ready'].includes(e.operation)
        );
      if (e.kind === 'sacrificeSelf') return first.physical !== target;
      if (e.kind === 'healSelf') return true;
      if (e.kind === 'target' || e.kind === 'all') {
        if (e.after) return false;
        const targets = publicTargets(o, e.filter, o.you, first.source);
        if (targets === null) return false;
        if (['heal', 'power', 'ward'].includes(e.operation)) return !targets.some((c) => c.id === target);
        if (
          e.operation === 'returnHand' &&
          targets.every((c) => o.players.some((p) => p.discard.some((d) => d.id === c.id)))
        )
          return true;
        return (
          !targets.some((c) => required.includes(c.id)) &&
          ['damage', 'destroy', 'purge', 'returnHand', 'archive', 'stun', 'exhaust', 'ready'].includes(
            e.operation,
          )
        );
      }
      if (e.kind === 'randomArchive' || e.kind === 'randomDiscard') return !secondPlay;
      return false;
    });
  };
  return safe(effectsOf(first));
}

function continuationAllowed(
  o: Observation,
  first: Option,
  second: Option,
  playRemaining: number | null,
): boolean {
  if (first.omega || second.alpha || usedTogether(first, second)) return false;
  const a = first.legal.action,
    b = second.legal.action;
  const hand = o.players[o.you].hand ?? [];
  if (
    o.turn === 1 &&
    hand.some((c) => c.id === first.physical) &&
    hand.some((c) => c.id === second.physical) &&
    ['play', 'discard'].includes(a.kind) &&
    ['play', 'discard'].includes(b.kind)
  )
    return false;
  if (a.kind === 'fight' && (second.consumed.includes(a.target) || ('target' in b && b.target === a.target)))
    return false;
  const own = o.players[o.you].amber,
    enemy = o.players[o.you === 0 ? 1 : 0].amber;
  if (second.row.estimatedAmber[1] < enemy && first.row.estimatedAmber[1] !== enemy) return false;
  if (second.row.estimatedAmber[0] < own && first.row.estimatedAmber[0] < own) return false;
  if (b.kind === 'play') {
    if (b.permission !== undefined || second.source.spec.playCondition) return false;
    const spent = a.kind === 'play' ? 1 : 0;
    if (playRemaining !== null && playRemaining <= spent) return false;
    const cost = Math.max(second.source.spec.playAmberCost ?? 0, second.source.spec.minAmberToPlay ?? 0);
    if (first.row.estimatedAmber[0] < cost) return false;
    if (a.kind === 'play') {
      if (first.source.spec.prohibitOwnCreatures && second.source.spec.kind === 'creature') return false;
      const boxes = [...o.players.flatMap((p) => [...p.battleline, ...p.artifacts]), first.source];
      if (first.source.spec.kind === second.source.spec.kind && boxes.some((c) => c.spec.onePlayPerType))
        return false;
      if (second.source.spec.kind === 'creature' && boxes.some((c) => c.spec.creaturePlayLimits?.length))
        return false;
    }
  }
  return preserves(o, first, second);
}

interface TriggerValue {
  /** Already included in contextual single-card value; removing this play loses it. */
  prepaid: number;
  /** A newly deployed permanent engine's one visible trigger, not yet in its base row. */
  extra: number;
}
const reactionFields = new Set([
  'event',
  'side',
  'other',
  'ownTurn',
  'house',
  'cardKind',
  'subjectTrait',
  'effects',
]);
function matchesReaction(r: Reaction, c: CardView): boolean {
  if (Object.keys(r).some((k) => !reactionFields.has(k))) return false;
  if (r.side !== 'friendly' || !['cardPlayed', 'creaturePlayed', 'artifactPlayed'].includes(r.event))
    return false;
  if (r.event === 'creaturePlayed' && c.spec.kind !== 'creature') return false;
  if (r.event === 'artifactPlayed' && c.spec.kind !== 'artifact') return false;
  if (r.cardKind && r.cardKind !== c.spec.kind) return false;
  if (r.house && !(c.effective.houses ?? [c.effective.house]).includes(r.house)) return false;
  return !r.subjectTrait || !!c.spec.traits?.includes(r.subjectTrait);
}

/** Only simple, public liquid gain/draw triggers are admitted. Unknown replacements
 * and conditional/neighbor reactions add no invented sequencing benefit.
 */
function triggerValue(o: Observation, engine: Option, next: Option): TriggerValue {
  const value = { prepaid: 0, extra: 0 };
  if (engine.legal.action.kind !== 'play' || next.legal.action.kind !== 'play') return value;
  const me = o.players[o.you],
    foe = o.players[o.you === 0 ? 1 : 0];
  const available = Math.max(0, me.deckCount + me.discard.length);
  const draw = (n: number) => Math.min(available, Math.max(0, n)) * 1.2;
  for (const e of engine.source.spec.abilities?.play ?? []) {
    if (
      e.kind === 'lasting' &&
      e.rule === 'cardPlayDraw' &&
      e.duration === 'turn' &&
      (!e.side || e.side === 'self') &&
      !e.countFilter &&
      (!e.house || e.house === next.source.effective.house) &&
      Number.isFinite(e.amount) &&
      (e.amount ?? 0) > 0
    )
      value.prepaid += draw(e.amount!);
  }
  if (
    !['creature', 'artifact'].includes(engine.source.spec.kind) ||
    engine.source.spec.entersOpponentControl ||
    engine.source.spec.destroyIfFlank ||
    (engine.source.spec.destroyWithoutEnemy && !foe.battleline.length) ||
    effectsOf(engine).some(
      (e) =>
        e.kind === 'sacrificeSelf' ||
        (e.kind === 'self' && ['destroy', 'purge', 'returnHand', 'archive'].includes(e.operation)),
    )
  )
    return value;
  const intercepted =
    [...foe.battleline, ...foe.artifacts].some((c) => c.spec.capturesIncomingAmber) ||
    o.lasting.some((e) => e.rule === 'poolIncomeBecomesTokens' && e.turn === o.turn && e.appliesTo === o.you);
  for (const r of engine.source.spec.reactions ?? []) {
    if (!matchesReaction(r, next.source)) continue;
    let trigger = 0,
      admitted = true;
    for (const e of r.effects) {
      if ((e.kind === 'gain' || e.kind === 'draw') && typeof e.amount === 'number' && e.amount >= 0)
        trigger += e.kind === 'gain' ? (intercepted ? 0 : e.amount * 3.5) : draw(e.amount);
      else if (
        e.kind === 'resource' &&
        (!e.side || e.side === 'self') &&
        typeof e.amount === 'number' &&
        e.amount >= 0 &&
        ['gain', 'draw'].includes(e.operation)
      )
        trigger += e.operation === 'gain' ? (intercepted ? 0 : e.amount * 3.5) : draw(e.amount);
      else admitted = false;
    }
    if (admitted) value.extra += trigger;
  }
  return value;
}

/** A deliberately narrow lower bound for declining an Alpha+Omega terminal:
 * one ordinary, liquid reap per distinct ready creature. No additional reap,
 * after-use, granted, conditional or reaction text is silently treated as empty.
 */
function independentReaps(o: Observation, options: readonly Option[]): Option[] {
  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  if (
    o.nextCreatureUseRestriction ||
    o.cardEffects.length ||
    o.lasting.some(
      (e) =>
        e.turn === o.turn &&
        e.appliesTo === o.you &&
        (/reap/i.test(e.rule) || e.rule === 'poolIncomeBecomesTokens' || e.rule === 'shareFightReap'),
    )
  )
    return [];
  for (const c of board) {
    for (const box of [c.spec, ...(c.gainedTextBoxes ?? [])]) {
      if (
        box.capturesIncomingAmber ||
        box.capturesReapIncome ||
        box.reapIncomeChosenCapture ||
        box.nextUseAlternatesFightReap ||
        box.reapRestrictions?.length ||
        box.prohibitsEnemyReap ||
        box.prohibitsNeighborReap ||
        box.reactions?.some((r) => r.event === 'creatureReaped' || r.event === 'creatureUsed') ||
        box.grantsAbilities?.some((g) => g.abilities.reap?.length || g.abilities.afterUse?.length)
      )
        return [];
    }
  }
  const byPhysical = new Map<string, Option>();
  for (const option of options) {
    const c = option.source;
    if (
      option.legal.action.kind !== 'reap' ||
      !c.ready ||
      c.stunned ||
      c.spec.cannotReap ||
      !o.players[o.you].battleline.some((x) => x.id === option.physical) ||
      c.spec.reapSourceConditions?.length
    )
      continue;
    const textBoxes = [c.spec, ...(c.gainedTextBoxes ?? [])];
    const boxes = [
      ...textBoxes,
      ...board.filter((x) => x.attachedTo === c.id).flatMap((x) => (x.spec.upgrade ? [x.spec.upgrade] : [])),
    ];
    if (
      textBoxes.some((box) => box.destroyFriendlyBeforeUse) ||
      boxes.some((box) => box.abilities?.reap?.length || box.abilities?.afterUse?.length) ||
      textBoxes.some((box) =>
        box.conditionalAbilities?.some((g) => g.abilities.reap?.length || g.abilities.afterUse?.length),
      )
    )
      continue;
    const old = byPhysical.get(option.physical);
    if (!old || compare(option.row, old.row) < 0) byPhysical.set(option.physical, option);
  }
  return [...byPhysical.values()];
}

/**
 * A maximum of one retained second action is credited to each first action.
 * Taking a maximum (never a sum) makes fights, reaps, entry flanks, copied faces,
 * multiple Alpha cards and multiple terminal Omegas mutually exclusive.
 *
 * Rows >= 5000 remain untouched and ordinary rows are capped below that boundary.
 * No names, ratings, hidden hands, deck identities, simulator state or randomness.
 */
export function adjustCardAwareSequence(
  o: Observation,
  rows: readonly ActionAssessment[],
  profile: CompetitiveProfile = 'tactical',
): ActionAssessment[] {
  const unchanged = () => [...rows].sort(compare);
  if (
    o.phase !== 'main' ||
    o.pending ||
    o.activePlayer !== o.you ||
    o.publicStateCoverage?.effectsComplete === false ||
    o.publicStateCoverage?.turnHistoryComplete === false
  )
    return unchanged();
  const capacity = publicPlayCapacity(o);
  if (!capacity.known) return unchanged();
  const cards = visibleCards(o),
    legal = new Map(o.legalActions.map((a) => [a.id, a]));
  const options: Option[] = [];
  for (const row of rows) {
    const item = legal.get(row.actionId);
    if (
      !item ||
      !activity(item.action) ||
      !('card' in item.action) ||
      row.score <= 0 ||
      row.score >= CRITICAL
    )
      continue;
    const a = item.action;
    const source = cards.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card);
    if (!source) continue;
    options.push({
      row,
      legal: item,
      source,
      physical: a.card,
      consumed: a.kind === 'play' && a.otherHalf ? [a.card, a.otherHalf] : [a.card],
      alpha: a.kind === 'play' && !!source.spec.alpha,
      omega: a.kind === 'play' && publicPlayEndsStep(o, source, !!a.asUpgrade),
    });
  }
  // Only the best row of each physically identical kind/rules face is a second
  // action candidate. No number of target/entry variants creates extra work.
  const candidates = new Map<string, Option>();
  for (const option of options) {
    const a = option.legal.action;
    const key = option.physical + ':' + a.kind + ':' + (a.kind === 'play' ? (a.copy ?? '') : '');
    const old = candidates.get(key);
    if (!old || compare(option.row, old.row) < 0) candidates.set(key, option);
  }
  const future = [...candidates.values()];
  const alphaOmega = options.some((x) => x.alpha && x.omega);
  const credits = new Map<string, { amount: number; reason: string }>();
  const credit = (first: Option, amount: number, reason: string) => {
    if (!(amount > 0) || !Number.isFinite(amount)) return;
    const old = credits.get(first.row.actionId);
    if (!old || amount > old.amount || (amount === old.amount && reason < old.reason))
      credits.set(first.row.actionId, { amount, reason });
  };
  const label = (x: Option) => x.source.spec.name + ' [' + x.physical + ']';
  for (const first of options) {
    if (first.omega) continue;
    for (const second of future) {
      if (!continuationAllowed(o, first, second, capacity.remaining)) continue;
      const retained = second.row.score;
      if (first.alpha)
        credit(first, retained, 'Alpha window: retain ' + label(second) + ' after ' + label(first));
      else if (second.omega)
        credit(first, retained, 'Omega terminal: retain ' + label(second) + ' after this useful action');
      else if (alphaOmega)
        credit(first, retained, 'Alpha+Omega alternative: two distinct public actions instead of ending now');
      const trigger = triggerValue(o, first, second);
      if (trigger.prepaid + trigger.extra > 0) {
        credit(
          first,
          retained + trigger.extra,
          'engine before ' +
            label(second) +
            ': preserve ' +
            (trigger.prepaid + trigger.extra).toFixed(2) +
            ' trigger utility; retained second action ' +
            retained.toFixed(2),
        );
        if (continuationAllowed(o, second, first, capacity.remaining))
          credit(
            second,
            Math.max(0, first.row.score - trigger.prepaid),
            'engine after this play: its earlier trigger is unavailable (' +
              trigger.prepaid.toFixed(2) +
              ' prepaid utility lost)',
          );
      }
    }
  }
  if (alphaOmega) {
    const reaps = independentReaps(o, options);
    // 3.9 is the base evaluator's one liquid amber (3.5) plus ordinary use (0.4).
    // Style discounts are retained; no unmodeled extra effect enters the bound.
    const value = (x: Option) => Math.min(3.9, x.row.score);
    const total = reaps.reduce((n, x) => n + value(x), 0);
    for (const first of reaps)
      credit(
        first,
        total - value(first),
        'Alpha+Omega alternative: ' +
          reaps.length +
          ' independent plain reaps, public lower bound ' +
          total.toFixed(2),
      );
  }
  return rows
    .map((row) => {
      if (row.score >= CRITICAL) return row;
      const added = credits.get(row.actionId);
      if (!added) return row;
      const score = Math.min(CRITICAL - 1, row.score + added.amount);
      if (score === row.score) return row;
      return {
        ...row,
        score,
        approximate: true,
        reasons: [
          ...row.reasons,
          'card-aware sequence/' +
            profile +
            ': ' +
            added.reason +
            '; bounded continuation credit ' +
            (score - row.score).toFixed(2),
        ],
      };
    })
    .sort(compare);
}
