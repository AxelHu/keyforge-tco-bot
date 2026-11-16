/** Standalone player-view and heuristic-evaluation contracts. No authoritative rules engine. */
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

export type LegacyHouse = 'brobnar' | 'dis' | 'logos' | 'mars' | 'sanctum' | 'shadows' | 'untamed';

export type CardKind = 'creature' | 'action' | 'artifact' | 'upgrade';

export interface Command {
  actor: Seat;
  revision: number;
  actionId: string;
}

export type Seat = 0 | 1;

export type KeyColor = 'red' | 'blue' | 'yellow';

export interface Observation {
  /** Omitted by the complete local referee. An adapter sets false when its public
   * input cannot reconstruct the entire turn history or current effect state.
   * False never means a known zero counter or a known absence of effects. */
  publicStateCoverage?: {
    turnHistoryComplete: boolean;
    effectsComplete: boolean;
    /** One public ordinal can be known even while other turn counters/restrictions remain unknown. */
    turnOrdinalKnown?: boolean;
  };
  prophecies?: {
    id: string;
    owner: Seat;
    faces: ProphecyPair;
    face: 0 | 1;
    active: boolean;
    count: number;
    revealed: boolean;
    cards?: CardView[];
    namedHouse?: House;
  }[];
  prophecyActivatedThisTurn?: [boolean, boolean];
  haunted?: [boolean, boolean];
  nextCreatureUseRestriction?: { turn: number; cannot: 'fight' | 'reap'; alsoCannot?: 'fight' | 'reap' };
  creatureUseHistory?: { actor: Seat; houses: House[]; traits: string[]; distinctKey: number }[];
  friendlyExaltedThisTurn?: [boolean, boolean];
  nextCreatureEntries?: { actor: Seat; turn: number; source: string | null; sourceName: string }[];
  tokenReferences?: [CardDefinition | null, CardDefinition | null];
  previousChosenHouses?: [House | null, House | null];
  playedTypes?: [Partial<Record<CardKind, number>>, Partial<Record<CardKind, number>>];
  readinessProfile?: '18.4-ordered-v1';
  tide?: {
    highFor: Seat | null;
    status: 'high' | 'low' | 'neutral';
    canRaise: boolean;
    rulesAbilityChains: 3;
  };
  worldsCollide?: {
    version: 2;
    fought: [number, number];
    stolenFrom: [number, number];
    previousStolenFrom: [number, number];
  };
  interactionCounters?: { reaps: number; discarded: [number, number] };
  turnStep?: TurnStepState;
  schemaVersion: 2;
  engineVersion: string;
  rulesVersion: string;
  catalogVersion: string;
  revision: number;
  turn: number;
  you: Seat;
  firstPlayer: Seat;
  turnUsage: Record<string, number>;
  handOperations: number;
  playedThisTurn: number;
  creaturesPlayedThisTurn: number;
  activePlayer: Seat;
  phase: Phase;
  activeHouse: House | null;
  players: [PlayerView, PlayerView];
  legalActions: LegalAction[];
  resolving: CardView[];
  promptCards: CardView[];
  underCards: { source: string; count: number; cards?: CardView[]; faceUp?: boolean }[];
  spanglerCards: { source: string; cards: CardView[] }[];
  controlLayers: { source: string | null; target: string; controller: Seat; whileSource: boolean }[];
  nextReady: { source: string; actor: Seat; turn: number; filter: Filter }[];
  leaveEffects: { source: string; actor: Seat; effects: Effect[] }[];
  publicCounters: {
    playedByHouse: Partial<Record<House, number>>;
    discardedHouses: [House[], House[]];
    creaturesPlayedLastTurn: [number, number];
    enemyFightDeaths: number;
    /** Ordinals reveal only the public order of distinct uses, never internal zone epochs. */
    creaturesUsed: { use: number; currentCard: string | null }[];
  };

