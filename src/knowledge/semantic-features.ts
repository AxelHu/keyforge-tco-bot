/** Bounded, display-independent potential features from public static rule data.
 *
 * These flags describe capabilities, not a prediction that a conditional effect
 * will resolve now. Unknown rules remain explicit; neither summary prose nor the
 * retired summaryFeatures mask participates in classification.
 */
import type { CardDefinition } from '../contracts/observation.js';

export type SemanticScope = 'any' | 'play' | 'use';
export interface CardSemanticFeatures {
  amberControl: boolean;
  forge: boolean;
  gain: boolean;
  draw: boolean;
  archive: boolean;
  recover: boolean;
  boardControl: boolean;
  heal: boolean;
  fullHeal: boolean;
  readyUse: boolean;
  conditional: boolean;
  unknown: boolean;
  unknownKinds: readonly string[];
  unknownFields: readonly string[];
}

type Row = Record<string, unknown>;
type RelativeSide = 'friendly' | 'enemy' | 'any' | 'unknown';
type Actor = 1 | -1 | 0;
interface Selection {
  side: RelativeSide;
  zone?: unknown;
}
interface Context {
  actor: Actor;
  bindings: Map<string, Selection>;
}
const object = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const OWN_TRIGGERS = new Set([
  'play',
  'reap',
  'beforeFight',
  'afterFight',
  'action',
  'omni',
  'destroyed',
  'startTurn',
  'endTurn',
  'anyStartTurn',
  'anyEndTurn',
  'endReadyStep',
  'startDrawStep',
  'opponentForge',
  'afterForge',
  'chooseHouse',
  'anyHouseChosen',
  'anyForge',
  'destroyedInFight',
  'attackDestroyed',
  'afterUse',
  'afterAssaultDestroy',
  'tideRaised',
  'opponentTideRaised',
  'survivedDamage',
  'discardPileShuffled',
  'cardDrawnOwnTurn',
  'opponentCardDrawn',
  'scrap',
]);
const USE_TRIGGERS = new Set(['reap', 'action', 'omni', 'beforeFight', 'afterFight', 'afterUse']);
const NEUTRAL_FIELDS = new Set([
  'id',
  'name',
  'number',
  'house',
  'kind',
  'power',
  'armor',
  'amber',
  'traits',
  'summary',
  'summaryFeatures',
  'ruleInterpretations',
  'unmodeled',
  'tokenReference',
  'variant',
  'keywords',
  'assault',
  'hazardous',
  'splashAttack',
  'alpha',
  'omega',
  'deploy',
  'entersReady',
  'entersStunned',
  'entersEnraged',
  'cannotFight',
  'cannotReap',
  'cannotReady',
  'cannotPlay',
  'cannotDiscardAsAction',
  'anyHouseUse',
  'ignoreTaunt',
  'ignoreArmorWhenAttacking',
  'ignoreTauntElusive',
  'noCombatDamage',
  'noDefenseDamage',
  'invulnerable',
  'invulnerableDuringFight',
  'selfPower',
  'powerBonus',
  'armorBonusValue',
  'damagedPowerBonus',
  'flankAttackBonus',
  'combatDamageMaximum',
  'tauntDistance',
  'poisonAttackingFlank',
  'fightOnlyStunned',
  'minAmberToPlay',
  'playAmberCost',
  'requiresUntamedDiscard',
  'playCondition',
  'useRequiresNeighborsHouse',
  'cannotReadyUnlessHaunted',
  'readyIfHaunted',
  'entryReadyCondition',
  'entryEnragedCondition',
  'useProhibitedIf',
  'reapSourceConditions',
  'cannotBeDamagedCondition',
  'noCombatDamageCondition',
  'invulnerableCondition',
  'incomingDamageMultipliers',
  'attackingIgnores',
  'numericKeywordBonuses',
  'conditionalKeywords',
  'absorbsNeighborDamage',
  'sharesNeighborFightDamage',
  'protectsFriendlyTraits',
  'preventsCreatureDamage',
  'preventsReadyCapturedFriendlyDamage',
  'removesCreatureArmor',
  'removesCreatureKeywords',
  'inheritsFriendlyKeywords',
  'neighborTraits',
  'neighborHouse',
  'neighborUseAsHouse',
  'useAsNeighborHouse',
  'hauntedWithPurged',
  'revealsDeckTop',
  'faceupSelectiveArchives',
  'mineralizesCounters',
  'destroyWhenNoCreatures',
  'destroyWithoutEnemy',
  'destroyIfFlank',
  'purgeWhenNoCreatures',
  'cannotStealFrom',
  'cannotStealWhileAmber',
  'cannotStealCondition',
  'evasionSigil',
]);
const STATIC_FIELDS = new Set([
  'skipForgeStep',
  'prohibitsForging',
  'forgeRestrictions',
  'opponentKeyTax',
  'keyTaxes',
  'opponentPoolForgeLimit',
  'capturesIncomingAmber',
  'capturesReapIncome',
  'reapIncomeChosenCapture',
  'replacesStealWithCapture',
  'firstShadowDiscardSteal',
  'replacesDealtDamageWithSteal',
  'drawBonus',
  'drawBonusValue',
  'drawBonusIfOpponentRicher',
  'globalDrawBonus',
  'globalHauntedDrawBonus',
  'centralDrawBonus',
  'discardDrawReplacement',
  'returnFromDiscardCondition',
  'returnFromDiscardOnHouse',
  'destroyedDestination',
  'opponentDrawPenalty',
  'opponentDrawPenaltyValue',
  'prohibitsEnemyReap',
  'blocksOpponentBonusIcons',
  'forbidsEnemyRightFlankPlay',
  'grantsEnemyOmega',
  'replacesEnemyActionPlayWithOwnLeftDestruction',
  'replacesEnemyCreatureReadyStep',
  'suppressesEnemyDestroyed',
  'locksForeignArchives',
  'opponentArtifactPlayTax',
  'opponentArtifactUseTax',
  'playLimitOpponent',
  'creaturePlayLimits',
  'onePlayPerType',
  'auras',
  'abilities',
  'conditionalAbilities',
  'reactions',
  'startTurnFromDiscard',
  'attackerBeforeFight',
  'afterAttach',
  'grantsAbilities',
  'upgrade',
  'playAsUpgrade',
  'retainedUpgrade',
]);
const CACHE = new WeakMap<CardDefinition, Partial<Record<SemanticScope, CardSemanticFeatures>>>();
function deeplyFrozen(value: unknown): boolean {
  const seen = new Set<object>();
  let budget = 4096;
  function visit(item: unknown, depth: number): boolean {
    if (--budget < 0 || depth > 32) return false;
    if (item === null || typeof item !== 'object' || seen.has(item)) return true;
    if (!Object.isFrozen(item)) return false;
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (budget <= 0 || !visit(item[index], depth + 1)) return false;
      }
    } else {
      for (const key of Object.keys(item)) {
        if (budget <= 0 || !visit((item as Row)[key], depth + 1)) return false;
      }
    }
    return true;
  }
  return visit(value, 0);
}

