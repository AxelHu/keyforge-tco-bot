/** New, opt-in tactical versions. Historical rankers and deck recommendations remain available. */
import type { CardView, Effect, LegalAction, Observation } from '../contracts/observation.js';
import { assessAlgorithm, type ActionAssessment } from './algorithm-policies.js';
import { rankLadder } from './ladder-policy.js';
import { rankCardAwareV3 } from './card-aware-v3-policy.js';
import { rankTocPolicy } from './toc-policy.js';
import { publicPlayCapacity } from './public-guidance-guards.js';
import { publicTargets } from './season-utility.js';
import { assessPublicOperation } from './public-card-value.js';
import type { Policy } from './policies.js';

export const TACTICAL_STRENGTH_POLICY_IDS = [
  'tactical-ladder-balanced-v2',
  'tactical-card-effects-v4',
  'tactical-toc-v2',
] as const;
export type TacticalStrengthPolicyId = (typeof TACTICAL_STRENGTH_POLICY_IDS)[number];
const CRITICAL = 5000;
const corrections = {
  physicalBonuses: true,
  multipleHouses: true,
  targetIntent: true,
  netResources: true,
  contextualEffects: true,
} as const;
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
const thirdKeyDanger = (o: Observation) => {
  const foe = o.players[1 - o.you];
  return (
    foe.keys.length === 2 &&
    !foe.forgeBlocked &&
    foe.skipForgeTurn !== o.turn + 1 &&
    foe.forgeAvailable >= foe.keyCost
  );
};
function complete(o: Observation): boolean {
  return (
    o.publicStateCoverage?.effectsComplete !== false && o.publicStateCoverage?.turnHistoryComplete !== false
  );
}

/** The old Ladder's four balanced priorities are retained; actual pool replacement
 * and contextual target costs now feed those priorities instead of nominal income. */
export function rankLadderBalancedV2(o: Observation): ActionAssessment[] {
  return rankLadder(o, 'tactical', 'balanced', { netResources: true, contextualEffects: true });
}

/** Compare only a card's printed Play effect with the same public card without that
 * effect. Icons and body value cancel. These private valuation actions are never
 * returned to a referee, and are not assertions of future legal availability. */
function handEffectPremium(o: Observation, c: CardView): number {
  const id = 'strength-v1-public-play-value:' + c.id;
  const probe: LegalAction = { id, action: { kind: 'play', card: c.id } };
  const view: Observation = { ...o, legalActions: [...o.legalActions, probe] };
  const value = assessAlgorithm(view, id, 'tempo-v1', {
    ...corrections,
    publicIntegerThirds: c.definition === 'sir-jaune',
    publicHouseChoices: true,
    publicAmberIconBindings: true,
  }).score;
  const without: CardView = { ...c, spec: { ...c.spec, abilities: { ...c.spec.abilities, play: [] } } };
  const players = [...view.players] as Observation['players'];
  players[o.you] = {
    ...players[o.you],
    hand: (players[o.you].hand ?? []).map((x) => (x.id === c.id ? without : x)),
  };
  const plain = assessAlgorithm({ ...view, players }, id, 'tempo-v1', corrections).score;
  // A hypothetical key or denial is ordinary bounded opportunity, never a critical priority.
  return Math.max(0, Math.min(12, value - plain));
}

