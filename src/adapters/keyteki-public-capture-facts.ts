/** No personal deck IDs or historical deployment attestations are shipped.
 * Explicit local registrations retain the exact composition/source/runtime guards.
 */
export type CaptureProfile = 'aoa-wc-no-house-transforms' | 'dm-mm-visible-poltergeistoids';
export interface PublicRuleReference {
  commit: string;
  sourceManifestSha256: string;
  serverDeploymentAttestation: false;
}
export interface PublicCaptureDeckFact {
  expansion: number;
  publicCompositionSha256: string;
  physicalConfigurationSha256: string;
}
const PIN = '361c085bcd401c20976ee9bcc4e4e5b8c061d56c';
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
export let PUBLIC_CAPTURE_DECK_FACTS: Readonly<Record<string, PublicCaptureDeckFact>> = Object.freeze({});
export let PUBLIC_CAPTURE_PAIRS: Readonly<Partial<Record<CaptureProfile, readonly string[]>>> = Object.freeze({});
let captureReference: PublicRuleReference | undefined;
export function getPublicCaptureReference(): PublicRuleReference {
  if (!captureReference) throw Error('Public capture requires an explicitly registered audited local contract');
  return captureReference;
}
/** Call once before sessions, using a locally audited source and exact public deck facts.
 * Registering data is not evidence that a public server runs those rules.
 */
export function configurePublicCaptureFacts(input: {
  referenceRules: PublicRuleReference;
  decks: Record<string, PublicCaptureDeckFact>;
  pairs: Partial<Record<CaptureProfile, readonly string[]>>;
}): void {
  if (captureReference) throw Error('Public capture facts already configured');
  const c = structuredClone(input);
  if (!c || c.referenceRules?.commit !== PIN || !digest(c.referenceRules.sourceManifestSha256) || c.referenceRules.serverDeploymentAttestation !== false || !c.decks || !c.pairs || !Object.keys(c.pairs).length || Object.keys(c.decks).length > 32) throw Error('Invalid local public capture contract');
  for (const [id, facts] of Object.entries(c.decks)) {
    if (!identity(id) || !facts || !Number.isSafeInteger(facts.expansion) || !digest(facts.publicCompositionSha256) || !digest(facts.physicalConfigurationSha256)) throw Error('Invalid audited public deck facts');
  }
  for (const [profile, ids] of Object.entries(c.pairs)) {
    const expected = profile === 'aoa-wc-no-house-transforms' ? [435, 452] : profile === 'dm-mm-visible-poltergeistoids' ? [479, 928] : undefined;
    if (!expected || !Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !identity(id) || !Object.hasOwn(c.decks, id)) || JSON.stringify(ids.map(id => c.decks[id].expansion).sort((a,b) => a-b)) !== JSON.stringify(expected)) throw Error('Unaudited capture profile or deck pair');
    c.pairs[profile as CaptureProfile] = [...ids].sort();
  }
  captureReference = freeze(c.referenceRules);
  PUBLIC_CAPTURE_DECK_FACTS = freeze(c.decks);
  PUBLIC_CAPTURE_PAIRS = freeze(c.pairs);
}
export interface VerifiedVeilConfiguration {
  sourceManifestSha256: string;
  runtimeLockSha256: string;
  requiredDeckId: string;
  decks: Record<string, string>;
}
let veilConfiguration: VerifiedVeilConfiguration | undefined;
export function getVerifiedVeilConfiguration(): VerifiedVeilConfiguration {
  if (!veilConfiguration) throw Error('Veil allocation requires an explicitly registered audited local contract');
  return veilConfiguration;
}
export function configureVerifiedVeilFacts(input: VerifiedVeilConfiguration): void {
  if (veilConfiguration) throw Error('Veil facts already configured');
  const c = structuredClone(input);
  if (!c || !digest(c.sourceManifestSha256) || !digest(c.runtimeLockSha256) || !identity(c.requiredDeckId) || !c.decks || Object.keys(c.decks).length < 2 || Object.keys(c.decks).length > 32 || !Object.hasOwn(c.decks, c.requiredDeckId) || Object.entries(c.decks).some(([id, hash]) => !identity(id) || !digest(hash))) throw Error('Invalid audited local Veil facts');
  veilConfiguration = freeze(c);
}
