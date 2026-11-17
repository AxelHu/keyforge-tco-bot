/** Public-observation formula evaluation. This module never consumes a referee
 * GameState, private frame or a hidden opponent hand/archive face. */
import type {
  Action,
  CardView,
  Condition,
  Filter,
  House,
  Observation,
  Seat,
  Value,
} from '../contracts/observation.js';
import {
  makeFormulaView,
  publicFormulaSide,
  selectFormulaCards,
} from './public-formula-context.js';

export type PublicValueResult =
  | { kind: 'exact'; value: number; reasons: readonly string[] }
  | {
      kind: 'expected';
      expected: number;
      lower: number;
      upper: number;
      outcomes?: readonly { value: number; probability: number }[];
      assumptions: readonly string[];
      reasons: readonly string[];
    }
  | {
      kind: 'interval';
      lower: number;
      upper: number;
      reasons: readonly string[];
    }
  | {
      kind: 'unknown';
      lower?: number;
      upper?: number;
      reasons: readonly string[];
    };
export type PublicConditionResult =
  | { kind: 'exact'; value: boolean; reasons: readonly string[] }
  | {
      kind: 'unknown';
      possibleTrue: boolean;
      possibleFalse: boolean;
      probability?: number;
      reasons: readonly string[];
    };
export interface PublicCardSelection {
  /** Definitely matched, currently public cards; never anonymous hidden faces. */
  cards: readonly CardView[];
  /** Public candidates whose membership cannot be established from this context. */
  possibleCards: readonly CardView[];
  /** Count may be exact even when the identities are hidden, e.g. opposing hand size. */
  count: PublicValueResult;
  identitiesComplete: boolean;
  reasons: readonly string[];
}
export interface PublicFormulaContext {
  observation: Observation;
  actor?: Seat;
  /** Actual physical source. A copied ability donor is not the physical source. */
  source?: CardView;
  action?: Action;
  /** Applies only a declared entry/use projection, never an entire rules simulation. */
  phase?: 'current' | 'after-play' | 'after-use';
  /** Public uncertainty retained when the entry projection is prepared once. */
  projection?: {
    uncertainCardFields: ReadonlyMap<string, ReadonlySet<string>>;
    uncertainMetrics?: ReadonlySet<'amber' | 'handSize' | 'archives'>;
  };
  target?: CardView;
  combatOpponent?: CardView;
  eventCard?: CardView;
  eventOwner?: Seat;
  eventController?: Seat;
  lastOwner?: Seat;
  /** Only current-step bindings proved from public selections/receipts. Absence is not an empty binding. */
  bindings?: ReadonlyMap<string, readonly CardView[]>;
  scalarBindings?: ReadonlyMap<string, number | PublicValueResult>;
  lastKnownPower?: ReadonlyMap<string, number>;
  chosenHouse?: House;
  chosenNumber?: number;
  chosenTrait?: string;
  lastAmount?: number | PublicValueResult;
  eventAmount?: number | PublicValueResult;
  /** Existing public projection (pools, hand sizes, tokens, receipts) takes priority
   * for non-arithmetic leaves. Return undefined to use the shared evaluator. */
  resolveLeaf?: (
    value: Exclude<Value, number>,
    context: PublicFormulaContext,
  ) => PublicValueResult | undefined;
  /** Return a full selection contract only when this projected filter is understood;
   * otherwise return undefined. Do not return [] to represent an unknown filter. */
  selectCards?: (filter: Filter, context: PublicFormulaContext) => PublicCardSelection | undefined;
}

export const exactPublicValue = (
  value: number,
  reasons: readonly string[] = [],
): PublicValueResult =>
  Number.isFinite(value)
    ? { kind: 'exact', value, reasons }
    : { kind: 'unknown', reasons: ['non-finite-value', ...reasons] };
export const unknownPublicValue = (...reasons: string[]): PublicValueResult => ({
  kind: 'unknown',
  reasons,
});
export function intervalPublicValue(
  lower: number,
  upper: number,
  reasons: readonly string[] = [],
): PublicValueResult {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower > upper)
    return unknownPublicValue('invalid-public-interval', ...reasons);
  return lower === upper
    ? exactPublicValue(lower, reasons)
    : { kind: 'interval', lower, upper, reasons };
}
/** Explicit finite probability model, usually a uniform choice among visible cards.
 * Value contains no random operator: this helper never guesses a hidden distribution. */
export function expectedPublicValue(
  outcomes: readonly { value: number; probability: number }[],
  assumptions: readonly string[] = [],
  reasons: readonly string[] = [],
): PublicValueResult {
  if (
    !outcomes.length ||
    outcomes.length > 256 ||
    outcomes.some(
      (x) => !Number.isFinite(x.value) || !Number.isFinite(x.probability) || x.probability < 0,
    ) ||
    Math.abs(outcomes.reduce((sum, x) => sum + x.probability, 0) - 1) > 1e-9
  )
    return unknownPublicValue('invalid-public-outcomes', ...reasons);
  const positive = outcomes.filter((x) => x.probability > 0);
  const lower = Math.min(...positive.map((x) => x.value)),
    upper = Math.max(...positive.map((x) => x.value));
  if (lower === upper) return exactPublicValue(lower, reasons);
  return {
    kind: 'expected',
    expected: positive.reduce((sum, x) => sum + x.value * x.probability, 0),
    lower,
    upper,
    outcomes: positive.map((x) => ({ ...x })),
    assumptions: [...assumptions],
    reasons: [...reasons],
  };
}

/** Implementation below is intentionally independent of card-definition caches. */
export function evaluatePublicValue(
  value: Value,
  context?: PublicFormulaContext,
): PublicValueResult {
  return createEvaluator(context).value(value);
}
export function evaluatePublicCondition(
  condition: Condition,
  context?: PublicFormulaContext,
): PublicConditionResult {
  return createEvaluator(context).condition(condition);
}
export function selectPublicCards(
  filter: Filter,
  context: PublicFormulaContext,
): PublicCardSelection {
  return createEvaluator(context).select(filter);
}

