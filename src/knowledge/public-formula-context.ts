import { ALL_DEFINITIONS } from './catalog.js';
import type {
  CardView,
  Filter,
  House,
  Observation,
  Seat,
  Value,
} from '../contracts/observation.js';
import type {
  PublicCardSelection,
  PublicFormulaContext,
  PublicValueResult,
} from './public-formula.js';

export interface FormulaView {
  observation?: Observation;
  actor?: Seat;
  source?: CardView;
  cards: Map<string, CardView>;
  uncertain: Map<string, Set<string>>;
  played: boolean;
  used: boolean;
  entryCondition?: import('../contracts/observation.js').Condition;
}
const opposite = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const zones = [
  'hand',
  'archives',
  'battleline',
  'artifacts',
  'upgrades',
  'discard',
  'purged',
] as const;
const inPlay = (o: Observation, id: string) =>
  o.players.some((p) => [...p.battleline, ...p.artifacts, ...p.upgrades].some((c) => c.id === id));
const houses = (c: CardView): readonly House[] => c.effective.houses ?? [c.effective.house];
const traits = (c: CardView): readonly string[] => c.spec.traits ?? [];
function collect(o: Observation): Map<string, CardView> {
  const cards = new Map<string, CardView>();
  for (const [seat, p] of o.players.entries()) {
    for (const zone of zones) {
      if ((zone === 'hand' || zone === 'archives') && seat !== o.you) continue;
      for (const c of p[zone] ?? []) cards.set(c.id, c);
    }
    for (const c of p.faceupArchives ?? []) cards.set(c.id, c);
    if (p.revealedTop) cards.set(p.revealedTop.id, p.revealedTop);
  }
  for (const c of [
    ...o.resolving,
    ...o.promptCards,
    ...o.underCards.flatMap((row) => row.cards ?? []),
    ...o.spanglerCards.flatMap((row) => row.cards),
    ...(o.prophecies ?? []).flatMap((row) => row.cards ?? []),
  ])
    cards.set(c.id, c);
  return cards;
}

/** Reconstruct the copied printed definition from public identity and public copy
 * fields. No continuous board bonus is copied as a printed characteristic. */
function copiedEntrySpec(card: CardView): CardView['spec'] | undefined {
  let spec =
    ALL_DEFINITIONS[card.copiedDefinition ?? card.tokenCreature?.reference ?? card.definition];
  if (!spec)
    return card.copiedCharacteristics || card.copiedAnimation || card.temporaryAnimation
      ? undefined
      : card.spec;
  if (card.form === 'animated' || card.copiedForm === 'animated')
    spec = {
      ...spec,
      kind: 'creature',
      power: spec.animation?.power ?? 5,
      armor: spec.animation?.armor ?? spec.armor,
      keywords: [...new Set([...(spec.keywords ?? []), ...(spec.animation?.keywords ?? [])])],
      anyHouseUse: spec.animation?.anyHouseUse ?? true,
    };
  if (card.animatedArtifact)
    spec = {
      ...spec,
      kind: 'creature',
      power: 4,
      keywords: [...new Set([...(spec.keywords ?? []), 'versatile' as const])],
      anyHouseUse: true,
    };
  if (card.temporaryAnimation || card.copiedAnimation)
    spec = {
      ...spec,
      kind: 'creature',
      power: (card.temporaryAnimation ?? card.copiedAnimation)!.power,
    };
  if (card.copiedCharacteristics) {
    const x = card.copiedCharacteristics;
    spec = {
      ...spec,
      power: x.power,
      armor: spec.armor + x.armor,
      traits: [...new Set([...(spec.traits ?? []), ...x.traits])],
      keywords: [...new Set([...(spec.keywords ?? []), ...x.keywords])],
      assault: (spec.assault ?? 0) + x.assault,
      hazardous: (spec.hazardous ?? 0) + x.hazardous,
      splashAttack: (spec.splashAttack ?? 0) + (x.splashAttack ?? 0),
      alpha: spec.alpha || x.alpha,
      omega: spec.omega || x.omega,
      deploy: spec.deploy || x.deploy,
    };
  }
  return spec;
}

/** A small declared zone/entry projection. It does not resolve play abilities,
 * reactions, private frames, continuous effects, or a future shuffle. */
