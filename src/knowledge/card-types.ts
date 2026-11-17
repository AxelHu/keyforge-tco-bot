/** 完整静态卡牌知识的纯类型；不包含裁判状态、结算队列或游戏执行器。 */
import type { Effect } from '../contracts/observation.js';

export type LegacyHouse = 'brobnar' | 'dis' | 'logos' | 'mars' | 'sanctum' | 'shadows' | 'untamed';

export type House =
  | LegacyHouse
  | 'saurian'
  | 'staralliance'
  | 'unfathomable'
  | 'ekwidon'
  | 'geistoid'
  | 'skyborn'
  | 'redemption'
  | 'ouboros';

export type BonusIcon = 'amber' | 'capture' | 'damage' | 'draw' | 'discard' | 'power';

export type KeyColor = 'red' | 'blue' | 'yellow';

export type CardKind = 'creature' | 'action' | 'artifact' | 'upgrade';

export type Trigger =
  /** The named player's discard-to-deck shuffle left their discard empty. */
  | 'discardPileShuffled'
  /** Only successful draws by this controller during that controller's own turn. */
  | 'cardDrawnOwnTurn'
  /** Every successful draw by this source controller's opponent, on either turn. */
  | 'opponentCardDrawn'
  /** Actor is the active player resolving a ready transition, not its source/target controller. */
  | 'friendlyFightFinished'
  | 'playerReadiedCard'
  | 'fate'
  | 'scrap'
  | 'play'
  | 'reap'
  | 'beforeFight'
  | 'afterFight'
  | 'action'
  | 'omni'
  | 'destroyed'
  | 'anyStartTurn'
  | 'endReadyStep'
  | 'startDrawStep'
  | 'startTurn'
  | 'anyEndTurn'
  | 'endTurn'
  | 'opponentForge'
  | 'afterForge'
  | 'chooseHouse'
  | 'anyHouseChosen'
  | 'anyForge'
  | 'destroyedInFight'
  | 'attackDestroyed'
  | 'afterUse'
  | 'afterAssaultDestroy'
  | 'tideRaised'
  | 'opponentTideRaised'
  | 'survivedDamage';

export type Keyword = 'elusive' | 'skirmish' | 'poison' | 'taunt' | 'versatile' | 'entrench';

export type Side =
  | 'self'
  | 'opponent'
  | 'eventOwner'
  | 'eventController'
  | 'eventOpponent'
  | 'lastOwner'
  | 'active';

export type Zone =
  | 'deck'
  | 'hand'
  | 'discard'
  | 'archives'
  | 'battleline'
  | 'artifacts'
  | 'upgrades'
  | 'purged';

export interface CardFacts {
  tokenReference?: true;
  variant?: 'evil-twin';
  id: string;
  name: string;
  number: string;
  house: House;
  kind: CardKind;
  power: number;
  armor: number;
  amber: number;
  traits?: string[];
}

