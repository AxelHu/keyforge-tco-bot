/** Explicit schema boundary for the published heuristic knowledge projection. */
export const CARD_KNOWLEDGE_FIELDS: readonly string[] = [
  "unmodeled",
  "preventsReadyCapturedFriendlyDamage",
  "neighborTraits",
  "neighborHouse",
  "reapSourceConditions",
  "suppressesEnemyDestroyed",
  "forbidsArchiveStep",
  "forbidMorePowerfulCreaturePlay",
  "creaturePlayLimits",
  "entryEnragedCondition",
  "globalHauntedDrawBonus",
  "destroyFriendlyBeforeUse",
  "replacesEnemyActionPlayWithOwnLeftDestruction",
  "nextUseAlternatesFightReap",
  "protectsFriendlyTraits",
  "opponentDrawPenaltyValue",
  "cannotPlay",
  "cannotDiscardAsAction",
  "forgeRestrictions",
  "locksForeignArchives",
  "forbidsPreviousHouse",
  "grantsEnemyOmega",
  "onePlayPerType",
  "prohibitsForging",
  "enragesEnteringCreatures",
  "reapRestrictions",
  "playCondition",
  "incomingDamageMultipliers",
  "cannotBeDamagedCondition",
  "replacesEnemyCreatureReadyStep",
  "reapIncomeChosenCapture",
  "cannotReady",
  "useProhibitedIf",
  "returnFromDiscardCondition",
  "blanksArtifacts",
  "preventsCreatureDamage",
  "suppressesDestroyed",
  "bonusReplacements",
  "blocksOpponentBonusIcons",
  "drawBonusValue",
  "locksUsesOfStoredHouses",
  "maxControllerForgesPerTurn",
  "firstMutantDeathOwnerGain",
  "drawBonusIfOpponentRicher",
  "cannotStealCondition",
  "mimicCreature",
  "playAsUpgrade",
  "retainedUpgrade",
  "animation",
  "repeatFriendlyCreaturePlay",
  "friendlyPlayAsReap",
  "invulnerable",
  "invulnerableDuringFight",
  "invulnerableCondition",
  "forgeIntercept",
  "conditionalAbilities",
  "conditionalKeywords",
  "noPlayCreaturesWhileAhead",
  "destroyIfFlank",
  "entersOpponentControl",
  "supplyInsteadOfPool",
  "capturesReapIncome",
  "forbiddenKeyOrdinal",
  "cannotForgeAhead",
  "useRequiresNeighborsHouse",
  "powerBonus",
  "armorBonusValue",
  "keyTaxes",
  "offFlankDrawPenalty",
  "noDefenseDamage",
  "globalFightIfAble",
  "prohibitsEnemyReap",
  "prohibitsNeighborReap",
  "readyEntryKinds",
  "grantsAbilities",
  "alpha",
  "omega",
  "keywords",
  "assault",
  "hazardous",
  "splashAttack",
  "drawBonus",
  "opponentDrawPenalty",
  "globalDrawBonus",
  "centralDrawBonus",
  "opponentKeyTax",
  "selfPower",
  "anyHouseUse",
  "cannotReap",
  "noCombatDamage",
  "absorbsNeighborDamage",
  "evasionSigil",
  "ignoreTauntElusive",
  "destroyWithoutEnemy",
  "cannotStealFrom",
  "cannotStealWhileAmber",
  "minAmberToPlay",
  "playAmberCost",
  "requiresUntamedDiscard",
  "playLimitOpponent",
  "prohibitOwnCreatures",
  "opponentArtifactPlayTax",
  "opponentArtifactUseTax",
  "mustHouse",
  "damagedPowerBonus",
  "skipForgeStep",
  "capturesIncomingAmber",
  "purgeCreaturesLeavingPlay",
  "controlsHost",
  "mimicAction",
  "auras",
  "abilities",
  "reactions",
  "destroyedDestination",
  "upgrade",
  "tokenReference",
  "variant",
  "id",
  "name",
  "number",
  "house",
  "kind",
  "power",
  "armor",
  "amber",
  "traits",
  "summary",
  "summaryFeatures"
];
export const EFFECT_KNOWLEDGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "unmodeled": [
    "kind",
    "reason"
  ],
  "payOpponent": [
    "kind",
    "amount",
    "then",
    "unmodeled"
  ],
  "putSource": [
    "kind",
    "controller",
    "unmodeled"
  ],
  "cauldronStart": [
    "kind",
    "unmodeled"
  ],
  "eachPlayer": [
    "kind",
    "condition",
    "effects",
    "unmodeled"
  ],
  "bindDeckEdge": [
    "kind",
    "edge",
    "side",
    "count",
    "bind",
    "then",
    "unmodeled"
  ],
  "makeTokens": [
    "kind",
    "count",
    "side",
    "named",
    "bind",
    "then",
    "unmodeled"
  ],
  "makeToken": [
    "kind",
    "side",
    "named",
    "bind",
    "then",
    "unmodeled"
  ],
  "discardDeckEdge": [
    "kind",
    "edge",
    "count",
    "side",
    "bind",
    "then",
    "unmodeled"
  ],
  "orderedChild": [
    "kind",
    "effects",
    "then",
    "unmodeled"
  ],
  "destroyBoundAndThen": [
    "kind",
    "key",
    "bind",
    "then",
    "unmodeled"
  ],
  "tide": [
    "kind",
    "operation",
    "side",
    "unmodeled"
  ],
  "asPlayer": [
    "kind",
    "side",
    "effects",
    "unmodeled"
  ],
  "loseThen": [
    "kind",
    "side",
    "amount",
    "then",
    "unmodeled"
  ],
  "bindCards": [
    "kind",
    "filter",
    "bind",
    "then",
    "unmodeled"
  ],
  "randomArchive": [
    "kind",
    "amount",
    "side",
    "unmodeled"
  ],
  "forEach": [
    "kind",
    "count",
    "effects",
    "unmodeled"
  ],
  "gain": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "loseOpponent": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "capture": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "draw": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "healSelf": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "chains": [
    "kind",
    "amount",
    "unmodeled"
  ],
  "resource": [
    "kind",
    "operation",
    "amount",
    "side",
    "unmodeled"
  ],
  "steal": [
    "kind",
    "amount",
    "thenDamage",
    "then",
    "unmodeled"
  ],
  "damageChoice": [
    "kind",
    "amount",
    "rewardOnDestruction",
    "unmodeled"
  ],
  "archiveChoice": [
    "kind",
    "unmodeled"
  ],
  "sacrificeSelf": [
    "kind",
    "unmodeled"
  ],
  "skipForge": [
    "kind",
    "unmodeled"
  ],
  "finishAction": [
    "kind",
    "unmodeled"
  ],
  "if": [
    "kind",
    "condition",
    "then",
    "otherwise",
    "unmodeled"
  ],
  "target": [
    "kind",
    "filter",
    "max",
    "optional",
    "label",
    "operation",
    "amount",
    "fullHeal",
    "ignoreArmor",
    "after",
    "unmodeled"
  ],
  "all": [
    "kind",
    "filter",
    "operation",
    "amount",
    "fullHeal",
    "ignoreArmor",
    "after",
    "unmodeled"
  ],
  "self": [
    "kind",
    "operation",
    "amount",
    "fullHeal",
    "ignoreArmor",
    "after",
    "unmodeled"
  ],
  "randomDiscard": [
    "kind",
    "side",
    "amount",
    "zone",
    "operation",
    "unmodeled"
  ],
  "archiveTop": [
    "kind",
    "side",
    "unmodeled"
  ],
  "choose": [
    "kind",
    "label",
    "options",
    "unmodeled"
  ],
  "chooseHouse": [
    "kind",
    "from",
    "then",
    "unmodeled"
  ],
  "chooseCards": [
    "kind",
    "distinctNames",
    "distinctHouses",
    "min",
    "allOrNone",
    "minimumPower",
    "filter",
    "bind",
    "max",
    "optional",
    "then",
    "label",
    "unmodeled"
  ],
  "bound": [
    "kind",
    "key",
    "operation",
    "amount",
    "fullHeal",
    "ignoreArmor",
    "after",
    "unmodeled"
  ],
  "reveal": [
    "kind",
    "filter",
    "unmodeled"
  ],
  "recur": [
    "kind",
    "count",
    "effects",
    "unmodeled"
  ],
  "lasting": [
    "kind",
    "rule",
    "side",
    "amount",
    "duration",
    "countFilter",
    "house",
    "unmodeled"
  ],
  "permission": [
    "kind",
    "mode",
    "filter",
    "unmodeled"
  ],
  "useChoice": [
    "kind",
    "filter",
    "mode",
    "optional",
    "after",
    "unmodeled"
  ],
  "forgeEffect": [
    "kind",
    "color",
    "minimumCost",
    "delta",
    "reduction",
    "fixedCost",
    "optional",
    "after",
    "unmodeled"
  ],
  "storeAmber": [
    "kind",
    "unmodeled"
  ],
  "takeControl": [
    "kind",
    "key",
    "whileSource",
    "house",
    "side",
    "unmodeled"
  ]
};
