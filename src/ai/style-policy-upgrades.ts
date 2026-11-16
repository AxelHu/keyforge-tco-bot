/**
 * Style-preserving candidates, independent from the universal decision-loop guard.
 * Each ordinary bonus replaces the frozen V1 bonus within the same V3 regret bound.
 * Archive guidance uses public counts only, never a sampled card or deck order.
 */
import type { CardView, Effect, House, LegalAction, Observation } from '../contracts/observation.js';
import type { ActionAssessment } from './algorithm-policies.js';
import type { Policy } from './policies.js';
import { refillGuidanceStatus } from './public-guidance-guards.js';
import { publicRefillForecast } from './public-refill-planning.js';
import { publicReapBlocked } from './toc-public-utility.js';
import {
  assessStylePolicy,
  STYLE_POLICY_LIMITS,
  type StyleGuard,
  type StylePolicyId,
  type StyleScore,
} from './style-policy.js';

export const STYLE_UPGRADE_POLICY_IDS = [
  'tactical-style-cycle-v2',
  'tactical-style-engine-v3',
  'tactical-style-control-v2',
] as const;
export type StyleUpgradePolicyId = (typeof STYLE_UPGRADE_POLICY_IDS)[number];
const PREDECESSOR: Record<StyleUpgradePolicyId, StylePolicyId> = {
  'tactical-style-cycle-v2': 'tactical-style-cycle-v1',
  'tactical-style-engine-v3': 'tactical-style-engine-v1',
  'tactical-style-control-v2': 'tactical-style-control-v1',
};
const SPECIALIZED = new Set(['unity-prism', 'sir-jaune', 'they-tell-no-tales', 'infurnace']);
const cap = (n: number, maximum: number = STYLE_POLICY_LIMITS.maximumBonus): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(maximum, n)) : 0;
const houses = (c: CardView): House[] => c.effective.houses ?? [c.effective.house];
const board = (o: Observation): CardView[] =>
  o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);

export interface ArchivePickupAssessment {
  available: boolean;
  reason: string;
  refillTarget: number;
  nativeArchiveExits: number;
  residualIfLeave: number;
  residualIfTake: number;
  displacedRefill: number;
  penalty: number;
}
export interface StyleUpgradeScore {
  actionId: string;
  baseScore: number;
  oldBonus: number;
  bonus: number;
  score: number;
  reasons: string[];
}
export interface StyleUpgradeAssessment {
  policyId: StyleUpgradePolicyId;
  predecessorId: StylePolicyId;
  predecessorActionId: string;
  selectedActionId: string;
  guard: StyleGuard | 'archive-refill';
  baseScoreGap: number;
  archive?: ArchivePickupAssessment;
  scores: StyleUpgradeScore[];
  ranked: ActionAssessment[];
}

/** An upper bound used only to preserve an existing pickup near a key threshold. */
function possiblePrintedAmber(effects: readonly Effect[]): number {
  let result = 0;
  for (const e of effects) {
    if (e.kind === 'gain' || e.kind === 'steal') {
      if (typeof e.amount !== 'number') return Infinity;
      result += Math.max(0, e.amount);
    } else if (
      e.kind === 'resource' &&
      (!e.side || e.side === 'self') &&
      ['gain', 'steal'].includes(e.operation)
    ) {
      if (typeof e.amount !== 'number') return Infinity;
      result += Math.max(0, e.amount);
    } else if (e.kind === 'if') {
      result += Math.max(possiblePrintedAmber(e.then), possiblePrintedAmber(e.otherwise ?? []));
    } else if (e.kind === 'forgeEffect') return Infinity;
  }
  return result;
}

