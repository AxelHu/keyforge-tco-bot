import type { CardView, House, Observation } from '../contracts/observation.js';
import { retainedPlayPartnerCount } from './retained-play-partners.js';
import type { PublicCardLocation } from './card-lifecycle-value.js';

export interface HandOpportunityMove {
  card: CardView;
  from: PublicCardLocation;
  to: PublicCardLocation;
}

export interface HandOpportunityGroupOptions {
  /** Add typed, incremental play-trigger value for retained hand partners. */
  semanticPlayPartners?: boolean;
  /** Physical cards already allocated a jointly feasible play in this candidate. */
  excludedImmediateIds?: ReadonlySet<string>;
  /** Initial allocation when a newly arrived card displaces an earlier immediate play. */
  beforeExcludedImmediateIds?: ReadonlySet<string>;
}

const partnerValue = 0.3;
const groupLimit = 1.2;
const archiveWeight = 0.5;
// One additional pool amber has 2.5 play-opportunity value, discounted for later use.
// Replace the generic partner value already present in this same house.
const semanticPremium = 2.5 / 2 - partnerValue;
type HouseOpportunity = { access: number; links: number };
type Holdings = { hand: Map<string, CardView>; archives: Map<string, CardView> };

function houseOpportunities(o: Observation, holdings: Holdings, archivesComplete: boolean,
  excluded: ReadonlySet<string> | undefined, boardOrigins?: ReadonlySet<string>): Map<House, HouseOpportunity> {
  const me = o.players[o.you];
  const groups = new Map<House, CardView[]>();
  const anchors = new Set<House>();
  // A displayed alternate face or joined entity does not establish the identity
  // of a normally playable physical card after its projected movement.
  const houses = (c: CardView) => c.owner !== o.you || excluded?.has(c.id) || c.spec.cannotPlay ||
    c.definition !== c.spec.id || c.tokenCreature || c.form || c.copiedForm || c.temporaryAnimation ||
    c.animatedArtifact || c.copiedAnimation || c.copiedDefinition || c.copiedHouse ||
    c.giganticBonusIcons !== undefined || c.physicalParts !== undefined
    ? [] : new Set((c.effective.houses ?? [c.effective.house]).filter((h) => me.houses.includes(h)));
  for (const c of holdings.hand.values())
    for (const h of houses(c)) {
      const group = groups.get(h);
      if (group) group.push(c);
      else groups.set(h, [c]);
    }

  if (archivesComplete && holdings.archives.size && o.publicStateCoverage?.effectsComplete !== false) {
    const blocked = o.players.some((p) => [...p.battleline, ...p.artifacts, ...p.upgrades].some((c) =>
      [c.spec, ...(c.gainedTextBoxes ?? [])].some((d) => d.forbidsArchiveStep)));
    if (!blocked) for (const c of holdings.archives.values())
      for (const h of houses(c)) anchors.add(h);
  }
  // A visible archive supplies at most half of one partner, regardless of pile size.
  return new Map([...groups].map(([h, cards]) => [h, {
    access: partnerValue * (cards.length - 1 + (anchors.has(h) ? archiveWeight : 0)),
    links: boardOrigins ? retainedPlayPartnerCount(o, h, cards, boardOrigins) : 0,
  }]));
}

/** Incremental future same-house access only. Each candidate earns its best single-house
 * gain and pays its largest single-house loss, each measured against the same initial
 * holdings. A multi-house card never earns multiple positive deltas. Comparing each
 * house to itself also preserves a new pair in a smaller house beside a larger one. */
export function assessHandOpportunityGroup(o: Observation, moves: readonly HandOpportunityMove[],
  options: HandOpportunityGroupOptions = {}): { score: number; approximate: boolean; reasons: string[] } {
  const unchanged = { score: 0, approximate: false, reasons: [] };
  const heldZone = (l: PublicCardLocation) => l.seat === o.you &&
    (l.zone === 'hand' || l.zone === 'archives') ? l.zone : undefined;
  const net = new Map<string, HandOpportunityMove>();
  for (const row of moves) {
    const old = net.get(row.card.id);
    net.set(row.card.id, { ...row, from: old?.from ?? row.from });
  }
  const changes = [...net.values()].filter((m) => heldZone(m.from) !== heldZone(m.to));
  if (!changes.length) return unchanged;
  const me = o.players[o.you];
  const byId = (cards?: CardView[]) => new Map(cards?.map((c) => [c.id, c]));
  const before: Holdings = { hand: byId(me.hand), archives: byId(me.archives) };
  const after: Holdings = { hand: new Map(before.hand), archives: new Map(before.archives) };
  for (const { card, from, to } of changes) {
    const oldZone = heldZone(from);
    const newZone = heldZone(to);
    if (oldZone) after[oldZone].delete(card.id);
    if (newZone) {
      // Temporary in-play house layers expire on departure. Per-copy printed
      // and bonus houses survive. Other visible origins already expose hand-mode houses.
      const fromPlay = from.zone === 'battleline' || from.zone === 'upgrades' || from.zone === 'artifacts';
      const primary = card.printedHouse ?? card.spec.house;
      const held = fromPlay ? { ...card, effective: { ...card.effective, house: primary,
        houses: [primary, ...(card.bonusHouses ?? [])] } } : card;
      after[newZone].set(card.id, held);
    }
  }
  const archivesComplete = before.archives.size === me.archiveCount;
  // A returned permanent previously supplied its own board trigger. Putting it in hand
  // cannot create a new future trigger with a retained follower.
  const boardOrigins = options.semanticPlayPartners ? new Set(changes.filter(({ from }) =>
    from.zone === 'battleline' || from.zone === 'artifacts' || from.zone === 'upgrades').map((m) => m.card.id)) : undefined;
  const old = houseOpportunities(o, before, archivesComplete,
    options.beforeExcludedImmediateIds ?? options.excludedImmediateIds, boardOrigins);
  const next = houseOpportunities(o, after, archivesComplete, options.excludedImmediateIds, boardOrigins);
  let gain = 0, loss = 0, gainAccess = 0, lossAccess = 0;
  for (const h of new Set([...old.keys(), ...next.keys()])) {
    const first = old.get(h), last = next.get(h);
    const access = (last?.access ?? 0) - (first?.access ?? 0);
    const delta = access + semanticPremium * ((last?.links ?? 0) - (first?.links ?? 0));
    if (delta > gain) { gain = delta; gainAccess = access; }
    if (delta < loss) { loss = delta; lossAccess = access; }
  }
  // Only a net typed gain or loss in the selected houses extends that direction's
  // legacy access bound. Two extra links at most, even for dual-house batches.
  const total = gain + loss;
  const premium = Math.max(-2 * semanticPremium, Math.min(2 * semanticPremium, total - (gainAccess + lossAccess)));
  const score = Math.max(-groupLimit + Math.min(0, premium), Math.min(groupLimit + Math.max(0, premium), total));
  return score ? { score, approximate: true, reasons: ['future same-house hand opportunity, net of visible partners',
    ...(Math.abs(premium) > 1e-9 ? ['retained same-house play order changes incremental pool amber'] : [])] } : unchanged;
}
