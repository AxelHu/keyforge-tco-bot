/** Bounded public-card utility; deliberately not a second rules engine.
 * Only observed cards, counters and structural definitions are read. No names, ratings or hidden piles.
 * released is GROSS captured-amber credit, indexed [you, opponent]. The caller must first record
 * removed cards and then route this credit through its public income-replacement calculation.
 * Board score never includes the 3.5/3.2 pool weights, and never includes captured amber twice.
 */
import type { CardView, Effect, Observation, Seat } from '../contracts/observation.js';

export interface PublicOperationAssessment {
  score: number;
  /** The original entry is known to leave play. */
  removed: boolean;
  /** Destruction of the original entry is known, rather than just a legal attempt. */
  destroyed: boolean;
  /** The requested operation itself succeeds; consuming Ward alone does not satisfy after(affected). */
  affected: boolean;
  released: [number, number];
  approximate: boolean;
}
export interface PublicOperationOptions {
  fullHeal?: boolean;
  ignoreArmor?: boolean;
  inPlay?: boolean;
}
type Row = Record<string, unknown>;
const row = (x: unknown): Row | undefined =>
  x !== null && typeof x === 'object' && !Array.isArray(x) ? (x as Row) : undefined;
const number = (x: unknown): number | undefined =>
  typeof x === 'number' && Number.isFinite(x) ? x : undefined;
const cap = (n: number, limit: number) => Math.max(-limit, Math.min(limit, n));
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const attached = (o: Observation, c: CardView) =>
  o.players.flatMap((p) => p.upgrades).filter((u) => u.attachedTo === c.id);
const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const relative = (o: Observation, seat: Seat): 0 | 1 => (seat === o.you ? 0 : 1);
const houses = (c: CardView) => c.effective.houses ?? [c.effective.house];

/** Entry-granted Omega is public even though a card in hand has not acquired it yet. */
export function publicPlayEndsStep(o: Observation, c: CardView, asUpgrade = false): boolean {
  if (asUpgrade) return false;
  if (c.spec.omega) return true;
  if (!['creature', 'artifact'].includes(c.spec.kind)) return false;
  const receiver = c.spec.entersOpponentControl ? other(o.you) : o.you;
  return board(o).some(
    (x) =>
      x.controller !== receiver && [x.spec, ...(x.gainedTextBoxes ?? [])].some((box) => box.grantsEnemyOmega),
  );
}

/** Small, explicitly public scalar subset. Unknown binding/hidden identity expressions stay unknown. */
function publicValue(o: Observation, c: CardView, input: unknown, depth = 0): number | undefined {
  if (depth > 4) return;
  const n = number(input);
  if (n !== undefined) return n;
  const v = row(input);
  if (!v) return;
  if (v.sourceAmber === true) return c.captured;
  if (Array.isArray(v.add)) {
    const ns = v.add.map((x) => publicValue(o, c, x, depth + 1));
    return ns.every((x) => x !== undefined) ? ns.reduce<number>((a, b) => a + b!, 0) : undefined;
  }
  if (Array.isArray(v.subtract) && v.subtract.length === 2) {
    const a = publicValue(o, c, v.subtract[0], depth + 1),
      b = publicValue(o, c, v.subtract[1], depth + 1);
    return a !== undefined && b !== undefined ? a - b : undefined;
  }
  if (v.half !== undefined) {
    const x = publicValue(o, c, v.half, depth + 1);
    return x === undefined ? undefined : Math.floor(x / 2);
  }
  const seat =
    v.side === undefined || v.side === 'self'
      ? c.controller
      : v.side === 'opponent'
        ? other(c.controller)
        : undefined;
  if (typeof v.metric === 'string' && seat !== undefined) {
    const p = o.players[seat];
    if (v.metric === 'amber') return p.amber;
    if (v.metric === 'keys') return p.keys.length;
    if (v.metric === 'archives') return p.archiveCount;
    if (v.metric === 'handSize') return p.handCount;
  }
  const f = row(v.count);
  if (!f || Object.keys(f).some((k) => !['side', 'zone', 'kind', 'neighborsOf'].includes(k))) return;
  const side =
    f.side === undefined || f.side === 'any'
      ? undefined
      : f.side === 'friendly'
        ? c.controller
        : f.side === 'enemy'
          ? other(c.controller)
          : null;
  if (side === null) return;
  const multiplier = v.multiplier === undefined ? 1 : number(v.multiplier);
  if (multiplier === undefined) return;
  if (f.neighborsOf === 'source' && Object.keys(f).length === 1) {
    const line = o.players[c.controller].battleline,
      i = line.findIndex((x) => x.id === c.id);
    return (i < 0 ? 0 : Number(i > 0) + Number(i + 1 < line.length)) * multiplier;
  }
  if (f.neighborsOf !== undefined) return;
  const seats: Seat[] = side === undefined ? [0, 1] : [side];
  if ((f.zone === 'archives' || f.zone === 'hand') && f.kind === undefined)
    return (
      seats.reduce<number>(
        (a, s) => a + (f.zone === 'archives' ? o.players[s].archiveCount : o.players[s].handCount),
        0,
      ) * multiplier
    );
  if (f.zone !== undefined && f.zone !== 'play' && f.zone !== 'battleline' && f.zone !== 'artifacts') return;
  const cards = seats.flatMap((s) =>
    f.zone === 'artifacts'
      ? o.players[s].artifacts
      : f.zone === 'battleline'
        ? o.players[s].battleline
        : [...o.players[s].battleline, ...o.players[s].artifacts],
  );
  return cards.filter((x) => f.kind === undefined || x.spec.kind === f.kind).length * multiplier;
}
function publicCondition(o: Observation, c: CardView, input: unknown): boolean | undefined {
  const q = row(input);
  if (!q || Object.keys(q).some((k) => !['left', 'right', 'comparison'].includes(k))) return;
  const a = publicValue(o, c, q.left),
    b = publicValue(o, c, q.right);
  if (a === undefined || b === undefined) return;
  switch (q.comparison) {
    case 'gte':
      return a >= b;
    case 'gt':
      return a > b;
    case 'eq':
      return a === b;
    case 'lte':
      return a <= b;
    case 'lt':
      return a < b;
    default:
      return;
  }
}
/** One potential activation in existing immediate-utility units, later discounted.
 * A partially understood activation gets no positive bonus: its unsupported cost may matter.
 */