export function assessCycleArchives(o: Observation): ArchivePickupAssessment {
  const me = o.players[o.you],
    archive = me.archives ?? [],
    hand = me.hand ?? [];
  const result: ArchivePickupAssessment = {
    available: false,
    reason: 'not an ordinary complete archive pickup',
    refillTarget: 0,
    nativeArchiveExits: 0,
    residualIfLeave: 0,
    residualIfTake: 0,
    displacedRefill: 0,
    penalty: 0,
  };
  if (
    o.phase !== 'archives' ||
    !o.activeHouse ||
    o.turn === 1 ||
    o.legalActions.length !== 2 ||
    !o.legalActions.some((x) => x.action.kind === 'takeArchives') ||
    !o.legalActions.some((x) => x.action.kind === 'leaveArchives') ||
    archive.length !== me.archiveCount ||
    hand.length !== me.handCount ||
    archive.some((c) => c.owner !== o.you) ||
    !archive.length
  )
    return result;
  if (
    [...hand, ...archive].some((c) => SPECIALIZED.has(c.definition)) ||
    (o.prophecies ?? []).some((p) => p.active)
  ) {
    result.reason = 'specialist or active prophecy retains baseline archive timing';
    return result;
  }
  if (!refillGuidanceStatus(o).known) {
    result.reason = 'refill modifiers or before-refill effects are not fully modeled';
    return result;
  }
  const native = (c: CardView) => houses(c).includes(o.activeHouse!);
  // A native card can leave by discarding even when its play is restricted. Cards
  // that prohibit ordinary discard are not certified exits by this count model.
  const exits = (c: CardView) => native(c) && !c.spec.cannotDiscardAsAction;
  const activeArchive = archive.filter(native);
  const possibleAmber = activeArchive.reduce(
    (n, c) =>
      n +
      (c.resolvedBonusIcons ?? c.bonusIcons ?? Array(c.spec.amber).fill('amber')).filter((x) => x === 'amber')
        .length +
      possiblePrintedAmber(c.spec.abilities?.play ?? []),
    0,
  );
  const shortfall = me.keyCost - me.forgeAvailable;
  if (shortfall > 0 && possibleAmber >= shortfall) {
    result.reason = 'visible archive may fund the next key; preserve baseline pickup';
    return result;
  }
  // This is a best-case clear of the *known* native hand, not a continuation.
  // Public draw effects, tutors, unknown draws and off-house permissions are not added.
  result.nativeArchiveExits = archive.filter(exits).length;
  result.residualIfLeave = hand.length - hand.filter(exits).length;
  result.residualIfTake = result.residualIfLeave + archive.length - result.nativeArchiveExits;
  const leave = publicRefillForecast(o, result.residualIfLeave),
    take = publicRefillForecast(o, result.residualIfTake),
    availableCards = me.deckCount + me.discard.length;
  result.refillTarget = leave.target;
  result.displacedRefill = Math.max(
    0,
    Math.min(availableCards, leave.draws) - Math.min(availableCards, take.draws),
  );
  result.penalty = cap(result.displacedRefill * 0.9);
  result.available = true;
  result.reason = 'known off-house archive cards displace the next normal refill';
  return result;
}

function readyAssetOpportunities(o: Observation, house: House): number {
  if (
    o.publicStateCoverage?.effectsComplete === false ||
    o.publicStateCoverage?.turnHistoryComplete === false
  )
    return 0;
  const visible = board(o),
    me = o.players[o.you];
  if (o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'noUse')) return 0;
  const available = (c: CardView) =>
    c.controller === o.you &&
    c.ready &&
    !c.stunned &&
    houses(c).includes(house) &&
    c.usesThisTurn < 6 &&
    ![c.spec, ...(c.gainedTextBoxes ?? [])].some(
      (d) =>
        d.useProhibitedIf ||
        d.destroyFriendlyBeforeUse ||
        d.useRequiresNeighborsHouse ||
        d.requiresUntamedDiscard,
    ) &&
    !o.lasting.some(
      (e) => e.rule === 'noNamedPlayUse' && e.turn >= o.turn && e.affectedName === c.spec.name,
    ) &&
    !visible.some(
      (u) =>
        u.attachedTo === c.id &&
        (u.spec.upgrade?.cannotUse || u.spec.upgrade?.hostUseProhibitedIf || u.spec.upgrade?.requiresDiscard),
    );
  const fightOnly = o.lasting.some(
    (e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'fightOnly',
  );
  const reapers = fightOnly
    ? 0
    : me.battleline.filter((c) => available(c) && publicReapBlocked(o, c) === false).length;
  // A plain stocked draw Action also represents existing engine work. Omni work
  // is not attributed to one house, and an unsupported cost/compound Action is
  // not optimistically treated as a draw engine by this small count helper.
  const drawArtifacts =
    me.deckCount + me.discard.length <= 0
      ? 0
      : me.artifacts.filter((c) => {
          const effects = c.spec.abilities?.action ?? [];
          return (
            available(c) &&
            effects.length > 0 &&
            !c.spec.abilities?.afterUse?.length &&
            effects.every(
              (e) =>
                (e.kind === 'draw' ||
                  (e.kind === 'resource' && e.operation === 'draw' && (!e.side || e.side === 'self'))) &&
                typeof e.amount === 'number' &&
                e.amount > 0,
            )
          );
        }).length;
  return reapers + drawArtifacts;
}

