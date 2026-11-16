import { createHash } from 'node:crypto';
import type { Action, CardView, LegalAction, Observation, Phase, PlayerView, Seat } from '../contracts/observation.js';
import type { Policy } from './policies.js';

/** This is an AI execution limit, not a game rule or a change to legalActions. */
export const AI_LOOP_GUARD_VERSION = 'ai-loop-guard-v1' as const;
export const DEFAULT_AI_LOOP_LIMITS = Object.freeze({
  repeatLimit: 8,
  maxTurnActions: 512,
  resolutionGrace: 32,
});
export type LoopGuardAccounting = 'acknowledged' | 'observed-revision';
export interface LoopGuardLimits {
  repeatLimit: number;
  maxTurnActions: number;
  resolutionGrace: number;
}
export interface LoopGuardEvent {
  type: 'ai-loop-guard';
  version: typeof AI_LOOP_GUARD_VERSION;
  status: 'prepared' | 'accepted' | 'halted';
  reason: 'repeated-public-state' | 'turn-action-budget';
  outcome: 'replaced' | 'halted';
  haltReason?: 'no-legal-exit' | 'resolution-budget-exhausted';
  accounting: LoopGuardAccounting;
  actor: Seat;
  turn: number;
  revision: number;
  phase: Phase;
  proposedActionId: string;
  selectedActionId: string | null;
  stateFingerprint: string;
  repeatedActionCount: number;
  acceptedTurnActions: number;
  limits: LoopGuardLimits;
  publicStateCoverage?: Observation['publicStateCoverage'];
}
export interface AILoopGuardOptions extends Partial<LoopGuardLimits> {
  /** Called only for accepted replacements and terminal guard halts, never for a query. */
  onEvent?: (event: LoopGuardEvent) => void;
}
export interface GuardedAction {
  actionId: string;
  /** A proposal until acknowledge(..., true). Do not count this alone as a played intervention. */
  intervention?: LoopGuardEvent;
}
export interface LoopGuardSnapshot {
  version: typeof AI_LOOP_GUARD_VERSION;
  actor: Seat | null;
  turn: number | null;
  lastObservedRevision: number | null;
  acceptedTurnActions: number;
  observedRevisionAcknowledgements: number;
  explicitAcknowledgements: number;
  trackedStateActions: number;
  interventionCount: number;
  haltCount: number;
  eventsDropped: number;
  limits: LoopGuardLimits;
  lastEvent?: LoopGuardEvent;
}
/** Persist beside the accepted command, never a prepared/unissued decision. */
export interface LoopGuardCheckpoint extends LoopGuardSnapshot {
  occurrences: [string, number][];
  lastAccepted?: { revision: number; actionId: string };
  haltEvent?: LoopGuardEvent;
}

// Deliberately independent of core/replay (which imports the authoritative engine).
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const object = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + canonical(object[key]))
      .join(',') +
    '}'
  );
}

function pick(object: object, keys: readonly string[]): Record<string, unknown> {
  const record = object as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}