const rangeOf = (result: PublicValueResult): [number, number] | undefined =>
  result.kind === 'exact'
    ? [result.value, result.value]
    : result.kind === 'interval' || result.kind === 'expected'
      ? [result.lower, result.upper]
      : result.lower !== undefined && result.upper !== undefined
        ? [result.lower, result.upper]
        : undefined;
const reasonsOf = (...results: PublicValueResult[]) => [
  ...new Set(results.flatMap((result) => result.reasons)),
];
const housesOf = (card: CardView): readonly House[] =>
  card.effective.houses ?? [card.effective.house];
const traitsOf = (card: CardView): readonly string[] => card.spec.traits ?? [];
const iconList = (card: CardView) =>
  card.resolvedBonusIcons ?? card.bonusIcons ?? Array(card.spec.amber).fill('amber');

/** Apply a deterministic operation to every explicit random outcome. Rounding or
 * thresholds never operate on just the mean. Without an outcome distribution,
 * nonlinear transforms retain their public bounds. */
function transform(
  result: PublicValueResult,
  operation: (value: number) => number,
  endpoints: (lower: number, upper: number) => [number, number],
  linear = false,
): PublicValueResult {
  if (result.kind === 'exact') return exactPublicValue(operation(result.value), result.reasons);
  if (result.kind === 'expected' && result.outcomes)
    return expectedPublicValue(
      result.outcomes.map((outcome) => ({
        value: operation(outcome.value),
        probability: outcome.probability,
      })),
      result.assumptions,
      result.reasons,
    );
  const range = rangeOf(result);
  if (!range) return unknownPublicValue(...result.reasons, 'unbounded-transformed-value');
  const [lower, upper] = endpoints(...range);
  if (result.kind === 'expected' && linear)
    return {
      kind: 'expected',
      expected: operation(result.expected),
      lower,
      upper,
      assumptions: result.assumptions,
      reasons: result.reasons,
    };
  return intervalPublicValue(lower, upper, result.reasons);
}

function sumValues(results: PublicValueResult[]): PublicValueResult {
  const reasons = reasonsOf(...results);
  if (results.every((result) => result.kind === 'exact'))
    return exactPublicValue(
      results.reduce(
        (sum, result) => sum + (result as Extract<PublicValueResult, { kind: 'exact' }>).value,
        0,
      ),
      reasons,
    );
  const ranges = results.map(rangeOf);
  if (ranges.some((range) => !range)) return unknownPublicValue(...reasons, 'unbounded-sum');
  const lower = ranges.reduce((sum, range) => sum + range![0], 0),
    upper = ranges.reduce((sum, range) => sum + range![1], 0);
  const uncertain = results.filter((result) => result.kind !== 'exact');
  if (uncertain.length === 1 && uncertain[0].kind === 'expected') {
    const constant = results.reduce(
      (sum, result) => sum + (result.kind === 'exact' ? result.value : 0),
      0,
    );
    return transform(
      uncertain[0],
      (n) => n + constant,
      (lo, hi) => [lo + constant, hi + constant],
      true,
    );
  }
  // Linearity permits E[X+Y] without independence. A joint distribution is not fabricated.
  if (results.every((result) => result.kind === 'exact' || result.kind === 'expected'))
    return {
      kind: 'expected',
      expected: results.reduce(
        (sum, result) =>
          sum +
          (result.kind === 'exact'
            ? result.value
            : result.kind === 'expected'
              ? result.expected
              : 0),
        0,
      ),
      lower,
      upper,
      assumptions: [
        ...new Set(
          results.flatMap((result) => (result.kind === 'expected' ? result.assumptions : [])),
        ),
      ],
      reasons,
    };
  return intervalPublicValue(lower, upper, reasons);
}

function subtractValues(left: PublicValueResult, right: PublicValueResult): PublicValueResult {
  const reasons = reasonsOf(left, right);
  if (left.kind === 'exact' && right.kind === 'exact')
    return exactPublicValue(Math.max(0, left.value - right.value), reasons);
  if (right.kind === 'exact')
    return transform(
      left,
      (n) => Math.max(0, n - right.value),
      (lo, hi) => [Math.max(0, lo - right.value), Math.max(0, hi - right.value)],
    );
  if (left.kind === 'exact')
    return transform(
      right,
      (n) => Math.max(0, left.value - n),
      (lo, hi) => [Math.max(0, left.value - hi), Math.max(0, left.value - lo)],
    );
  const l = rangeOf(left),
    r = rangeOf(right);
  if (!l || !r) return unknownPublicValue(...reasons, 'unbounded-subtraction');
  return intervalPublicValue(Math.max(0, l[0] - r[1]), Math.max(0, l[1] - r[0]), [
    ...reasons,
    'joint-distribution-not-provided',
  ]);
}

