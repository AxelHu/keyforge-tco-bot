import { getVerifiedVeilConfiguration } from './keyteki-public-capture-facts.js';
/** A complete draft for Keyteki's batch-settled AllocateAmberPrompt.
 * Only player-visible views and their public message history enter this module.
 * Draft choices are not captures, receipts, or a replacement legal-action engine.
 */
import { createHash } from 'node:crypto';
import { canonical } from '../shared/canonical.js';
import type { StrategyController, StrategyDecision, StrategyFrame } from '../ai/strategy-controller.js';
import { compileKeytekiCommand, type KeytekiCommand, type KeytekiProjection } from './keyteki.js';
import {
  derivePublicCaptureQuota,
  publicCaptureMessageHash,
  validatePublicCaptureRuleContract,
  type KeytekiPublicCaptureRuleContract,
  type KeytekiPublicCaptureQuotaEvidence,
} from './keyteki-public-capture.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const hash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
const normalizedHouse = (v: unknown): string =>
  str(v)
    .toLowerCase()
    .replace(/[^a-z]/g, '');

const VEIL_PIN = '361c085bcd401c20976ee9bcc4e4e5b8c061d56c';
const ORDINARY_ENHANCEMENTS = new Set(['amber', 'capture', 'damage', 'draw', 'discard', 'power']);
const ORDINARY_BONUS_SELECT_TITLES = new Set([
  'Choose a creature to capture amber due to bonus icon',
  'Choose a creature to damage due to bonus icon',
  'Choose a card to discard due to bonus icon',
  'Choose a creature to add a +1 power counter to due to bonus icon',
]);
const FESTIVAL_MESSAGE_TEMPLATES = [
  [' uses ', ' to capture ', ' amber onto friendly creatures'],
  [' 使用 ', ' 抢占 ', ' 琥珀放置到友方生物上'],
] as const;
/** Static AllocateCaptureAction callers in the pinned upstream. Recognizing a
 * batch is separate from proving its quota: unsupported callers must not fall
 * through to a single click whose accepted prefix has no visible settlement.
 * These are UI protocol labels, never live card effect text.
 */
const CAPTURE_BATCH_TITLES: Readonly<Record<string, string>> = {
  'veil-of-ectoplasm': 'Choose a creature to capture 1 amber',
  'hallowed-eve-festival': 'Choose a creature to capture 1 amber',
  'bring-low': 'Choose a creature to capture 1 amber',
  fathomshare: 'Choose a friendly creature to capture 1 amber on',
  xenotraining: 'Choose a creature to capture 1 amber',
  'shard-of-hope': 'Choose a creature to capture 1 amber',
  'sirs-colossus': 'Choose a creature to capture 1 amber',
  'hypnotic-command': 'Choose a creature to capture 1 amber from its controller',
  fetchdrones: 'Choose a creature to capture 2 amber',
  'cryptic-collapse': 'Choose a creature to capture 1 amber',
  'gilded-burden': 'Choose an enemy creature to capture 2 amber on',
  'productive-trash': 'Choose a creature to capture 1 amber',
  gargantodon: 'Choose a creature to capture amber',
};
/** This is an explicit local-fixture capability, not evidence about a public server.
 * The fixed selected rules have no house-changing effect on cards in the discard.
 * House enhancements are excluded separately, including from public discard views.
 */
export interface KeytekiVerifiedVeilScope {
  kind: 'keyteki-veil-fixed-profile-v1';
  id: string;
  commit: string;
  sourceManifestSha256: string;
  runtimeLockSha256: string;
  participants: { playerName: string; deckId: string; publicCompositionSha256: string }[];
}
const PUBLIC_VEIL_RULE = 'min-opponent-amber-visible-geistoid-discard-cards-v1';
interface PublicVeilPhysicalCard {
  definition: string;
  upstreamId: string;
  house: string;
  count: number;
  enhancements: string[];
}
/** An explicitly selected compatibility rule, not an attestation of server code.
 * Empirical settlements are recorded separately from this expected rule contract.
 */
