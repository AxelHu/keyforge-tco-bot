/** 独立玩家观测；完整静态知识类型与游戏执行状态分离。 */
import type { BonusIcon, CardDefinition, CardKind, CardMarker, Condition, Filter, House, KeyColor, Keyword, LegacyHouse, Side, Trigger, Value } from '../knowledge/card-types.js';
export type { Aura, BonusIcon, CardDefinition, CardFacts, CardKind, CardMarker, Condition, Filter, House, KeyColor, Keyword, LegacyHouse, Reaction, RuleInterpretationNote, Side, Trigger, Value, Zone } from '../knowledge/card-types.js';
import type { UninterpretedStaticEffect } from '../knowledge/static-rule-kinds.js';


export interface Command {
  actor: Seat;
  revision: number;
  actionId: string;
}

export type Seat = 0 | 1;

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

/** Typed scoring shapes plus intact static rules that the bounded scorer may not interpret. */
export type Effect = UninterpretedStaticEffect | {kind:"unmodeled";reason?:string} | { unmodeled?: true; kind: "payOpponent";
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
      selection?: { ability: Trigger; path: (string | number)[] };
    }
  | { kind: 'house-choice'; options: { id: string; house: House }[]; selection?: { ability: Trigger; path: (string | number)[] } }
  /** A uniquely matched current choice in the visible source's public ability tree. */
  | { kind: 'effect-choice'; ability: Trigger; path: (string | number)[] }
  | { kind: 'effect-selection'; ability: Trigger; path: (string | number)[] }
  | { kind: 'prophecy-face-choice'; slot: string; options: { id: string; operation: 'flip' | 'keep' }[] }
  | { kind: 'play-from-under' }
  | { kind: 'target-operation'; operation: Operation; selection?: { ability: Trigger; path: (string | number)[] } }
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