function flip(side: RelativeSide): RelativeSide {
  return side === 'friendly' ? 'enemy' : side === 'enemy' ? 'friendly' : side;
}
function relativeSide(side: unknown, actor: Actor): RelativeSide {
  if (actor === 0) return 'unknown';
  if (side === undefined || side === 'self') return actor === 1 ? 'friendly' : 'enemy';
  if (side === 'opponent') return actor === 1 ? 'enemy' : 'friendly';
  return 'unknown';
}

/** Inspect one static definition. Caching is restricted to deeply immutable
 * definitions; mutable/custom observations cannot retain stale semantic flags. */
export function cardSemanticFeatures(
  card: CardDefinition | undefined,
  scope: SemanticScope = 'any',
): CardSemanticFeatures {
  const cached = card && CACHE.get(card)?.[scope];
  if (cached) return cached;
  const result = inspect(card, scope);
  if (card && deeplyFrozen(card)) {
    const entries = CACHE.get(card) ?? {};
    entries[scope] = result;
    CACHE.set(card, entries);
  }
  return result;
}

function inspect(card: CardDefinition | undefined, scope: SemanticScope): CardSemanticFeatures {
  const flags = {
    amberControl: false,
    forge: false,
    gain: false,
    draw: false,
    archive: false,
    recover: false,
    boardControl: false,
    heal: false,
    fullHeal: false,
    readyUse: false,
    conditional: false,
  };
  const unknownKinds = new Set<string>(),
    unknownFields = new Set<string>();
  let budget = 4096;
  const unknown = (kind: string) => {
    unknownKinds.add(kind);
  };
  const active = new Set<object>();
  const ctx: Context = { actor: 1, bindings: new Map() };
  function positive(value: unknown, field = 'amount'): boolean {
    if (value === undefined) return true;
    if (typeof value === 'number' && Number.isFinite(value)) return value > 0;
    // A formula can be zero, negative, conditional, or unsupported. Potential
    // benefit is not established merely by the presence of an object value.
    flags.conditional = true;
    unknown('dynamic:' + field);
    return false;
  }
  function selection(filter: unknown, context: Context): Selection {
    const f = object(filter);
    if (!f) return { side: 'unknown' };
    if (typeof f.bound === 'string' && context.bindings.has(f.bound)) return context.bindings.get(f.bound)!;
    if (f.sourceOnly === true) return { side: 'friendly', zone: f.zone };
    let side: RelativeSide =
      f.side === 'friendly' || f.side === 'enemy' || f.side === 'any'
        ? f.side
        : f.side === undefined
          ? 'any'
          : 'unknown';
    if (f.controllerBinding !== undefined || f.eventOnly === true || f.hostSide !== undefined)
      side = 'unknown';
    if (context.actor === -1) side = flip(side);
    if (context.actor === 0) side = 'unknown';
    return { side, zone: f.zone };
  }
  const friendly = (side: RelativeSide) => side === 'friendly' || side === 'any';
  const enemy = (side: RelativeSide) => side === 'enemy' || side === 'any';
  function operation(op: unknown, target: Selection, effect: Row) {
    if (target.side === 'unknown') {
      unknown('operation-target');
      return;
    }
    if (
      ['damage', 'heal', 'capture', 'captureOwn'].includes(String(op)) &&
      !(op === 'heal' && effect.fullHeal === true) &&
      !positive(effect.amount)
    )
      return;
    switch (op) {
      case 'capture':
        if (friendly(target.side)) flags.amberControl = true;
        break;
      case 'captureOwn':
        if (enemy(target.side)) flags.amberControl = true;
        break;
      case 'heal':
        if (friendly(target.side)) {
          flags.heal = true;
          flags.fullHeal ||= effect.fullHeal === true;
        }
        break;
      case 'ready':
      case 'use':
        if (friendly(target.side)) flags.readyUse = true;
        break;
      case 'archive':
        if (friendly(target.side)) flags.archive = true;
        if (enemy(target.side)) flags.boardControl = true;
        break;
      case 'returnHand':
        if (friendly(target.side)) flags.recover = true;
        if (enemy(target.side)) flags.boardControl = true;
        break;
      case 'destroy':
      case 'purge':
      case 'damage':
      case 'stun':
      case 'exhaust':
      case 'stunExhaust':
      case 'deckBottom':
      case 'deckTop':
      case 'discard':
        if (enemy(target.side)) flags.boardControl = true;
        break;
      case 'ward':
      case 'enrage':
      case 'exalt':
      case 'power':
      case 'removePower':
      case 'unward':
      case 'unstun':
        break;
      default:
        unknown('operation:' + String(op));
    }
  }
  function effects(value: unknown, context: Context, depth: number) {
    if (!Array.isArray(value)) {
      if (value !== undefined) unknown('effect-list');
      return;
    }
    for (let index = 0; index < value.length; index++) {
      if (budget <= 0) {
        unknown('effect-budget-or-cycle');
        break;
      }
      effect(value[index], context, depth);
    }
  }
  function effect(value: unknown, context: Context, depth: number) {
    const e = object(value);
    if (!e || typeof e.kind !== 'string') {
      unknown('effect-shape');
      return;
    }
    if (--budget < 0 || depth > 32 || active.has(e)) {
      unknown('effect-budget-or-cycle');
      return;
    }
    active.add(e);
    const next = depth + 1;
    if (e.unmodeled === true) {
      unknown(e.kind);
      active.delete(e);
      return;
    }
    const own = relativeSide(e.side, context.actor);
    const actor = relativeSide('self', context.actor);
    const source: Selection = { side: 'friendly' };
    const follow = (field: string, c = context) => effects(e[field], c, next);
    const amountActive = positive(e.amount);
    switch (e.kind) {
      case 'gain':
        if (amountActive && actor === 'friendly') flags.gain = true;
        break;
      case 'draw':
        if (amountActive && actor === 'friendly') flags.draw = true;
        break;
      case 'steal':
        if (amountActive && actor === 'friendly') {
          flags.amberControl = true;
          flags.gain = true;
        }
        follow('then');
        break;
      case 'loseOpponent':
        if (amountActive && context.actor === 1) flags.amberControl = true;
        break;
      case 'skipForge':
        if (context.actor === 1) flags.amberControl = true;
        break;
      case 'capture':
        operation('capture', source, e);
        break;
      case 'healSelf':
        operation('heal', source, e);
        break;
      case 'resource':
        if (own === 'unknown') unknown('resource-side');
        else if (amountActive) {
          if (e.operation === 'draw' && own === 'friendly') flags.draw = true;
          else if (e.operation === 'gain' && own === 'friendly') flags.gain = true;
          else if (e.operation === 'lose' && own === 'enemy') flags.amberControl = true;
          else if (e.operation === 'steal' && own === 'friendly') {
            flags.amberControl = true;
            flags.gain = true;
          } else if (!['draw', 'gain', 'lose', 'steal', 'chains'].includes(String(e.operation)))
            unknown('resource-operation');
        }
        break;
      case 'forgeEffect':
        if (context.actor === 1) flags.forge = true;
        else if (context.actor === 0) unknown('forge-actor');
        follow('after');
        break;
      case 'archiveChoice':
      case 'archiveTop':
        if (own === 'friendly') flags.archive = true;
        else if (own === 'unknown') unknown('archive-side');
        break;
      case 'randomArchive':
        if (amountActive && own === 'friendly') flags.archive = true;
        else if (own === 'unknown') unknown('archive-side');
        break;
      case 'target':
      case 'all':
      case 'repeatTarget': {
        if (e.kind === 'repeatTarget' && !positive(e.count, 'count')) break;
        const target = selection(e.filter, context);
        operation(e.operation, target, e);
        const after = object(e.after);
        if (after) {
          flags.conditional = true;
          effects(after.effects, context, next);
        }
        break;
      }
      case 'self':
        operation(e.operation, source, e);
        effects(object(e.after)?.effects, context, next);
        break;
      case 'bound':
        operation(e.operation, context.bindings.get(String(e.key)) ?? { side: 'unknown' }, e);
        effects(object(e.after)?.effects, context, next);
        break;
      case 'chooseCards':
      case 'bindCards':
      case 'bindPhysicalCards': {
        const bindings = new Map(context.bindings);
        if (typeof e.bind === 'string') bindings.set(e.bind, selection(e.filter, context));
        else unknown('selection-binding');
        follow('then', { ...context, bindings });
        break;
      }
      case 'choose':
        for (const option of array(e.options)) effects(object(option)?.effects, context, next);
        flags.conditional = true;
        break;
      case 'chooseHouse':
        follow('then');
        flags.conditional = true;
        break;
      case 'if':
        flags.conditional = true;
        follow('then');
        follow('otherwise');
        break;
      case 'forEach':
      case 'recur':
        if (positive(e.count, 'count')) follow('effects');
        if (typeof e.count !== 'number') flags.conditional = true;
        break;
      case 'orderedChild':
        follow('effects');
        follow('then');
        break;
      case 'eachPlayer':
        follow('effects', { actor: 1, bindings: new Map(context.bindings) });
        follow('effects', { actor: -1, bindings: new Map(context.bindings) });
        flags.conditional ||= e.condition !== undefined;
        break;
      case 'asPlayer': {
        const actor: Actor = own === 'friendly' ? 1 : own === 'enemy' ? -1 : 0;
        if (!actor) unknown('asPlayer-side');
        follow('effects', { actor, bindings: new Map(context.bindings) });
        break;
      }
      case 'useChoice': {
        const side = selection(e.filter, context).side;
        if (side === 'unknown' || context.actor === 0) unknown('useChoice-side');
        else if (context.actor === 1 && friendly(side)) flags.readyUse = true;
        follow('after');
        break;
      }
      case 'takeControl': {
        const target = typeof e.key === 'string' ? context.bindings.get(e.key) : undefined;
        if (own === 'friendly' && target && enemy(target.side)) flags.boardControl = true;
        else if (!target || own === 'unknown') unknown('takeControl-binding');
        break;
      }
      case 'damageChoice':
        if (context.actor === 1 && amountActive) flags.boardControl = true;
        break;
      case 'randomDiscard':
        if (own === 'enemy' && amountActive) flags.boardControl = true;
        else if (own === 'unknown') unknown('discard-side');
        break;
      case 'lasting':
        if (e.rule === 'skipForge' && own === 'enemy') flags.amberControl = true;
        else if (e.rule === 'keyCost' && own === 'enemy' && typeof e.amount === 'number' && e.amount > 0)
          flags.amberControl = true;
        else unknown('lasting:' + String(e.rule));
        break;
      case 'permission': {
        const side = selection(e.filter, context).side;
        if (side === 'unknown' || context.actor === 0) unknown('permission-side');
        if (e.mode === 'use' || e.mode === 'fight' || e.mode === 'playOrUse') {
          if (context.actor === 1 && friendly(side)) flags.readyUse = true;
        } else unknown('permission:' + String(e.mode));
        break;
      }
      case 'payOpponent':
      case 'sacrificeSelf':
      case 'chains':
      case 'finishAction':
      case 'reveal':
      case 'storeAmber':
        follow('then');
        break;
      default:
        unknown(e.kind);
    }
    active.delete(e);
  }
  function abilities(value: unknown, context = ctx) {
    const entries = object(value);
    if (!entries) {
      if (value !== undefined) unknown('abilities-shape');
      return;
    }
    for (const [trigger, list] of Object.entries(entries)) {
      if (scope === 'play' && trigger !== 'play') continue;
      if (scope === 'use' && !USE_TRIGGERS.has(trigger)) continue;
      if (!OWN_TRIGGERS.has(trigger)) {
        unknown('trigger:' + trigger);
        continue;
      }
      if (!['play', 'reap', 'action', 'omni'].includes(trigger)) flags.conditional = true;
      effects(list, context, 0);
    }
  }
  if (!card) unknown('card-unavailable');
  else {
    if (card.unmodeled || card.ruleInterpretations?.some((note) => note.officialRulingConfirmed === false))
      unknown('card-unmodeled-or-research-convention');
    for (const [field, value] of Object.entries(card)) {
      if (value !== undefined && !NEUTRAL_FIELDS.has(field) && !STATIC_FIELDS.has(field))
        unknownFields.add(field);
    }
    abilities(card.abilities);
    for (const item of card.conditionalAbilities ?? []) {
      flags.conditional = true;
      abilities(item.abilities);
    }
    if (scope === 'any') {
      for (const reaction of card.reactions ?? []) {
        flags.conditional = true;
        effects(reaction.effects, ctx, 0);
      }
      effects(card.startTurnFromDiscard, ctx, 0);
      if (card.attackerBeforeFight?.length) {
        // The defender grants this bundle to the attacker, who supplies both
        // actor and source. The defender's own controller is not its beneficiary.
        flags.conditional = true;
        unknown('attacker-before-fight-context');
      }
      effects(card.afterAttach, ctx, 0);
    }
    if (scope !== 'use') {
      flags.amberControl ||= !!(
        card.prohibitsForging ||
        (card.opponentKeyTax ?? 0) > 0 ||
        card.opponentPoolForgeLimit !== undefined
      );
      // Income replacements and reactions are future potential, not an immediate
      // Play defense against an opponent who is already funded.
      if (scope === 'any') {
        flags.amberControl ||= !!(
          card.capturesIncomingAmber ||
          card.capturesReapIncome ||
          card.firstShadowDiscardSteal ||
          card.replacesDealtDamageWithSteal
        );
        if (card.reapIncomeChosenCapture || card.replacesStealWithCapture)
          unknown('capture-replacement-context');
      }
      flags.amberControl ||= (card.keyTaxes ?? []).some(
        (row) => row.side === 'opponent' && positive(row.amount),
      );
      flags.amberControl ||= (card.forgeRestrictions ?? []).some((row) => row.side === 'opponent');
      if (card.keyTaxes?.some((row) => row.condition) || card.forgeRestrictions?.some((row) => row.condition))
        flags.conditional = true;
      flags.draw ||= !!(
        card.discardDrawReplacement ||
        (card.drawBonus ?? 0) > 0 ||
        (card.drawBonusIfOpponentRicher ?? 0) > 0 ||
        (card.globalDrawBonus ?? 0) > 0 ||
        (card.globalHauntedDrawBonus ?? 0) > 0 ||
        (card.centralDrawBonus ?? 0) > 0 ||
        (card.drawBonusValue !== undefined && positive(card.drawBonusValue))
      );
      flags.recover ||= !!(
        card.returnFromDiscardCondition ||
        card.returnFromDiscardOnHouse ||
        card.destroyedDestination === 'hand'
      );
      flags.boardControl ||= !!(
        card.prohibitsEnemyReap ||
        card.blocksOpponentBonusIcons ||
        card.forbidsEnemyRightFlankPlay ||
        card.grantsEnemyOmega ||
        card.replacesEnemyActionPlayWithOwnLeftDestruction ||
        card.replacesEnemyCreatureReadyStep ||
        card.suppressesEnemyDestroyed ||
        card.locksForeignArchives ||
        (card.opponentDrawPenalty ?? 0) > 0 ||
        (card.opponentDrawPenaltyValue !== undefined && positive(card.opponentDrawPenaltyValue)) ||
        (card.playLimitOpponent ?? 0) > 0 ||
        card.onePlayPerType === 'opponent' ||
        card.creaturePlayLimits?.some((row) => row.side === 'opponent')
      );
      flags.amberControl ||=
        (card.opponentArtifactPlayTax ?? 0) > 0 || (card.opponentArtifactUseTax ?? 0) > 0;
      for (const grant of card.grantsAbilities ?? []) {
        const side = selection(grant.filter, ctx).side;
        if (side === 'friendly') abilities(grant.abilities);
        else unknown('granted-ability-controller');
        flags.conditional = true;
      }
      if (card.upgrade || card.playAsUpgrade || card.retainedUpgrade) unknown('upgrade-host-controller');
      if (card.auras?.length) unknown('aura-context');
    }
  }
  return Object.freeze({
    ...flags,
    unknown: unknownKinds.size > 0 || unknownFields.size > 0,
    unknownKinds: Object.freeze([...unknownKinds].sort()),
    unknownFields: Object.freeze([...unknownFields].sort()),
  });
}