export interface KeytekiPublicVeilRuleContract {
  kind: 'keyteki-public-veil-rule-contract-v1';
  id: string;
  origin: string;
  frontendBundleSha256: string;
  backendRuleVersion: 'unreported';
  rule: typeof PUBLIC_VEIL_RULE;
  referenceRules: {
    commit: string;
    sourceManifestSha256: string;
    serverDeploymentAttestation: false;
  };
  participants: {
    playerName: string;
    deckId: string;
    publicCompositionSha256: string;
    physicalConfigurationSha256: string;
    physicalCards: PublicVeilPhysicalCard[];
  }[];
}
interface PublicVeilBinding {
  origin: string;
  frontendBundleSha256: string;
  participants?: string[];
  deckLists?: Record<string, unknown>;
}
const digest = (v: unknown): boolean => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function publicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      !['localhost', '[::1]', '0.0.0.0'].includes(url.hostname) &&
      !url.hostname.endsWith('.localhost') &&
      !url.hostname.startsWith('127.')
    );
  } catch {
    return false;
  }
}
function publicContractId(body: Omit<KeytekiPublicVeilRuleContract, 'id'>): string {
  return 'public-veil-contract-' + hash(body);
}
export function validatePublicVeilRuleContract(
  contract: KeytekiPublicVeilRuleContract,
  binding: PublicVeilBinding,
): void {
  const { id, ...body } = contract;
  if (
    contract.kind !== 'keyteki-public-veil-rule-contract-v1' ||
    !publicOrigin(contract.origin) ||
    contract.origin !== binding.origin ||
    !digest(contract.frontendBundleSha256) ||
    contract.frontendBundleSha256 !== binding.frontendBundleSha256 ||
    contract.backendRuleVersion !== 'unreported' ||
    contract.rule !== PUBLIC_VEIL_RULE ||
    contract.referenceRules?.commit !== VEIL_PIN ||
    contract.referenceRules?.sourceManifestSha256 !== getVerifiedVeilConfiguration().sourceManifestSha256 ||
    contract.referenceRules?.serverDeploymentAttestation !== false ||
    !Array.isArray(contract.participants) ||
    contract.participants.length !== 2 ||
    new Set(contract.participants.map((p) => p.playerName)).size !== 2 ||
    !contract.participants.some((p) => p.deckId === getVerifiedVeilConfiguration().requiredDeckId) ||
    id !== publicContractId(body)
  )
    throw Error('Invalid public Veil rule contract or origin/frontend binding');
  for (const p of contract.participants) {
    if (
      !p.playerName ||
      !getVerifiedVeilConfiguration().decks[p.deckId] ||
      p.publicCompositionSha256 !== getVerifiedVeilConfiguration().decks[p.deckId] ||
      !Array.isArray(p.physicalCards) ||
      p.physicalConfigurationSha256 !== hash(p.physicalCards) ||
      p.physicalCards.some(
        (c) =>
          !c.upstreamId ||
          !Array.isArray(c.enhancements) ||
          c.enhancements.some((icon) => !ORDINARY_ENHANCEMENTS.has(icon)),
      ) ||
      keytekiPublicCompositionHash(p.physicalCards) !== p.publicCompositionSha256 ||
      (binding.participants && !binding.participants.includes(p.playerName)) ||
      (binding.deckLists &&
        keytekiPublicCompositionHash(binding.deckLists[p.playerName]) !== p.publicCompositionSha256)
    )
      throw Error('Public Veil contract requires complete fixed compositions and physical enhancements');
  }
  if (binding.participants && (binding.participants.length !== 2 || new Set(binding.participants).size !== 2))
    throw Error('Public Veil contract requires two exact participants');
}
/** Accepts the existing prepareDeck() entries; no referee, backend or hidden view is loaded. */
export function createPublicVeilRuleContract(
  binding: Pick<PublicVeilBinding, 'origin' | 'frontendBundleSha256'>,
  deckEntries: unknown[],
  participants: string[],
): KeytekiPublicVeilRuleContract {
  if (deckEntries.length !== 2 || participants.length !== 2)
    throw Error('Public Veil contract requires two complete deck entries');
  const entries = deckEntries.map((value, index) => {
    const entry = obj(value),
      data = obj(entry.data),
      rows = arr(entry.publicList).map(obj);
    const deckId = str(obj(entry.description).uuid) || str(data.uuid);
    if (str(data.uuid) !== deckId) throw Error('Public Veil physical deck identity mismatch');
    const publicCompositionSha256 = keytekiPublicCompositionHash(rows);
    const physicalCards = arr(data.cards)
      .map((value): PublicVeilPhysicalCard => {
        const c = obj(value),
          printed = obj(c.card),
          upstreamId = str(c.id);
        const house = normalizedHouse(c.maverick ?? printed.house);
        const matches = rows.filter(
          (r) =>
            normalizedHouse(r.house) === house &&
            (r.definition === upstreamId || (str(r.name) && r.name === printed.name)),
        );
        const enhancements = c.enhancements === undefined ? [] : c.enhancements;
        if (
          !upstreamId ||
          matches.length !== 1 ||
          !Number.isSafeInteger(c.count) ||
          (c.count as number) < 1 ||
          !Array.isArray(enhancements) ||
          enhancements.some((icon) => !ORDINARY_ENHANCEMENTS.has(str(icon)))
        )
          throw Error('Unbound public Veil physical copy or unsupported house enhancements');
        return {
          definition: str(matches[0].definition),
          upstreamId,
          house,
          count: c.count as number,
          enhancements: [...enhancements] as string[],
        };
      })
      .sort((a, b) => canonical(a).localeCompare(canonical(b), 'en'));
    return {
      playerName: participants[index],
      deckId,
      publicCompositionSha256,
      physicalConfigurationSha256: hash(physicalCards),
      physicalCards,
    };
  });
  const body: Omit<KeytekiPublicVeilRuleContract, 'id'> = {
    kind: 'keyteki-public-veil-rule-contract-v1',
    origin: binding.origin,
    frontendBundleSha256: binding.frontendBundleSha256,
    backendRuleVersion: 'unreported',
    rule: PUBLIC_VEIL_RULE,
    referenceRules: {
      commit: VEIL_PIN,
      sourceManifestSha256: getVerifiedVeilConfiguration().sourceManifestSha256,
      serverDeploymentAttestation: false,
    },
    participants: entries,
  };
  const contract = { ...body, id: publicContractId(body) };
  validatePublicVeilRuleContract(contract, { ...binding, participants });
  return contract;
}
export function keytekiPublicCompositionHash(rows: unknown): string {
  if (!Array.isArray(rows) || !rows.length) throw Error('Missing complete public deck composition');
  const counts = new Map<string, [string, string, number]>();
  let total = 0;
  for (const value of rows) {
    const row = obj(value),
      definition = str(row.definition),
      house = normalizedHouse(row.house),
      count = row.count;
    if (!definition || !house || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1)
      throw Error('Invalid public deck composition');
    const key = JSON.stringify([definition, house]),
      previous = counts.get(key);
    if (previous) previous[2] += count;
    else counts.set(key, [definition, house, count]);
    total += count;
  }
  if (total !== 36) throw Error('Expected a complete 36-card public composition');
  const tuples = [...counts.values()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return hash(tuples);
}
function scopeHash(scope: Omit<KeytekiVerifiedVeilScope, 'id'>): string {
  return 'veil-scope-' + hash(scope);
}
function validateVeilScope(scope: KeytekiVerifiedVeilScope): void {
  const { id, ...body } = scope;
  if (
    scope.kind !== 'keyteki-veil-fixed-profile-v1' ||
    scope.commit !== VEIL_PIN ||
    scope.sourceManifestSha256 !== getVerifiedVeilConfiguration().sourceManifestSha256 ||
    scope.runtimeLockSha256 !== getVerifiedVeilConfiguration().runtimeLockSha256 ||
    !Array.isArray(scope.participants) ||
    scope.participants.length !== 2 ||
    new Set(scope.participants.map((p) => p.playerName)).size !== 2 ||
    scope.participants.some(
      (p) => !p.playerName || !getVerifiedVeilConfiguration().decks[p.deckId] || getVerifiedVeilConfiguration().decks[p.deckId] !== p.publicCompositionSha256,
    ) ||
    !scope.participants.some((p) => p.deckId === getVerifiedVeilConfiguration().requiredDeckId) ||
    id !== scopeHash(body)
  )
    throw Error('Unverified Veil fixture scope');
}
export function createVerifiedVeilScope(
  profile: unknown,
  deckEntries: unknown[],
  participants: string[],
): KeytekiVerifiedVeilScope {
  const p = obj(profile);
  if (
    p.id !== 'tullibint-gr' ||
    p.commit !== VEIL_PIN ||
    p.sourceManifestSha256 !== getVerifiedVeilConfiguration().sourceManifestSha256 ||
    p.runtimeLockSha256 !== getVerifiedVeilConfiguration().runtimeLockSha256 ||
    deckEntries.length !== 2 ||
    participants.length !== 2
  )
    throw Error('Veil scope requires the exact verified Tullibint fixture profile');
  const entries = deckEntries.map((value, index) => {
    const entry = obj(value),
      data = obj(entry.data),
      deckId = str(obj(entry.description).uuid) || str(data.uuid);
    const publicCompositionSha256 = keytekiPublicCompositionHash(entry.publicList);
    if (!getVerifiedVeilConfiguration().decks[deckId] || getVerifiedVeilConfiguration().decks[deckId] !== publicCompositionSha256)
      throw Error('Veil scope does not cover this complete public deck composition');
    const rows = arr(data.cards).map(obj);
    if (
      !rows.length ||
      rows.some(
        (row) =>
          row.enhancements !== undefined &&
          (!Array.isArray(row.enhancements) ||
            row.enhancements.some((x) => !ORDINARY_ENHANCEMENTS.has(str(x)))),
      )
    )
      throw Error('Veil scope excludes added or unknown house enhancements');
    return { playerName: participants[index], deckId, publicCompositionSha256 };
  });
  const body: Omit<KeytekiVerifiedVeilScope, 'id'> = {
    kind: 'keyteki-veil-fixed-profile-v1',
    commit: VEIL_PIN,
    sourceManifestSha256: getVerifiedVeilConfiguration().sourceManifestSha256,
    runtimeLockSha256: getVerifiedVeilConfiguration().runtimeLockSha256,
    participants: entries,
  };
  const scope = { ...body, id: scopeHash(body) };
  validateVeilScope(scope);
  return scope;
}

export interface KeytekiAllocationDescriptor {
  id: string;
  gameId: string;
  playerName: string;
  promptUuid: string;
  sourceCardId: string;
  sourceDefinition:
    | 'veil-of-ectoplasm'
    | 'hallowed-eve-festival'
    | 'bring-low'
    | 'fathomshare'
    | 'shard-of-hope'
    | 'xenotraining'
    | 'hypnotic-command'
    | 'fetchdrones';
  /** Number of clicks, separate from the points assigned by each click. */
  amount: number;
  pointsPerClick?: 1 | 2;
  amountEvidence:
    | KeytekiPublicCaptureQuotaEvidence
    | {
        kind: 'visible-discard-and-opponent-amber';
        discardIds: string[];
        opponentAmber: number;
        verifiedScopeId: string;
      }
    | {
        kind: 'public-rule-contract-and-visible-discard';
        contractId: string;
        origin: string;
        frontendBundleSha256: string;
        backendRuleVersion: 'unreported';
        discardIds: string[];
        opponentName: string;
        opponentAmber: number;
      }
    | { kind: 'new-public-effect-message'; messageId: string; amount: number }
    | {
        kind: 'new-public-effect-message-and-opponent-amber';
        messageId: string;
        messageSha256: string;
        amount: number;
        opponentName: string;
        opponentAmber: number;
        rule: 'max-opponent-amber-minus-five' | 'floor-half-opponent-amber' | 'published-shard-capture-count';
      };
  allowedTargets: string[];
  baseFingerprint: string;
  observedFromPromptStart: true;
}
export type KeytekiAllocationObservation =
  | { status: 'none' }
  | { status: 'ready'; descriptor: KeytekiAllocationDescriptor }
  | { status: 'unsupported'; reason: string };
export interface KeytekiAllocationPlan {
  kind: 'keyteki-allocation-plan-v1';
  id: string;
  descriptor: KeytekiAllocationDescriptor;
  decisions: StrategyDecision[];
  finalDecision: StrategyDecision;
  finalFrame: StrategyFrame;
  commands: KeytekiCommand[];
  targets: string[];
  draftAllocations: Record<string, number>;
}
function position(p: KeytekiProjection): string {
  return hash({
    gameId: p.gameId,
    playerName: p.playerName,
    observation: { ...p.observation, revision: 0 },
    commands: p.commands,
    unsupported: p.unsupported,
    unknown: p.unknown,
  });
}
function capturePromptCandidate(
  raw: unknown,
  name: string,
): { me: Obj; controls: Obj[]; source: string } | null {
  const me = obj(obj(obj(raw).players)[name]);
  if (me.selectCard !== true) return null;
  const controls = arr(me.controls).map(obj),
    source = str(
      obj(controls.find((c) => Object.hasOwn(CAPTURE_BATCH_TITLES, str(obj(c.source).id)))?.source).id,
    ),
    title = str(me.menuTitle);
  // These exact ResolveBonusIconsAction titles belong to ordinary SelectCardPrompts,
  // even when their short source has the ID of a card with a later batch ability.
  if (
    !source ||
    ORDINARY_BONUS_SELECT_TITLES.has(title) ||
    (!['bring-low', 'fathomshare', 'shard-of-hope', 'xenotraining'].includes(source) &&
      !/^Choose\b.*\bcapture\b.*\bamber\b/.test(title))
  )
    return null;
  return { me, controls, source };
}
function recognizedPrompt(raw: unknown, name: string): { key: string; source: string } | null {
  const candidate = capturePromptCandidate(raw, name);
  if (!candidate) return null;
  const { me, controls, source } = candidate;
  if (
    me.selectOrder === true ||
    me.menuTitle !== CAPTURE_BATCH_TITLES[source] ||
    arr(me.buttons).length ||
    controls.length !== 1 ||
    controls[0].type !== 'targeting' ||
    arr(controls[0].targets).length
  )
    return null;
  const binding = str(controls[0].uuid);
  if (!/^.+:0$/.test(binding)) return null;
  return { key: binding.slice(0, -2), source };
}

function quotaMessageHash(message: Obj): string {
  return hash({ activePlayer: message.activePlayer, message: message.message });
}
/** Require an unchanged retained suffix before accepting any fresh effect event.
 * A disconnected/reordered/reused-ID window is not a new quota observation.
 */
function newMessagesAfterWindow(previous: Obj[], current: Obj[]): Obj[] | null {
  const oldIds = previous.map((m) => str(m.id)),
    ids = current.map((m) => str(m.id));
  if (
    oldIds.some((id) => !id) ||
    ids.some((id) => !id) ||
    new Set(oldIds).size !== oldIds.length ||
    new Set(ids).size !== ids.length
  )
    return null;
  if (!oldIds.length) return null;
  const boundary = ids.indexOf(oldIds.at(-1)!);
  if (boundary < 0 || boundary >= oldIds.length) return null;
  const retained = previous.slice(oldIds.length - boundary - 1);
  if (retained.some((m, i) => m.id !== current[i].id || quotaMessageHash(m) !== quotaMessageHash(current[i])))
    return null;
  const fresh = current.slice(boundary + 1);
  return fresh.some((m) => oldIds.includes(str(m.id))) ? null : fresh;
}

/** Observe every player view starting before the allocation prompt. A first full
 * view already inside the prompt cannot reveal how many clicks were accepted.
 */
export class KeytekiAllocationTracker {
  private readonly verifiedVeilScope?: KeytekiVerifiedVeilScope;
  private readonly publicVeilRuleContract?: KeytekiPublicVeilRuleContract;
  private readonly publicCaptureRuleContract?: KeytekiPublicCaptureRuleContract;
  private identity?: string;
  private seen = false;
  private prompt?: string;
  private result: KeytekiAllocationObservation = { status: 'none' };
  private messages = new Set<string>();
  private messageWindow: Obj[] = [];
  private previousRaw?: Obj;
  private stopped?: string;
  constructor(
    options: {
      verifiedVeilScope?: KeytekiVerifiedVeilScope;
      publicVeilRuleContract?: KeytekiPublicVeilRuleContract;
      publicCaptureRuleContract?: KeytekiPublicCaptureRuleContract;
      origin?: string;
      frontendBundleSha256?: string;
    } = {},
  ) {
    if (options.verifiedVeilScope && (options.publicVeilRuleContract || options.publicCaptureRuleContract))
      throw Error('Local Veil verification and public rule contracts are separate capabilities');
    if (options.verifiedVeilScope) {
      validateVeilScope(options.verifiedVeilScope);
      this.verifiedVeilScope = structuredClone(options.verifiedVeilScope);
    }
    if (options.publicVeilRuleContract) {
      validatePublicVeilRuleContract(options.publicVeilRuleContract, {
        origin: options.origin ?? '',
        frontendBundleSha256: options.frontendBundleSha256 ?? '',
      });
      this.publicVeilRuleContract = structuredClone(options.publicVeilRuleContract);
    }
    if (options.publicCaptureRuleContract) {
      validatePublicCaptureRuleContract(options.publicCaptureRuleContract, {
        origin: options.origin ?? '',
        frontendBundleSha256: options.frontendBundleSha256 ?? '',
      });
      this.publicCaptureRuleContract = structuredClone(options.publicCaptureRuleContract);
    }
  }
  reset(): void {
    this.identity = undefined;
    this.seen = false;
    this.prompt = undefined;
    this.result = { status: 'none' };
    this.messages.clear();
    this.messageWindow = [];
    this.previousRaw = undefined;
    this.stopped = undefined;
  }
  markUnknown(reason: string): void {
    this.stopped = reason;
    this.result = { status: 'unsupported', reason: 'allocation-outcome-unknown: ' + reason };
  }
  observe(raw: unknown, p: KeytekiProjection): KeytekiAllocationObservation {
    const identity = canonical([p.gameId, p.playerName]);
    if (this.identity !== identity) {
      this.reset();
      this.identity = identity;
    }
    if (this.publicCaptureRuleContract && obj(raw).started === true && obj(raw).manualMode !== false) {
      this.stopped = 'public-capture-manual-mode-invalidates-fixed-deck-effects';
      this.result = { status: 'unsupported', reason: this.stopped };
    }
    if (this.stopped) return structuredClone(this.result);
    const current = recognizedPrompt(raw, p.playerName),
      priorMessages = this.messages,
      previousWindow = this.messageWindow,
      beforeRaw = this.previousRaw;
    this.previousRaw = structuredClone(obj(raw));
    this.messageWindow = structuredClone(arr(obj(raw).messages).map(obj));
    this.messages = new Set(
      arr(obj(raw).messages)
        .map((m) => str(obj(m).id))
        .filter(Boolean),
    );
    if (!current) {
      this.seen = true;
      this.prompt = undefined;
      this.result = capturePromptCandidate(raw, p.playerName)
        ? { status: 'unsupported', reason: 'allocation-prompt-schema-unsupported' }
        : { status: 'none' };
      return this.result;
    }
    if (this.prompt === current.key) {
      if (this.result.status === 'ready' && this.result.descriptor.baseFingerprint !== position(p))
        this.result = {
          status: 'unsupported',
          reason: 'allocation-public-position-changed-before-completion',
        };
      if (
        this.result.status === 'ready' &&
        this.result.descriptor.amountEvidence.kind === 'new-public-effect-message-and-opponent-amber'
      ) {
        const evidence = this.result.descriptor.amountEvidence,
          messages = this.messageWindow.filter((m) => m.id === evidence.messageId);
        if (messages.length !== 1 || quotaMessageHash(messages[0]) !== evidence.messageSha256)
          this.result = { status: 'unsupported', reason: 'allocation-public-quota-event-changed-or-missing' };
      }
      if (
        this.result.status === 'ready' &&
        this.result.descriptor.amountEvidence.kind === 'public-capture-contract-and-visible-state'
      ) {
        const discard = this.result.descriptor.amountEvidence.discard;
        if (discard) {
          const messages = this.messageWindow.filter((m) => m.id === discard.messageId);
          if (messages.length !== 1 || publicCaptureMessageHash(messages[0]) !== discard.messageSha256)
            this.result = {
              status: 'unsupported',
              reason: 'allocation-fetch-discard-event-changed-or-missing',
            };
        }
      }
      return structuredClone(this.result);
    }
    const sawEarlier = this.seen;
    this.seen = true;
    this.prompt = current.key;
    const fail = (reason: string): KeytekiAllocationObservation =>
      (this.result = { status: 'unsupported', reason });
    if (!sawEarlier)
      return fail('allocation-start-unobserved: first view is already inside a batch allocation');
    if (p.unsupported.length) return fail('allocation-projection-unsupported');
    const source = p.observation.pending?.source;
    if (!source || source.startsWith('keyteki-prompt-source:'))
      return fail('allocation-physical-source-unbound');
    const candidates = p.observation.legalActions;
    if (
      !candidates.length ||
      candidates.some(
        ({ action, id }) =>
          action.kind !== 'select' ||
          p.commands[id]?.message !== 'cardClicked' ||
          p.commands[id].args[0] !== action.target,
      )
    )
      return fail('allocation-target-schema-unsupported');
    const allowedTargets = candidates.map((x) => (x.action as { kind: 'select'; target: string }).target);
    let amount: number,
      evidence: KeytekiAllocationDescriptor['amountEvidence'],
      pointsPerClick: 1 | 2 | undefined;
    if (current.source === 'veil-of-ectoplasm') {
      const scope = this.publicVeilRuleContract ?? this.verifiedVeilScope;
      if (!scope)
        return fail(
          'allocation-veil-effective-discard-houses-unknown: verified fixed-profile scope required, or an explicit public rule contract',
        );
      try {
        const names = Object.keys(obj(obj(raw).players)).sort((a, b) => a.localeCompare(b, 'en'));
        for (const [index, name] of names.entries()) {
          const bound = scope.participants.find((x) => x.playerName === name);
          if (
            !bound ||
            keytekiPublicCompositionHash(p.observation.players[index]?.deckList) !==
              bound.publicCompositionSha256
          )
            return fail('allocation-veil-public-composition-outside-verified-scope');
        }
        if (names.length !== 2) return fail('allocation-veil-public-composition-outside-verified-scope');
      } catch {
        return fail('allocation-veil-public-composition-outside-verified-scope');
      }
      const players = obj(obj(raw).players),
        mine = obj(players[p.playerName]);
      const discard = arr(obj(mine.cardPiles).discard).map(obj);
      if (
        discard.some(
          (c) =>
            !str(c.uuid) ||
            !str(c.id) ||
            c.facedown === true ||
            !normalizedHouse(c.printedHouse) ||
            c.copying === true,
        )
      )
        return fail('allocation-discard-house-unreported');
      if (
        discard.some(
          (c) =>
            c.enhancements !== undefined &&
            (!Array.isArray(c.enhancements) ||
              c.enhancements.some((x) => !ORDINARY_ENHANCEMENTS.has(str(x)))),
        )
      )
        return fail('allocation-discard-house-enhancement-outside-verified-scope');
      if (this.publicVeilRuleContract) {
        const bound = this.publicVeilRuleContract.participants.find((x) => x.playerName === p.playerName)!;
        const friendlyCreatures = new Set(
          p.observation.players[p.observation.you].battleline.map((c) => c.id),
        );
        if (allowedTargets.some((id) => !friendlyCreatures.has(id)))
          return fail('allocation-public-contract-target-is-not-a-visible-friendly-creature');
        const counts = new Map<string, number>();
        const ids = new Set<string>();
        for (const card of discard) {
          if (ids.has(str(card.uuid)) || card.uuid === source)
            return fail('allocation-public-contract-discard-identity-ambiguous');
          ids.add(str(card.uuid));
          const matches = bound.physicalCards.filter(
            (row) =>
              row.upstreamId === card.id &&
              row.house === normalizedHouse(card.printedHouse) &&
              canonical(row.enhancements) === canonical(card.enhancements ?? []),
          );
          const key = canonical([card.id, normalizedHouse(card.printedHouse), card.enhancements ?? []]);
          const count = (counts.get(key) ?? 0) + 1;
          counts.set(key, count);
          if (!matches.length || count > matches.reduce((n, row) => n + row.count, 0))
            return fail('allocation-public-contract-discard-outside-physical-configuration');
        }
      }
      const opponentName = Object.keys(players).find((name) => name !== p.playerName),
        opponent = obj(obj(players[opponentName ?? '']).stats).amber;
      if (typeof opponent !== 'number' || !Number.isSafeInteger(opponent) || opponent < 0)
        return fail('allocation-opponent-amber-unreported');
      const discardIds = discard
        .filter((c) => normalizedHouse(c.printedHouse) === 'geistoid')
        .map((c) => str(c.uuid));
      amount = Math.min(opponent, discardIds.length);
      evidence = this.publicVeilRuleContract
        ? {
            kind: 'public-rule-contract-and-visible-discard',
            contractId: this.publicVeilRuleContract.id,
            origin: this.publicVeilRuleContract.origin,
            frontendBundleSha256: this.publicVeilRuleContract.frontendBundleSha256,
            backendRuleVersion: 'unreported',
            discardIds,
            opponentName: opponentName!,
            opponentAmber: opponent,
          }
        : {
            kind: 'visible-discard-and-opponent-amber',
            discardIds,
            opponentAmber: opponent,
            verifiedScopeId: this.verifiedVeilScope!.id,
          };
    } else if (current.source === 'hallowed-eve-festival') {
      const matches = arr(obj(raw).messages)
        .map(obj)
        .filter((entry) => {
          const m = arr(entry.message);
          return (
            str(entry.id) &&
            !priorMessages.has(str(entry.id)) &&
            m.length === 6 &&
            obj(m[0]).name === p.playerName &&
            obj(m[0]).argType === 'nonAvatarPlayer' &&
            obj(m[2]).argType === 'card' &&
            obj(m[2]).id === 'hallowed-eve-festival' &&
            FESTIVAL_MESSAGE_TEMPLATES.some(
              ([use, capture, onto]) => m[1] === use && m[3] === capture && m[5] === onto,
            ) &&
            typeof m[4] === 'number' &&
            Number.isSafeInteger(m[4])
          );
        });
      if (matches.length !== 1)
        return fail('allocation-festival-new-public-amount-message-missing-or-ambiguous');
      amount = arr(matches[0].message)[4] as number;
      // Festival deliberately does NOT clamp its selection count to the opponent's pool.
      evidence = { kind: 'new-public-effect-message', messageId: str(matches[0].id), amount };
    } else if (
      current.source === 'bring-low' ||
      current.source === 'fathomshare' ||
      current.source === 'shard-of-hope'
    ) {
      const players = obj(obj(raw).players),
        names = Object.keys(players),
        opponentName = names.find((name) => name !== p.playerName),
        opponentAmber = obj(obj(players[opponentName ?? '']).stats).amber;
      if (
        names.length !== 2 ||
        !names.includes(p.playerName) ||
        !opponentName ||
        obj(players[p.playerName]).activePlayer !== true ||
        typeof opponentAmber !== 'number' ||
        !Number.isSafeInteger(opponentAmber) ||
        opponentAmber < 0
      )
        return fail('allocation-public-opponent-pool-or-actor-unreported');
      const friendly = new Set(p.observation.players[p.observation.you].battleline.map((card) => card.id));
      if (allowedTargets.some((id) => !friendly.has(id)))
        return fail('allocation-public-target-is-not-a-visible-friendly-creature');
      const fresh = newMessagesAfterWindow(previousWindow, this.messageWindow);
      if (!fresh) return fail('allocation-public-quota-message-window-incomplete');
      const matches = fresh.filter((entry) => {
        const m = arr(entry.message),
          effect = obj(m[4]),
          parts = arr(effect.message);
        return (
          entry.activePlayer === p.playerName &&
          m.length === 5 &&
          obj(m[0]).argType === 'nonAvatarPlayer' &&
          obj(m[0]).name === p.playerName &&
          m[1] === ' uses ' &&
          obj(m[2]).argType === 'card' &&
          obj(m[2]).id === current.source &&
          obj(m[2]).type === (current.source === 'shard-of-hope' ? 'artifact' : 'action') &&
          obj(m[2]).facedown !== true &&
          m[3] === ' to ' &&
          Object.keys(effect).length === 1 &&
          obj(parts[3]).argType === 'nonAvatarPlayer' &&
          obj(parts[3]).name === opponentName &&
          parts[2] === ' amber from ' &&
          (current.source === 'bring-low'
            ? parts.length === 4 && parts[0] === 'have friendly creatures capture '
            : current.source === 'fathomshare'
              ? parts.length === 5 &&
                parts[0] === 'capture ' &&
                parts[4] === ', distributed among friendly creatures'
              : parts.length === 4 && parts[0] === 'capture ')
        );
      });
      if (matches.length !== 1) return fail('allocation-new-public-amount-message-missing-or-ambiguous');
      const message = matches[0],
        published = arr(obj(arr(message.message)[4]).message)[1];
      // Shard of Hope publishes its evaluated capture quota. Bound that
      // explicit quota by the public pool; do not reconstruct it from printed traits.
      if (
        typeof published !== 'number' ||
        !Number.isSafeInteger(published) ||
        published < 1 ||
        published > opponentAmber ||
        (current.source === 'bring-low' && published !== Math.max(opponentAmber - 5, 0)) ||
        (current.source === 'fathomshare' && published !== Math.floor(opponentAmber / 2))
      )
        return fail('allocation-public-amount-does-not-match-opponent-pool');
      amount = published;
      evidence = {
        kind: 'new-public-effect-message-and-opponent-amber',
        messageId: str(message.id),
        messageSha256: quotaMessageHash(message),
        amount,
        opponentName,
        opponentAmber,
        rule:
          current.source === 'bring-low'
            ? 'max-opponent-amber-minus-five'
            : current.source === 'fathomshare'
              ? 'floor-half-opponent-amber'
              : 'published-shard-capture-count',
      };
    } else if (
      this.publicCaptureRuleContract &&
      (current.source === 'xenotraining' ||
        current.source === 'hypnotic-command' ||
        current.source === 'fetchdrones')
    ) {
      try {
        const quota = derivePublicCaptureQuota(
          this.publicCaptureRuleContract,
          beforeRaw,
          raw,
          p,
          current.source,
          source,
          allowedTargets,
        );
        amount = quota.amount;
        pointsPerClick = quota.pointsPerClick;
        evidence = quota.evidence;
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'allocation-public-capture-quota-unverifiable');
      }
    } else {
      return fail(
        current.source === 'xenotraining'
          ? 'allocation-xenotraining-effective-houses-unreported'
          : `allocation-${current.source}-public-quota-unreported`,
      );
    }
    if (
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      (current.source === 'hallowed-eve-festival' && amount > 5)
    )
      return fail('allocation-public-amount-invalid');
    const descriptor: KeytekiAllocationDescriptor = {
      id: '',
      gameId: p.gameId,
      playerName: p.playerName,
      promptUuid: current.key,
      sourceCardId: source,
      sourceDefinition: current.source as KeytekiAllocationDescriptor['sourceDefinition'],
      amount,
      ...(pointsPerClick ? { pointsPerClick } : {}),
      amountEvidence: evidence,
      allowedTargets,
      baseFingerprint: position(p),
      observedFromPromptStart: true,
    };
    descriptor.id = 'allocation-' + hash(descriptor);
    this.result = { status: 'ready', descriptor };
    return structuredClone(this.result);
  }
}