function activationUtility(
  o: Observation,
  c: CardView,
  effects: readonly unknown[],
  depth = 0,
): number | undefined {
  if (depth > 3 || effects.length > 12) return;
  let total = 0;
  for (const input of effects) {
    const e = row(input);
    if (!e) return;
    const amount = e.amount === undefined ? 0 : publicValue(o, c, e.amount);
    switch (e.kind) {
      case 'gain':
        if (amount === undefined) return;
        total += Math.max(0, amount) * 3.5;
        break;
      case 'loseOpponent':
        if (amount === undefined) return;
        total += Math.min(o.players[other(c.controller)].amber, Math.max(0, amount)) * 3.2;
        break;
      case 'steal':
        if (amount === undefined || e.thenDamage) return;
        if (
          board(o).some(
            (x) =>
              x.id !== c.id &&
              x.controller === other(c.controller) &&
              (x.spec.cannotStealFrom || (x.spec.cannotStealWhileAmber && x.captured > 0)),
          )
        )
          break;
        if (
          board(o).some(
            (x) => x.id !== c.id && x.controller === other(c.controller) && x.spec.cannotStealCondition,
          )
        )
          return;
        total +=
          Math.min(o.players[other(c.controller)].amber, Math.max(0, amount)) *
          (board(o).some(
            (x) => x.id !== c.id && x.controller === other(c.controller) && x.spec.supplyInsteadOfPool,
          )
            ? 3.5
            : 6.7);
        break;
      case 'capture':
        if (amount === undefined) return;
        total += Math.min(o.players[other(c.controller)].amber, Math.max(0, amount)) * 1.4;
        break;
      case 'draw':
        if (amount === undefined) return;
        total += Math.max(0, amount) * 1.2;
        break;
      case 'chains':
        if (amount === undefined) return;
        total -= Math.max(0, amount) * 1.3;
        break;
      case 'archiveChoice':
        total += o.players[c.controller].handCount > 0 ? 0.8 : 0;
        break;
      case 'lasting':
        if (e.rule !== 'keyCost' || amount === undefined || !['self', 'opponent'].includes(String(e.side)))
          return;
        total += (e.side === 'opponent' ? 1 : -1) * amount * 1.5;
        break;
      case 'resource': {
        if (amount === undefined || (e.side !== undefined && e.side !== 'self' && e.side !== 'opponent'))
          return;
        const own = e.side !== 'opponent';
        if (e.operation === 'gain') total += (own ? 3.5 : -3.2) * Math.max(0, amount);
        else if (e.operation === 'draw') total += (own ? 1 : -1) * amount * 1.2;
        else if (e.operation === 'chains') total -= (own ? 1 : -1) * amount * 1.3;
        else if (e.operation === 'lose')
          total +=
            (own ? -3.5 : 3.2) *
            Math.min(o.players[own ? c.controller : other(c.controller)].amber, Math.max(0, amount));
        else return;
        break;
      }
      case 'if': {
        const yes = publicCondition(o, c, e.condition);
        if (yes === undefined) return;
        const branch = yes ? e.then : (e.otherwise ?? []);
        if (!Array.isArray(branch)) return;
        const x = activationUtility(o, c, branch, depth + 1);
        if (x === undefined) return;
        total += x;
        break;
      }
      default:
        return;
    }
  }
  return cap(total, 10);
}
function restrictedHousePenalty(o: Observation, c: CardView): number {
  const h = c.spec.mustHouse;
  if (!h) return 0;
  const p = o.players[c.controller];
  // Never inspect an opposing hand array, even if a malformed input includes one.
  const known = [...p.battleline, ...p.artifacts, ...(c.controller === o.you ? (p.hand ?? []) : [])];
  const work = (house: string) => known.filter((x) => houses(x).includes(house as never)).length;
  return Math.min(3, Math.max(0, ...p.houses.map((x) => work(x) - work(h))) * 0.7);
}
export function contextualBoardWorth(o: Observation, c: CardView): number {
  const d = c.spec,
    p = o.players[c.controller],
    foe = o.players[other(c.controller)];
  const base =
    2.6 +
    Math.min(Math.max(0, c.effective.power), 10) * 0.18 +
    (d.drawBonus ?? 0) * 2 +
    (d.opponentKeyTax ?? 0) * 1.5 +
    (d.opponentDrawPenalty ?? 0) * 1.2;
  let extra = 0;
  for (const tax of d.keyTaxes ?? []) {
    if (tax.condition && publicCondition(o, c, tax.condition) !== true) continue;
    const n = publicValue(o, c, tax.amount);
    if (n !== undefined) extra += (tax.side === 'opponent' ? 1 : -1) * cap(n, 4) * 1.5;
  }
  // The base body already represents ordinary reap. Only additional Reap/End-turn utility is added.
  const reap = d.cannotReap ? 0 : (activationUtility(o, c, d.abilities?.reap ?? []) ?? 0);
  const end = activationUtility(o, c, d.abilities?.endTurn ?? []) ?? 0;
  const action = activationUtility(o, c, d.abilities?.action ?? []) ?? 0;
  const omni = activationUtility(o, c, d.abilities?.omni ?? []) ?? 0;
  const ordinaryReap = d.kind === 'creature' && !d.cannotReap ? 3.5 : 0;
  extra += cap(end + Math.max(0, reap, action - ordinaryReap, omni - ordinaryReap), 8) * 0.4;
  for (const reaction of d.reactions ?? []) {
    // A capability premium, not predicted secret creature plays or immediate income.
    if (
      reaction.event !== 'creaturePlayed' ||
      reaction.side !== 'friendly' ||
      Object.keys(reaction).some((k) => !['event', 'side', 'other', 'effects'].includes(k))
    )
      continue;
    const n = activationUtility(o, c, reaction.effects);
    if (n !== undefined && p.handCount > 0) extra += Math.max(0, Math.min(n, 3.5)) * 0.35;
  }
  if (d.playLimitOpponent !== undefined && foe.handCount > d.playLimitOpponent) {
    // Stronger only when our own public hand establishes the number of potentially restricted cards.
    const known =
      other(c.controller) === o.you && o.activePlayer === o.you
        ? (foe.hand ?? []).filter((x) => !x.spec.cannotPlay && houses(x).includes(o.activeHouse as never))
            .length
        : 0;
    extra += Math.min(3, 0.8 + Math.max(0, known - d.playLimitOpponent) * 0.8);
  }
  if (d.capturesIncomingAmber) extra += 2;
  else if (d.capturesReapIncome)
    extra += Math.min(2, foe.battleline.filter((x) => !x.spec.cannotReap).length * 0.6);
  if (d.blocksOpponentBonusIcons && foe.handCount > 0) extra += 1.5;
  if (d.readyEntryKinds?.includes('creature') && p.handCount > 0) extra += 1.2;
  if (d.prohibitsEnemyReap) extra += Math.min(3, foe.battleline.length * 0.7);
  if (d.opponentArtifactUseTax) extra += Math.min(2, foe.artifacts.length * d.opponentArtifactUseTax * 0.6);
  if (d.cannotReap && d.kind === 'creature') extra -= 0.8;
  if (d.prohibitOwnCreatures)
    extra -=
      c.controller === o.you
        ? Math.min(3, (p.hand ?? []).filter((x) => x.spec.kind === 'creature').length * 0.8)
        : 0.8;
  extra -= restrictedHousePenalty(o, c);
  if (d.skipForgeStep && p.forgeAvailable >= p.keyCost) extra -= 4;
  // Hard forge prevention remains the existing v3 layer's responsibility; no duplicate win bonuses.
  return base + cap(extra, 8);
}
function recoveryValue(o: Observation, c: CardView): number {
  return (
    1 +
    Math.max(0, contextualBoardWorth(o, c)) * (c.spec.kind === 'creature' ? 0.45 : 0.2) +
    Math.min(2, Math.max(0, c.spec.amber)) * 0.5
  );
}
function empty(approximate = false): PublicOperationAssessment {
  return { score: 0, removed: false, destroyed: false, affected: false, released: [0, 0], approximate };
}
function hasUnknownDestruction(
  o: Observation,
  c: CardView,
): { unknown: boolean; amber: number; approximate: boolean } {
  const allies = board(o),
    upgrades = attached(o, c);
  const afterUnknown =
    allies.some((x) =>
      [x.spec, ...(x.gainedTextBoxes ?? [])].some((box) =>
        box.reactions?.some((r) => r.event === 'creatureDestroyed'),
      ),
    ) || o.leaveEffects.some((x) => x.source === c.id);
  const globalSuppression = allies.some((x) => x.spec.suppressesDestroyed);
  const enemySuppression =
    c.spec.kind === 'creature' &&
    allies.some((x) => x.controller !== c.controller && x.spec.suppressesEnemyDestroyed);
  if (globalSuppression) return { unknown: false, amber: c.captured, approximate: afterUnknown };
  if (enemySuppression) {
    if (upgrades.some((u) => u.spec.upgrade?.destructionReplacement))
      return { unknown: true, amber: 0, approximate: true };
    return { unknown: false, amber: c.captured, approximate: afterUnknown };
  }
  if (
    c.spec.destroyedDestination ||
    (c.gainedTextBoxes ?? []).some(
      (d) => d.destroyedDestination || d.conditionalAbilities?.some((x) => x.abilities.destroyed?.length),
    ) ||
    c.spec.conditionalAbilities?.some((x) => x.abilities.destroyed?.length) ||
    upgrades.some((u) => u.spec.upgrade?.destructionReplacement)
  )
    return { unknown: true, amber: 0, approximate: true };
  if (allies.some((x) => (x.spec.grantsAbilities ?? []).some((g) => g.abilities.destroyed?.length)))
    return { unknown: true, amber: 0, approximate: true };
  const effects: readonly Effect[] = [
    ...(c.spec.abilities?.destroyed ?? []),
    ...(c.gainedTextBoxes ?? []).flatMap((x) => x.abilities?.destroyed ?? []),
    ...upgrades.flatMap((u) => u.spec.upgrade?.abilities?.destroyed ?? []),
  ];
  let amber = c.captured,
    approximate = effects.length > 0;
  for (const effect of effects) {
    const e = row(effect)!;
    if (e.kind === 'self' && e.operation === 'removeAmber') {
      const amount = publicValue(o, c, e.amount);
      if (amount === undefined) return { unknown: true, amber: 0, approximate: true };
      amber = Math.max(0, amber - Math.max(0, amount));
    } else if (!['gain', 'loseOpponent', 'resource', 'draw', 'chains'].includes(String(e.kind))) {
      return { unknown: true, amber: 0, approximate: true };
    }
  }
  // These after-events may change other resources; the caller must not call the entire result exact.
  approximate ||= afterUnknown;
  return { unknown: false, amber, approximate };
}
function destructionProtection(o: Observation, c: CardView): 'yes' | 'unknown' | 'no' {
  if (
    c.spec.invulnerable ||
    (c.gainedTextBoxes ?? []).some((d) => d.invulnerable) ||
    attached(o, c).some((x) => x.spec.upgrade?.invulnerable) ||
    o.cardEffects.some(
      (e) => e.target === c.id && e.rule === 'invulnerable' && (e.untilTurn ?? e.turn) >= o.turn,
    ) ||
    board(o).some(
      (x) =>
        x.controller === c.controller &&
        x.spec.protectsFriendlyTraits?.some((t) => c.spec.traits?.includes(t)),
    )
  )
    return 'yes';
  if (c.spec.invulnerableCondition) {
    const q = publicCondition(o, c, c.spec.invulnerableCondition);
    if (q === true) return 'yes';
    if (q === undefined) return 'unknown';
  }
  // The signature does not contain a combat phase. Do not assume conditional combat immunity is off.
  if (
    c.spec.invulnerableDuringFight ||
    (c.gainedTextBoxes ?? []).some((d) => d.invulnerableCondition || d.invulnerableDuringFight)
  )
    return 'unknown';
  return 'no';
}
export function assessPublicOperation(
  o: Observation,
  c: CardView,
  operation: string,
  amount = 0,
  options: PublicOperationOptions = {},
): PublicOperationAssessment {
  const r = empty(),
    present = options.inPlay ?? board(o).some((x) => x.id === c.id);
  const sign = c.controller === o.you ? -1 : 1;
  const worth = contextualBoardWorth(o, c);
  if (!Number.isFinite(amount) || amount < 0) return empty(true);
  if (!present) {
    const inOwnHand = (o.players[o.you].hand ?? []).some((x) => x.id === c.id);
    if (operation === 'returnHand') {
      if (
        inOwnHand ||
        (c.owner !== o.you &&
          !o.promptCards.some((x) => x.id === c.id) &&
          !o.players.some((p) => [...p.discard, ...p.purged].some((x) => x.id === c.id)))
      )
        return r;
      r.score = (c.owner === o.you ? 1 : -1) * recoveryValue(o, c);
      r.affected = true;
      return r;
    }
    if (operation === 'purge' || operation === 'discard') {
      r.score = (c.owner === o.you ? -1 : 1) * recoveryValue(o, c) * 0.5;
      r.affected = true;
      r.approximate = true;
      return r;
    }
    return empty(true);
  }
  if (['capture', 'captureOwn', 'takeAmber', 'removeAmber', 'addAmber'].includes(operation)) {
    const available =
      operation === 'capture'
        ? o.players[other(c.controller)].amber
        : operation === 'captureOwn'
          ? o.players[c.controller].amber
          : operation === 'takeAmber' || operation === 'removeAmber'
            ? c.captured
            : amount;
    r.affected = amount > 0 && available > 0;
    return r; // Pool math and receipts belong exclusively to the caller.
  }
  const removal = [
    'destroy',
    'sacrifice',
    'purge',
    'returnHand',
    'archive',
    'foreignArchive',
    'deckTop',
    'deckBottom',
    'shuffleDeck',
    'shuffleIntoDeck',
  ].includes(operation);
  let destructive = operation === 'destroy' || operation === 'sacrifice';
  if (destructive) {
    const protection = destructionProtection(o, c);
    if (protection !== 'no') return empty(protection === 'unknown');
  }
  if (operation === 'damage') {
    if (!amount) return r;
    const prevention = destructionProtection(o, c);
    if (prevention !== 'no') return empty(prevention === 'unknown');
    if (
      c.spec.cannotBeDamagedCondition ||
      c.spec.incomingDamageMultipliers?.length ||
      attached(o, c).some(
        (u) => u.spec.upgrade?.hostDamagePreventedIf || u.spec.upgrade?.dividesHostDamageAmongNeighbors,
      ) ||
      board(o).some((x) => x.spec.preventsCreatureDamage || x.spec.preventsReadyCapturedFriendlyDamage) ||
      o.players[c.controller].battleline.some(
        (x, i, line) =>
          x.spec.absorbsNeighborDamage && (line[i - 1]?.id === c.id || line[i + 1]?.id === c.id),
      )
    )
      return empty(true);
  }
  // Ward prevents a positive damage event before armor; destroy immunity is checked before Ward.
  if ((removal || operation === 'damage') && c.warded) {
    r.score = sign * Math.min(1.1, Math.max(0.4, Math.abs(worth) * 0.2));
    r.affected = false;
    return r;
  }
  if (operation === 'damage') {
    const dealt = Math.max(
      0,
      amount - (options.ignoreArmor ? 0 : Math.max(0, c.effective.armor - c.armorUsed)),
    );
    if (!dealt) return r;
    r.affected = true;
    if (dealt < Math.max(0, c.effective.power - c.damage)) {
      r.score = sign * Math.min(Math.max(0, worth) * 0.5, dealt * 0.3);
      return r;
    }
    const protection = destructionProtection(o, c);
    if (protection !== 'no') {
      r.score = sign * Math.min(0.6, dealt * 0.1);
      r.approximate = protection === 'unknown';
      return r;
    }
    destructive = true;
  } else if (!removal) {
    if (operation === 'heal') {
      r.score = -sign * Math.min(c.damage, options.fullHeal ? c.damage : amount) * 0.5;
      r.affected = c.damage > 0 && (options.fullHeal === true || amount > 0);
    } else if (operation === 'ward') {
      if (c.spec.kind !== 'creature') return r;
      r.score = -sign * (c.warded ? 0 : Math.min(1.1, Math.max(0.4, Math.abs(worth) * 0.2)));
      r.affected = !c.warded;
    } else if (operation === 'unward') {
      r.score = sign * (c.warded ? Math.min(1.1, Math.max(0.4, Math.abs(worth) * 0.2)) : 0);
      r.affected = !!c.warded;
    } else if (operation === 'ready') {
      if (
        c.readiness?.cannotReadyByEffect ||
        c.spec.cannotReady ||
        attached(o, c).some((u) => u.spec.upgrade?.cannotReady)
      )
        return r;
      r.score = -sign * (c.ready ? 0 : c.stunned ? 0.5 : 2.4);
      r.affected = !c.ready;
    } else if (operation === 'stun' || operation === 'stunExhaust' || operation === 'exhaust') {
      const stun = operation !== 'exhaust' && !c.stunned,
        exhaust = operation !== 'stun' && c.ready;
      r.score = sign * (stun ? 1.5 : 0) + sign * (exhaust ? 0.7 : 0);
      r.affected = stun || exhaust;
    } else if (operation === 'power') {
      r.score = -sign * amount * 0.45;
      r.affected = amount > 0;
    } else return empty(true);
    return r;
  }
  const d = destructive
    ? hasUnknownDestruction(o, c)
    : { unknown: false, amber: c.captured, approximate: false };
  if (d.unknown) return { ...r, approximate: true }; // No fabricated removal, destruction or credit.
  r.removed = true;
  r.destroyed = destructive;
  r.affected = true;
  r.approximate ||= d.approximate;
  r.score = sign * worth;
  r.approximate ||= (c.physicalParts?.length ?? 0) > 1;
  if (operation === 'returnHand') {
    r.score += (c.owner === o.you ? 1 : -1) * recoveryValue(o, c) * 0.45;
    r.approximate ||= c.owner !== c.controller;
  } else if (operation === 'deckTop' || operation === 'shuffleDeck' || operation === 'shuffleIntoDeck') {
    r.score += (c.owner === o.you ? 1 : -1) * recoveryValue(o, c) * 0.2;
    r.approximate = true;
  } else if (operation === 'archive' || operation === 'foreignArchive') r.approximate = true;
  if (c.spec.kind === 'creature') r.released[relative(o, other(c.controller))] = d.amber;
  return r;
}
export interface PublicOperationGroupRow {
  card: CardView;
  result: PublicOperationAssessment;
  /** The actual departure can replace the requested destruction. */
  operation: string;
  direct: boolean;
}
export interface PublicOperationGroup {
  rows: PublicOperationGroupRow[];
  consumedWards: string[];
  expandedDestroyed: boolean;
  unresolved: boolean;
  /** A public risk bound only; these cards are NOT asserted to depart or refund. */
  possibleDepartureIds: string[];
}

