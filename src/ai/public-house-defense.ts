/** Bounded, public next-action opportunities while choosing a house.
 * These probes are not referee legal actions and never certify that a key is denied.
 */
import type { CardView, House, LegalAction, Observation, Seat } from '../contracts/observation.js';
import { publicPlayCapacity } from './public-guidance-guards.js';
import { publicReapBlocked } from './toc-public-utility.js';

export interface HouseDefenseProjection {
  opponentAmber: number;
  opponentKeyCost: number;
  skipsOpponentForge: boolean;
  unresolvedValues: boolean;
}
export interface PublicHouseDefense {
  score: number;
  approximate: boolean;
  reasons: string[];
}
const scalar = (n: number) => Number.isSafeInteger(n) && n >= 0;
const houses = (c: CardView) => c.effective.houses ?? [c.effective.house];
const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
// Capability boundary, not another interpreter: arithmetic, choices and public
// targets still run through the existing evaluator. Hidden draws, borrowed uses,
// random outcomes and other unprojected continuations earn no emergency premium.
const projectedKinds = new Set([
  'gain',
  'loseOpponent',
  'capture',
  'steal',
  'draw',
  'chains',
  'resource',
  'if',
  'skipForge',
  'lasting',
  'target',
  'all',
  'self',
  'bound',
  'healSelf',
  'sacrificeSelf',
  'choose',
  'chooseHouse',
  'chooseCards',
  'bindCards',
  'loseThen',
  'forEach',
  'recur',
  'finishAction',
  // These are card-kind filters, not effect nodes in the structured tree.
  'creature',
  'artifact',
  'action',
  'upgrade',
]);
function hasNamedLock(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((x) => hasNamedLock(x, depth + 1));
  const r = value as Record<string, unknown>;
  return (
    r.kind === 'chooseForbiddenName' ||
    r.kind === 'forbidName' ||
    Object.values(r).some((x) => hasNamedLock(x, depth + 1))
  );
}