function engineBonus(
  o: Observation,
  item: LegalAction,
  row: ActionAssessment,
  old: StyleScore,
  reasons: string[],
): number {
  const f = old.features,
    a = item.action,
    me = o.players[o.you];
  let value = f.deployment * 2.3 + f.amberProgress * 0.15;
  // V3 already values understood recurring effects in contextualBoardWorth.
  // Do not pay a second premium merely because a trigger exists (including an
  // empty healing opportunity or a costly/conditional Action).
  if (f.recurringText > 0) reasons.push('replace trigger-count premium with current asset opportunities');
  if (a.kind === 'house' && a.house) {
    const ready = readyAssetOpportunities(o, a.house);
    value += cap(ready * 0.9, 2.7);
    if (ready > 0) reasons.push('ready native permanents have public reap or stocked draw opportunities');
  } else if ((a.kind === 'reap' || a.kind === 'use') && o.publicStateCoverage?.effectsComplete !== false) {
    const source = [...me.battleline, ...me.artifacts].find((c) => c.id === a.card);
    if (
      !source ||
      source.controller !== o.you ||
      SPECIALIZED.has(source.definition) ||
      a.permission !== undefined
    )
      return cap(value);
    const ownGain = cap(row.estimatedAmber[0] - me.amber, 2),
      drawOpportunity = Math.min(f.drawText, me.deckCount + me.discard.length, 2);
    if (ownGain > 0 || drawOpportunity > 0) {
      value += 0.8 + ownGain * 0.65 + drawOpportunity * 0.45;
      reasons.push('legal permanent activation has a net resource or stocked draw opportunity');
    }
  }
  return cap(value);
}

function currentCostFunded(o: Observation, row: ActionAssessment, opponent: boolean): boolean {
  const index = opponent ? (o.you === 0 ? 1 : 0) : o.you,
    p = o.players[index],
    estimate = row.estimatedAmber[opponent ? 1 : 0];
  return !p.forgeBlocked && estimate + Math.max(0, p.forgeAvailable - p.amber) >= p.keyCost;
}

function controlBonus(
  o: Observation,
  item: LegalAction,
  row: ActionAssessment,
  old: StyleScore,
  alternatives: Map<string, ActionAssessment>,
  reasons: string[],
): number {
  const f = old.features,
    a = item.action;
  let pressure = f.boardPressure;
  if (a.kind === 'fight' && pressure > 0) {
    const reap = alternatives.get(a.card),
      me = o.players[o.you],
      foe = o.players[o.you === 0 ? 1 : 0];
    const canFundByReaping = reap && me.forgeAvailable < me.keyCost && currentCostFunded(o, reap, false);
    const threatensNextKey =
      !foe.forgeBlocked && foe.skipForgeTurn !== o.turn + 1 && foe.forgeAvailable >= foe.keyCost;
    const blocksNextKey = threatensNextKey && !currentCostFunded(o, row, true);
    if (canFundByReaping && !currentCostFunded(o, row, false) && !blocksNextKey && !row.deniesKey) {
      pressure = 0;
      reasons.push(
        'same-creature reap can fund the next key; generic combat pressure has an immediate opportunity cost',
      );
    }
  }
  return cap(f.denial * 1.25 + pressure * 1.2 + f.controlText * 0.65);
}

