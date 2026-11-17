import { keytekiUseMessageMatches } from './keyteki-native-semantics.js';
/** Narrow external compatibility for two audited real-deck pairs.
 * Public views, static configurations and observed transitions only. This never
 * changes core rules or reconstructs an unrestricted hidden effect engine.
 */
import { createHash } from 'node:crypto';
import { canonical } from '../shared/canonical.js';
import type { KeytekiProjection } from './keyteki.js';
import type { KeytekiAllocationPlan } from './keyteki-allocation.js';
import { PUBLIC_CAPTURE_DECK_FACTS, PUBLIC_CAPTURE_PAIRS as PAIRS, getPublicCaptureReference, type CaptureProfile, type PublicRuleReference } from './keyteki-public-capture-facts.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const check: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw Error('public-capture-' + message);
};
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const HOUSES = new Set([
  'brobnar',
  'dis',
  'logos',
  'mars',
  'sanctum',
  'shadows',
  'untamed',
  'saurian',
  'staralliance',
  'unfathomable',
  'ekwidon',
  'geistoid',
  'skyborn',
]);
const ICONS = new Set(['amber', 'capture', 'damage', 'draw', 'discard', 'power']);
const house = (v: unknown): string => {
  const value = str(v).toLowerCase().replace(/\s/g, '');
  check(HOUSES.has(value), 'house-unreported');
  return value;
};
function enhancements(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  check(Array.isArray(v), 'enhancements-unreported');
  return v.map((x) => (ICONS.has(str(x)) ? str(x) : house(x)));
}
export type PublicCaptureSource = 'xenotraining' | 'hypnotic-command' | 'fetchdrones';
type Profile = CaptureProfile;
interface PhysicalCard {
  definition: string;
  upstreamId: string;
  house: string;
  kind: string;
  enhancements: string[];
  count: number;
}
export interface KeytekiPublicCaptureRuleContract {
  kind: 'keyteki-public-capture-rule-contract-v1';
  id: string;
  origin: string;
  frontendBundleSha256: string;
  backendRuleVersion: 'unreported';
  referenceRules: PublicRuleReference;
  profile: Profile;
  participants: {
    playerName: string;
    deckId: string;
    deckName: string;
    serverDeckId: number;
    importReceiptCanonicalSha256: string;
    publicCompositionSha256: string;
    physicalConfigurationSha256: string;
    physicalCards: PhysicalCard[];
  }[];
}
interface Binding {
  origin: string;
  frontendBundleSha256: string;
  participants?: string[];
  deckLists?: Record<string, unknown>;
}
function publicOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (
      ['https:', 'http:'].includes(u.protocol) &&
      u.origin === v &&
      !u.username &&
      !u.password &&
      !['localhost', '[::1]', '0.0.0.0'].includes(u.hostname) &&
      !u.hostname.startsWith('127.') &&
      !u.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
function compositionHash(value: unknown): string {
  check(Array.isArray(value), 'complete-public-composition-required');
  const counts = new Map<string, [string, string, number]>();
  let total = 0;
  for (const item of value) {
    const r = obj(item),
      definition = str(r.definition),
      h = house(r.house),
      count = r.count;
    check(definition && integer(count) && count > 0, 'invalid-public-composition');
    const key = canonical([definition, h]);
    const previous = counts.get(key);
    if (previous) previous[2] += count;
    else counts.set(key, [definition, h, count]);
    total += count;
  }
  check(total === 36, 'complete-36-card-composition-required');
  return hash(
    [...counts.values()].sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
    ),
  );
}
function physicalRows(value: unknown): PhysicalCard[] {
  check(Array.isArray(value) && value.length > 0, 'physical-configuration-required');
  const counts = new Map<string, PhysicalCard>();
  let total = 0;
  for (const item of value) {
    const r = obj(item),
      count = r.count;
    check(
      str(r.definition) &&
        r.definition === r.upstreamId &&
        integer(count) &&
        count > 0 &&
        ['action', 'creature', 'artifact', 'upgrade'].includes(str(r.kind)),
      'physical-row-invalid',
    );
    const body = {
      definition: str(r.definition),
      upstreamId: str(r.upstreamId),
      house: house(r.house),
      kind: str(r.kind),
      enhancements: enhancements(r.enhancements),
    };
    const key = canonical(body),
      previous = counts.get(key);
    if (previous) previous.count += count;
    else counts.set(key, { ...body, count });
    total += count;
  }
  check(total === 36, 'physical-count-is-not-36');
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
}
const contractId = (body: Omit<KeytekiPublicCaptureRuleContract, 'id'>): string =>
  'public-capture-contract-' + hash(body);
