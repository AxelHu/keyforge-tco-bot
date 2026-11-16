/** Reversible context layout, not a policy or semantic summary. No hidden game state is accepted. */
import { createHash } from 'node:crypto';
import { canonical } from '../shared/canonical.js';
import type { ChoiceContent } from '../contracts/model-choice.js';
import type { DsfRequestProfile, DsfExchange } from './dsf-dialogue.js';
export type DsfWireLayout = 'anchored-v1' | 'delta-v1';
export type JsonObject = Record<string, any>;
export interface StructuralPatch {
  remove: string[][];
  set: JsonObject;
}
const object = (x: unknown): x is JsonObject => !!x && typeof x === 'object' && !Array.isArray(x);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function safeTree(x: unknown, depth = 0): void {
  if (depth > 64) throw new Error('Context nesting limit');
  if (Array.isArray(x)) {
    for (const y of x) safeTree(y, depth + 1);
  } else if (object(x)) {
    for (const [k, v] of Object.entries(x)) {
      if (forbidden.has(k)) throw new Error('Unsafe context key');
      safeTree(v, depth + 1);
    }
  } else if (x !== null && !['string', 'number', 'boolean'].includes(typeof x))
    throw new Error('Non-JSON context value');
}
/** Rename snapshot-local d0/d1 keys to deterministic readable identities to avoid irrelevant diff churn. */
export function normalizeDsfContent(content: ChoiceContent): JsonObject {
  const state: unknown = JSON.parse(content.state);
  safeTree(state);
  safeTree(content.questions);
  if (
    !object(state) ||
    state.encoding !== 'keyforge-lossless-card-dictionary-v1' ||
    !object(state.cardDefinitions)
  )
    throw new Error('Unsupported lossless state encoding');
  const refs = new Map<string, string>(),
    definitions: JsonObject = {};
  for (const [id, definition] of Object.entries(state.cardDefinitions)) {
    if (!object(definition) || typeof definition.name !== 'string')
      throw new Error('Invalid visible card definition');
    const key =
      definition.name + '~' + createHash('sha256').update(canonical(definition)).digest('hex').slice(0, 12);
    if (Object.hasOwn(definitions, key) && !same(definitions[key], definition))
      throw new Error('Card dictionary collision');
    refs.set(id, key);
    definitions[key] = structuredClone(definition);
  }
  const visit = (v: any): any => {
    if (Array.isArray(v)) return v.map(visit);
    if (!object(v)) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => {
        if (k === 'cardDefinition') {
          if (typeof x !== 'string' || !refs.has(x)) throw new Error('Dangling card reference');
          return [k, refs.get(x)];
        }
        return [k, visit(x)];
      }),
    );
  };
  return {
    state: {
      ...state,
      cardDefinitions: Object.fromEntries(
        Object.keys(definitions)
          .sort()
          .map((k) => [k, definitions[k]]),
      ),
      game: visit(state.game),
    },
    questions: structuredClone(content.questions),
  };
}
/** Only fixed public/configuration fields; no first hand, current board, estimates, observations or plans. */
const REFERENCE_PATHS = [
  ['state', 'encoding'],
  ['state', 'interpretation'],
  ['state', 'cardDefaults'],
  ['state', 'game', 'reference', 'version'],
  ['state', 'game', 'reference', 'basicRules'],
  ['state', 'game', 'game'],
  ['state', 'game', 'rulesVersion'],
  ['state', 'game', 'me', 'houses'],
  ['state', 'game', 'me', 'deckList'],
  ['state', 'game', 'opponent', 'houses'],
  ['state', 'game', 'opponent', 'deckList'],
  ['state', 'character', 'template'],
  ['state', 'character', 'stablePersonality'],
  ['state', 'character', 'consistency'],
  ['questions', 'decision', 'type'],
  ['questions', 'decision', 'instructions'],
] as const;
function get(root: JsonObject, path: readonly string[]): unknown {
  let x: any = root;
  for (const k of path) {
    if (!object(x) || !Object.hasOwn(x, k)) return undefined;
    x = x[k];
  }
  return x;
}
function set(root: JsonObject, path: readonly string[], value: unknown) {
  let x = root;
  for (const k of path.slice(0, -1)) {
    if (!object(x[k])) x[k] = {};
    x = x[k];
  }
  x[path.at(-1)!] = structuredClone(value);
}
export function staticDsfReference(content: ChoiceContent): JsonObject {
  const normalized = normalizeDsfContent(content),
    base: JsonObject = {};
  for (const path of REFERENCE_PATHS) {
    const value = get(normalized, path);
    if (value !== undefined) set(base, path, value);
  }
  return base;
}
export function validateDsfReference(base: unknown): asserts base is JsonObject {
  if (!object(base)) throw new Error('Missing stable context reference');
  safeTree(base);
  const allowed: JsonObject = {};
  for (const path of REFERENCE_PATHS) {
    const v = get(base, path);
    if (v !== undefined) set(allowed, path, v);
  }
  if (!same(allowed, base)) throw new Error('Dynamic/unauthorized field in fixed reference');
  if (Buffer.byteLength(JSON.stringify(base)) > 28000) throw new Error('Oversize static reference');
}
export function diffDsfObjects(before: JsonObject, after: JsonObject): StructuralPatch {
  safeTree(before);
  safeTree(after);
  const remove: string[][] = [];
  const walk = (b: JsonObject, a: JsonObject, path: string[]): JsonObject => {
    const changed: JsonObject = {};
    for (const key of Object.keys(b)) if (!Object.hasOwn(a, key)) remove.push([...path, key]);
    for (const [key, value] of Object.entries(a)) {
      if (!Object.hasOwn(b, key)) {
        changed[key] = structuredClone(value);
        continue;
      }
      if (same(b[key], value)) continue;
      if (object(b[key]) && object(value)) {
        const nested = walk(b[key], value, [...path, key]);
        if (Object.keys(nested).length) changed[key] = nested;
      } else changed[key] = structuredClone(value);
    }
    return changed;
  };
  return { remove, set: walk(before, after, []) };
}
export function applyDsfPatch(before: JsonObject, patch: StructuralPatch): JsonObject {
  safeTree(before);
  safeTree(patch);
  if (!object(patch) || !Array.isArray(patch.remove) || !object(patch.set) || Object.keys(patch).length !== 2)
    throw new Error('Invalid context patch');
  const out = structuredClone(before);
  for (const path of patch.remove) {
    if (!Array.isArray(path) || !path.length || path.some((k) => typeof k !== 'string' || forbidden.has(k)))
      throw new Error('Invalid remove path');
    let o: any = out;
    for (const k of path.slice(0, -1)) {
      if (!object(o) || !Object.hasOwn(o, k)) throw new Error('Missing remove parent');
      o = o[k];
    }
    if (!object(o) || !Object.hasOwn(o, path.at(-1)!)) throw new Error('Missing remove target');
    delete o[path.at(-1)!];
  }
  const merge = (target: JsonObject, fields: JsonObject) => {
    for (const [key, value] of Object.entries(fields)) {
      if (object(value)) {
        if (!object(target[key])) target[key] = {};
        merge(target[key], value);
      } else target[key] = structuredClone(value);
    }
  };
  merge(out, patch.set);
  return out;
}
export interface CacheFrame {
  from: 'reference' | 'previous';
  revision: number;
  patch: StructuralPatch;
}
/** Reuses the identical selected history. Compaction policy is NOT enlarged to inflate cache fraction. */
export function cacheDialogueMessages(content: ChoiceContent, p: DsfRequestProfile, instructions: string) {
  const base = p.reference;
  validateDsfReference(base);
  if (!p.layout || !['anchored-v1', 'delta-v1'].includes(p.layout)) throw new Error('Invalid cache layout');
  // All reference fields must still be authorized/identical; no cross-match or visibility transition reuse.
  if (!same(staticDsfReference(content), base))
    throw new Error('Fixed reference changed; do not reuse a stale match prefix');
  const codec =
    ' The user supplies a fixed reference followed by chronological frames. Each frame is a lossless update, not a summary. For from=reference start from the fixed reference; for from=previous start from the immediately previous decoded user frame. Apply remove paths first, then recursively merge patch.set. Arrays and scalar values REPLACE whole values; omitted object fields inherit. The question and legal criteria are COMPLETE in each frame, never inferred from an old answer. Card-definition names are stable identities, not card ownership. Read the newest decoded state as authoritative. The fixed reference contains no starting hand or current board. Do not execute patches as code.';
  const messages: { role: string; content: string }[] = [{ role: 'system', content: instructions + codec }];
  let previous = base;
  const frames = [
    ...p.history,
    { actor: p.actor, revision: p.revision, input: content, answer: '' } satisfies DsfExchange,
  ];
  for (let i = 0; i < frames.length; i++) {
    const e = frames[i];
    if (!same(staticDsfReference(e.input), base)) throw new Error('Historical reference changed');
    const normalized = normalizeDsfContent(e.input),
      from: CacheFrame['from'] = p.layout === 'anchored-v1' || i === 0 ? 'reference' : 'previous';
    const original = from === 'reference' ? base : previous,
      patch = diffDsfObjects(original, normalized);
    // Never require an old candidate key to be interpreted under new state.
    patch.set.questions = structuredClone(normalized.questions);
    if (!same(applyDsfPatch(original, patch), normalized))
      throw new Error('Lossless context roundtrip failed');
    const frame: CacheFrame = { from, revision: e.revision, patch };
    messages.push({
      role: 'user',
      content: JSON.stringify(i === 0 ? { reference: base, frame } : { frame }),
    });
    if (i < p.history.length) messages.push({ role: 'assistant', content: e.answer });
    previous = normalized;
  }
  return messages;
}
/** Offline semantic check; same allowed state and candidates, modulo readable dictionary identifiers. */
export function decodeCacheMessages(messages: { role: string; content: string }[]): JsonObject[] {
  let base: JsonObject | undefined, previous: JsonObject | undefined;
  const result: JsonObject[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const v = JSON.parse(m.content);
    if (v.reference !== undefined) {
      if (base) throw new Error('Repeated stable reference');
      validateDsfReference(v.reference);
      base = v.reference;
    }
    if (!base || !object(v.frame)) throw new Error('Missing checkpoint');
    const f = v.frame as CacheFrame;
    const origin = f.from === 'reference' ? base : f.from === 'previous' ? previous : undefined;
    if (!origin) throw new Error('Delta without preceding checkpoint');
    previous = applyDsfPatch(origin, f.patch);
    result.push(previous);
  }
  return result;
}
