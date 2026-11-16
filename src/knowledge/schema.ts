/** 完整静态知识的字段边界；允许数据描述，不包含运行态 frame/queue 或执行代码。 */
export const CARD_KNOWLEDGE_FIELDS: readonly string[] = [
  "abilities",
  "absorbsNeighborDamage",
  "afterAttach",
  "alpha",
  "amber",
  "animation",
  "anyHouseUse",
  "armor",
  "armorBonusValue",
  "assault",
  "attackerBeforeFight",
  "attackingIgnores",
  "auras",
  "blanksArtifacts",
  "blocksOpponentBonusIcons",
  "bonusReplacements",
  "cannotBeDamagedCondition",
  "cannotDiscardAsAction",
  "cannotFight",
  "cannotForgeAhead",
  "cannotPlay",
  "cannotReady",
  "cannotReadyUnlessHaunted",
  "cannotReap",
  "cannotStealCondition",
  "cannotStealFrom",
  "cannotStealWhileAmber",
  "capturesIncomingAmber",
  "capturesReapIncome",
  "centralDrawBonus",
  "combatDamageMaximum",
  "conditionalAbilities",
  "conditionalKeywords",
  "controlsHost",
  "creaturePlayLimits",
  "damagedBrobnarKeyTax",
  "damagedPowerBonus",
  "deploy",
  "destroyFriendlyBeforeUse",
  "destroyIfFlank",
  "destroyWhenNoCreatures",
  "destroyWithoutEnemy",
  "destroyedDestination",
  "discardDrawReplacement",
  "drawBonus",
  "drawBonusIfOpponentRicher",
  "drawBonusValue",
  "enemyEntryStunnedCondition",
  "enragesEnteringCreatures",
  "entersEnraged",
  "entersOpponentControl",
  "entersReady",
  "entersReadyAfterUse",
  "entersStunned",
  "entryEnragedCondition",
  "entryReadyCondition",
  "evasionSigil",
  "faceupSelectiveArchives",
  "fightOnlyStunned",
  "fightTargetRules",
  "firstCreatureReady",
  "firstMutantDeathOwnerGain",
  "firstShadowDiscardSteal",
  "flankAttackBonus",
  "flankKeyDiscount",
  "forbidMorePowerfulCreaturePlay",
  "forbiddenKeyOrdinal",
  "forbidsArchiveStep",
  "forbidsEnemyRightFlankPlay",
  "forbidsPreviousHouse",
  "forgeIntercept",
  "forgeLosesRemaining",
  "forgeRestrictions",
  "friendlyAmberSpendCondition",
  "friendlyPlayAsReap",
  "globalDrawBonus",
  "globalFightIfAble",
  "globalHauntedDrawBonus",
  "grantsAbilities",
  "grantsCenterOutOfHousePlay",
  "grantsEnemyOmega",
  "grantsOutOfHousePlay",
  "grantsOutOfHousePlayKind",
  "hauntedWithPurged",
  "hazardous",
  "house",
  "id",
  "ignoreArmorWhenAttacking",
  "ignoreTaunt",
  "ignoreTauntElusive",
  "incomingDamageMultipliers",
  "inheritsFriendlyKeywords",
  "invulnerable",
  "invulnerableCondition",
  "invulnerableDuringFight",
  "keyTaxes",
  "keywords",
  "kind",
  "locksForeignArchives",
  "locksUsesOfStoredHouses",
  "markerDestructions",
  "maxControllerForgesPerTurn",
  "mimicAction",
  "mimicCreature",
  "minAmberToPlay",
  "mineralizesCounters",
  "mustHouse",
  "name",
  "neighborHouse",
  "neighborTraits",
  "neighborUseAsHouse",
  "nextUseAlternatesFightReap",
  "noCombatDamage",
  "noCombatDamageCondition",
  "noDefenseDamage",
  "noPlayCreaturesWhileAhead",
  "number",
  "numericKeywordBonuses",
  "observesForgePayment",
  "offFlankDrawPenalty",
  "omega",
  "onePlayPerType",
  "onlyAttackFlanks",
  "opponentArtifactPlayTax",
  "opponentArtifactUseTax",
  "opponentDrawPenalty",
  "opponentDrawPenaltyValue",
  "opponentKeyTax",
  "opponentPoolForgeLimit",
  "playAmberCost",
  "playAsUpgrade",
  "playCondition",
  "playLimitOpponent",
  "poisonAttackingFlank",
  "power",
  "powerBonus",
  "preventsCreatureDamage",
  "preventsFriendlyExhaustionOffTurn",
  "preventsReadyCapturedFriendlyDamage",
  "prohibitOwnCreatures",
  "prohibitsEnemyReap",
  "prohibitsForging",
  "prohibitsNeighborReap",
  "protectsFriendlyTraits",
  "purgeCreaturesLeavingPlay",
  "purgeWhenNoCreatures",
  "reactions",
  "readyAfterSplashKill",
  "readyEnteringNeighbors",
  "readyEntryKinds",
  "readyEntryRules",
  "readyIfHaunted",
  "readyStepRestrictions",
  "reapIncomeChosenCapture",
  "reapRestrictions",
  "reapSourceConditions",
  "receivesForgePayment",
  "removesCreatureArmor",
  "removesCreatureKeywords",
  "repeatFriendlyCreaturePlay",
  "replacesDealtDamageWithSteal",
  "replacesEnemyActionPlayWithOwnLeftDestruction",
  "replacesEnemyCreatureReadyStep",
  "replacesStealWithCapture",
  "requiresUntamedDiscard",
  "retainedUpgrade",
  "retainedUpgradeOnArtifacts",
  "returnFromDiscardCondition",
  "returnFromDiscardOnHouse",
  "revealsDeckTop",
  "ruleInterpretations",
  "selfPower",
  "sharesNeighborFightDamage",
  "skipForgeConditions",
  "skipForgeStep",
  "spendAmberForKeys",
  "spendFriendlyCreatureAmberForKeys",
  "spendSelfAsAmber",
  "spendStoredAmberAsPool",
  "splashAttack",
  "startTurnFromDiscard",
  "summary",
  "summaryFeatures",
  "supplyInsteadOfPool",
  "suppressesDestroyed",
  "suppressesEnemyDestroyed",
  "suppressesFriendlyAfterFight",
  "tauntDistance",
  "tokenReference",
  "traits",
  "unmodeled",
  "upgrade",
  "useAsNeighborHouse",
  "useProhibitedIf",
  "useRequiresNeighborsHouse",
  "variant"
];
export const EFFECT_KNOWLEDGE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "addHouse": [
    "key",
    "kind",
    "unmodeled"
  ],
  "all": [
    "after",
    "allAmber",
    "amount",
    "filter",
    "fullHeal",
    "ignoreArmor",
    "kind",
    "operation",
    "unmodeled"
  ],
  "animateArtifact": [
    "key",
    "kind",
    "unmodeled"
  ],
  "animateAttachedArtifact": [
    "kind",
    "unmodeled"
  ],
  "animateSelf": [
    "anywhere",
    "kind",
    "power",
    "unmodeled"
  ],
  "archiveChoice": [
    "kind",
    "unmodeled"
  ],
  "archiveTop": [
    "kind",
    "side",
    "unmodeled"
  ],
  "archiveWithUpgrades": [
    "kind",
    "unmodeled"
  ],
  "asBoundController": [
    "effects",
    "key",
    "kind",
    "unmodeled"
  ],
  "asPlayer": [
    "effects",
    "kind",
    "side",
    "unmodeled"
  ],
  "assignHouse": [
    "house",
    "key",
    "kind",
    "unmodeled"
  ],
  "assignSourceHouses": [
    "key",
    "kind",
    "unmodeled"
  ],
  "attachedHost": [
    "after",
    "amount",
    "fullHeal",
    "includeNeighbors",
    "kind",
    "operation",
    "unmodeled"
  ],
  "aurascopeDiscard": [
    "key",
    "kind",
    "unmodeled"
  ],
  "awakenSelected": [
    "key",
    "kind",
    "unmodeled"
  ],
  "barterReveal": [
    "kind",
    "receipts",
    "remaining",
    "unmodeled"
  ],
  "bindCards": [
    "bind",
    "filter",
    "kind",
    "then",
    "unmodeled"
  ],
  "bindDeckEdge": [
    "bind",
    "count",
    "edge",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "bindDiscardSubset": [
    "bind",
    "count",
    "edge",
    "filter",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "bindPhysicalCards": [
    "bind",
    "key",
    "kind",
    "then",
    "unmodeled"
  ],
  "bindRandom": [
    "bind",
    "kind",
    "side",
    "then",
    "unmodeled",
    "zone"
  ],
  "bindTop": [
    "bind",
    "count",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "blankBoostNamed": [
    "amount",
    "kind",
    "name",
    "unmodeled"
  ],
  "blasterChoice": [
    "kind",
    "name",
    "unmodeled"
  ],
  "bonusNext": [
    "extra",
    "kind",
    "unmodeled"
  ],
  "borrowedPlay": [
    "kind",
    "unmodeled",
    "zone"
  ],
  "bottomBound": [
    "from",
    "key",
    "kind",
    "unmodeled"
  ],
  "bottomPlayedActionEvent": [
    "kind",
    "unmodeled"
  ],
  "bound": [
    "after",
    "allAmber",
    "amount",
    "archiveTo",
    "discardShuffle",
    "followPublic",
    "fullHeal",
    "ignoreArmor",
    "includeNeighbors",
    "key",
    "kind",
    "operation",
    "unmodeled"
  ],
  "cancelOwnDestruction": [
    "controlTo",
    "kind",
    "then",
    "unmodeled"
  ],
  "capture": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "captureBoundFromEligiblePlayers": [
    "amount",
    "condition",
    "key",
    "kind",
    "unmodeled"
  ],
  "captureDistribution": [
    "amount",
    "key",
    "kind",
    "unmodeled"
  ],
  "captureFromPools": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "cardEffect": [
    "amount",
    "key",
    "kind",
    "rule",
    "unmodeled"
  ],
  "cauldronStart": [
    "kind",
    "unmodeled"
  ],
  "chains": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "changeActiveHouse": [
    "key",
    "kind",
    "unmodeled"
  ],
  "choose": [
    "kind",
    "label",
    "options",
    "unmodeled"
  ],
  "chooseCardNames": [
    "count",
    "kind",
    "then",
    "unmodeled"
  ],
  "chooseCards": [
    "allOrNone",
    "bind",
    "distinctHouses",
    "distinctNames",
    "filter",
    "kind",
    "label",
    "max",
    "min",
    "minimumPower",
    "optional",
    "then",
    "unmodeled"
  ],
  "chooseFewestController": [
    "kind",
    "unmodeled"
  ],
  "chooseForbiddenName": [
    "duration",
    "kind",
    "unmodeled"
  ],
  "chooseHouse": [
    "from",
    "kind",
    "then",
    "unmodeled"
  ],
  "chooseHouseRestriction": [
    "duration",
    "kind",
    "rule",
    "unmodeled"
  ],
  "chooseNumber": [
    "kind",
    "label",
    "limit",
    "then",
    "unmodeled"
  ],
  "chooseTrait": [
    "kind",
    "then",
    "unmodeled"
  ],
  "churnOpponentHand": [
    "kind",
    "unmodeled"
  ],
  "clearBoundCreatureCounters": [
    "key",
    "kind",
    "unmodeled"
  ],
  "collectBoundAmber": [
    "key",
    "kind",
    "unmodeled"
  ],
  "collectBoundAmberToControllers": [
    "key",
    "kind",
    "unmodeled"
  ],
  "collectSearched": [
    "chains",
    "destination",
    "key",
    "kind",
    "unmodeled"
  ],
  "combatOpponent": [
    "amount",
    "followPublic",
    "includeNeighbors",
    "kind",
    "operation",
    "splash",
    "unmodeled"
  ],
  "combineBindings": [
    "bind",
    "keys",
    "kind",
    "then",
    "unmodeled"
  ],
  "controlTransferSequence": [
    "count",
    "from",
    "kind",
    "then",
    "to",
    "unmodeled"
  ],
  "convertCardsToTokens": [
    "from",
    "key",
    "kind",
    "unmodeled"
  ],
  "copyFriendlyTokens": [
    "kind",
    "unmodeled"
  ],
  "copyReap": [
    "key",
    "kind",
    "unmodeled"
  ],
  "crazyStart": [
    "kind",
    "unmodeled"
  ],
  "creaturePowerDamage": [
    "first",
    "kind",
    "relation",
    "second",
    "unmodeled"
  ],
  "damageChoice": [
    "amount",
    "kind",
    "rewardOnDestruction",
    "unmodeled"
  ],
  "damageFromCounters": [
    "counter",
    "filter",
    "kind",
    "unmodeled"
  ],
  "damageFromOpponent": [
    "filter",
    "kind",
    "unmodeled"
  ],
  "damageGroups": [
    "groups",
    "kind",
    "unmodeled"
  ],
  "damagePerHouse": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "departedNeighbors": [
    "amount",
    "key",
    "kind",
    "operation",
    "unmodeled"
  ],
  "destroyBoundAndThen": [
    "awaitChildren",
    "bind",
    "key",
    "kind",
    "then",
    "unmodeled"
  ],
  "destroyDiscardedHouseMatches": [
    "kind",
    "unmodeled"
  ],
  "destroyHostMoveLinked": [
    "kind",
    "unmodeled"
  ],
  "destroyReadiedSelf": [
    "kind",
    "unmodeled"
  ],
  "discardBorrowedCard": [
    "kind",
    "unmodeled",
    "zone"
  ],
  "discardBothTop": [
    "bind",
    "kind",
    "then",
    "unmodeled"
  ],
  "discardDeckEdge": [
    "bind",
    "bindKind",
    "count",
    "edge",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "discardPileTop": [
    "kind",
    "operation",
    "side",
    "unmodeled"
  ],
  "discardSequence": [
    "allHand",
    "key",
    "kind",
    "tallyAmber",
    "then",
    "unmodeled"
  ],
  "discardTopSequential": [
    "bind",
    "count",
    "kind",
    "result",
    "side",
    "then",
    "unmodeled"
  ],
  "discardUntil": [
    "house",
    "kind",
    "unmodeled"
  ],
  "divideBattlelines": [
    "kind",
    "unmodeled"
  ],
  "doublePowerCounters": [
    "filter",
    "kind",
    "unmodeled"
  ],
  "draw": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "drawStealWhileAhead": [
    "kind",
    "unmodeled"
  ],
  "dynamicKeyTax": [
    "amount",
    "kind",
    "side",
    "unmodeled"
  ],
  "eachPlayer": [
    "condition",
    "effects",
    "kind",
    "unmodeled"
  ],
  "endActionStep": [
    "kind",
    "unmodeled"
  ],
  "eventCard": [
    "after",
    "amount",
    "kind",
    "operation",
    "unmodeled"
  ],
  "exchangeNeighborCounters": [
    "key",
    "kind",
    "unmodeled"
  ],
  "finalRefrain": [
    "kind",
    "unmodeled"
  ],
  "finishAction": [
    "kind",
    "unmodeled"
  ],
  "fixedBoundStats": [
    "armor",
    "key",
    "kind",
    "power",
    "unmodeled"
  ],
  "fixedEnemyHorde": [
    "kind",
    "unmodeled"
  ],
  "flipCards": [
    "direction",
    "filter",
    "kind",
    "unmodeled"
  ],
  "forEach": [
    "awaitChildren",
    "count",
    "effects",
    "kind",
    "unmodeled"
  ],
  "forEachCard": [
    "bind",
    "effects",
    "filter",
    "kind",
    "unmodeled"
  ],
  "forgeEffect": [
    "after",
    "color",
    "delta",
    "fixedCost",
    "kind",
    "minimumCost",
    "optional",
    "reduction",
    "unmodeled"
  ],
  "gain": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "gainNeighborText": [
    "key",
    "kind",
    "unmodeled"
  ],
  "givePoolThen": [
    "amount",
    "kind",
    "then",
    "unmodeled"
  ],
  "graftAction": [
    "kind",
    "unmodeled"
  ],
  "grantAfterFight": [
    "effects",
    "key",
    "kind",
    "unmodeled"
  ],
  "grantCreatureKeywords": [
    "duration",
    "keywords",
    "kind",
    "unmodeled"
  ],
  "grantEnemyDestroyed": [
    "effects",
    "kind",
    "unmodeled"
  ],
  "grantFriendlyAfterFight": [
    "effects",
    "kind",
    "unmodeled"
  ],
  "grantFriendlyReap": [
    "effects",
    "kind",
    "unmodeled"
  ],
  "grantNamedAfterFight": [
    "effects",
    "kind",
    "name",
    "unmodeled"
  ],
  "grantNumericKeyword": [
    "amount",
    "keyword",
    "kind",
    "unmodeled"
  ],
  "grantText": [
    "chosen",
    "kind",
    "revealed",
    "unmodeled"
  ],
  "healSelf": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "if": [
    "condition",
    "kind",
    "otherwise",
    "then",
    "unmodeled"
  ],
  "ifBoundHouse": [
    "house",
    "key",
    "kind",
    "otherwise",
    "then",
    "unmodeled"
  ],
  "ifHouse": [
    "house",
    "kind",
    "then",
    "unmodeled"
  ],
  "ifNamedCards": [
    "key",
    "kind",
    "then",
    "unmodeled"
  ],
  "infinityStropDamage": [
    "key",
    "kind",
    "unmodeled"
  ],
  "inspectTop": [
    "bind",
    "count",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "jettisonDiscard": [
    "key",
    "kind",
    "unmodeled"
  ],
  "lastNeighbors": [
    "amount",
    "key",
    "kind",
    "unmodeled"
  ],
  "lasting": [
    "amount",
    "countFilter",
    "duration",
    "house",
    "kind",
    "rule",
    "side",
    "unmodeled"
  ],
  "linkedUpgradeCreature": [
    "flank",
    "kind",
    "ready",
    "unmodeled"
  ],
  "loseFromBoth": [
    "amount",
    "kind",
    "then",
    "unmodeled"
  ],
  "loseOpponent": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "loseThen": [
    "amount",
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "magnetUpgrades": [
    "key",
    "kind",
    "unmodeled"
  ],
  "makeToken": [
    "bind",
    "fixedFlank",
    "kind",
    "named",
    "neighborTraitAtEntry",
    "relativeToSource",
    "side",
    "then",
    "unmodeled"
  ],
  "makeTokens": [
    "bind",
    "count",
    "kind",
    "named",
    "side",
    "then",
    "unmodeled"
  ],
  "millUntil": [
    "bind",
    "kind",
    "stop",
    "then",
    "unmodeled"
  ],
  "moveAmberToDefender": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "moveBoundAmber": [
    "amount",
    "from",
    "kind",
    "to",
    "unmodeled"
  ],
  "moveBoundDamage": [
    "kind",
    "to",
    "unmodeled"
  ],
  "moveBoundUpgrade": [
    "key",
    "kind",
    "unmodeled"
  ],
  "moveInBattleline": [
    "key",
    "kind",
    "optional",
    "then",
    "unmodeled"
  ],
  "moveNamedMarkers": [
    "amount",
    "kind",
    "name",
    "to",
    "toLinked",
    "unmodeled"
  ],
  "movePoolToBound": [
    "amount",
    "from",
    "key",
    "kind",
    "unmodeled"
  ],
  "movePoolToLinked": [
    "amount",
    "kind",
    "unmodeled"
  ],
  "movePoolToSource": [
    "amount",
    "kind",
    "side",
    "unmodeled"
  ],
  "movePowerCounters": [
    "filter",
    "kind",
    "unmodeled"
  ],
  "moveToFlank": [
    "key",
    "kind",
    "unmodeled"
  ],
  "moveWard": [
    "from",
    "kind",
    "to",
    "unmodeled"
  ],
  "namedMarkers": [
    "amount",
    "blankWhilePresent",
    "key",
    "kind",
    "name",
    "operation",
    "then",
    "unmodeled"
  ],
  "neighborHouseChain": [
    "key",
    "kind",
    "unmodeled"
  ],
  "nextCreatureEntry": [
    "kind",
    "unmodeled"
  ],
  "nextReady": [
    "afterFight",
    "filter",
    "kind",
    "unmodeled"
  ],
  "offerRetainedPlay": [
    "definition",
    "kind",
    "onlyCreature",
    "unmodeled",
    "zone"
  ],
  "oldBoomy": [
    "cards",
    "kind",
    "unmodeled"
  ],
  "orderedChild": [
    "effects",
    "kind",
    "then",
    "unmodeled"
  ],
  "paintArtifact": [
    "key",
    "kind",
    "unmodeled"
  ],
  "payDiscardTop": [
    "amount",
    "bind",
    "kind",
    "then",
    "unmodeled"
  ],
  "payOpponent": [
    "amount",
    "kind",
    "then",
    "unmodeled",
    "upTo"
  ],
  "payOpponentOne": [
    "kind",
    "then",
    "unmodeled"
  ],
  "permission": [
    "bound",
    "filter",
    "kind",
    "limit",
    "mode",
    "uniqueLimit",
    "unmodeled"
  ],
  "placeholderLoop": [
    "kind",
    "unmodeled"
  ],
  "planTenRelease": [
    "kind",
    "unmodeled"
  ],
  "planTenStore": [
    "kind",
    "unmodeled"
  ],
  "playBound": [
    "afterPlay",
    "anywhere",
    "fromHand",
    "key",
    "kind",
    "onlyUpgradeHost",
    "unmodeled"
  ],
  "playBoundSequence": [
    "key",
    "kind",
    "unmodeled",
    "zone"
  ],
  "playCreatureFromHand": [
    "house",
    "kind",
    "stunned",
    "unmodeled"
  ],
  "playHandChoice": [
    "filter",
    "kind",
    "optional",
    "unmodeled"
  ],
  "playOpponentHand": [
    "kind",
    "unmodeled"
  ],
  "playOwnTop": [
    "kind",
    "unmodeled"
  ],
  "playUnder": [
    "kind",
    "unmodeled"
  ],
  "plunderHand": [
    "kind",
    "unmodeled"
  ],
  "predictTopHouse": [
    "kind",
    "unmodeled"
  ],
  "preserveOnePer": [
    "kind",
    "property",
    "unmodeled"
  ],
  "purgeAndResolveIcons": [
    "key",
    "kind",
    "unmodeled"
  ],
  "purgeCopyCharacteristics": [
    "key",
    "kind",
    "unmodeled"
  ],
  "purgeForReturn": [
    "filter",
    "kind",
    "unmodeled"
  ],
  "purgeStoredCards": [
    "kind",
    "unmodeled"
  ],
  "putBound": [
    "afterEntry",
    "controller",
    "entryReady",
    "followPublic",
    "from",
    "key",
    "kind",
    "powerCounters",
    "ready",
    "unmodeled"
  ],
  "putCombatOpponent": [
    "kind",
    "unmodeled"
  ],
  "putFromHandsReady": [
    "kind",
    "unmodeled"
  ],
  "putMilledCreature": [
    "key",
    "kind",
    "unmodeled"
  ],
  "putRevealedHand": [
    "kind",
    "ready",
    "side",
    "unmodeled"
  ],
  "putSearched": [
    "key",
    "kind",
    "unmodeled"
  ],
  "putSource": [
    "controller",
    "kind",
    "unmodeled"
  ],
  "pvBanBoundType": [
    "duration",
    "key",
    "kind",
    "side",
    "unmodeled"
  ],
  "pvCladogenesis": [
    "kind",
    "unmodeled"
  ],
  "pvForgeStepAgain": [
    "kind",
    "unmodeled"
  ],
  "pvMoveSourceCounters": [
    "amount",
    "key",
    "kind",
    "unmodeled"
  ],
  "pvParallelArchives": [
    "kind",
    "side",
    "unmodeled"
  ],
  "pvParallelCheck": [
    "key",
    "kind",
    "unmodeled"
  ],
  "pvPlayDeckTop": [
    "changeHouse",
    "kind",
    "side",
    "unmodeled"
  ],
  "pvRecoveryTop": [
    "key",
    "kind",
    "unmodeled"
  ],
  "pvScheduleAtrocity": [
    "kind",
    "unmodeled"
  ],
  "pvSoulLockDiscard": [
    "kind",
    "unmodeled"
  ],
  "pvSoulLockStore": [
    "key",
    "kind",
    "unmodeled"
  ],
  "pvTradeDamage": [
    "enemy",
    "friendly",
    "kind",
    "unmodeled"
  ],
  "randomArchive": [
    "amount",
    "kind",
    "side",
    "unmodeled"
  ],
  "randomCard": [
    "bind",
    "kind",
    "side",
    "then",
    "unmodeled",
    "zone"
  ],
  "randomDeckTop": [
    "filter",
    "kind",
    "unmodeled"
  ],
  "randomDiscard": [
    "amount",
    "kind",
    "operation",
    "side",
    "unmodeled",
    "zone"
  ],
  "randomHandOffer": [
    "kind",
    "unmodeled"
  ],
  "reattachLinked": [
    "key",
    "kind",
    "unmodeled"
  ],
  "rebindAfterPublicMove": [
    "bind",
    "filter",
    "key",
    "kind",
    "then",
    "unmodeled",
    "zone"
  ],
  "recur": [
    "count",
    "effects",
    "kind",
    "unmodeled"
  ],
  "redHotArmor": [
    "kind",
    "unmodeled"
  ],
  "redirectCombat": [
    "key",
    "kind",
    "unmodeled"
  ],
  "redistribute": [
    "allCreatures",
    "kind",
    "optional",
    "resource",
    "side",
    "unmodeled"
  ],
  "refill": [
    "kind",
    "side",
    "unmodeled"
  ],
  "registerLeave": [
    "effects",
    "kind",
    "unmodeled"
  ],
  "releaseStoredCreature": [
    "kind",
    "unmodeled"
  ],
  "reorderZone": [
    "count",
    "excludeSource",
    "kind",
    "side",
    "then",
    "unmodeled",
    "zone"
  ],
  "repeatPrinted": [
    "condition",
    "kind",
    "optional",
    "trigger",
    "unmodeled"
  ],
  "repeatScrap": [
    "kind",
    "unmodeled"
  ],
  "repeatTarget": [
    "amount",
    "count",
    "filter",
    "kind",
    "label",
    "operation",
    "splash",
    "unmodeled"
  ],
  "resolveCardIcons": [
    "key",
    "kind",
    "unmodeled"
  ],
  "resolveControllerTopMatch": [
    "key",
    "kind",
    "unmodeled"
  ],
  "resolveUnder": [
    "kind",
    "unmodeled"
  ],
  "resource": [
    "amount",
    "kind",
    "operation",
    "side",
    "unmodeled"
  ],
  "restoreOwners": [
    "kind",
    "unmodeled"
  ],
  "restrictHouse": [
    "house",
    "kind",
    "player",
    "rule",
    "unmodeled"
  ],
  "returnBoundBottom": [
    "key",
    "kind",
    "then",
    "unmodeled"
  ],
  "returnCombatVictim": [
    "kind",
    "unmodeled"
  ],
  "returnWithUpgrades": [
    "key",
    "kind",
    "unmodeled"
  ],
  "reveal": [
    "audience",
    "filter",
    "kind",
    "unmodeled"
  ],
  "revealHandCreature": [
    "bind",
    "kind",
    "then",
    "unmodeled"
  ],
  "reverseTime": [
    "kind",
    "unmodeled"
  ],
  "sacrificeSelf": [
    "kind",
    "unmodeled"
  ],
  "sacrificeThen": [
    "kind",
    "then",
    "unmodeled"
  ],
  "scheduleActionReturn": [
    "kind",
    "unmodeled"
  ],
  "scheduleTopReplacement": [
    "kind",
    "unmodeled"
  ],
  "screeyanTopDiscard": [
    "kind",
    "unmodeled"
  ],
  "seekDeck": [
    "filter",
    "kind",
    "result",
    "unmodeled"
  ],
  "self": [
    "after",
    "amount",
    "fullHeal",
    "ignoreArmor",
    "includeNeighbors",
    "kind",
    "operation",
    "unmodeled"
  ],
  "setActiveHouseFromChoice": [
    "kind",
    "unmodeled"
  ],
  "setBoundPower": [
    "key",
    "kind",
    "power",
    "unmodeled"
  ],
  "shatterStorm": [
    "kind",
    "unmodeled"
  ],
  "shelfDamage": [
    "kind",
    "unmodeled"
  ],
  "shuffleFriendlyIntoDeck": [
    "drawPerCard",
    "kind",
    "unmodeled"
  ],
  "shuffleSourceWithDiscardTop": [
    "kind",
    "unmodeled"
  ],
  "shuffleZones": [
    "archives",
    "discard",
    "hand",
    "kind",
    "side",
    "unmodeled"
  ],
  "skipForge": [
    "kind",
    "unmodeled"
  ],
  "skipNextForge": [
    "kind",
    "side",
    "unmodeled"
  ],
  "skollRelease": [
    "kind",
    "unmodeled"
  ],
  "spanglerPurge": [
    "key",
    "kind",
    "unmodeled"
  ],
  "steal": [
    "amount",
    "kind",
    "then",
    "thenDamage",
    "unmodeled"
  ],
  "storeAmber": [
    "kind",
    "unmodeled"
  ],
  "storeDiscardedEventUnder": [
    "kind",
    "unmodeled"
  ],
  "storeSourceUnderLinked": [
    "kind",
    "unmodeled"
  ],
  "suppressNextReadyStep": [
    "kind",
    "player",
    "target",
    "unmodeled"
  ],
  "suppressReadyThisTurn": [
    "kind",
    "target",
    "unmodeled"
  ],
  "swapBound": [
    "grantUse",
    "key",
    "kind",
    "unmodeled"
  ],
  "swapControl": [
    "combatOpponent",
    "first",
    "kind",
    "second",
    "unmodeled"
  ],
  "swapHandDiscard": [
    "discard",
    "hand",
    "kind",
    "unmodeled"
  ],
  "swapPositions": [
    "key",
    "kind",
    "unmodeled"
  ],
  "swapPowerArmor": [
    "key",
    "kind",
    "unmodeled"
  ],
  "takeBoundAmber": [
    "amount",
    "key",
    "kind",
    "unmodeled"
  ],
  "takeControl": [
    "flank",
    "house",
    "key",
    "kind",
    "retainHouseWhileControllerUnchanged",
    "shadowHouse",
    "side",
    "unmodeled",
    "whileSource"
  ],
  "takeUnderToHand": [
    "kind",
    "unmodeled"
  ],
  "target": [
    "after",
    "allAmber",
    "amount",
    "archiveReturnToOwner",
    "archiveTo",
    "filter",
    "fullHeal",
    "ignoreArmor",
    "includeNeighbors",
    "kind",
    "label",
    "max",
    "operation",
    "optional",
    "splash",
    "unmodeled"
  ],
  "targetCount": [
    "count",
    "filter",
    "kind",
    "operation",
    "unmodeled"
  ],
  "temporaryKeywords": [
    "assault",
    "duration",
    "key",
    "keywords",
    "kind",
    "lose",
    "trait",
    "unmodeled"
  ],
  "tide": [
    "kind",
    "operation",
    "side",
    "unmodeled"
  ],
  "topCard": [
    "bind",
    "kind",
    "operation",
    "side",
    "then",
    "unmodeled",
    "zone"
  ],
  "transferPool": [
    "amount",
    "from",
    "kind",
    "to",
    "unmodeled"
  ],
  "triggerGraft": [
    "kind",
    "unmodeled"
  ],
  "triggerPlay": [
    "key",
    "kind",
    "unmodeled"
  ],
  "trimHands": [
    "kind",
    "limit",
    "then",
    "unmodeled"
  ],
  "underCard": [
    "faceUp",
    "from",
    "key",
    "kind",
    "unmodeled"
  ],
  "underFromPlay": [
    "anyController",
    "key",
    "kind",
    "unmodeled"
  ],
  "unforgeChoice": [
    "kind",
    "side",
    "then",
    "unmodeled"
  ],
  "unforgePrevious": [
    "kind",
    "unmodeled"
  ],
  "unmodeled": [
    "kind",
    "reason",
    "unmodeled"
  ],
  "useBound": [
    "asIf",
    "key",
    "kind",
    "mode",
    "ready",
    "unmodeled"
  ],
  "useChoice": [
    "after",
    "afterSuccessful",
    "asIf",
    "differentUsers",
    "distinctDefenders",
    "filter",
    "kind",
    "mode",
    "optional",
    "ready",
    "remaining",
    "rememberDefender",
    "sameUserTimes",
    "unmodeled"
  ],
  "useNeighborSides": [
    "awaitChildren",
    "kind",
    "mode",
    "optional",
    "ready",
    "secondOnlyAtHighTide",
    "unmodeled"
  ],
  "vaporImpDiscard": [
    "key",
    "kind",
    "unmodeled"
  ],
  "withAmount": [
    "kind",
    "then",
    "unmodeled",
    "value"
  ],
  "withBoundHouse": [
    "key",
    "kind",
    "then",
    "unmodeled"
  ],
  "withLinkedSource": [
    "effects",
    "kind",
    "unmodeled"
  ],
  "withValue": [
    "bind",
    "kind",
    "then",
    "unmodeled",
    "value"
  ],
  "wordReturning": [
    "kind",
    "unmodeled"
  ]
};
export const AFTER_KNOWLEDGE_FIELDS: readonly string[] = ["atLeast","bindAffected","directDamage","effects","originalTargetsOnly","unmodeled","when"];
