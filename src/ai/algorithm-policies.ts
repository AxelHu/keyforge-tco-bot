import { cardSemanticFeatures } from '../knowledge/semantic-features.js';
import {
  evaluatePublicValue,
  exactPublicValue,
  expectedPublicValue,
  intervalPublicValue,
  unknownPublicValue,
  projectPublicFormulaContext,
  selectPublicCards,
  type PublicCardSelection,
  type PublicFormulaContext,
} from '../knowledge/public-formula.js';
import {
  HOUSES,
  type Action,
  type CardView,
  type Effect,
  type Filter,
  type House,
  type Observation,
  type Seat,
  type Side,
  type Value,
} from '../contracts/observation.js';
import type { Policy } from './policies.js';
import {
  contextualBoardWorth,
  assessPublicOperation,
  assessPublicOperationGroup,
  contextualControlValue,
  publicPlayEndsStep,
} from './public-card-value.js';
import { assessPublicReapControl } from './public-reap-control.js';
import { knownRecoveredForge } from './recovery-forge.js';
import { publicPlayCapacity } from './public-guidance-guards.js';
import { assessPublicHouseDefense } from './public-house-defense.js';
import {
  tokenUnitValue,
  tokenEngineValue,
  tokenHouseWork,
  tocPublicValue,
  publicReapBlocked,
  reapUnlockDelta,
} from './toc-public-utility.js';

export type AlgorithmName = 'tempo-v1' | 'tactical-v1';
/** Current-action corrections are explicitly enabled by a candidate, never by a historical baseline. */
export interface PublicActionCorrections {
  publicReapControlRisk?: boolean;
  /** Scoped direct-destruction receipts, attributed to the destroyed public controller. */
  publicDestructionPayments?: boolean;
  /** Bounded risk of funding an initially unfunded opposing third key. */
  publicThirdKeyFundingRisk?: boolean;
  /** Candidate-only public Destroyed group departures and captured-amber refunds. */
  publicDestroyedRefunds?: boolean;
  /** Zone/timing-aware, bounded next-action opportunities at house choice. */
  publicHouseDefenseOpportunities?: boolean;
}
/** Optional numeric refinements; all policies consume the current structured decision contract. */
export interface AlgorithmFeatures extends PublicActionCorrections {
  physicalBonuses?: boolean;
  multipleHouses?: boolean;
  targetIntent?: boolean;
  /** V4: public resource replacement and predicted removal provenance. Defaults preserve older agents. */
  netResources?: boolean;
  /** Card-aware v1: bounded public effect dataflow and contextual target values. */
  contextualEffects?: boolean;
  /** Opt-in V2 arithmetic; evaluate thirds after preceding icons/effects change the public pool. */
  publicIntegerThirds?: boolean;
  /** Opt-in V3: bind the public chooseHouse branch rather than treating chosenHouse as unknown. */
  publicHouseChoices?: boolean;
  /** Opt-in V3: public discard-pile bindings count the complete physical amber-icon list. */
  publicAmberIconBindings?: boolean;
  /** Experimental ToC candidates; historical agents leave both flags disabled. */
  tokenEconomy?: boolean;
  conditionalReapLocks?: boolean;
}
export interface ActionAssessment {
  actionId: string;
  score: number;
  reasons: string[];
  estimatedAmber: [number, number];
  projectedKey: boolean;
  deniesKey: boolean;
  approximate: boolean;
}
/** All inputs are already-observed facts. This is a small utility evaluator, NOT a replacement rules engine. */
function context(o: Observation) {
  const me = o.players[o.you],
    foe = o.players[o.you === 0 ? 1 : 0];
  const all = [
    ...(me.hand ?? []),
    ...(me.archives ?? []),
    ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades, ...p.discard, ...p.purged]),
    ...o.promptCards,
    ...o.resolving,
    ...o.underCards.flatMap((r) => r.cards ?? []),
  ];
  const cards = [...new Map(all.map((c) => [c.id, c])).values()];
  return {
    me,
    foe,
    cards,
    find: (id: string) => cards.find((c) => c.id === id),
    inPlay: (id: string) =>
      o.players.some((p) => [...p.battleline, ...p.artifacts, ...p.upgrades].some((c) => c.id === id)),
  };
}
export function houseWork(o: Observation, h: string | null, features: AlgorithmFeatures = {}): number {
  const { me } = context(o);
  if (h === null) return 0;
  const hand = [...(me.hand ?? []), ...(me.archives ?? []).filter((c) => c.owner === o.you)];
  const matches = (c: CardView) =>
    features.multipleHouses
      ? (c.effective.houses ?? [c.effective.house]).includes(h as import('../contracts/observation.js').House)
      : c.effective.house === h;
  const blocked =
    features.physicalBonuses &&
    [...o.players[1 - o.you].battleline, ...o.players[1 - o.you].artifacts].some(
      (c) => c.spec.blocksOpponentBonusIcons,
    );
  const amber = (c: CardView) =>
    features.physicalBonuses
      ? blocked
        ? 0
        : (c.resolvedBonusIcons ?? c.bonusIcons ?? Array(c.spec.amber).fill('amber')).filter(
            (x: string) => x === 'amber',
          ).length
      : c.spec.amber;
  const plays = hand
    .filter(matches)
    .reduce((n, c) => n + 1.6 + amber(c) * 1.3 + (c.spec.kind === 'creature' ? 1.2 : 0), 0);
  const fromSupply = [...me.battleline, ...me.artifacts].some((c) => c.spec.supplyInsteadOfPool);
  const intercepted =
    features.netResources &&
    ([...o.players[1 - o.you].battleline, ...o.players[1 - o.you].artifacts].some(
      (c) => c.spec.capturesIncomingAmber || (!fromSupply && c.spec.capturesReapIncome),
    ) ||
      o.lasting.some(
        (e) => e.rule === 'poolIncomeBecomesTokens' && e.turn === o.turn && e.appliesTo === o.you,
      ));
  const ready = me.battleline
    .filter((c) => matches(c) && c.ready)
    .reduce(
      (n, c) =>
        n +
        (c.stunned
          ? 0.6
          : c.spec.cannotReap || (features.conditionalReapLocks && publicReapBlocked(o, c) === true)
            ? 0.7
            : intercepted
              ? 0.9
              : 3.2),
      0,
    );
  const arts = me.artifacts.filter(
    (c) => matches(c) && c.ready && (c.spec.abilities?.action?.length ?? 0) > 0,
  ).length;
  return plays + ready + arts * 1.6 + (features.tokenEconomy ? tokenHouseWork(o, h) : 0);
}
const legacyBoardWorth = (c: CardView) =>
  2.6 +
  Math.min(c.effective.power, 10) * 0.18 +
  (c.spec.drawBonus ?? 0) * 2 +
  (c.spec.opponentKeyTax ?? 0) * 1.5 +
  (c.spec.opponentDrawPenalty ?? 0) * 1.2;
/** Replay-visible, deterministic score. Unknown effects add no fabricated benefit and mark approximation. */
export function assessAlgorithm(
  o: Observation,
  actionId: string,
  mode: AlgorithmName = 'tactical-v1',
  features: AlgorithmFeatures = {},
): ActionAssessment {
  return assessAlgorithmProjection(o, actionId, mode, features).assessment;
}
/** Private projection details are also reused by house-choice opportunity probes.
 * The public action assessment and its historical serialization stay unchanged.
 */
