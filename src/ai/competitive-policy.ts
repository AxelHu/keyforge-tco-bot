import { cardSemanticFeatures } from '../knowledge/semantic-features.js';
/** Observation-only candidate agents. No simulator state, shuffle seed, deck rating or model calls. */
import {
  assessAlgorithm,
  houseWork,
  type ActionAssessment,
  type AlgorithmFeatures,
} from './algorithm-policies.js';
import type { CardView, Observation } from '../contracts/observation.js';
import type { Policy } from './policies.js';
export const COMPETITIVE_PROFILES = ['tactical', 'tempo', 'economy', 'race', 'control', 'adaptive'] as const;
export type CompetitiveProfile = (typeof COMPETITIVE_PROFILES)[number];
const featureSet = { physicalBonuses: true, multipleHouses: true, targetIntent: true } as const;
export function rankCompetitive(
  o: Observation,
  profile: CompetitiveProfile = 'tactical',
  corrections: AlgorithmFeatures = {},
): ActionAssessment[] {
  const features = { ...featureSet, ...corrections };
  if (!COMPETITIVE_PROFILES.includes(profile)) throw Error('Unknown competitive profile');
  const me = o.players[o.you],
    foe = o.players[1 - o.you];
  const danger =
    foe.keys.length === 2 &&
    foe.forgeAvailable >= foe.keyCost &&
    foe.skipForgeTurn !== o.turn + 1 &&
    !foe.artifacts.some((c) => c.spec.skipForgeStep);
  const mode = profile === 'tempo' && !danger ? 'tempo-v1' : 'tactical-v1';
  const cards = new Map<string, CardView>(
    [
      ...(me.hand ?? []),
      ...(me.archives ?? []),
      ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.discard, ...p.upgrades]),
      ...o.promptCards,
      ...o.resolving,
    ].map((c) => [c.id, c]),
  );
  const rows = o.legalActions.map((item) => {
    const r = assessAlgorithm(o, item.id, mode, features),
      a = item.action;
    if (r.score >= 5000) return r; // Preserve recognized immediate win/funding/denial priority.
    let delta = 0;
    if (a.kind === 'house' && !danger) {
      if (profile === 'race')
        delta =
          me.battleline.filter(
            (c) => c.ready && !c.stunned && (c.effective.houses ?? [c.effective.house]).includes(a.house!),
          ).length * 0.45;
      if (profile === 'control')
        delta =
          (me.hand ?? []).filter((c) => {
            if (!(c.effective.houses ?? [c.effective.house]).includes(a.house!)) return false;
            const semantic = cardSemanticFeatures(c.spec);
            return semantic.amberControl || semantic.boardControl;
          }).length * 0.4;
    }
    if (a.kind === 'play') {
      const c = cards.get(a.copy ?? a.card);
      if (c && !danger) {
        const blocked = [...foe.battleline, ...foe.artifacts].some((x) => x.spec.blocksOpponentBonusIcons);
        if (!blocked)
          for (const icon of c.resolvedBonusIcons ?? c.bonusIcons ?? []) {
            if (icon === 'damage' && foe.battleline.length) delta += 0.55;
            if (icon === 'power' && (me.battleline.length || c.spec.kind === 'creature')) delta += 0.3;
          }
        if (profile === 'tempo' && c.spec.kind === 'creature') delta += 0.8;
      }
    }
    if (a.kind === 'choose' && o.pending?.intent?.kind === 'house-restriction') {
      const intent = o.pending.intent,
        choice = intent.options.find((x) => x.id === item.id || x.id === a.option);
      if (choice) {
        const target = o.players[intent.target];
        const work =
          target.battleline.filter(
            (c) => c.ready && (c.effective.houses ?? [c.effective.house]).includes(choice.house),
          ).length *
            3 +
          (target.hand ?? []).filter((c) =>
            (c.effective.houses ?? [c.effective.house]).includes(choice.house),
          ).length *
            2;
        delta += (intent.target === o.you ? 1 : -1) * (intent.rule === 'mustHouse' ? 1 : -1) * work;
      }
    }
    const gained = Math.max(0, r.estimatedAmber[0] - me.amber),
      denied = Math.max(0, foe.amber - r.estimatedAmber[1]);
    if (!danger) {
      if (profile === 'economy')
        delta -= Math.max(0, gained - Math.max(0, me.keyCost - me.forgeAvailable)) * 1.0;
      if (profile === 'race') delta += gained * 0.65 + (a.kind === 'reap' ? 0.35 : 0);
      if (profile === 'control') delta += denied * 0.7 + (a.kind === 'fight' && r.score > 0 ? 0.8 : 0);
      if (profile === 'adaptive') delta += me.keys.length >= foe.keys.length ? gained * 0.35 : denied * 0.4;
    }
    // A poor opening is observable; no simulated future hand is inspected.
    if (a.kind === 'mulligan' && profile === 'adaptive') {
      const work = Math.max(...me.houses.map((h) => houseWork(o, h, features)));
      if (work < 6) delta += 10;
    }
    return {
      ...r,
      score: r.score + delta,
      reasons: delta ? [...r.reasons, 'competitive-' + profile + ': bounded style adjustment'] : r.reasons,
    };
  });
  return rows.sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export function competitivePolicy(
  profile: CompetitiveProfile = 'tactical',
  corrections: AlgorithmFeatures = {},
): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankCompetitive(o, profile, corrections)[0].actionId;
  };
}