export interface Filter {
  eventOnly?: true;
  combatOpponentOnly?: true;
  hostSide?: 'friendly' | 'enemy';
  neighborPower?: 'higher' | 'lower';
  sharesNeighborHouse?: boolean;
  powerBelow?: Value;
  notActiveHouse?: true;
  sourceInCenter?: true;
  attachedToBinding?: string;
  /** Explicit GR public-pile selection; based on physical owner, not an old controller. */
  ownerHaunted?: true;
  activeHouse?: true;
  sameNameAsSourceHost?: true;
  /** Two current neighbors, each outside this house, with a different-house pairing. */
  differentNonHouseNeighbors?: House;
  name?: string;
  attachedHostOfSource?: true;
  tokenCreature?: boolean;
  houseInBinding?: string;
  betweenSourceAnd?: string;
  powerEquals?: Value;
  excludePhysicalBinding?: string;
  hasArmor?: boolean;
  hasPowerCounters?: boolean;
  flankSide?: 'left' | 'right';
  giganticHalf?: boolean;
  notInvulnerable?: boolean;
  notTaggedForDestruction?: true;
  bonusCount?: number;
  powerBelowSource?: boolean;
  traitBinding?: string;
  houseRepresentedByFriendly?: boolean;
  sourceOnly?: boolean;
  marker?: { name: CardMarker; atLeast: number };
  powerBelowBinding?: string;
  sameHouseNeighbors?: number;
  sharesTraitWithFriendlyOther?: boolean;
  mostNumerousHouse?: boolean;
  housePopulationMin?: number;
  powerMatchesBinding?: string;
  center?: boolean;
  hasUpgrade?: boolean;
  controllerBinding?: string;
  lineMinimum?: number;
  powerParity?: 'odd' | 'even';
  relativeToSource?: 'left' | 'right';
  side?: 'friendly' | 'enemy' | 'any';
  warded?: boolean;
  enraged?: boolean;
  zone?: Zone | 'play' | (Zone | 'play')[];
  kind?: CardKind;
  house?: House | 'chosenHouse';
  notHouse?: House | 'chosenHouse';
  bound?: string;
  excludeBinding?: string;
  sharesTraits?: string;
  definition?: string;
  trait?: string;
  notTrait?: string;
  other?: boolean;
  flank?: boolean;
  damaged?: boolean;
  stunned?: boolean;
  ready?: boolean;
  withAmber?: boolean;
  powerMin?: number;
  powerMax?: number;
  powerExtreme?: 'min' | 'max';
  powerEqualsChosen?: boolean;
  any?: Filter[];
  ranked?: 'min' | 'max';
  keyword?: Keyword;
  houseBinding?: string;
  neighborBinding?: string;
  notSameNameBinding?: string;
  sameNameBinding?: string;
  notKindBinding?: string;
  sameKindBinding?: string;
  neighborsOf?: 'source' | 'opponent';
}

export type Value =
  | { armorTotal: Filter }
  | { creatureFightsThisTurn: true }
  | { maximumBoundHouseCount: string }
  | { haunted: true; side?: Side }
  | { usedCreatureCount: { house?: House; trait?: string; side?: Side; distinct?: boolean } }
  | { allBoundShareHouse: string }
  | { friendlyExaltedThisTurn: true; side?: Side }
  | { tokenReferenceIs: string; side?: Side }
  | { bindingIconCount: { key: string; icon: BonusIcon } }
  | { boundTokenOrLastKnown: string }
  | { distinctPowers: Filter }
  | { bindingPowerCounters: string }
  | { drawnInDrawStep: true; side?: Side }
  | { powerCounterTotal: Filter }
  | { maximumPower: Filter }
  | { negate: Value }
  | { floorThird: Value }
  | { sharedHousePair: Filter }
  | { storedValue: string }
  | { ceilHalf: Value }
  | { foughtOpponentDestroyed: true }
  | { sourceArmor: true }
  | { sourcePower: true }
  | { tide: 'high' | 'low' | 'neutral'; side?: Side }
  | { sourcePowerCounters: true }
  | { defenderMostPowerful: true }
  | { friendlyDestroyedThisTurn: true }
  | { bonusCount: string }
  | { bindingUpgradeCount: string }
  | { bindingControllerCount: string; side?: Side; purged?: boolean }
  | { keyForged: KeyColor; side?: Side }
  | { discardAtLeast: number; side?: Side }
  | { activeIsController: true }
  | { sourceMarker: CardMarker }
  | { sourceNeighborPowerSum: true; excludeTrait: string }
  | { opponentMarkerTotal: CardMarker }
  /** Actual amber stolen by this frame actor during the current turn; attempts/replacements do not count. */
  | { stolenThisTurn: true }
  | { wasStolenFromPreviousTurn: true }
  | { bindingAmber: string }
  | { chosenHouseIs: House }
  | { bindingBonusSum: string }
  | { ceilThird: Value }
  | { creatureAmberTotal: Filter }
  | { bindingHouseCount: string; house: House; owner?: Side }
  | { boundPowerOrLastKnown: string }
  | { markerCount: { filter: Filter; name: CardMarker } }
  | { bindingBonus: string }
  | { bindingPowerSum: string }
  | { eventAmount: true }
  | { sourceDamage: true }
  | { sourceAmber: true }
  | { bindingTraits: string }
  | { distinctHouses: Filter }
  | { atMost: number; value: Value }
  | { enemyDestroyedThisTurn: true }
  | { ownTurn: true }
  | number
  | { metric: 'amber' | 'keys' | 'archives' | 'forgedLastTurn' | 'playedThisTurn'; side?: Side }
  | { count: Filter; multiplier?: number }
  | { add: Value[] }
  | { subtract: [Value, Value] }
  | { half: Value }
  | { lastAmount: true }
  | { bindingCount: string }
  | { bindingOwnerCount: string; side?: Side }
  | { destroyedBinding: string; side?: Side; direct?: boolean }
  | { sourceUsesThisTurn: true }
  | { playedHouse: House }
  | { metric: 'forgedThisTurn'; side?: Side }
  | { bindingDamage: string }
  | { bindingPower: string }
  | { chosenNumber: true }
  | {
      metric:
        | 'handSize'
        | 'creaturesPlayedThisTurn'
        | 'creaturesPlayedLastTurn'
        | 'uniqueCreaturesUsed'
        | 'enemyFightDeaths';
      side?: Side;
    };