export interface KeytekiPublicVeilSettlement {
  status: 'not-required' | 'pending' | 'verified' | 'unverifiable';
  reason?: string;
  contractId?: string;
  gameId?: string;
  playerName?: string;
  promptUuid?: string;
  planId?: string;
  expectedAmount?: number;
  discardGeistoidCards?: number;
  opponentAmberBefore?: number;
  opponentAmberAfter?: number;
  targetCaptures?: Record<string, { before: number; after: number; expectedDelta: number }>;
  captureAggregation?: {
    status: 'batch-aggregation-observed' | 'indeterminate';
    reason?: string;
    pointsPerClick: 1;
    events: {
      messageId: string;
      messageSha256: string;
      targetId: string;
      definition: string;
      plannedClicks: number;
      captured: number;
    }[];
  };
  settlementKind?: 'unique-dew-faerie-entangler';
  departedTarget?: {
    id: string;
    definition: 'dew-faerie';
    upgradeId: string;
    capturedBefore: number;
    capturedThisBatch: number;
    returnedAmber: number;
    captureMessageId: string;
  };
}

/** Additional public event evidence, separate from the selected compatibility rule.
 * Call only after visible settlement has been verified. Veil allocates one point
 * per click: one fresh capture of several planned points on one uniquely bound
 * recipient demonstrates aggregation. It does not attest to backend code or to
 * every internal reaction order. Wire receipts/sequences are added by the caller.
 */
