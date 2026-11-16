/** Public AI knowledge only. Legal moves and outcomes always come from the remote referee. */
import type { CardDefinition } from '../contracts/observation.js';
import { BUILTIN_CARD_DATA } from './builtin-data.js';
import { CARD_KNOWLEDGE_FIELDS, EFFECT_KNOWLEDGE_FIELDS } from './schema.js';
export { KNOWLEDGE_COVERAGE } from './coverage.js';
/** Presence is conservative; it never certifies all printed rules as modeled. */
export function cardKnowledgeIsPartial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(cardKnowledgeIsPartial);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.unmodeled === true || record.kind === 'unmodeled' || Object.values(record).some(cardKnowledgeIsPartial);
}
const cardFields = new Set(CARD_KNOWLEDGE_FIELDS);
const effectArrayFields = new Set(["after","afterFight","afterSuccessful","effects","grantedEffects","otherwise","then"]);
const forbidden = new Set(['__proto__', 'constructor', 'prototype', 'entry', 'hidden', 'physicalIndex', 'houseChangeOrder', 'queue', 'gameState', 'frame']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function inspect(value: unknown, depth = 0, effect = false): void {
  if (depth > 32) throw Error('Knowledge nesting limit');
  if (Array.isArray(value)) { for (const item of value) inspect(item, depth + 1, effect); return; }
  if (!object(value)) {
    if (effect) throw Error('Invalid knowledge effect object');
    if (value !== null && !['string', 'boolean', 'number'].includes(typeof value)) throw Error('Knowledge must be JSON data');
    if (typeof value === 'number' && !Number.isFinite(value)) throw Error('Nonfinite knowledge');
    return;
  }
  if (value.unmodeled !== undefined && value.unmodeled !== true) throw Error('Invalid unmodeled marker');
  if (Object.keys(value).some(key => forbidden.has(key))) throw Error('Private or executable knowledge field');
  if (effect) {
    if (typeof value.kind !== 'string' || !Object.hasOwn(EFFECT_KNOWLEDGE_FIELDS, value.kind)) throw Error('Unsupported knowledge effect kind');
    const fields = EFFECT_KNOWLEDGE_FIELDS[value.kind];
    if (Object.keys(value).some(key => !fields.includes(key))) throw Error('Unsupported knowledge effect field');
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'abilities') {
      if (!object(item)) throw Error('Invalid ability estimate map');
      for (const values of Object.values(item)) {
        if (!Array.isArray(values)) throw Error('Invalid ability estimate list');
        inspect(values, depth + 1, true);
      }
    } else {
      if (key === 'after' && object(item) && Object.keys(item).some(field => !['when', 'atLeast', 'bindAffected', 'effects', 'unmodeled'].includes(field))) throw Error('Unsupported after-estimate field');
      inspect(item, depth + 1, effectArrayFields.has(key) && Array.isArray(item));
    }
  }
}
export function validateCardKnowledge(value: unknown): asserts value is CardDefinition {
  if (!object(value) || Object.keys(value).some(key => !cardFields.has(key))) throw Error('Unknown card knowledge field');
  if (typeof value.id !== 'string' || (!value.id.length || value.id.length > 128 || /[\u0000-\u001f\u007f/\\]/.test(value.id) || forbidden.has(value.id)) || typeof value.name !== 'string' || value.name.length > 160 || typeof value.number !== 'string' || typeof value.house !== 'string' || !['creature', 'action', 'artifact', 'upgrade'].includes(String(value.kind))) throw Error('Invalid card identity');
  if (!['power', 'armor', 'amber'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && Number(value[key]) >= 0)) throw Error('Invalid printed numeric facts');
  if (value.unmodeled !== undefined && value.unmodeled !== true) throw Error('Invalid unmodeled marker');
  if (typeof value.summary !== 'string' || value.summary.length > 512) throw Error('Invalid authored summary');
  if (value.summaryFeatures !== undefined && (!Number.isSafeInteger(value.summaryFeatures) || Number(value.summaryFeatures) < 0 || Number(value.summaryFeatures) >= 4096)) throw Error('Invalid heuristic text features');
  inspect(value);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Install owned/authorized public knowledge before starting a session. Built-in entries cannot be silently replaced. */
const catalog: Record<string, CardDefinition> = Object.create(null);
export function registerCardKnowledge(entries: readonly unknown[]): void {
  if (!Array.isArray(entries) || entries.length > 10000) throw Error('Invalid knowledge pack');
  const prepared = entries.map(entry => { validateCardKnowledge(entry); return freeze(structuredClone(entry)); });
  const ids = new Set<string>();
  for (const entry of prepared) {
    if (ids.has(entry.id) || Object.hasOwn(catalog, entry.id)) throw Error('Duplicate card knowledge');
    ids.add(entry.id);
  }
  for (const entry of prepared) catalog[entry.id] = entry;
}
if (!Array.isArray(BUILTIN_CARD_DATA)) throw Error('Invalid built-in knowledge pack');
registerCardKnowledge(BUILTIN_CARD_DATA);
export const ALL_DEFINITIONS: Readonly<Record<string, CardDefinition>> = new Proxy(catalog, {
  set() { throw Error('Read-only public knowledge catalog'); },
  defineProperty() { throw Error('Read-only public knowledge catalog'); },
  deleteProperty() { throw Error('Read-only public knowledge catalog'); },
  setPrototypeOf() { throw Error('Read-only public knowledge catalog'); },
  preventExtensions() { throw Error('Read-only public knowledge catalog'); },
});
/** Compatibility name for consumers of the strategy interface, not a rule catalog. */
export const CATALOG = ALL_DEFINITIONS;