export function validatePublicCaptureRuleContract(
  contract: KeytekiPublicCaptureRuleContract,
  binding: Binding,
): void {
  const { id, ...body } = contract;
  check(
    contract.kind === 'keyteki-public-capture-rule-contract-v1' &&
      id === contractId(body) &&
      publicOrigin(contract.origin) &&
      contract.origin === binding.origin &&
      digest(contract.frontendBundleSha256) &&
      contract.frontendBundleSha256 === binding.frontendBundleSha256 &&
      contract.backendRuleVersion === 'unreported' &&
      same(contract.referenceRules, getPublicCaptureReference()) &&
      Object.hasOwn(PAIRS, contract.profile) &&
      Array.isArray(contract.participants) &&
      contract.participants.length === 2 &&
      new Set(contract.participants.map((p) => p.playerName)).size === 2 &&
      same(contract.participants.map((p) => p.deckId).sort(), PAIRS[contract.profile]),
    'contract-binding-invalid',
  );
  for (const p of contract.participants) {
    const facts = PUBLIC_CAPTURE_DECK_FACTS[p.deckId as keyof typeof PUBLIC_CAPTURE_DECK_FACTS];
    check(
      str(p.playerName) &&
        str(p.deckName) &&
        facts &&
        integer(p.serverDeckId) &&
        p.serverDeckId > 0 &&
        digest(p.importReceiptCanonicalSha256) &&
        p.publicCompositionSha256 === facts.publicCompositionSha256 &&
        p.physicalConfigurationSha256 === facts.physicalConfigurationSha256 &&
        hash(physicalRows(p.physicalCards)) === p.physicalConfigurationSha256 &&
        compositionHash(p.physicalCards) === p.publicCompositionSha256,
      'contract-deck-outside-audited-pair',
    );
    if (binding.deckLists)
      check(
        compositionHash(binding.deckLists[p.playerName]) === p.publicCompositionSha256,
        'configured-composition-mismatch',
      );
  }
  if (binding.participants)
    check(
      same([...binding.participants].sort(), contract.participants.map((p) => p.playerName).sort()),
      'participant-binding-mismatch',
    );
}
/** Consumes the data-only public-decks entry, never the synthetic Game loader. */
export function createPublicCaptureRuleContract(
  binding: Pick<Binding, 'origin' | 'frontendBundleSha256'>,
  entries: unknown[],
  participants: string[],
): KeytekiPublicCaptureRuleContract {
  check(entries.length === 2 && participants.length === 2, 'two-real-decks-required');
  const rows = entries.map((value, index) => {
    const entry = obj(value),
      data = obj(entry.data),
      description = obj(entry.description),
      receipt = obj(description.publicImport),
      references = obj(entry.references);
    check(
      receipt.schema === 'keyteki-public-deck-composition-v1' &&
        receipt.account === participants[index] &&
        receipt.uuid === data.uuid &&
        description.uuid === data.uuid &&
        receipt.ordinaryCopiesVerified === true &&
        receipt.ordinaryCopyCount === 36 &&
        receipt.backendRuleVersion === 'unreported' &&
        receipt.referenceDeploymentVerified === false &&
        !references.token &&
        !references.tide &&
        !arr(references.prophecyFaces).length,
      'verified-public-import-required',
    );
    const physicalCards = physicalRows(
      arr(data.cards).map((value) => {
        const r = obj(value),
          card = obj(r.card);
        check(r.isNonDeck === false, 'non-deck-reference-not-allowed');
        const actualHouse = house(r.house ?? card.house);
        check(actualHouse === house(card.house), 'row-and-printing-house-disagree');
        return {
          definition: r.id,
          upstreamId: r.id,
          house: actualHouse,
          kind: card.type,
          enhancements: r.enhancements,
          count: r.count,
        };
      }),
    );
    return {
      playerName: participants[index],
      deckId: str(data.uuid),
      deckName: str(data.name),
      serverDeckId: receipt.serverDeckId as number,
      importReceiptCanonicalSha256: str(receipt.importReceiptCanonicalSha256),
      publicCompositionSha256: compositionHash(entry.publicList),
      physicalConfigurationSha256: hash(physicalCards),
      physicalCards,
    };
  });
  const ids = rows.map((p) => p.deckId).sort(),
    profile = (Object.keys(PAIRS) as Profile[]).find((k) => same(ids, PAIRS[k]));
  check(profile, 'unaudited-deck-pair');
  const body: Omit<KeytekiPublicCaptureRuleContract, 'id'> = {
    kind: 'keyteki-public-capture-rule-contract-v1',
    origin: binding.origin,
    frontendBundleSha256: binding.frontendBundleSha256,
    backendRuleVersion: 'unreported',
    referenceRules: { ...getPublicCaptureReference() },
    profile,
    participants: rows,
  };
  const contract = { ...body, id: contractId(body) };
  validatePublicCaptureRuleContract(contract, binding);
  return contract;
}

