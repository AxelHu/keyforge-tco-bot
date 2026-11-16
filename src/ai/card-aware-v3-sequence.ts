/**
 * B is A plus one narrow public ordering correction: a fractional capture followed
 * by a fixed capture. Both current Plays must remain executable in either order.
 * Compare symmetric two-action utility, then keep the pair's original maximum
 * score: this reorders the pair, rather than promoting a combo above other work.
 */
import type { Action, CardView, LegalAction, Observation, PermissionView } from '../contracts/observation.js';
import { prophecyFacts } from '../knowledge/prophecy-facts.js';
import { assessAlgorithm, type ActionAssessment } from './algorithm-policies.js';
import { rankCardAwareV3 } from './card-aware-v3-policy.js';
import { publicPlayCapacity } from './public-guidance-guards.js';
import { publicPlayEndsStep } from './public-card-value.js';
import type { Policy } from './policies.js';

const CRITICAL = 5000;
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');
const houses = (c: CardView) => [...(c.effective.houses ?? [c.effective.house])].sort().join('|');
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const features = {
  physicalBonuses: true,
  multipleHouses: true,
  targetIntent: true,
  netResources: true,
  contextualEffects: true,
  publicIntegerThirds: true,
} as const;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const plainCaptureFields = new Set([
  'id',
  'name',
  'number',
  'house',
  'kind',
  'power',
  'armor',
  'amber',
  'traits',
  'summary',
  'abilities',
  'keywords',
  'assault',
  'hazardous',
  'splashAttack',
  'alpha',
  'omega',
]);
type Play = Extract<Action, { kind: 'play' }>;
interface Capture {
  row: ActionAssessment;
  legal: LegalAction & { action: Play };
  card: CardView;
  fixed: number | null;
  tier: 0 | typeof CRITICAL;
  normal: ActionAssessment;
}
interface Continuation {
  joint: number;
  next: Capture;
  afterFirst: number;
  afterBoth: number;
  reverseAfterBoth: number;
}

/** A real legal Play is necessary, but does not establish a second future Play.
 * Extra entry text, bonus choices, copied forms and conditional Play text abstain.
 * Ward is intentionally not a veto: this engine's capture transfer bypasses Ward.
 */
function captureKind(c: CardView): { fixed: number | null } | undefined {
  if (
    c.spec.kind !== 'creature' ||
    c.spec.alpha ||
    c.spec.omega ||
    c.effective.power <= 0 ||
    c.gainedTextBoxes?.length ||
    c.physicalParts?.length ||
    Object.entries(c.spec).some(([k, v]) => v !== undefined && !plainCaptureFields.has(k) && k !== 'summaryFeatures') ||
    (c.resolvedBonusIcons ?? c.bonusIcons ?? Array(c.spec.amber).fill('amber')).length
  )
    return;
  const effects = c.spec.abilities?.play;
  if (effects?.length !== 1 || effects[0].kind !== 'capture') return;
  const amount = effects[0].amount;
  if (typeof amount === 'number')
    return Number.isSafeInteger(amount) && amount > 0 ? { fixed: amount } : undefined;
  const v = object(amount),
    third = object(v?.floorThird);
  if (
    v &&
    Object.keys(v).length === 1 &&
    third &&
    Object.keys(third).length === 2 &&
    third.metric === 'amber' &&
    third.side === 'opponent'
  )
    return { fixed: null };
}

/** No alternate interpreter for an intervening reaction, changing power/house,
 * type cap, entry replacement, or hidden Fate. These cases retain A unchanged.
 */