export type Condition = { left: Value; comparison: 'gte' | 'gt' | 'eq' | 'lt' | 'lte'; right: Value };

export interface Aura {
  sourceCondition?: Condition;
  property:
    | 'power'
    | 'armor'
    | 'taunt'
    | 'poison'
    | 'skirmish'
    | 'elusive'
    | 'hazardous'
    | 'assault'
    | 'splashAttack'
    | 'versatile';
  amount?: number;
  targetAmberMultiplier?: number;
  sourceAmberMultiplier?: number;
  filter: Filter;
}

export interface Reaction {
  playedFrom?: Zone;
  eventPlayerMatchesController?: true;
  subjectIsActualToken?: boolean;
  distinctTraitUseThreshold?: { trait: string; count: number };
  subjectStillOriginalEntry?: boolean;
  subjectAttachedToSource?: boolean;
  destructionOrdinalAtLeast?: number;
  exactPlayOrdinal?: number;
  playedWithBonus?: boolean;
  bonusIcon?: BonusIcon;
  cardKind?: CardKind;
  subjectAttachedToSourceOrNeighbor?: boolean;
  definition?: string;
  subjectRightFlank?: boolean;
  combatDestructionOnly?: boolean;
  sourceReady?: boolean;
  firstReapOnly?: boolean;
  selfOnly?: boolean;
  neighborAtUse?: boolean;
  neighborOnly?: boolean;
  subjectTrait?: string;
  /** One union predicate, so an enemy of this trait triggers only once. */
  subjectEnemyOrTrait?: string;
  /** Relationship fixed before the destruction event, not the shortened battleline. */
  neighborAtDestruction?: true;
  subjectLeftFlank?: boolean;
  event:
    | 'creatureCaptured'
    | 'creatureExalted'
    | 'creatureDamaged'
    | 'creaturePlayed'
    | 'artifactPlayed'
    | 'creatureEntered'
    | 'creatureDestroyed'
    | 'artifactUsed'
    | 'creatureFought'
    | 'creatureReaped'
    | 'creatureUsed'
    | 'handDiscarded'
    | 'armorPrevented'
    | 'cardPlayed'
    | 'amberStolen'
    | 'actionBeforePlay'
    | 'actionPlacedAfterPlay'
    | 'bonusDamage'
    | 'bonusResolved'
    | 'upgradeEntered'
    | 'upgradeAttached';
  side?: 'friendly' | 'enemy' | 'any';
  warded?: boolean;
  enraged?: boolean;
  house?: House;
  other?: boolean;
  ownTurn?: boolean;
  effects: Effect[];
}

export interface RuleInterpretationNote {
  id: string;
  status: 'research-convention';
  scope: string;
  behavior: string;
  officialRulingConfirmed: false;
}