function hasStructuredEffect(
  value: unknown,
  matches: (r: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((x) => hasStructuredEffect(x, matches, depth + 1));
  const r = value as Record<string, unknown>;
  return matches(r) || Object.values(r).some((x) => hasStructuredEffect(x, matches, depth + 1));
}

/** Use only our visible cards and both public boards. Missing native effect/history
 * coverage permits an approximate opportunity, never a claim of future legality.
 * Known blockers and costs outside the small projection below veto the opportunity.
 */
export function assessPublicHouseDefense(
  o: Observation,
  house: House | null,
  project: (probe: Observation, actionId: string) => HouseDefenseProjection,
): PublicHouseDefense {
  const none = { score: 0, approximate: false, reasons: [] };
  const foeSeat: Seat = o.you === 0 ? 1 : 0,
    me = o.players[o.you],
    foe = o.players[foeSeat];
  if (
    !house ||
    o.phase !== 'house' ||
    o.activePlayer !== o.you ||
    o.winner !== null ||
    !o.legalActions.some((x) => x.action.kind === 'house' && x.action.house === house) ||
    foe.keys.length !== 2 ||
    foe.forgeBlocked === true ||
    foe.skipForgeTurn === o.turn + 1 ||
    foe.artifacts.some((c) => boxes(c).some((d) => d.skipForgeStep)) ||
    !scalar(foe.amber) ||
    !scalar(foe.forgeAvailable) ||
    !scalar(foe.keyCost) ||
    foe.forgeAvailable < foe.keyCost ||
    o.turnStep?.omega
  )
    return none;
  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  const allBoxes = board.flatMap((c) => boxes(c).map((d) => ({ c, d })));
  const current = o.lasting.filter((e) => (e.begins ?? o.turn) <= o.turn && e.turn >= o.turn);
  const active = current.filter((e) => e.appliesTo === o.you);
  const capacity = publicPlayCapacity(o);
  const historyKnown = o.publicStateCoverage?.turnHistoryComplete !== false;
  const namedLock = allBoxes.some(({ d }) => hasNamedLock(d.abilities));
  const attachments = (c: CardView) => board.filter((u) => u.attachedTo === c.id);
  const namedBlocked = (c: CardView) =>
    current.some((e) => e.rule === 'noNamedPlayUse' && e.affectedName === c.spec.name);
  const ordinaryText = (c: CardView) =>
    c.spec.id === c.definition &&
    !c.copiedDefinition &&
    !c.copiedCharacteristics &&
    !c.gainedTextBoxes?.length &&
    !c.spec.conditionalAbilities?.length &&
    !c.physicalParts?.length &&
    (o.turnUsage[c.spec.name] ?? 0) < 6 &&
    c.usesThisTurn < 6 &&
    !namedBlocked(c) &&
    !namedLock;
  // Do not simulate unprojected responses, conditional payments or acquired text.
  const unmodeledResponse = (events: string[]) =>
    allBoxes.some(({ d }) =>
      [...(d.reactions ?? []), ...(d.upgrade?.reactions ?? [])].some((r) => events.includes(r.event)),
    );
  const unmodeledLasting = (allowed: string[]) => current.some((e) => !allowed.includes(e.rule));
  const sharedRules = [
    'noNamedPlayUse',
    'keyCost',
    'noPlay',
    'noActions',
    'noCreatures',
    'playLimit',
    'onlyPlayHouse',
    'noMatchingPlay',
    'noUse',
    'noFight',
    'fightOnly',
    'noReap',
    'noReapHouse',
    'blankCreatures',
    'blankBoostNamed',
  ];

  const canPlay = (c: CardView): boolean => {
    const d = c.spec;
    if (
      c.owner !== o.you ||
      c.controller !== o.you ||
      !ordinaryText(c) ||
      !houses(c).includes(house) ||
      !['creature', 'artifact', 'action'].includes(d.kind) ||
      d.cannotPlay ||
      d.playCondition ||
      d.alpha ||
      d.mimicAction ||
      d.mimicCreature ||
      d.entersOpponentControl ||
      d.destroyIfFlank ||
      (d.destroyWithoutEnemy && !foe.battleline.length) ||
      !scalar(d.playAmberCost ?? 0) ||
      !scalar(d.minAmberToPlay ?? 0) ||
      me.amber < Math.max(d.playAmberCost ?? 0, d.minAmberToPlay ?? 0) ||
      (o.turn === 1 && (!historyKnown || o.handOperations >= 1)) ||
      (capacity.limit !== null && (!capacity.known || capacity.blocked)) ||
      active.some(
        (e) =>
          e.rule === 'noPlay' ||
          (e.rule === 'noActions' && d.kind === 'action') ||
          (e.rule === 'noCreatures' && d.kind === 'creature') ||
          (e.rule === 'onlyPlayHouse' && e.house !== d.house) ||
          (e.rule === 'noMatchingPlay' &&
            (!e.countFilter?.kind || e.countFilter.kind === d.kind) &&
            (!e.house || houses(c).includes(e.house))),
      ) ||
      unmodeledLasting([...sharedRules, 'creaturePlayGain', 'cardPlayDraw', 'reapGain', 'reapSteal']) ||
      unmodeledResponse([
        'cardPlayed',
        'creaturePlayed',
        'artifactPlayed',
        'creatureEntered',
        'upgradeEntered',
        'actionBeforePlay',
        'actionPlacedAfterPlay',
        'bonusResolved',
      ]) ||
      allBoxes.some(({ d: b }) => b.bonusReplacements?.length)
    )
      return false;
    if (
      current.some(
        (e) =>
          (e.rule === 'blankCreatures' && d.kind === 'creature') ||
          (e.rule === 'blankBoostNamed' && e.affectedName === d.name),
      ) ||
      (d.kind === 'artifact' && allBoxes.some(({ d: b }) => b.blanksArtifacts))
    )
      return false;
    for (const { c: source, d: b } of allBoxes) {
      if (
        b.onePlayPerType &&
        (b.onePlayPerType === 'self' ? source.controller === o.you : source.controller !== o.you) &&
        (!historyKnown || !o.playedTypes || (o.playedTypes[o.you][d.kind] ?? 0) > 0)
      )
        return false;
      if (d.kind === 'artifact' && source.controller !== o.you && b.opponentArtifactPlayTax) return false;
      if (
        d.kind === 'creature' &&
        ((source.controller === o.you && b.prohibitOwnCreatures) ||
          b.creaturePlayLimits?.length ||
          (b.forbidMorePowerfulCreaturePlay && c.effective.power > source.effective.power) ||
          b.upgrade?.hostForbidMorePowerfulEnemyPlay ||
          (b.noPlayCreaturesWhileAhead && me.battleline.length > foe.battleline.length))
      )
        return false;
    }
    return true;
  };
  const canUse = (c: CardView): boolean => {
    const d = c.spec,
      attached = attachments(c);
    return (
      c.controller === o.you &&
      c.ready &&
      !c.stunned &&
      ordinaryText(c) &&
      !d.useProhibitedIf &&
      !d.destroyFriendlyBeforeUse &&
      !d.useRequiresNeighborsHouse &&
      !d.requiresUntamedDiscard &&
      !d.animation &&
      !d.abilities?.afterUse?.length &&
      !attached.some((u) =>
        boxes(u).some(
          (b) =>
            b.upgrade?.cannotUse ||
            b.upgrade?.blanksHost ||
            b.upgrade?.hostUseProhibitedIf ||
            b.upgrade?.requiresDiscard ||
            b.upgrade?.reactions?.length ||
            b.upgrade?.abilities?.afterUse?.length,
        ),
      ) &&
      !o.cardEffects.some((e) => e.target === c.id) &&
      !active.some((e) => e.rule === 'noUse' || (d.kind === 'creature' && e.rule === 'fightOnly')) &&
      !current.some(
        (e) =>
          (d.kind === 'creature' && e.rule === 'blankCreatures') ||
          (e.rule === 'blankBoostNamed' && e.affectedName === d.name),
      ) &&
      !allBoxes.some(
        ({ c: source, d: b }) =>
          b.locksUsesOfStoredHouses ||
          b.grantsAbilities?.some((g) => g.abilities.afterUse?.length) ||
          (d.kind === 'artifact' &&
            (b.blanksArtifacts || (source.controller !== o.you && b.opponentArtifactUseTax))),
      ) &&
      !(
        d.kind === 'creature' &&
        foe.battleline.length &&
        (c.enraged || allBoxes.some(({ d: b }) => b.globalFightIfAble))
      ) &&
      !unmodeledResponse(['creatureUsed', 'artifactUsed', 'cardUsed']) &&
      !unmodeledLasting([...sharedRules, 'reapGain', 'reapSteal', 'creaturePlayGain', 'cardPlayDraw'])
    );
  };

  // Taking archives moves the entire visible batch. Foreign-owned cards return to
  // their owner; they are never counted as playable hand cards for us.
  const archives = me.archives ?? [];
  const mayTake =
    archives.length > 0 &&
    archives.length === me.archiveCount &&
    !allBoxes.some(({ d }) => d.forbidsArchiveStep) &&
    !(archives.some((c) => c.owner !== o.you) && allBoxes.some(({ d }) => d.locksForeignArchives));
  const ownArchives = mayTake ? archives.filter((c) => c.owner === o.you) : [];
  const afterPickup = (): Observation['players'] => {
    const players: Observation['players'] = [...o.players];
    players[o.you] = {
      ...me,
      hand: [...(me.hand ?? []), ...ownArchives],
      handCount: me.handCount + ownArchives.length,
      archives: [],
      archiveCount: 0,
    };
    // Read only public opponent fields, including when a caller deliberately
    // places throwing getters on the forbidden hand/archive properties.
    players[foeSeat] = {
      houses: foe.houses,
      amber: foe.amber,
      keys: foe.keys,
      keyCost: foe.keyCost,
      chains: foe.chains,
      skipForgeTurn: foe.skipForgeTurn,
      lastForgedTurn: foe.lastForgedTurn,
      forgedOn: foe.forgedOn,
      forgeAvailable: foe.forgeAvailable,
      forgeSources: foe.forgeSources,
      forgeBlocked: foe.forgeBlocked,
      deckList: foe.deckList,
      deckCount: foe.deckCount,
      handCount: foe.handCount + archives.length - ownArchives.length,
      archiveCount: foe.archiveCount,
      battleline: foe.battleline,
      artifacts: foe.artifacts,
      upgrades: foe.upgrades,
      discard: foe.discard,
      purged: foe.purged,
    };
    return players;
  };
  let best = 0,
    bestPath = '';
  const consider = (
    card: CardView,
    action: LegalAction['action'],
    path: string,
    fromArchives = false,
    useDescription?: LegalAction['useDescription'],
  ) => {
    const effects =
      action.kind === 'play'
        ? card.spec.abilities?.play
        : action.kind === 'reap'
          ? [
              ...(card.spec.abilities?.reap ?? []),
              ...attachments(card).flatMap((u) => u.spec.upgrade?.abilities?.reap ?? []),
            ]
          : useDescription?.effects;
    if (
      hasStructuredEffect(
        effects,
        (e) =>
          (typeof e.kind === 'string' && !projectedKinds.has(e.kind)) ||
          (e.kind === 'lasting' && (e.rule !== 'keyCost' || e.duration === 'turn')) ||
          (e.kind === 'steal' && e.thenDamage !== undefined),
      ) ||
      unmodeledResponse(['creatureCaptured', 'amberStolen', 'creatureDamaged', 'creatureDestroyed'])
    )
      return;
    const steals =
      hasStructuredEffect(effects, (e) => e.kind === 'steal' || e.operation === 'steal') ||
      (action.kind === 'reap' && active.some((e) => e.rule === 'reapSteal'));
    if (
      steals &&
      allBoxes.some(
        ({ c, d }) => c.controller !== o.you && (d.cannotStealCondition || d.upgrade?.cannotStealFrom),
      )
    )
      return;
    const captures =
      hasStructuredEffect(effects, (e) => e.kind === 'capture' || e.operation === 'capture') ||
      (action.kind === 'play' && (card.resolvedBonusIcons ?? card.bonusIcons ?? []).includes('capture'));
    // The shared evaluator changes pools, not the physical captured counters.
    // A later departure could refund this newly captured amber; exclude that
    // unsupported combination, including capture enhancements.
    if (
      captures &&
      hasStructuredEffect(
        effects,
        (e) =>
          e.kind === 'sacrificeSelf' ||
          e.kind === 'takeControl' ||
          ['destroy', 'damage', 'purge', 'archive', 'returnHand', 'deckTop', 'deckBottom'].includes(
            String(e.operation),
          ),
      )
    )
      return;
    const id = 'public-house-opportunity';
    const probe: Observation = {
      ...o,
      phase: 'main',
      activeHouse: house,
      players: fromArchives ? afterPickup() : o.players,
      legalActions: [{ id, action, ...(useDescription ? { useDescription } : {}) }],
    };
    const estimate = project(probe, id);
    if (
      estimate.unresolvedValues ||
      !Number.isFinite(estimate.opponentAmber) ||
      !Number.isFinite(estimate.opponentKeyCost)
    )
      return;
    const pressure = foe.amber - estimate.opponentAmber + estimate.opponentKeyCost - foe.keyCost;
    const value = estimate.skipsOpponentForge
      ? 25
      : 25 * Math.min(1, Math.max(0, pressure) / (foe.forgeAvailable - foe.keyCost + 1));
    if (value > best) {
      best = value;
      bestPath = `${path} ${card.spec.name}`;
    }
  };
  for (const c of me.hand ?? []) if (canPlay(c)) consider(c, { kind: 'play', card: c.id }, 'hand Play');
  for (const c of ownArchives)
    if (canPlay(c)) consider(c, { kind: 'play', card: c.id }, 'archive Play', true);
  for (const c of [...me.battleline, ...me.artifacts]) {
    if (!canUse(c)) continue;
    const activeHouse = houses(c).includes(house) || c.spec.anyHouseUse;
    if (
      activeHouse &&
      c.spec.kind === 'creature' &&
      // Use the real house observation: a synthetic probe must not be mistaken
      // for the native legal Reap proof accepted by publicReapBlocked.
      publicReapBlocked(o, c) !== true &&
      !c.spec.reapSourceConditions?.length &&
      !allBoxes.some(({ d }) => d.reapRestrictions?.length) &&
      !unmodeledResponse(['creatureReaped'])
    )
      consider(c, { kind: 'reap', card: c.id }, 'ready Reap');
    for (const trigger of ['action', 'omni'] as const) {
      const effects = c.spec.abilities?.[trigger];
      if (effects?.length && (activeHouse || trigger === 'omni'))
        consider(c, { kind: 'use', card: c.id }, `ready ${trigger === 'action' ? 'Action' : 'Omni'}`, false, {
          trigger,
          label: c.spec.name,
          effects,
        });
    }
  }
  return best > 0
    ? {
        score: best,
        approximate: true,
        reasons: [
          `public-house-defense: ${bestPath}; bounded next-action opportunity, not a guaranteed denial`,
        ],
      }
    : none;
}
