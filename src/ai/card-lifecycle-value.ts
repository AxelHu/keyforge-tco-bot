/** Public card movement and bounded opportunity value. No Game, private frames, deck order or ranker. */
import type { CardView, Observation, Seat } from '../contracts/observation.js';
import { publicRefillForecast } from './public-refill-planning.js';
import { refillGuidanceStatus } from './public-guidance-guards.js';

export interface PublicCardLocation {
  seat: Seat;
  zone: 'hand' | 'archives' | 'discard' | 'purged' | 'deck' | 'battleline' | 'artifacts' | 'upgrades' | 'resolving';
  position?: 'top' | 'bottom' | 'unknown';
}
export interface PublicCardUseValue {
  /** Utility to the owner, excluding terminal/urgency bonuses. */
  score: number;
  approximate: boolean;
  playableNow: boolean;
  currentScore?: number;
  /** Bounded current-window priority only; never part of retained material Q or a terminal claim. */
  currentKeyPriority?: boolean;
}
export interface PublicCardLifecycleContext {
  actor?: Seat;
  /** Only a caller's publicly projected location may override the visible location. */
  from?: PublicCardLocation;
  archiveTo?: Seat;
  archiveReturnToOwner?: boolean;
  /** The candidate consumer settles a shared current hand window exactly once. */
  deferCurrentHandOpportunity?: boolean;
  useValue?: (card: CardView, owner: Seat) => PublicCardUseValue | undefined;
}
export interface PublicCardMove {
  from: PublicCardLocation;
  to: PublicCardLocation;
  requestedOperation: string;
  actualOperation: string;
  replaced: boolean;
  /** Public replacement marker after this movement; null means the old marker resets. */
  foreignArchiveHolder: Seat | null;
}
export interface PublicCardLifecycleAssessment {
  /** Card opportunity difference only. Refill displacement is settled once for the full candidate. */
  score: number;
  affected: boolean;
  move?: PublicCardMove;
  ruleUncertain: boolean;
  utilityApproximate: boolean;
  /** Direct movement is known, but its triggered continuation is outside this bounded model. */
  continuationUncertain?: boolean;
  continuationKinds?: ('scrap' | 'hand-discard-reaction' | 'archive-after-discard' | 'leave-play')[];
  reasons: string[];
}
export interface PublicLifecycleCounts { hand: number; deck: number; discard: number; }
export interface PublicLifecycleRefillDelta {
  score: number;
  /** Absolute seats. */
  drawDelta: [number, number];
  approximate: boolean;
}
const seats = [0, 1] as const;
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
const inPlay = (location: PublicCardLocation) => ['battleline', 'artifacts', 'upgrades'].includes(location.zone);
const validCount = (n: number) => Number.isSafeInteger(n) && n >= 0;
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const sameLocation = (a: PublicCardLocation, b: PublicCardLocation) => a.seat === b.seat && a.zone === b.zone;
const relocation = new Set(['archive', 'foreignArchive', 'returnHand', 'discard', 'purge', 'deckTop', 'deckBottom', 'shuffleDeck', 'shuffleIntoDeck']);

/** Prompt faces alone do not prove a zone. Revealed top/faceup archives do. */
export function publicCardLocation(o: Observation, c: CardView): PublicCardLocation | undefined {
  for (const seat of seats) {
    const p = o.players[seat];
    for (const zone of ['hand', 'archives', 'discard', 'purged', 'battleline', 'artifacts', 'upgrades'] as const)
      if ((seat === o.you || (zone !== 'hand' && zone !== 'archives')) &&
        p[zone]?.some((x) => x.id === c.id)) return { seat, zone };
    if (p.faceupArchives?.some((x) => x.id === c.id)) return { seat, zone: 'archives' };
    if (p.revealedTop?.id === c.id) return { seat, zone: 'deck', position: 'top' };
  }
  if (o.resolving.some((x) => x.id === c.id)) return { seat: c.owner, zone: 'resolving' };
  return undefined;
}

/** A current legal self-return is this physical card's own option. Future shared
 * recovery sources are not allocated once per card: that needs a group opportunity model. */
function hasNativeReturn(o: Observation, c: CardView, from: PublicCardLocation): boolean {
  return from.zone === 'discard' && o.legalActions.some((x) =>
    x.action.kind === 'returnDiscard' && x.action.card === c.id);
}

