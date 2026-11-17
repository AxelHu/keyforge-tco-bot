/** Native Keyteki compatibility vocabulary.
 *
 * The wire has structured player/card identities and numeric arguments, but some
 * prompt and game-log kinds are still encoded as display templates. Keep that
 * fallback here: callers bind actor/source/prompt/timing/targets before treating
 * these labels as current decision semantics. This is not a card-text parser.
 */
import type { Operation } from '../contracts/observation.js';

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value : '';

export function keytekiPromptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const prompt = obj(value), values = obj(prompt.values);
  return str(prompt.text).replace(/\{\{([^}]+)\}\}/g, (whole, key: string) => {
    const parameter = values[key];
    return typeof parameter === 'string' || (typeof parameter === 'number' && Number.isFinite(parameter))
      ? String(parameter) : whole;
  });
}

const PROMPTS = {
  'choose-card': /^Choose a card$/i,
  'choose-creature': /^Choose a creature$/i,
  'choose-house': /^Choose a house$/i,
  'choose-ability': /^choose an ability:?\s*$/i,
  'play-card': /^Choose a card to play$/i,
  'fight-target': /choose a creature to attack/i,
  'upgrade-target': /choose a (creature|card) to attach(?:ed)? this upgrade to/i,
  'battleline-swap': /^Select two creatures to swap$/,
  'unnatural-friendly': /^Choose 3 friendly creatures$/,
  'unnatural-enemy': /^Choose 3 enemy creatures$/,
  'prophecy-confirm': /^Activate prophecy\?$/,
  'prophecy-place': /^Choose a card from your hand to place under the prophecy$/,
  'reaver-amber': /^Choose a captured amber to move to your pool\.$/i,
  'mulligan': /mulligan|keep starting hand/i,
  'archives': /access archives|take.*cards.*archives.*hand/i,
  'active-house': /choose active house|choose which house.*activate/i,
  'forge': /forge.*key|choose.*key.*forge/i,
  'ability-or-play': /choose an ability|^play /i,
  'raise-tide': /raise the tide/i,
  'end-turn-confirm': /are you sure you want to end your turn/i,
  'flank-placement': /flank|play|place/i,
} as const;

export function keytekiPromptMatches(value: unknown, template: keyof typeof PROMPTS): boolean {
  return PROMPTS[template].test(keytekiPromptText(value));
}