function veilCaptureAggregation(
  plan: KeytekiAllocationPlan,
  before: Obj,
  after: Obj,
  departedDefinition?: string,
): NonNullable<KeytekiPublicVeilSettlement['captureAggregation']> {
  const unknown = (reason: string): NonNullable<KeytekiPublicVeilSettlement['captureAggregation']> => ({
    status: 'indeterminate',
    reason,
    pointsPerClick: 1,
    events: [],
  });
  const d = plan.descriptor;
  if (d.sourceDefinition !== 'veil-of-ectoplasm') return unknown('not-a-veil-one-point-allocation');
  const expected = new Map<string, number>();
  for (const id of plan.targets) expected.set(id, (expected.get(id) ?? 0) + 1);
  if (![...expected.values()].some((count) => count > 1))
    return unknown('no-recipient-has-more-than-one-planned-point');
  const cards = arr(obj(obj(obj(before.players)[d.playerName]).cardPiles).cardsInPlay).map(obj);
  const byDefinition = new Map<string, string>();
  for (const id of expected.keys()) {
    const matches = cards.filter((c) => c.uuid === id);
    if (matches.length !== 1) return unknown('recipient-physical-identity-unavailable');
    const card = matches[0],
      definition = str(card.id);
    if (
      !definition ||
      card.type !== 'creature' ||
      card.facedown === true ||
      card.copying === true ||
      cards.filter((c) => c.id === definition).length !== 1
    )
      return unknown('recipient-definition-is-not-unique-and-visible');
    byDefinition.set(definition, id);
  }
  const fresh = newMessagesAfterWindow(arr(before.messages).map(obj), arr(after.messages).map(obj));
  if (!fresh) return unknown('public-message-window-is-not-continuous');
  const captures = departedDefinition ? fresh.slice(0, -1) : fresh;
  if (departedDefinition) {
    const death = arr(fresh.at(-1)?.message);
    if (
      death.length !== 2 ||
      obj(death[0]).argType !== 'card' ||
      obj(death[0]).id !== departedDefinition ||
      death[1] !== ' is destroyed'
    )
      return unknown('departure-message-does-not-match-verified-settlement');
  }
  if (captures.length !== expected.size) return unknown('capture-event-count-is-not-exact');
  const seen = new Set<string>();
  const events: NonNullable<KeytekiPublicVeilSettlement['captureAggregation']>['events'] = [];
  for (const row of captures) {
    const m = arr(row.message),
      source = obj(m[2]),
      recipient = obj(m[4]);
    const definition = str(recipient.id),
      targetId = byDefinition.get(definition);
    if (
      row.activePlayer !== d.playerName ||
      m.length !== 8 ||
      obj(m[0]).argType !== 'nonAvatarPlayer' ||
      obj(m[0]).name !== d.playerName ||
      source.argType !== 'card' ||
      source.id !== 'veil-of-ectoplasm' ||
      source.type !== 'action' ||
      source.facedown === true ||
      recipient.argType !== 'card' ||
      recipient.type !== 'creature' ||
      recipient.facedown === true ||
      m[1] !== ' uses ' ||
      m[3] !== ' to have ' ||
      m[5] !== ' capture ' ||
      m[7] !== ' amber' ||
      !targetId ||
      seen.has(targetId) ||
      m[6] !== expected.get(targetId)
    )
      return unknown('capture-event-is-not-a-unique-exact-veil-allocation');
    seen.add(targetId);
    events.push({
      messageId: str(row.id),
      messageSha256: quotaMessageHash(row),
      targetId,
      definition,
      plannedClicks: expected.get(targetId)!,
      captured: m[6] as number,
    });
  }
  return { status: 'batch-aggregation-observed', pointsPerClick: 1, events };
}