export function projectPublicFormulaContext(context: PublicFormulaContext): PublicFormulaContext {
  const view = makeFormulaView(context);
  const uncertainMetrics = new Set(context.projection?.uncertainMetrics ?? []);
  const prepared: PublicFormulaContext = {
    ...context,
    observation: view.observation!,
    source: view.source,
    phase: 'current',
    projection: { uncertainCardFields: view.uncertain, uncertainMetrics },
  };
  const source = view.source;
  if (!view.played || !source) return prepared;
  const icons = iconList(source);
  if (icons.includes('amber')) uncertainMetrics.add('amber');
  if (icons.includes('draw')) uncertainMetrics.add('handSize');
  if (icons.some((icon) => icon === 'damage' || icon === 'capture')) {
    for (const player of prepared.observation.players)
      for (const card of player.battleline) {
        const fields = view.uncertain.get(card.id) ?? new Set<string>();
        if (icons.includes('damage')) fields.add('damage');
        if (icons.includes('capture')) fields.add('captured');
        view.uncertain.set(card.id, fields);
      }
  }
  if (source.spec.kind !== 'creature' && source.spec.kind !== 'artifact') return prepared;
  // entryReadied runs after the source leaves its old zone, but before its
  // battleline insertion, creature-play ordinal and bonus icons resolve.
  const creature = source.spec.kind === 'creature';
  const entryActor = creature ? view.actor! : source.controller;
  const before: Observation = {
    ...prepared.observation,
    creaturesPlayedThisTurn: prepared.observation.creaturesPlayedThisTurn - Number(creature),
    players: prepared.observation.players.map((player) => ({
      ...player,
      battleline: player.battleline.filter((card) => card.id !== source.id),
      artifacts: player.artifacts.filter((card) => card.id !== source.id),
      upgrades: player.upgrades.filter((card) => card.id !== source.id),
    })) as Observation['players'],
  };
  const entryContext: PublicFormulaContext = {
    ...prepared,
    observation: before,
    actor: entryActor,
    source: { ...source, controller: entryActor },
    action: undefined,
    projection: {
      uncertainCardFields: view.uncertain,
      uncertainMetrics: context.projection?.uncertainMetrics,
    },
  };
  let ready =
    !!source.spec.entersReady ||
    !!(creature && context.action?.kind === 'play' && context.action.entryOverride);
  let unknown =
    context.observation.publicStateCoverage?.effectsComplete === false ||
    !!view.uncertain.get(source.id)?.has('spec');
  const condition = (test: Condition, provider = source) => {
    const result = evaluatePublicCondition(test, {
      ...entryContext,
      source: provider,
    });
    if (result.kind === 'exact') return result.value;
    unknown = true;
    return false;
  };
  const providers = [
    source,
    ...before.players[entryActor].battleline,
    ...before.players[entryActor].artifacts,
    ...before.players[entryActor].upgrades,
  ];
  for (const provider of providers) {
    ready ||= !!provider.spec.readyEntryKinds?.includes(source.spec.kind);
    for (const rule of provider.spec.readyEntryRules ?? []) {
      if (
        (rule.other && provider.id === source.id) ||
        (rule.kind && rule.kind !== source.spec.kind) ||
        (rule.tokenCreature !== undefined && !!source.tokenCreature !== rule.tokenCreature) ||
        (rule.notHouse && housesOf(source).includes(rule.notHouse)) ||
        (rule.trait && !traitsOf(source).includes(rule.trait))
      )
        continue;
      if (!rule.condition || condition(rule.condition, provider)) ready = true;
    }
  }
  if (source.spec.entryReadyCondition && condition(source.spec.entryReadyCondition)) ready = true;
  if (source.spec.readyIfHaunted) {
    const haunted = evaluatePublicValue({ haunted: true }, entryContext);
    if (haunted.kind === 'exact') ready ||= haunted.value !== 0;
    else unknown = true;
  }
  if (source.spec.entersReadyAfterUse) {
    const complete = context.observation.publicStateCoverage?.turnHistoryComplete !== false;
    const uses =
      source.spec.entersReadyAfterUse === 'fight'
        ? context.observation.worldsCollide?.fought[entryActor]
        : context.observation.activePlayer === entryActor
          ? context.observation.interactionCounters?.reaps
          : 0;
    if (!complete || uses === undefined) unknown = true;
    else ready ||= uses > 0;
  }
  if (
    creature &&
    before.players.some((player) =>
      [...player.battleline, ...player.artifacts, ...player.upgrades].some(
        (card) => card.spec.firstCreatureReady,
      ),
    )
  ) {
    if (context.observation.publicStateCoverage?.turnHistoryComplete === false) unknown = true;
    else ready ||= before.creaturesPlayedThisTurn === 0;
  }
  if (creature) {
    const line = prepared.observation.players[source.controller].battleline;
    const index = line.findIndex((card) => card.id === source.id);
    if (line.some((card) => card.spec.readyEnteringNeighbors)) {
      if (!prepared.observation.tide) unknown = true;
      else if (prepared.observation.tide.highFor === source.controller) {
        if (view.uncertain.get(source.id)?.has('position')) unknown = true;
        else
          ready ||= [line[index - 1], line[index + 1]].some(
            (card) => !!card?.spec.readyEnteringNeighbors,
          );
      }
    }
  }
  for (const effect of context.observation.nextReady) {
    if (effect.turn !== context.observation.turn || effect.actor !== view.actor) continue;
    const provider = view.cards.get(effect.source);
    const selected = selectPublicCards(
      { ...effect.filter, zone: 'play' },
      {
        ...prepared,
        actor: effect.actor,
        source: provider,
        action: undefined,
        projection: {
          uncertainCardFields: view.uncertain,
          uncertainMetrics: context.projection?.uncertainMetrics,
        },
      },
    );
    if (selected.cards.some((card) => card.id === source.id)) ready = true;
    else if (
      selected.possibleCards.some((card) => card.id === source.id) ||
      selected.count.kind === 'unknown'
    )
      unknown = true;
  }
  const fields = view.uncertain.get(source.id) ?? new Set<string>();
  if (ready || !unknown) fields.delete('ready');
  else fields.add('ready');
  view.uncertain.set(source.id, fields);
  const updated = { ...source, ready };
  prepared.source = updated;
  prepared.observation = {
    ...prepared.observation,
    players: prepared.observation.players.map((player) => ({
      ...player,
      battleline: player.battleline.map((card) => (card.id === source.id ? updated : card)),
      artifacts: player.artifacts.map((card) => (card.id === source.id ? updated : card)),
    })) as Observation['players'],
  };
  // Resolve a card's own public scalar modifiers when no unmodeled external
  // continuous modifier can intervene. Self-referential power remains unknown.
  const board = prepared.observation.players.flatMap((player) => [
    ...player.battleline,
    ...player.artifacts,
    ...player.upgrades,
  ]);
  for (const field of ['power', 'armor'] as const) {
    const current: CardView = prepared.source!;
    if (
      view.uncertain.get(current.id)?.has('spec') ||
      context.projection?.uncertainCardFields.get(current.id)?.has(field)
    )
      continue;
    if (
      board.some(
        (card) =>
          card.spec.auras?.some((aura) => aura.property === field) ||
          (field === 'armor' && card.spec.removesCreatureArmor),
      ) ||
      prepared.observation.lasting.some((effect) =>
        ['fixedCreatureStats', 'filteredPower', 'blankBoostNamed'].includes(effect.rule),
      )
    )
      continue;
    const bonus = field === 'power' ? current.spec.powerBonus : current.spec.armorBonusValue;
    const amount =
      bonus === undefined
        ? exactPublicValue(0)
        : evaluatePublicValue(bonus, { ...prepared, actor: current.controller, action: undefined });
    if (amount.kind !== 'exact') continue;
    let extra = 0;
    if (field === 'power' && current.spec.selfPower) {
      if (current.spec.selfPower === 'unforgedKeys')
        extra = 3 * (3 - prepared.observation.players[current.controller].keys.length);
      else if (current.spec.selfPower === 'captured') extra = current.captured;
      else {
        if (view.uncertain.get(current.id)?.has('position')) continue;
        const line = prepared.observation.players[current.controller].battleline,
          index = line.findIndex((card) => card.id === current.id);
        extra = Number(index >= 0 && (index === 0 || index === line.length - 1)) * 2;
      }
    }
    view.uncertain.get(current.id)?.delete(field);
    const next: CardView = {
      ...current,
      effective: {
        ...current.effective,
        [field]: Math.max(0, current.spec[field] + amount.value + extra),
      },
    };
    prepared.source = next;
    prepared.observation = {
      ...prepared.observation,
      players: prepared.observation.players.map((player) => ({
        ...player,
        battleline: player.battleline.map((card) => (card.id === next.id ? next : card)),
        artifacts: player.artifacts.map((card) => (card.id === next.id ? next : card)),
      })) as Observation['players'],
    };
  }
  return prepared;
}