function improveHouseChoice(o: Observation, rows: readonly ActionAssessment[]): ActionAssessment[] {
  if (
    o.phase !== 'house' ||
    o.pending ||
    !complete(o) ||
    thirdKeyDanger(o) ||
    rows.some((r) => r.score >= CRITICAL)
  )
    return [...rows];
  const hand = o.players[o.you].hand ?? [];
  // The dedicated Prism/Fate house plan remains authoritative in its own context.
  if (hand.some((c) => c.definition === 'unity-prism') || o.prophecies?.some((p) => p.active))
    return [...rows];
  const publicBoard = board(o),
    capacity = publicPlayCapacity(o);
  if (
    !capacity.known ||
    o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'noPlay')
  )
    return [...rows];
  if (publicBoard.some((c) => boxes(c).some((d) => d.onePlayPerType || d.creaturePlayLimits?.length)))
    return [...rows];
  const noCreatures =
    o.players[o.you].battleline.concat(o.players[o.you].artifacts).some((c) => c.spec.prohibitOwnCreatures) ||
    o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'noCreatures');
  const potential = new Map<string, number>();
  for (const c of hand) {
    if (
      !c.spec.abilities?.play?.length ||
      c.spec.kind === 'upgrade' ||
      c.spec.playCondition ||
      c.physicalParts?.length ||
      c.gainedTextBoxes?.length ||
      c.spec.conditionalAbilities?.length ||
      (noCreatures && c.spec.kind === 'creature') ||
      Math.max(c.spec.minAmberToPlay ?? 0, c.spec.playAmberCost ?? 0) > o.players[o.you].amber
    )
      continue;
    for (const house of c.effective.houses ?? [c.effective.house]) {
      if (o.legalActions.some((a) => a.action.kind === 'house' && a.action.house === house))
        potential.set(c.id + ':' + house, handEffectPremium({ ...o, activeHouse: house }, c));
    }
  }
  const legal = new Map(o.legalActions.map((a) => [a.id, a.action]));
  const limit = Math.min(o.turn === 1 ? 1 : 2, capacity.remaining ?? 2);
  return rows
    .map((r) => {
      const a = legal.get(r.actionId)!;
      if (a.kind !== 'house' || !a.house || r.score >= CRITICAL || limit <= 0) return r;
      // At most two distinct visible cards. Alpha/Omega alternatives count once:
      // they are opportunities, not an invented multi-card turn or unknown draw.
      const ordinary: number[] = [],
        terminal: number[] = [],
        alpha: number[] = [],
        exclusive: number[] = [];
      for (const c of hand)
        if ((c.effective.houses ?? [c.effective.house]).includes(a.house)) {
          const n = potential.get(c.id + ':' + a.house) ?? 0;
          (c.spec.alpha && c.spec.omega
            ? exclusive
            : c.spec.alpha
              ? alpha
              : c.spec.omega
                ? terminal
                : ordinary
          ).push(n);
        }
      ordinary.sort((a, b) => b - a);
      const bestAlpha = Math.max(0, ...alpha),
        bestTerminal = Math.max(0, ...terminal);
      const alternatives = [
        Math.max(0, ...exclusive),
        ordinary.slice(0, limit).reduce((a, b) => a + b, 0),
        bestAlpha + ordinary.slice(0, limit - 1).reduce((a, b) => a + b, 0),
        bestTerminal + ordinary.slice(0, limit - 1).reduce((a, b) => a + b, 0),
      ];
      const delta = Math.min(6, Math.max(...alternatives) * 0.35);
      return delta > 0
        ? {
            ...r,
            score: Math.min(CRITICAL - 1, r.score + delta),
            approximate: true,
            reasons: [
              ...r.reasons,
              'strength v1: bounded visible hand-effect opportunity beyond icons/body; no hidden draw or certified continuation',
            ],
          }
        : r;
    })
    .sort(compare);
}

/** Restrict the sequencing claim to an ordinary, liquid reap that changes no
 * resource or card used to determine a later public sweep. Complex interactions
 * keep the existing V3 decision instead of being simulated approximately. */
function plainLiquidReap(o: Observation, c: CardView, row: ActionAssessment): boolean {
  if (
    row.estimatedAmber[0] !== o.players[o.you].amber + 1 ||
    row.estimatedAmber[1] !== o.players[1 - o.you].amber
  )
    return false;
  if (
    !c.ready ||
    c.stunned ||
    c.spec.cannotReap ||
    c.spec.destroyFriendlyBeforeUse ||
    c.gainedTextBoxes?.length ||
    c.spec.conditionalAbilities?.length
  )
    return false;
  if (c.spec.abilities?.reap?.length || c.spec.abilities?.afterUse?.length) return false;
  if (
    board(o).some((x) =>
      boxes(x).some(
        (d) =>
          d.capturesIncomingAmber ||
          d.capturesReapIncome ||
          d.reapIncomeChosenCapture ||
          d.supplyInsteadOfPool ||
          d.nextUseAlternatesFightReap ||
          d.grantsAbilities?.length ||
          d.reactions?.some((r) => ['creatureReaped', 'creatureUsed', 'amberGained'].includes(r.event)),
      ),
    )
  )
    return false;
  if (
    o.players
      .flatMap((p) => p.upgrades)
      .some(
        (u) =>
          u.attachedTo === c.id &&
          (u.spec.upgrade?.abilities?.reap?.length || u.spec.upgrade?.abilities?.afterUse?.length),
      )
  )
    return false;
  return true;
}

/** Only literal unconditional simultaneous departures with stable public filters.
 * A Ward, unknown replacement, choice, conditional branch or paid effect does not
 * establish that an unused body will be lost. */