export interface KeytekiPublicCaptureQuotaEvidence {
  kind: 'public-capture-contract-and-visible-state';
  contractId: string;
  rule: PublicCaptureSource;
  opponentName: string;
  opponentAmber: number;
  recipientName: string;
  pointsPerClick: 1 | 2;
  allocationStateSha256: string;
  creatureHouses: { id: string; houses: string[]; poltergeistoidsId?: string }[];
  discard?: {
    messageId: string;
    messageSha256: string;
    cardIds: string[];
    logosIds: string[];
    deckCountBefore: number;
    deckCountAfter: number;
  };
}
function cardConfig(card: Obj): string {
  return canonical([str(card.id), house(card.printedHouse), enhancements(card.enhancements)]);
}
/** Public zones only. Hidden hands/decks are not enumerated to infer membership. */
function visibleState(raw: Obj, contract: KeytekiPublicCaptureRuleContract) {
  const players = obj(raw.players),
    names = contract.participants.map((p) => p.playerName).sort();
  check(
    raw.started === true && raw.manualMode === false && same(Object.keys(players).sort(), names),
    'state-identity-or-manual-mode-unreported',
  );
  const inventory = new Map<string, { count: number; kind: string }>();
  for (const p of contract.participants)
    for (const card of p.physicalCards) {
      const key = canonical([card.upstreamId, card.house, card.enhancements]),
        old = inventory.get(key);
      check(!old || old.kind === card.kind, 'physical-kind-ambiguous');
      inventory.set(key, { count: (old?.count ?? 0) + card.count, kind: card.kind });
    }
  const seen = new Set<string>(),
    counts = new Map<string, number>();
  const cards: { name: string; zone: string; card: Obj; stable: Obj }[] = [];
  const visit = (value: unknown, name: string, zone: string, attached = false): void => {
    const card = obj(value),
      id = str(card.uuid);
    check(
      id &&
        !seen.has(id) &&
        str(card.id) &&
        card.facedown !== true &&
        card.copying !== true &&
        card.isToken !== true &&
        card.gigantic !== true,
      'visible-identity-ambiguous',
    );
    seen.add(id);
    const key = cardConfig(card),
      fact = inventory.get(key),
      count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    check(fact && count <= fact.count, 'visible-card-outside-physical-configuration');
    const convertedUpgrade =
      attached &&
      card.type === 'upgrade' &&
      ((contract.profile === 'aoa-wc-no-house-transforms' && card.id === 'explo-rover') ||
        (contract.profile === 'dm-mm-visible-poltergeistoids' && card.id === 'poltergeistoids'));
    check(card.type === fact.kind || convertedUpgrade, 'visible-type-change-outside-contract');
    check(!attached || card.type === 'upgrade', 'attached-card-schema-unknown');
    check(card.upgrades === undefined || Array.isArray(card.upgrades), 'upgrades-unreported');
    const tokens = obj(card.tokens);
    check(
      card.tokens &&
        !Array.isArray(card.tokens) &&
        typeof card.tokens === 'object' &&
        Object.values(tokens).every(integer),
      'tokens-unreported',
    );
    const stable = {
      id,
      definition: card.id,
      house: house(card.printedHouse),
      enhancements: enhancements(card.enhancements),
      type: card.type,
      zone,
      tokens: { ...tokens },
      upgrades: arr(card.upgrades).map((x) => str(obj(x).uuid)),
    };
    cards.push({ name, zone, card, stable });
    for (const upgrade of arr(card.upgrades)) visit(upgrade, name, 'attached:' + id, true);
  };
  const resources: Record<
    string,
    { amber: number; deck: number; archives: number; hand: number; keys: unknown }
  > = {};
  for (const name of names) {
    const p = obj(players[name]),
      piles = obj(p.cardPiles),
      stats = obj(p.stats);
    check(
      integer(stats.amber) &&
        integer(p.numDeckCards) &&
        integer(p.numArchivesCards) &&
        Array.isArray(piles.hand),
      'public-resource-count-unreported',
    );
    const keys = obj(stats.keys);
    check(
      same(Object.keys(keys).sort(), ['blue', 'red', 'yellow']) &&
        Object.values(keys).every((value) => typeof value === 'boolean'),
      'public-keys-unreported',
    );
    resources[name] = {
      amber: stats.amber,
      deck: p.numDeckCards,
      archives: p.numArchivesCards,
      hand: piles.hand.length,
      keys: { ...keys },
    };
    for (const zone of ['cardsInPlay', 'discard', 'purged']) {
      check(Array.isArray(piles[zone]), 'public-zone-unreported');
      for (const card of piles[zone]) visit(card, name, zone);
    }
  }
  return { cards, resources };
}
function stateHash(state: ReturnType<typeof visibleState>): string {
  return hash({ cards: state.cards.map((x) => ({ name: x.name, ...x.stable })), resources: state.resources });
}
export function publicCaptureMessageHash(message: unknown): string {
  const m = obj(message);
  return hash({ activePlayer: m.activePlayer, message: m.message });
}
function freshMessages(before: Obj, after: Obj): Obj[] {
  const a = arr(before.messages).map(obj),
    b = arr(after.messages).map(obj),
    old = a.map((x) => str(x.id)),
    ids = b.map((x) => str(x.id));
  check(
    old.length &&
      !old.some((x) => !x) &&
      !ids.some((x) => !x) &&
      new Set(old).size === old.length &&
      new Set(ids).size === ids.length,
    'message-window-invalid',
  );
  const boundary = ids.indexOf(old.at(-1)!);
  check(boundary >= 0 && boundary < old.length, 'message-window-incomplete');
  const retained = a.slice(old.length - boundary - 1);
  check(
    retained.every(
      (m, i) => m.id === b[i].id && publicCaptureMessageHash(m) === publicCaptureMessageHash(b[i]),
    ),
    'message-window-changed',
  );
  const fresh = b.slice(boundary + 1);
  check(
    fresh.every((m) => !old.includes(str(m.id))),
    'message-id-reused',
  );
  return fresh;
}
function sourceBefore(
  before: Obj,
  name: string,
  sourceId: string,
  source: PublicCaptureSource,
  contract: KeytekiPublicCaptureRuleContract,
): void {
  const p = obj(obj(before.players)[name]),
    piles = obj(p.cardPiles);
  const matches = [...arr(piles.hand), ...arr(piles.cardsInPlay)].map(obj).filter((c) => c.uuid === sourceId);
  check(p.activePlayer === true && matches.length === 1, 'previous-physical-source-unbound');
  const c = matches[0],
    type = source === 'fetchdrones' ? 'artifact' : 'action';
  check(
    c.id === source &&
      c.type === type &&
      c.facedown !== true &&
      c.copying !== true &&
      c.isToken !== true &&
      contract.participants.some((p) =>
        p.physicalCards.some(
          (r) =>
            r.upstreamId === source &&
            r.kind === type &&
            cardConfig(c) === canonical([r.upstreamId, r.house, r.enhancements]),
        ),
      ),
    'previous-source-outside-contract',
  );
}
export function derivePublicCaptureQuota(
  contract: KeytekiPublicCaptureRuleContract,
  beforeValue: unknown,
  currentValue: unknown,
  projection: KeytekiProjection,
  source: PublicCaptureSource,
  sourceId: string,
  targets: string[],
): { amount: number; pointsPerClick: 1 | 2; evidence: KeytekiPublicCaptureQuotaEvidence } {
  const before = obj(beforeValue),
    current = obj(currentValue),
    name = projection.playerName,
    players = obj(current.players),
    names = Object.keys(players).sort((a, b) => a.localeCompare(b, 'en')),
    opponentName = names.find((x) => x !== name);
  check(
    before.id === projection.gameId &&
      current.id === projection.gameId &&
      before.started === true &&
      before.manualMode === false &&
      same(Object.keys(obj(before.players)).sort(), Object.keys(players).sort()) &&
      opponentName &&
      obj(players[name]).activePlayer === true,
    'game-or-actor-binding-invalid',
  );
  for (const [index, n] of names.entries()) {
    const bound = contract.participants.find((p) => p.playerName === n);
    check(
      bound &&
        compositionHash(projection.observation.players[index]?.deckList) === bound.publicCompositionSha256,
      'projected-public-composition-mismatch',
    );
  }
  check(
    (contract.profile === 'aoa-wc-no-house-transforms' && ['xenotraining', 'fetchdrones'].includes(source)) ||
      (contract.profile === 'dm-mm-visible-poltergeistoids' && source === 'hypnotic-command'),
    'source-outside-audited-pair',
  );
  sourceBefore(before, name, sourceId, source, contract);
  const state = visibleState(current, contract),
    opponentAmber = state.resources[opponentName].amber,
    recipientName = source === 'hypnotic-command' ? opponentName : name,
    recipientIds = new Set(
      state.cards
        .filter((x) => x.name === recipientName && x.zone === 'cardsInPlay' && x.card.type === 'creature')
        .map((x) => str(x.card.uuid)),
    );
  check(
    targets.length && new Set(targets).size === targets.length && targets.every((x) => recipientIds.has(x)),
    'offered-target-side-invalid',
  );
  const creatureHouses = state.cards
    .filter((x) => x.name === name && x.zone === 'cardsInPlay' && x.card.type === 'creature')
    .map(({ card }) => {
      const polter = arr(card.upgrades)
        .map(obj)
        .filter((c) => c.id === 'poltergeistoids');
      check(polter.length <= 1, 'poltergeistoids-identity-ambiguous');
      const houses = polter.length
        ? ['geistoid']
        : [
            ...new Set([
              house(card.printedHouse),
              ...enhancements(card.enhancements).filter((x) => HOUSES.has(x)),
            ]),
          ].sort();
      return {
        id: str(card.uuid),
        houses,
        ...(polter.length ? { poltergeistoidsId: str(polter[0].uuid) } : {}),
      };
    });
  const pointsPerClick = source === 'fetchdrones' ? 2 : 1;
  const evidence: KeytekiPublicCaptureQuotaEvidence = {
    kind: 'public-capture-contract-and-visible-state',
    contractId: contract.id,
    rule: source,
    opponentName,
    opponentAmber,
    recipientName,
    pointsPerClick,
    allocationStateSha256: stateHash(state),
    creatureHouses,
  };
  let amount: number;
  if (source === 'xenotraining')
    amount = Math.min(opponentAmber, new Set(creatureHouses.flatMap((x) => x.houses)).size);
  else if (source === 'hypnotic-command')
    amount = Math.min(opponentAmber, creatureHouses.filter((x) => x.houses.includes('mars')).length);
  else {
    const prior = visibleState(before, contract),
      count = prior.resources[name].deck,
      expected = Math.min(2, count),
      fresh = freshMessages(before, current);
    check(expected > 0 && fresh.length === 1, 'fetch-discard-event-not-unique');
    const row = fresh[0],
      m = arr(row.message),
      src = obj(m[2]),
      inner = obj(m[4]);
    check(
      row.activePlayer === name &&
        m.length === 5 &&
        obj(m[0]).argType === 'nonAvatarPlayer' &&
        obj(m[0]).name === name &&
        keytekiUseMessageMatches(m, 'discard') &&
        src.argType === 'card' &&
        src.id === 'fetchdrones' &&
        src.type === 'artifact' &&
        src.facedown !== true,
      'fetch-discard-template-unrecognized',
    );
    const parts = inner.argType === 'card' ? [inner] : arr(inner.message);
    check(
      inner.argType === 'card' || (Object.keys(inner).length === 1 && Array.isArray(inner.message)),
      'fetch-discard-inner-schema-unrecognized',
    );
    check(
      (expected === 1 && parts.length === 1) ||
        (expected === 2 && parts.length === 3 && parts[1] === ' and '),
      'fetch-discard-list-unrecognized',
    );
    const logged = (expected === 1 ? [parts[0]] : [parts[0], parts[2]]).map(obj);
    check(
      logged.every((c) => c.argType === 'card' && str(c.id) && c.facedown !== true),
      'fetch-discard-card-unreported',
    );
    const oldDiscard = prior.cards.filter((x) => x.name === name && x.zone === 'discard'),
      oldIds = new Set(oldDiscard.map((x) => str(x.card.uuid))),
      nextDiscard = state.cards.filter((x) => x.name === name && x.zone === 'discard'),
      added = nextDiscard.filter((x) => !oldIds.has(str(x.card.uuid)));
    check(
      added.length === expected &&
        nextDiscard.length === oldDiscard.length + expected &&
        oldDiscard.every((x) => nextDiscard.some((y) => same(x.stable, y.stable))) &&
        state.resources[name].deck === count - expected,
      'fetch-discard-transition-incomplete',
    );
    // The typed log has no physical UUID. Its full visible multiset must equal
    // the entire newly exposed UUID set; assigning a particular log occurrence
    // to one of two identical physical copies is neither possible nor needed.
    const bound = added.map(({ card }) => card);
    const logKey = (card: Obj) => canonical([str(card.id), str(card.type), enhancements(card.enhancements)]);
    check(same(logged.map(logKey).sort(), bound.map(logKey).sort()), 'fetch-discard-multiset-mismatch');
    const compatible = (log: Obj, card: Obj) =>
      logKey(log) === logKey(card) &&
      (log.printedHouse === undefined || house(log.printedHouse) === house(card.printedHouse));
    check(
      expected === 1
        ? compatible(logged[0], bound[0])
        : (compatible(logged[0], bound[0]) && compatible(logged[1], bound[1])) ||
            (compatible(logged[0], bound[1]) && compatible(logged[1], bound[0])),
      'fetch-discard-reported-house-mismatch',
    );
    const removeAdded = (s: ReturnType<typeof visibleState>, ids: Set<string>) =>
      s.cards.filter((x) => !ids.has(str(x.card.uuid))).map((x) => ({ name: x.name, ...x.stable }));
    const addedIds = new Set(added.map((x) => str(x.card.uuid)));
    check(
      same(removeAdded(prior, new Set()), removeAdded(state, addedIds)),
      'fetch-other-public-cards-changed',
    );
    for (const n of names) {
      const a = prior.resources[n],
        b = state.resources[n];
      check(
        same({ ...a, deck: b.deck }, b) && (n === name || a.deck === b.deck),
        'fetch-other-public-resources-changed',
      );
    }
    const logosIds = bound
      .filter((c) => [house(c.printedHouse), ...enhancements(c.enhancements)].includes('logos'))
      .map((c) => str(c.uuid));
    amount = Math.min(logosIds.length, Math.ceil(opponentAmber / 2));
    evidence.discard = {
      messageId: str(row.id),
      messageSha256: publicCaptureMessageHash(row),
      cardIds: bound.map((c) => str(c.uuid)),
      logosIds,
      deckCountBefore: count,
      deckCountAfter: state.resources[name].deck,
    };
  }
  check(integer(amount) && amount > 0, 'quota-does-not-explain-open-prompt');
  return { amount, pointsPerClick, evidence };
}