  pending: PendingView | null;
  lasting: LastingEffect[];
  knowledge: Revelation[];
  permissions: PermissionView[];
  cardEffects: (Omit<CardEffect, 'target'> & { target: string })[];
  houseRestrictions: (Omit<HouseRestriction, 'source'> & { source: string })[];
  futureHouseRestrictions: (Omit<HouseRestriction, 'source'> & { source: string })[];
  winner: Seat | null;
}

export type ProphecyPair = [string, string];

export interface CardView {
mineralized?: true;
temporaryAnimation?: { turn: number; power: number; house: House };
animatedArtifact?: { source: CardRef };
copiedAnimation?: { power: number };
copiedCharacteristics?: {
    power: number;
    armor: number;
    traits: string[];
    keywords: Keyword[];
    assault: number;
    hazardous: number;
    splashAttack?: number;
    alpha: boolean;
    omega: boolean;
    deploy: boolean;
  };
giganticBonusIcons?: BonusIcon[];
bonusIcons?: BonusIcon[];
bonusHouses?: House[];
copiedBonusHouses?: House[];
copiedBonusIcons?: BonusIcon[];
form?: 'upgrade' | 'animated';
retainedUpgradeDefinition?: string;
copiedForm?: 'animated';
warded?: boolean;
enraged?: boolean;
markers?: Partial<Record<CardMarker, number>>;
printing?: string;
id: string;
definition: string;
owner: Seat;
controller: Seat;
ready: boolean;
damage: number;
armorUsed: number;
elusiveUsed: boolean;
captured: number;
stunned: boolean;
powerCounters: number;
attachedTo: string | null;
enteredController: Seat;
foreignArchiveHolder: Seat | null;
copiedDefinition?: string;
printedHouse?: House;
copiedHouse?: House;
tokenCreature?: { reference: string; madeBy?: Seat; publicId: string };
tokenReverse?: {
    definition: string;
    printing?: string;
    printedHouse?: House;
    bonusIcons?: BonusIcon[];
    bonusHouses?: House[];
  };
readiness?: { cannotReadyByEffect: boolean; cannotReadyInNextStep: boolean };
physicalParts?: { id: string; definition: string; owner: Seat; printing?: string }[];
resolvedBonusIcons?: BonusIcon[];
spec: CardDefinition;
gainedTextBoxes?: CardDefinition[];
effective: {
    houses?: House[];
    house: House;
    power: number;
    armor: number;
    keywords: Keyword[];
    assault: number;
    hazardous: number;
    splashAttack?: number;
  };
usesThisTurn: number;
}

/** Public identity only; no hidden epoch or engine entry counter. */
export interface CardRef { id: string; controller?: Seat; }

export type Keyword = 'elusive' | 'skirmish' | 'poison' | 'taunt' | 'versatile' | 'entrench';

export type BonusIcon = 'amber' | 'capture' | 'damage' | 'draw' | 'discard' | 'power';

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