/** Candidate-only, one-window public projection. This deliberately recognizes a
 * small effect shape, not arbitrary nested abilities. Multiple Destroyed windows,
 * choices, replacements and extra leave responses stay unknown. The caller owns
 * pool replacements and applies each actual departure's refund once.
 */
export function assessPublicOperationGroup(
  observation: Observation,
  targets: readonly CardView[],
  operation: string,
  amount = 0,
  options: PublicOperationOptions & {
    removed?: ReadonlySet<string>;
    warded?: ReadonlyMap<string, boolean>;
    captured?: ReadonlyMap<string, number>;
    additionalInPlay?: readonly CardView[];
  } = {},
): PublicOperationGroup {
  const removed = options.removed ?? new Set<string>();
  const wards = new Map(options.warded);
  const consumed = new Set<string>();
  const remaining = (c: CardView) => !removed.has(c.id) && (!c.attachedTo || !removed.has(c.attachedTo));
  const projected = (c: CardView) => ({
    ...c,
    warded: wards.get(c.id) ?? c.warded,
    captured: options.captured?.get(c.id) ?? c.captured,
  });
  const makeView = (): Observation => ({
    ...observation,
    players: observation.players.map((p, seat) => {
      const extra = (options.additionalInPlay ?? []).filter((c) => c.controller === seat && remaining(c));
      const append = (xs: CardView[], kind: string) =>
        [
          ...new Map(
            [...xs, ...extra.filter((c) => c.spec.kind === kind)].filter(remaining).map((c) => [c.id, c]),
          ).values(),
        ].map(projected);
      return {
        ...p,
        battleline: append(p.battleline, 'creature'),
        artifacts: append(p.artifacts, 'artifact'),
        upgrades: append(p.upgrades, 'upgrade'),
      };
    }) as Observation['players'],
  });
  let o = makeView();
  const unique = [...new Map(targets.filter(remaining).map((c) => [c.id, projected(c)])).values()];
  const result: PublicOperationGroup = {
    rows: unique.map((card) => ({
      card,
      result: assessPublicOperation(o, card, operation, amount, options),
      operation,
      direct: true,
    })),
    consumedWards: [],
    expandedDestroyed: false,
    unresolved: false,
    possibleDepartureIds: [],
  };
  const removal = [
    'destroy',
    'sacrifice',
    'purge',
    'returnHand',
    'archive',
    'foreignArchive',
    'deckTop',
    'deckBottom',
    'shuffleDeck',
    'shuffleIntoDeck',
  ].includes(operation);
  for (const { card, result: r } of result.rows) {
    // Immunity is checked before Ward. Ward prevention has nonzero Ward value,
    // unlike an immunity/unknown stop; no full hidden effect state is inferred.
    if (
      card.warded &&
      (removal || (operation === 'damage' && amount > 0)) &&
      !r.removed &&
      !r.affected &&
      !r.approximate &&
      r.score !== 0
    ) {
      wards.set(card.id, false);
      consumed.add(card.id);
    }
  }
  const finish = () => {
    result.consumedWards = [...consumed];
    return result;
  };
  if (!['destroy', 'sacrifice', 'damage'].includes(operation)) return finish();

  const visible = board(o);
  const creatures = o.players.flatMap((p) => p.battleline);
  const unknown = () => {
    result.unresolved = true;
    result.possibleDepartureIds = creatures.map((c) => c.id);
    return finish();
  };
  const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
  const blanking = (c: CardView) =>
    attached(o, c).some((u) => u.spec.upgrade?.blanksHost) ||
    o.lasting.some(
      (e) =>
        e.turn >= o.turn &&
        ((e.rule === 'blankCreatures' && c.spec.kind === 'creature') ||
          (e.rule === 'blankBoostNamed' && e.affectedName === c.spec.name)),
    ) ||
    o.cardEffects.some((e) => e.target === c.id && e.rule === 'blankWhileMarked');
  const suppressed = (c: CardView) =>
    visible.some(
      (x) =>
        !blanking(x) &&
        boxes(x).some(
          (d) =>
            d.suppressesDestroyed ||
            (c.spec.kind === 'creature' && x.controller !== c.controller && d.suppressesEnemyDestroyed),
        ),
    );
  const destroyedEffects = (c: CardView) => [
    ...boxes(c).flatMap((d) => d.abilities?.destroyed ?? []),
    ...attached(o, c).flatMap((u) => u.spec.upgrade?.abilities?.destroyed ?? []),
  ];
  const destroyAttempt = (c: CardView) => {
    if (c.warded || destructionProtection(o, c) === 'yes') return false;
    if (operation !== 'damage') return true;
    // Strip only Destroyed text to test known lethal damage. Existing public
    // damage prevention, armor and replacement gates still apply.
    const stripped: CardView = {
      ...c,
      spec: { ...c.spec, abilities: { ...c.spec.abilities, destroyed: [] } },
      gainedTextBoxes: c.gainedTextBoxes?.map((d) => ({
        ...d,
        abilities: { ...d.abilities, destroyed: [] },
      })),
    };
    return assessPublicOperation(o, stripped, operation, amount, options).destroyed;
  };
  const attempts = unique.filter(destroyAttempt);
  if (!attempts.length) return finish();
  const complex =
    (o.prophecies ?? []).some((p) => p.active) ||
    o.lasting.some(
      (e) =>
        e.turn >= o.turn &&
        [
          'grantEnemyDestroyed',
          'fightDeathDiscard',
          'enemyFightDestroyedToken',
          'anyCreatureDestroyedToken',
          'enemyDestroyedGain',
        ].includes(e.rule),
    ) ||
    visible.some((c) =>
      boxes(c).some(
        (d) =>
          d.purgeCreaturesLeavingPlay ||
          d.firstMutantDeathOwnerGain ||
          d.grantsAbilities?.some((g) => g.abilities.destroyed?.length) ||
          d.reactions?.some((r) => r.event === 'creatureDestroyed') ||
          d.upgrade?.reactions?.some((r) => r.event === 'creatureDestroyed'),
      ),
    );
  const triggers = attempts.filter(
    (c) =>
      !suppressed(c) &&
      (destroyedEffects(c).length > 0 ||
        boxes(c).some(
          (d) => d.destroyedDestination || d.conditionalAbilities?.some((x) => x.abilities.destroyed?.length),
        ) ||
        attached(o, c).some((u) => u.spec.upgrade?.destructionReplacement)),
  );
  if (!triggers.length) return complex ? unknown() : finish();
  const source = triggers[0];
  const effects = destroyedEffects(source);
  const e = effects[0];
  const plainSweep =
    effects.length === 1 &&
    e.kind === 'all' &&
    e.operation === 'shuffleDeck' &&
    Object.keys(e).every((k) => ['kind', 'filter', 'operation'].includes(k)) &&
    Object.entries(e.filter).every(([k, v]) => (k === 'kind' && v === 'creature') || v === undefined);
  if (
    triggers.length !== 1 ||
    !plainSweep ||
    blanking(source) ||
    source.copiedDefinition ||
    source.copiedCharacteristics ||
    source.gainedTextBoxes?.length ||
    source.spec.destroyedDestination ||
    source.spec.conditionalAbilities?.length ||
    creatures.some(
      (c) => c.physicalParts?.length || attached(o, c).some((u) => u.spec.upgrade?.destructionReplacement),
    ) ||
    o.leaveEffects.length ||
    o.controlLayers.some((x) => x.whileSource) ||
    complex ||
    destructionProtection(o, source) !== 'no'
  )
    return unknown();

  // The initial destruction attempt consumed its targets' Wards. Other bodies
  // retain theirs for the following, distinct return-to-deck event.
  o = makeView();
  const direct = new Map(result.rows.map((r) => [r.card.id, r]));
  const chained: PublicOperationGroupRow[] = [];
  for (const card of o.players.flatMap((p) => p.battleline)) {
    const r = assessPublicOperation(o, card, 'shuffleDeck', 0, { inPlay: true });
    const before = direct.get(card.id);
    if (r.removed) {
      // Departure/refund is projected, but this small helper does not certify
      // native onCardDestroyed versus leaves-event payment receipts. A caller
      // with an after(destroyed) dependency must retain that uncertainty.
      chained.push({
        card,
        result: { ...r, destroyed: false, affected: before ? false : r.affected },
        operation: 'shuffleDeck',
        direct: !!before,
      });
      direct.delete(card.id);
    } else {
      if (card.warded && r.score !== 0 && !r.approximate) {
        wards.set(card.id, false);
        consumed.add(card.id);
      }
      if (!before) chained.push({ card, result: r, operation: 'shuffleDeck', direct: false });
    }
  }
  result.rows = [...direct.values(), ...chained];
  result.expandedDestroyed = true;
  return finish();
}
/** Control changes no captured-amber pool and bypasses Ward.
 * Compare controller-relative structural utility before and after transfer. A source-bound transfer
 * has a fixed conservative duration discount, not a prediction of the source's future survival.
 */
export function contextualControlValue(
  o: Observation,
  c: CardView,
  newController: Seat,
  temporary = false,
): number {
  if (!board(o).some((x) => x.id === c.id) || c.controller === newController) return 0;
  const before = contextualBoardWorth(o, c);
  const after = contextualBoardWorth(o, { ...c, controller: newController });
  const value = (c.controller === o.you ? -before : before) + (newController === o.you ? after : -after);
  return value * (temporary ? 0.7 : 1);
}
