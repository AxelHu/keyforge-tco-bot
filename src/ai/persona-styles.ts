import { cardSemanticFeatures } from '../knowledge/semantic-features.js';
import { rankAlgorithm, type ActionAssessment } from './algorithm-policies.js';
import type { Observation } from '../contracts/observation.js';
export const STYLES = ['balanced', 'race', 'control', 'develop', 'combo'] as const;
export type Style = (typeof STYLES)[number];
export const PERSONAS = ['balanced', 'racer', 'warden', 'builder', 'planner'] as const;
export type Persona = (typeof PERSONAS)[number];
export type Mood = 'steady' | 'pressured' | 'confident';
export const STYLE_TEXT: Record<Style, string> = {
  balanced:
    'Balance amber generation, board development and hand turnover. Do not force expensive low-value plays.',
  race: 'Prefer immediate amber generation and key-race progress; accept some remaining opposing board pressure.',
  control:
    'Prefer reducing meaningful opposing board/amber pressure; accept slower immediate gains, not aimless damage.',
  develop:
    'Prefer putting useful creatures/artifacts into play and cycling hand; accept less immediate reaping.',
  combo:
    'Prefer useful draw/recovery and retaining concretely useful combo value; never wait indefinitely for unknown cards.',
};
export const PERSONA_TEMPLATES: Record<
  Persona,
  { label: string; description: string; home: Style; weights: Record<Style, number> }