interface Opportunity { value: number; approximate: boolean; reasons: string[]; }
/** Delay estimates are explicitly heuristic. Only a real shuffle supplies an exchangeable n/N model. */
function opportunity(
  o: Observation, c: CardView, location: PublicCardLocation, use: PublicCardUseValue,
  move?: PublicCardMove,
): Opportunity {
  const quality = Math.max(0, use.score);
  const result = (value: number, reason: string, approximate = true): Opportunity =>
    ({ value, approximate: approximate || use.approximate, reasons: [reason] });
  if (inPlay(location)) return result(0, 'board value belongs to its existing consumer', false);
  if (location.zone === 'resolving') {
    if (c.spec.kind !== 'action') return result(0, 'entry resolution belongs to its existing consumer', false);
    const later = opportunity(o, c, { seat: c.owner, zone: 'discard' }, use);
    return { ...later, reasons: ['normal resolving action retains its later discard option', ...later.reasons] };
  }
  if (location.zone === 'purged')
    return result(0, 'purged card has no normal-cycle access; shared future recovery is not allocated', false);
  if (location.zone === 'hand') {
    return c.owner === o.you && location.seat === o.you && use.playableNow
      ? result(Math.max(quality / 2, use.currentScore ?? quality), 'normal current play or later retention opportunity', use.approximate)
      : result(quality / 2, 'retained hand card needs a later play opportunity');
  }
  if (location.zone === 'archives') {
    // Foreign archives belong to the holder's pickup step; the physical owner gets the returned card.
    // A live lock can delay that return. No opposing house/pickup choice is assumed.
    const locked = c.owner !== location.seat && board(o).some((x) =>
      x.controller === location.seat && boxes(x).some((d) => d.locksForeignArchives));
    const archiveForbidden = board(o).some((x) => boxes(x).some((d) => d.forbidsArchiveStep));
    return result(quality / (locked || archiveForbidden ? 3 : 2),
      locked ? 'foreign archive access waits for the public lock to leave'
        : archiveForbidden ? 'archive access is currently prohibited'
          : location.seat === c.owner ? 'retained archive card is available at a later pickup'
            : 'owner return depends on the foreign holder archive pickup');
  }
  const p = o.players[c.owner];
  const refill = publicRefillForecast(o, p.handCount, p.deckCount, c.owner);
  const window = Math.max(1, refill.target);
  if (location.zone === 'discard') {
    const recoverable = hasNativeReturn(o, c, location);
    const delay = recoverable ? 1 : 2 + Math.floor(p.deckCount / window);
    return result(quality / (1 + delay),
      recoverable
        ? 'currently legal native self-return shortens this card access'
        : 'discard access waits for a later cycle; only public deck size is used');
  }
  const entersDeck = move && sameLocation(location, move.to) && !sameLocation(move.from, move.to);
  const deckCount = Math.max(1, p.deckCount + Number(entersDeck));
  if (location.position === 'top') return result(quality / (refill.draws > 0 ? 2 : 3),
    refill.draws > 0 ? 'known top card fits the next normal refill' : 'known top card has no current refill slot');
  const fullTraversalDelay = Math.max(1, Math.ceil(deckCount / window));
  if (move && sameLocation(location, move.to) && ['shuffleDeck', 'shuffleIntoDeck'].includes(move.actualOperation)) {
    const probability = Math.min(refill.draws, deckCount) / deckCount;
    return result(quality * (probability / 2 + (1 - probability) / (2 + fullTraversalDelay)),
      'actual shuffle: next-refill inclusion uses draws/deck count; remaining access stays discounted');
  }
  return result(quality / (1 + fullTraversalDelay), location.position === 'bottom'
    ? 'known bottom placement waits for public deck traversal'
    : 'unlocated deck card uses a traversal horizon without inventing an order');
}

