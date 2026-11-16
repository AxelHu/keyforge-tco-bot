import type { Observation } from '../contracts/observation.js';
import { buildJevInput } from './jev-input.js';
import { DEFAULT_CONTEXT_PROFILE, type ContextProfile } from './jev-context.js';
/** Lossless structured deduplication, identical for both providers. No action scoring or search. */
const CARD_DEFAULTS = {
  damage: 0,
  armorAvailable: 0,
  elusiveUsed: false,
  assault: 0,
  hazardous: 0,
  ready: false,
  stunned: false,
  amber: 0,
  usesThisTurn: 0,
  attachedTo: null,
};
const STATIC_FIELDS = ['name', 'kind', 'rules', 'traits', 'bonusAmber'] as const;
export function packMirrorState(state: Record<string, unknown>) {
  const definitions: Record<string, Record<string, unknown>> = {},
    keys = new Map<string, string>();
  function visit(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(visit);
    if (!x || typeof x !== 'object') return x;
    const c = x as Record<string, unknown>;
    if (typeof c.instance === 'string' && typeof c.rules === 'string' && typeof c.name === 'string') {
      const spec = Object.fromEntries(STATIC_FIELDS.map((k) => [k, c[k]])),
        key = JSON.stringify(spec);
      let ref = keys.get(key);
      if (ref === undefined) {
        ref = `d${keys.size}`;
        keys.set(key, ref);
        definitions[ref] = spec;
      }
      const result: Record<string, unknown> = { instance: c.instance, cardDefinition: ref };
      for (const [k, v] of Object.entries(c)) {
        if (k === 'instance' || STATIC_FIELDS.includes(k as (typeof STATIC_FIELDS)[number])) continue;
        if (Object.hasOwn(CARD_DEFAULTS, k) && v === CARD_DEFAULTS[k as keyof typeof CARD_DEFAULTS]) continue;
        result[k] = v;
      }
      return result;
    }
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, visit(v)]));
  }
  const game = visit(JSON.parse(JSON.stringify(state)));
  return {
    encoding: 'keyforge-lossless-card-dictionary-v1',
    interpretation:
      'Each visible card references cardDefinitions. Merge its definition, cardDefaults, then instance fields. Omitted card-default fields have the listed value. All card rules and game fields are retained; no hidden state is supplied.',
    cardDefaults: CARD_DEFAULTS,
    cardDefinitions: definitions,
    game,
  };
}
export function unpackMirrorState(p: ReturnType<typeof packMirrorState>): unknown {
  function visit(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(visit);
    if (!x || typeof x !== 'object') return x;
    const c = x as Record<string, unknown>;
    if (typeof c.cardDefinition === 'string') {
      const { cardDefinition, ...values } = c;
      return { ...p.cardDefaults, ...p.cardDefinitions[cardDefinition as string], ...values };
    }
    return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, visit(v)]));
  }
  return visit(p.game);
}
export function buildMirrorInput(o: Observation, profile: ContextProfile = DEFAULT_CONTEXT_PROFILE) {
  const input = buildJevInput(o, profile);
  return { state: JSON.stringify(packMirrorState(input.state)), questions: input.questions };
}