export interface CardDefinition extends CardFacts {
  /** Explicitly incomplete user-supplied knowledge; never inferred from an omitted projection. */
  unmodeled?: true;
  /** Legacy import compatibility field; ignored by structured strategy features. */
  summaryFeatures?: number;
  removesCreatureArmor?: boolean;
  preventsReadyCapturedFriendlyDamage?: boolean;
  neighborTraits?: string[];
  neighborHouse?: House;
  attackingIgnores?: ('taunt' | 'elusive' | 'poison' | 'hazardous' | 'invulnerable')[];
  reapSourceConditions?: Condition[];
  mineralizesCounters?: true;
  suppressesEnemyDestroyed?: true;
  forbidsArchiveStep?: true;
  forbidsEnemyRightFlankPlay?: true;
  enemyEntryStunnedCondition?: Condition;
  spendStoredAmberAsPool?: true;
  /** Physical own-discard-only replacement. It does not become an in-play gained text ability. */
  discardDrawReplacement?: boolean;
  purgeWhenNoCreatures?: boolean;
  forbidMorePowerfulCreaturePlay?: boolean;
  creaturePlayLimits?: { side: 'self' | 'opponent'; maximum: Value; condition?: Condition }[];
  entryEnragedCondition?: Condition;
  fightTargetRules?: { target: Filter; attacker: Filter; unlessTargetKeyword?: Keyword }[];
  skipForgeConditions?: Condition[];

  neighborUseAsHouse?: House;
  hauntedWithPurged?: boolean;
  cannotReadyUnlessHaunted?: boolean;
  globalHauntedDrawBonus?: number;
  destroyFriendlyBeforeUse?: boolean;
  replacesEnemyActionPlayWithOwnLeftDestruction?: boolean;
  revealsDeckTop?: boolean;
  nextUseAlternatesFightReap?: boolean;
  readyAfterSplashKill?: boolean;
  protectsFriendlyTraits?: string[];
  suppressesFriendlyAfterFight?: string[];
  preventsFriendlyExhaustionOffTurn?: boolean;
  markerDestructions?: { marker: CardMarker; atLeast: number; targets: Filter }[];
  spendSelfAsAmber?: boolean;
  readyStepRestrictions?: Filter[];
  opponentDrawPenaltyValue?: Value;
  cannotPlay?: boolean;
  cannotDiscardAsAction?: boolean;
  startTurnFromDiscard?: Effect[];
  forgeRestrictions?: { side: Side; condition: Condition }[];
  locksForeignArchives?: boolean;
  numericKeywordBonuses?: {
    keyword: 'assault' | 'hazardous' | 'splashAttack';
    amount: Value;
    condition?: Condition;
  }[];
  forbidsPreviousHouse?: boolean;
  grantsEnemyOmega?: boolean;
  onePlayPerType?: 'self' | 'opponent';
  inheritsFriendlyKeywords?: Keyword[];
  removesCreatureKeywords?: Keyword[];
  useAsNeighborHouse?: boolean;
  readyEnteringNeighbors?: boolean;
  prohibitsForging?: boolean;
  enragesEnteringCreatures?: boolean;
  reapRestrictions?: {
    filter: Filter;
    /** Live restriction-source context, independent of the player borrowing the target's use. */
    sourceCondition?: Condition;
    /** Target/use-actor context; preserved for existing restrictions. */
    condition?: Condition;
    gainedText?: boolean;
  }[];
  observesForgePayment?: boolean;
  playCondition?: Condition;
  incomingDamageMultipliers?: { condition: Condition; factor: number }[];
  noCombatDamageCondition?: Condition;
  cannotBeDamagedCondition?: Condition;
  friendlyAmberSpendCondition?: Condition;
  attackerBeforeFight?: Effect[];
  replacesEnemyCreatureReadyStep?: boolean;
  reapIncomeChosenCapture?: boolean;
  ruleInterpretations?: RuleInterpretationNote[];
  cannotReady?: boolean;
  useProhibitedIf?: Condition;
  sharesNeighborFightDamage?: boolean;
  faceupSelectiveArchives?: boolean;
  returnFromDiscardOnHouse?: House;
  /** Optional discard return between instructions on the owner's turn, independent of house. */
  returnFromDiscardCondition?: Condition;
  blanksArtifacts?: boolean;
  destroyWhenNoCreatures?: boolean;