function quietWindow(o: Observation): boolean {
  const capacity = publicPlayCapacity(o);
  if (
    o.phase !== 'main' ||
    o.pending ||
    o.activePlayer !== o.you ||
    o.winner !== null ||
    o.turn === 1 ||
    o.publicStateCoverage?.turnOrdinalKnown === false ||
    !capacity.known ||
    (capacity.remaining !== null && capacity.remaining < 2) ||
    o.turnStep?.omega ||
    (o.turnStep && o.turnStep.step !== 3) ||
    o.cardEffects.length ||
    o.nextCreatureEntries?.some((e) => e.actor === o.you && e.turn === o.turn) ||
    o.players.some((p) => p.upgrades.length) ||
    o.lasting.some((e) => e.turn >= o.turn && e.rule !== 'playLimit')
  )
    return false;
  for (const p of o.prophecies ?? []) {
    if (!p.active || p.owner === o.you) continue;
    const face = p.faces[p.face];
    // Without draws, damage, uses, discard, or an action card, the other current
    // faces cannot fire between these two pure creature captures.
    if (
      !prophecyFacts.has(face) ||
      ['heads-i-win', 'tails-you-lose', 'look-how-far-you-ve-come'].includes(face)
    )
      return false;
  }
  for (const c of board(o))
    for (const box of [c.spec, ...(c.gainedTextBoxes ?? [])]) {
      if (
        (box.supplyInsteadOfPool && c.controller !== o.you) ||
        (box.onePlayPerType &&
          (box.onePlayPerType === 'self' ? c.controller === o.you : c.controller !== o.you)) ||
        box.noPlayCreaturesWhileAhead ||
        box.creaturePlayLimits?.length ||
        box.forbidMorePowerfulCreaturePlay ||
        box.prohibitOwnCreatures ||
        box.repeatFriendlyCreaturePlay ||
        box.friendlyPlayAsReap ||
        box.auras?.length ||
        box.powerBonus !== undefined ||
        box.selfPower ||
        box.damagedPowerBonus ||
        box.neighborHouse ||
        box.neighborTraits?.length ||
        box.grantsAbilities?.some((g) => g.abilities.play?.length) ||
        box.reactions?.some((r) =>
          ['cardPlayed', 'creaturePlayed', 'creatureEntered', 'creatureCaptured'].includes(r.event),
        )
      )
        return false;
    }
  return true;
}

function permission(o: Observation, c: Capture): PermissionView | undefined {
  if (c.legal.action.permission === undefined) return;
  return o.permissions.find((p) => p.id === c.legal.action.permission);
}
function permissionStable(o: Observation, c: Capture): boolean {
  if (c.legal.action.permission === undefined)
    return !!o.activeHouse && (c.card.effective.houses ?? [c.card.effective.house]).includes(o.activeHouse);
  const p = permission(o, c);
  if (!p || !['play', 'playOrUse'].includes(p.mode)) return false;
  // A static hand filter keeps the other physical hand card eligible. Bound and
  // used entries are already checked by the actual current legal action.
  const staticFields = new Set([
    'zone',
    'side',
    'kind',
    'house',
    'notHouse',
    'definition',
    'name',
    'trait',
    'notTrait',
  ]);
  return Object.keys(p.filter).every((k) => staticFields.has(k));
}
function pairExecutable(o: Observation, a: Capture, b: Capture): boolean {
  if (
    a.card.id === b.card.id ||
    a.card.spec.name === b.card.spec.name ||
    a.fixed === b.fixed ||
    (a.fixed !== null && b.fixed !== null) ||
    a.tier !== b.tier ||
    houses(a.card) !== houses(b.card) ||
    !permissionStable(o, a) ||
    !permissionStable(o, b)
  )
    return false;
  for (const c of [a, b]) {
    const p = permission(o, c);
    if (!p) continue;
    const uses = a.legal.action.permission === p.id && b.legal.action.permission === p.id ? 2 : 1;
    if (
      (p.remaining !== null && p.remaining < uses) ||
      (p.uniqueRemaining !== null && p.uniqueRemaining < uses)
    )
      return false;
  }
  return true;
}
const taken = (c: Capture, amber: number) => Math.min(amber, c.fixed ?? Math.floor(amber / 3));

/** Re-score only the companion's public pool-dependent marginal utility.
 * This is an appraisal of an existing legal action, never a fabricated command
 * or a simulated observation used to choose/compile a subsequent action.
 */
function afterCapture(o: Observation, c: Capture, amber: number): ActionAssessment {
  const opponent = o.you === 0 ? 1 : 0;
  const view: Observation = { ...o, players: [...o.players] as Observation['players'] };
  const p = o.players[opponent];
  view.players[opponent] = {
    ...p,
    amber,
    forgeAvailable: Math.max(0, p.forgeAvailable - (p.amber - amber)),
  };
  return assessAlgorithm(view, c.legal.id, 'tempo-v1', features);
}

