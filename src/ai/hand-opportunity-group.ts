import type { CardView, House, Observation } from '../contracts/observation.js';
import type { PublicCardLocation } from './card-lifecycle-value.js';

export interface HandOpportunityMove {
  card: CardView;
  from: PublicCardLocation;
  to: PublicCardLocation;
}

export interface HandOpportunityGroupOptions {
  /** Physical cards already allocated a jointly feasible play in this candidate. */
  excludedImmediateIds?: ReadonlySet<string>;
  /** Initial allocation when a newly arrived card displaces an earlier immediate play. */
  beforeExcludedImmediateIds?: ReadonlySet<string>;
}

const partnerValue = 0.3;
const groupLimit = 1.2;
const archiveWeight = 0.5;
type Holdings = { hand: Map<string, CardView>; archives: Map<string, CardView> };

function houseOpportunities(o: Observation, holdings: Holdings, archivesComplete: boolean,
  excluded: ReadonlySet<string> | undefined): Map<House, number> {
  const me = o.players[o.you];
  const counts = new Map<House, number>();
  const anchors = new Set<House>();
  // A displayed alternate face or joined entity does not establish the identity
  // of a normally playable physical card after its projected movement.
  const houses = (c: CardView) => c.owner !== o.you || excluded?.has(c.id) || c.spec.cannotPlay ||
    c.definition !== c.spec.id || c.tokenCreature || c.form || c.copiedForm || c.temporaryAnimation ||
    c.animatedArtifact || c.copiedAnimation || c.copiedDefinition || c.copiedHouse ||
    c.giganticBonusIcons !== undefined || c.physicalParts !== undefined
    ? [] : new Set((c.effective.houses ?? [c.effective.house]).filter((h) => me.houses.includes(h)));
  for (const c of holdings.hand.values())
    for (const h of houses(c)) counts.set(h, (counts.get(h) ?? 0) + 1);

  if (archivesComplete && holdings.archives.size && o.publicStateCoverage?.effectsComplete !== false) {
    const blocked = o.players.some((p) => [...p.battleline, ...p.artifacts, ...p.upgrades].some((c) =>
      [c.spec, ...(c.gainedTextBoxes ?? [])].some((d) => d.forbidsArchiveStep)));
    if (!blocked) for (const c of holdings.archives.values())
      for (const h of houses(c)) anchors.add(h);
  }
  // A visible archive supplies at most half of one partner, regardless of pile size.
  return new Map([...counts].map(([h, n]) => [h, partnerValue * (n - 1 + (anchors.has(h) ? archiveWeight : 0))]));
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
  const old = houseOpportunities(o, before, archivesComplete,
    options.beforeExcludedImmediateIds ?? options.excludedImmediateIds);
  const next = houseOpportunities(o, after, archivesComplete, options.excludedImmediateIds);
  let gain = 0, loss = 0;
  for (const h of new Set([...old.keys(), ...next.keys()])) {
    const delta = (next.get(h) ?? 0) - (old.get(h) ?? 0);
    gain = Math.max(gain, delta);
    loss = Math.min(loss, delta);
  }
  const score = Math.max(-groupLimit, Math.min(groupLimit, gain + loss));
  return score ? { score, approximate: true, reasons: ['future same-house hand opportunity, net of visible partners'] }
    : unchanged;
}