function assessAlgorithmProjection(
  o: Observation,
  actionId: string,
  mode: AlgorithmName,
  features: AlgorithmFeatures,
): {
  assessment: ActionAssessment;
  opponentKeyCost: number;
  skipsOpponentForge: boolean;
  unresolvedValues: boolean;
} {
  const item = o.legalActions.find((x) => x.id === actionId);
  if (!item) throw new Error('Cannot assess an illegal action');
  const a = item.action,
    { me, foe, cards, find, inPlay } = context(o),
    opp = (o.you === 0 ? 1 : 0) as Seat;
  const initial: [number, number] = [me.amber, foe.amber],
    pool: [number, number] = [...initial];
  let ownCost = me.keyCost,
    otherCost = foe.keyCost,
    score = 0,
    approximate = false,
    projectedKey = false,
    skip = false,
    draws = 0,
    chainGain = 0,
    forecastUncertain =
      !!features.contextualEffects &&
      (o.publicStateCoverage?.effectsComplete === false ||
        o.publicStateCoverage?.turnHistoryComplete === false),
    // Separate unmodeled effects from missing native coverage for bounded probes.
    unresolvedEffects = false;
  const reasons: string[] = [];
  const c = 'card' in a ? find(a.card) : undefined;
  const physicalSource = c ?? (features.contextualEffects ? find(o.pending?.source ?? '') : undefined);
  // A copy supplies the rule tree, while source quantities refer to the physical card.
  const source = a.kind === 'play' && a.copy ? find(a.copy) : physicalSource;
  const evaluatedInPlay = (id: string) =>
    (!features.contextualEffects || (!projectedLocations.has(id) && !predictedRemoved.has(id) && !uncertainLocations.has(id))) &&
    (inPlay(id) || !!(features.contextualEffects && a.kind === 'play' && physicalSource?.id === id &&
      ['creature', 'artifact', 'upgrade'].includes(physicalSource.spec.kind)));
  const boardWorth = (card: CardView) =>
    (features.contextualEffects ? contextualBoardWorth(o, card) : legacyBoardWorth(card)) +
    (features.tokenEconomy ? tokenEngineValue(o, card) : 0);
  const departingPhysicalIds = new Set(a.kind === 'play'
    ? [a.card, ...(a.otherHalf ? [a.otherHalf] : [])] : []);
  const hands = [me.handCount - (me.hand ?? []).filter((card) => departingPhysicalIds.has(card.id)).length, foe.handCount];
  const archives = [me.archiveCount - (me.archives ?? []).filter((card) => departingPhysicalIds.has(card.id)).length, foe.archiveCount];
  const drawSupply = [me.deckCount + me.discard.length, foe.deckCount + foe.discard.length];
  // Only proven shuffle arrivals change this ledger. Other unmodeled deck changes
  // invalidate the count; a later arrival must never revive the original deck size.
  const deckChanges = [0, 0];
  const bindings = new Map<string, CardView[]>();
  const scalarBindings = new Map<string, number>();
  // Scoped physical receipts; these are estimates from public destruction assessment,
  // not selected-card counts or a copied referee destruction history.
  const directDestructions = new Map<string, { id: string; controller: Seat }[]>();
  let publicControlChanged = false;
  // Counts only: generated bodies have no fabricated reverse face or public identity.
  const createdTokens = [0, 0];
  let tokenUtility = 0;
  let lastAmount: number | undefined = undefined,
    chosenHouse: House | undefined,
    unknownValues = 0,
    effectBudget = features.publicAmberIconBindings ? 16384 : 512;
  function markUnknown() {
    approximate = true;
    if (features.contextualEffects) {
      forecastUncertain = unresolvedEffects = true;
      unknownValues++;
    }
  }
  const idx = (side?: Side) => {
    if (side === undefined || side === 'self') return 0;
    if (side === 'opponent') return 1;
    if (features.contextualEffects && side === 'active') return o.activePlayer === o.you ? 0 : 1;
    markUnknown();
    // Missing public event/last-owner context does not establish the referee's
    // default actor. Keep the legacy path separate from current attribution.
    return features.contextualEffects ? -1 : 0;
  };
  const player = (i: number) => (i === 0 ? me : foe);
  const ability = (card: CardView | undefined, k: 'play' | 'reap' | 'action' | 'omni') =>
    card?.spec.abilities?.[k] ?? [];
  function filtered(filter: Filter, src = features.contextualEffects ? physicalSource : source): CardView[] {
    if (features.contextualEffects && !filter.notTaggedForDestruction) {
      const ctx = formulaContext();
      const result = selectPublicCards(filter, { ...ctx,
        source: src?.id === physicalSource?.id ? ctx.source : src ? projectedCard(src) : ctx.source });
      if (!result.identitiesComplete) markUnknown();
      return [...result.cards];
    }
    if (features.contextualEffects) {
      if (filter.house === 'chosenHouse' || filter.notHouse === 'chosenHouse') {
        if (!features.publicHouseChoices || !chosenHouse) {
          markUnknown();
          return [];
        }
        filter = {
          ...filter,
          ...(filter.house === 'chosenHouse' ? { house: chosenHouse } : {}),
          ...(filter.notHouse === 'chosenHouse' ? { notHouse: chosenHouse } : {}),
        };
      }
      const supported = new Set([
        'side',
        'kind',
        'house',
        'notHouse',
        'other',
        'trait',
        'notTrait',
        'damaged',
        'stunned',
        'ready',
        'withAmber',
        'powerMin',
        'powerMax',
        'keyword',
        'zone',
        'definition',
        'any',
        'flank',
        'powerExtreme',
        'name',
      ]);
      if (features.tokenEconomy || features.conditionalReapLocks) {
        supported.add('tokenCreature');
        supported.add('sourceOnly');
      }
      if (features.publicDestructionPayments) supported.add('notTaggedForDestruction');
      if (Object.entries(filter).some(([key, v]) => v !== undefined && !supported.has(key))) {
        markUnknown();
        return [];
      }
    }
    if (
      filter.bound ||
      filter.excludeBinding ||
      filter.sharesTraits ||
      filter.houseBinding ||
      filter.neighborBinding ||
      filter.powerEqualsChosen ||
      filter.ranked ||
      filter.notSameNameBinding
    ) {
      markUnknown();
      return [];
    }
    let destructionDomain: Set<string> | undefined;
    if (features.contextualEffects && features.publicDestructionPayments && filter.notTaggedForDestruction) {
      if (o.pending?.kind === 'target' && (a.kind === 'select' || a.kind === 'done')) {
        // The current server/referee offer establishes eligibility. A visible but
        // unoffered body must never be added to a real target prompt.
        destructionDomain = new Set([
          ...(o.pending.selected ?? []),
          ...o.legalActions.flatMap((x) => (x.action.kind === 'select' ? [x.action.target] : [])),
        ]);
      } else if (a.kind === 'play' && o.phase === 'main' && !o.pending) {
        // Main-play planning is a bounded public-board estimate, not a claim that
        // this future menu or the adapter's omitted destruction tags are complete.
        approximate = true;
      } else {
        markUnknown();
        return [];
      }
    }
    let list = cards.filter((x) => {
      const zones = filter.zone ? [filter.zone].flat() : [features.contextualEffects ? 'battleline' : 'play'];
      const zone =
        (!features.contextualEffects || !predictedRemoved.has(x.id)) &&
        zones.some((z) =>
          z === 'play'
            ? evaluatedInPlay(x.id)
            : (features.contextualEffects &&
                a.kind === 'play' &&
                source?.id === x.id &&
                ((z === 'battleline' && source.spec.kind === 'creature') ||
                  (z === 'artifacts' && source.spec.kind === 'artifact'))) ||
              o.players.some((p) =>
                (p[z as 'hand' | 'archives' | 'battleline'] ?? []).some((t) => t.id === x.id),
              ),
        );
      const friendly = x.controller === o.you;
      return (
        zone &&
        (!destructionDomain || destructionDomain.has(x.id)) &&
        (!filter.side || filter.side === 'any' || (filter.side === 'friendly' ? friendly : !friendly)) &&
        (!filter.kind || x.spec.kind === filter.kind) &&
        (!filter.house ||
          (features.contextualEffects
            ? (x.effective.houses ?? [x.effective.house]).includes(
                filter.house as import('../contracts/observation.js').House,
              )
            : x.effective.house === filter.house)) &&
        (!filter.notHouse ||
          (features.contextualEffects
            ? !(x.effective.houses ?? [x.effective.house]).includes(
                filter.notHouse as import('../contracts/observation.js').House,
              )
            : x.effective.house !== filter.notHouse)) &&
        (!filter.other || x.id !== src?.id) &&
        (!(features.tokenEconomy || features.conditionalReapLocks) ||
          !filter.sourceOnly ||
          x.id === src?.id) &&
        (!(features.tokenEconomy || features.conditionalReapLocks) ||
          filter.tokenCreature === undefined ||
          !!x.tokenCreature === filter.tokenCreature) &&
        (!filter.trait || x.spec.traits?.includes(filter.trait)) &&
        (!filter.notTrait || !x.spec.traits?.includes(filter.notTrait)) &&
        (filter.damaged === undefined || x.damage > 0 === filter.damaged) &&
        (filter.stunned === undefined || x.stunned === filter.stunned) &&
        (filter.ready === undefined || x.ready === filter.ready) &&
        (filter.withAmber === undefined || x.captured > 0 === filter.withAmber) &&
        (filter.powerMin === undefined || x.effective.power >= filter.powerMin) &&
        (filter.powerMax === undefined || x.effective.power <= filter.powerMax) &&
        (!filter.keyword || x.effective.keywords.includes(filter.keyword))
      );
    });
    if (filter.definition) list = list.filter((x) => x.definition === filter.definition);
    if (features.contextualEffects && filter.name) list = list.filter((x) => x.spec.name === filter.name);
    if (filter.any) {
      const ids = new Set(
        filter.any.flatMap((f) => filtered({ ...filter, any: undefined, ...f }, src).map((x) => x.id)),
      );
      list = list.filter((x) => ids.has(x.id));
    }
    if (filter.flank !== undefined)
      list = list.filter((x) => {
        const line = player(x.controller === o.you ? 0 : 1).battleline;
        return [line[0]?.id, line.at(-1)?.id].includes(x.id) === filter.flank;
      });
    if (filter.neighborsOf) {
      markUnknown();
      return [];
    }
    if (filter.powerExtreme) {
      const n = Math[filter.powerExtreme](...list.map((x) => x.effective.power));
      list = list.filter((x) => x.effective.power === n);
    }
    return list;
  }
  function value(v: Value | undefined): number {
    if (v === undefined) return 0;
    if (typeof v === 'number') return v;
    if (features.contextualEffects) {
      const result = evaluatePublicValue(v, formulaContext());
      if (result.kind === 'exact') return result.value;
      // An interval/expectation is not a deterministic threshold or loop count.
      // Random effects enumerate concrete public outcomes separately.
      markUnknown();
      const reason = `public-formula: ${result.kind}: ${result.reasons.join(', ')}`;
      if (!reasons.includes(reason)) reasons.push(reason);
      return 0;
    }
    if ('add' in v) return v.add.reduce<number>((n, x) => n + value(x), 0);
    if ('subtract' in v) return value(v.subtract[0]) - value(v.subtract[1]);
    if ('half' in v) return Math.floor(value(v.half) / 2);
    if (features.contextualEffects) {
      if ('lastAmount' in v) {
        if (lastAmount !== undefined) return lastAmount;
        markUnknown();
        return 0;
      }
      if ('boundPowerOrLastKnown' in v || 'bindingPower' in v || 'bindingPowerSum' in v) {
        const key =
          'boundPowerOrLastKnown' in v
            ? v.boundPowerOrLastKnown
            : 'bindingPower' in v
              ? v.bindingPower
              : v.bindingPowerSum;
        const found = bindings.get(key);
        if (found)
          return 'bindingPowerSum' in v
            ? found.reduce((n, c) => n + c.effective.power, 0)
            : (found[0]?.effective.power ?? 0);
      }
      if (features.publicDestructionPayments && 'destroyedBinding' in v) {
        const receipts = directDestructions.get(v.destroyedBinding);
        if (
          v.direct === true &&
          (v.side === undefined || v.side === 'self' || v.side === 'opponent') &&
          receipts
        ) {
          const controller = v.side === 'opponent' ? opp : o.you;
          return receipts.filter((r) => r.controller === controller).length;
        }
        markUnknown();
        return 0;
      }
      if ('bindingCount' in v && bindings.has(v.bindingCount)) return bindings.get(v.bindingCount)!.length;
      if (features.publicAmberIconBindings && 'bindingBonusSum' in v && bindings.has(v.bindingBonusSum))
        return bindings.get(v.bindingBonusSum)!.reduce((n, c) => {
          // The public list is complete, including enhanced amber, and may be
          // explicitly empty. Do not add the native printed prefix twice.
          const icons = c.bonusIcons ?? c.resolvedBonusIcons;
          return n + (icons ? icons.filter((icon) => icon === 'amber').length : c.spec.amber);
        }, 0);
      if ('sourcePower' in v && source) return source.effective.power;
      if ('sourceAmber' in v && source) return captured(source);
      if ('ceilHalf' in v) return Math.ceil(value(v.ceilHalf) / 2);
      if (features.publicIntegerThirds && 'floorThird' in v) return Math.floor(value(v.floorThird) / 3);
      if ('atMost' in v) return Math.min(v.atMost, value(v.value));
    }
    if ('count' in v) {
      let count = filtered(v.count).length;
      // Only this exact public count subset admits anonymous newly created bodies.
      // Relative positions, bound identity, combat modifications and private zones stay unknown.
      const f = v.count;
      if (
        features.tokenEconomy &&
        Object.keys(f).every((k) =>
          [
            'side',
            'zone',
            'kind',
            'tokenCreature',
            'house',
            'notHouse',
            'trait',
            'notTrait',
            'name',
            'definition',
          ].includes(k),
        ) &&
        (!f.zone || f.zone === 'battleline' || f.zone === 'play') &&
        (!f.kind || f.kind === 'creature') &&
        f.tokenCreature !== false
      ) {
        for (const i of [0, 1]) {
          const seat = i === 0 ? o.you : opp,
            ref = o.tokenReferences?.[seat];
          if (
            !ref ||
            (f.side === 'friendly' && i !== 0) ||
            (f.side === 'enemy' && i !== 1) ||
            (f.house && ref.house !== f.house) ||
            (f.notHouse && ref.house === f.notHouse) ||
            (f.trait && !ref.traits?.includes(f.trait)) ||
            (f.notTrait && ref.traits?.includes(f.notTrait)) ||
            (f.name && ref.name !== f.name) ||
            (f.definition && ref.id !== f.definition)
          )
            continue;
          count += createdTokens[i];
        }
      }
      return count * (v.multiplier ?? 1);
    }
    if (
      features.tokenEconomy &&
      ('haunted' in v || 'tokenReferenceIs' in v || 'keyForged' in v || 'ownTurn' in v)
    ) {
      const known = tocPublicValue(o, v, o.you, source);
      if (known !== null) return known;
    }
    if ('metric' in v) {
      const i = idx(v.side);
      if (i === -1) return 0;
      const p = player(i);
      switch (v.metric) {
        case 'amber':
          return pool[i];
        case 'keys':
          return p.keys.length;
        case 'archives':
          return p.archiveCount;
        case 'handSize':
          return features.contextualEffects ? hands[i] : p.handCount - (i === 0 && a.kind === 'play' ? 1 : 0);
        case 'playedThisTurn':
          return o.playedThisTurn + (a.kind === 'play' ? 1 : 0);
        case 'creaturesPlayedThisTurn':
          return o.creaturesPlayedThisTurn + (a.kind === 'play' && source?.spec.kind === 'creature' ? 1 : 0);
        case 'creaturesPlayedLastTurn':
          return o.publicCounters.creaturesPlayedLastTurn[i === 0 ? o.you : opp];
        case 'enemyFightDeaths':
          return o.publicCounters.enemyFightDeaths;
        case 'uniqueCreaturesUsed':
          return o.publicCounters.creaturesUsed.length;
        case 'forgedThisTurn':
          return p.lastForgedTurn === o.turn ? 1 : 0;
        case 'forgedLastTurn':
          return p.lastForgedTurn === o.turn - 1 ? 1 : 0;
      }
    }
    if ('playedHouse' in v)
      return (
        (o.publicCounters.playedByHouse[v.playedHouse] ?? 0) +
        (a.kind === 'play' && source?.effective.house === v.playedHouse ? 1 : 0)
      );
    if ('sourceUsesThisTurn' in v) return (source?.usesThisTurn ?? 0) + 1;
    markUnknown();
    return 0;
  }
  const predictedRemoved = new Set<string>();
  const predictedWards = new Map<string, boolean>();
  const predictedCaptured = new Map<string, number>();
  const projectedFields = new Map<string, Partial<Pick<CardView, 'ready' | 'stunned'>>>();
  type ProjectedZone = 'hand' | 'archives' | 'discard' | 'purged' | 'deck';
  const projectedLocations = new Map<string, { card: CardView; seat: Seat; zone: ProjectedZone }>();
  const uncertainLocations = new Set<string>();
  // Local public-operation versions distinguish a fresh selection in a new zone
  // from an older binding. They are never referee entry counters.
  const projectedEntries = new Map<string, number>();
  const publicCardEntries = new WeakMap<CardView, number>();
  const uncertainFormulaZones = new Set<string>();
  const changedFormulaFields = new Map<string, Set<string>>();
  const uncertainPools = new Set<number>();
  const uncertainCounts = new Set<string>();
  const uncertainSupplies = new Set<number>();
  let preparedFormulaContext: PublicFormulaContext | undefined;
  function preparedContext(): PublicFormulaContext {
    return (preparedFormulaContext ??= projectPublicFormulaContext({
      observation: o,
      source: physicalSource,
      action: a,
      phase: a.kind === 'play' ? 'after-play' : ['use', 'reap', 'fight'].includes(a.kind) ? 'after-use' : 'current',
    }));
  }
  function projectedCard(card: CardView): CardView {
    const result = predictedCaptured.has(card.id) || predictedWards.has(card.id) || projectedFields.has(card.id)
      ? { ...card, ...projectedFields.get(card.id), captured: predictedCaptured.get(card.id) ?? card.captured,
          warded: predictedWards.get(card.id) ?? card.warded }
      : card;
    publicCardEntries.set(result, publicCardEntries.get(card) ?? 0);
    return result;
  }
  function formulaContext(): PublicFormulaContext {
    const prepared = preparedContext();
    const base = prepared.observation;
    const players = base.players.map((p, seat) => {
      const relative = seat === o.you ? 0 : 1;
      const pile = (zone: Exclude<ProjectedZone, 'deck'> | 'battleline' | 'artifacts' | 'upgrades') => {
        const original = p[zone];
        if ((zone === 'hand' || zone === 'archives') &&
          (!original || uncertainFormulaZones.has(`${seat}:${zone}`))) return undefined;
        const kept = (original ?? []).filter((card) =>
          !projectedLocations.has(card.id) &&
          (!['battleline', 'artifacts', 'upgrades'].includes(zone) || !predictedRemoved.has(card.id)));
        const added = [...projectedLocations.values()].filter((move) => move.seat === seat && move.zone === zone)
          .map((move) => move.card);
        return [...kept, ...added].map(projectedCard);
      };
      return { ...p, amber: pool[relative], handCount: hands[relative], archiveCount: archives[relative],
        deckCount: p.deckCount + deckChanges[relative],
        hand: pile('hand'), archives: pile('archives'), battleline: pile('battleline')!,
        artifacts: pile('artifacts')!, upgrades: pile('upgrades')!, discard: pile('discard')!, purged: pile('purged')! };
    }) as Observation['players'];
    const projected = { ...base, players };
    const uncertainFields = new Map<string, ReadonlySet<string>>(prepared.projection?.uncertainCardFields ?? []);
    for (const [id, fields] of changedFormulaFields)
      uncertainFields.set(id, new Set([...(uncertainFields.get(id) ?? []), ...fields]));
    for (const [id, fields] of projectedFields) {
      const unknown = new Set(uncertainFields.get(id) ?? []);
      for (const field of Object.keys(fields)) unknown.delete(field);
      uncertainFields.set(id, unknown);
    }
    const ctx: PublicFormulaContext = {
      ...prepared, observation: projected,
      source: prepared.source ? projectedCard(prepared.source) : undefined,
      bindings: new Map([...bindings].map(([key, cards]) => [key, cards.map(projectedCard)])),
      scalarBindings, lastAmount, chosenHouse,
      projection: { ...prepared.projection, uncertainCardFields: uncertainFields },
      resolveLeaf: (leaf, leafContext) => {
        if ('metric' in leaf && ['amber', 'handSize', 'archives'].includes(leaf.metric)) {
          if (leaf.side !== undefined && !['self', 'opponent', 'active'].includes(leaf.side)) return undefined;
          const actor = (leafContext.actor ?? o.you) === o.you ? 0 : 1;
          const side = leaf.side === 'active' ? (o.activePlayer === o.you ? 0 : 1) : leaf.side === 'opponent' ? 1 - actor : actor;
          if (leaf.metric === 'amber') return uncertainPools.has(side)
            ? unknownPublicValue('resource-pool-depends-on-random-outcome') : exactPublicValue(pool[side]);
          const zone = leaf.metric === 'handSize' ? 'hand' : 'archives';
          return uncertainCounts.has(`${side === 0 ? o.you : opp}:${zone}`)
            ? unknownPublicValue('zone-count-depends-on-random-or-unmodeled-continuation')
            : exactPublicValue(leaf.metric === 'handSize' ? hands[side] : archives[side]);
        }
        if ('destroyedBinding' in leaf) {
          const receipts = directDestructions.get(leaf.destroyedBinding);
          if (features.publicDestructionPayments && leaf.direct === true && receipts &&
            (leaf.side === undefined || leaf.side === 'self' || leaf.side === 'opponent')) {
            const actor = leafContext.actor ?? o.you;
            const controller = leaf.side === 'opponent' ? (actor === 0 ? 1 : 0) : actor;
            return exactPublicValue(receipts.filter((receipt) => receipt.controller === controller).length);
          }
          return unknownPublicValue('no-public-scoped-destruction-receipt');
        }
        const key = Object.keys(leaf)[0];
        const sourceField: Record<string, string> = { sourcePower: 'power', sourceArmor: 'armor',
          sourceDamage: 'damage', sourcePowerCounters: 'powerCounters' };
        if (sourceField[key] && physicalSource && changedFormulaFields.get(physicalSource.id)?.has(sourceField[key]))
          return unknownPublicValue('source-field-changed-in-unmodeled-continuation');
        const bindingField: Record<string, string> = { bindingPower: 'power', bindingPowerSum: 'power',
          boundPowerOrLastKnown: 'power', bindingDamage: 'damage', bindingPowerCounters: 'powerCounters' };
        if (bindingField[key]) {
          const binding = (leaf as unknown as Record<string, unknown>)[key];
          if (typeof binding === 'string' && bindings.get(binding)?.some((card) => changedFormulaFields.get(card.id)?.has(bindingField[key])))
            return unknownPublicValue('bound-field-changed-in-unmodeled-continuation');
        }
        if (publicControlChanged && ['count', 'armorTotal', 'powerCounterTotal', 'maximumPower', 'distinctPowers',
          'creatureAmberTotal', 'distinctHouses', 'sharedHousePair'].includes(key))
          return unknownPublicValue('controller-changed-in-unmodeled-continuation');
        return undefined;
      },
      selectCards: (filter, current) => projectedSelection(filter, current),
    };
    return ctx;
  }
  function projectedSelection(filter: Filter, ctx: PublicFormulaContext): PublicCardSelection {
    if (publicControlChanged) return { cards: [], possibleCards: [],
      count: unknownPublicValue('controller-changed-in-unmodeled-continuation'), identitiesComplete: false,
      reasons: ['controller-changed-in-unmodeled-continuation'] };
    const zones = filter.zone ? [filter.zone].flat() : ['battleline'];
    const actor = ctx.actor ?? o.you;
    const seats = filter.side === 'friendly' ? [actor] : filter.side === 'enemy' ? [actor === 0 ? 1 : 0] : [0, 1];
    if (seats.some((seat) => zones.some((zone) => uncertainCounts.has(`${seat}:${zone}`) ||
      (zone === 'deck' && (uncertainSupplies.has(seat === o.you ? 0 : 1) ||
        (seat === o.you && ctx.projection?.uncertainMetrics?.has('handSize'))))))) return {
      cards: [], possibleCards: [], count: unknownPublicValue('zone-count-depends-on-random-or-unmodeled-continuation'),
      identitiesComplete: false, reasons: ['public-projection-incomplete'],
    };
    const uncertainZone = seats.some((seat) => zones.some((zone) => uncertainFormulaZones.has(`${seat}:${zone}`)));
    const changedField = [...changedFormulaFields.values()].some((fields) =>
      (filter.damaged !== undefined && fields.has('damage')) ||
      ((filter.powerMin !== undefined || filter.powerMax !== undefined || filter.powerExtreme) && fields.has('power')) ||
      (filter.ready !== undefined && fields.has('ready')) || (filter.stunned !== undefined && fields.has('stunned')));
    let selectionBindings = ctx.bindings;
    for (const key of [filter.bound, filter.excludeBinding].filter((key): key is string => !!key)) {
      const original = selectionBindings?.get(key);
      if (!original) continue;
      if (original.some((card) => uncertainLocations.has(card.id))) return {
        cards: [], possibleCards: [], count: unknownPublicValue('binding-location-varies-across-random-outcomes'),
        identitiesComplete: false, reasons: ['binding-location-varies-across-random-outcomes'],
      };
      selectionBindings = new Map(selectionBindings).set(key, original.filter((card) =>
        (publicCardEntries.get(card) ?? 0) === (projectedEntries.get(card.id) ?? 0)));
    }
    const base = selectPublicCards(filter, { ...ctx, bindings: selectionBindings, selectCards: undefined });
    for (const card of base.cards) if (projectedLocations.has(card.id) && !uncertainLocations.has(card.id))
      publicCardEntries.set(card, projectedEntries.get(card.id) ?? 0);
    if (uncertainZone && Object.keys(filter).every((key) => ['side', 'zone'].includes(key)) &&
      zones.every((zone) => zone === 'hand' || zone === 'archives' || zone === 'deck')) return {
      ...base, cards: [], possibleCards: [], identitiesComplete: false,
      reasons: [...base.reasons, 'projected-zone-count-known-identities-not-known'],
    };
    if (uncertainZone || changedField) return {
      cards: [], possibleCards: [...base.cards, ...base.possibleCards],
      count: unknownPublicValue(uncertainZone ? 'zone-identities-changed-in-random-or-unmodeled-continuation' : 'filter-field-changed-in-unmodeled-continuation'),
      identitiesComplete: false, reasons: ['public-projection-incomplete'],
    };
    const tokenTotal = createdTokens.reduce((sum, count) => sum + count, 0);
    if (!tokenTotal || !zones.some((zone) => zone === 'battleline' || zone === 'play')) return base;
    const supported = ['side', 'zone', 'kind', 'tokenCreature', 'house', 'notHouse', 'trait', 'notTrait', 'name', 'definition'];
    if (Object.keys(filter).some((key) => !supported.includes(key))) return {
      ...base, count: unknownPublicValue('anonymous-token-identities-required'), identitiesComplete: false,
      reasons: [...base.reasons, 'anonymous-token-identities-required'],
    };
    let added = 0;
    for (const seat of seats) {
      const reference = o.tokenReferences?.[seat], relative = seat === o.you ? 0 : 1;
      if (!reference || (filter.kind && filter.kind !== 'creature') || filter.tokenCreature === false ||
        (filter.house && reference.house !== filter.house) || (filter.notHouse && reference.house === filter.notHouse) ||
        (filter.trait && !reference.traits?.includes(filter.trait)) || (filter.notTrait && reference.traits?.includes(filter.notTrait)) ||
        (filter.name && reference.name !== filter.name) || (filter.definition && reference.id !== filter.definition)) continue;
      added += createdTokens[relative];
    }
    const count = base.count.kind === 'exact' ? exactPublicValue(base.count.value + added) :
      base.count.kind === 'interval' ? intervalPublicValue(base.count.lower + added, base.count.upper + added, base.count.reasons) : base.count;
    return { ...base, count, identitiesComplete: base.identitiesComplete && added === 0,
      reasons: added ? [...base.reasons, 'anonymous-created-tokens-counted-without-fabricated-identities'] : base.reasons };
  }
  function noteChangedFields(card: CardView, operation: string, result: { affected: boolean; approximate: boolean }) {
    const changes: Record<string, Partial<Pick<CardView, 'ready' | 'stunned'>>> = {
      ready: { ready: true }, exhaust: { ready: false }, stun: { stunned: true },
      stunExhaust: { ready: false, stunned: true },
    };
    if (result.affected && changes[operation]) {
      projectedFields.set(card.id, { ...projectedFields.get(card.id), ...changes[operation] });
      for (const field of Object.keys(changes[operation])) changedFormulaFields.get(card.id)?.delete(field);
      return;
    }
    const affected: Record<string, string[]> = { damage: ['damage', 'armor'], heal: ['damage'],
      power: ['power', 'powerCounters'], ready: ['ready'], exhaust: ['ready'], stun: ['stunned'],
      stunExhaust: ['ready', 'stunned'] };
    if (!affected[operation]) return;
    const fields = changedFormulaFields.get(card.id) ?? new Set<string>();
    const previouslyKnown = { ...projectedFields.get(card.id) };
    for (const field of affected[operation]) {
      fields.add(field);
      if (field === 'ready' || field === 'stunned') delete previouslyKnown[field];
    }
    projectedFields.set(card.id, previouslyKnown);
    changedFormulaFields.set(card.id, fields);
  }

  function projectedLocation(card: CardView): { seat: Seat; zone: ProjectedZone | 'battleline' | 'artifacts' | 'upgrades' } | undefined {
    const moved = projectedLocations.get(card.id);
    if (moved) return moved;
    const view = preparedContext().observation;
    for (const seat of [0, 1] as const)
      for (const zone of ['hand', 'archives', 'discard', 'purged', 'battleline', 'artifacts', 'upgrades'] as const)
        if (view.players[seat][zone]?.some((candidate) => candidate.id === card.id)) return { seat, zone };
    return undefined;
  }
  function recordProjectedMove(card: CardView, operation: string) {
    const destinations: Record<string, ProjectedZone> = { destroy: 'discard', sacrifice: 'discard',
      discard: 'discard', purge: 'purged', returnHand: 'hand', deckTop: 'deck', deckBottom: 'deck',
      shuffleDeck: 'deck', shuffleIntoDeck: 'deck', archive: 'archives' };
    const zone = destinations[operation];
    if (!zone) return;
    const previous = projectedLocation(card);
    const seat = card.owner;
    if (previous?.zone === zone && previous.seat === seat) return;
    const oldSide = previous?.seat === o.you ? 0 : 1, newSide = seat === o.you ? 0 : 1;
    if (previous?.zone === 'hand') hands[oldSide] = Math.max(0, hands[oldSide] - 1);
    if (previous?.zone === 'archives') archives[oldSide] = Math.max(0, archives[oldSide] - 1);
    if (zone === 'hand') hands[newSide]++;
    if (zone === 'archives') archives[newSide]++;
    if (previous?.zone === 'discard' && zone !== 'deck') drawSupply[oldSide] = Math.max(0, drawSupply[oldSide] - 1);
    if (zone === 'discard' || (zone === 'deck' && previous?.zone !== 'discard')) drawSupply[newSide]++;
    const moved = { ...card, controller: card.owner };
    const entry = (projectedEntries.get(card.id) ?? 0) + 1;
    projectedEntries.set(card.id, entry);
    publicCardEntries.set(moved, entry);
    projectedLocations.set(card.id, { card: moved, seat, zone });
    if (zone === 'deck' || previous?.zone === 'deck') {
      // This general leave-play path does not model all deck/leave responses.
      for (const changedSeat of [seat, ...(previous?.zone === 'deck' ? [previous.seat] : [])]) {
        uncertainFormulaZones.add(`${changedSeat}:deck`);
        uncertainCounts.add(`${changedSeat}:deck`);
      }
    }
    // Entry-specific modifiers are not a leave-play rules simulation.
    projectedFields.delete(card.id);
    changedFormulaFields.set(card.id, new Set(['power', 'armor', 'damage', 'powerCounters', 'ready', 'stunned']));
  }
  const uncertainDepartures = new Set<string>();
  const uncertainStoredAmber = new Map<string, number>();
  let unboundCapture = 0,
    possibleIncomeRefund = 0;
  const captured = (c: CardView) =>
    features.contextualEffects ? (predictedCaptured.get(c.id) ?? c.captured) : c.captured;
  const publicBoard = (i: number) =>
    [...player(i).battleline, ...player(i).artifacts].filter(
      (c) => !features.netResources || !predictedRemoved.has(c.id),
    );
  const fromSupply = (i: number) =>
    !!features.netResources && publicBoard(i).some((c) => c.spec.supplyInsteadOfPool);
  const cannotSteal = (i: number) =>
    publicBoard(i).some(
      (x) =>
        x.spec.cannotStealFrom || (features.netResources && x.spec.cannotStealWhileAmber && x.captured > 0),
    );
  function gain(i: number, n: number) {
    const captors = publicBoard(1 - i).filter((x) => x.spec.capturesIncomingAmber);
    if (
      captors.length > 0 ||
      (features.netResources &&
        o.lasting.some(
          (e) =>
            e.rule === 'poolIncomeBecomesTokens' &&
            e.turn === o.turn &&
            e.appliesTo === (i === 0 ? o.you : opp),
        ))
    ) {
      approximate = true;
      if (features.publicDestroyedRefunds && captors.length && n > 0) {
        markUnknown();
        // Competing incoming-income replacements are not simulated. Each public
        // captor is a possible recipient; this upper bound never enters pool.
        for (const c of captors) uncertainStoredAmber.set(c.id, (uncertainStoredAmber.get(c.id) ?? 0) + n);
      }
      return;
    }
    pool[i] += Math.max(0, n);
  }
  function steal(i: number, n: number) {
    if (uncertainPools.has(1 - i)) { markUnknown(); return; }
    if (cannotSteal(1 - i)) return;
    const take = Math.min(pool[1 - i], Math.max(0, n));
    if (!fromSupply(1 - i)) pool[1 - i] -= take;
    gain(i, take);
  }
  function addDraw(i: number, n: number) {
    if (!features.contextualEffects) {
      draws += (i === 0 ? 1 : -1) * Math.max(0, n);
      return;
    }
    // Identities of draws stay hidden. Count only cards publicly available to draw.
    if (uncertainSupplies.has(i)) { markUnknown(); return; }
    const take = Math.min(drawSupply[i], Math.max(0, n));
    drawSupply[i] -= take;
    hands[i] += take;
    if (take > 0) {
      uncertainFormulaZones.add(`${i === 0 ? o.you : opp}:hand`);
      uncertainFormulaZones.add(`${i === 0 ? o.you : opp}:deck`);
      uncertainCounts.add(`${i === 0 ? o.you : opp}:deck`);
      if (take > player(i).deckCount) uncertainFormulaZones.add(`${i === 0 ? o.you : opp}:discard`);
    }
    draws += (i === 0 ? 1 : -1) * take;
  }
  function snapshot() {
    return {
      score,
      ownCost,
      otherCost,
      approximate,
      projectedKey,
      skip,
      draws,
      chainGain,
      forecastUncertain,
      unresolvedEffects,
      pool: [...pool],
      hands: [...hands],
      archives: [...archives],
      deckChanges: [...deckChanges],
      scalarBindings: [...scalarBindings],
      projectedLocations: [...projectedLocations],
      projectedEntries: [...projectedEntries],
      uncertainLocations: [...uncertainLocations],
      uncertainFormulaZones: [...uncertainFormulaZones],
      changedFormulaFields: [...changedFormulaFields].map(([id, fields]) => [id, [...fields]] as const),
      uncertainPools: [...uncertainPools],
      uncertainCounts: [...uncertainCounts],
      uncertainSupplies: [...uncertainSupplies],
      drawSupply: [...drawSupply],
      createdTokens: [...createdTokens],
      tokenUtility,
      lastAmount,
      chosenHouse,
      unknownValues,
      publicControlChanged,
      removed: [...predictedRemoved],
      predictedWards: [...predictedWards],
      predictedCaptured: [...predictedCaptured],
      projectedFields: [...projectedFields],
      uncertainDepartures: [...uncertainDepartures],
      unboundCapture,
      possibleIncomeRefund,
      uncertainStoredAmber: [...uncertainStoredAmber],
      bindings: [...bindings.entries()],
      directDestructions: [...directDestructions].map(
        ([key, receipts]) => [key, receipts.map((r) => ({ ...r }))] as const,
      ),
      reasons: [...reasons],
    };
  }
  function restore(s: ReturnType<typeof snapshot>) {
    ({
      score,
      ownCost,
      otherCost,
      approximate,
      projectedKey,
      skip,
      draws,
      chainGain,
      forecastUncertain,
      unresolvedEffects,
      lastAmount,
      chosenHouse,
      unknownValues,
      publicControlChanged,
      tokenUtility,
      unboundCapture,
      possibleIncomeRefund,
    } = s);
    for (let i = 0; i < 2; i++) {
      pool[i] = s.pool[i];
      hands[i] = s.hands[i];
      archives[i] = s.archives[i];
      deckChanges[i] = s.deckChanges[i];
      drawSupply[i] = s.drawSupply[i];
      createdTokens[i] = s.createdTokens[i];
    }
    scalarBindings.clear();
    for (const [key, n] of s.scalarBindings) scalarBindings.set(key, n);
    projectedEntries.clear();
    for (const [id, entry] of s.projectedEntries) projectedEntries.set(id, entry);
    uncertainLocations.clear();
    for (const id of s.uncertainLocations) uncertainLocations.add(id);
    projectedLocations.clear();
    for (const [id, move] of s.projectedLocations) projectedLocations.set(id, move);
    uncertainFormulaZones.clear();
    for (const zone of s.uncertainFormulaZones) uncertainFormulaZones.add(zone);
    changedFormulaFields.clear();
    for (const [id, fields] of s.changedFormulaFields) changedFormulaFields.set(id, new Set(fields));
    uncertainSupplies.clear();
    for (const side of s.uncertainSupplies) uncertainSupplies.add(side);
    uncertainCounts.clear();
    for (const zone of s.uncertainCounts) uncertainCounts.add(zone);
    uncertainPools.clear();
    for (const side of s.uncertainPools) uncertainPools.add(side);
    predictedRemoved.clear();
    for (const id of s.removed) predictedRemoved.add(id);
    predictedWards.clear();
    for (const [id, warded] of s.predictedWards) predictedWards.set(id, warded);
    projectedFields.clear();
    for (const [id, fields] of s.projectedFields) projectedFields.set(id, fields);
    predictedCaptured.clear();
    for (const [id, n] of s.predictedCaptured) predictedCaptured.set(id, n);
    uncertainDepartures.clear();
    for (const id of s.uncertainDepartures) uncertainDepartures.add(id);
    uncertainStoredAmber.clear();
    for (const [id, n] of s.uncertainStoredAmber) uncertainStoredAmber.set(id, n);
    bindings.clear();
    for (const [key, cards] of s.bindings) bindings.set(key, cards);
    directDestructions.clear();
    for (const [key, receipts] of s.directDestructions)
      directDestructions.set(
        key,
        receipts.map((r) => ({ ...r })),
      );
    reasons.splice(0, reasons.length, ...s.reasons);
  }
  function taxOpensThirdKey(): boolean {
    return (
      !!features.contextualEffects &&
      foe.keys.length === 2 &&
      !foe.forgeBlocked &&
      foe.skipForgeTurn !== o.turn + 1 &&
      !foe.artifacts.some((c) => c.spec.skipForgeStep) &&
      foe.forgeAvailable < foe.keyCost &&
      otherCost < foe.keyCost &&
      pool[1] + Math.max(0, foe.forgeAvailable - foe.amber) >= otherCost &&
      !skip &&
      !projectedKey
    );
  }
  function incomeFundsThirdKey(): boolean {
    if (!features.publicThirdKeyFundingRisk || uncertainPools.has(1)) return false;
    const projectedAvailable = pool[1] + Math.max(0, foe.forgeAvailable - foe.amber);
    return (
      foe.keys.length === 2 &&
      !foe.forgeBlocked &&
      foe.skipForgeTurn !== o.turn + 1 &&
      !foe.artifacts.some((c) => c.spec.skipForgeStep) &&
      foe.forgeAvailable < foe.keyCost &&
      foe.forgeAvailable < otherCost &&
      pool[1] > initial[1] &&
      projectedAvailable >= otherCost &&
      !skip &&
      !(projectedKey && me.keys.length === 2)
    );
  }
  function possibleRefundFundsThirdKey(): boolean {
    if (
      !features.publicDestroyedRefunds ||
      !features.publicThirdKeyFundingRisk ||
      (!uncertainDepartures.size && possibleIncomeRefund <= 0)
    )
      return false;
    const possible = [...uncertainDepartures].reduce(
      (n, id) => {
        const c = find(id);
        return (
          n +
          (c && c.controller === o.you && !predictedRemoved.has(id)
            ? captured(c) + (uncertainStoredAmber.get(id) ?? 0)
            : 0)
        );
      },
      (uncertainDepartures.size ? unboundCapture : 0) + possibleIncomeRefund,
    );
    return (
      possible > 0 &&
      foe.keys.length === 2 &&
      !foe.forgeBlocked &&
      foe.skipForgeTurn !== o.turn + 1 &&
      !foe.artifacts.some((c) => c.spec.skipForgeStep) &&
      foe.forgeAvailable < foe.keyCost &&
      foe.forgeAvailable < otherCost &&
      pool[1] + possible + Math.max(0, foe.forgeAvailable - foe.amber) >= otherCost &&
      !skip &&
      !(projectedKey && me.keys.length === 2)
    );
  }
  function branchWorth() {
    const threat =
      foe.keys.length === 2 &&
      !foe.forgeBlocked &&
      foe.skipForgeTurn !== o.turn + 1 &&
      foe.forgeAvailable >= foe.keyCost;
    const denied =
      threat &&
      !forecastUncertain &&
      (skip || pool[1] + Math.max(0, foe.forgeAvailable - foe.amber) < otherCost);
    return (
      score +
      (pool[0] - initial[0]) * 3.5 -
      (pool[1] - initial[1]) * 3.2 +
      draws * 1.2 -
      chainGain * 1.3 +
      Number(denied) * 5000 +
      Number(projectedKey) * (me.keys.length === 2 ? 100000 : 40) -
      // The same existing terminal-risk cost is applied once when comparing
      // optional target sets, before the final action row is selected.
      Number(
        !!features.publicThirdKeyFundingRisk &&
          (incomeFundsThirdKey() || taxOpensThirdKey() || possibleRefundFundsThirdKey()),
      ) *
        160
    );
  }
  function bestBranch(branches: (() => void)[]) {
    const before = snapshot();
    let best: ReturnType<typeof snapshot> | undefined,
      bestValue = -Infinity;
    for (const run of branches) {
      if (effectBudget <= 0) {
        markUnknown();
        break;
      }
      restore(before);
      run();
      const n = branchWorth();
      if (n > bestValue) {
        bestValue = n;
        best = snapshot();
      }
    }
    restore(best ?? before);
    if (effectBudget <= 0) markUnknown();
  }
  function selections(candidates: CardView[], min: number, max: number, limit = 48): CardView[][] {
    const result: CardView[][] = [];
    const xs = [...candidates].sort((a, b) => a.id.localeCompare(b.id, 'en'));
    const walk = (start: number, chosen: CardView[]) => {
      if (result.length >= limit) return;
      if (chosen.length >= min) result.push(chosen);
      if (chosen.length === max) return;
      for (let i = start; i < xs.length && result.length < limit; i++) walk(i + 1, [...chosen, xs[i]]);
    };
    walk(0, []);
    if (result.length >= limit) approximate = true;
    return result;
  }
  /** A nested effect frame receives bindings and lastAmount by value. Its public
   * board/resource changes persist, but temporary scalar/card bindings do not leak. */
  function inLocalFrame(run: () => void) {
    const oldLastAmount = lastAmount, oldHouse = chosenHouse;
    const oldBindings = [...bindings], oldScalars = [...scalarBindings];
    run();
    lastAmount = oldLastAmount;
    chosenHouse = oldHouse;
    bindings.clear();
    for (const [key, cards] of oldBindings) bindings.set(key, cards);
    scalarBindings.clear();
    for (const [key, n] of oldScalars) scalarBindings.set(key, n);
  }
  function randomSide(side?: Side): 0 | 1 | undefined {
    if (side === undefined || side === 'self') return 0;
    if (side === 'opponent') return 1;
    if (side === 'active') return o.activePlayer === o.you ? 0 : 1;
    markUnknown();
    reasons.push('public-random: event/last-owner recipient has no public current-frame binding');
    return undefined;
  }
  function randomCandidates(side: 0 | 1, zone: 'hand' | 'archives' | 'discard' | 'deck'): PublicCardSelection {
    return selectPublicCards({ side: side === 0 ? 'friendly' : 'enemy', zone }, formulaContext());
  }
  function mayReactToRandomMove(candidates: readonly CardView[], operation: string) {
    if (o.publicStateCoverage?.effectsComplete === false) return true;
    if (operation === 'discard' && candidates.some((card) => card.spec.abilities?.scrap?.length ||
      card.gainedTextBoxes?.some((box) => box.abilities?.scrap?.length))) return true;
    const events = new Set(operation === 'discard' ? ['handDiscarded'] : []);
    return cards.some((card) => evaluatedInPlay(card.id) &&
      [card.spec, ...(card.gainedTextBoxes ?? [])].some((box) =>
        (box.reactions ?? []).some((reaction) => events.has(reaction.event))));
  }
  function randomMove(e: Extract<Effect, { kind: 'randomDiscard' | 'randomArchive' }>) {
    const side = randomSide(e.side);
    if (side === undefined) return;
    const zone = e.kind === 'randomArchive' ? 'hand' : e.zone ?? 'hand';
    const selection = randomCandidates(side, zone);
    if (selection.count.kind !== 'exact' || !Number.isSafeInteger(e.amount) || e.amount < 0) {
      markUnknown(); return;
    }
    const amount = Math.min(selection.count.value, e.amount);
    if (!amount) return;
    const seat = side === 0 ? o.you : opp;
    const operation = e.kind === 'randomArchive' ? 'archive' : e.operation ?? 'discard';
    if (zone === 'archives' && selection.cards.some((card) => card.owner !== seat)) {
      markUnknown(); reasons.push('public-random: foreign archive departure has an owner-return replacement'); return;
    }
    const complete = selection.identitiesComplete && selection.cards.length === selection.count.value;
    const shuffled = operation === 'shuffleDeck';
    const shuffleResponse = shuffled && (
      (o.prophecies ?? []).some((slot) => slot.active && !slot.revealed && slot.count > 0 &&
        slot.faces[slot.face] === 'expect-the-unexpected' && slot.owner !== o.activePlayer && seat === o.activePlayer) ||
      (zone === 'discard' && amount === selection.count.value && cards.some((card) =>
        evaluatedInPlay(card.id) && card.controller === seat && [card.spec, ...(card.gainedTextBoxes ?? [])]
          .some((box) => box.abilities?.discardPileShuffled?.length)))
    );
    // Legal hands contain their owner's cards. A hidden face shuffled from hand
    // has no discard/Scrap event; only the public shuffle response can intervene.
    const reactions = mayReactToRandomMove(selection.cards, operation) || shuffleResponse ||
      (!complete && !(shuffled && zone === 'hand'));
    // n/N inclusion probability is exact for a fixed, uniformly sampled population.
    // With reaction-dependent replacement it is only a direct-operation model.
    if (complete) {
      const utilities = selection.cards.map((card) => e.kind === 'randomArchive'
        ? (side === 0 ? 1 : -1) * (card.effective.house === o.activeHouse ? -0.5 : 1.5)
        : assessPublicOperation(o, card, operation, 0, { inPlay: false }).score);
      const expected = expectedPublicValue(utilities.map((value) => ({ value, probability: 1 / utilities.length })),
        reactions ? ['direct operation only; intervening reactions are not simulated'] : ['uniform visible population']);
      if (expected.kind === 'exact' || expected.kind === 'expected')
        score += amount * (expected.kind === 'exact' ? expected.value : expected.expected);
    } else {
      // Preserve the existing anonymous discard and archive utility, without
      // inventing the opponent's card types, icons or probability distribution.
      score += amount * (e.kind === 'randomArchive' ? (side === 0 ? 0.8 : -0.8) : side === 0 ? -1.5 : 1.2);
    }
    approximate = true;
    forecastUncertain = true;
    const changedZone = `${seat}:${zone}`;
    uncertainFormulaZones.add(changedZone);
    if (zone === 'hand') hands[side] = Math.max(0, hands[side] - amount);
    if (zone === 'archives') archives[side] = Math.max(0, archives[side] - amount);
    if (e.kind === 'randomArchive') {
      archives[side] += amount;
      uncertainFormulaZones.add(`${seat}:archives`);
    } else if (shuffled) {
      deckChanges[side] += amount;
      uncertainFormulaZones.add(`${seat}:deck`);
      if (zone !== 'discard') drawSupply[side] += amount;
    } else {
      uncertainFormulaZones.add(`${seat}:${operation === 'purge' ? 'purged' : 'discard'}`);
      if (operation === 'discard' && zone !== 'discard') drawSupply[side] += amount;
      if (operation === 'purge' && zone === 'discard') drawSupply[side] = Math.max(0, drawSupply[side] - amount);
    }
    if (reactions) {
      markUnknown();
      uncertainCounts.add(changedZone);
      if (e.kind === 'randomArchive') uncertainCounts.add(`${seat}:archives`);
      uncertainSupplies.add(side);
      for (const index of [0, 1]) {
        uncertainPools.add(index);
        const affectedSeat = index === 0 ? o.you : opp;
        if (shuffled) {
          uncertainCounts.add(`${affectedSeat}:deck`);
          uncertainFormulaZones.add(`${affectedSeat}:discard`);
          uncertainSupplies.add(index);
        }
        uncertainFormulaZones.add(`${affectedSeat}:battleline`);
        uncertainFormulaZones.add(`${affectedSeat}:artifacts`);
      }
    }
    reasons.push(`public-random: ${operation} ${amount} from ${side === 0 ? 'self' : 'opponent'} ${zone}; ` +
      (complete ? 'uniform public-card utility expectation' : 'anonymous count utility; hidden identities not inferred') +
      (reactions ? '; intervening reactions/disclosures remain unknown' : '; no visible move reaction'));
  }
  function averageRandomBranches(runs: (() => void)[]) {
    if (!runs.length || runs.length > 32 || effectBudget < runs.length) { markUnknown(); return; }
    if (runs.length === 1) { inLocalFrame(runs[0]); return; }
    const before = snapshot(), outcomes: ReturnType<typeof snapshot>[] = [];
    for (const run of runs) {
      restore(before);
      inLocalFrame(run);
      outcomes.push(snapshot());
      if (effectBudget <= 0) { restore(before); markUnknown(); return; }
    }
    restore(before);
    // Terminal/cost-changing random subtrees need a joint continuation model;
    // never certify a forge by averaging a payable and an unpayable branch.
    if (outcomes.some((s) => s.projectedKey !== before.projectedKey || s.skip !== before.skip ||
      s.ownCost !== before.ownCost || s.otherCost !== before.otherCost)) {
      markUnknown(); reasons.push('public-random: terminal or key-cost branch requires a full outcome continuation'); return;
    }
    const mean = (f: (s: ReturnType<typeof snapshot>) => number) => outcomes.reduce((n, s) => n + f(s), 0) / outcomes.length;
    score = mean((s) => s.score); draws = mean((s) => s.draws); chainGain = mean((s) => s.chainGain);
    tokenUtility = mean((s) => s.tokenUtility);
    for (const side of [0, 1]) {
      pool[side] = mean((s) => s.pool[side]);
      if (outcomes.some((s) => s.pool[side] !== outcomes[0].pool[side])) uncertainPools.add(side);
      hands[side] = mean((s) => s.hands[side]); archives[side] = mean((s) => s.archives[side]);
      const seat = side === 0 ? o.you : opp;
      if (outcomes.some((s) => s.hands[side] !== outcomes[0].hands[side])) uncertainCounts.add(`${seat}:hand`);
      if (outcomes.some((s) => s.archives[side] !== outcomes[0].archives[side])) uncertainCounts.add(`${seat}:archives`);
      deckChanges[side] = mean((s) => s.deckChanges[side]);
      if (outcomes.some((s) => s.deckChanges[side] !== outcomes[0].deckChanges[side])) uncertainCounts.add(`${seat}:deck`);
      drawSupply[side] = Math.min(...outcomes.map((s) => s.drawSupply[side]));
      if (outcomes.some((s) => s.drawSupply[side] !== outcomes[0].drawSupply[side])) uncertainSupplies.add(side);
      if (outcomes.every((s) => s.createdTokens[side] === outcomes[0].createdTokens[side]))
        createdTokens[side] = outcomes[0].createdTokens[side];
      else {
        uncertainFormulaZones.add(`${seat}:battleline`);
        uncertainCounts.add(`${seat}:battleline`);
      }
    }
    for (const s of outcomes) {
      for (const zone of s.uncertainFormulaZones) uncertainFormulaZones.add(zone);
      for (const zone of s.uncertainCounts) uncertainCounts.add(zone);
      for (const side of s.uncertainPools) uncertainPools.add(side);
      for (const side of s.uncertainSupplies) uncertainSupplies.add(side);
      for (const [id, fields] of s.changedFormulaFields) {
        const union = changedFormulaFields.get(id) ?? new Set<string>();
        for (const field of fields) union.add(field);
        changedFormulaFields.set(id, union);
      }
      for (const id of s.uncertainLocations) uncertainLocations.add(id);
      for (const reason of s.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    }
    // This also covers a card which had already moved before the random step.
    // Restoring its old location is not a proof that every outcome left it there.
    for (const id of new Set(outcomes.flatMap((s) => s.projectedLocations.map(([id]) => id)))) {
      const move = new Map(outcomes[0].projectedLocations).get(id);
      const entry = new Map(outcomes[0].projectedEntries).get(id) ?? 0;
      if (move && outcomes.every((s) => {
        const other = new Map(s.projectedLocations).get(id);
        return other?.zone === move.zone && other.seat === move.seat &&
          (new Map(s.projectedEntries).get(id) ?? 0) === entry;
      })) {
        projectedLocations.set(id, move); projectedEntries.set(id, entry);
      } else {
        const possibilities = outcomes.flatMap((s) => {
          const location = new Map(s.projectedLocations).get(id);
          return location ? [location] : [];
        });
        const reference = possibilities[0]?.card ?? find(id);
        const origin = reference ? projectedLocation(reference) : undefined;
        if (origin) uncertainFormulaZones.add(`${origin.seat}:${origin.zone}`);
        for (const location of possibilities) uncertainFormulaZones.add(`${location.seat}:${location.zone}`);
        projectedLocations.delete(id); uncertainLocations.add(id);
      }
    }
    for (const id of outcomes[0].removed) if (outcomes.every((s) => s.removed.includes(id))) predictedRemoved.add(id);
    for (const id of new Set(outcomes.flatMap((s) => s.predictedCaptured.map(([id]) => id)))) {
      const values = outcomes.map((s) => new Map(s.predictedCaptured).get(id) ?? predictedCaptured.get(id) ?? find(id)?.captured);
      if (values[0] !== undefined && values.every((n) => n === values[0])) predictedCaptured.set(id, values[0]);
      else { const fields = changedFormulaFields.get(id) ?? new Set<string>(); fields.add('captured'); changedFormulaFields.set(id, fields); }
    }
    for (const id of new Set(outcomes.flatMap((s) => s.predictedWards.map(([id]) => id)))) {
      const values = outcomes.map((s) => new Map(s.predictedWards).get(id) ?? predictedWards.get(id) ?? find(id)?.warded ?? false);
      if (values.every((ward) => ward === values[0])) predictedWards.set(id, values[0]);
      else { const fields = changedFormulaFields.get(id) ?? new Set<string>(); fields.add('warded'); changedFormulaFields.set(id, fields); }
    }
    for (const id of new Set(outcomes.flatMap((s) => s.projectedFields.map(([id]) => id)))) {
      for (const field of ['ready', 'stunned'] as const) {
        const values = outcomes.map((s) => new Map(s.projectedFields).get(id)?.[field] ?? projectedFields.get(id)?.[field] ?? find(id)?.[field]);
        if (values[0] !== undefined && values.every((value) => value === values[0]))
          projectedFields.set(id, { ...projectedFields.get(id), [field]: values[0] });
        else {
          const fields = changedFormulaFields.get(id) ?? new Set<string>(); fields.add(field); changedFormulaFields.set(id, fields);
          const known = { ...projectedFields.get(id) }; delete known[field]; projectedFields.set(id, known);
        }
      }
    }
    publicControlChanged ||= outcomes.some((s) => s.publicControlChanged);
    approximate = forecastUncertain = true;
    unresolvedEffects ||= outcomes.some((s) => s.unresolvedEffects);
    unknownValues = Math.max(...outcomes.map((s) => s.unknownValues));
    reasons.push(`public-random: mean utility of ${outcomes.length} equally likely public outcomes; caps and conditionals evaluated inside each outcome`);
  }
  function randomBinding(e: Extract<Effect, { kind: 'randomCard' | 'bindRandom' }>, depth: number) {
    const side = randomSide(e.side);
    if (side === undefined) return;
    const selection = randomCandidates(side, e.zone);
    if (selection.count.kind === 'exact' && selection.count.value === 0) {
      inLocalFrame(() => { bindings.set(e.bind, []); evalEffects(e.then, depth + 1); }); return;
    }
    if (!selection.identitiesComplete || selection.count.kind !== 'exact' ||
      selection.cards.length !== selection.count.value || selection.cards.length > 32) {
      // An identity-independent immediate discard still has its anonymous count value.
      const direct = e.then[0];
      if (e.zone !== 'deck' && direct?.kind === 'bound' && direct.key === e.bind && ['discard', 'purge'].includes(direct.operation))
        randomMove({ kind: 'randomDiscard', side: side === 0 ? 'self' : 'opponent', zone: e.zone,
          amount: 1, operation: direct.operation as 'discard' | 'purge' });
      markUnknown(); reasons.push('public-random: hidden or incomplete candidate identities; no fabricated probability over card properties'); return;
    }
    const discardsBinding = (value: unknown, level = 0): boolean => {
      if (!value || typeof value !== 'object' || level > 12) return false;
      if (Array.isArray(value)) return value.some((child) => discardsBinding(child, level + 1));
      const row = value as Record<string, unknown>;
      if (row.kind === 'bound' && row.key === e.bind && row.operation === 'discard') return true;
      return ['then', 'effects', 'otherwise', 'after', 'options'].some((key) => discardsBinding(row[key], level + 1));
    };
    if (discardsBinding(e.then) && mayReactToRandomMove(selection.cards, 'discard')) {
      const direct = e.then[0];
      if (e.zone !== 'deck' && direct?.kind === 'bound' && direct.key === e.bind && direct.operation === 'discard')
        randomMove({ kind: 'randomDiscard', side: side === 0 ? 'self' : 'opponent', zone: e.zone, amount: 1 });
      markUnknown(); reasons.push('public-random: discard responses can change the dependent continuation; no static branch expectation is certified'); return;
    }
    averageRandomBranches(selection.cards.map((card) => () => {
      bindings.set(e.bind, [card]);
      evalEffects(e.then, depth + 1);
    }));
  }
  function applyTargets(
    targets: CardView[],
    e: import('../contracts/observation.js').ApplySpec,
    depth: number,
  ) {
    targets = targets.map(projectedCard).filter((card) => {
      if (uncertainLocations.has(card.id)) { markUnknown(); return false; }
      return !features.contextualEffects || (publicCardEntries.get(card) ?? 0) === (projectedEntries.get(card.id) ?? 0);
    });
    const n = value(e.amount);
    const offBoard = features.contextualEffects ? targets.filter((card) => projectedLocations.has(card.id)) : [];
    const battleTargets = targets.filter((card) => !offBoard.includes(card));
    const group = features.publicDestroyedRefunds
      ? assessPublicOperationGroup(o, battleTargets, e.operation, n, {
          fullHeal: e.fullHeal,
          ignoreArmor: e.ignoreArmor,
          removed: predictedRemoved,
          warded: predictedWards,
          captured: predictedCaptured,
          additionalInPlay:
            a.kind === 'play' && physicalSource && ['creature', 'artifact', 'upgrade'].includes(physicalSource.spec.kind)
              ? [preparedContext().source ?? physicalSource]
              : [],
        })
      : undefined;
    const rows = group
      ? group.rows.map((r) => ({
          t: r.card,
          wasInPlay: evaluatedInPlay(r.card.id),
          result: r.result,
          operation: r.operation,
          direct: r.direct,
          destructionReceiptUnknown: group.expandedDestroyed || group.unresolved,
        }))
      : targets
          .filter((t) => !predictedRemoved.has(t.id) || projectedLocations.has(t.id))
          .map((t) => ({
            t,
            wasInPlay: evaluatedInPlay(t.id),
            result: assessPublicOperation(projectedLocations.has(t.id) ? formulaContext().observation : o, t, e.operation, n, {
              fullHeal: e.fullHeal,
              ignoreArmor: e.ignoreArmor,
              inPlay: evaluatedInPlay(t.id),
            }),
            operation: e.operation,
            direct: true,
            destructionReceiptUnknown: false,
          }));
    if (group && offBoard.length) {
      const view = formulaContext().observation;
      rows.push(...offBoard.map((t) => ({ t, wasInPlay: false,
        result: assessPublicOperation(view, t, e.operation, n, { fullHeal: e.fullHeal, ignoreArmor: e.ignoreArmor, inPlay: false }),
        operation: e.operation, direct: true, destructionReceiptUnknown: false,
      })));
    }
    const results = rows.filter((r) => r.direct);
    if (group) {
      for (const id of group.consumedWards) predictedWards.set(id, false);
      if (group.unresolved) {
        markUnknown();
        for (const id of group.possibleDepartureIds) uncertainDepartures.add(id);
        reasons.push(
          'public-destroyed: unmodeled leave/Destroyed consequences retain a bounded captured-amber risk, not a zero-cost certainty',
        );
      }
      if (group.expandedDestroyed)
        reasons.push(
          'public-destroyed: one public all-creature shuffle window; distinct departures and controller-relative refunds',
        );
    }
    const removedBefore = new Set(predictedRemoved);
    // A simultaneous group departs before released amber meets surviving replacement effects.
    for (const { t, result: r } of rows) if (r.removed) predictedRemoved.add(t.id);
    if (features.conditionalReapLocks)
      score += reapUnlockDelta(
        o,
        removedBefore,
        predictedRemoved,
        ['reap', 'use', 'fight', 'unstun'].includes(a.kind) ? source?.id : undefined,
      );
    for (const { t, result: r, operation, wasInPlay } of rows) {
      score += r.score;
      if (features.tokenEconomy && r.removed)
        score += (t.controller === o.you ? -1 : 1) * tokenEngineValue(o, t);
      approximate ||= r.approximate;
      if (r.approximate && wasInPlay) forecastUncertain = unresolvedEffects = true;
      gain(0, r.released[0]);
      gain(1, r.released[1]);
      if (features.publicDestroyedRefunds && r.removed && uncertainStoredAmber.has(t.id)) {
        markUnknown();
        if (t.controller === o.you) possibleIncomeRefund += uncertainStoredAmber.get(t.id)!;
        uncertainStoredAmber.delete(t.id);
        reasons.push(
          'public-destroyed: earlier replaced income has an unresolved stored-amber refund; excluded from estimated pool',
        );
      }
      if (features.contextualEffects) {
        if (r.removed || (r.affected && !evaluatedInPlay(t.id))) recordProjectedMove(t, operation);
        if (r.affected || r.approximate) noteChangedFields(t, operation, r);
      } else if (operation === 'returnHand' && r.affected && (!evaluatedInPlay(t.id) || r.removed)) {
        const owner = t.owner === o.you ? 0 : 1;
        hands[owner]++;
        if (player(owner).discard.some((c) => c.id === t.id))
          drawSupply[owner] = Math.max(0, drawSupply[owner] - 1);
      }
      if (evaluatedInPlay(t.id) && (e.operation === 'capture' || e.operation === 'captureOwn')) {
        const controller = t.controller === o.you ? 0 : 1,
          donor = e.operation === 'capture' ? 1 - controller : controller;
        if (uncertainPools.has(donor)) { markUnknown(); continue; }
        const moved = Math.min(pool[donor], Math.max(0, n));
        if (!fromSupply(donor)) pool[donor] -= moved;
        if (features.contextualEffects) predictedCaptured.set(t.id, captured(t) + moved);
      } else if (evaluatedInPlay(t.id) && e.operation === 'takeAmber') {
        const moved = Math.min(captured(t), Math.max(0, n));
        gain(0, moved);
        if (features.contextualEffects) predictedCaptured.set(t.id, captured(t) - moved);
        approximate = true; // Multiple changes to the same stored amount are not a public-state simulation.
      }
      if (features.contextualEffects && r.affected && ['ward', 'unward'].includes(operation))
        predictedWards.set(t.id, operation === 'ward');
      if (
        features.contextualEffects &&
        evaluatedInPlay(t.id) &&
        ['removeAmber', 'addAmber'].includes(e.operation)
      )
        predictedCaptured.set(t.id, Math.max(0, captured(t) + (e.operation === 'removeAmber' ? -n : n)));
      if (!features.contextualEffects && r.removed && operation === 'destroy') drawSupply[t.owner === o.you ? 0 : 1]++;

      if (r.removed && t.spec.opponentKeyTax) {
        if (t.controller === o.you) otherCost = Math.max(0, otherCost - t.spec.opponentKeyTax);
        else ownCost = Math.max(0, ownCost - t.spec.opponentKeyTax);
      }
    }
    if (group && rows.some((r) => r.result.removed) && unboundCapture > 0) {
      // A previous capture icon did not expose its target in this play probe.
      // Refund it only when every possible friendly recipient actually departs.
      const receivers = [
        ...me.battleline,
        ...(a.kind === 'play' && source?.spec.kind === 'creature' ? [source] : []),
      ];
      if (receivers.length && receivers.every((c) => predictedRemoved.has(c.id))) {
        gain(1, unboundCapture);
        unboundCapture = 0;
      } else {
        markUnknown();
        for (const c of receivers) uncertainDepartures.add(c.id);
      }
    }
    if (e.after) {
      if (results.some((r) => r.destructionReceiptUnknown)) {
        markUnknown();
        reasons.push(
          'public-destroyed: follow-up destruction receipts are unresolved; no payment or success guarantee',
        );
        return results;
      }
      const key = e.after.when;
      if (
        key === 'affected' &&
        ['damage', 'heal', 'capture', 'captureOwn', 'takeAmber', 'removeAmber', 'addAmber'].includes(
          e.operation,
        )
      ) {
        markUnknown();
        return results; // A boolean success is not an actual damage/heal/resource quantity.
      }
      const qualifying = results.filter(({ result: r }) =>
        key === 'destroyed' || key === 'destroyedPower'
          ? r.destroyed
          : key === 'affected'
            ? r.affected
            : key === 'notDestroyed'
              ? !r.destroyed && !r.approximate
              : false,
      );
      const count =
        key === 'destroyedPower'
          ? qualifying.reduce((sum, { t }) => sum + t.effective.power, 0)
          : qualifying.length;
      if (count >= (e.after.atLeast ?? 1)) {
        inLocalFrame(() => {
          lastAmount = count;
          if (e.after!.bindAffected)
            bindings.set(e.after!.bindAffected, qualifying.map((x) => x.t));
          evalEffects(e.after!.effects, depth + 1);
        });
      }
      if (key === 'healed') markUnknown();
    }
    return results;
  }
  type PublicLocator = { ability: string; path: readonly (string | number)[] };
  function publicEffectAt<K extends Effect['kind']>(
    locator: PublicLocator,
    kind: K,
  ): Extract<Effect, { kind: K }> | undefined {
    if (!source || source.id !== o.pending?.source || locator.path.length < 1 || locator.path.length > 48)
      return;
    const abilities = source.spec.abilities;
    if (!abilities || !Object.hasOwn(abilities, locator.ability)) return;
    let node: unknown = abilities[locator.ability as keyof typeof abilities];
    for (const part of locator.path) {
      if (
        node === null ||
        typeof node !== 'object' ||
        ['__proto__', 'prototype', 'constructor'].includes(String(part))
      )
        return;
      if (Array.isArray(node)) {
        if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part >= node.length)
          return;
      } else if (typeof part !== 'string') return;
      if (!Object.hasOwn(node, part)) return;
      node = (node as Record<string | number, unknown>)[part];
    }
    return node && typeof node === 'object' && 'kind' in node && node.kind === kind
      ? (node as Extract<Effect, { kind: K }>)
      : undefined;
  }
  function publicChoices(): Extract<Effect, { kind: 'choose' }>[] {
    const choices: Extract<Effect, { kind: 'choose' }>[] = [];
    const visit = (effects: readonly Effect[], depth = 0) => {
      if (depth > 6) return;
      for (const e of effects) {
        if (e.kind === 'choose') {
          choices.push(e);
          for (const option of e.options) visit(option.effects, depth + 1);
        } else if (e.kind === 'if') {
          visit(e.then, depth + 1);
          visit(e.otherwise ?? [], depth + 1);
        }
      }
    };
    visit(Object.values(source?.spec.abilities ?? {}).flat());
    return choices;
  }
  function sameOptionIds(e: Extract<Effect, { kind: 'choose' }>, keys: string[]) {
    return (
      keys.length > 0 &&
      new Set(keys).size === keys.length &&
      new Set(e.options.map((option) => option.key)).size === e.options.length &&
      e.options.length === keys.length &&
      e.options.every((option) => keys.includes(option.key))
    );
  }
  function currentPublicChoice(): Extract<Effect, { kind: 'choose' }> | undefined {
    if (!o.pending?.options || o.pending.source !== source?.id) return;
    const keys = o.pending.options.map((option) => option.id),
      intent = o.pending.intent;
    const offered = o.legalActions.flatMap((entry) =>
      entry.action.kind === 'choose' ? [entry.action.option] : [],
    );
    if (offered.length !== keys.length || offered.some((key) => !keys.includes(key))) return;
    if (intent?.kind === 'effect-choice') {
      const choice = publicEffectAt(intent, 'choose');
      return choice && sameOptionIds(choice, keys) ? choice : undefined;
    }
    if (intent) return;
    // Legacy external observations have no locator. Accept only one complete,
    // unmodified printed ability consisting of this choice and the exact offer.
    const roots = Object.values(source?.spec.abilities ?? {}).flat();
    if (
      roots.length !== 1 ||
      source?.copiedDefinition ||
      source?.copiedCharacteristics ||
      source?.gainedTextBoxes?.length
    )
      return;
    const choice = roots[0];
    return choice.kind === 'choose' && sameOptionIds(choice, keys) ? choice : undefined;
  }
  function availableHouses(e: Extract<Effect, { kind: 'chooseHouse' }>): House[] {
    if (e.from === 'ownDeck') return me.houses;
    if (e.from === 'opponentDeck') return foe.houses;
    // Every legacy house is selectable, as are both publicly declared deck
    // houses and represented later houses. Do not invent a disabled expansion.
    return [
      ...new Set([
        ...HOUSES,
        ...me.houses,
        ...foe.houses,
        ...o.players.flatMap((p) =>
          [...p.battleline, ...p.artifacts, ...p.upgrades].flatMap(
            (c) => c.effective.houses ?? [c.effective.house],
          ),
        ),
      ]),
    ];
  }
  function publicBonusPurge(e: Effect): e is Extract<Effect, { kind: 'chooseCards' }> {
    if (
      e.kind !== 'chooseCards' ||
      e.max !== 2 ||
      !e.optional ||
      e.then.length !== 2 ||
      e.filter.zone !== 'discard' ||
      !['friendly', 'enemy'].includes(e.filter.side ?? '') ||
      Object.keys(e.filter).some((key) => !['zone', 'side'].includes(key))
    )
      return false;
    const [purge, loss] = e.then;
    return (
      purge.kind === 'bound' &&
      purge.key === e.bind &&
      purge.operation === 'purge' &&
      loss.kind === 'loseOpponent' &&
      typeof loss.amount === 'object' &&
      'bindingBonusSum' in loss.amount &&
      loss.amount.bindingBonusSum === e.bind
    );
  }
  /** Adapter-certified Infurnace semantics still require the actual visible
   * creature and the unchanged public one-pile bonus-purge effect structure. */
  function nativeInfurnacePurge(owner: Seat): Extract<Effect, { kind: 'chooseCards' }> | undefined {
    if (
      !source ||
      source.id !== o.pending?.source ||
      source.definition !== 'infurnace' ||
      source.spec.id !== 'infurnace' ||
      source.controller !== o.you ||
      source.copiedDefinition ||
      source.copiedCharacteristics ||
      source.gainedTextBoxes?.length ||
      !o.players[o.you].battleline.some((card) => card.id === source.id)
    )
      return;
    const effects = source.spec.abilities?.play ?? [];
    if (effects.length !== 1 || effects[0].kind !== 'choose') return;
    const candidates = effects[0].options
      .flatMap((option) => option.effects)
      .filter(publicBonusPurge)
      .filter((effect) => effect.filter.side === (owner === o.you ? 'friendly' : 'enemy'));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  function publicControllerPayment(e: Effect): e is Extract<Effect, { kind: 'chooseCards' }> {
    if (
      e.kind !== 'chooseCards' ||
      !e.optional ||
      (e.min ?? 0) !== 0 ||
      typeof e.max !== 'number' ||
      e.max < 1 ||
      e.max > 3 ||
      !Number.isInteger(e.max) ||
      e.distinctNames ||
      e.distinctHouses ||
      e.minimumPower ||
      e.allOrNone ||
      !e.filter.notTaggedForDestruction ||
      e.then.length !== 1
    )
      return false;
    const destroy = e.then[0];
    if (destroy.kind !== 'destroyBoundAndThen' || destroy.key !== e.bind || destroy.then.length !== 2)
      return false;
    const paid = new Set<number>();
    for (const payment of destroy.then) {
      if (payment.kind !== 'gain' && !(payment.kind === 'resource' && payment.operation === 'gain'))
        return false;
      const side = payment.kind === 'resource' ? (payment.side ?? 'self') : 'self';
      if (side !== 'self' && side !== 'opponent') return false;
      const v = payment.amount;
      if (
        typeof v !== 'object' ||
        !('destroyedBinding' in v) ||
        v.destroyedBinding !== destroy.bind ||
        v.direct !== true ||
        (v.side ?? 'self') !== side ||
        Object.keys(v).some((key) => !['destroyedBinding', 'side', 'direct'].includes(key))
      )
        return false;
      paid.add(side === 'self' ? 0 : 1);
    }
    return paid.size === 2;
  }
  function pendingContinuation(): Extract<Effect, { kind: 'chooseCards' }> | undefined {
    if (!features.contextualEffects || !o.pending || o.pending.kind !== 'target' || !source) return;
    const intent = o.pending.intent;
    const locator =
      intent?.kind === 'effect-selection'
        ? intent
        : intent?.kind === 'target-operation'
          ? intent.selection
          : undefined;
    if (locator) {
      const effect = publicEffectAt(locator, 'chooseCards');
      const selected = o.pending.selected ?? [];
      const offered = [
        ...selected,
        ...o.legalActions.flatMap((entry) => (entry.action.kind === 'select' ? [entry.action.target] : [])),
      ];
      const operationMatches =
        intent?.kind !== 'target-operation' ||
        (effect?.then.length === 1 &&
          effect.then[0].kind === 'bound' &&
          effect.then[0].key === effect.bind &&
          effect.then[0].operation === intent.operation);
      if (
        !effect ||
        !operationMatches ||
        new Set(selected).size !== selected.length ||
        (o.pending.max !== undefined && selected.length > o.pending.max) ||
        offered.some((id) => !find(id))
      ) {
        markUnknown();
        return;
      }
      // The public locator certifies the current selection. The referee's actual
      // offered/selected IDs supply the binding; no private filter or frame is read.
      return effect;
    }
    if (
      features.publicDestructionPayments &&
      o.pending.min === 0 &&
      typeof o.pending.max === 'number' &&
      o.pending.max > 0 &&
      o.pending.max <= 3
    ) {
      const activeSources = [
        ...o.resolving,
        ...o.promptCards,
        ...o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]),
      ].filter((c) => c.id === o.pending?.source);
      const effects = Object.values(source.spec.abilities ?? {}).flat();
      const selected = o.pending.selected ?? [];
      const ids = new Set([
        ...selected,
        ...o.legalActions.flatMap((x) => (x.action.kind === 'select' ? [x.action.target] : [])),
      ]);
      // The actual pending source must have a current public physical face. A hand
      // or discard namesake, prose label, private frame, or guessed continuation is
      // insufficient. This narrow source has one unambiguous printed selection.
      if (
        source.id === o.pending.source &&
        activeSources.length > 0 &&
        activeSources.every((c) => c.definition === source.definition && c.spec.id === source.spec.id) &&
        !source.copiedDefinition &&
        !source.copiedCharacteristics &&
        !source.gainedTextBoxes?.length &&
        effects.length === 1 &&
        new Set(selected).size === selected.length &&
        selected.length <= o.pending.max &&
        (!o.pending.intent ||
          (o.pending.intent.kind === 'target-operation' && o.pending.intent.operation === 'destroy'))
      ) {
        const candidates = effects.filter(publicControllerPayment).filter((e) => {
          if (o.pending!.max! > (e.max as number)) return false;
          const offered = new Set(filtered(e.filter).map((c) => c.id));
          return [...ids].every((id) => offered.has(id));
        });
        if (candidates.length === 1) return candidates[0];
      }
    }
    if (
      features.publicAmberIconBindings &&
      o.pending.intent?.kind === 'infurnace-targets' &&
      o.pending.min === 0 &&
      o.pending.max === 2
    ) {
      const intent = o.pending.intent,
        selected = o.pending.selected ?? [];
      const continuation = nativeInfurnacePurge(intent.owner);
      const ids = new Set([
        ...selected,
        ...o.legalActions.flatMap((entry) => (entry.action.kind === 'select' ? [entry.action.target] : [])),
      ]);
      const pile = continuation ? new Set(filtered(continuation.filter).map((card) => card.id)) : undefined;
      // A capped native selector may expose only Done after two selections.
      // Validate the actual offered/selected prefix; never invent more targets.
      if (
        continuation &&
        pile &&
        (intent.owner === 0 || intent.owner === 1) &&
        selected.length <= 2 &&
        new Set(selected).size === selected.length &&
        [...ids].every((id) => pile.has(id))
      )
        return continuation;
    }
    if (
      features.publicAmberIconBindings &&
      !o.pending.intent &&
      o.pending.min === 0 &&
      (o.pending.max ?? 0) > 0 &&
      (o.pending.max ?? 0) <= 2
    ) {
      // Bind only the actual legal pile plus already selected public cards.
      // No private frame, hidden card, or combination of two piles is inferred.
      const ids = new Set([
        ...(o.pending.selected ?? []),
        ...o.legalActions.flatMap((x) => (x.action.kind === 'select' ? [x.action.target] : [])),
      ]);
      const candidates = publicChoices()
        .flatMap((e) => e.options.flatMap((x) => x.effects))
        .filter(publicBonusPurge)
        .filter((e) => {
          const pile = filtered(e.filter);
          return (
            o.pending?.max === Math.min(2, pile.length) &&
            pile.length === ids.size &&
            pile.every((c) => ids.has(c.id))
          );
        });
      if (candidates.length === 1) return candidates[0];
    }
    if (features.tokenEconomy && !o.pending.intent) {
      const ids = new Set([
        ...(o.pending.selected ?? []),
        ...o.legalActions.flatMap((x) => (x.action.kind === 'select' ? [x.action.target] : [])),
      ]);
      const candidates = Object.values(source.spec.abilities ?? {})
        .flat()
        .filter(
          (e): e is Extract<Effect, { kind: 'chooseCards' }> =>
            e.kind === 'chooseCards' &&
            e.optional === true &&
            e.then.length === 2 &&
            e.then[0].kind === 'reveal' &&
            e.then[0].filter.bound === e.bind &&
            e.then[1].kind === 'makeTokens' &&
            typeof e.then[1].count === 'object' &&
            'bindingCount' in e.then[1].count &&
            e.then[1].count.bindingCount === e.bind,
        )
        .filter((e) => {
          const pile = filtered(e.filter);
          return (
            ids.size === pile.length &&
            pile.every((c) => ids.has(c.id)) &&
            o.pending?.max === Math.min(typeof e.max === 'number' ? e.max : 1, pile.length)
          );
        });
      if (candidates.length === 1) return candidates[0];
    }
    const op = o.pending.intent?.kind === 'target-operation' ? o.pending.intent.operation : undefined;
    // A locator-free external fallback needs both a unique simple operation and
    // the complete public offer, including selections already made.
    const candidates = Object.values(source.spec.abilities ?? {})
      .flat()
      .filter(
        (e): e is Extract<Effect, { kind: 'chooseCards' }> =>
          e.kind === 'chooseCards' &&
          e.then.length === 1 &&
          ((!!op && e.then[0].kind === 'bound' && e.then[0].key === e.bind && e.then[0].operation === op) ||
            (!op &&
              !o.pending?.intent &&
              e.then[0].kind === 'takeControl' &&
              e.then[0].key === e.bind &&
              Object.values(source.spec.abilities ?? {}).flat().length === 1)),
      )
      .filter((e) => {
        const selected = o.pending?.selected ?? [];
        const ids = new Set([
          ...selected,
          ...o.legalActions.flatMap((entry) => (entry.action.kind === 'select' ? [entry.action.target] : [])),
        ]);
        const before = unknownValues,
          pile = filtered(e.filter);
        return (
          before === unknownValues &&
          new Set(selected).size === selected.length &&
          ids.size === pile.length &&
          pile.every((card) => ids.has(card.id)) &&
          typeof e.max === 'number' &&
          o.pending?.max === Math.min(e.max, pile.length) &&
          o.pending?.min === (e.optional ? 0 : Math.min(e.max, pile.length))
        );
      });
    if (candidates.length === 1) return candidates[0];
  }
  function containsTokenCreation(effects: readonly Effect[], depth = 0): boolean {
    if (depth > 8) return false;
    return effects.some((e) => {
      if (e.kind === 'makeToken' || e.kind === 'makeTokens') return true;
      if (e.kind === 'orderedChild') return containsTokenCreation([...e.effects, ...e.then], depth + 1);
      if (e.kind === 'if') return containsTokenCreation([...e.then, ...(e.otherwise ?? [])], depth + 1);
      if (e.kind === 'chooseCards' || e.kind === 'chooseHouse')
        return containsTokenCreation(e.then, depth + 1);
      if (e.kind === 'choose') return e.options.some((x) => containsTokenCreation(x.effects, depth + 1));
      if (e.kind === 'forEach' || e.kind === 'recur') return containsTokenCreation(e.effects, depth + 1);
      if (e.kind === 'target' || e.kind === 'all' || e.kind === 'self' || e.kind === 'bound')
        return !!e.after && containsTokenCreation(e.after.effects, depth + 1);
      return false;
    });
  }
  function evalEffects(effects: readonly Effect[], depth = 0): void {
    if (depth > 12) {
      markUnknown();
      return;
    }
    for (const e of effects) {
      if ('unmodeled' in e && e.unmodeled === true) markUnknown();
      if (features.contextualEffects && --effectBudget < 0) {
        markUnknown();
        return;
      }
      switch (e.kind) {
        case 'makeToken':
        case 'makeTokens': {
          if (!features.tokenEconomy) {
            approximate = true;
            if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
            break;
          }
          if (e.side && e.side !== 'self' && e.side !== 'opponent') {
            markUnknown();
            break;
          }
          const i = e.side === 'opponent' ? 1 : 0,
            seat = i === 0 ? o.you : opp;
          const ref = o.tokenReferences?.[seat];
          if (!ref?.tokenReference || (e.named && ref.name !== e.named)) break;
          const before = unknownValues,
            requested = e.kind === 'makeToken' ? 1 : value(e.count);
          if (before !== unknownValues) break;
          const count = Math.min(12, drawSupply[i], Math.max(0, Math.floor(requested)));
          if (requested > 12) markUnknown();
          drawSupply[i] -= count;
          createdTokens[i] += count;
          const utility = (i === 0 ? 1 : -1) * count * tokenUnitValue(o, seat);
          score += utility;
          tokenUtility += utility;
          // Entry reactions/placement can alter outcomes. A body is not certified instant amber.
          if (count) {
            uncertainCounts.add(`${seat}:deck`);
            approximate = true;
            forecastUncertain = unresolvedEffects = true;
            reasons.push('toc: public token reference and available supply; exhausted body minus cycle cost');
          }
          if (e.then?.length) markUnknown();
          break;
        }
        case 'orderedChild':
          if (features.contextualEffects || (features.tokenEconomy && containsTokenCreation([...e.effects, ...e.then]))) {
            inLocalFrame(() => evalEffects(e.effects, depth + 1));
            inLocalFrame(() => evalEffects(e.then, depth + 1));
          } else {
            approximate = true;
            if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
          }
          break;
        case 'reveal':
          // Disclosure and its reactions remain uncertain, while a known selection binding
          // can still feed an independently public token count in the following effect.
          approximate = true;
          if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
          break;
        case 'gain':
          gain(0, value(e.amount));
          break;
        case 'loseOpponent':
          if (uncertainPools.has(1)) { markUnknown(); break; }
          pool[1] = Math.max(0, pool[1] - value(e.amount));
          break;
        case 'capture': {
          if (uncertainPools.has(1)) { markUnknown(); break; }
          const amount = value(e.amount),
            moved = Math.min(pool[1], Math.max(0, amount));
          if (!fromSupply(1)) pool[1] = Math.max(0, pool[1] - amount);
          if (features.contextualEffects && physicalSource && evaluatedInPlay(physicalSource.id))
            predictedCaptured.set(physicalSource.id, captured(physicalSource) + moved);
          break;
        }
        case 'steal':
          steal(0, value(e.amount));
          if (e.thenDamage) score += 1;
          break;
        case 'draw':
          addDraw(0, value(e.amount));
          break;
        case 'chains':
          chainGain += Math.max(0, value(e.amount));
          break;
        case 'resource': {
          const i = idx(e.side);
          if (i === -1) { reasons.push('public-formula: resource recipient has no public event/last-owner binding'); break; }
          const n = Math.max(0, value(e.amount));
          switch (e.operation) {
            case 'gain':
              gain(i, n);
              break;
            case 'lose':
              if (uncertainPools.has(i)) { markUnknown(); break; }
              pool[i] = Math.max(0, pool[i] - n);
              break;
            case 'steal':
              steal(i, n);
              break;
            case 'draw':
              addDraw(i, n);
              break;
            case 'chains':
              chainGain += (i === 0 ? 1 : -1) * n;
              break;
          }
          break;
        }
        case 'if': {
          const knownBefore = unknownValues;
          const l = value(e.condition.left),
            r = value(e.condition.right),
            cmp = e.condition.comparison;
          if (features.contextualEffects && knownBefore !== unknownValues) {
            approximate = true;
            break;
          }
          if (
            cmp === 'gte'
              ? l >= r
              : cmp === 'gt'
                ? l > r
                : cmp === 'eq'
                  ? l === r
                  : cmp === 'lt'
                    ? l < r
                    : l <= r
          )
            inLocalFrame(() => evalEffects(e.then, depth + 1));
          else inLocalFrame(() => evalEffects(e.otherwise ?? [], depth + 1));
          break;
        }
        case 'forgeEffect': {
          if (uncertainPools.has(0)) { markUnknown(); break; }
          const cost = Math.max(0, e.fixedCost ?? ownCost + value(e.delta) - value(e.reduction));
          const storage = Math.max(0, me.forgeAvailable - me.amber);
          if (pool[0] + storage >= cost) {
            if (features.contextualEffects && forecastUncertain) {
              approximate = true;
              reasons.push('card-aware: unknown public side effects prevent certifying a forge');
              break;
            }
            projectedKey = true;
            score += me.keys.length === 2 ? 10000 : 40;
            pool[0] = Math.max(0, pool[0] - cost);
            reasons.push('affordable off-step forge');
          } else {
            score -= 14;
            reasons.push('off-step forge not funded');
          }
          break;
        }
        case 'skipForge':
          skip = true;
          break;
        case 'lasting':
          if (e.rule === 'keyCost') {
            const side = idx(e.side);
            if (side === -1) break;
            if (side === 1) otherCost += e.amount ?? 0;
            else ownCost += e.amount ?? 0;
          } else if (e.rule === 'reapGain' || e.rule === 'creaturePlayGain' || e.rule === 'cardPlayDraw') {
            if (features.contextualEffects) {
              const i = idx(e.side);
              if (i !== 0 || e.duration !== 'turn') {
                approximate = true;
                break;
              }
              if (a.kind === 'play' && source && publicPlayEndsStep(o, source, !!a.asUpgrade)) {
                approximate = true;
                reasons.push('card-aware: terminal play has no following ordinary this-turn actions');
                break;
              }
              const capacity = publicPlayCapacity(o);
              if (e.rule === 'reapGain') {
                const readyIds = new Set(
                  o.legalActions
                    .filter((x) => x.action.kind === 'reap' && x.action.card !== source?.id)
                    .flatMap((x) => ('card' in x.action ? [x.action.card] : [])),
                );
                score += Math.min(8, readyIds.size) * (e.amount ?? 1) * 2.5;
              } else {
                const plays = new Map<string, { terminal: boolean }>();
                for (const x of o.legalActions)
                  if (x.action.kind === 'play' && x.action.card !== source?.id) {
                    const card = find(x.action.copy ?? x.action.card);
                    if (
                      card &&
                      !card.spec.alpha &&
                      (e.rule !== 'creaturePlayGain' ||
                        (!x.action.asUpgrade && card.spec.kind === 'creature'))
                    ) {
                      const terminal = publicPlayEndsStep(o, card, !!x.action.asUpgrade);
                      const prior = plays.get(x.action.card);
                      plays.set(x.action.card, { terminal: prior ? prior.terminal && terminal : terminal });
                    }
                  }
                const ordinary = [...plays.values()].filter((x) => !x.terminal).length;
                const omega = Number([...plays.values()].some((x) => x.terminal));
                const count = Math.min(
                  ordinary + omega,
                  capacity.remaining === null
                    ? 12
                    : Math.max(0, capacity.remaining - Number(a.kind === 'play')),
                );
                if (e.rule === 'cardPlayDraw')
                  score += Math.min(drawSupply[0], count * (e.amount ?? 1)) * 1.2;
                else if (!publicBoard(1).some((x) => x.spec.capturesIncomingAmber))
                  score += count * (e.amount ?? 1) * 2.5;
              }
              approximate = true;
              reasons.push('card-aware: this-turn engine value uses distinct visible follow-up actions');
            } else score += 2;
          } else markUnknown();
          break;
        case 'target': {
          if (features.contextualEffects) {
            const targets = filtered(e.filter),
              max = Math.min(e.max ?? 1, targets.length);
            bestBranch(
              selections(targets, e.optional ? 0 : max, max).map((xs) => () => applyTargets(xs, e, depth)),
            );
            approximate = true;
            break;
          }
          const targets = filtered(e.filter),
            values = targets.map((x) => targetValue(x, e.operation, value(e.amount), e.fullHeal));
          score += Math.max(0, ...values);
          approximate = true;
          break;
        }
        case 'damageChoice':
          if (features.contextualEffects) {
            const targets = cards.filter((x) => evaluatedInPlay(x.id) && x.spec.kind === 'creature');
            bestBranch(
              targets.map(
                (t) => () =>
                  applyTargets(
                    [t],
                    {
                      operation: 'damage',
                      amount: e.amount,
                      after: e.rewardOnDestruction
                        ? { when: 'destroyed', effects: [{ kind: 'gain', amount: e.rewardOnDestruction }] }
                        : undefined,
                    },
                    depth,
                  ),
              ),
            );
            approximate = true;
            break;
          }
          score += Math.max(
            0,
            ...cards
              .filter((x) => inPlay(x.id) && x.spec.kind === 'creature')
              .map((x) => targetValue(x, 'damage', e.amount)),
          );
          approximate = true;
          break;
        case 'all':
          if (features.contextualEffects) {
            applyTargets(filtered(e.filter), e, depth);
            break;
          }
          score += filtered(e.filter).reduce(
            (n, x) => n + targetValue(x, e.operation, value(e.amount), e.fullHeal),
            0,
          );
          approximate = true;
          break;
        case 'self':
          if (features.contextualEffects) {
            if (physicalSource) applyTargets([preparedContext().source ?? physicalSource], e, depth);
            else approximate = true;
            break;
          }
          score += source ? targetValue(source, e.operation, value(e.amount), e.fullHeal) : 0;
          approximate = true;
          break;
        case 'healSelf':
          score += source ? Math.min(source.damage, value(e.amount)) * 0.2 : 0;
          break;
        case 'sacrificeSelf':
          if (features.contextualEffects) {
            if (physicalSource) applyTargets([preparedContext().source ?? physicalSource], { operation: 'destroy' }, depth);
            else approximate = true;
            break;
          }
          score -= source ? boardWorth(source) * 0.65 : 2;
          approximate = true;
          break;
        case 'archiveChoice':
          score += 0.8;
          approximate = true;
          break;
        case 'randomDiscard':
        case 'randomArchive':
          if (features.contextualEffects) randomMove(e);
          else if (e.kind === 'randomDiscard') {
            const side = e.side === 'opponent' ? 1 : 0;
            const zone = e.zone ?? 'hand';
            const count = zone === 'hand' ? hands[side] : zone === 'archives' ? player(side).archiveCount : player(side).discard.length;
            const n = Math.min(count, e.amount);
            score += n * (side === 0 ? -1.5 : 1.2);
            approximate = true;
          } else markUnknown();
          break;
        case 'randomCard':
        case 'bindRandom':
          if (features.contextualEffects) randomBinding(e, depth);
          else markUnknown();
          break;
        case 'randomDeckTop':
          if (features.contextualEffects) {
            applyTargets(filtered(e.filter), { operation: 'deckTop' }, depth);
            reasons.push('public-random: every matched creature returns to its owner deck; only top order is random');
          } else markUnknown();
          break;
        case 'storeAmber':
          score += pool[0] > 0 ? 0.2 : 0;
          break;
        case 'permission':
          score += 1.5;
          approximate = true;
          break;
        case 'useChoice':
          score += 2;
          approximate = true;
          break;
        case 'recur': {
          const n = Math.min(12, Math.max(0, value(e.count)));
          for (let i = 0; i < n; i++) inLocalFrame(() => evalEffects(e.effects, depth + 1));
          if (features.contextualEffects && n === 12) markUnknown();
          approximate = true;
          break;
        }
        case 'loseThen': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          const i = idx(e.side);
          if (i === -1) { reasons.push('public-formula: loss recipient has no public event/last-owner binding'); break; }
          if (uncertainPools.has(i)) { markUnknown(); break; }
          const n = e.amount === undefined ? pool[i] : Math.max(0, value(e.amount));
          inLocalFrame(() => {
            lastAmount = Math.min(pool[i], n);
            pool[i] -= lastAmount;
            evalEffects(e.then, depth + 1);
          });
          reasons.push('card-aware: actual lost amber feeds continuation');
          break;
        }
        case 'withValue': {
          if (!features.contextualEffects) { markUnknown(); break; }
          const before = unknownValues, n = value(e.value);
          if (before !== unknownValues || !Number.isSafeInteger(n)) { markUnknown(); break; }
          inLocalFrame(() => { scalarBindings.set(e.bind, n); evalEffects(e.then, depth + 1); });
          break;
        }
        case 'forEach': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          const before = unknownValues,
            n = Math.min(24, Math.max(0, value(e.count)));
          if (before !== unknownValues) break;
          if (!Number.isSafeInteger(n)) { markUnknown(); break; }
          for (let i = 0; i < n; i++) inLocalFrame(() => evalEffects(e.effects, depth + 1));
          if (n === 24) markUnknown();
          break;
        }
        case 'chooseCards': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          const before = unknownValues, candidates = filtered(e.filter),
            max = Math.min(candidates.length, Math.max(0, e.max === undefined ? 1 : value(e.max)));
          if (before !== unknownValues || !Number.isSafeInteger(max)) break;
          const min = Math.min(candidates.length, e.min ?? (e.optional ? 0 : max));
          if (e.distinctNames || e.distinctHouses || e.minimumPower || e.allOrNone || max > 3) {
            markUnknown();
            break;
          }
          bestBranch(
            selections(
              candidates,
              min,
              max,
              features.publicAmberIconBindings && publicBonusPurge(e) ? 4096 : 48,
            ).map((xs) => () => {
              inLocalFrame(() => { bindings.set(e.bind, xs); evalEffects(e.then, depth + 1); });
            }),
          );
          reasons.push('card-aware: bounded public target continuation, including its costs');
          break;
        }
        case 'destroyBoundAndThen': {
          if (!features.contextualEffects || !features.publicDestructionPayments) {
            approximate = true;
            if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
            break;
          }
          const selected = bindings.get(e.key);
          if (!selected || selected.length > 3 || publicControlChanged || unknownValues > 0) {
            markUnknown();
            break;
          }
          approximate ||= o.publicStateCoverage?.effectsComplete === false;
          const targets = [...new Map(selected.map((c) => [c.id, c])).values()];
          const outcomes = applyTargets(targets, { operation: 'destroy' }, depth);
          if (outcomes.some((r) => r.destructionReceiptUnknown)) {
            markUnknown();
            reasons.push('public-destroyed: dependent destruction payment remains unresolved');
            break;
          }
          const priorReceipts = directDestructions.get(e.bind);
          const priorBinding = bindings.get(e.bind);
          // An estimated original body death can fund a controller payment;
          // merely selected, warded, prevented or unmodeled deaths cannot.
          directDestructions.set(
            e.bind,
            outcomes
              .filter(({ result }) => result.destroyed)
              .map(({ t }) => ({ id: t.id, controller: t.controller })),
          );
          // Do not expose estimated receipts as an ordinary engine binding whose
          // tagged/surviving-entry semantics are not represented in Observation.
          bindings.delete(e.bind);
          try {
            evalEffects(e.then, depth + 1);
          } finally {
            if (priorReceipts) directDestructions.set(e.bind, priorReceipts);
            else directDestructions.delete(e.bind);
            if (priorBinding) bindings.set(e.bind, priorBinding);
            else bindings.delete(e.bind);
          }
          reasons.push(
            'public-destruction: direct public body outcomes pay their controller; selection and owner are not receipts',
          );
          break;
        }
        case 'takeControl': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          const targets = e.key ? bindings.get(e.key) : source ? [source] : undefined;
          const next = e.side === 'opponent' ? opp : o.you;
          if (targets) {
            for (const target of targets) score += contextualControlValue(o, target, next, !!e.whileSource);
            // A control attempt is not a simulated controller/entry update. Do not
            // attribute a later destruction in this chain to the stale visible controller.
            if (features.publicDestructionPayments && targets.some((target) => target.controller !== next))
              publicControlChanged = true;
          } else {
            approximate = true;
            if (features.publicDestructionPayments) markUnknown();
          }
          approximate = true;
          break;
        }
        case 'bound': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          const selected = bindings.get(e.key);
          if (selected) applyTargets(selected, e, depth);
          else {
            markUnknown();
          }
          break;
        }
        case 'choose': {
          if (!features.contextualEffects) {
            approximate = true;
            break;
          }
          // A hypothetical traversal already holds this exact public node.
          // Display labels and unrelated choices do not identify its branches.
          bestBranch(e.options.slice(0, 12).map((option) => () =>
            inLocalFrame(() => evalEffects(option.effects, depth + 1))));
          approximate = true;
          break;
        }
        case 'chooseHouse': {
          if (!features.contextualEffects || !features.publicHouseChoices) {
            approximate = true;
            if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
            break;
          }
          const beforeHouse = chosenHouse;
          bestBranch(
            availableHouses(e).map((house) => () => {
              inLocalFrame(() => { chosenHouse = house; evalEffects(e.then, depth + 1); });
            }),
          );
          chosenHouse = beforeHouse;
          reasons.push('card-aware v3: evaluate visible house-bound effects and friendly costs');
          break;
        }
        case 'finishAction':
          break;
        default:
          if (features.publicDestructionPayments) markUnknown();
          else {
            approximate = true;
            if (features.contextualEffects) forecastUncertain = unresolvedEffects = true;
          }
          break;
      }
    }
  }
  function targetValue(t: CardView, operation: string, n = 0, fullHeal = false): number {
    if (features.contextualEffects) {
      const r = assessPublicOperation(o, t, operation, n, { fullHeal, inPlay: evaluatedInPlay(t.id) });
      approximate ||= r.approximate;
      if (r.approximate && evaluatedInPlay(t.id)) forecastUncertain = unresolvedEffects = true;
      return r.score + r.released[0] * 3.5 - r.released[1] * 3.2;
    }
    const sign = t.controller === o.you ? -1 : 1;
    if (
      ['destroy', 'purge', 'returnHand', 'archive', 'foreignArchive', 'deckTop', 'shuffleDeck'].includes(
        operation,
      )
    )
      return sign * boardWorth(t) + (t.captured ? sign * t.captured * 2 : 0);
    if (operation === 'damage') {
      const dealt = Math.max(0, n - Math.max(0, t.effective.armor - t.armorUsed));
      return sign * (dealt >= t.effective.power - t.damage ? boardWorth(t) + t.captured * 2 : dealt * 0.3);
    }
    if (operation === 'heal') return -sign * Math.min(t.damage, fullHeal ? t.damage : n) * 0.5;
    if (operation === 'power') return -sign * n * 0.45;
    if (operation === 'ready') return -sign * (t.ready ? 0 : 2.4);
    if (operation === 'stun' || operation === 'stunExhaust' || operation === 'exhaust')
      return sign * (t.stunned ? 0 : 2.2);
    if (operation === 'capture')
      return -sign * Math.min(o.players[t.controller === 0 ? 1 : 0].amber, Math.max(0, n)) * 1.4;
    if (operation === 'captureOwn')
      return sign * Math.min(o.players[t.controller].amber, Math.max(0, n)) * 1.4;
    return 0;
  }
  function fightValue(attacker: CardView, defender: CardView): number {
    const ignore = attacker.spec.ignoreTauntElusive;
    if (
      [attacker, defender].some((x) => x.spec.absorbsNeighborDamage || x.spec.evasionSigil) ||
      o.players.flatMap((p) => p.artifacts).some((x) => x.spec.evasionSigil)
    ) {
      approximate = true;
      return -2;
    }
    let ar = Math.max(0, attacker.effective.armor - attacker.armorUsed),
      dr = Math.max(0, defender.effective.armor - defender.armorUsed);
    let ad = attacker.damage,
      dd = defender.damage;
    const beforeD = attacker.effective.assault,
      beforeA = defender.effective.hazardous;
    dd += Math.max(0, beforeD - dr);
    dr = Math.max(0, dr - beforeD);
    ad += Math.max(0, beforeA - ar);
    ar = Math.max(0, ar - beforeA);
    let kill = dd >= defender.effective.power,
      dead = ad >= attacker.effective.power;
    const elusive = defender.effective.keywords.includes('elusive') && !defender.elusiveUsed && !ignore;
    if (!kill && !dead && !elusive) {
      const out = attacker.spec.noCombatDamage ? 0 : Math.max(0, attacker.effective.power - dr);
      const inc =
        defender.spec.noCombatDamage || attacker.effective.keywords.includes('skirmish')
          ? 0
          : Math.max(0, defender.effective.power - ar);
      dd += out;
      ad += inc;
      kill = dd >= defender.effective.power || (out > 0 && attacker.effective.keywords.includes('poison'));
      dead = ad >= attacker.effective.power || (inc > 0 && defender.effective.keywords.includes('poison'));
    }
    const cloak = (x: CardView) =>
      o.players
        .flatMap((p) => p.upgrades)
        .some((c) => c.attachedTo === x.id && c.spec.upgrade?.destructionReplacement);
    if (kill && cloak(defender)) {
      kill = false;
      approximate = true;
    }
    if (dead && cloak(attacker)) {
      dead = false;
      approximate = true;
    }
    if (features.netResources) {
      // Conservative for unmodeled prevention: never promise a release through a surviving ward,
      // invulnerability or a conditional prevention whose truth this evaluator cannot establish.
      const protectedDeath = (x: CardView) =>
        !!(
          x.warded ||
          x.spec.invulnerable ||
          x.spec.invulnerableDuringFight ||
          x.spec.invulnerableCondition ||
          x.spec.cannotBeDamagedCondition
        );
      if (kill && protectedDeath(defender)) {
        kill = false;
        approximate = true;
      }
      if (dead && protectedDeath(attacker)) {
        dead = false;
        approximate = true;
      }
    }
    let defenderCredit = defender.captured,
      attackerCredit = attacker.captured;
    if (features.contextualEffects) {
      if (kill) {
        const r = assessPublicOperation(o, defender, 'destroy');
        if (r.approximate) markUnknown();
        kill = r.destroyed;
        defenderCredit = r.released[0];
      }
      if (dead) {
        const r = assessPublicOperation(o, attacker, 'destroy');
        if (r.approximate) markUnknown();
        dead = r.destroyed;
        attackerCredit = r.released[1];
      }
    }
    const removedBeforeFight = new Set(predictedRemoved);
    if (features.netResources) {
      if (kill) predictedRemoved.add(defender.id);
      if (dead) predictedRemoved.add(attacker.id);
    }
    if (kill) gain(0, defenderCredit);
    if (dead) gain(1, attackerCredit);
    const beforeFightTokens = tokenUtility;
    if (!dead && !elusive) evalEffects(attacker.spec.abilities?.afterFight ?? []);
    const followUpScore = features.tokenEconomy ? tokenUtility - beforeFightTokens : 0;
    if (
      attacker.spec.abilities?.beforeFight ||
      defender.spec.abilities?.destroyed ||
      attacker.spec.abilities?.destroyed ||
      o.players.some((p) => p.battleline.some((x) => x.spec.absorbsNeighborDamage))
    )
      markUnknown();
    return (
      (kill ? boardWorth(defender) : 0.15 * Math.max(0, dd - defender.damage)) -
      (dead ? boardWorth(attacker) : 0.15 * Math.max(0, ad - attacker.damage)) +
      (features.conditionalReapLocks
        ? reapUnlockDelta(o, removedBeforeFight, predictedRemoved, attacker.id)
        : 0) +
      followUpScore
    );
  }
  if (
    features.contextualEffects &&
    source &&
    ['reap', 'fight', 'use', 'unstun'].includes(a.kind) &&
    [source.spec, ...(source.gainedTextBoxes ?? [])].some((box) => box.destroyFriendlyBeforeUse)
  ) {
    markUnknown();
    reasons.push('card-aware: pre-use destruction may cancel the use or change its resource outcome');
  }
  switch (a.kind) {
    case 'raiseTide':
      // This action is the rules ability (including its Yes confirmation), not
      // a free tide-raising card effect. Seasonal policies replace this score
      // with their own public high-tide benefit/cost assessment.
      chainGain += o.tide?.rulesAbilityChains ?? 3;
      approximate = true;
      reasons.push('rules tide: account for the three-chain cost; no assumed high-tide benefit');
      break;
    case 'activateProphecy':
      score = c?.spec.abilities?.fate?.length ? 1.5 : -20;
      approximate = true;
      reasons.push('store an own visible Fate card; prophecy timing has no calibrated tactical valuation');
      break;
    case 'keep':
      score = 4;
      break;
    case 'mulligan':
      score = -4;
      break;
    case 'forge':
      score = me.keys.length === 2 ? 100000 : 1000;
      projectedKey = true;
      reasons.push('forge available key');
      break;
    case 'payForge':
      score = 500 + (a.source === 'pool' ? 0 : 1);
      break;
    case 'house':
      score = houseWork(o, a.house, features);
      reasons.push('count useful active-house work');
      if (mode === 'tactical-v1' && features.publicHouseDefenseOpportunities) {
        const opportunity = assessPublicHouseDefense(o, a.house, (probe, id) => {
          const projected = assessAlgorithmProjection(probe, id, 'tempo-v1', {
            ...features,
            physicalBonuses: true,
            multipleHouses: true,
            targetIntent: true,
            netResources: true,
            contextualEffects: true,
            publicIntegerThirds: true,
            publicHouseChoices: true,
            publicAmberIconBindings: true,
            publicHouseDefenseOpportunities: false,
          });
          return {
            opponentAmber: projected.assessment.estimatedAmber[1],
            opponentKeyCost: projected.opponentKeyCost,
            skipsOpponentForge: projected.skipsOpponentForge,
            unresolvedValues: projected.unresolvedValues,
          };
        });
        score += opportunity.score;
        approximate ||= opportunity.approximate;
        reasons.push(...opportunity.reasons);
      } else if (mode === 'tactical-v1' && foe.keys.length === 2 && foe.forgeAvailable >= foe.keyCost) {
        for (const x of [...(me.hand ?? []), ...me.battleline, ...me.artifacts])
          if (
            x.effective.house === a.house &&
            ((me.hand ?? []).some((h) => h.id === x.id) || (x.ready && !x.stunned))
          ) {
            const inHand = (me.hand ?? []).some((h) => h.id === x.id);
            const semantic = cardSemanticFeatures(x.spec, inHand ? 'play' : 'use', {
              observation: o, source: x, action: inHand ? { kind: 'play', card: x.id } : undefined,
              phase: inHand ? 'after-play' : 'current',
            });
            if (semantic.amberControl && !semantic.conditional) score += 25;
            approximate ||= semantic.unknown || semantic.conditional;
          }
      }
      break;
    case 'takeArchives':
      score =
        (me.archives ?? []).reduce(
          (n, x) => n + (x.owner === o.you ? (x.effective.house === o.activeHouse ? 2.5 : 0.1) : -1),
          0,
        ) - 0.2;
      break;
    case 'leaveArchives':
      score = 0;
      break;
    case 'play': {
      if (!source) {
        approximate = true;
        break;
      }
      if (features.physicalBonuses) {
        const blocked = [...foe.battleline, ...foe.artifacts].some((x) => x.spec.blocksOpponentBonusIcons);
        const icons =
          source.resolvedBonusIcons ??
          source.bonusIcons ??
          Array<import('../contracts/observation.js').BonusIcon>(source.spec.amber).fill('amber');
        if (!blocked)
          for (const icon of icons) {
            if (icon === 'amber') gain(0, 1);
            else if (icon === 'draw') {
              if (features.tokenEconomy) addDraw(0, 1);
              else draws++;
            } else if (icon === 'capture' && (me.battleline.length || source.spec.kind === 'creature')) {
              if (features.publicDestroyedRefunds) unboundCapture += Math.min(pool[1], 1);
              pool[1] = Math.max(0, pool[1] - (fromSupply(1) ? 0 : 1));
            }
            // Target-dependent and optional replacement outcomes stay approximate.
            else if (icon === 'damage' || icon === 'power' || icon === 'discard') approximate = true;
          }
        reasons.push('v2: full visible bonus sequence, including native amber exactly once');
      } else gain(0, source.spec.amber);
      pool[0] = Math.max(0, pool[0] - (source.spec.playAmberCost ?? 0));
      score =
        source.spec.kind === 'creature'
          ? boardWorth(source)
          : source.spec.kind === 'artifact'
            ? 2
            : source.spec.kind === 'upgrade'
              ? 1
              : 0.3;
      if (source.spec.skipForgeStep) score -= 20;
      if (source.spec.prohibitOwnCreatures) score -= 4;
      if (source.spec.destroyWithoutEnemy && !foe.battleline.length) score -= 8;
      if (source.spec.kind === 'upgrade' && a.target) {
        const target = find(a.target);
        if (
          target &&
          target.controller !== o.you &&
          source.spec.upgrade &&
          (source.spec.upgrade.power || source.spec.upgrade.armor)
        )
          score -= 12;
      }
      if (features.contextualEffects && source.spec.controlsHost && a.target && find(a.target))
        score += contextualControlValue(o, find(a.target)!, o.you, true);
      if (
        features.contextualEffects &&
        source.spec.kind === 'action' &&
        publicBoard(1).some((x) => x.spec.replacesEnemyActionPlayWithOwnLeftDestruction)
      ) {
        const left = foe.battleline[0];
        if (left) applyTargets([left], { operation: 'destroy' }, 0);
        reasons.push(
          'card-aware: visible opponent replaces this action Play; original effects do not execute',
        );
        approximate = true;
      } else evalEffects(ability(source, 'play'));
      if (source.spec.opponentKeyTax) otherCost += source.spec.opponentKeyTax;
      if (source.spec.kind === 'creature') {
        for (const x of [...me.battleline, ...me.artifacts])
          for (const r of x.spec.reactions ?? [])
            if (
              r.event === 'creaturePlayed' &&
              r.side === 'friendly' &&
              (!r.house || r.house === source.effective.house)
            )
              evalEffects(r.effects);
        for (const e of o.lasting)
          if (e.turn === o.turn && e.appliesTo === o.you && e.rule === 'creaturePlayGain') gain(0, e.amount);
      }
      if (features.contextualEffects)
        for (const e of o.lasting)
          if (e.turn === o.turn && e.appliesTo === o.you && e.rule === 'cardPlayDraw') addDraw(0, e.amount);
      if (source.spec.reactions?.length) score += 0.6;
      reasons.push('develop board / resolve visible play text');
      break;
    }
    case 'reap':
      // Dimension Door replaces the normal one-amber gain; its lasting amount is not its steal amount.
      if (o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'reapSteal'))
        steal(0, 1);
      else {
        const beforeBase = pool[0];
        gain(0, 1);
        if (
          features.netResources &&
          !fromSupply(0) &&
          publicBoard(1).some((x) => x.spec.capturesReapIncome)
        ) {
          // Capture exactly the new base-reap receipt once, never older pool amber; later
          // Reap: ability income has a different origin and is not removed here.
          pool[0] = beforeBase;
          approximate = true;
          reasons.push('v4: base reap income is captured, not available for forging');
        }
      }
      score = 0.4;
      evalEffects(ability(c, 'reap'));
      for (const u of me.upgrades.filter((u) => u.attachedTo === a.card))
        evalEffects(u.spec.upgrade?.abilities?.reap ?? []);
      for (const e of o.lasting)
        if (e.turn === o.turn && e.appliesTo === o.you) {
          if (e.rule === 'reapGain') gain(0, e.amount);
        }
      if (features.publicReapControlRisk) {
        const risk = assessPublicReapControl(o, actionId);
        score += risk.score;
        if (risk.approximate) {
          approximate = true;
          forecastUncertain = unresolvedEffects = true;
        }
        reasons.push(...risk.reasons);
      }
      reasons.push('reap for resources');
      break;
    case 'use': {
      // Exact engine indexing: printed Action, attached Actions, printed Omni, attached Omnis.
      const choices: { effects: Effect[]; source: string; trigger: string }[] = [];
      for (const trigger of ['action', 'omni'] as const) {
        const printed = c?.spec.abilities?.[trigger];
        if (printed) choices.push({ effects: printed, source: c!.spec.name, trigger });
        for (const u of o.players.flatMap((p) => p.upgrades).filter((u) => u.attachedTo === a.card)) {
          const granted = u.spec.upgrade?.abilities?.[trigger];
          if (granted) choices.push({ effects: granted, source: u.spec.name, trigger });
        }
      }
      const choice = item.useDescription
        ? {
            effects: item.useDescription.effects,
            trigger: item.useDescription.trigger,
            source: item.useDescription.label,
          }
        : choices[a.ability ?? 0];
      if (choice) {
        evalEffects(choice.effects);
        reasons.push(`ability: ${choice.trigger} from ${choice.source}`);
      } else approximate = true;
      score += 0.2;
      reasons.push('activate printed ability instead of automatic reap');
      break;
    }
    case 'unstun':
      score = 1.6;
      reasons.push('restore a future usable creature');
      break;
    case 'fight':
      if (c && find(a.target)) score = fightValue(c, find(a.target)!);
      else approximate = true;
      reasons.push('estimate combat rather than damage-as-goal');
      break;
    case 'returnDiscard':
      score = 2;
      reasons.push('optional own-turn discard recovery; no play or use cost');
      break;
    case 'discard': {
      const semantic = cardSemanticFeatures(c?.spec, 'any', { observation: o, source: c });
      const useful =
        c?.spec.kind === 'creature' ||
        c?.spec.amber ||
        semantic.forge ||
        semantic.gain ||
        semantic.amberControl ||
        semantic.draw ||
        semantic.archive ||
        semantic.recover ||
        semantic.boardControl ||
        semantic.heal ||
        semantic.readyUse ||
        semantic.unknown;
      approximate ||= semantic.unknown;
      score = c?.spec.returnFromDiscardCondition && me.discard.length >= 9 ? -20 : useful ? -0.1 : 0.15;
      reasons.push('cycle low-immediate-value card; no bonus icons on discard');
      break;
    }
    case 'select': {
      const target = find(a.target);
      if (!target) {
        approximate = true;
        score = 0;
        break;
      }
      const continuation = pendingContinuation();
      if (continuation) {
        const selected = [...new Set([...(o.pending?.selected ?? []), a.target])].flatMap((id) =>
          find(id) ? [find(id)!] : [],
        );
        bindings.set(continuation.bind, selected);
        evalEffects(continuation.then);
        reasons.push('card-aware: public selected target plus its unique advertised continuation');
        break;
      }
      if (o.pending?.intent?.kind === 'target-operation') {
        const op = o.pending.intent.operation;
        if (op === 'discard') {
          const worth =
            target.spec.amber * 3 +
            (target.spec.kind === 'creature' ? 2 : 0) +
            (target.effective.house === o.activeHouse ? 1.5 : 0);
          score = target.controller === o.you ? -worth : worth;
        } else if (features.contextualEffects) {
          applyTargets([target], { operation: op, amount: o.pending.amount }, 0);
          if (op === 'returnHand' && !forecastUncertain && knownRecoveredForge(o, target, pool[0])) {
            score += 7000;
            reasons.push('card-aware: recover a publicly payable next-play third-key route');
          }
        } else if (op === 'ward')
          score = (target.controller === o.you ? 1 : -1) * (target.warded ? 0 : boardWorth(target));
        else score = targetValue(target, op, o.pending.amount);
        reasons.push('v2: use explicit public target operation instead of card-summary guess');
        approximate = true;
        break;
      }
      if (o.pending?.kind === 'archive') {
        score = target.effective.house === o.activeHouse ? -0.5 : 1.5;
        break;
      }
      if (o.pending?.kind === 'damage') {
        score = targetValue(target, 'damage', o.pending.amount);
        break;
      }
      // A card's complete rule tree can contain several unrelated target effects.
      // Without the current public intent, neither prose nor a whole-card feature
      // flag identifies this continuation. Keep the actual legal choice neutral.
      score = 0;
      approximate = true;
      reasons.push('current target operation is not publicly identified');
      break;
    }
    case 'choose': {
      if (
        features.contextualEffects &&
        features.publicAmberIconBindings &&
        o.pending?.kind === 'option' &&
        o.pending.intent?.kind === 'infurnace-pile'
      ) {
        const options = o.pending.intent.options,
          chosen = options.find((option) => option.id === a.option);
        const offered = o.legalActions.filter((entry) => entry.action.kind === 'choose');
        const contractMatches =
          options.length > 0 &&
          options.length <= 2 &&
          new Set(options.map((option) => option.id)).size === options.length &&
          new Set(options.map((option) => option.owner)).size === options.length &&
          options.every(
            (option) =>
              (option.owner === 0 || option.owner === 1) &&
              offered.some((entry) => entry.action.kind === 'choose' && entry.action.option === option.id),
          ) &&
          offered.length === options.length;
        const continuation = chosen && contractMatches ? nativeInfurnacePurge(chosen.owner) : undefined;
        if (continuation) {
          evalEffects([continuation]);
          reasons.push('card-aware v3: evaluate the exact native Infurnace public discard-pile option');
          break;
        }
      }
      if (features.contextualEffects && o.pending?.kind === 'option' && o.pending.options) {
        const intent = o.pending.intent;
        if (
          features.publicHouseChoices &&
          (intent?.kind === 'house-choice' || intent?.kind === 'house-restriction')
        ) {
          const selected = intent.options.find((option) => option.id === a.option);
          const contractMatches =
            new Set(intent.options.map((option) => option.id)).size === intent.options.length &&
            intent.options.length === o.pending.options.length &&
            intent.options.every((option) =>
              o.pending!.options!.some(
                (offered) => offered.id === option.id && offered.house === option.house,
              ),
            );
          const choice = intent.selection ? publicEffectAt(intent.selection, 'chooseHouse') : undefined;
          if (selected && contractMatches && choice && availableHouses(choice).includes(selected.house)) {
            chosenHouse = selected.house;
            evalEffects(choice.then);
            reasons.push('card-aware: evaluate the current public house continuation');
            break;
          }
          // Typed options identify real houses without proving which source
          // continuation is active. Keep that uncertainty instead of guessing.
          markUnknown();
        }
        const choice = currentPublicChoice();
        const option = choice?.options.find((option) => option.key === a.option);
        if (option) {
          evalEffects(option.effects);
          reasons.push('card-aware: evaluate the structurally identified public option');
          break;
        }
      }
      score = 0;
      approximate = true;
      break;
    }
    case 'order':
      score = -a.index * 0.001;
      approximate = true;
      break;
    case 'done': {
      const continuation = pendingContinuation();
      if (continuation) {
        bindings.set(
          continuation.bind,
          (o.pending?.selected ?? []).flatMap((id) => (find(id) ? [find(id)!] : [])),
        );
        evalEffects(continuation.then);
      } else score = -0.3;
      break;
    }
    case 'endTurn':
      score = 0;
      reasons.push('end remains legal; do not force every card');
      break;
  }
  const ownDelta = pool[0] - initial[0],
    otherDelta = pool[1] - initial[1];
  score += ownDelta * 3.5 - otherDelta * 3.2 + draws * 1.2 - chainGain * 1.3;
  const forgePrevented = foe.skipForgeTurn === o.turn + 1 || foe.artifacts.some((c) => c.spec.skipForgeStep);
  const threat = foe.keys.length === 2 && !forgePrevented && foe.forgeAvailable >= foe.keyCost;
  const deniesKey =
    threat &&
    (!(features.contextualEffects || features.publicReapControlRisk) || !forecastUncertain) &&
    (skip || pool[1] + Math.max(0, foe.forgeAvailable - foe.amber) < otherCost);
  const fundedThirdKey = incomeFundsThirdKey(),
    possibleRefund = possibleRefundFundsThirdKey();
  if (taxOpensThirdKey() || fundedThirdKey || possibleRefund) {
    score -= 160;
    if (fundedThirdKey) {
      approximate = true;
      reasons.push(
        'public-third-key: this public income estimate funds an initially unfunded enemy third key; bounded risk, not a guaranteed outcome',
      );
    } else if (possibleRefund) {
      approximate = true;
      reasons.push(
        'public-third-key: an unresolved Destroyed/leave window can return enough publicly captured amber; bounded risk only, not an estimated or guaranteed refund',
      );
    } else reasons.push('card-aware: do not remove the tax that alone prevents an opponent third key');
  }
  if (mode === 'tactical-v1') {
    if (deniesKey) {
      score += 5000;
      reasons.push('prevent next third key (visible resource estimate)');
    }
    if (skip && !threat) score += foe.forgeAvailable >= foe.keyCost ? 7 : -1;
    if (
      me.keys.length === 2 &&
      !projectedKey &&
      ownDelta > 0 &&
      (!(features.contextualEffects || features.publicReapControlRisk) || !forecastUncertain)
    ) {
      // Resource-first sequencing: only a presently legal off-step forge action, not an assumed draw.
      const forges = o.legalActions
        .filter((x) => x.id !== actionId && x.action.kind === 'play')
        .flatMap((x) => {
          const xcard = find((x.action as Extract<Action, { kind: 'play' }>).card);
          return xcard && ['key-charge', 'chota-hazri'].includes(xcard.definition) ? [xcard] : [];
        });
      if (
        forges.length &&
        me.amber < me.keyCost + 1 &&
        (!features.contextualEffects ||
          !publicBoard(1).some((x) => x.spec.replacesEnemyActionPlayWithOwnLeftDestruction))
      ) {
        score += pool[0] + Math.max(0, me.forgeAvailable - me.amber) >= me.keyCost + 1 ? 7000 : 12;
        reasons.push('fund visible off-step third key before committing');
      }
    }
  }
  if (projectedKey && me.keys.length === 2) score = Math.max(score, 100000);
  if (!Number.isFinite(score)) throw new Error('Nonfinite algorithm score');
  return {
    assessment: { actionId, score, reasons, estimatedAmber: pool, projectedKey, deniesKey, approximate },
    opponentKeyCost: otherCost,
    skipsOpponentForge: skip,
    unresolvedValues: unknownValues > 0 || unresolvedEffects,
  };
}
export function rankAlgorithm(o: Observation, name: AlgorithmName = 'tactical-v1'): ActionAssessment[] {
  if (!o.legalActions.length) throw new Error('No legal decision');
  return o.legalActions
    .map((x) => assessAlgorithm(o, x.id, name))
    .sort((a, b) => b.score - a.score || a.actionId.localeCompare(b.actionId, 'en'));
}
export const tempoPolicy: Policy = (o) => rankAlgorithm(o, 'tempo-v1')[0].actionId;
export const tacticalPolicy: Policy = (o) => rankAlgorithm(o, 'tactical-v1')[0].actionId;
