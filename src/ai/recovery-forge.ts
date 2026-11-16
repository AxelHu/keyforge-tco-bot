/** Only a currently observed single-card recovery prompt may prove this next-play route. */
import type { CardView, Effect, Observation } from '../contracts/observation.js';
import { publicPlayCapacity } from './public-guidance-guards.js';

const scalar = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
function namedLock(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((x) => namedLock(x, depth + 1));
  const r = value as Record<string, unknown>;
  return (
    r.kind === 'chooseForbiddenName' ||
    r.kind === 'forbidName' ||
    Object.values(r).some((x) => namedLock(x, depth + 1))
  );
}
/** A true result is a following-action opportunity, never an already projected key.
 * No stored amber, permissions, unknown card draws or copied/conditional text is assumed.
 */
export function knownRecoveredForge(o: Observation, card: CardView, amberAfterRecovery: number): boolean {
  const me = o.players[o.you],
    q = o.pending,
    d = card.spec;
  if (
    o.phase !== 'choice' ||
    !q ||
    q.actor !== o.you ||
    o.activePlayer !== o.you ||
    q.intent?.kind !== 'target-operation' ||
    q.intent.operation !== 'returnHand' ||
    o.winner !== null ||
    me.keys.length !== 2 ||
    me.forgeBlocked === true ||
    !o.activeHouse ||
    o.publicStateCoverage?.effectsComplete === false ||
    o.publicStateCoverage?.turnHistoryComplete === false ||
    o.turnStep?.omega ||
    !scalar(amberAfterRecovery) ||
    !scalar(me.keyCost)
  )
    return false;
  if (
    card.owner !== o.you ||
    d.kind !== 'action' ||
    d.alpha ||
    d.cannotPlay ||
    d.playCondition ||
    d.conditionalAbilities?.length ||
    card.gainedTextBoxes?.length ||
    d.id !== card.definition ||
    !(card.effective.houses ?? [card.effective.house]).includes(o.activeHouse) ||
    !o.legalActions.some((x) => x.action.kind === 'select' && x.action.target === card.id) ||
    !me.discard.some((x) => x.id === card.id) ||
    (o.turnUsage[d.name] ?? 0) >= 6
  )
    return false;
  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  const visible = [...board, ...(me.hand ?? []), ...o.resolving, ...o.promptCards];
  const source = visible.find((c) => c.id === q.source);
  const recovery = source?.spec.abilities?.play;
  // No unresolved parent continuation, Omega, or multi-target recovery is assumed.
  if (
    !source ||
    source.controller !== o.you ||
    source.spec.omega ||
    source.gainedTextBoxes?.length ||
    source.spec.conditionalAbilities?.length ||
    recovery?.length !== 1 ||
    recovery[0].kind !== 'target' ||
    recovery[0].operation !== 'returnHand' ||
    recovery[0].after ||
    (recovery[0].max ?? 1) !== 1 ||
    (q.max ?? 1) !== 1
  )
    return false;
  const capacity = publicPlayCapacity(o);
  if (!capacity.known || capacity.blocked || (o.turn === 1 && o.handOperations >= 1)) return false;
  const boxes = board.flatMap((c) => [c.spec, ...(c.gainedTextBoxes ?? [])].map((spec) => ({ spec, c })));
  for (const { spec: b, c } of boxes) {
    if (c.controller !== o.you && b.replacesEnemyActionPlayWithOwnLeftDestruction) return false;
    if (
      b.prohibitsForging ||
      b.forbiddenKeyOrdinal === 3 ||
      b.forgeRestrictions?.length ||
      b.forgeIntercept ||
      b.maxControllerForgesPerTurn !== undefined ||
      (b.cannotForgeAhead && me.keys.length > o.players[o.you === 0 ? 1 : 0].keys.length) ||
      b.keyTaxes?.some((t) => t.condition || typeof t.amount !== 'number') ||
      b.upgrade?.hostKeyTaxes?.some((t) => t.condition || typeof t.amount !== 'number') ||
      namedLock(b.abilities) ||
      b.bonusReplacements?.length
    )
      return false;
    if (
      b.onePlayPerType &&
      (b.onePlayPerType === 'self' ? c.controller === o.you : c.controller !== o.you) &&
      (!o.playedTypes || (o.playedTypes[o.you].action ?? 0) > 0)
    )
      return false;
    if (
      b.reactions?.some((r) =>
        [
          'cardPlayed',
          'creaturePlayed',
          'actionBeforePlay',
          'actionPlacedAfterPlay',
          'bonusResolved',
        ].includes(r.event),
      )
    )
      return false;
  }
  for (const e of o.lasting) {
    if (e.rule === 'noNamedPlayUse' && e.turn >= o.turn && e.affectedName === d.name) return false;
    if (e.appliesTo !== o.you || (e.begins ?? o.turn) > o.turn || e.turn < o.turn) continue;
    if (e.rule === 'onlyPlayHouse') {
      if (e.house !== d.house) return false;
      continue;
    }
    if (e.rule === 'playLimit') continue;
    if (e.rule === 'keyCost' && !e.countFilter && !e.keyTaxValue) continue;
    return false; // Includes noPlay/noActions, dynamic taxes and unmodeled play responses.
  }
  if (
    o.cardEffects.length ||
    !scalar(d.playAmberCost ?? 0) ||
    !scalar(d.minAmberToPlay ?? 0) ||
    amberAfterRecovery < Math.max(d.playAmberCost ?? 0, d.minAmberToPlay ?? 0)
  )
    return false;
  let pool = amberAfterRecovery - (d.playAmberCost ?? 0),
    won = false,
    budget = 16;
  const gainAllowed = !boxes.some(({ spec: b, c }) => c.controller !== o.you && b.capturesIncomingAmber);
  const blockedIcons = boxes.some(({ spec: b, c }) => c.controller !== o.you && b.blocksOpponentBonusIcons);
  if (!scalar(d.amber) || d.amber > 16) return false;
  const icons = card.resolvedBonusIcons ?? card.bonusIcons ?? Array<string>(d.amber).fill('amber');
  if (!blockedIcons) {
    if (icons.length > 16 || icons.some((x) => x !== 'amber') || (icons.length > 0 && !gainAllowed))
      return false;
    pool += icons.length;
  }
  const walk = (effects: readonly Effect[], depth = 0): boolean => {
    if (depth > 4) return false;
    for (const e of effects) {
      if (--budget < 0 || won) return false;
      if (e.kind === 'if') {
        const { left, right, comparison } = e.condition;
        if (
          typeof left !== 'object' ||
          left === null ||
          !('metric' in left) ||
          left.metric !== 'amber' ||
          (left.side !== undefined && left.side !== 'self') ||
          !scalar(right)
        )
          return false;
        const yes =
          comparison === 'gte'
            ? pool >= right
            : comparison === 'gt'
              ? pool > right
              : comparison === 'eq'
                ? pool === right
                : comparison === 'lt'
                  ? pool < right
                  : pool <= right;
        if (!walk(yes ? e.then : (e.otherwise ?? []), depth + 1)) return false;
      } else if (e.kind === 'resource') {
        if ((e.side !== undefined && e.side !== 'self') || !scalar(e.amount)) return false;
        if (e.operation === 'lose') pool = Math.max(0, pool - e.amount);
        else if (e.operation === 'gain' && gainAllowed) pool += e.amount;
        else return false;
      } else if (e.kind === 'forgeEffect') {
        const fixed = e.fixedCost,
          delta = e.delta ?? 0,
          reduction = e.reduction ?? 0;
        const minimum = e.minimumCost ?? 0;
        if (
          e.after?.length ||
          (e.color && me.keys.includes(e.color)) ||
          (fixed !== undefined && !scalar(fixed)) ||
          !scalar(delta) ||
          !scalar(reduction) ||
          !scalar(minimum)
        )
          return false;
        if (pool < Math.max(minimum, fixed ?? me.keyCost + delta - reduction)) return false;
        won = true;
      } else return false;
      if (!Number.isSafeInteger(pool)) return false;
    }
    return true;
  };
  return walk(d.abilities?.play ?? []) && won;
}