/** Public strategy knowledge: whitelisted numeric facts, estimated effects, and conservative vetoes. */
export interface CardDefinition extends CardFacts {
  /** Derived boolean heuristic features, never encoded original text. */
  summaryFeatures?: number; unmodeled?: true; knowledge?: { schema: "strategy-knowledge-v1"; incomplete: boolean; }; preventsReadyCapturedFriendlyDamage?: boolean;
neighborTraits?: string[];
neighborHouse?: House;
reapSourceConditions?: Condition[];
suppressesEnemyDestroyed?: true;
forbidsArchiveStep?: true;
forbidMorePowerfulCreaturePlay?: boolean;
creaturePlayLimits?: { side: 'self' | 'opponent'; maximum: Value; condition?: Condition }[];
entryEnragedCondition?: Condition;
globalHauntedDrawBonus?: number;
destroyFriendlyBeforeUse?: boolean;
replacesEnemyActionPlayWithOwnLeftDestruction?: boolean;
nextUseAlternatesFightReap?: boolean;
protectsFriendlyTraits?: string[];
opponentDrawPenaltyValue?: Value;
cannotPlay?: boolean;
cannotDiscardAsAction?: boolean;
forgeRestrictions?: { side: Side; condition: Condition }[];
locksForeignArchives?: boolean;
forbidsPreviousHouse?: boolean;
grantsEnemyOmega?: boolean;
onePlayPerType?: 'self' | 'opponent';
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
playCondition?: Condition;
incomingDamageMultipliers?: { condition: Condition; factor: number }[];
cannotBeDamagedCondition?: Condition;
replacesEnemyCreatureReadyStep?: boolean;
reapIncomeChosenCapture?: boolean;
ruleInterpretations?: RuleInterpretationNote[];
cannotReady?: boolean;
useProhibitedIf?: Condition;
returnFromDiscardCondition?: Condition;
blanksArtifacts?: boolean;
preventsCreatureDamage?: { mutant?: boolean; powerMin?: number; withAmber?: boolean; damaged?: true };
suppressesDestroyed?: boolean;
bonusReplacements?: { from?: BonusIcon; to: BonusIcon | 'steal' | 'token' }[];
blocksOpponentBonusIcons?: boolean;
drawBonusValue?: Value;
locksUsesOfStoredHouses?: true;
maxControllerForgesPerTurn?: number;
firstMutantDeathOwnerGain?: true;
drawBonusIfOpponentRicher?: number;
cannotStealCondition?: Condition;
mimicCreature?: { house: House };
playAsUpgrade?: NonNullable<CardDefinition['upgrade']>;
retainedUpgrade?: NonNullable<CardDefinition['upgrade']>;
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
forgeIntercept?: boolean;
conditionalAbilities?: { condition: Condition; abilities: Partial<Record<Trigger, Effect[]>> }[];
conditionalKeywords?: { condition: Condition; keywords: Keyword[] }[];
noPlayCreaturesWhileAhead?: boolean;
destroyIfFlank?: boolean;
entersOpponentControl?: boolean;
supplyInsteadOfPool?: boolean;
capturesReapIncome?: boolean;
forbiddenKeyOrdinal?: 1 | 2 | 3;
cannotForgeAhead?: boolean;
useRequiresNeighborsHouse?: House;
powerBonus?: Value;
armorBonusValue?: Value;
keyTaxes?: { side: 'self' | 'opponent'; amount: Value; condition?: Condition }[];
offFlankDrawPenalty?: number;
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
alpha?: boolean;
omega?: boolean;
summary: string;
keywords?: Keyword[];
assault?: number;
hazardous?: number;
splashAttack?: number;
drawBonus?: number;
opponentDrawPenalty?: number;
globalDrawBonus?: number;
centralDrawBonus?: number;
opponentKeyTax?: number;
selfPower?: 'unforgedKeys' | 'captured' | 'flank';
anyHouseUse?: boolean;
cannotReap?: boolean;
noCombatDamage?: boolean;
absorbsNeighborDamage?: boolean;
evasionSigil?: boolean;
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
damagedPowerBonus?: number;
skipForgeStep?: boolean;
capturesIncomingAmber?: boolean;
purgeCreaturesLeavingPlay?: boolean;
controlsHost?: boolean;
mimicAction?: boolean;
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

export type Condition = { left: Value; comparison: 'gte' | 'gt' | 'eq' | 'lt' | 'lte'; right: Value };

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

export type Zone =
  | 'deck'
  | 'hand'
  | 'discard'
  | 'archives'
  | 'battleline'
  | 'artifacts'
  | 'upgrades'
  | 'purged';

export type Side =
  | 'self'
  | 'opponent'
  | 'eventOwner'
  | 'eventController'
  | 'eventOpponent'
  | 'lastOwner'
  | 'active';

export interface RuleInterpretationNote {
  id: string;
  status: 'research-convention';
  scope: string;
  behavior: string;
  officialRulingConfirmed: false;
}

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

/** Evaluation input only. Unsupported instructions remain explicitly unmodeled. */
export type Effect = {kind:"unmodeled";reason?:string} | { unmodeled?: true; kind: "payOpponent";
amount: Value;
then?: Effect[]} | { unmodeled?: true; kind: "putSource";
controller?: Side | 'owner'} | { unmodeled?: true; kind: "cauldronStart";} | { unmodeled?: true; kind: "eachPlayer";
condition?: Condition;
effects: Effect[]} | { unmodeled?: true; kind: "bindDeckEdge";
edge: 'top' | 'bottom';
side?: Side;
count: number;
bind: string;
then: Effect[]} | { unmodeled?: true; kind: "makeTokens";
count: Value;
side?: Side;
named?: string;
bind?: string;
then?: Effect[]} | { unmodeled?: true; kind: "makeToken";
side?: Side;
named?: string;
bind?: string;
then?: Effect[];} | { unmodeled?: true; kind: "discardDeckEdge";
edge: 'top' | 'bottom';
count: Value;
side?: Side;
bind: string;
then: Effect[];} | { unmodeled?: true; kind: "orderedChild";
effects: Effect[];
then: Effect[]} | { unmodeled?: true; kind: "destroyBoundAndThen";
key: string;
bind: string;
then: Effect[];} | { unmodeled?: true; kind: "tide";
operation: 'raise' | 'reset';
side?: Side} | { unmodeled?: true; kind: "asPlayer";
side: Side;
effects: Effect[]} | { unmodeled?: true; kind: "loseThen";
side?: Side;
amount?: Value;
then: Effect[]} | { unmodeled?: true; kind: "bindCards";
filter: Filter;
bind: string;
then: Effect[]} | { unmodeled?: true; kind: "randomArchive";
amount: number;
side?: Side} | { unmodeled?: true; kind: "forEach";
count: Value;
effects: Effect[];} | { unmodeled?: true; kind: "gain" | "loseOpponent" | "capture" | "draw" | "healSelf" | "chains";
amount: Value} | { unmodeled?: true; kind: "resource";
operation: 'gain' | 'lose' | 'steal' | 'draw' | 'chains';
amount: Value;
side?: Side} | { unmodeled?: true; kind: "steal";
amount: Value;
thenDamage?: number;
then?: Effect[]} | { unmodeled?: true; kind: "damageChoice";
amount: number;
rewardOnDestruction?: number} | { unmodeled?: true; kind: "archiveChoice" | "sacrificeSelf" | "skipForge" | "finishAction";} | { unmodeled?: true; kind: "if";
condition: Condition;
then: Effect[];
otherwise?: Effect[]} | { unmodeled?: true; kind: "target";
filter: Filter;
max?: number;
optional?: boolean;
label?: string
operation: Operation;
amount?: Value;
fullHeal?: boolean;
ignoreArmor?: boolean;
after?: ApplySpec['after'];} | { unmodeled?: true; kind: "all";
filter: Filter
operation: Operation;
amount?: Value;
fullHeal?: boolean;
ignoreArmor?: boolean;
after?: ApplySpec['after'];} | { unmodeled?: true; kind: "self";
operation: Operation;
amount?: Value;
fullHeal?: boolean;
ignoreArmor?: boolean;
after?: ApplySpec['after'];} | { unmodeled?: true; kind: "randomDiscard";
side?: Side;
amount: number;
zone?: 'hand' | 'archives' | 'discard';
operation?: 'discard' | 'purge' | 'shuffleDeck';} | { unmodeled?: true; kind: "archiveTop";
side?: Side} | { unmodeled?: true; kind: "choose";
label: string;
options: DecisionOption[]} | { unmodeled?: true; kind: "chooseHouse";
from?: 'all' | 'ownDeck' | 'opponentDeck';
then: Effect[]} | { unmodeled?: true; kind: "chooseCards";
distinctNames?: true;
distinctHouses?: true;
min?: number;
allOrNone?: boolean;
minimumPower?: number;
filter: Filter;
bind: string;
max?: Value;
optional?: boolean;
then: Effect[];
label?: string;} | { unmodeled?: true; kind: "bound";
key: string;
operation: Operation;
amount?: Value;
fullHeal?: boolean;
ignoreArmor?: boolean;
after?: ApplySpec['after'];} | { unmodeled?: true; kind: "reveal";
filter: Filter;} | { unmodeled?: true; kind: "recur";
count: Value;
effects: Effect[]} | { unmodeled?: true; kind: "lasting";
rule: LastingRule;
side?: Side;
amount?: number;
duration: 'turn' | 'nextTurn' | 'endOfNextTurn' | 'untilNextOwnTurnStart';
countFilter?: Filter;
house?: House | 'chosenHouse';} | { unmodeled?: true; kind: "permission";
mode: PermissionMode;
filter: Filter;} | { unmodeled?: true; kind: "useChoice";
filter: Filter;
mode: 'any' | 'fight' | 'artifact' | 'reap';
optional?: boolean;
after?: Effect[];} | { unmodeled?: true; kind: "forgeEffect";
color?: KeyColor;
minimumCost?: number;
delta?: Value;
reduction?: Value;
fixedCost?: number;
optional?: boolean;
after?: Effect[];} | { unmodeled?: true; kind: "storeAmber";} | { unmodeled?: true; kind: "takeControl";
key?: string;
whileSource?: boolean;
house?: House;
side?: Side;};

export interface DecisionOption {
  key: string;
  label: string;
  effects: Effect[];
  house?: House;
  number?: number;
}

export type LastingRule =
  | 'pvCardPlaySteal'
  | 'pvUseNeighborsDamage'
  | 'pvActionPlayLose'
  | 'allCreaturesMutant'
  | 'skipReadyStep'
  | 'playLimit'
  | 'noNamedPlayUse'
  | 'noMatchingPlay'
  | 'creaturePlayDamage'
  | 'cardPlayLose'
  | 'grantFriendlyAfterFight'
  | 'grantNamedAfterFight'
  | 'grantFriendlyReap'
  | 'grantEnemyDestroyed'
  | 'anotherTurn'
  | 'anyCreatureDamagedGain'
  | 'fightDeathDiscard'
  | 'filteredPower'
  | 'copyFriendlyTokens'
  | 'poolIncomeBecomesTokens'
  | 'blankBoostNamed'
  | 'archiveAfterDiscard'
  | 'onlyPlayHouse'
  | 'makeReadyTokensOnOtherHouse'
  | 'enemyFightDestroyedToken'
  | 'anyCreatureDestroyedToken'
  | 'gainOnOtherHouse'
  | 'dynamicKeyTax'
  | 'grantNumericKeyword'
  | 'cardPlayExhaust'
  | 'grantCreatureKeywords'
  | 'actionPlayGain'
  | 'noRaiseTide'
  | 'noFight'
  | 'noActions'
  | 'noCreatures'
  | 'noUse'
  | 'noPlay'
  | 'keyCost'
  | 'noDamage'
  | 'noReady'
  | 'loseElusive'
  | 'creaturePlayGain'
  | 'cardPlayCapture'
  | 'cardPlayDraw'
  | 'reapGain'
  | 'enemyDestroyedGain'
  | 'fightGain'
  | 'fightCapture'
  | 'fightOnly'
  | 'reapSteal'
  | 'charge'
  | 'giveRemainingOnForge'
  | 'grantElusive'
  | 'noReapHouse'
  | 'blankCreatures'
  | 'grantBeforeFightExalt'
  | 'noReap'
  | 'fightLoseOpponent'
  | 'afterDinosaurUseDamage'
  | 'fixedCreatureStats'
  | 'destroyCreaturesEndTurn'
  | 'noNonShadowsFight'
  | 'grantFriendlyReapGain'
  | 'stealOnChosenHouse'
  | 'shareFightReap';

export type PermissionMode = 'play' | 'use' | 'fight' | 'playOrUse';

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

export interface TurnStepState {
  step: 1 | 2 | 3 | 4 | 5;
  performed: [number, number];
  omega: boolean;
}

export type Phase = 'mulligan' | 'forge' | 'house' | 'archives' | 'main' | 'choice' | 'finished';

export interface PlayerView {
  revealedTop?: CardView;
  faceupArchives?: CardView[];
  forgeBlocked?: boolean;
  houses: House[];
  amber: number;
  keys: KeyColor[];
  keyCost: number;
  chains: number;
  skipForgeTurn: number | null;
  lastForgedTurn: number | null;
  forgedOn: Partial<Record<KeyColor, number>>;
  forgeAvailable: number;
  forgeSources?: Record<string, number>;
  deckList: { definition: string; name: string; count: number; house: House }[];
  deckCount: number;
  handCount: number;
  archiveCount: number;
  hand?: CardView[];
  archives?: CardView[];
  battleline: CardView[];
  artifacts: CardView[];
  upgrades: CardView[];
  purged: CardView[];
  discard: CardView[];
}

export interface LegalAction {
  /** Current public WC use semantics, indexed by the referee; absent in legacy protocols. */
  useDescription?: { trigger: 'action' | 'omni'; label: string; effects: Effect[] };
  id: string;
  action: Action;
}

export type Action =
  | { kind: 'activateProphecy'; slot: string; face: 0 | 1; card: string }
  | { kind: 'returnDiscard'; card: string }
  | { kind: 'raiseTide' }
  | { kind: 'keep' | 'mulligan' | 'endTurn' | 'takeArchives' | 'takeSomeArchives' | 'leaveArchives' | 'done' }
  | { kind: 'forge'; color: KeyColor }
  | { kind: 'payForge'; source: string }
  | { kind: 'house'; house: House | null }
  | {
      kind: 'play';
      entryOverride?: true;
      card: string;
      otherHalf?: string;
      flank?: 'left' | 'right';
      position?: number;
      target?: string;
      permission?: number;
      copy?: string;
      asUpgrade?: true;
    }
  | { kind: 'discard' | 'reap' | 'use' | 'unstun'; card: string; ability?: number; permission?: number }
  | { kind: 'fight'; card: string; target: string; permission?: number }
  | { kind: 'select'; target: string }
  | { kind: 'order'; index: number }
  | { kind: 'choose'; option: string };

export interface PendingView {
  orientation?: {
    operation: 'ready' | 'exhaust' | 'stunExhaust';
    context: 'effect' | 'readyStep';
    remaining: number;
  };
  actionPayment?: { action: Action };
  entryStunned?: boolean;
  minimumPower?: number;
  kind: 'damage' | 'archive' | 'target' | 'order' | 'option' | 'use' | 'forge' | 'payment' | 'play';
  redistribution?: {
    resource: 'damage' | 'amber';
    player: Seat;
    total: number;
    assigned: Record<string, number>;
  };
  /** Public, uncommitted prompt preview; it has not changed card damage or consumed a Ward. */
  damagePreview?: { assigned: Record<string, number>; wardBreaks: string[] };
  source: string;
  actor: Seat;
  amount: number;
  reward: number;
  label?: string;
  selectedCount?: number;
  selected?: string[];
  payment?: Record<string, number>;
  forgeColor?: KeyColor;
  forgePlayer?: Seat;
  paymentSources?: Record<string, number>;
  min?: number;
  max?: number;
  allOrNone?: boolean;
  options?: {
    id: string;
    label: string;
    source?: string;
    /** Current public house-choice meaning; the option ID and native command remain unchanged. */
    house?: House;
  }[];
  intent?: DecisionIntent;
}

export type DecisionIntent =
  | {
      kind: 'house-restriction';
      target: Seat;
      rule: 'mustHouse' | 'cannotHouse';
      duration: 'nextTurn' | 'source';
      options: { id: string; house: House }[];
    }
  | { kind: 'target-operation'; operation: Operation }
  /** Exact native Infurnace menus, preserving their actual option IDs and one public pile. */
  | { kind: 'infurnace-pile'; options: { id: string; owner: Seat }[] }
  | { kind: 'infurnace-targets'; owner: Seat }
  | {
      kind: 'battleline-reorder';
      player: Seat;
      mode: 'full-order' | 'swap-pair';
      /** A currently legal Done that leaves the order unchanged; absent when Done commits a swap. */
      keepOrderActionId?: string;
    };

export type Operation =
  | 'deckBottom'
  | 'damage'
  | 'heal'
  | 'destroy'
  | 'stun'
  | 'unstun'
  | 'exhaust'
  | 'ready'
  | 'returnHand'
  | 'deckTop'
  | 'archive'
  | 'purge'
  | 'capture'
  | 'addAmber'
  | 'power'
  | 'discard'
  | 'stunExhaust'
  | 'captureOwn'
  | 'shuffleDeck'
  | 'takeAmber'
  | 'foreignArchive'
  | 'removeAmber'
  | 'removePower'
  | 'doom'
  | 'ward'
  | 'enrage'
  | 'exalt'
  | 'unward';

export interface LastingEffect {
  expiresAtTurnStart?: { player: Seat; turn: number };
  grantedEffects?: Effect[];
  copyTemplate?: CardDefinition;
  affectedName?: string;
  /** Public face at creation, retained after a token source leaves for a hidden zone. */
  publicSourceDefinition?: string;
  keyTaxValue?: Value;
  numericKeyword?: 'assault' | 'hazardous' | 'splashAttack';
  keywordAmount?: Value;
  keywords?: Keyword[];
  sourcePlay?: CardRef;
  afterPlayed?: number;
  countFilter?: Filter;
  begins?: number;
  house?: House;
  source: string;
  actor: Seat;
  appliesTo: Seat;
  turn: number;
  rule: LastingRule;
  amount: number;
}

export interface Revelation {
  /** Observation-only: card IDs identify historical public occurrences, not current physical objects. */
  historicalOnly?: true;
  turn: number;
  revision: number;
  audience: Seat | 'all';
  cards: { id: string; definition: string; name: string; owner: Seat; zone: string }[];
  label: string;
}

export interface PermissionView {
  id: number;
  source: string;
  mode: PermissionMode;
  remaining: number | null;
  uniqueRemaining: number | null;
  filter: Filter;
  bound: string[] | null;
  used: string[];
}

export interface CardEffect {
  /** GR-only explicit exclusive deadline; untilTurn remains the inclusive compatibility projection. */
  expiresAtTurnStart?: { player: Seat; turn: number };
  /** Captured public houses; duration is this precise source's in-play entry, not control. */
  sourceRef?: CardRef;
  houses?: House[];
  armor?: number;
  grantedEffects?: Effect[];
  houseChangeOrder?: number;
  marker?: CardMarker;
  lose?: Keyword[];
  keywords?: Keyword[];
  trait?: string;
  assault?: number;
  untilTurn?: number;
  house?: House;
  target: CardRef;
  source: string;
  turn: number;
  rule: CardEffectRule;
  amount: number;
}

export type CardEffectRule =
  | 'sourceHouses'
  | 'neighborHouse'
  | 'fixedPower'
  | 'fixedStats'
  | 'paintHouse'
  | 'splashBonus'
  | 'grantAfterFight'
  | 'noReadyThisTurn'
  | 'powerBonus'
  | 'addHouse'
  | 'swapPowerArmor'
  | 'blankWhileMarked'
  | 'skirmish'
  | 'noDamage'
  | 'flank'
  | 'marsHouse'
  | 'sanctumHouse'
  | 'assignedHouse'
  | 'armorZero'
  | 'afterReapDraw'
  | 'afterFightReady'
  | 'temporaryKeywords'
  | 'armorBonus'
  | 'loseTaunt'
  | 'loseElusive'
  | 'damagePlus'
  | 'assaultBonus'
  | 'afterFightSteal'
  | 'invulnerable';

export interface HouseRestriction {
  source: CardRef;
  house: House;
  player: Seat;
  rule: 'mustHouse' | 'cannotHouse';
  turn: number | null;
}

export const HOUSES: readonly LegacyHouse[] = ["brobnar","dis","logos","mars","sanctum","shadows","untamed"];

/** Public target-operation estimate, not an execution receipt or queue item. */
export interface ApplySpec { operation: Operation; amount?: Value; fullHeal?: boolean; ignoreArmor?: boolean; after?: { unmodeled?: true; when: "destroyed" | "affected" | "healed" | "notDestroyed" | "destroyedPower"; atLeast?: number; bindAffected?: string; effects: Effect[]; }; }