const OBSERVATION_FIELDS = [
  'publicStateCoverage',
  'prophecyActivatedThisTurn',
  'haunted',
  'nextCreatureUseRestriction',
  'creatureUseHistory',
  'friendlyExaltedThisTurn',
  'nextCreatureEntries',
  'tokenReferences',
  'previousChosenHouses',
  'playedTypes',
  'readinessProfile',
  'tide',
  'worldsCollide',
  'schemaVersion',
  'engineVersion',
  'rulesVersion',
  'catalogVersion',
  'turn',
  'you',
  'firstPlayer',
  'turnUsage',
  'playedThisTurn',
  'creaturesPlayedThisTurn',
  'activePlayer',
  'phase',
  'activeHouse',
  'controlLayers',
  'nextReady',
  'leaveEffects',
  'pending',
  'lasting',
  'knowledge',
  'permissions',
  'cardEffects',
  'houseRestrictions',
  'futureHouseRestrictions',
  'winner',
] as const satisfies readonly (keyof Observation)[];
const PLAYER_FIELDS = [
  'forgeBlocked',
  'houses',
  'amber',
  'keys',
  'keyCost',
  'chains',
  'skipForgeTurn',
  'lastForgedTurn',
  'forgedOn',
  'forgeAvailable',
  'forgeSources',
  'deckList',
  'deckCount',
  'handCount',
  'archiveCount',
] as const satisfies readonly (keyof PlayerView)[];
const CARD_FIELDS = [
  'mineralized',
  'tokenCreature',
  'temporaryAnimation',
  'animatedArtifact',
  'copiedAnimation',
  'copiedCharacteristics',
  'giganticBonusIcons',
  'bonusIcons',
  'bonusHouses',
  'copiedBonusHouses',
  'copiedBonusIcons',
  'form',
  'retainedUpgradeDefinition',
  'copiedForm',
  'warded',
  'enraged',
  'markers',
  'printing',
  'id',
  'definition',
  'owner',
  'controller',
  'ready',
  'damage',
  'armorUsed',
  'elusiveUsed',
  'captured',
  'stunned',
  'powerCounters',
  'attachedTo',
  'enteredController',
  'foreignArchiveHolder',
  'copiedDefinition',
  'printedHouse',
  'copiedHouse',
  'tokenReverse',
  'readiness',
  'physicalParts',
  'resolvedBonusIcons',
  'spec',
  'gainedTextBoxes',
  'effective',
  'usesThisTurn',
] as const satisfies readonly (keyof CardView)[];
function publicCard(card: CardView): Record<string, unknown> {
  return pick(card, CARD_FIELDS);
}
function publicPlayer(player: PlayerView, seat: number, you: Seat): Record<string, unknown> {
  const result = pick(player, PLAYER_FIELDS);
  for (const zone of ['battleline', 'artifacts', 'upgrades', 'purged', 'discard', 'faceupArchives'] as const)
    if (player[zone]) result[zone] = player[zone]!.map(publicCard);
  if (player.revealedTop) result.revealedTop = publicCard(player.revealedTop);
  if (seat === you) {
    if (player.hand) result.hand = player.hand.map(publicCard);
    if (player.archives) result.archives = player.archives.map(publicCard);
  }
  return result;
}
function publicAction(action: Action): Record<string, unknown> {
  return pick(action, [
    'kind',
    'slot',
    'face',
    'card',
    'color',
    'source',
    'house',
    'entryOverride',
    'otherHalf',
    'flank',
    'position',
    'target',
    'permission',
    'copy',
    'asUpgrade',
    'ability',
    'index',
    'option',
  ]);
}

/**
 * A conservative public-state projection: physical/opaque identities, zone order, all visible
 * card properties, remaining deck/hand/archive counts, resources, effects and action semantics
 * remain intact. In particular, rule-of-six usage, played counts and distinct-creature history
 * can have future value and are NOT treated as empty bookkeeping.
 *
 * The only normalized counters are those whose current referee semantics are zero/nonzero
 * or set membership: handOperations, turnStep.performed (Alpha), discard occurrence and
 * discarded houses. Their unbounded increments otherwise conceal the Scythe discard/return
 * cycle. Update this projection/version if rules ever give those exact counts new meaning.
 *
 * Equality means repeated observable state, not proof about hidden cards or incomplete adapters.
 * Diverging states are still bounded by the generous, separate turn action budget.
 */