export function assessCardLifecycle(
  o: Observation, c: CardView, operation: string, context: PublicCardLifecycleContext,
  fallbackQuality = 1,
): PublicCardLifecycleAssessment | undefined {
  if (!relocation.has(operation)) return undefined;
  const result: PublicCardLifecycleAssessment = { score: 0, affected: false,
    ruleUncertain: false, utilityApproximate: false, reasons: [] };
  const from = context.from ?? publicCardLocation(o, c);
  if (!from) return { ...result, ruleUncertain: true, utilityApproximate: true,
    reasons: ['public source zone is not established'] };
  if (operation === 'foreignArchive' && !inPlay(from)) return result;
  if (inPlay(from) && c.warded) return result; // The board consumer values consuming the Ward.
  if (from.zone === 'archives' && c.foreignArchiveHolder === from.seat && c.owner !== from.seat &&
    board(o).some((x) => x.controller === from.seat && boxes(x).some((d) => d.locksForeignArchives))) {
    result.reasons.push('live public foreign-archive lock prevents departure');
    return result;
  }
  if (from.zone === 'archives' && o.publicStateCoverage?.effectsComplete === false &&
    (c.foreignArchiveHolder !== from.seat || c.owner !== from.seat)) {
    return { ...result, ruleUncertain: true, utilityApproximate: true,
      reasons: ['incomplete public archive replacement/lock coverage does not establish a destination'] };
  }
  if (operation === 'discard' && from.zone === 'hand' && board(o).some((x) =>
    boxes(x).some((d) => d.upgrade?.discardHandsUnderHost) && x.attachedTo &&
    board(o).some((host) => host.id === x.attachedTo && host.spec.kind === 'creature'))) {
    return { ...result, ruleUncertain: true, utilityApproximate: true,
      reasons: ['public hand-discard replacement requires an unresolved host choice'] };
  }
  const destination: PublicCardLocation = operation === 'returnHand' ? { seat: c.owner, zone: 'hand' }
    : operation === 'purge' ? { seat: c.owner, zone: 'purged' }
      : operation === 'discard' ? { seat: c.owner, zone: 'discard' }
        : operation === 'archive' || operation === 'foreignArchive'
          ? { seat: operation === 'foreignArchive' ? context.archiveTo ?? context.actor ?? o.you : c.owner, zone: 'archives' }
          : { seat: c.owner, zone: 'deck', position: operation === 'deckTop' ? 'top' : operation === 'deckBottom' ? 'bottom' : 'unknown' };
  const replacement = from.zone === 'archives' && c.foreignArchiveHolder === from.seat;
  const to: PublicCardLocation = replacement ? { seat: c.owner, zone: 'hand' } : destination;
  const actualOperation = replacement ? 'returnHand' : operation;
  const foreignArchiveHolder = to.zone === 'archives' && operation === 'foreignArchive' &&
    (context.archiveReturnToOwner || to.seat !== c.owner) ? to.seat : null;
  const move: PublicCardMove = { from, to, requestedOperation: operation, actualOperation,
    replaced: replacement && operation !== 'returnHand', foreignArchiveHolder };
  result.move = move;
  result.affected = !replacement || operation === 'returnHand';
  if (move.replaced) result.reasons.push('foreign-archive departure is replaced by owner hand return');
  if (inPlay(from) && (c.physicalParts?.length ?? 0) > 1) {
    result.ruleUncertain = true;
    result.reasons.push('multiple physical parts require separate destination accounting');
  }
  if (inPlay(from) && operation === 'discard' && c.spec.kind === 'creature' &&
    board(o).some((x) => boxes(x).some((d) => d.purgeCreaturesLeavingPlay))) {
    move.to = { seat: c.owner, zone: 'purged' };
    move.actualOperation = 'purge'; move.replaced = true;
    result.affected = false;
    result.reasons.push('public leave-to-discard replacement purges the creature');
  }
  const supplied = context.useValue?.(c, c.owner);
  const use: PublicCardUseValue = supplied && finite(supplied.score) && Math.abs(supplied.score) < 5000 &&
    (supplied.currentScore === undefined || (finite(supplied.currentScore) && Math.abs(supplied.currentScore) < 5000))
    ? supplied : { score: finite(fallbackQuality) ? fallbackQuality : 1, approximate: true, playableNow: false };
  const regionUse = context.deferCurrentHandOpportunity ? { ...use, playableNow: false } : use;
  const before = opportunity(o, c, from, regionUse);
  const after = opportunity(o, c, move.to, regionUse, move);
  result.score = (c.owner === o.you ? 1 : -1) * (after.value - before.value);
  result.utilityApproximate = before.approximate || after.approximate;
  result.reasons.push(...before.reasons, ...after.reasons);
  if (c.tokenCreature || c.copiedDefinition || c.spec.id !== c.definition || (c.physicalParts?.length ?? 0) > 1) {
    // Moving preserves the physical card, not necessarily its current public token/copy face.
    result.score = 0;
    result.utilityApproximate = true;
    result.reasons.push('future physical face is not inferred from a transformed in-play face');
  }
  if (operation === 'discard' && from.zone === 'hand') {
    const scrap = from.seat === o.activePlayer && boxes(c).some((d) => d.abilities?.scrap?.length);
    const responses = board(o).some((x) => boxes(x).some((d) => d.reactions?.some((r) => r.event === 'handDiscarded')));
    const archiveAfter = o.lasting.some((e) => e.rule === 'archiveAfterDiscard' && e.appliesTo === from.seat &&
      (e.begins ?? o.turn) <= o.turn && e.turn >= o.turn);
    if (scrap || responses || archiveAfter) {
      result.continuationKinds = [];
      if (scrap) result.continuationKinds.push('scrap');
      if (responses) result.continuationKinds.push('hand-discard-reaction');
      if (archiveAfter) result.continuationKinds.push('archive-after-discard');
      result.continuationUncertain = true;
      result.utilityApproximate = true;
      result.reasons.push('direct hand discard is known; its triggered continuation is not valued here');
    }
  }
  if (inPlay(from) && o.leaveEffects.some((e) => e.source === c.id)) {
    result.continuationKinds = [...(result.continuationKinds ?? []), 'leave-play'];
    result.continuationUncertain = true;
    result.utilityApproximate = true;
    result.reasons.push('known departure has a public unmodeled leave-play continuation');
  }
  return result;
}