> = {
  balanced: {
    label: '均衡型',
    description:
      'A pragmatic, steady card player. Balance progress, control and development. Do not abruptly invent a new personality.',
    home: 'balanced',
    weights: { balanced: 0.4, race: 0.15, control: 0.15, develop: 0.2, combo: 0.1 },
  },
  racer: {
    label: '竞速型',
    description:
      'An proactive key racer, eager to turn opportunities into amber. Accept limited board pressure but do not ignore a visible immediate loss.',
    home: 'race',
    weights: { balanced: 0.1, race: 0.6, control: 0.08, develop: 0.17, combo: 0.05 },
  },
  warden: {
    label: '控制型',
    description:
      'A patient, protective controller. Value disrupting important enemy plans and preserving useful units, without giving up normal development.',
    home: 'control',
    weights: { balanced: 0.1, race: 0.08, control: 0.6, develop: 0.17, combo: 0.05 },
  },
  builder: {
    label: '展开型',
    description:
      'A constructive board builder. Prefer deploying a useful active board and refreshing the hand, not hoarding cards for no concrete benefit.',
    home: 'develop',
    weights: { balanced: 0.1, race: 0.13, control: 0.12, develop: 0.6, combo: 0.05 },
  },
  planner: {
    label: '组合型',
    description:
      'A deliberate combo/value player. Appreciate draw and recovery plus specific future combinations, but do not sacrifice obvious current wins for speculative value.',
    home: 'combo',
    weights: { balanced: 0.15, race: 0.1, control: 0.1, develop: 0.15, combo: 0.5 },
  },
};
export const MOOD_TEXT: Record<Mood, string> = {
  steady: 'Steady: follow the established personality; no exceptional public setback or lead was detected.',
  pressured:
    'Under pressure: a key deficit, immediate third-key threat or loss of multiple visible units encourages stabilization. This is a bounded shift, not panic or a new identity.',
  confident:
    'Confident: ahead in forged keys without a detected immediate third-key threat. Favor converting the lead into progress without ignoring control.',
};
export function styleWeights(persona: Persona, mood: Mood): Record<Style, number> {
  const w = { ...PERSONA_TEMPLATES[persona].weights };
  if (mood === 'pressured') {
    w.control += 0.45;
    w.balanced += 0.08;
  }
  if (mood === 'confident') {
    w.race += 0.45;
    w.develop += 0.04;
  }
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(STYLES.map((k) => [k, w[k] / sum])) as Record<Style, number>;
}
function priority(score: number) {
  return score >= 100000 ? 3 : score >= 7000 ? 2 : score >= 5000 ? 1 : 0;
}
export interface StyleRanking {
  style: Style;
  actionId: string;
  baselineActionId: string;
  baselineScore: number;
  selectedBaseScore: number;
  admissible: string[];
  priorityBand: number;
  estimatedRegret: number;
  ranked: { actionId: string; score: number; styleBonus: number }[];
}
/** Bounded stylistic tilt on one common tactical evaluator. Not a safety/optimality proof. */
export function rankStyled(o: Observation, style: Style, foundation?: ActionAssessment[]): StyleRanking {
  if (!STYLES.includes(style)) throw new Error('Unknown style');
  const base = foundation ?? rankAlgorithm(o, 'tactical-v1'),
    best = base[0];
  const me = o.players[o.you],
    foe = o.players[o.you === 0 ? 1 : 0];
  // An immediate opponent third-key threat can require several ordered moves: no single move
  // need have the evaluator's deniesKey flag. Preserve the baseline's whole decision policy
  // while that public threat remains, not just actions recognized as single-step wins/denials.
  // This is non-degradation relative to that baseline, NOT a proof the baseline finds all defenses.
  const emergency =
    foe.keys.length === 2 &&
    foe.forgeAvailable >= foe.keyCost &&
    foe.skipForgeTurn !== o.turn + 1 &&
    !foe.artifacts.some((c) => c.spec.skipForgeStep);
  const band = emergency ? 4 : priority(best.score);
  const candidates = emergency
    ? [best]
    : base.filter((x) => priority(x.score) === band && x.score >= best.score - 3);
  const cards = [
    ...(me.hand ?? []),
    ...(me.archives ?? []),
    ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades, ...p.discard]),
    ...o.resolving,
    ...o.promptCards,
  ];
  function bonus(x: ActionAssessment) {
    if (style === 'balanced' || band > 0) return 0;
    const a = o.legalActions.find((a) => a.id === x.actionId)!.action;
    const card = 'card' in a ? cards.find((c) => c.id === a.card) : undefined;
    if (a.kind === 'house') {
      const hand = (me.hand ?? []).filter((c) => c.effective.house === a.house);
      const ready = me.battleline.filter((c) => c.effective.house === a.house && c.ready && !c.stunned);
      if (style === 'race')
        return Math.min(2.8, ready.length * 0.65 + hand.reduce((n, c) => n + c.spec.amber * 0.45, 0));
      if (style === 'develop')
        return Math.min(
          2.8,
          hand.length * 0.55 + hand.filter((c) => c.spec.kind === 'creature').length * 0.35,
        );
      if (style === 'control')
        return Math.min(
          2.8,
          hand.filter((c) => {
            const semantic = cardSemanticFeatures(c.spec);
            return semantic.amberControl || semantic.boardControl;
          }).length * 0.65,
        );
      return Math.min(
        2.8,
        hand.filter((c) => {
          const semantic = cardSemanticFeatures(c.spec);
          return semantic.draw || semantic.archive || semantic.recover || semantic.forge;
        }).length * 0.65,
      );
    }
    if (style === 'race')
      return Math.min(2.8, Math.max(0, x.estimatedAmber[0] - me.amber) * 0.8 + (a.kind === 'reap' ? 0.5 : 0));
    if (style === 'control')
      return Math.min(
        2.8,
        Math.max(0, foe.amber - x.estimatedAmber[1]) * 0.8 + (a.kind === 'fight' && x.score > 0 ? 1.2 : 0),
      );
    if (style === 'develop')
      return a.kind === 'play'
        ? card?.spec.kind === 'creature'
          ? 2
          : card?.spec.kind === 'artifact'
            ? 1.2
            : 0.3
        : a.kind === 'discard'
          ? 0.25
          : 0;
    if (!card || !['play', 'use', 'reap'].includes(a.kind)) return 0;
    const semantic = cardSemanticFeatures(card.spec, a.kind === 'play' ? 'play' : 'use');
    return semantic.draw || semantic.archive || semantic.recover || semantic.forge ? 1.6 : 0;
  }
  const ranked = candidates
    .map((x) => {
      const styleBonus = bonus(x);
      return { actionId: x.actionId, score: x.score + styleBonus, styleBonus };
    })
    .sort((a, b) => b.score - a.score); // Stable ties retain the tactical base ordering.
  const chosen = ranked[0];
  return {
    style,
    actionId: chosen.actionId,
    baselineActionId: best.actionId,
    baselineScore: best.score,
    selectedBaseScore: base.find((x) => x.actionId === chosen.actionId)!.score,
    admissible: candidates.map((x) => x.actionId),
    priorityBand: band,
    estimatedRegret: best.score - base.find((x) => x.actionId === chosen.actionId)!.score,
    ranked,
  };
}