function createEvaluator(initialContext?: PublicFormulaContext) {
  const context =
    initialContext && initialContext.phase && initialContext.phase !== 'current'
      ? projectPublicFormulaContext(initialContext)
      : initialContext;
  const view = makeFormulaView(context),
    o = view.observation,
    actor = view.actor;
  let budget = 4096,
    depth = 0;
  const active = new Set<object>();
  const consume = () => --budget >= 0;
  const unknown = (...reasons: string[]) => unknownPublicValue(...reasons);
  const current = (card: CardView) => view.cards.get(card.id);
  const inPlay = (card: CardView) =>
    !!o?.players.some((player) =>
      [...player.battleline, ...player.artifacts, ...player.upgrades].some((c) => c.id === card.id),
    );
  const historyKnown = () => o?.publicStateCoverage?.turnHistoryComplete !== false;
  const side = (which: unknown) => publicFormulaSide(which, context, view);
  const scalar = (
    input: number | PublicValueResult | undefined,
    missing: string,
  ): PublicValueResult =>
    input === undefined
      ? unknown(missing)
      : typeof input === 'number'
        ? exactPublicValue(input)
        : input;
  const binding = (key: string) => context?.bindings?.get(key);
  const select = (filter: Filter): PublicCardSelection => {
    if (!consume() || depth > 32)
      return {
        cards: [],
        possibleCards: [],
        count: unknown('formula-budget'),
        identitiesComplete: false,
        reasons: ['formula-budget'],
      };
    if (context) {
      const override = context.selectCards?.(filter, context);
      if (override !== undefined) return override;
    }
    depth++;
    try {
      return selectFormulaCards(filter, context, view, value, consume, select);
    } finally {
      depth--;
    }
  };
  const sourceScalar = (
    field: 'power' | 'armor' | 'damage' | 'captured' | 'powerCounters',
  ): PublicValueResult => {
    const source = view.source;
    if (!source) return unknown('missing-public-source');
    if (view.uncertain.get(source.id)?.has(field)) return unknown('unresolved-entry-' + field);
    return exactPublicValue(
      field === 'power' || field === 'armor' ? source.effective[field] : source[field],
    );
  };
  function aggregate(
    filter: Filter,
    field: 'power' | 'armor' | 'captured' | 'powerCounters' | 'marker',
    marker?: string,
    maximum = false,
  ): PublicValueResult {
    const selected = select(filter);
    const number = (card: CardView) =>
      field === 'power' || field === 'armor'
        ? card.effective[field]
        : field === 'marker'
          ? (card.markers?.[marker as keyof NonNullable<CardView['markers']>] ?? 0)
          : card[field];
    const uncertain = selected.cards.some((card) => view.uncertain.get(card.id)?.has(field));
    if (selected.identitiesComplete && !uncertain)
      return exactPublicValue(
        maximum
          ? Math.max(0, ...selected.cards.map(number))
          : selected.cards.reduce((sum, card) => sum + number(card), 0),
        selected.reasons,
      );
    const lower = uncertain
      ? 0
      : maximum
        ? Math.max(0, ...selected.cards.map(number))
        : selected.cards.reduce((sum, card) => sum + number(card), 0);
    const candidates = [...selected.cards, ...selected.possibleCards];
    const count = rangeOf(selected.count);
    if (
      count &&
      count[1] === candidates.length &&
      !candidates.some((card) => view.uncertain.get(card.id)?.has(field))
    ) {
      const upper = maximum
        ? Math.max(0, ...candidates.map(number))
        : candidates.reduce((sum, card) => sum + number(card), 0);
      return intervalPublicValue(lower, upper, selected.reasons);
    }
    return {
      kind: 'unknown',
      lower,
      reasons: [...selected.reasons, 'unseen-' + field + '-aggregate'],
    };
  }
  const value = (input: Value): PublicValueResult => {
    if (!consume() || depth > 32) return unknown('formula-budget');
    if (typeof input === 'number') return exactPublicValue(input);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return unknown('invalid-value-shape');
    if (active.has(input)) return unknown('formula-cycle');
    active.add(input);
    depth++;
    try {
      if ('add' in input) {
        const parts: PublicValueResult[] = [];
        for (let index = 0; index < input.add.length; index++) {
          if (budget <= 0) {
            parts.push(unknown('formula-budget'));
            break;
          }
          parts.push(value(input.add[index]));
        }
        return sumValues(parts);
      }
      if ('subtract' in input)
        return subtractValues(value(input.subtract[0]), value(input.subtract[1]));
      for (const key of ['half', 'ceilHalf', 'floorThird', 'ceilThird', 'negate'] as const)
        if (key in input) {
          const result = value((input as Record<typeof key, Value>)[key]);
          if (key === 'negate')
            return transform(
              result,
              (n) => -n,
              (lo, hi) => [-hi, -lo],
              true,
            );
          const divisor = key === 'half' || key === 'ceilHalf' ? 2 : 3,
            round = key === 'half' || key === 'floorThird' ? Math.floor : Math.ceil;
          return transform(
            result,
            (n) => round(n / divisor),
            (lo, hi) => [round(lo / divisor), round(hi / divisor)],
          );
        }
      if ('atMost' in input)
        return transform(
          value(input.value),
          (n) => Math.min(input.atMost, n),
          (lo, hi) => [Math.min(input.atMost, lo), Math.min(input.atMost, hi)],
        );
      if (context) {
        const override = context.resolveLeaf?.(input, context);
        if (override !== undefined) return override;
      }
      if ('lastAmount' in input) return scalar(context?.lastAmount, 'missing-public-last-amount');
      if ('eventAmount' in input)
        return scalar(context?.eventAmount, 'missing-public-event-amount');
      if ('chosenNumber' in input)
        return scalar(context?.chosenNumber, 'missing-public-chosen-number');
      if ('storedValue' in input)
        return scalar(
          context?.scalarBindings?.get(input.storedValue),
          'missing-public-scalar-binding:' + input.storedValue,
        );
      if ('chosenHouseIs' in input)
        return context?.chosenHouse === undefined
          ? unknown('missing-public-chosen-house')
          : exactPublicValue(Number(context.chosenHouse === input.chosenHouseIs));
      if ('sourcePower' in input) return sourceScalar('power');
      if ('sourceArmor' in input) return sourceScalar('armor');
      if ('sourceDamage' in input) return sourceScalar('damage');
      if ('sourceAmber' in input) return sourceScalar('captured');
      if ('sourcePowerCounters' in input) return sourceScalar('powerCounters');
      if ('sourceMarker' in input)
        return view.source
          ? view.uncertain.get(view.source.id)?.has('markers')
            ? unknown('unresolved-projected-markers')
            : exactPublicValue(view.source.markers?.[input.sourceMarker] ?? 0)
          : unknown('missing-public-source');
      if ('sourceUsesThisTurn' in input)
        return !historyKnown()
          ? unknown('incomplete-turn-history')
          : view.source
            ? scalar(view.source.usesThisTurn, 'missing-public-source-use-count')
            : unknown('missing-public-source');
      if ('bindingCount' in input) {
        const cards = binding(input.bindingCount);
        return cards
          ? exactPublicValue(cards.length)
          : unknown('missing-public-binding:' + input.bindingCount);
      }
      if ('bindingOwnerCount' in input || 'bindingControllerCount' in input) {
        const key =
            'bindingOwnerCount' in input ? input.bindingOwnerCount : input.bindingControllerCount,
          cards = binding(key),
          seat = side(input.side);
        if (!cards) return unknown('missing-public-binding:' + key);
        if (seat === undefined) return unknown('missing-public-side');
        return exactPublicValue(
          cards.filter(
            (card) =>
              ('bindingOwnerCount' in input ? card.owner : card.controller) === seat &&
              (!('purged' in input) ||
                !input.purged ||
                !!o?.players[card.owner].purged.some((c) => c.id === card.id)),
          ).length,
        );
      }
      if (
        'bindingBonusSum' in input ||
        'bindingPowerSum' in input ||
        'bindingHouseCount' in input ||
        'allBoundShareHouse' in input
      ) {
        const key =
          'bindingBonusSum' in input
            ? input.bindingBonusSum
            : 'bindingPowerSum' in input
              ? input.bindingPowerSum
              : 'bindingHouseCount' in input
                ? input.bindingHouseCount
                : input.allBoundShareHouse;
        const cards = binding(key);
        if (!cards) return unknown('missing-public-binding:' + key);
        if ('bindingBonusSum' in input) {
          const visible = cards.map(current);
          if (visible.some((card) => !card))
            return unknown('binding-card-current-face-unavailable:' + key);
          return exactPublicValue(
            (visible as CardView[]).reduce(
              (sum, card) => sum + iconList(card).filter((icon) => icon === 'amber').length,
              0,
            ),
          );
        }
        const currentCards = cards.map(current);
        if (currentCards.some((card) => !card))
          return unknown('binding-card-current-face-unavailable:' + key);
        const visible = currentCards as CardView[];
        if ('bindingPowerSum' in input)
          return visible.some((card) => view.uncertain.get(card.id)?.has('power'))
            ? unknown('unresolved-bound-power')
            : exactPublicValue(visible.reduce((sum, card) => sum + card.effective.power, 0));
        if ('bindingHouseCount' in input) {
          const seat = input.owner === undefined ? undefined : side(input.owner);
          if (input.owner !== undefined && seat === undefined)
            return unknown('missing-public-side');
          return exactPublicValue(
            visible.filter(
              (card) =>
                housesOf(card).includes(input.house) && (seat === undefined || card.owner === seat),
            ).length,
          );
        }
        return exactPublicValue(
          Number(
            visible.length >= 2 &&
              housesOf(visible[0]).some((house) =>
                visible.every((card) => housesOf(card).includes(house)),
              ),
          ),
        );
      }
      const firstBindingKey =
        'bindingPower' in input
          ? input.bindingPower
          : 'bindingDamage' in input
            ? input.bindingDamage
            : 'bindingAmber' in input
              ? input.bindingAmber
              : 'bindingPowerCounters' in input
                ? input.bindingPowerCounters
                : 'bindingBonus' in input
                  ? input.bindingBonus
                  : 'bindingTraits' in input
                    ? input.bindingTraits
                    : 'bindingUpgradeCount' in input
                      ? input.bindingUpgradeCount
                      : 'bonusCount' in input
                        ? input.bonusCount
                        : 'bindingIconCount' in input
                          ? input.bindingIconCount.key
                          : 'boundPowerOrLastKnown' in input
                            ? input.boundPowerOrLastKnown
                            : 'boundTokenOrLastKnown' in input
                              ? input.boundTokenOrLastKnown
                              : undefined;
      if (firstBindingKey !== undefined) {
        const cards = binding(firstBindingKey);
        if (!cards) return unknown('missing-public-binding:' + firstBindingKey);
        if (!cards.length) return exactPublicValue(0);
        const bound = cards[0],
          card = current(bound);
        if ('boundPowerOrLastKnown' in input) {
          if (card && inPlay(card) && !view.uncertain.get(card.id)?.has('power'))
            return exactPublicValue(card.effective.power);
          return scalar(
            context?.lastKnownPower?.get(firstBindingKey),
            'missing-public-last-known-power:' + firstBindingKey,
          );
        }
        if ('boundTokenOrLastKnown' in input)
          return card && inPlay(card)
            ? exactPublicValue(Number(!!card.tokenCreature))
            : unknown('missing-public-last-known-token:' + firstBindingKey);
        if (!card) return unknown('binding-card-current-face-unavailable:' + firstBindingKey);
        if ('bindingPower' in input)
          return view.uncertain.get(card.id)?.has('power')
            ? unknown('unresolved-bound-power')
            : exactPublicValue(card.effective.power);
        if ('bindingDamage' in input)
          return view.uncertain.get(card.id)?.has('damage')
            ? unknown('unresolved-projected-damage')
            : exactPublicValue(card.damage);
        if ('bindingAmber' in input)
          return view.uncertain.get(card.id)?.has('captured')
            ? unknown('unresolved-projected-captured')
            : exactPublicValue(inPlay(card) ? card.captured : 0);
        if ('bindingPowerCounters' in input)
          return view.uncertain.get(card.id)?.has('powerCounters')
            ? unknown('unresolved-projected-power-counters')
            : exactPublicValue(inPlay(card) ? card.powerCounters : 0);
        if ('bindingBonus' in input) return exactPublicValue(card.spec.amber);
        if ('bindingTraits' in input) return exactPublicValue(new Set(traitsOf(card)).size);
        if ('bonusCount' in input) return exactPublicValue(iconList(card).length);
        if ('bindingIconCount' in input)
          return exactPublicValue(
            iconList(card).filter((icon) => icon === input.bindingIconCount.icon).length,
          );
        if ('bindingUpgradeCount' in input)
          return o
            ? exactPublicValue(
                o.players
                  .flatMap((player) => player.upgrades)
                  .filter((upgrade) => upgrade.attachedTo === card.id).length,
              )
            : unknown('missing-public-observation');
      }
      if ('count' in input) {
        const selected = select(input.count),
          multiplier = input.multiplier ?? 1;
        if (!Number.isFinite(multiplier)) return unknown('invalid-count-multiplier');
        return transform(
          selected.count,
          (n) => n * multiplier,
          (lo, hi) =>
            multiplier >= 0
              ? [lo * multiplier, hi * multiplier]
              : [hi * multiplier, lo * multiplier],
          true,
        );
      }
      if ('armorTotal' in input) return aggregate(input.armorTotal, 'armor');
      if ('creatureAmberTotal' in input) return aggregate(input.creatureAmberTotal, 'captured');
      if ('powerCounterTotal' in input) return aggregate(input.powerCounterTotal, 'powerCounters');
      if ('maximumPower' in input) return aggregate(input.maximumPower, 'power', undefined, true);
      if ('markerCount' in input)
        return aggregate(input.markerCount.filter, 'marker', input.markerCount.name);
      if ('distinctHouses' in input || 'distinctPowers' in input || 'sharedHousePair' in input) {
        const filter =
          'distinctHouses' in input
            ? input.distinctHouses
            : 'distinctPowers' in input
              ? input.distinctPowers
              : input.sharedHousePair;
        const selected = select(filter),
          all = [...selected.cards, ...selected.possibleCards];
        if ('sharedHousePair' in input) {
          const yes = selected.cards.some((a, index) =>
            selected.cards
              .slice(index + 1)
              .some((b) => housesOf(a).some((h) => housesOf(b).includes(h))),
          );
          if (yes) return exactPublicValue(1, selected.reasons);
          return selected.identitiesComplete
            ? exactPublicValue(0, selected.reasons)
            : intervalPublicValue(0, 1, selected.reasons);
        }
        if (
          'distinctPowers' in input &&
          all.some((card) => view.uncertain.get(card.id)?.has('power'))
        )
          return unknown('unresolved-projected-power', ...selected.reasons);
        const distinct = (cards: readonly CardView[]) =>
          'distinctHouses' in input
            ? new Set(cards.flatMap((card) => [...housesOf(card)])).size
            : new Set(cards.map((card) => card.effective.power)).size;
        const lower = distinct(selected.cards);
        if (selected.identitiesComplete) return exactPublicValue(lower, selected.reasons);
        const count = rangeOf(selected.count);
        if (!count) return unknown('unbounded-distinct-count', ...selected.reasons);
        const allPublic = count[1] === all.length,
          upper = allPublic ? distinct(all) : 'distinctHouses' in input ? 15 : count[1];
        return intervalPublicValue(lower, Math.max(lower, upper), selected.reasons);
      }
      const contextualKeys = [
        'metric',
        'playedHouse',
        'ownTurn',
        'activeIsController',
        'keyForged',
        'discardAtLeast',
        'haunted',
        'tokenReferenceIs',
        'tide',
        'friendlyExaltedThisTurn',
        'stolenThisTurn',
        'wasStolenFromPreviousTurn',
        'creatureFightsThisTurn',
        'usedCreatureCount',
        'opponentMarkerTotal',
        'sourceNeighborPowerSum',
        'defenderMostPowerful',
        'destroyedBinding',
        'friendlyDestroyedThisTurn',
        'enemyDestroyedThisTurn',
        'foughtOpponentDestroyed',
        'maximumBoundHouseCount',
        'drawnInDrawStep',
      ];
      if (!contextualKeys.some((key) => key in input))
        return unknown('unsupported-public-formula:' + Object.keys(input).sort().join(','));
      if (!o || actor === undefined) return unknown('missing-public-observation');
      const seat = side('side' in input ? input.side : undefined);
      if (seat === undefined) return unknown('missing-public-side');
      const player = o.players[seat];
      if ('metric' in input) {
        if (
          (input.metric === 'amber' ||
            input.metric === 'handSize' ||
            input.metric === 'archives') &&
          context?.projection?.uncertainMetrics?.has(input.metric)
        )
          return unknown('unresolved-entry-bonus:' + input.metric);
        switch (input.metric) {
          case 'amber':
            return exactPublicValue(player.amber);
          case 'keys':
            return exactPublicValue(player.keys.length);
          case 'archives':
            return exactPublicValue(player.archiveCount);
          case 'handSize':
            return exactPublicValue(player.handCount);
          case 'forgedThisTurn':
          case 'forgedLastTurn':
            return !historyKnown() && player.lastForgedTurn === null
              ? unknown('incomplete-turn-history')
              : exactPublicValue(
                  Number(
                    player.lastForgedTurn === o.turn - (input.metric === 'forgedLastTurn' ? 1 : 0),
                  ),
                );
          case 'playedThisTurn':
            return historyKnown()
              ? exactPublicValue(o.playedThisTurn)
              : unknown('incomplete-turn-history');
          case 'creaturesPlayedThisTurn':
            return historyKnown()
              ? exactPublicValue(o.creaturesPlayedThisTurn)
              : unknown('incomplete-turn-history');
          case 'creaturesPlayedLastTurn':
            return historyKnown()
              ? exactPublicValue(o.publicCounters.creaturesPlayedLastTurn[seat])
              : unknown('incomplete-turn-history');
          case 'enemyFightDeaths':
            return historyKnown()
              ? exactPublicValue(o.publicCounters.enemyFightDeaths)
              : unknown('incomplete-turn-history');
          case 'uniqueCreaturesUsed':
            return historyKnown()
              ? exactPublicValue(o.publicCounters.creaturesUsed.length)
              : unknown('incomplete-turn-history');
        }
      }
      if ('playedHouse' in input)
        return historyKnown()
          ? exactPublicValue(o.publicCounters.playedByHouse[input.playedHouse] ?? 0)
          : unknown('incomplete-turn-history');
      if ('ownTurn' in input || 'activeIsController' in input)
        return exactPublicValue(Number(o.activePlayer === actor));
      if ('keyForged' in input)
        return exactPublicValue(Number(player.keys.includes(input.keyForged)));
      if ('discardAtLeast' in input)
        return exactPublicValue(Number(player.discard.length >= input.discardAtLeast));
      if ('haunted' in input) {
        if (o.haunted) return exactPublicValue(Number(o.haunted[seat]));
        const purgeHaunted = [...player.battleline, ...player.artifacts, ...player.upgrades].some(
          (card) => card.spec.hauntedWithPurged,
        );
        return exactPublicValue(
          Number(player.discard.length + (purgeHaunted ? player.purged.length : 0) >= 10),
        );
      }
      if ('tokenReferenceIs' in input)
        return o.tokenReferences
          ? exactPublicValue(Number(o.tokenReferences[seat]?.name === input.tokenReferenceIs))
          : unknown('public-token-reference-unavailable');
      if ('tide' in input)
        return o.tide
          ? exactPublicValue(
              Number(
                input.tide === 'neutral'
                  ? o.tide.highFor === null
                  : input.tide === 'high'
                    ? o.tide.highFor === seat
                    : o.tide.highFor !== null && o.tide.highFor !== seat,
              ),
            )
          : unknown('public-tide-unavailable');
      if ('friendlyExaltedThisTurn' in input)
        return !historyKnown()
          ? unknown('incomplete-turn-history')
          : o.friendlyExaltedThisTurn
            ? exactPublicValue(Number(o.friendlyExaltedThisTurn[seat]))
            : unknown('public-exalt-history-unavailable');
      if ('stolenThisTurn' in input)
        return !historyKnown()
          ? unknown('incomplete-turn-history')
          : o.worldsCollide
            ? exactPublicValue(o.worldsCollide.stolenFrom[actor === 0 ? 1 : 0])
            : unknown('public-steal-history-unavailable');
      if ('wasStolenFromPreviousTurn' in input)
        return !historyKnown()
          ? unknown('incomplete-turn-history')
          : o.worldsCollide
            ? exactPublicValue(Number(o.worldsCollide.previousStolenFrom[actor] > 0))
            : unknown('public-steal-history-unavailable');
      if ('creatureFightsThisTurn' in input)
        return !historyKnown()
          ? unknown('incomplete-turn-history')
          : o.worldsCollide
            ? exactPublicValue(o.worldsCollide.fought[actor])
            : unknown('public-fight-history-unavailable');
      if ('usedCreatureCount' in input) {
        const history = o.creatureUseHistory;
        if (!historyKnown()) return unknown('incomplete-turn-history');
        if (!history) return unknown('public-creature-use-history-unavailable');
        const who = side(input.usedCreatureCount.side);
        if (who === undefined) return unknown('missing-public-side');
        const matches = history.filter(
          (row) =>
            row.actor === who &&
            (!input.usedCreatureCount.house ||
              row.houses.includes(input.usedCreatureCount.house)) &&
            (!input.usedCreatureCount.trait || row.traits.includes(input.usedCreatureCount.trait)),
        );
        return exactPublicValue(
          input.usedCreatureCount.distinct === false
            ? matches.length
            : new Set(matches.map((row) => row.distinctKey)).size,
        );
      }
      if ('opponentMarkerTotal' in input)
        return aggregate({ side: 'enemy', zone: 'play' }, 'marker', input.opponentMarkerTotal);
      if ('sourceNeighborPowerSum' in input) {
        const source = view.source;
        if (!source) return unknown('missing-public-source');
        if (view.uncertain.get(source.id)?.has('position'))
          return unknown('unresolved-entry-position');
        const line = o.players[source.controller].battleline,
          index = line.findIndex((card) => card.id === source.id);
        const neighbors =
          index < 0
            ? []
            : [line[index - 1], line[index + 1]]
                .filter((card): card is CardView => !!card)
                .filter((card) => !traitsOf(card).includes(input.excludeTrait));
        return neighbors.some((card) => view.uncertain.get(card.id)?.has('power'))
          ? unknown('unresolved-neighbor-power')
          : exactPublicValue(neighbors.reduce((sum, card) => sum + card.effective.power, 0));
      }
      if ('defenderMostPowerful' in input) {
        const opponent = context?.combatOpponent;
        if (!opponent) return unknown('missing-public-combat-opponent');
        const selected = select({ side: 'enemy', powerExtreme: 'max' });
        return selected.identitiesComplete
          ? exactPublicValue(Number(selected.cards.some((card) => card.id === opponent.id)))
          : intervalPublicValue(0, 1, selected.reasons);
      }
      if (
        'destroyedBinding' in input ||
        'friendlyDestroyedThisTurn' in input ||
        'enemyDestroyedThisTurn' in input ||
        'foughtOpponentDestroyed' in input ||
        'maximumBoundHouseCount' in input ||
        'drawnInDrawStep' in input
      )
        return unknown('public-step-or-history-receipt-required:' + Object.keys(input)[0]);
      return unknown('unsupported-public-formula:' + Object.keys(input).sort().join(','));
    } finally {
      depth--;
      active.delete(input);
    }
  };
  const condition = (input: Condition): PublicConditionResult => {
    if (!input || !['eq', 'gt', 'gte', 'lt', 'lte'].includes(input.comparison))
      return {
        kind: 'unknown',
        possibleTrue: true,
        possibleFalse: true,
        reasons: ['invalid-condition-shape'],
      };
    const left = value(input.left),
      right = value(input.right),
      l = rangeOf(left),
      r = rangeOf(right),
      reasons = reasonsOf(left, right);
    const compare = (a: number, b: number) =>
      input.comparison === 'eq'
        ? a === b
        : input.comparison === 'gt'
          ? a > b
          : input.comparison === 'gte'
            ? a >= b
            : input.comparison === 'lt'
              ? a < b
              : a <= b;
    if (left.kind === 'exact' && right.kind === 'exact')
      return {
        kind: 'exact',
        value: compare(left.value, right.value),
        reasons,
      };
    if (l && r) {
      const always =
        input.comparison === 'eq'
          ? l[0] === l[1] && r[0] === r[1] && l[0] === r[0]
          : input.comparison === 'gt'
            ? l[0] > r[1]
            : input.comparison === 'gte'
              ? l[0] >= r[1]
              : input.comparison === 'lt'
                ? l[1] < r[0]
                : l[1] <= r[0];
      const never =
        input.comparison === 'eq'
          ? l[1] < r[0] || l[0] > r[1]
          : input.comparison === 'gt'
            ? l[1] <= r[0]
            : input.comparison === 'gte'
              ? l[1] < r[0]
              : input.comparison === 'lt'
                ? l[0] >= r[1]
                : l[0] > r[1];
      if (always || never) return { kind: 'exact', value: always, reasons };
    }
    let probability: number | undefined;
    if (left.kind === 'expected' && left.outcomes && right.kind === 'exact')
      probability = left.outcomes.reduce(
        (sum, x) => sum + (compare(x.value, right.value) ? x.probability : 0),
        0,
      );
    else if (right.kind === 'expected' && right.outcomes && left.kind === 'exact')
      probability = right.outcomes.reduce(
        (sum, x) => sum + (compare(left.value, x.value) ? x.probability : 0),
        0,
      );
    return {
      kind: 'unknown',
      possibleTrue: true,
      possibleFalse: true,
      ...(probability === undefined ? {} : { probability }),
      reasons,
    };
  };
  return { value, condition, select };
}