  entersEnraged?: boolean;
  preventsCreatureDamage?: { mutant?: boolean; powerMin?: number; withAmber?: boolean; damaged?: true };
  suppressesDestroyed?: boolean;
  tauntDistance?: number;
  grantsOutOfHousePlayKind?: CardKind;

  cannotFight?: boolean;
  replacesDealtDamageWithSteal?: boolean;
  readyEntryRules?: {
    other?: true;
    kind?: CardKind;
    notHouse?: House;
    trait?: string;
    tokenCreature?: boolean;
    condition?: Condition;
  }[];
  bonusReplacements?: { from?: BonusIcon; to: BonusIcon | 'steal' | 'token' }[];
  blocksOpponentBonusIcons?: boolean;
  drawBonusValue?: Value;
  locksUsesOfStoredHouses?: true;
  maxControllerForgesPerTurn?: number;
  firstMutantDeathOwnerGain?: true;
  firstShadowDiscardSteal?: true;
  drawBonusIfOpponentRicher?: number;
  cannotStealCondition?: Condition;
  entryReadyCondition?: Condition;

  mimicCreature?: { house: House };
  playAsUpgrade?: NonNullable<CardDefinition['upgrade']>;
  /** An action may become this upgrade only after its own play effect, never as a hand-play alternative. */
  retainedUpgrade?: NonNullable<CardDefinition['upgrade']>;
  retainedUpgradeOnArtifacts?: true;
  animation?: {
    power: number;
    armor?: number;
    keywords?: Keyword[];
    anyHouseUse?: boolean;
    blankText?: boolean;
    threshold?: { marker: CardMarker; amount: number };
  };
  repeatFriendlyCreaturePlay?: boolean;
  friendlyPlayAsReap?: boolean;
  invulnerable?: boolean;
  invulnerableDuringFight?: boolean;
  invulnerableCondition?: Condition;
  readyIfHaunted?: boolean;
  afterAttach?: Effect[];
  forgeIntercept?: boolean;

  conditionalAbilities?: { condition: Condition; abilities: Partial<Record<Trigger, Effect[]>> }[];
  conditionalKeywords?: { condition: Condition; keywords: Keyword[] }[];
  noPlayCreaturesWhileAhead?: boolean;
  destroyIfFlank?: boolean;
  grantsCenterOutOfHousePlay?: boolean;

  entersOpponentControl?: boolean;
  supplyInsteadOfPool?: boolean;
  capturesReapIncome?: boolean;

  forbiddenKeyOrdinal?: 1 | 2 | 3;
  cannotForgeAhead?: boolean;
  forgeLosesRemaining?: boolean;
  combatDamageMaximum?: number;
  poisonAttackingFlank?: boolean;
  useRequiresNeighborsHouse?: House;