/** A deliberately narrow public proof for one known leave-play interaction.
 * The upstream short log cards have definition IDs, not physical UUIDs. Only
 * unique visible recipients can therefore bind those records to plan targets.
 * No generic death/redirect/reaction is inferred from a net pool difference.
 */
function uniqueDewEntanglerSettlement(
  plan: KeytekiAllocationPlan,
  before: Obj,
  after: Obj,
  expected: Map<string, number>,
): Pick<
  KeytekiPublicVeilSettlement,
  'settlementKind' | 'departedTarget' | 'targetCaptures' | 'opponentAmberAfter'
> | null {
  const d = plan.descriptor,
    evidence = d.amountEvidence;
  if (evidence.kind !== 'public-rule-contract-and-visible-discard') return null;
  const names = [d.playerName, evidence.opponentName];
  const player = (view: Obj, name: string) => obj(obj(view.players)[name]);
  const pile = (view: Obj, name: string, zone: string): Obj[] | null => {
    const value = obj(player(view, name).cardPiles)[zone];
    return Array.isArray(value) ? value.map(obj) : null;
  };
  const index = (cards: Obj[] | null): Map<string, Obj> | null => {
    if (!cards) return null;
    const result = new Map<string, Obj>();
    for (const card of cards) {
      const id = str(card.uuid);
      if (
        !id ||
        !str(card.id) ||
        result.has(id) ||
        card.facedown === true ||
        card.copying === true ||
        card.isToken === true
      )
        return null;
      result.set(id, card);
    }
    return result;
  };
  const tokens = (card: Obj): Record<string, number> | null => {
    if (!card.tokens || Array.isArray(card.tokens) || typeof card.tokens !== 'object') return null;
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(obj(card.tokens))) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      if (value) result[key] = value;
    }
    return result;
  };
  const a = index(pile(before, d.playerName, 'cardsInPlay'));
  const b = index(pile(after, d.playerName, 'cardsInPlay'));
  if (!a || !b || [...b.keys()].some((id) => !a.has(id))) return null;
  const departed = [...a.keys()].filter((id) => !b.has(id));
  if (departed.length !== 1) return null;
  const id = departed[0],
    host = a.get(id)!,
    hostTokens = tokens(host),
    amount = expected.get(id);
  const upgrades = arr(host.upgrades).map(obj),
    upgrade = upgrades[0];
  if (
    host.id !== 'dew-faerie' ||
    host.type !== 'creature' ||
    host.controlled !== false ||
    host.powerPrinted !== 2 ||
    host.armorPrinted !== 0 ||
    !hostTokens ||
    !amount ||
    [...a.values()].filter((c) => c.id === 'dew-faerie').length !== 1 ||
    upgrades.length !== 1 ||
    upgrade.id !== 'essence-entangler' ||
    upgrade.type !== 'upgrade' ||
    !str(upgrade.uuid) ||
    upgrade.controlled !== false ||
    upgrade.facedown === true ||
    upgrade.copying === true ||
    upgrade.isToken === true ||
    !tokens(upgrade) ||
    Object.keys(tokens(upgrade)!).length ||
    arr(host.childCards).length ||
    arr(upgrade.childCards).length ||
    arr(upgrade.upgrades).length ||
    (hostTokens.ward ?? 0) !== 0
  )
    return null;
  const stored = hostTokens.amber ?? 0,
    damage = hostTokens.damage ?? 0;
  const power = 2 + (hostTokens.power ?? 0) - stored;
  if (
    host.modifiedPower !== power ||
    power <= 0 ||
    damage >= power ||
    damage < power - amount ||
    [...a.values()].flatMap((c) => arr(c.upgrades).map(obj)).filter((c) => c.id === 'essence-entangler')
      .length !== 1
  )
    return null;
  // Require the original action and both departing physical cards to be visible
  // in discard, with no other moved discard card. No hidden-zone inference.
  for (const name of names) {
    const x = index(pile(before, name, 'discard')),
      y = index(pile(after, name, 'discard'));
    if (!x || !y || [...x.keys()].some((key) => !y.has(key))) return null;
    const additions = [...y.keys()].filter((key) => !x.has(key)).sort();
    const wanted = name === d.playerName ? [id, str(upgrade.uuid), d.sourceCardId].sort() : [];
    if (canonical(additions) !== canonical(wanted)) return null;
    if (name === d.playerName) {
      for (const [key, definition] of [
        [id, 'dew-faerie'],
        [str(upgrade.uuid), 'essence-entangler'],
        [d.sourceCardId, 'veil-of-ectoplasm'],
      ]) {
        const card = y.get(key)!;
        if (
          card.id !== definition ||
          card.location !== 'discard' ||
          card.controlled !== false ||
          !tokens(card) ||
          Object.keys(tokens(card)!).length ||
          arr(card.upgrades).length ||
          arr(card.childCards).length
        )
          return null;
      }
    }
    for (const [key, card] of x) if (card.id !== y.get(key)?.id) return null;
    for (const zone of ['hand', 'archives', 'purged']) {
      const old = pile(before, name, zone),
        next = pile(after, name, zone);
      if (
        !old ||
        !next ||
        old.some((c) => !str(c.uuid)) ||
        next.some((c) => !str(c.uuid)) ||
        canonical(old.map((c) => c.uuid).sort()) !== canonical(next.map((c) => c.uuid).sort())
      )
        return null;
    }
    for (const key of ['numDeckCards', 'numArchivesCards'])
      if (player(before, name)[key] !== player(after, name)[key]) return null;
  }
  const ownAfter = player(after, d.playerName);
  if (
    ownAfter.phase !== 'main' ||
    ownAfter.activePlayer !== true ||
    ownAfter.selectCard === true ||
    arr(ownAfter.controls).length ||
    !arr(ownAfter.buttons)
      .map(obj)
      .some((button) => button.command === 'menuButton' && button.arg === 'done')
  )
    return null;

  // A retained suffix of the old message window must precede every new record.
  // Reused IDs, incomplete windows, extra reactions or different templates fail.
  const oldMessages = arr(before.messages).map(obj),
    messages = arr(after.messages).map(obj);
  const oldIds = oldMessages.map((m) => str(m.id)),
    ids = messages.map((m) => str(m.id));
  if (
    !oldIds.length ||
    oldIds.some((key) => !key) ||
    ids.some((key) => !key) ||
    new Set(oldIds).size !== oldIds.length ||
    new Set(ids).size !== ids.length
  )
    return null;
  const boundary = ids.indexOf(oldIds.at(-1)!);
  if (boundary < 0 || boundary >= oldIds.length) return null;
  const retained = oldMessages.slice(oldIds.length - boundary - 1);
  if (
    retained.some(
      (m, i) => m.id !== messages[i].id || canonical(m.message) !== canonical(messages[i].message),
    )
  )
    return null;
  const fresh = messages.slice(boundary + 1);
  if (
    fresh.length !== expected.size + 1 ||
    fresh.some((m) => oldIds.includes(str(m.id)) || m.activePlayer !== d.playerName)
  )
    return null;
  const byDefinition = new Map<string, string>();
  for (const [target] of expected) {
    const card = a.get(target);
    if (!card || card.type !== 'creature' || [...a.values()].filter((c) => c.id === card.id).length !== 1)
      return null;
    byDefinition.set(str(card.id), target);
  }
  const logged = new Map<string, string>();
  for (const row of fresh.slice(0, -1)) {
    const m = arr(row.message),
      recipient = byDefinition.get(str(obj(m[4]).id));
    if (
      m.length !== 8 ||
      obj(m[0]).argType !== 'nonAvatarPlayer' ||
      obj(m[0]).name !== d.playerName ||
      obj(m[2]).argType !== 'card' ||
      obj(m[2]).id !== 'veil-of-ectoplasm' ||
      obj(m[2]).type !== 'action' ||
      obj(m[4]).argType !== 'card' ||
      obj(m[4]).type !== 'creature' ||
      !recipient ||
      logged.has(recipient) ||
      m[1] !== ' uses ' ||
      m[3] !== ' to have ' ||
      m[5] !== ' capture ' ||
      m[7] !== ' amber' ||
      m[6] !== expected.get(recipient)
    )
      return null;
    logged.set(recipient, str(row.id));
  }
  const death = arr(fresh.at(-1)?.message);
  if (
    logged.size !== expected.size ||
    death.length !== 2 ||
    obj(death[0]).argType !== 'card' ||
    obj(death[0]).id !== 'dew-faerie' ||
    death[1] !== ' is destroyed'
  )
    return null;

  const stableCard = (card: Obj, addedAmber = 0): Obj | null => {
    const t = tokens(card);
    if (!t) return null;
    if (addedAmber) t.amber = (t.amber ?? 0) + addedAmber;
    const attached = arr(card.upgrades).map((value) => stableCard(obj(value)));
    const children = arr(card.childCards).map((value) => stableCard(obj(value)));
    if (attached.some((value) => value === null) || children.some((value) => value === null)) return null;
    return Object.fromEntries([
      ...[
        'id',
        'uuid',
        'type',
        'location',
        'controlled',
        'copying',
        'isToken',
        'facedown',
        'printedHouse',
        'powerPrinted',
        'armorPrinted',
        'modifiedPower',
        'stunned',
        'taunt',
        'exhausted',
        'enhancements',
        'maverick',
        'anomaly',
        'gigantic',
      ].map((key) => [key, card[key]]),
      ['tokens', t],
      ['upgrades', attached],
      ['childCards', children],
    ]);
  };
  const targetCaptures: NonNullable<KeytekiPublicVeilSettlement['targetCaptures']> = {};
  const returnedAmber = stored + amount;
  let opponentAmberAfter: number | undefined;
  for (const name of names) {
    const old = index(pile(before, name, 'cardsInPlay')),
      next = index(pile(after, name, 'cardsInPlay'));
    const oldAmber = obj(player(before, name).stats).amber,
      nextAmber = obj(player(after, name).stats).amber;
    if (
      !old ||
      !next ||
      typeof oldAmber !== 'number' ||
      typeof nextAmber !== 'number' ||
      !Number.isSafeInteger(oldAmber) ||
      !Number.isSafeInteger(nextAmber) ||
      oldAmber < 0 ||
      nextAmber < 0
    )
      return null;
    const expectedIds = [...old.keys()].filter((key) => name !== d.playerName || key !== id).sort();
    if (canonical(expectedIds) !== canonical([...next.keys()].sort())) return null;
    if (name === evidence.opponentName) {
      if (oldAmber !== evidence.opponentAmber || nextAmber !== oldAmber - d.amount + returnedAmber)
        return null;
      opponentAmberAfter = nextAmber;
    } else if (oldAmber !== nextAmber) return null;
    for (const key of expectedIds) {
      const card = old.get(key)!,
        current = next.get(key)!,
        increment = name === d.playerName ? (expected.get(key) ?? 0) : 0;
      const expectedCard = stableCard(card, increment),
        actualCard = stableCard(current);
      if (!expectedCard || !actualCard || canonical(expectedCard) !== canonical(actualCard)) return null;
      if (increment)
        targetCaptures[key] = {
          before: tokens(card)!.amber ?? 0,
          after: tokens(current)!.amber ?? 0,
          expectedDelta: increment,
        };
    }
  }
  return {
    settlementKind: 'unique-dew-faerie-entangler',
    opponentAmberAfter,
    targetCaptures,
    departedTarget: {
      id,
      definition: 'dew-faerie',
      upgradeId: str(upgrade.uuid),
      capturedBefore: stored,
      capturedThisBatch: amount,
      returnedAmber,
      captureMessageId: logged.get(id)!,
    },
  };
}
/** Verifies only the visible settlement of one completed expected-rule batch.
 * Apart from the explicit unique Dew/Entangler proof, deaths remain unknown.
 * A redirect, intervening effect or missing field can make attribution
 * impossible; that is not proof that the server's underlying formula is wrong.
 */