export function assessStyleUpgrade(o: Observation, policyId: StyleUpgradePolicyId): StyleUpgradeAssessment {
  if (!STYLE_UPGRADE_POLICY_IDS.includes(policyId)) throw Error('Unknown enhanced style policy');
  const predecessorId = PREDECESSOR[policyId],
    old = assessStylePolicy(o, predecessorId, {
      publicReapControlRisk: policyId === 'tactical-style-engine-v3',
      publicDestructionPayments: policyId === 'tactical-style-engine-v3',
      publicThirdKeyFundingRisk: policyId === 'tactical-style-engine-v3',
      publicDestroyedRefunds: policyId === 'tactical-style-engine-v3',
      publicHouseDefenseOpportunities: policyId === 'tactical-style-engine-v3',
    }),
    legal = new Map(o.legalActions.map((x) => [x.id, x])),
    oldScores = new Map(old.scores.map((x) => [x.actionId, x])),
    rows = new Map(old.ranked.map((x) => [x.actionId, x]));
  const archive =
    policyId === 'tactical-style-cycle-v2' && old.guard === 'effect-or-special-decision'
      ? assessCycleArchives(o)
      : undefined;
  const archiveEnabled = !!archive?.available && archive.penalty > 0;
  const reapRows = new Map<string, ActionAssessment>();
  for (const s of old.scores) {
    const a = legal.get(s.actionId)!.action;
    if (a.kind === 'reap') {
      const previous = reapRows.get(a.card);
      if (!previous || s.baseScore > previous.score)
        reapRows.set(a.card, { ...rows.get(s.actionId)!, score: s.baseScore });
    }
  }
  const bestBase = Math.max(...old.scores.map((s) => s.baseScore));
  const scores: StyleUpgradeScore[] = old.scores.map((s) => {
    const item = legal.get(s.actionId)!,
      row = rows.get(s.actionId)!,
      reasons: string[] = [];
    let bonus = s.bonus;
    if (
      archiveEnabled &&
      item.action.kind === 'takeArchives' &&
      bestBase - s.baseScore <= STYLE_POLICY_LIMITS.maximumBaseGap
    ) {
      bonus = -archive!.penalty;
      reasons.push(archive!.reason + ': ' + archive!.displacedRefill + ' publicly counted slots');
    } else if (old.guard === 'none' && s.eligible) {
      if (policyId === 'tactical-style-engine-v3') bonus = engineBonus(o, item, row, s, reasons);
      if (policyId === 'tactical-style-control-v2') bonus = controlBonus(o, item, row, s, reapRows, reasons);
    }
    return {
      actionId: s.actionId,
      baseScore: s.baseScore,
      oldBonus: s.bonus,
      bonus,
      score: bonus > 0 ? Math.min(4999, s.baseScore + bonus) : s.baseScore + bonus,
      reasons,
    };
  });
  const byId = new Map(scores.map((s) => [s.actionId, s]));
  const ranked = old.ranked
    .map((row) => {
      const next = byId.get(row.actionId)!,
        previous = oldScores.get(row.actionId)!;
      if (next.bonus === previous.bonus) return row;
      return {
        ...row,
        score: Math.min(4999, next.score),
        approximate: true,
        reasons: [
          ...row.reasons.filter((r) => !r.startsWith(predecessorId + ': bounded visible style opportunity')),
          policyId + ': bounded style bonus ' + next.bonus.toFixed(3),
          ...next.reasons,
        ],
      };
    })
    .sort((a, b) => b.score - a.score);
  // If archive congestion cannot overcome the original gap, leave the baseline
  // choice intact. In particular, this cannot demote multiple productive archives
  // far enough to exceed the ordinary maximum V3 score gap.
  const selected = ranked[0].actionId;
  return {
    policyId,
    predecessorId,
    predecessorActionId: old.selectedActionId,
    selectedActionId: selected,
    guard: archiveEnabled ? 'archive-refill' : old.guard,
    baseScoreGap: bestBase - oldScores.get(selected)!.baseScore,
    ...(archive ? { archive } : {}),
    scores,
    ranked,
  };
}
export const rankStyleUpgrade = (o: Observation, id: StyleUpgradePolicyId): ActionAssessment[] =>
  assessStyleUpgrade(o, id).ranked;
export function styleUpgradePolicy(id: StyleUpgradePolicyId): Policy {
  if (!STYLE_UPGRADE_POLICY_IDS.includes(id)) throw Error('Unknown enhanced style policy');
  return (o) => rankStyleUpgrade(o, id)[0].actionId;
}