export function makeFormulaView(context?: PublicFormulaContext): FormulaView {
  if (!context)
    return {
      cards: new Map(),
      uncertain: new Map(),
      played: false,
      used: false,
    };
  const original = context.observation;
  const actor = context.actor ?? original.you;
  const players = original.players.map((p, seat) => ({
    ...p,
    hand: seat === original.you ? p.hand?.slice() : undefined,
    archives: seat === original.you ? p.archives?.slice() : undefined,
    battleline: p.battleline.slice(),
    artifacts: p.artifacts.slice(),
    upgrades: p.upgrades.slice(),
    discard: p.discard.slice(),
    purged: p.purged.slice(),
    faceupArchives: p.faceupArchives?.slice(),
  })) as Observation['players'];
  const o: Observation = {
    ...original,
    players,
    resolving: original.resolving.slice(),
  };
  let cards = collect(o);
  const action = context.action;
  const physicalId = action && 'card' in action ? action.card : context.source?.id;
  let source = physicalId
    ? (cards.get(physicalId) ?? (context.source?.id === physicalId ? context.source : undefined))
    : context.source;
  const view: FormulaView = {
    observation: o,
    actor,
    source,
    cards,
    uncertain: new Map(
      [...(context.projection?.uncertainCardFields ?? [])].map(([id, fields]) => [
        id,
        new Set(fields),
      ]),
    ),
    played: false,
    used: false,
  };
  const mark = (id: string, ...fields: string[]) =>
    view.uncertain.set(id, new Set([...(view.uncertain.get(id) ?? []), ...fields]));
  if (
    context.phase === 'after-play' &&
    source &&
    cards.has(source.id) &&
    (!action || action.kind === 'play') &&
    !inPlay(o, source.id) &&
    !o.resolving.some((c) => c.id === source!.id)
  ) {
    view.played = true;
    let copyUnknown = false;
    if (action?.kind === 'play' && action.copy) {
      const donor = cards.get(action.copy);
      const spec = donor && copiedEntrySpec(donor);
      if (
        !spec ||
        (donor?.tokenCreature &&
          original.lasting.some((effect) => effect.rule === 'copyFriendlyTokens'))
      )
        copyUnknown = true;
      else {
        const copiedHouse = source.spec.mimicCreature?.house ?? spec.house;
        const copiedBonusHouses = donor!.copiedBonusHouses ?? donor!.bonusHouses ?? [];
        source = {
          ...source,
          spec: { ...spec, house: copiedHouse },
          copiedHouse,
          copiedDefinition: spec.id,
          printedHouse: copiedHouse,
          bonusHouses: copiedBonusHouses,
          copiedBonusHouses,
          copiedBonusIcons:
            donor!.resolvedBonusIcons ?? donor!.copiedBonusIcons ?? donor!.bonusIcons,
          resolvedBonusIcons:
            donor!.resolvedBonusIcons ?? donor!.copiedBonusIcons ?? donor!.bonusIcons,
          effective: {
            ...source.effective,
            house: copiedHouse,
            houses: [copiedHouse, ...copiedBonusHouses],
            keywords: spec.keywords ?? [],
            assault: spec.assault ?? 0,
            hazardous: spec.hazardous ?? 0,
          },
        };
      }
    }
    const ids = new Set([
      source.id,
      ...(action?.kind === 'play' && action.otherHalf ? [action.otherHalf] : []),
    ]);
    for (const p of players) {
      const handRemoved = p.hand?.filter((c) => ids.has(c.id)).length ?? 0;
      p.handCount = Math.max(0, p.handCount - handRemoved);
      const archiveIds = new Set(
        [...(p.archives ?? []), ...(p.faceupArchives ?? [])]
          .filter((c) => ids.has(c.id))
          .map((c) => c.id),
      );
      p.archiveCount = Math.max(0, p.archiveCount - archiveIds.size);
      p.faceupArchives = p.faceupArchives?.filter((c) => !ids.has(c.id));
      if (p.revealedTop && ids.has(p.revealedTop.id)) {
        p.revealedTop = undefined;
        p.deckCount = Math.max(0, p.deckCount - 1);
      }
      for (const zone of zones) {
        const list = p[zone];
        if (list)
          (p as unknown as Record<string, unknown>)[zone] = list.filter((c) => !ids.has(c.id));
      }
    }
    o.underCards = o.underCards.map((row) => ({
      ...row,
      count: Math.max(0, row.count - (row.cards?.filter((c) => ids.has(c.id)).length ?? 0)),
      cards: row.cards?.filter((c) => !ids.has(c.id)),
    }));
    o.spanglerCards = o.spanglerCards.map((row) => ({
      ...row,
      cards: row.cards.filter((c) => !ids.has(c.id)),
    }));
    if (o.prophecies)
      o.prophecies = o.prophecies.map((row) => ({
        ...row,
        count: Math.max(0, row.count - (row.cards?.filter((c) => ids.has(c.id)).length ?? 0)),
        cards: row.cards?.filter((c) => !ids.has(c.id)),
      }));
    o.promptCards = o.promptCards.filter((c) => !ids.has(c.id));
    const kind = action?.kind === 'play' && action.asUpgrade ? 'upgrade' : source.spec.kind;
    const controller = source.spec.entersOpponentControl ? opposite(actor) : actor;
    const enteringReady =
      !!source.spec.entersReady ||
      !!source.spec.readyEntryKinds?.includes(kind) ||
      players[controller].battleline
        .concat(players[controller].artifacts)
        .some((c) => c.spec.readyEntryKinds?.includes(kind));
    source = {
      ...source,
      controller,
      ready: enteringReady,
      damage: 0,
      armorUsed: 0,
      elusiveUsed: false,
      captured: 0,
      powerCounters: 0,
      warded: false,
      stunned: !!source.spec.entersStunned,
      enraged: !!source.spec.entersEnraged,
      markers: undefined,
      usesThisTurn: 0,
      attachedTo: kind === 'upgrade' && action?.kind === 'play' ? (action.target ?? null) : null,
      spec: kind === source.spec.kind ? source.spec : { ...source.spec, kind },
      effective: {
        ...source.effective,
        power:
          source.spec.power +
          (typeof source.spec.powerBonus === 'number' ? source.spec.powerBonus : 0),
        armor:
          source.spec.armor +
          (typeof source.spec.armorBonusValue === 'number' ? source.spec.armorBonusValue : 0),
        house: source.printedHouse ?? source.spec.house,
        houses: [
          ...new Set([source.printedHouse ?? source.spec.house, ...(source.bonusHouses ?? [])]),
        ],
      },
    };
    source.effective.power = Math.max(0, source.effective.power);
    source.effective.armor = Math.max(0, source.effective.armor);
    const board = players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
    if (copyUnknown) mark(source.id, 'power', 'armor', 'ready', 'spec', 'houses', 'keywords');
    if (source.spec.entryEnragedCondition || board.some((c) => c.spec.enragesEnteringCreatures))
      mark(source.id, 'enraged');
    if (board.some((c) => c.spec.enemyEntryStunnedCondition)) mark(source.id, 'stunned');
    if (source.spec.auras?.length || kind === 'upgrade')
      for (const card of board) mark(card.id, 'power', 'armor', 'keywords');
    if (
      !enteringReady &&
      (source.spec.entryReadyCondition ||
        source.spec.entersReadyAfterUse ||
        source.spec.readyEntryRules?.length ||
        board.some((c) => c.spec.readyEntryRules?.length) ||
        original.nextReady.length)
    )
      mark(source.id, 'ready');
    if (!enteringReady && source.spec.entryReadyCondition)
      view.entryCondition = source.spec.entryReadyCondition;
    if (
      (source.spec.powerBonus !== undefined && typeof source.spec.powerBonus !== 'number') ||
      source.spec.selfPower ||
      source.copiedCharacteristics ||
      [source, ...board].some((c) => c.spec.auras?.some((a) => a.property === 'power')) ||
      original.lasting.some((e) =>
        ['fixedCreatureStats', 'filteredPower', 'blankBoostNamed'].includes(e.rule),
      )
    )
      mark(source.id, 'power');
    if (
      (source.spec.armorBonusValue !== undefined &&
        typeof source.spec.armorBonusValue !== 'number') ||
      source.copiedCharacteristics ||
      [source, ...board].some(
        (c) => c.spec.removesCreatureArmor || c.spec.auras?.some((a) => a.property === 'armor'),
      ) ||
      original.lasting.some((e) => e.rule === 'fixedCreatureStats')
    )
      mark(source.id, 'armor');
    if (kind === 'creature') {
      const line = players[controller].battleline;
      const position =
        action?.kind === 'play' && action.position !== undefined
          ? Math.max(0, Math.min(line.length, action.position))
          : action?.kind === 'play' && action.flank === 'left'
            ? 0
            : line.length;
      if (
        line.length > 0 &&
        !(action?.kind === 'play' && (action.position !== undefined || action.flank))
      )
        for (const c of [...line, source]) mark(c.id, 'position');
      line.splice(position, 0, source);
    } else if (kind === 'artifact') players[controller].artifacts.push(source);
    else if (kind === 'upgrade') {
      players[controller].upgrades.push(source);
      mark(source.id, 'power', 'armor');
    } else o.resolving.push(source);
    o.playedThisTurn += 1;
    if (kind === 'creature') o.creaturesPlayedThisTurn += 1;
    const playedByHouse = { ...o.publicCounters.playedByHouse };
    for (const house of houses(source)) playedByHouse[house] = (playedByHouse[house] ?? 0) + 1;
    o.publicCounters = { ...o.publicCounters, playedByHouse };
  }
  if (
    context.phase === 'after-use' &&
    source &&
    action &&
    ['reap', 'use', 'fight', 'unstun'].includes(action.kind)
  ) {
    view.used = true;
    if (source.spec.kind === 'creature') {
      const uses = o.publicCounters.creaturesUsed;
      const previous = uses.find((row) => row.currentCard === source!.id);
      if (o.creatureUseHistory) {
        const distinctKeys = [...new Set(o.creatureUseHistory.map((row) => row.distinctKey))];
        const key = previous ? distinctKeys[previous.use - 1] : o.creatureUseHistory.length;
        if (key !== undefined)
          o.creatureUseHistory = [
            ...o.creatureUseHistory,
            {
              actor,
              houses: [...houses(source)],
              traits: [...traits(source)],
              distinctKey: key,
            },
          ];
        else o.creatureUseHistory = undefined;
      }
      if (!previous)
        o.publicCounters = {
          ...o.publicCounters,
          creaturesUsed: [...uses, { use: uses.length + 1, currentCard: source.id }],
        };
    }
    if (action.kind === 'reap' && o.interactionCounters)
      o.interactionCounters = {
        ...o.interactionCounters,
        reaps: o.interactionCounters.reaps + 1,
      };
    if (action.kind === 'fight' && o.worldsCollide) {
      const fought: [number, number] = [...o.worldsCollide.fought];
      fought[actor] += 1;
      o.worldsCollide = { ...o.worldsCollide, fought };
    }
    source = {
      ...source,
      ready: false,
      usesThisTurn: (source.usesThisTurn ?? 0) + 1,
      ...(action.kind === 'unstun' ? { stunned: false } : {}),
    };
    for (const p of players)
      for (const zone of ['battleline', 'artifacts', 'upgrades'] as const)
        p[zone] = p[zone].map((c) => (c.id === source!.id ? source! : c));
  }
  cards = collect(o);
  if (source) cards.set(source.id, source);
  view.cards = cards;
  view.source = source;
  return view;
}