  powerBonus?: Value;
  armorBonusValue?: Value;
  keyTaxes?: { side: 'self' | 'opponent'; amount: Value; condition?: Condition }[];
  offFlankDrawPenalty?: number;
  onlyAttackFlanks?: boolean;
  noDefenseDamage?: boolean;
  globalFightIfAble?: boolean;
  prohibitsEnemyReap?: boolean;
  prohibitsNeighborReap?: boolean;
  readyEntryKinds?: CardKind[];
  grantsAbilities?: {
    sourceCondition?: Condition;
    filter: Filter;
    abilities: Partial<Record<Trigger, Effect[]>>;
  }[];
  /** AoA preview: timing/entry keywords, not combat keywords. */
  alpha?: boolean;
  omega?: boolean;
  deploy?: boolean;
  summary: string;
  keywords?: Keyword[];
  assault?: number;
  hazardous?: number;
  splashAttack?: number;
  entersReady?: boolean;
  entersStunned?: boolean;
  drawBonus?: number;
  opponentDrawPenalty?: number;
  globalDrawBonus?: number;
  centralDrawBonus?: number;
  flankKeyDiscount?: number;
  opponentKeyTax?: number;
  damagedBrobnarKeyTax?: boolean;
  flankAttackBonus?: number;
  selfPower?: 'unforgedKeys' | 'captured' | 'flank';
  anyHouseUse?: boolean;
  cannotReap?: boolean;
  fightOnlyStunned?: boolean;
  noCombatDamage?: boolean;
  absorbsNeighborDamage?: boolean;
  evasionSigil?: boolean;
  ignoreTaunt?: boolean;
  ignoreArmorWhenAttacking?: boolean;
  ignoreTauntElusive?: boolean;
  destroyWithoutEnemy?: boolean;
  cannotStealFrom?: boolean;
  cannotStealWhileAmber?: boolean;
  minAmberToPlay?: number;
  playAmberCost?: number;
  requiresUntamedDiscard?: boolean;
  playLimitOpponent?: number;
  prohibitOwnCreatures?: boolean;
  opponentArtifactPlayTax?: number;
  opponentArtifactUseTax?: number;
  mustHouse?: House;
  firstCreatureReady?: boolean;
  spendAmberForKeys?: boolean;
  spendFriendlyCreatureAmberForKeys?: boolean;
  opponentPoolForgeLimit?: number;
  replacesStealWithCapture?: boolean;
  entersReadyAfterUse?: 'fight' | 'reap';
  damagedPowerBonus?: number;
  skipForgeStep?: boolean;
  receivesForgePayment?: boolean;
  capturesIncomingAmber?: boolean;
  purgeCreaturesLeavingPlay?: boolean;
  controlsHost?: boolean;
  mimicAction?: boolean;
  grantsOutOfHousePlay?: House;
  auras?: Aura[];
  abilities?: Partial<Record<Trigger, Effect[]>>;
  reactions?: Reaction[];
  destroyedDestination?: 'hand' | 'deckTop';
  upgrade?: {
    discardHandsUnderHost?: true;
    hostSpendStoredAmberAsPool?: true;
    hostForbidMorePowerfulEnemyPlay?: true;
    /** This upgrade may be initially attached to an artifact; its own Play text decides what happens next. */
    attachToArtifact?: true;
    blanksHost?: true;
    hostUseProhibitedIf?: Condition;
    hostDamagePreventedIf?: Condition;
    conditionalNumericKeywords?: {
      condition: Condition;
      keyword: 'assault' | 'hazardous' | 'splashAttack';
      amount: number;
    }[];

    dividesHostDamageAmongNeighbors?: boolean;
    additionalHostHouse?: House;
    hostAttackProhibitedIf?: Condition;
    hostKeyTaxes?: { side: 'self' | 'opponent'; amount: Value; condition?: Condition }[];
    hostPowerBonus?: Value;
    cannotUse?: boolean;
    useAsNeighborHouse?: boolean;
    conditionalKeywords?: { condition: Condition; keywords: Keyword[] }[];
    armorZero?: boolean;
    cannotReady?: boolean;
    opponentSpendsAmber?: boolean;
    invulnerable?: boolean;
    controlledHostHouse?: House;
    /** Unconditional house replacement; unlike Ransom, it does not require matching controllers. */
    hostHouse?: House;
    spendAmberForKeys?: boolean;
    cannotStealFrom?: boolean;
    powerPerUpgrade?: number;
    armorPerUpgrade?: number;
    neighborKeywords?: Keyword[];
    onlyFlankAttackers?: boolean;
    cannotFight?: boolean;
    cannotReap?: boolean;
    requiresDiscard?: boolean;
    destructionReplacement?: boolean;
    reactions?: Reaction[];
    power?: number;
    armor?: number;
    flankPower?: number;
    flankArmor?: number;
    keywords?: Keyword[];
    assault?: number;
    hazardous?: number;
    splashAttack?: number;
    anyHouseUse?: boolean;
    opponentKeyTax?: number;
    abilities?: Partial<Record<Trigger, Effect[]>>;
  };
}

export type CardMarker =
  | 'mineralize'
  | 'doom'
  | 'fuse'
  | 'growth'
  | 'glory'
  | 'disruption'
  | 'warrant'
  | 'scheme'
  | 'knowledge'
  | 'ignorance'
  | 'awakening'
  | 'time'
  | 'depth'
  | 'wisdom'
  | 'trade'
  | 'yea'
  | 'nay'
  | 'hatch'
  | 'paint'
  | 'corrosion'
  | 'mutation';