export function observePublicVeilSettlement(
  plan: KeytekiAllocationPlan,
  beforeValue: unknown,
  afterValue: unknown,
): KeytekiPublicVeilSettlement {
  const d = plan.descriptor,
    evidence = d.amountEvidence;
  if (evidence.kind !== 'public-rule-contract-and-visible-discard') return { status: 'not-required' };
  const base = {
    contractId: evidence.contractId,
    gameId: d.gameId,
    playerName: d.playerName,
    promptUuid: d.promptUuid,
    planId: plan.id,
    expectedAmount: d.amount,
    discardGeistoidCards: evidence.discardIds.length,
    opponentAmberBefore: evidence.opponentAmber,
  };
  const unavailable = (reason: string): KeytekiPublicVeilSettlement => ({
    ...base,
    status: 'unverifiable',
    reason,
  });
  const before = obj(beforeValue),
    after = obj(afterValue);
  const names = [d.playerName, evidence.opponentName].sort();
  if (
    d.sourceDefinition !== 'veil-of-ectoplasm' ||
    before.id !== d.gameId ||
    after.id !== d.gameId ||
    canonical(Object.keys(obj(before.players)).sort()) !== canonical(names) ||
    canonical(Object.keys(obj(after.players)).sort()) !== canonical(names) ||
    recognizedPrompt(before, d.playerName)?.key !== d.promptUuid ||
    !Number.isSafeInteger(d.amount) ||
    d.amount < 1 ||
    d.amount !== Math.min(evidence.opponentAmber, evidence.discardIds.length)
  )
    return unavailable('public-veil-settlement-binding-unverifiable');
  if (recognizedPrompt(after, d.playerName)?.key === d.promptUuid) return { ...base, status: 'pending' };
  type Snapshot = { amber: number; creatures: Map<string, { definition: string; amber: number }> };
  const snapshot = (raw: Obj, name: string): Snapshot | null => {
    const player = obj(obj(raw.players)[name]),
      amber = obj(player.stats).amber;
    const cards = obj(player.cardPiles).cardsInPlay;
    if (typeof amber !== 'number' || !Number.isSafeInteger(amber) || amber < 0 || !Array.isArray(cards))
      return null;
    const creatures = new Map<string, { definition: string; amber: number }>();
    for (const value of cards) {
      const card = obj(value);
      if (card.type !== 'creature') continue;
      const id = str(card.uuid),
        definition = str(card.id),
        tokens = obj(card.tokens);
      const captured = tokens.amber === undefined ? 0 : tokens.amber;
      if (
        !id ||
        !definition ||
        creatures.has(id) ||
        card.facedown === true ||
        card.copying === true ||
        !card.tokens ||
        Array.isArray(card.tokens) ||
        typeof card.tokens !== 'object' ||
        typeof captured !== 'number' ||
        !Number.isSafeInteger(captured) ||
        captured < 0
      )
        return null;
      creatures.set(id, { definition, amber: captured });
    }
    return { amber, creatures };
  };
  const expected = new Map<string, number>();
  for (const id of plan.targets) expected.set(id, (expected.get(id) ?? 0) + 1);
  if (plan.targets.length !== d.amount || plan.targets.some((id) => !d.allowedTargets.includes(id)))
    return unavailable('public-veil-settlement-plan-unverifiable');
  const targets: NonNullable<KeytekiPublicVeilSettlement['targetCaptures']> = {};
  let opponentAmberAfter: number | undefined,
    deltasMatch = true;
  for (const name of names) {
    const a = snapshot(before, name),
      b = snapshot(after, name);
    if (!a || !b) return unavailable('public-veil-settlement-fields-unreported');
    if (
      canonical([...a.creatures.keys()].sort()) !== canonical([...b.creatures.keys()].sort()) ||
      [...a.creatures].some(([id, card]) => card.definition !== b.creatures.get(id)?.definition)
    ) {
      const known = uniqueDewEntanglerSettlement(plan, before, after, expected);
      return known
        ? {
            ...base,
            ...known,
            status: 'verified',
            captureAggregation: veilCaptureAggregation(plan, before, after, known.departedTarget?.definition),
          }
        : unavailable('public-veil-settlement-board-changed-attribution-unknown');
    }
    if (name === evidence.opponentName) {
      opponentAmberAfter = b.amber;
      if (a.amber !== evidence.opponentAmber || a.amber - b.amber !== d.amount) deltasMatch = false;
    } else if (a.amber !== b.amber) deltasMatch = false;
    for (const [id, card] of a.creatures) {
      const next = b.creatures.get(id)!;
      const delta = name === d.playerName ? (expected.get(id) ?? 0) : 0;
      if (next.amber - card.amber !== delta) deltasMatch = false;
      if (name === d.playerName && expected.has(id))
        targets[id] = { before: card.amber, after: next.amber, expectedDelta: delta };
    }
  }
  if (Object.keys(targets).length !== expected.size)
    return unavailable('public-veil-settlement-target-left-visible-play');
  return {
    ...base,
    opponentAmberAfter,
    targetCaptures: targets,
    status: deltasMatch ? 'verified' : 'unverifiable',
    ...(deltasMatch ? { captureAggregation: veilCaptureAggregation(plan, before, after) } : {}),
    ...(!deltasMatch ? { reason: 'public-veil-visible-deltas-do-not-establish-expected-settlement' } : {}),
  };
}