export interface KeytekiPublicCaptureSettlement {
  status: 'not-required' | 'pending' | 'verified' | 'unverifiable';
  reason?: string;
  contractId?: string;
  gameId?: string;
  playerName?: string;
  planId?: string;
  promptUuid?: string;
  sourceDefinition?: PublicCaptureSource;
  pointsPerClick?: 1 | 2;
  expectedClicks?: number;
  expectedCaptured?: number;
  opponentAmberBefore?: number;
  opponentAmberAfter?: number;
  recipientName?: string;
  targetCaptures?: Record<string, { before: number; after: number; expectedDelta: number }>;
}
/** Complete visible deltas are enough for these audited normal states. No
 * capture log is invented as a server ACK, and unknown leave-play effects stop. */
export function observePublicCaptureSettlement(
  plan: KeytekiAllocationPlan,
  beforeValue: unknown,
  afterValue: unknown,
  contract: KeytekiPublicCaptureRuleContract | undefined,
): KeytekiPublicCaptureSettlement {
  const d = plan.descriptor,
    e = d.amountEvidence;
  if (e.kind !== 'public-capture-contract-and-visible-state') return { status: 'not-required' };
  const base = {
    contractId: e.contractId,
    gameId: d.gameId,
    playerName: d.playerName,
    planId: plan.id,
    promptUuid: d.promptUuid,
    sourceDefinition: e.rule,
    pointsPerClick: e.pointsPerClick,
    expectedClicks: d.amount,
    expectedCaptured: Math.min(e.opponentAmber, d.amount * e.pointsPerClick),
    opponentAmberBefore: e.opponentAmber,
    recipientName: e.recipientName,
  };
  try {
    const before = obj(beforeValue),
      after = obj(afterValue);
    check(
      contract &&
        contract.id === e.contractId &&
        before.id === d.gameId &&
        after.id === d.gameId &&
        plan.targets.length === d.amount &&
        plan.commands.length === d.amount &&
        plan.targets.every((id) => d.allowedTargets.includes(id)) &&
        d.sourceDefinition === e.rule &&
        (d.pointsPerClick ?? 1) === e.pointsPerClick,
      'settlement-binding-invalid',
    );
    const beforeMe = obj(obj(before.players)[d.playerName]),
      afterMe = obj(obj(after.players)[d.playerName]);
    const prompt = (me: Obj) => arr(me.controls).some((c) => obj(c).uuid === d.promptUuid + ':0');
    check(prompt(beforeMe), 'settlement-initial-prompt-missing');
    if (prompt(afterMe)) return { ...base, status: 'pending' };
    const a = visibleState(before, contract),
      b = visibleState(after, contract);
    check(
      stateHash(a) === e.allocationStateSha256 && a.resources[e.opponentName].amber === e.opponentAmber,
      'settlement-before-state-changed',
    );
    const targets = new Map<string, number>();
    for (const id of plan.targets) targets.set(id, (targets.get(id) ?? 0) + e.pointsPerClick);
    let remaining = e.opponentAmber;
    for (const [id, requested] of targets) {
      const actual = Math.min(requested, remaining);
      targets.set(id, actual);
      remaining -= actual;
    }
    const targetCaptures: NonNullable<KeytekiPublicCaptureSettlement['targetCaptures']> = {};
    const normalize = (state: ReturnType<typeof visibleState>, isAfter: boolean) =>
      state.cards
        .filter((x) => !(e.rule !== 'fetchdrones' && x.card.uuid === d.sourceCardId))
        .map((x) => {
          const stable = structuredClone(x.stable),
            id = str(x.card.uuid),
            tokens = obj(stable.tokens),
            delta = targets.get(id) ?? 0;
          if (targets.has(id)) {
            check(
              x.name === e.recipientName && x.zone === 'cardsInPlay' && x.card.type === 'creature',
              'settlement-target-left-visible-play',
            );
            const captured = tokens.amber ?? 0;
            check(integer(captured), 'settlement-captured-amber-unreported');
            if (isAfter)
              targetCaptures[id] = { before: captured - delta, after: captured, expectedDelta: delta };
            tokens.amber = captured - (isAfter ? delta : 0);
          } else if (tokens.amber === undefined) tokens.amber = 0;
          return { name: x.name, ...stable, tokens };
        });
    check(
      same(normalize(a, false), normalize(b, true)) && Object.keys(targetCaptures).length === targets.size,
      'settlement-public-card-deltas-unknown',
    );
    for (const name of Object.keys(a.resources)) {
      const expected = {
        ...a.resources[name],
        amber: name === e.opponentName ? remaining : a.resources[name].amber,
      };
      check(same(expected, b.resources[name]), 'settlement-public-resource-deltas-unknown');
    }
    return { ...base, status: 'verified', opponentAmberAfter: remaining, targetCaptures };
  } catch (error) {
    return {
      ...base,
      status: 'unverifiable',
      reason: error instanceof Error ? error.message : 'public-capture-settlement-unverifiable',
    };
  }
}