/** Same normal-refill slot unit already used by the cycle archive policy. */
export const PUBLIC_LIFECYCLE_REFILL_SLOT_VALUE = 0.9;
export function assessLifecycleRefillDelta(
  o: Observation,
  before: readonly [PublicLifecycleCounts, PublicLifecycleCounts],
  after: readonly [PublicLifecycleCounts, PublicLifecycleCounts],
): PublicLifecycleRefillDelta {
  const result: PublicLifecycleRefillDelta = { score: 0, drawDelta: [0, 0], approximate: false };
  const intent = o.pending?.intent;
  const trigger = intent && (intent.kind === 'effect-choice' || intent.kind === 'effect-selection'
    ? intent.ability : 'selection' in intent ? intent.selection?.ability : undefined);
  // End-turn abilities resolve after normal refill. A bare step 5 does not prove
  // that a normal refill is still ahead, so no present-turn slot credit is claimed.
  if (o.turnStep?.step === 5 || (o.pending?.actor === o.activePlayer &&
    (trigger === 'endTurn' || trigger === 'anyEndTurn'))) {
    result.approximate = true;
    return result;
  }
  for (const seat of seats) {
    const old = before[seat], next = after[seat];
    if (![old.hand, old.deck, old.discard, next.hand, next.deck, next.discard].every(validCount)) {
      result.approximate = true; continue;
    }
    if (old.hand === next.hand && old.deck === next.deck && old.discard === next.discard) continue;
    if (!refillGuidanceStatus({ ...o, you: seat }).known) {
      result.approximate = true; continue;
    }
    const modifiers = board(o).flatMap(boxes);
    // The existing forecast cannot project an arbitrary dynamic modifier across a changed pile.
    if (modifiers.some((d) => d.drawBonusValue || d.opponentDrawPenaltyValue) ||
      (old.discard !== next.discard && modifiers.some((d) => d.globalHauntedDrawBonus))) {
      result.approximate = true; continue;
    }
    const a = publicRefillForecast(o, old.hand, old.deck, seat);
    const b = publicRefillForecast(o, next.hand, next.deck, seat);
    if (!a.knownModifiers || !b.knownModifiers || o.publicStateCoverage?.effectsComplete === false) {
      result.approximate = true; continue;
    }
    result.drawDelta[seat] = Math.min(b.draws, next.deck + next.discard) - Math.min(a.draws, old.deck + old.discard);
    result.score += (seat === o.you ? 1 : -1) * result.drawDelta[seat] * PUBLIC_LIFECYCLE_REFILL_SLOT_VALUE;
  }
  return result;
}
