/** Bounded, optional DoK priors over the unchanged tactical-v3 public-observation scores. */
import type { Action, CardView, Observation, Seat } from '../contracts/observation.js';
import type { Policy } from './policies.js';
import { rankForgeAware } from './forge-lock-policy.js';
import { neutralBattlelineReorder } from './reorder-policy.js';

export const DOK_POLICY_IDS = [
  'tactical-dok-card-v1',
  'tactical-dok-deck-v1',
  'tactical-dok-combined-v1',
] as const;
export type DokVariant = 'card' | 'deck' | 'combined';
export const DOK_POLICY_PARAMETERS = Object.freeze({
  cardWeight: 0.4,
  deckWeight: 0.3,
  cardCenter: 3,
  cardScale: 3,
  synergyScale: 2,
  maximumResidual: 0.65,
  maximumBaselineGap: 1,
});
export interface DokDecisionAudit {
  variant: DokVariant;
  revision: number;
  baselineActionId: string;
  actionId: string;
  changed: boolean;
  status: 'active' | 'missing-cache' | 'disabled' | 'protected' | 'no-rating';
  eligibleActions: number;
  cardLookups: number;
  cardHits: number;
  deckLookups: number;
  deckHits: number;
  groupRepresentativeHits: number;
  unknownVersionHits: number;
  unavailableDeckBindings: number;
  largestAbsoluteResidual: number;
}
/** Constructor-only data. Never added to Observation, model content, legal actions or engine state. */
export interface CodeStrategyContext {
  dok?: {
    /** Frozen normalized keyforge-dok-advisor-cache-v1 JSON; no fetch or file access occurs here. */
    cache?: unknown;
    /** Public deck identities by seat. Each is additionally matched to the observed public multiset. */
    deckIds?: readonly [string, string];
    /** Zero provides an exact tactical-v3 control. Nonzero weights are bounded by the fixed v1 defaults. */
    weights?: { card?: number; deck?: number };
    onDecision?: (audit: DokDecisionAudit) => void;
  };
}
type Row = Record<string, unknown>;
interface Version {
  status: 'known' | 'unknown';
}
interface Rating {
  value: number;
  version: Version;
}
interface DeckRating {
  composition: string;
  counts: Map<string, number>;
  ratings: Map<string, Rating>;
}
interface CacheIndex {
  cards: Map<string, Rating>;
  decks: Map<string, DeckRating>;
}
const compiled = new WeakMap<object, CacheIndex>();
const row = (v: unknown): Row | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : undefined;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const key = (definition: string, house: string) => JSON.stringify([definition, house]);
const clamp = (n: number, max = 1) => Math.max(-max, Math.min(max, n));
function version(v: unknown): Version {
  const x = row(v);
  if (x?.status === 'known' && finite(x.value) && x.value >= 0) return { status: 'known' };
  return { status: 'unknown' };
}
function composition(v: unknown): { encoded: string; counts: Map<string, number> } | undefined {
  if (!Array.isArray(v) || !v.length) return;
  const counts = new Map<string, number>();
  for (const item of v) {
    const x = row(item);
    if (
      !x ||
      !nonempty(x.definition) ||
      !nonempty(x.house) ||
      !Number.isSafeInteger(x.count) ||
      Number(x.count) < 1
    )
      return;
    const id = key(x.definition, x.house);
    if (counts.has(id)) return;
    counts.set(id, Number(x.count));
  }
  if ([...counts.values()].reduce((a, b) => a + b, 0) !== 36) return;
  return { encoded: JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b, 'en'))), counts };
}
function cacheIndex(value: unknown): CacheIndex | undefined {
  if (value === undefined || value === null) return;
  const raw = row(value);
  if (
    !raw ||
    raw.schema !== 'keyforge-dok-advisor-cache-v1' ||
    !Array.isArray(raw.cards) ||
    !Array.isArray(raw.decks)
  )
    throw Error('Invalid DoK cache schema');
  const prior = compiled.get(raw);
  if (prior) return prior;
  const index: CacheIndex = { cards: new Map(), decks: new Map() };
  const cardSeen = new Set<string>(),
    duplicateCards = new Set<string>();
  for (const candidate of raw.cards) {
    const c = row(candidate);
    if (!c || !nonempty(c.definition)) continue;
    if (cardSeen.has(c.definition)) duplicateCards.add(c.definition);
    cardSeen.add(c.definition);
    const rv = version(c.ratingVersion);
    if (
      c.availability !== 'available' ||
      row(c.mapping)?.status !== 'exact' ||
      c.physicalResolution !== 'generic-definition' ||
      c.baseAercKind !== 'published-average' ||
      !finite(c.baseAerc)
    )
      continue;
    index.cards.set(c.definition, { value: c.baseAerc, version: rv });
  }
  for (const definition of duplicateCards) index.cards.delete(definition);
  const deckSeen = new Set<string>(),
    duplicateDecks = new Set<string>();
  for (const candidate of raw.decks) {
    const d = row(candidate);
    if (!d || !nonempty(d.deckId)) continue;
    if (deckSeen.has(d.deckId)) duplicateDecks.add(d.deckId);
    deckSeen.add(d.deckId);
    const list = composition(d.composition),
      rv = version(d.ratingVersion);
    if (
      !list ||
      !Array.isArray(d.cardRatings) ||
      (d.availability !== undefined && d.availability !== 'available')
    )
      continue;
    const ratings = new Map<string, Rating>(),
      seen = new Set<string>(),
      duplicates = new Set<string>();
    for (const candidateRating of d.cardRatings) {
      const c = row(candidateRating);
      if (!c || !nonempty(c.definition) || !nonempty(c.house)) continue;
      const id = key(c.definition, c.house);
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
      if (
        c.availability !== 'available' ||
        c.physicalResolution !== 'name-house-group' ||
        (c.mapping !== undefined && row(c.mapping)?.status !== 'exact') ||
        c.copies !== list.counts.get(id) ||
        !finite(c.netSynergy)
      )
        continue;
      ratings.set(id, { value: c.netSynergy, version: rv });
    }
    for (const id of duplicates) ratings.delete(id);
    index.decks.set(d.deckId, { composition: list.encoded, counts: list.counts, ratings });
  }
  for (const id of duplicateDecks) index.decks.delete(id);
  // Copy only primitive values into private indexes. Later mutation of the caller's JSON has no effect.
  compiled.set(raw, index);
  return index;
}
/** Capture the data snapshot and per-seat settings once; callback identity is intentionally retained. */
export function snapshotCodeStrategyContext(context?: CodeStrategyContext): CodeStrategyContext | undefined {
  if (!context?.dok) return;
  const d = context.dok;
  cacheIndex(d.cache);
  if (
    d.deckIds !== undefined &&
    (!Array.isArray(d.deckIds) || d.deckIds.length !== 2 || d.deckIds.some((id) => !nonempty(id)))
  )
    throw Error('Invalid DoK deck identities');
  const weights = {
    card: d.weights?.card ?? DOK_POLICY_PARAMETERS.cardWeight,
    deck: d.weights?.deck ?? DOK_POLICY_PARAMETERS.deckWeight,
  };
  for (const k of ['card', 'deck'] as const)
    if (
      !finite(weights[k]) ||
      weights[k] < 0 ||
      weights[k] > (k === 'card' ? DOK_POLICY_PARAMETERS.cardWeight : DOK_POLICY_PARAMETERS.deckWeight)
    )
      throw Error('Invalid DoK residual weight');
  if (d.onDecision !== undefined && typeof d.onDecision !== 'function')
    throw Error('Invalid DoK audit callback');
  const deckIds = d.deckIds ? (Object.freeze([...d.deckIds]) as readonly [string, string]) : undefined;
  return Object.freeze({
    dok: Object.freeze({
      cache: d.cache,
      ...(deckIds ? { deckIds } : {}),
      weights: Object.freeze(weights),
      ...(d.onDecision ? { onDecision: d.onDecision } : {}),
    }),
  });
}
function visibleCards(o: Observation): Map<string, CardView> {
  // No current hidden deck or opposing hand is ever inspected, even if a malformed caller supplied one.
  const me = o.players[o.you];
  return new Map(
    [
      ...o.players.flatMap((p) => [
        ...p.battleline,
        ...p.artifacts,
        ...p.upgrades,
        ...p.discard,
        ...p.purged,
        ...(p.faceupArchives ?? []),
        ...(p.revealedTop ? [p.revealedTop] : []),
      ]),
      ...(me.hand ?? []),
      ...(me.archives ?? []),
      ...o.promptCards,
      ...o.resolving,
      ...o.underCards.flatMap((p) => p.cards ?? []),
      ...o.spanglerCards.flatMap((p) => p.cards),
      ...(o.prophecies ?? []).flatMap((p) => p.cards ?? []),
    ].map((c) => [c.id, c]),
  );
}
type Location = 'hand' | 'archives' | 'discard' | 'purged' | 'play' | 'other';
function location(o: Observation, c: CardView): Location {
  for (const p of o.players) {
    if (p === o.players[o.you] && p.hand?.some((x) => x.id === c.id)) return 'hand';
    if (p === o.players[o.you] && p.archives?.some((x) => x.id === c.id)) return 'archives';
    if (p.discard.some((x) => x.id === c.id)) return 'discard';
    if (p.purged.some((x) => x.id === c.id)) return 'purged';
    if ([...p.battleline, ...p.artifacts, ...p.upgrades].some((x) => x.id === c.id)) return 'play';
  }
  return 'other';
}
/** Static identity is not enough to transfer a deck's synergy estimate onto a transformed occurrence. */
function ordinaryOriginal(c: CardView): boolean {
  return (
    c.owner === c.controller &&
    !c.tokenCreature &&
    !c.physicalParts?.length &&
    !c.copiedDefinition &&
    !c.copiedHouse &&
    !c.copiedCharacteristics &&
    !c.copiedAnimation &&
    !c.copiedForm &&
    !c.copiedBonusHouses?.length &&
    !c.copiedBonusIcons?.length &&
    !c.form &&
    !c.temporaryAnimation &&
    !c.animatedArtifact &&
    !c.retainedUpgradeDefinition &&
    !c.gainedTextBoxes?.length &&
    c.spec.id === c.definition
  );
}
function targetDirection(o: Observation, c: CardView): number {
  const intent = o.pending?.intent;
  if (intent?.kind !== 'target-operation') return 0;
  const own = c.controller === o.you,
    place = location(o, c);
  switch (intent.operation) {
    case 'destroy':
    case 'purge':
    case 'discard':
      return place === 'other' ? 0 : own ? -1 : 1;
    case 'returnHand':
      if (place === 'discard' || place === 'purged' || place === 'archives')
        return c.owner === o.you ? 1 : -1;
      return place === 'play' ? (own ? -1 : 1) : 0;
    case 'ready':
      return place === 'play' && !c.ready && !c.stunned ? (own ? 1 : -1) : 0;
    case 'ward':
      return place === 'play' && !c.warded ? (own ? 1 : -1) : 0;
    case 'heal':
      return place === 'play' && c.damage > 0 ? (own ? 1 : -1) : 0;
    case 'power':
      return place === 'play' && (o.pending?.amount ?? 0) > 0 ? (own ? 1 : -1) : 0;
    case 'damage':
    case 'stun':
    case 'stunExhaust':
    case 'exhaust':
      return place === 'play' ? (own ? -1 : 1) : 0;
    default:
      // Archive destination, capture, arbitrary options, bindings and replacement choices are not inferred.
      return 0;
  }
}
export function dokTacticalPolicy(variant: DokVariant, context?: CodeStrategyContext): Policy {
  const captured = snapshotCodeStrategyContext(context)?.dok,
    index = cacheIndex(captured?.cache);
  const cardWeight = variant === 'deck' ? 0 : (captured?.weights?.card ?? DOK_POLICY_PARAMETERS.cardWeight),
    deckWeight = variant === 'card' ? 0 : (captured?.weights?.deck ?? DOK_POLICY_PARAMETERS.deckWeight);
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    const rows = rankForgeAware(o, 'tactical'),
      best = rows[0],
      neutral = neutralBattlelineReorder(o),
      baseline = neutral?.actionId ?? best.actionId;
    const audit: DokDecisionAudit = {
      variant,
      revision: o.revision,
      baselineActionId: baseline,
      actionId: baseline,
      changed: false,
      status: 'active',
      eligibleActions: 0,
      cardLookups: 0,
      cardHits: 0,
      deckLookups: 0,
      deckHits: 0,
      groupRepresentativeHits: 0,
      unknownVersionHits: 0,
      unavailableDeckBindings: 0,
      largestAbsoluteResidual: 0,
    };
    const finish = (status: DokDecisionAudit['status'], actionId = baseline) => {
      audit.status = status;
      audit.actionId = actionId;
      audit.changed = actionId !== baseline;
      captured?.onDecision?.({ ...audit });
      return actionId;
    };
    if (!cardWeight && !deckWeight) return finish('disabled');
    if (!index) return finish('missing-cache');
    if (neutral || best.projectedKey || best.deniesKey || best.score >= 1000) return finish('protected');
    const cards = visibleCards(o);
    const bound = [0, 1].map((seat) => {
      const id = captured?.deckIds?.[seat],
        d = id ? index.decks.get(id) : undefined,
        observed = composition(o.players[seat].deckList);
      const matched = d && observed?.encoded === d.composition ? d : undefined;
      if (deckWeight && !matched) audit.unavailableDeckBindings++;
      return matched;
    });
    const read = (rating: Rating | undefined): number | undefined => {
      if (!rating) return;
      if (rating.version.status === 'unknown') audit.unknownVersionHits++;
      return rating.value;
    };
    const quality = (c: CardView, allowDeck = true): [number, number] => {
      let generic = 0,
        synergy = 0;
      if (cardWeight) {
        audit.cardLookups++;
        const value = read(index.cards.get(c.tokenCreature?.reference ?? c.spec.id));
        if (value !== undefined) {
          audit.cardHits++;
          generic = clamp((value - DOK_POLICY_PARAMETERS.cardCenter) / DOK_POLICY_PARAMETERS.cardScale);
        }
      }
      if (deckWeight) {
        audit.deckLookups++;
        if (allowDeck && ordinaryOriginal(c)) {
          const d = bound[c.owner as Seat],
            house = c.printedHouse ?? c.spec.house,
            value = read(d?.ratings.get(key(c.definition, house)));
          if (value !== undefined) {
            audit.deckHits++;
            audit.groupRepresentativeHits++;
            synergy = clamp(value / DOK_POLICY_PARAMETERS.synergyScale);
          }
        }
      }
      return [generic, synergy];
    };
    const contribution = (a: Action): [number, number] => {
      if (a.kind === 'play' || a.kind === 'discard' || a.kind === 'returnDiscard') {
        const c = cards.get(a.kind === 'play' ? (a.copy ?? a.card) : a.card);
        if (!c) return [0, 0];
        const q = quality(c, !(a.kind === 'play' && !!a.copy)),
          sign = a.kind === 'discard' ? -1 : 1;
        return [q[0] * sign, q[1] * sign];
      }
      if (a.kind === 'house' && a.house) {
        const me = o.players[o.you];
        const candidates = [
          ...(me.hand ?? []),
          ...me.battleline.filter((c) => c.ready && !c.stunned),
          ...me.artifacts.filter((c) => c.ready),
        ].filter((c) => (c.effective.houses ?? [c.effective.house]).includes(a.house!));
        if (!candidates.length) return [0, 0];
        const values = candidates.map((c) => quality(c)),
          divisor = Math.max(2, candidates.length);
        return [
          values.reduce((n, q) => n + q[0], 0) / divisor,
          values.reduce((n, q) => n + q[1], 0) / divisor,
        ];
      }
      if (a.kind === 'select') {
        const c = cards.get(a.target),
          direction = c ? targetDirection(o, c) : 0;
        if (!c || !direction) return [0, 0];
        const q = quality(c);
        return [q[0] * direction, q[1] * direction];
      }
      return [0, 0];
    };
    const amended = rows
      .map((r) => {
        if (
          best.score - r.score > DOK_POLICY_PARAMETERS.maximumBaselineGap ||
          r.projectedKey ||
          r.deniesKey ||
          r.score >= 1000
        )
          return { ...r, dokScore: r.score };
        audit.eligibleActions++;
        const action = o.legalActions.find((a) => a.id === r.actionId)!.action,
          q = contribution(action),
          delta = clamp(q[0] * cardWeight + q[1] * deckWeight, DOK_POLICY_PARAMETERS.maximumResidual);
        audit.largestAbsoluteResidual = Math.max(audit.largestAbsoluteResidual, Math.abs(delta));
        return { ...r, dokScore: r.score + delta };
      })
      .sort((a, b) => b.dokScore - a.dokScore || a.actionId.localeCompare(b.actionId, 'en'));
    return finish(audit.cardHits + audit.deckHits ? 'active' : 'no-rating', amended[0].actionId);
  };
}