export function publicProgressFingerprint(o: Observation): string {
  const material = {
    ...pick(o, OBSERVATION_FIELDS),
    players: o.players.map((player, seat) => publicPlayer(player, seat, o.you)),
    resolving: o.resolving.map(publicCard),
    promptCards: o.promptCards.map(publicCard),
    underCards: o.underCards.map((group) => ({
      ...pick(group, ['source', 'count', 'faceUp']),
      ...(group.cards ? { cards: group.cards.map(publicCard) } : {}),
    })),
    spanglerCards: o.spanglerCards.map((group) => ({
      source: group.source,
      cards: group.cards.map(publicCard),
    })),
    ...(o.prophecies
      ? {
          prophecies: o.prophecies.map((prophecy) => ({
            ...pick(prophecy, ['id', 'owner', 'faces', 'face', 'active', 'count', 'revealed', 'namedHouse']),
            ...(prophecy.cards && (prophecy.owner === o.you || prophecy.revealed)
              ? { cards: prophecy.cards.map(publicCard) }
              : {}),
          })),
        }
      : {}),
    handOperations: Number(o.handOperations > 0),
    ...(o.turnStep
      ? {
          turnStep: {
            step: o.turnStep.step,
            omega: o.turnStep.omega,
            performed: o.turnStep.performed.map((n) => Number(n > 0)),
          },
        }
      : {}),
    ...(o.interactionCounters
      ? {
          interactionCounters: {
            reaps: o.interactionCounters.reaps,
            discarded: o.interactionCounters.discarded.map((n) => Number(n > 0)),
          },
        }
      : {}),
    publicCounters: {
      playedByHouse: o.publicCounters.playedByHouse,
      discardedHouses: o.publicCounters.discardedHouses.map((houses) => [...new Set(houses)].sort()),
      creaturesPlayedLastTurn: o.publicCounters.creaturesPlayedLastTurn,
      enemyFightDeaths: o.publicCounters.enemyFightDeaths,
      creaturesUsed: o.publicCounters.creaturesUsed.map((use) => pick(use, ['use', 'currentCard'])),
    },
    // Action IDs are transport identities; the actual actions and effective use semantics matter.
    legalActions: o.legalActions
      .map(({ action, useDescription }) =>
        canonical({
          action: publicAction(action),
          ...(useDescription
            ? { useDescription: pick(useDescription, ['trigger', 'label', 'effects']) }
            : {}),
        }),
      )
      .sort(),
  };
  return createHash('sha256').update(canonical(material)).digest('hex');
}

export class AILoopHaltError extends Error {
  readonly code = 'AI_LOOP_GUARD_HALT' as const;
  readonly event: LoopGuardEvent;
  constructor(event: LoopGuardEvent) {
    super(`AI loop guard halted: ${event.reason}/${event.haltReason}`);
    this.name = 'AILoopHaltError';
    this.event = structuredClone(event);
  }
}
export function isAILoopHaltError(error: unknown): error is AILoopHaltError {
  if (error instanceof AILoopHaltError) return true;
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; event?: Partial<LoopGuardEvent> };
  return (
    e.code === 'AI_LOOP_GUARD_HALT' &&
    e.event?.type === 'ai-loop-guard' &&
    e.event.version === AI_LOOP_GUARD_VERSION &&
    e.event.status === 'halted'
  );
}

interface PreparedAction {
  revision: number;
  actor: Seat;
  turn: number;
  actionId: string;
  key: string;
  intervention?: LoopGuardEvent;
}

/** One instance belongs to one match and seat. The owner must reset it when replacing a match. */
export class AILoopGuard {
  readonly limits: Readonly<LoopGuardLimits>;
  private readonly onEvent?: (event: LoopGuardEvent) => void;
  private actor: Seat | null = null;
  private turn: number | null = null;
  private lastObservedRevision: number | null = null;
  private acceptedTurnActions = 0;
  private observedRevisionAcknowledgements = 0;
  private explicitAcknowledgements = 0;
  private readonly occurrences = new Map<string, number>();
  private pending?: PreparedAction;
  private lastAccepted?: { revision: number; actionId: string };
  private halt?: AILoopHaltError;
  private readonly events: LoopGuardEvent[] = [];
  private lastEvent?: LoopGuardEvent;
  private interventionCount = 0;
  private haltCount = 0;
  private eventsDropped = 0;