const BUTTONS = {
  'yes': /^yes$/i,
  'no': /^no$/i,
  'archives-all': /^(yes|all cards)$/i,
  'end-turn': /^end turn$/i,
  'done': /^(done|cancel|cancel prompt)$/i,
  'reap': /^reap with this creature$/i,
  'unstun': /^(remove stun|remove stun from this creature|remove this creature's stun)$/i,
  'return-hand': /^return this card to hand$/i,
  'discard': /^discard (this )?card$/i,
  'play': /^play (this )?(card|creature|artifact|action|upgrade)$/i,
  'as-upgrade': /upgrade$/i,
  'fight': /^fight with this creature$/i,
  'use': /^(action|omni)(\b|:)|^use this card's (action|omni) ability$/i,
  'flank': /^(left|right)$/i,
} as const;

export function keytekiButtonMatches(value: unknown, template: keyof typeof BUTTONS): boolean {
  return BUTTONS[template].test(keytekiPromptText(value));
}

/** The native numeric argument is a selection maximum, not a minimum or an
 * operation's amount. The known template supplies its missing wire kind. */
export function keytekiSelectionMaximum(value: unknown): number | undefined {
  const prompt = obj(value), amount = obj(prompt.values).amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return undefined;
  return /^Choose \{\{amount\}\} (cards|creatures|artifacts|upgrades|actions)( to discard)?$/i.test(str(prompt.text))
    ? amount : undefined;
}

const BONUS_SELECTIONS: Readonly<Record<string, Operation | 'power'>> = {
  'Choose a creature to capture amber due to bonus icon': 'capture',
  'Choose a creature to damage due to bonus icon': 'damage',
  'Choose a card to discard due to bonus icon': 'discard',
  'Choose a creature to add a +1 power counter to due to bonus icon': 'power',
};
export function keytekiBonusSelection(value: unknown): Operation | 'power' | undefined {
  const text = str(value);
  return Object.hasOwn(BONUS_SELECTIONS, text) ? BONUS_SELECTIONS[text] : undefined;
}

export interface KeytekiTargetMeaning {
  operation: Operation;
  /** Amount of ONE target operation, never the batch quota or selection cap. */
  amount?: number;
  basis: 'native-parameter' | 'native-template' | 'source-template';
}

const ORDINARY_TARGET_TEMPLATES: ReadonlyArray<readonly [Operation, RegExp]> = [
  ['destroy', /^Choose (?:a|an|[1-9][0-9]*|up to [1-9][0-9]*|any number of) (?:friendly |enemy |other )?(?:creatures?|artifacts?|upgrades?|cards?) to destroy[.!]?$/i],
  ['purge', /^Choose (?:a|an|[1-9][0-9]*|up to [1-9][0-9]*) (?:friendly |enemy |other )?(?:creatures?|artifacts?|upgrades?|cards?) to purge[.!]?$/i],
  ['stun', /^Choose (?:a|an|[1-9][0-9]*|up to [1-9][0-9]*) (?:friendly |enemy |other )?creatures? to stun[.!]?$/i],
  ['exhaust', /^Choose (?:a|an|[1-9][0-9]*|up to [1-9][0-9]*) (?:friendly |enemy |other )?(?:creatures?|artifacts?|cards?) to exhaust[.!]?$/i],
  ['discard', /^Choose (?:a|[1-9][0-9]*|up to [1-9][0-9]*) cards? to discard[.!]?$/i],
  ['archive', /^Choose (?:a|an|[1-9][0-9]*|up to [1-9][0-9]*) (?:friendly |enemy )?(?:cards?|creatures?) to archive[.!]?$/i],
];

/** Only the CURRENT menu is interpreted. A source card's display name or summary
 * may contain these words without describing this choice. Negated/composite
 * prompts are deliberately not collapsed to one positive operation. */
export function keytekiTargetMeaning(value: unknown, boundSourceDefinition?: string): KeytekiTargetMeaning | undefined {
  const text = keytekiPromptText(value);
  const bonus = keytekiBonusSelection(value);
  if (bonus && bonus !== 'power') return { operation: bonus, amount: 1, basis: 'native-template' };

  if (text === KEYTEKI_CAPTURE_BATCH_TITLES['hypnotic-command']) {
    return boundSourceDefinition === 'hypnotic-command'
      ? { operation: 'captureOwn', amount: 1, basis: 'source-template' } : undefined;
  }
  const numericDamage = obj(value), damageAmount = obj(numericDamage.values).amount;
  if (str(numericDamage.text) === 'Choose a creature to deal {{amount}} damage to') {
    // A formatted string must not upgrade a malformed native numeric field.
    return typeof damageAmount === 'number' && Number.isSafeInteger(damageAmount) && damageAmount > 0
      ? { operation: 'damage', amount: damageAmount, basis: 'native-parameter' } : undefined;
  }
  const damage = /^Choose a creature to deal ([1-9][0-9]*) damage to[.!]?$/i.exec(text);
  if (damage) {
    const amount = Number(damage[1]);
    if (Number.isSafeInteger(amount))
      return { operation: 'damage', amount, basis: 'native-template' };
    return undefined;
  }

  // AllocateAmberPrompt publishes amberStep in the title. It does not publish
  // numSteps there: the allocation tracker must still prove that total separately.
  const capture = /^Choose (?:a|an) (?:friendly |enemy )?creature to capture ([1-9][0-9]*) amber(?: on)?[.!]?$/i.exec(text);
  if (capture) {
    const amount = Number(capture[1]);
    return Number.isSafeInteger(amount)
      ? { operation: 'capture', amount, basis: 'native-template' } : undefined;
  }
  if (/^Choose a creature to capture amber[.!]?$/i.test(text))
    return { operation: 'capture', basis: 'native-template' };
  if (boundSourceDefinition === 'reaver' && keytekiPromptMatches(value, 'reaver-amber'))
    return { operation: 'takeAmber', basis: 'source-template' };
  for (const [operation, pattern] of ORDINARY_TARGET_TEMPLATES)
    if (pattern.test(text)) return { operation, basis: 'native-template' };
  return undefined;
}

/** Recognizing a batch does not authorize it. Unknown or unproved quotas must
 * remain unsupported, rather than falling through to an unobserved single click. */
export const KEYTEKI_CAPTURE_BATCH_TITLES: Readonly<Record<string, string>> = {
  'veil-of-ectoplasm': 'Choose a creature to capture 1 amber',
  'hallowed-eve-festival': 'Choose a creature to capture 1 amber',
  'bring-low': 'Choose a creature to capture 1 amber',
  fathomshare: 'Choose a friendly creature to capture 1 amber on',
  xenotraining: 'Choose a creature to capture 1 amber',
  'shard-of-hope': 'Choose a creature to capture 1 amber',
  'sirs-colossus': 'Choose a creature to capture 1 amber',
  'hypnotic-command': 'Choose a creature to capture 1 amber from its controller',
  fetchdrones: 'Choose a creature to capture 2 amber',
  'cryptic-collapse': 'Choose a creature to capture 1 amber',
  'gilded-burden': 'Choose an enemy creature to capture 2 amber on',
  'productive-trash': 'Choose a creature to capture 1 amber',
  gargantodon: 'Choose a creature to capture amber',
};
export function keytekiCaptureCandidateTitle(value: unknown, source: string): boolean {
  const title = str(value);
  return !keytekiBonusSelection(value) &&
    (['bring-low', 'fathomshare', 'shard-of-hope', 'xenotraining'].includes(source) ||
      /^Choose\b.*\bcapture\b.*\bamber\b/.test(title));
}

const USE_EFFECT_PAIRS = [[' uses ', ' to '], [' 使用 ', ' 来 ']] as const;
const DISCARD_PAIRS = [[' uses ', ' to discard '], [' 使用 ', ' 来弃置 ']] as const;
const FESTIVAL_TUPLES = [
  [' uses ', ' to capture ', ' amber onto friendly creatures'],
  [' 使用 ', ' 抢占 ', ' 琥珀放置到友方生物上'],
] as const;

/** These incomplete native event kinds have no language-independent eventType.
 * Accept only observed complete templates; callers retain identity, fresh-window,
 * uniqueness, physical source, public amount and target checks. */
export function keytekiUseMessageMatches(message: unknown, kind: 'effect' | 'discard' | 'festival' | 'settlement'): boolean {
  const m = arr(message);
  if (kind === 'festival') return FESTIVAL_TUPLES.some(([use, capture, onto]) => m[1] === use && m[3] === capture && m[5] === onto);
  if (kind === 'settlement') return m[1] === ' uses ' && m[3] === ' to have ' && m[5] === ' capture ' && m[7] === ' amber';
  return (kind === 'effect' ? USE_EFFECT_PAIRS : DISCARD_PAIRS)
    .some(([use, to]) => m[1] === use && m[3] === to);
}

export function keytekiCaptureEffectPayloadMatches(source: string, value: unknown, opponentName?: string): boolean {
  const effect = obj(value), parts = arr(effect.message);
  if (Object.keys(effect).length !== 1) return false;
  if (source === 'hypnotic-command')
    return parts.length === 1 && parts[0] === 'force an enemy creature to capture 1 amber for each mars creature they control';
  if (
    !opponentName || obj(parts[3]).argType !== 'nonAvatarPlayer' ||
    obj(parts[3]).name !== opponentName || parts[2] !== ' amber from '
  ) return false;
  return source === 'bring-low'
    ? parts.length === 4 && parts[0] === 'have friendly creatures capture '
    : source === 'fathomshare'
      ? parts.length === 5 && parts[0] === 'capture ' && parts[4] === ', distributed among friendly creatures'
      : source === 'shard-of-hope' && parts.length === 4 && parts[0] === 'capture ';
}