export function publicFormulaSide(
  side: unknown,
  context: PublicFormulaContext | undefined,
  view: FormulaView,
): Seat | undefined {
  if (view.actor === undefined) return;
  if (side === undefined || side === 'self') return view.actor;
  if (side === 'opponent') return opposite(view.actor);
  if (side === 'active') return view.observation?.activePlayer;
  if (side === 'eventOwner') return context?.eventOwner;
  if (side === 'eventController') return context?.eventController;
  if (side === 'eventOpponent')
    return context?.eventController === undefined ? undefined : opposite(context.eventController);
  if (side === 'lastOwner') return context?.lastOwner;
}

const admitted = new Set([
  'zone',
  'side',
  'kind',
  'house',
  'notHouse',
  'name',
  'definition',
  'trait',
  'notTrait',
  'other',
  'sourceOnly',
  'flank',
  'flankSide',
  'center',
  'ready',
  'stunned',
  'damaged',
  'withAmber',
  'warded',
  'enraged',
  'powerMin',
  'powerMax',
  'powerExtreme',
  'keyword',
  'any',
  'tokenCreature',
  'hasArmor',
  'hasPowerCounters',
  'hostSide',
  'sourceInCenter',
  'bound',
  'excludeBinding',
  'excludePhysicalBinding',
  'controllerBinding',
  'houseBinding',
  'houseInBinding',
  'sharesTraits',
  'sameNameBinding',
  'notSameNameBinding',
  'sameKindBinding',
  'notKindBinding',
  'neighborBinding',
  'betweenSourceAnd',
  'neighborsOf',
  'relativeToSource',
  'activeHouse',
  'notActiveHouse',
  'hasUpgrade',
  'powerBelow',
  'powerEquals',
  'powerEqualsChosen',
  'powerBelowSource',
  'powerBelowBinding',
  'powerMatchesBinding',
  'powerParity',
  'lineMinimum',
  'marker',
  'ownerHaunted',
  'attachedToBinding',
  'attachedHostOfSource',
  'sameNameAsSourceHost',
  'houseRepresentedByFriendly',
  'sameHouseNeighbors',
  'sharesNeighborHouse',
  'neighborPower',
  'differentNonHouseNeighbors',
  'mostNumerousHouse',
  'housePopulationMin',
  'sharesTraitWithFriendlyOther',
  'traitBinding',
  'bonusCount',
  'eventOnly',
  'combatOpponentOnly',
]);
const exact = (value: number): PublicValueResult => ({
  kind: 'exact',
  value,
  reasons: [],
});
const bounds = (r: PublicValueResult): [number, number] | undefined =>
  r.kind === 'exact'
    ? [r.value, r.value]
    : r.kind === 'interval' || r.kind === 'expected'
      ? [r.lower, r.upper]
      : undefined;