  constructor(options: AILoopGuardOptions = {}) {
    const { onEvent, ...overrides } = options;
    const limits = { ...DEFAULT_AI_LOOP_LIMITS, ...overrides };
    for (const [name, value] of Object.entries(limits)) {
      const minimum = name === 'resolutionGrace' ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < minimum || value > 100_000)
        throw new Error(`Invalid AI loop guard ${name}`);
    }
    this.limits = Object.freeze(limits);
    this.onEvent = onEvent;
  }

  /** No executed-action count changes here. A discarded/rejected proposal costs no budget. */
  select(
    o: Observation,
    proposedActionId: string,
    preferredActionIds: readonly string[] = [],
  ): GuardedAction {
    this.synchronize(o);
    if (this.halt) throw this.halt;
    if (o.winner !== null || o.activePlayer !== o.you || o.legalActions.length === 0)
      throw new Error('No active legal AI decision for loop guard');
    const proposed = o.legalActions.find((item) => item.id === proposedActionId);
    if (!proposed) throw new Error('AI loop guard received an illegal proposed action');
    const fingerprint = publicProgressFingerprint(o);
    const keyFor = (item: LegalAction) => fingerprint + ':' + canonical(publicAction(item.action));
    const countFor = (item: LegalAction) => this.occurrences.get(keyFor(item)) ?? 0;
    // A factory and its outer controller can share one guard. Re-selecting the factory's
    // already-guarded result must preserve the original intervention until the host acks it.
    if (
      this.pending?.revision === o.revision &&
      this.pending.actionId === proposedActionId &&
      this.pending.key === keyFor(proposed)
    )
      return {
        actionId: proposedActionId,
        ...(this.pending.intervention ? { intervention: structuredClone(this.pending.intervention) } : {}),
      };
    const repeatedActionCount = countFor(proposed);
    const overTurnBudget = this.acceptedTurnActions >= this.limits.maxTurnActions;
    const reason: LoopGuardEvent['reason'] = overTurnBudget ? 'turn-action-budget' : 'repeated-public-state';
    const eventBase = {
      type: 'ai-loop-guard' as const,
      version: AI_LOOP_GUARD_VERSION,
      status: 'prepared' as const,
      reason,
      accounting:
        this.observedRevisionAcknowledgements > 0
          ? ('observed-revision' as const)
          : ('acknowledged' as const),
      actor: o.you,
      turn: o.turn,
      revision: o.revision,
      phase: o.phase,
      proposedActionId,
      stateFingerprint: fingerprint,
      repeatedActionCount,
      acceptedTurnActions: this.acceptedTurnActions,
      limits: { ...this.limits },
      ...(o.publicStateCoverage ? { publicStateCoverage: structuredClone(o.publicStateCoverage) } : {}),
    };
    if (this.acceptedTurnActions >= this.limits.maxTurnActions + this.limits.resolutionGrace)
      return this.stop({
        ...eventBase,
        outcome: 'halted',
        status: 'halted',
        selectedActionId: null,
        haltReason: 'resolution-budget-exhausted',
      });

    let selected = proposed;
    const needsEscape = overTurnBudget || repeatedActionCount >= this.limits.repeatLimit;
    if (needsEscape) {
      const eligible = o.legalActions.filter((item) => countFor(item) < this.limits.repeatLimit);
      // These are actual offered actions. Never manufacture an endTurn inside a required prompt.
      const exit = ['endTurn', 'done', 'leaveArchives', 'keep']
        .map((kind) => eligible.find((item) => item.action.kind === kind))
        .find((item) => item !== undefined);
      const preferred = preferredActionIds
        .map((id) => eligible.find((item) => item.id === id))
        .find((item) => item !== undefined);
      const replacement =
        exit ?? preferred ?? (overTurnBudget && eligible.includes(proposed) ? proposed : eligible[0]);
      if (!replacement)
        return this.stop({
          ...eventBase,
          outcome: 'halted',
          status: 'halted',
          selectedActionId: null,
          haltReason: 'no-legal-exit',
        });
      selected = replacement;
    }
    const intervention: LoopGuardEvent | undefined =
      selected.id === proposedActionId
        ? undefined
        : {
            ...eventBase,
            outcome: 'replaced',
            selectedActionId: selected.id,
          };
    this.pending = {
      revision: o.revision,
      actor: o.you,
      turn: o.turn,
      actionId: selected.id,
      key: keyFor(selected),
      ...(intervention ? { intervention } : {}),
    };
    return {
      actionId: selected.id,
      ...(intervention ? { intervention: structuredClone(intervention) } : {}),
    };
  }

  /** Call exactly after the host accepted/rejected the command. Repeated accepted acknowledgements are idempotent. */
  acknowledge(revision: number, actionId: string, accepted = true): void {
    this.commit(revision, actionId, accepted, 'acknowledged');
  }

  /** Cancel a superseded/unissued preparation; accepted history and budgets are unchanged. */
  discardPrepared(): void {
    this.pending = undefined;
  }

  /**
   * Compatibility for a Policy-only caller with no acceptance hook. Advancing revision confirms at
   * most its previous proposal; a repeated query never confirms execution. Explicit acknowledge
   * clears that proposal, so factory+controller/arena guards do not double count it.
   * The caller must own one sequential policy per match/seat; use acknowledged mode for branches,
   * remote retries and any host that can reject or replace a proposed command.
   */
  observe(o: Observation): void {
    if (
      this.pending &&
      o.you === this.pending.actor &&
      o.turn >= this.pending.turn &&
      o.revision > this.pending.revision &&
      (this.lastObservedRevision === null || o.revision >= this.lastObservedRevision)
    )
      this.commit(this.pending.revision, this.pending.actionId, true, 'observed-revision');
    this.synchronize(o);
  }

  /** A new match must call reset even when its numeric revision/turn happens to match the old one. */
  reset(): void {
    this.actor = null;
    this.turn = null;
    this.lastObservedRevision = null;
    this.clearTurn();
    this.events.length = 0;
    this.lastEvent = undefined;
    this.interventionCount = 0;
    this.haltCount = 0;
    this.eventsDropped = 0;
  }

  drainEvents(): LoopGuardEvent[] {
    return this.events.splice(0).map((event) => structuredClone(event));
  }

  snapshot(): LoopGuardSnapshot {
    return {
      version: AI_LOOP_GUARD_VERSION,
      actor: this.actor,
      turn: this.turn,
      lastObservedRevision: this.lastObservedRevision,
      acceptedTurnActions: this.acceptedTurnActions,
      observedRevisionAcknowledgements: this.observedRevisionAcknowledgements,
      explicitAcknowledgements: this.explicitAcknowledgements,
      trackedStateActions: this.occurrences.size,
      interventionCount: this.interventionCount,
      haltCount: this.haltCount,
      eventsDropped: this.eventsDropped,
      limits: { ...this.limits },
      ...(this.lastEvent ? { lastEvent: structuredClone(this.lastEvent) } : {}),
    };
  }
  getSnapshot(): LoopGuardSnapshot {
    return this.snapshot();
  }

  checkpoint(): LoopGuardCheckpoint {
    return {
      ...this.snapshot(),
      occurrences: [...this.occurrences.entries()].sort(([a], [b]) => a.localeCompare(b)),
      ...(this.lastAccepted ? { lastAccepted: { ...this.lastAccepted } } : {}),
      ...(this.halt ? { haltEvent: structuredClone(this.halt.event) } : {}),
    };
  }

  /** Pure transaction preview: write this before COMMIT, then acknowledge only on COMMIT success. */
  previewAccepted(revision: number, actionId: string): LoopGuardCheckpoint {
    if (this.lastAccepted?.revision === revision && this.lastAccepted.actionId === actionId)
      return this.checkpoint();
    const pending = this.pending;
    if (!pending || pending.revision !== revision || pending.actionId !== actionId)
      throw new Error('No matching prepared AI loop guard action');
    const checkpoint = this.checkpoint();
    const occurrences = new Map(checkpoint.occurrences);
    occurrences.set(pending.key, (occurrences.get(pending.key) ?? 0) + 1);
    checkpoint.occurrences = [...occurrences.entries()].sort(([a], [b]) => a.localeCompare(b));
    checkpoint.trackedStateActions = occurrences.size;
    checkpoint.acceptedTurnActions++;
    checkpoint.explicitAcknowledgements++;
    checkpoint.lastAccepted = { revision, actionId };
    if (pending.intervention) {
      checkpoint.interventionCount++;
      checkpoint.lastEvent = {
        ...structuredClone(pending.intervention),
        status: 'accepted',
        accounting: 'acknowledged',
      };
      if (this.events.length >= this.limits.maxTurnActions + this.limits.resolutionGrace + 1)
        checkpoint.eventsDropped++;
    }
    return checkpoint;
  }

  /** Limits/version must match the host's frozen configuration. No proposal or callback is replayed. */
  restore(checkpoint: LoopGuardCheckpoint): void {
    const c = structuredClone(checkpoint);
    const invalid = () => {
      throw new Error('Invalid AI loop guard checkpoint');
    };
    const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
    if (!c || c.version !== AI_LOOP_GUARD_VERSION || canonical(c.limits) !== canonical(this.limits))
      invalid();
    if (
      ![null, 0, 1].includes(c.actor) ||
      !(c.turn === null || count(c.turn)) ||
      !(c.lastObservedRevision === null || count(c.lastObservedRevision))
    )
      invalid();
    if (
      [c.actor, c.turn, c.lastObservedRevision].some((n) => n === null) &&
      ![c.actor, c.turn, c.lastObservedRevision].every((n) => n === null)
    )
      invalid();
    for (const n of [
      c.acceptedTurnActions,
      c.observedRevisionAcknowledgements,
      c.explicitAcknowledgements,
      c.trackedStateActions,
      c.interventionCount,
      c.haltCount,
      c.eventsDropped,
    ])
      if (!count(n)) invalid();
    if (
      c.acceptedTurnActions > this.limits.maxTurnActions + this.limits.resolutionGrace ||
      c.observedRevisionAcknowledgements + c.explicitAcknowledgements !== c.acceptedTurnActions ||
      !Array.isArray(c.occurrences) ||
      c.occurrences.length !== c.trackedStateActions ||
      c.occurrences.length > c.acceptedTurnActions
    )
      invalid();
    const occurrences = new Map<string, number>();
    let sum = 0;
    for (const entry of c.occurrences) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        entry[0].length > 65536 ||
        !/^[a-f0-9]{64}:/.test(entry[0]) ||
        !count(entry[1]) ||
        entry[1] < 1 ||
        occurrences.has(entry[0])
      )
        invalid();
      occurrences.set(entry[0], entry[1]);
      sum += entry[1];
    }
    if (sum !== c.acceptedTurnActions || (c.actor === null && c.acceptedTurnActions !== 0)) invalid();
    if (
      c.lastAccepted &&
      (!count(c.lastAccepted.revision) ||
        typeof c.lastAccepted.actionId !== 'string' ||
        c.lastObservedRevision === null ||
        c.lastAccepted.revision > c.lastObservedRevision)
    )
      invalid();
    if (c.acceptedTurnActions > 0 !== !!c.lastAccepted) invalid();
    for (const event of [c.lastEvent, c.haltEvent])
      if (
        event &&
        (event.type !== 'ai-loop-guard' ||
          event.version !== AI_LOOP_GUARD_VERSION ||
          !['accepted', 'halted'].includes(event.status) ||
          canonical(event.limits) !== canonical(this.limits))
      )
        invalid();
    if (
      c.haltEvent &&
      (c.haltEvent.status !== 'halted' || c.haltEvent.actor !== c.actor || c.haltEvent.turn !== c.turn)
    )
      invalid();
    this.reset();
    this.actor = c.actor;
    this.turn = c.turn;
    this.lastObservedRevision = c.lastObservedRevision;
    this.acceptedTurnActions = c.acceptedTurnActions;
    this.observedRevisionAcknowledgements = c.observedRevisionAcknowledgements;
    this.explicitAcknowledgements = c.explicitAcknowledgements;
    for (const [key, n] of occurrences) this.occurrences.set(key, n);
    this.lastAccepted = c.lastAccepted;
    this.interventionCount = c.interventionCount;
    this.haltCount = c.haltCount;
    this.eventsDropped = c.eventsDropped;
    this.lastEvent = c.lastEvent;
    if (c.haltEvent) this.halt = new AILoopHaltError(c.haltEvent);
  }

  private clearTurn(): void {
    this.occurrences.clear();
    this.acceptedTurnActions = 0;
    this.observedRevisionAcknowledgements = 0;
    this.explicitAcknowledgements = 0;
    this.pending = undefined;
    this.lastAccepted = undefined;
    this.halt = undefined;
  }

  private synchronize(o: Observation): void {
    if (!Number.isSafeInteger(o.revision) || o.revision < 0 || !Number.isSafeInteger(o.turn) || o.turn < 0)
      throw new Error('Invalid AI loop guard observation epoch');
    if (o.you !== 0 && o.you !== 1) throw new Error('Invalid AI loop guard actor');
    if (
      this.actor !== o.you ||
      this.turn !== o.turn ||
      (this.lastObservedRevision !== null && o.revision < this.lastObservedRevision)
    )
      this.clearTurn();
    else if (this.pending && this.pending.revision !== o.revision) this.pending = undefined;
    this.actor = o.you;
    this.turn = o.turn;
    this.lastObservedRevision = o.revision;
  }

  private commit(
    revision: number,
    actionId: string,
    accepted: boolean,
    accounting: LoopGuardAccounting,
  ): void {
    if (this.lastAccepted?.revision === revision) {
      if (this.lastAccepted.actionId !== actionId || !accepted)
        throw new Error('Conflicting AI loop guard acknowledgement');
      return;
    }
    const pending = this.pending;
    if (!pending || pending.revision !== revision || pending.actionId !== actionId)
      throw new Error('No matching prepared AI loop guard action');
    this.pending = undefined;
    if (!accepted) return;
    this.lastAccepted = { revision, actionId };
    this.occurrences.set(pending.key, (this.occurrences.get(pending.key) ?? 0) + 1);
    this.acceptedTurnActions++;
    if (accounting === 'acknowledged') this.explicitAcknowledgements++;
    else this.observedRevisionAcknowledgements++;
    if (pending.intervention) this.publish({ ...pending.intervention, status: 'accepted', accounting });
  }

  private stop(event: LoopGuardEvent): never {
    this.pending = undefined;
    this.halt = new AILoopHaltError(event);
    this.publish(event);
    throw this.halt;
  }

  private publish(event: LoopGuardEvent): void {
    const copy = structuredClone(event);
    this.lastEvent = copy;
    if (event.status === 'accepted') this.interventionCount++;
    else if (event.status === 'halted') this.haltCount++;
    const capacity = this.limits.maxTurnActions + this.limits.resolutionGrace + 1;
    if (this.events.length >= capacity) {
      this.events.shift();
      this.eventsDropped++;
    }
    this.events.push(copy);
    this.onEvent?.(structuredClone(copy));
  }
}

const policyGuards = new WeakMap<Policy, AILoopGuard>();
export interface GuardPolicyOptions {
  guard?: AILoopGuard;
  accounting?: LoopGuardAccounting;
}
/** Factory adapter. Wrap once after existing reordering/strategy selection, never before it. */
export function guardPolicy(original: Policy, options: GuardPolicyOptions = {}): Policy {
  const existing = policyGuards.get(original);
  if (existing) {
    if (options.guard && options.guard !== existing)
      throw new Error('Policy already has another AI loop guard');
    return original;
  }
  const guard = options.guard ?? new AILoopGuard();
  const accounting = options.accounting ?? 'observed-revision';
  const policy: Policy = (o) => {
    if (accounting === 'observed-revision') guard.observe(o);
    return guard.select(o, original(o)).actionId;
  };
  policyGuards.set(policy, guard);
  return policy;
}
export function getPolicyLoopGuard(policy: Policy): AILoopGuard | undefined {
  return policyGuards.get(policy);
}