export function rankCardAwareV3Sequence(o: Observation): ActionAssessment[] {
  const rows = rankCardAwareV3(o);
  if (!quietWindow(o)) return rows;
  const own = new Map((o.players[o.you].hand ?? []).map((c) => [c.id, c]));
  const legal = new Map(o.legalActions.map((a) => [a.id, a]));
  const pool = o.players[o.you === 0 ? 1 : 0].amber;
  const candidates: Capture[] = [];
  for (const row of rows) {
    const item = legal.get(row.actionId);
    if (!item || item.action.kind !== 'play' || row.projectedKey || row.score >= 100000) continue;
    const a = item.action,
      card = own.get(a.card);
    const kind = card && captureKind(card);
    if (
      !card ||
      !kind ||
      card.controller !== o.you ||
      card.owner !== o.you ||
      a.copy ||
      a.otherHalf ||
      a.asUpgrade ||
      a.entryOverride ||
      a.target ||
      a.position !== undefined ||
      publicPlayEndsStep(o, card)
    )
      continue;
    const tier = row.score < CRITICAL ? 0 : row.deniesKey ? CRITICAL : null;
    if (tier === null) continue;
    const normal = assessAlgorithm(o, item.id, 'tempo-v1', features);
    const c: Capture = { row, legal: item as Capture['legal'], card, ...kind, tier, normal };
    if (
      normal.approximate ||
      normal.projectedKey ||
      normal.estimatedAmber[0] !== o.players[o.you].amber ||
      normal.estimatedAmber[1] !== pool - taken(c, pool)
    )
      continue;
    candidates.push(c);
  }
  const best = new Map<string, Continuation>();
  const record = (
    first: Capture,
    next: Capture,
    afterFirst: number,
    afterBoth: number,
    reverseAfterBoth: number,
  ) => {
    const forecast = afterCapture(o, next, afterFirst);
    if (
      forecast.approximate ||
      forecast.projectedKey ||
      forecast.estimatedAmber[0] !== o.players[o.you].amber ||
      forecast.estimatedAmber[1] !== afterBoth
    )
      return;
    // Each current card's ordinary value is included exactly once. The second
    // row's critical tier is removed; future appraisal itself uses tempo mode.
    const joint = first.row.score + next.row.score - first.tier + (forecast.score - next.normal.score);
    const old = best.get(first.legal.id);
    if (
      !old ||
      joint > old.joint ||
      (joint === old.joint && next.legal.id.localeCompare(old.next.legal.id, 'en') < 0)
    )
      best.set(first.legal.id, { joint, next, afterFirst, afterBoth, reverseAfterBoth });
  };
  for (let i = 0; i < candidates.length; i++)
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i],
        b = candidates[j];
      if (!pairExecutable(o, a, b)) continue;
      const afterA = pool - taken(a, pool),
        afterB = pool - taken(b, pool);
      const ab = afterA - taken(b, afterA),
        ba = afterB - taken(a, afterB);
      if (ab === ba) continue; // A commuting/equal result keeps all original scores.
      record(a, b, afterA, ab, ba);
      record(b, a, afterB, ba, ab);
    }
  if (!best.size) return rows;
  const adjusted = new Map<string, ActionAssessment>();
  for (const tier of [0, CRITICAL] as const) {
    const group = candidates.filter((c) => c.tier === tier && best.has(c.legal.id));
    if (!group.length) continue;
    const originalTop = Math.max(...group.map((c) => c.row.score));
    const jointTop = Math.max(...group.map((c) => best.get(c.legal.id)!.joint));
    for (const c of group) {
      const plan = best.get(c.legal.id)!;
      const score = Math.max(tier === CRITICAL ? CRITICAL : -Infinity, originalTop + (plan.joint - jointTop));
      if (!Number.isFinite(score)) throw Error('Nonfinite capture sequence score');
      adjusted.set(c.legal.id, {
        ...c.row,
        score,
        approximate: true,
        // estimatedAmber / projectedKey / deniesKey still describe only this
        // immediate action, never the planned second capture.
        reasons: [
          ...c.row.reasons,
          'card-aware v3 sequence: two legal captures ' +
            c.card.definition +
            ' then ' +
            plan.next.card.definition +
            ' leave public opponent pool ' +
            plan.afterBoth +
            ' instead of ' +
            plan.reverseAfterBoth +
            '; symmetric pair utility, original maximum and immediate priority tier retained',
        ],
      });
    }
  }
  return rows.map((r) => adjusted.get(r.actionId) ?? r).sort(compare);
}

export function cardAwarePolicyV3Sequence(): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankCardAwareV3Sequence(o)[0].actionId;
  };
}