/** Shared public selector. Side selects the holder's zone, exactly as filterCards;
 * it is not an ownership test for foreign archives. */
export function selectFormulaCards(
  filter: Filter,
  context: PublicFormulaContext | undefined,
  view: FormulaView,
  evaluate: (value: Value) => PublicValueResult,
  consume: () => boolean,
  recurse: (filter: Filter) => PublicCardSelection,
): PublicCardSelection {
  const o = view.observation,
    actor = view.actor;
  if (!o || actor === undefined)
    return {
      cards: [],
      possibleCards: [],
      identitiesComplete: false,
      count: { kind: 'unknown', reasons: ['missing-public-observation'] },
      reasons: ['missing-public-observation'],
    };
  const reasons = new Set<string>();
  const unsupported = Object.entries(filter)
    .filter(([key, value]) => value !== undefined && !admitted.has(key))
    .map(([key]) => key);
  for (const key of unsupported) reasons.add('unsupported-filter:' + key);
  const selectedSeats: Seat[] =
    filter.side === 'friendly' ? [actor] : filter.side === 'enemy' ? [opposite(actor)] : [0, 1];
  const selectedZones = [
    ...new Set(Array.isArray(filter.zone) ? filter.zone : [filter.zone ?? 'battleline']),
  ];
  const domain = new Map<string, CardView>();
  let hidden = 0;
  for (const seat of selectedSeats)
    for (const zone of selectedZones) {
      const p = o.players[seat];
      let visible: readonly CardView[] = [];
      if (zone === 'play') visible = [...p.battleline, ...p.artifacts, ...p.upgrades];
      else if (zone === 'deck') {
        visible = p.revealedTop && p.deckCount > 0 ? [p.revealedTop] : [];
        hidden += Math.max(0, p.deckCount - visible.length);
      } else if (zone === 'hand') {
        visible = seat === o.you ? (p.hand ?? []) : [];
        hidden += Math.max(0, p.handCount - visible.length);
      } else if (zone === 'archives') {
        visible = seat === o.you && p.archives ? p.archives : (p.faceupArchives ?? []);
        hidden += Math.max(0, p.archiveCount - visible.length);
      } else if (zones.includes(zone as (typeof zones)[number]))
        visible = p[zone as (typeof zones)[number]] ?? [];
      else reasons.add('unsupported-zone:' + zone);
      for (const card of visible) domain.set(card.id, card);
    }
  const lineOf = (c: CardView) => o.players[c.controller].battleline;
  const neighbors = (c: CardView | undefined): CardView[] | undefined => {
    if (!c) return undefined;
    if (view.uncertain.get(c.id)?.has('position')) return undefined;
    const line = lineOf(c),
      index = line.findIndex((x) => x.id === c.id);
    return index < 0 ? [] : [line[index - 1], line[index + 1]].filter((x): x is CardView => !!x);
  };
  const center = (c: CardView | undefined): boolean | undefined => {
    if (!c) return undefined;
    if (view.uncertain.get(c.id)?.has('position')) return undefined;
    const line = lineOf(c);
    return line.length % 2 === 1 && line[Math.floor(line.length / 2)]?.id === c.id;
  };
  const binding = (key: string): readonly CardView[] | undefined => context?.bindings?.get(key);
  const current = (card: CardView) => view.cards.get(card.id);
  const boundCurrent = (key: string) => binding(key)?.map((c) => current(c));
  const sharesHouse = (a: CardView, b: CardView) => houses(a).some((h) => houses(b).includes(h));
  const comparison = (
    left: number,
    result: PublicValueResult,
    op: 'lt' | 'eq',
  ): boolean | undefined => {
    const range = bounds(result);
    if (!range) {
      result.reasons.forEach((x) => reasons.add(x));
      return;
    }
    if (op === 'lt') return left < range[0] ? true : left >= range[1] ? false : undefined;
    return range[0] === range[1]
      ? left === range[0]
      : left < range[0] || left > range[1]
        ? false
        : undefined;
  };
  const childSelections = filter.any?.map((child) =>
    recurse({ ...child, zone: child.zone ?? filter.zone }),
  );
  const housePopulation = new Map<House, number>();
  for (const p of o.players)
    for (const c of p.battleline)
      for (const house of houses(c))
        housePopulation.set(house, (housePopulation.get(house) ?? 0) + 1);
  const largestHousePopulation = Math.max(0, ...housePopulation.values());
  let certain: CardView[] = [],
    possible: CardView[] = [];
  let unread = 0;
  const list = [...domain.values()];
  for (let index = 0; index < list.length; index++) {
    if (!consume()) {
      unread = list.length - index;
      reasons.add('formula-budget');
      break;
    }
    const c = list[index],
      line = lineOf(c),
      indexInLine = line.findIndex((x) => x.id === c.id),
      checks: (boolean | undefined)[] = [];
    const u = view.uncertain.get(c.id);
    const test = (condition: boolean | undefined, reason = 'uncertain-filter-membership') => {
      checks.push(condition);
      if (condition === undefined) reasons.add(reason);
    };
    const bh = (key: string, predicate: (cards: readonly CardView[]) => boolean) => {
      const found = binding(key);
      test(found ? predicate(found) : undefined, 'missing-public-binding:' + key);
    };
    const bhCurrent = (key: string, predicate: (cards: readonly CardView[]) => boolean) => {
      const found = boundCurrent(key);
      test(
        found && found.every((card) => card && !view.uncertain.get(card.id)?.has('spec'))
          ? predicate(found as CardView[])
          : undefined,
        'binding-current-face-unavailable:' + key,
      );
    };
    const characteristic = (field: 'power' | 'armor', predicate: (value: number) => boolean) =>
      test(u?.has(field) ? undefined : predicate(c.effective[field]), 'projected-' + field);
    if (unsupported.length) test(undefined);
    if (filter.kind)
      test(u?.has('spec') ? undefined : c.spec.kind === filter.kind, 'projected-spec');
    for (const [field, negative] of [
      ['house', false],
      ['notHouse', true],
    ] as const) {
      const raw = filter[field];
      if (raw) {
        const house = raw === 'chosenHouse' ? context?.chosenHouse : raw;
        test(
          house === undefined ? undefined : houses(c).includes(house) !== negative,
          'missing-chosen-house',
        );
      }
    }
    if (filter.name !== undefined)
      test(u?.has('spec') ? undefined : c.spec.name === filter.name, 'projected-spec');
    if (filter.definition)
      test(u?.has('spec') ? undefined : c.spec.id === filter.definition, 'projected-spec');
    if (filter.trait)
      test(u?.has('spec') ? undefined : traits(c).includes(filter.trait), 'projected-spec');
    if (filter.notTrait)
      test(u?.has('spec') ? undefined : !traits(c).includes(filter.notTrait), 'projected-spec');
    if (filter.other) test(view.source ? c.id !== view.source.id : undefined, 'missing-source');
    if (filter.sourceOnly)
      test(view.source ? c.id === view.source.id : undefined, 'missing-source');
    for (const field of ['ready', 'stunned', 'warded', 'enraged'] as const)
      if (filter[field] !== undefined)
        test(u?.has(field) ? undefined : !!c[field] === filter[field], 'projected-' + field);
    if (filter.damaged !== undefined)
      test(u?.has('damage') ? undefined : c.damage > 0 === filter.damaged, 'projected-damage');
    if (filter.withAmber !== undefined)
      test(
        u?.has('captured') ? undefined : c.captured > 0 === filter.withAmber,
        'projected-captured',
      );
    if (filter.hasPowerCounters !== undefined)
      test(
        u?.has('powerCounters') ? undefined : c.powerCounters > 0 === filter.hasPowerCounters,
        'projected-power-counters',
      );
    if (filter.hasArmor !== undefined) characteristic('armor', (n) => n > 0 === filter.hasArmor);
    if (filter.tokenCreature !== undefined) test(!!c.tokenCreature === filter.tokenCreature);
    if (filter.keyword)
      test(
        u?.has('keywords') ? undefined : c.effective.keywords.includes(filter.keyword),
        'projected-keywords',
      );
    if (filter.powerMin !== undefined) characteristic('power', (n) => n >= filter.powerMin!);
    if (filter.powerMax !== undefined) characteristic('power', (n) => n <= filter.powerMax!);
    if (filter.powerParity)
      characteristic('power', (n) => n % 2 === (filter.powerParity === 'even' ? 0 : 1));
    if (filter.powerBelow !== undefined)
      test(
        u?.has('power')
          ? undefined
          : comparison(c.effective.power, evaluate(filter.powerBelow), 'lt'),
      );
    if (filter.powerEquals !== undefined)
      test(
        u?.has('power')
          ? undefined
          : comparison(c.effective.power, evaluate(filter.powerEquals), 'eq'),
      );
    if (filter.powerEqualsChosen)
      test(
        context?.chosenNumber === undefined || u?.has('power')
          ? undefined
          : c.effective.power === context.chosenNumber,
        'missing-chosen-number',
      );
    if (filter.powerBelowSource)
      test(
        view.source && !view.uncertain.get(view.source.id)?.has('power') && !u?.has('power')
          ? c.effective.power < view.source.effective.power
          : undefined,
        'missing-source-power',
      );
    if (filter.flank !== undefined) {
      const extra = o.cardEffects.some(
        (e) => e.target === c.id && e.rule === 'flank' && e.turn === o.turn,
      );
      test(
        u?.has('position')
          ? undefined
          : ((indexInLine >= 0 && (indexInLine === 0 || indexInLine === line.length - 1)) ||
              extra) === filter.flank,
        'projected-position',
      );
    }
    if (filter.flankSide)
      test(
        u?.has('position')
          ? undefined
          : indexInLine >= 0 && indexInLine === (filter.flankSide === 'left' ? 0 : line.length - 1),
        'projected-position',
      );
    if (filter.center !== undefined) {
      const yes = center(c);
      test(yes === undefined ? undefined : yes === filter.center, 'projected-position');
    }
    if (filter.sourceInCenter) test(center(view.source), 'missing-source-position');
    if (filter.lineMinimum !== undefined)
      test(indexInLine >= 0 && line.length >= filter.lineMinimum);
    if (filter.marker)
      test(
        u?.has('markers')
          ? undefined
          : (c.markers?.[filter.marker.name] ?? 0) >= filter.marker.atLeast,
        'projected-markers',
      );
    if (filter.activeHouse) test(o.activeHouse !== null && houses(c).includes(o.activeHouse));
    if (filter.notActiveHouse) test(o.activeHouse === null || !houses(c).includes(o.activeHouse));
    const attached = o.players.flatMap((p) => p.upgrades).filter((x) => x.attachedTo === c.id);
    if (filter.hasUpgrade !== undefined) test(attached.length > 0 === filter.hasUpgrade);
    if (filter.hostSide) {
      const host = c.attachedTo ? view.cards.get(c.attachedTo) : undefined;
      test(
        !!host &&
          inPlay(o, host.id) &&
          host.controller === (filter.hostSide === 'friendly' ? actor : opposite(actor)),
      );
    }
    if (filter.attachedHostOfSource)
      test(view.source ? view.source.attachedTo === c.id : undefined, 'missing-source');
    if (filter.sameNameAsSourceHost) {
      const host = view.source?.attachedTo ? view.cards.get(view.source.attachedTo) : undefined;
      test(
        host ? inPlay(o, host.id) && host.spec.name === c.spec.name : undefined,
        'missing-source-host',
      );
    }
    if (filter.bound) bh(filter.bound, (xs) => xs.some((x) => x.id === c.id));
    if (filter.excludeBinding) bh(filter.excludeBinding, (xs) => !xs.some((x) => x.id === c.id));
    if (filter.excludePhysicalBinding)
      bh(filter.excludePhysicalBinding, (xs) => !xs.some((x) => x.id === c.id));
    if (filter.controllerBinding)
      bh(filter.controllerBinding, (xs) => !!xs[0] && xs[0].controller === c.controller);
    if (filter.attachedToBinding)
      bh(filter.attachedToBinding, (xs) =>
        xs.some((x) => c.attachedTo === x.id && inPlay(o, x.id)),
      );
    if (filter.houseBinding) {
      const found = boundCurrent(filter.houseBinding);
      test(
        found
          ? found.length === 0
            ? false
            : found[0]
              ? sharesHouse(c, found[0])
              : undefined
          : undefined,
        'missing-public-binding:' + filter.houseBinding,
      );
    }
    if (filter.houseInBinding) {
      const found = boundCurrent(filter.houseInBinding);
      test(
        found && found.every(Boolean) ? found.some((x) => sharesHouse(c, x!)) : undefined,
        'missing-public-binding:' + filter.houseInBinding,
      );
    }
    if (filter.sharesTraits)
      bhCurrent(filter.sharesTraits, (xs) =>
        traits(c).some((t) => xs.some((x) => traits(x).includes(t))),
      );
    if (filter.sameNameBinding)
      bhCurrent(filter.sameNameBinding, (xs) => xs.some((x) => x.spec.name === c.spec.name));
    if (filter.notSameNameBinding)
      bhCurrent(filter.notSameNameBinding, (xs) => !xs.some((x) => x.spec.name === c.spec.name));
    if (filter.sameKindBinding)
      bhCurrent(filter.sameKindBinding, (xs) => xs.some((x) => x.spec.kind === c.spec.kind));
    if (filter.notKindBinding)
      bhCurrent(filter.notKindBinding, (xs) => !xs.some((x) => x.spec.kind === c.spec.kind));
    if (filter.powerBelowBinding) {
      const found = binding(filter.powerBelowBinding),
        target = found?.[0];
      const known = context?.lastKnownPower?.get(filter.powerBelowBinding);
      test(
        u?.has('power') || !found
          ? undefined
          : !target
            ? false
            : comparison(
                c.effective.power,
                known !== undefined
                  ? exact(known)
                  : evaluate({ bindingPower: filter.powerBelowBinding }),
                'lt',
              ),
        'missing-public-binding:' + filter.powerBelowBinding,
      );
    }
    if (filter.powerMatchesBinding) {
      const bound = binding(filter.powerMatchesBinding);
      const powers = bound?.map((card) => {
        const known = context?.lastKnownPower?.get(filter.powerMatchesBinding + ':' + card.id);
        if (known !== undefined) return known;
        const live = current(card);
        return live && !view.uncertain.get(live.id)?.has('power')
          ? live.effective.power
          : undefined;
      });
      test(
        !u?.has('power') && powers && powers.every((power) => power !== undefined)
          ? powers.some((power) => power === c.effective.power)
          : undefined,
        'missing-public-binding:' + filter.powerMatchesBinding,
      );
    }
    if (filter.traitBinding)
      test(
        context?.chosenTrait ? traits(c).includes(context.chosenTrait) : undefined,
        'missing-chosen-trait',
      );
    if (filter.eventOnly)
      test(
        context?.eventCard ? context.eventCard.id === c.id : undefined,
        'missing-public-event-card',
      );
    if (filter.combatOpponentOnly)
      test(
        context?.combatOpponent ? context.combatOpponent.id === c.id : undefined,
        'missing-public-combat-opponent',
      );
    if (filter.ownerHaunted) {
      const value = evaluate({
        haunted: true,
        side: c.owner === actor ? 'self' : 'opponent',
      });
      test(value.kind === 'exact' ? value.value !== 0 : undefined, 'unknown-owner-haunted');
    }
    if (filter.relativeToSource) {
      const sourceIndex = view.source ? line.findIndex((x) => x.id === view.source!.id) : -1;
      test(
        !view.source || u?.has('position') || view.uncertain.get(view.source.id)?.has('position')
          ? undefined
          : sourceIndex >= 0 &&
              indexInLine >= 0 &&
              (filter.relativeToSource === 'left'
                ? indexInLine < sourceIndex
                : indexInLine > sourceIndex),
        'missing-source-position',
      );
    }
    if (filter.neighborsOf) {
      const ns = neighbors(filter.neighborsOf === 'source' ? view.source : context?.combatOpponent);
      test(ns ? ns.some((x) => x.id === c.id) : undefined, 'missing-neighbor-context');
    }
    if (filter.neighborBinding) {
      const found = binding(filter.neighborBinding),
        ns = found?.[0] ? neighbors(current(found[0])) : undefined;
      test(
        found
          ? ns
            ? ns.some((x) => x.id === c.id)
            : found.length === 0
              ? false
              : undefined
          : undefined,
        'missing-public-binding:' + filter.neighborBinding,
      );
    }
    if (filter.betweenSourceAnd) {
      const found = binding(filter.betweenSourceAnd),
        other = found?.[0],
        src = view.source;
      if (!found || !src) test(undefined, 'missing-between-binding');
      else if (!other || other.controller !== src.controller) test(false);
      else {
        const sameLine = lineOf(src),
          a = sameLine.findIndex((x) => x.id === src.id),
          b = sameLine.findIndex((x) => x.id === other.id),
          i = sameLine.findIndex((x) => x.id === c.id);
        test(
          view.uncertain.get(src.id)?.has('position')
            ? undefined
            : a >= 0 && b >= 0 && i > Math.min(a, b) && i < Math.max(a, b),
          'projected-position',
        );
      }
    }
    if (
      filter.sameHouseNeighbors !== undefined ||
      filter.sharesNeighborHouse !== undefined ||
      filter.neighborPower ||
      filter.differentNonHouseNeighbors
    ) {
      const ns = neighbors(c);
      if (!ns) test(undefined, 'projected-neighbors');
      else {
        if (filter.sameHouseNeighbors !== undefined)
          test(ns.filter((x) => sharesHouse(c, x)).length === filter.sameHouseNeighbors);
        if (filter.sharesNeighborHouse !== undefined)
          test(ns.some((x) => sharesHouse(c, x)) === filter.sharesNeighborHouse);
        if (filter.neighborPower)
          test(
            u?.has('power') || ns.some((x) => view.uncertain.get(x.id)?.has('power'))
              ? undefined
              : ns.some((x) =>
                  filter.neighborPower === 'higher'
                    ? x.effective.power > c.effective.power
                    : x.effective.power < c.effective.power,
                ),
            'projected-neighbor-power',
          );
        if (filter.differentNonHouseNeighbors)
          test(
            ns.length === 2 &&
              !ns.some((x) => houses(x).includes(filter.differentNonHouseNeighbors!)) &&
              houses(ns[0]).some((h) => houses(ns[1]).some((other) => other !== h)),
          );
      }
    }
    if (filter.houseRepresentedByFriendly)
      test(
        o.players[actor].battleline
          .concat(o.players[actor].artifacts, o.players[actor].upgrades)
          .some((x) => sharesHouse(c, x)),
      );
    if (filter.mostNumerousHouse)
      test(houses(c).some((h) => (housePopulation.get(h) ?? 0) === largestHousePopulation));
    if (filter.housePopulationMin !== undefined)
      test(houses(c).some((h) => (housePopulation.get(h) ?? 0) >= filter.housePopulationMin!));
    if (filter.sharesTraitWithFriendlyOther !== undefined)
      test(
        line.some((x) => x.id !== c.id && traits(x).some((t) => traits(c).includes(t))) ===
          filter.sharesTraitWithFriendlyOther,
      );
    if (filter.bonusCount !== undefined) {
      const icons = c.resolvedBonusIcons ?? c.bonusIcons;
      test(icons ? icons.length === filter.bonusCount : c.spec.amber === filter.bonusCount);
    }
    if (childSelections)
      test(
        childSelections.some((s) => s.cards.some((x) => x.id === c.id))
          ? true
          : childSelections.some((s) => s.possibleCards.some((x) => x.id === c.id))
            ? undefined
            : false,
        'uncertain-any-filter',
      );
    if (checks.includes(false)) continue;
    (checks.includes(undefined) ? possible : certain).push(c);
  }
  if (filter.powerExtreme && certain.length + possible.length) {
    if (
      !hidden &&
      !unread &&
      !possible.length &&
      !certain.some((c) => view.uncertain.get(c.id)?.has('power'))
    ) {
      const extreme = (filter.powerExtreme === 'min' ? Math.min : Math.max)(
        ...certain.map((c) => c.effective.power),
      );
      certain = certain.filter((c) => c.effective.power === extreme);
    } else {
      possible = [...certain, ...possible];
      certain = [];
      reasons.add('uncertain-power-extreme');
    }
  }
  const identityFilters = Object.entries(filter).some(
    ([key, value]) => value !== undefined && !['zone', 'side'].includes(key),
  );
  if (hidden) reasons.add('hidden-zone-identities');
  const lower = certain.length + (identityFilters ? 0 : hidden),
    upper = certain.length + possible.length + hidden + unread;
  const count: PublicValueResult = [...reasons].some((reason) =>
    reason.startsWith('unsupported-zone:'),
  )
    ? { kind: 'unknown', lower, reasons: [...reasons] }
    : lower === upper
      ? { kind: 'exact', value: lower, reasons: [...reasons] }
      : { kind: 'interval', lower, upper, reasons: [...reasons] };
  return {
    cards: certain,
    possibleCards: possible,
    count,
    identitiesComplete:
      count.kind === 'exact' && hidden === 0 && unread === 0 && possible.length === 0,
    reasons: [...reasons],
  };
}