function sweepDepartures(o: Observation, source: CardView, effects: readonly Effect[]): Set<string> {
  const ids = new Set<string>();
  if (!effects.length) return ids;
  for (const e of effects) {
    if ((e.kind === 'gain' || e.kind === 'chains') && typeof e.amount === 'number') continue;
    if (
      e.kind !== 'all' ||
      e.after ||
      !['destroy', 'purge', 'returnHand', 'archive'].includes(e.operation) ||
      Object.keys(e.filter).some((k) => !['kind', 'zone', 'side', 'house', 'notHouse'].includes(k)) ||
      e.filter.house === 'chosenHouse' ||
      e.filter.notHouse === 'chosenHouse'
    )
      return new Set();
    const found = publicTargets(o, e.filter, o.you, source);
    if (found === null) return new Set();
    for (const c of found) {
      const impact = assessPublicOperation(o, c, e.operation, 0);
      if (impact.removed && !impact.approximate) ids.add(c.id);
    }
  }
  return ids;
}

export function preserveReadyWork(o: Observation, rows: readonly ActionAssessment[]): ActionAssessment[] {
  if (
    o.phase !== 'main' ||
    o.pending ||
    o.activePlayer !== o.you ||
    !complete(o) ||
    thirdKeyDanger(o) ||
    rows.some((r) => r.score >= CRITICAL) ||
    o.nextCreatureUseRestriction ||
    o.cardEffects.length ||
    o.prophecies?.some((p) => p.active) ||
    o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you)
  )
    return [...rows];
  const legal = new Map(o.legalActions.map((a) => [a.id, a]));
  const hand = new Map((o.players[o.you].hand ?? []).map((c) => [c.id, c]));
  const creatures = new Map(o.players[o.you].battleline.map((c) => [c.id, c]));
  const sweeps: { score: number; removed: Set<string> }[] = [];
  for (const row of rows) {
    const a = legal.get(row.actionId)!.action;
    if (a.kind !== 'play' || a.copy || a.otherHalf || a.permission !== undefined || row.score <= 0) continue;
    const source = hand.get(a.card);
    if (
      !source ||
      source.spec.alpha ||
      source.spec.playCondition ||
      source.gainedTextBoxes?.length ||
      source.spec.conditionalAbilities?.length ||
      source.spec.playAmberCost ||
      source.spec.minAmberToPlay ||
      source.spec.kind !== 'action'
    )
      continue;
    // Reap reactions and action-play replacement are not certified by this lower bound.
    if (board(o).some((c) => boxes(c).some((d) => d.replacesEnemyActionPlayWithOwnLeftDestruction))) continue;
    const removed = sweepDepartures(o, source, source.spec.abilities?.play ?? []);
    if (removed.size) sweeps.push({ score: row.score, removed });
  }
  if (!sweeps.length) return [...rows];
  return rows
    .map((row) => {
      const a = legal.get(row.actionId)!.action;
      if (a.kind !== 'reap' || a.permission !== undefined || row.score <= 0) return row;
      const source = creatures.get(a.card);
      if (!source || !plainLiquidReap(o, source, row)) return row;
      const sweep = Math.max(0, ...sweeps.filter((s) => s.removed.has(source.id)).map((s) => s.score));
      // Credit one retained removal and one liquid amber, not the existing reap
      // row plus a second copy of any older Alpha/Omega sequencing credit.
      const score = Math.min(CRITICAL - 1, Math.max(row.score, sweep + 3.5));
      return score > row.score
        ? {
            ...row,
            score,
            approximate: true,
            reasons: [
              ...row.reasons,
              'strength v1: take a liquid reap from a currently threatened ready body before a retained public sweep opportunity',
            ],
          }
        : row;
    })
    .sort(compare);
}

export function rankCardEffectsV4(o: Observation): ActionAssessment[] {
  return preserveReadyWork(o, improveHouseChoice(o, rankCardAwareV3(o)));
}
export function rankTocV2(o: Observation): ActionAssessment[] {
  // Retain the full token/conditional-lock specialization; strengthen its common
  // house and sequencing layer without replacing it with a different style.
  return preserveReadyWork(o, improveHouseChoice(o, rankTocPolicy(o, 'tactical-toc-v1')));
}
export function tacticalStrengthPolicy(id: TacticalStrengthPolicyId): Policy {
  if (!TACTICAL_STRENGTH_POLICY_IDS.includes(id)) throw Error('Unknown tactical strength policy');
  const rank =
    id === 'tactical-ladder-balanced-v2'
      ? rankLadderBalancedV2
      : id === 'tactical-card-effects-v4'
        ? rankCardEffectsV4
        : rankTocV2;
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rank(o)[0].actionId;
  };
}