/** Earlier points are prepared then discarded, never dispatched or acknowledged.
 * The final point keeps exactly one pending controller decision for the whole plan.
 * Real captured/amber/power values and the full server target set stay unchanged.
 */
export async function prepareKeytekiAllocationPlan(
  controller: StrategyController,
  frame: StrategyFrame,
  projection: KeytekiProjection,
  descriptor: KeytekiAllocationDescriptor,
  isCurrent: () => boolean = () => true,
  onPrepared: (decision: StrategyDecision) => void = () => {},
): Promise<KeytekiAllocationPlan> {
  if (
    position(projection) !== descriptor.baseFingerprint ||
    frame.matchId !== descriptor.gameId ||
    canonical(frame.observation) !== canonical(projection.observation) ||
    descriptor.id !== 'allocation-' + hash({ ...descriptor, id: '' }) ||
    !Number.isSafeInteger(descriptor.amount) ||
    descriptor.amount < 1 ||
    (descriptor.pointsPerClick ?? 1) !== (descriptor.sourceDefinition === 'fetchdrones' ? 2 : 1)
  )
    throw Error('Stale allocation plan input');
  const targets: string[] = [],
    decisions: StrategyDecision[] = [],
    commands: KeytekiCommand[] = [];
  const draftAllocations: Record<string, number> = Object.create(null) as Record<string, number>;
  let finalFrame: StrategyFrame | undefined, kept: StrategyDecision | undefined;
  try {
    for (let i = 0; i < descriptor.amount; i++) {
      if (!isCurrent()) throw Error('Superseded allocation draft');
      const planningFrame: StrategyFrame = {
        ...structuredClone(frame),
        qualifications: [
          ...(frame.qualifications ?? []),
          (descriptor.pointsPerClick === 2
            ? 'Allocation draft only: select one click assigning two points of a complete batch. No draft point has been sent or captured. '
            : 'Allocation draft only: select one point of a complete batch. No draft point has been sent or captured. ') +
            'All currently offered targets remain available, including previously chosen targets. ' +
            JSON.stringify({
              kind: 'unsettled-capture-allocation',
              total: descriptor.amount,
              point: i + 1,
              ...(descriptor.pointsPerClick === 2 ? { pointsPerClick: 2 } : {}),
              plannedTargets: targets,
              draftAllocations,
            }),
        ],
      };
      const d = await controller.prepare(planningFrame);
      kept = d;
      onPrepared(d);
      if (!isCurrent()) throw Error('Superseded allocation draft');
      const a = projection.observation.legalActions.find((x) => x.id === d.actionId)?.action;
      if (a?.kind !== 'select' || !descriptor.allowedTargets.includes(a.target))
        throw Error('Allocation policy chose a non-target');
      const command = compileKeytekiCommand(projection, d.actionId, {
        revision: projection.observation.revision,
        fingerprint: projection.fingerprint,
      });
      if (command.message !== 'cardClicked' || command.args.length !== 1 || command.args[0] !== a.target)
        throw Error('Allocation command binding changed');
      targets.push(a.target);
      draftAllocations[a.target] = (draftAllocations[a.target] ?? 0) + (descriptor.pointsPerClick ?? 1);
      decisions.push(d);
      commands.push(command);
      finalFrame = planningFrame;
      if (i + 1 < descriptor.amount) {
        controller.discard(d.id);
        kept = undefined;
      }
    }
    if (!kept || !finalFrame) throw Error('Empty allocation plan');
    const plan: KeytekiAllocationPlan = {
      kind: 'keyteki-allocation-plan-v1',
      id: '',
      descriptor: structuredClone(descriptor),
      decisions,
      finalDecision: kept,
      finalFrame,
      commands,
      targets,
      draftAllocations,
    };
    plan.id =
      'allocation-plan-' +
      hash({ descriptor: descriptor.id, decisions: decisions.map((d) => d.id), targets });
    return plan;
  } catch (error) {
    if (kept) controller.discard(kept.id);
    throw error;
  }
}
export function validateKeytekiAllocationPlan(plan: KeytekiAllocationPlan, p: KeytekiProjection): void {
  if (
    plan.kind !== 'keyteki-allocation-plan-v1' ||
    position(p) !== plan.descriptor.baseFingerprint ||
    plan.descriptor.id !== 'allocation-' + hash({ ...plan.descriptor, id: '' }) ||
    plan.id !==
      'allocation-plan-' +
        hash({
          descriptor: plan.descriptor.id,
          decisions: plan.decisions.map((d) => d.id),
          targets: plan.targets,
        }) ||
    p.gameId !== plan.descriptor.gameId ||
    p.playerName !== plan.descriptor.playerName ||
    plan.commands.length !== plan.descriptor.amount ||
    (plan.descriptor.pointsPerClick ?? 1) !== (plan.descriptor.sourceDefinition === 'fetchdrones' ? 2 : 1) ||
    plan.targets.length !== plan.commands.length ||
    plan.decisions.length !== plan.commands.length ||
    plan.finalDecision.id !== plan.decisions.at(-1)?.id
  )
    throw Error('Stale or incomplete allocation plan');
  for (let i = 0; i < plan.commands.length; i++) {
    const d = plan.decisions[i],
      cmd = compileKeytekiCommand(p, d.actionId, {
        revision: p.observation.revision,
        fingerprint: p.fingerprint,
      });
    if (
      !plan.descriptor.allowedTargets.includes(plan.targets[i]) ||
      cmd.message !== 'cardClicked' ||
      cmd.args[0] !== plan.targets[i] ||
      canonical(cmd) !== canonical(plan.commands[i])
    )
      throw Error('Allocation plan command changed');
  }
}
