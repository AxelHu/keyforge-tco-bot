/** Player-view adapter for upstream keyteki/keyteki 361c085bcd401c20976ee9bcc4e4e5b8c061d56c.
 * Only consumes the audience-filtered game.getState(playerName) wire object. It does not call
 * the local rules engine to invent external legal moves. Main-window card clicks are navigation
 * choices: keyteki reveals their exact abilities only in the next player prompt.
 */
import { createHash } from 'node:crypto';
import { ALL_DEFINITIONS as CATALOG, cardKnowledgeIsPartial } from '../knowledge/catalog.js';
import { canonical } from '../shared/canonical.js';
import { upgradeForm } from '../knowledge/upgrade-form.js';
import { prophecyFacts } from '../knowledge/prophecy-facts.js';
import { resolveExternalKeytekiToken } from './keyteki-token-references.js';
import { keytekiInfurnaceContract } from './keyteki-infurnace.js';
import type { StrategyAdministrativeRequest } from '../ai/strategy-controller.js';
import type {
  Action,
  BonusIcon,
  CardDefinition,
  CardView,
  House,
  KeyColor,
  LegalAction,
  Observation,
  Operation,
  PendingView,
  Phase,
  PlayerView,
  Seat,
} from '../contracts/observation.js';

export const KEYTEKI_ADAPTER_VERSION = 'keyteki-player-adapter-v3';
export const KEYTEKI_UPSTREAM_COMMIT = '361c085bcd401c20976ee9bcc4e4e5b8c061d56c';
type ObjectValue = Record<string, unknown>;
export interface KeytekiCommand {
  message: 'cardClicked' | 'menuButton' | 'clickTide' | 'clickProphecy';
  args: unknown[];
  /** Navigation opens another server prompt; it must not be credited as an executed card ability. */
  navigation: boolean;
  sourceCardId?: string;
  intent?: 'fight' | 'play' | 'use' | 'discard' | 'prophecy';
}
/** A previously selected shared action, retained only across its exact external UI route. */
export interface KeytekiProphecyActivation {
  action: Extract<Action, { kind: 'activateProphecy' }>;
  prophecyUuid: string;
  stage: 'confirm' | 'place';
  confirmationUuid?: string;
  placementUuid?: string;
}
/** One previously visible physical action, retained by navigation across its actual Play menu. */
export interface KeytekiResolvingPlaySource {
  id: string;
  definition: 'they-tell-no-tales' | 'divine-seal' | 'a-gift-of-æmber';
  owner: Seat;
  controller: Seat;
  gameId: string;
  playerName: string;
  turn: number;
}
export interface KeytekiProjectionOptions {
  playerName: string;
  /** Monotone transport revision, incremented only when a fresh player view is received. */
  revision: number;
  /** Public-history turn counter maintained by the transport; keyteki omits it from getState. */
  turn: number;
  /** Individually verified public turn ordinal; other history fields remain incomplete. */
  turnHistory?: { fromGameStart: boolean; observedEndTurns: number; unknownReasons: string[] };
  firstPlayerName?: string;
  /** Visible source bound by the last card-entry or menu command; target clicks retain it. */
  sourceCardId?: string;
  /** Navigation evidence only; never a hand card, target or new legal face. */
  resolvingPlaySource?: KeytekiResolvingPlaySource;
  /** Most recent actual cardClicked target, used only to identify a newly opened Card.use menu. */
  lastClickedCardId?: string;
  /** Publicly available deck lists, never a remaining-deck query. Absent means unknown. */
  deckLists?: Record<string, PlayerView['deckList']>;
  /** Navigation memory, never a source of new legal faces or unseen hand identities. */
  prophecyActivation?: KeytekiProphecyActivation;
}
export interface KeytekiProjection {
  protocol: typeof KEYTEKI_ADAPTER_VERSION;
  gameId: string;
  playerName: string;
  fingerprint: string;
  observation: Observation;
  commands: Record<string, KeytekiCommand>;
  navigationActionIds: string[];
  /** Exact public platform consent, separate from any card ability or effect text. */
  administrativeRequest?: StrategyAdministrativeRequest;
  /** These are not claims of engine parity. Compatibility defaults are disclosed here. */
  unknown: string[];
  /** Unknown controls/definitions prevent unattended sending, without fabricating legality. */
  unsupported: string[];
}
const obj = (v: unknown): ObjectValue =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as ObjectValue) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MANUAL_MODE_TITLE = '{{player}} requests to enable manual mode. Allow?';
const MANUAL_FORGE_TITLE = '{{player}} requests to forge the {{color}} key. Allow?';
const MANUAL_WAITING_TITLES = [
  'Waiting for opponent to approve entering manual mode',
  'Waiting for opponent to approve forging the key',
];
function administrativeTemplate(me: ObjectValue): string | undefined {
  const text = str(obj(me.menuTitle).text);
  return text === MANUAL_MODE_TITLE || text === MANUAL_FORGE_TITLE ? text : undefined;
}
/** These overlays suspend an existing card prompt; their appearance/restoration is not its ACK.
 * Include damaged known consent schemas here, while only the strict parser below permits No.
 */
export function keytekiAdministrativeSurface(input: unknown, playerName: string): boolean {
  const me = obj(obj(obj(input).players)[playerName]);
  return !!administrativeTemplate(me) || MANUAL_WAITING_TITLES.includes(str(me.menuTitle));
}
function administrativeBinding(
  raw: ObjectValue,
  me: ObjectValue,
  names: string[],
  you: Seat,
): StrategyAdministrativeRequest | undefined {
  const template = administrativeTemplate(me);
  if (!template) return undefined;
  const title = obj(me.menuTitle),
    values = obj(title.values),
    forge = template === MANUAL_FORGE_TITLE,
    requester = names.indexOf(str(values.player)),
    buttons = arr(me.buttons).map(obj),
    allowedValues = forge ? ['player', 'color'] : ['player'];
  if (
    !str(raw.id).trim() ||
    raw.started !== true ||
    raw.winner != null ||
    raw.manualMode !== forge ||
    requester !== (you === 0 ? 1 : 0) ||
    Object.keys(title).some((key) => !['text', 'values'].includes(key)) ||
    Object.keys(values).length !== allowedValues.length ||
    Object.keys(values).some((key) => !allowedValues.includes(key)) ||
    (forge && !['red', 'blue', 'yellow'].includes(str(values.color))) ||
    me.selectCard !== false ||
    me.selectOrder !== false ||
    !Array.isArray(me.controls) ||
    me.controls.length !== 0 ||
    buttons.length !== 2 ||
    buttons.some(
      (b) =>
        Object.keys(b).some((key) => !['arg', 'text', 'command', 'uuid', 'disabled'].includes(key)) ||
        !['yes', 'no'].includes(str(b.arg)) ||
        b.text !== (b.arg === 'no' ? 'No' : 'Yes') ||
        b.command !== 'menuButton' ||
        !str(b.uuid).trim() ||
        (b.disabled !== undefined && b.disabled !== false),
    ) ||
    new Set(buttons.map((b) => b.arg)).size !== 2 ||
    new Set(buttons.map((b) => b.uuid)).size !== 1
  )
    return undefined;
  // Upstream leaves promptedPiles/selected flags from the covered card prompt in place.
  // None of those residual fields can change the two exact consent commands.
  const rejectIndex = buttons.findIndex((b) => b.arg === 'no');
  const binding = {
    requester: requester as Seat,
    promptUuid: str(buttons[rejectIndex].uuid),
    rejectActionId: JSON.stringify({ kind: 'choose', option: `keyteki-button-${rejectIndex}` }),
  };
  return forge
    ? { kind: 'manual-key-forge-consent', ...binding, keyColor: values.color as KeyColor }
    : { kind: 'manual-mode-consent', ...binding };
}
const nonnegative = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
const label = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  const x = obj(v),
    values = obj(x.values);
  return str(x.text).replace(/\{\{([^}]+)\}\}/g, (whole, key: string) => {
    const value = values[key];
    return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
      ? String(value)
      : whole;
  });
};
/** ExactlyX and UpToX publish this same title; both provide a maximum, but the
 * minimum is deliberately not inferred. XorMore has a distinct "or more" title.
 * The serialized selectable flag is not adjusted when SelectCardPrompt reaches its cap.
 */
function publicSelectionMaximum(menuTitle: unknown): number | undefined {
  const prompt = obj(menuTitle),
    amount = obj(prompt.values).amount;
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return undefined;
  return /^Choose \{\{amount\}\} (cards|creatures|artifacts|upgrades|actions)( to discard)?$/i.test(
    str(prompt.text),
  )
    ? amount
    : undefined;
}
/** Unnatural Selection publishes literal titles instead of the usual amount template.
 * Its source-bound prompt still caps each side at three; the native Done button,
 * not the title, determines whether a smaller selection may be completed.
 */
function unnaturalSelectionMaximum(me: ObjectValue): number | undefined {
  if (
    me.selectOrder === true ||
    !['Choose 3 friendly creatures', 'Choose 3 enemy creatures'].includes(str(me.menuTitle))
  )
    return undefined;
  const controls = arr(me.controls).map(obj);
  if (controls.length !== 1 || controls[0].type !== 'targeting') return undefined;
  const source = obj(controls[0].source);
  return source.id === 'unnatural-selection' && source.type === 'action' && source.facedown !== true
    ? 3
    : undefined;
}
type PublicRankedTargetSelection =
  | { allowed: Set<string>; count: number; operation: Operation }
  | { error: string };
/** A MostStat selector highlights every boundary tie, but completing it also
 * requires every strictly higher target. Keep only prefixes that can still form
 * a top-N set. The referee's offered set supplies target restrictions; printed
 * power, hidden effects and unoffered creatures never enlarge that set.
 */
function publicRankedTargetSelection(
  me: ObjectValue,
  playerRaw: ObjectValue[],
  rawById: Map<string, ObjectValue>,
  locations: Map<string, string>,
  projectedSelected: string[],
): PublicRankedTargetSelection | undefined {
  // Bonus selectors use the same physical source before its Play ability. Their
  // four pinned titles identify ordinary one-icon choices, not MostStat.
  if (
    typeof me.menuTitle === 'string' &&
    [
      'Choose a creature to capture amber due to bonus icon',
      'Choose a creature to damage due to bonus icon',
      'Choose a card to discard due to bonus icon',
      'Choose a creature to add a +1 power counter to due to bonus icon',
    ].includes(me.menuTitle)
  )
    return undefined;
  const controls = arr(me.controls).map(obj);
  const sources = controls.map((control) => resolveDefinition(obj(control.source)));
  const hasRankedMax = (definition: CardDefinition | undefined) =>
    definition?.abilities?.play?.some((effect) => effect.kind === 'target' && effect.filter.ranked === 'max');
  // An exact known ranked title is only a reason to reject a missing/conflicting
  // source below. It must never supply a substitute source or numeric quota.
  const rankedTitle = Object.values(CATALOG).some(
    (definition) => definition.name === me.promptTitle && hasRankedMax(definition),
  );
  if (!sources.some(hasRankedMax) && !rankedTitle) return undefined;
  const fail = (reason: string): PublicRankedTargetSelection => ({ error: `ranked-target-${reason}` });
  const definition = sources[0],
    source = obj(controls[0]?.source),
    effects = definition?.abilities?.play ?? [],
    effect = effects.length === 1 && effects[0].kind === 'target' ? effects[0] : undefined,
    title = obj(me.menuTitle),
    values = obj(title.values),
    promptUuid = str(controls[0]?.uuid).replace(/:0$/, ''),
    buttons = arr(me.buttons).map(obj);
  // This narrow declared primitive has no optional/conditional/card filter or
  // competing ability. Other ranked forms require their own protocol binding.
  if (
    controls.length !== 1 ||
    controls[0].type !== 'targeting' ||
    !/^.+:0$/.test(str(controls[0].uuid)) ||
    !Array.isArray(controls[0].targets) ||
    !definition ||
    source.id !== definition.id ||
    source.type !== definition.kind ||
    source.facedown !== false ||
    source.copying === true ||
    label(me.promptTitle) !== definition.name ||
    Object.keys(definition.abilities ?? {}).some((key) => key !== 'play') ||
    !effect ||
    effect.filter.ranked !== 'max' ||
    Object.keys(effect.filter).some((key) => key !== 'ranked') ||
    Object.keys(effect).some((key) => !['kind', 'filter', 'operation', 'max'].includes(key)) ||
    effect.operation !== 'destroy' ||
    !Number.isSafeInteger(effect.max) ||
    (effect.max ?? 0) <= 0 ||
    title.text !== 'Choose {{amount}} creatures' ||
    Object.keys(title).some((key) => !['text', 'values'].includes(key)) ||
    Object.keys(values).some((key) => key !== 'amount') ||
    values.amount !== effect.max ||
    me.selectOrder === true ||
    !Array.isArray(me.promptedPiles) ||
    me.promptedPiles.length !== 0 ||
    !Array.isArray(me.buttons) ||
    buttons.length > 1 ||
    buttons.some(
      (button) =>
        button.text !== 'Done' ||
        button.arg !== 'done' ||
        button.command !== 'menuButton' ||
        button.uuid !== promptUuid ||
        button.method !== undefined ||
        button.disabled === true,
    )
  )
    return fail('binding-unsupported');
  const board = playerRaw.flatMap((player) => arr(obj(player.cardPiles).cardsInPlay).map(obj));
  const offered = board.filter((card) => card.selectable === true && card.unselectable !== true);
  const selected = board.filter((card) => card.selected === true).map((card) => str(card.uuid));
  const ids = offered.map((card) => str(card.uuid));
  if (
    offered.length === 0 ||
    new Set(ids).size !== ids.length ||
    new Set(selected).size !== selected.length ||
    projectedSelected.length !== selected.length ||
    projectedSelected.some((id) => !selected.includes(id)) ||
    selected.some((id) => !ids.includes(id)) ||
    [...rawById].some(
      ([id, card]) =>
        (card.selected === true || (card.selectable === true && card.unselectable !== true)) &&
        locations.get(id) !== 'cardsInPlay',
    ) ||
    offered.some(
      (card) =>
        !str(card.uuid) ||
        card.type !== 'creature' ||
        card.facedown !== false ||
        !rawById.has(str(card.uuid)) ||
        locations.get(str(card.uuid)) !== 'cardsInPlay' ||
        typeof card.modifiedPower !== 'number' ||
        !Number.isSafeInteger(card.modifiedPower) ||
        card.modifiedPower < 0,
    )
  )
    return fail('public-domain-incomplete');
  const count = Math.min(effect.max!, offered.length);
  const powers = new Map(offered.map((card) => [str(card.uuid), card.modifiedPower as number]));
  const threshold = [...powers.values()].sort((a, b) => b - a)[count - 1];
  const mandatory = ids.filter((id) => powers.get(id)! > threshold);
  const completable = (prefix: string[]) =>
    prefix.length <= count &&
    prefix.every((id) => powers.has(id) && powers.get(id)! >= threshold) &&
    mandatory.filter((id) => !prefix.includes(id)).length <= count - prefix.length;
  if (!completable(selected)) return fail('selected-prefix-cannot-complete');
  if (buttons.length && selected.length !== count) return fail('completion-control-conflict');
  if (selected.length === count && buttons.length === 0) return fail('completion-control-unreported');
  return {
    allowed: new Set(ids.filter((id) => !selected.includes(id) && completable([...selected, id]))),
    count,
    operation: effect.operation,
  };
}
/** Pinned UpToX(1) deck search keeps highlighting unselected cards after its cap.
 * Bind the exact single-card search schema and its real Done control, not arbitrary prose.
 */
function singleSearchMaximum(me: ObjectValue): number | undefined {
  if (me.menuTitle !== 'Choose a card' || me.selectOrder === true) return undefined;
  const controls = arr(me.controls).map(obj),
    piles = arr(me.promptedPiles).map(obj);
  if (controls.length !== 1 || controls[0].type !== 'targeting') return undefined;
  const binding = str(controls[0].uuid);
  if (!binding.endsWith(':0') || !binding.slice(0, -2)) return undefined;
  const prompt = binding.slice(0, -2);
  if (
    !arr(me.buttons)
      .map(obj)
      .some(
        (b) =>
          b.text === 'Done' &&
          b.arg === 'done' &&
          b.command === 'menuButton' &&
          b.uuid === prompt &&
          b.disabled !== true,
      )
  )
    return undefined;
  if (
    !piles.some((p) => p.location === 'deck' && p.controller === 'self') ||
    piles.some((p) => p.controller !== 'self' || !['deck', 'discard'].includes(str(p.location)))
  )
    return undefined;
  return 1;
}
/** Pinned RearrangeBattlelineAction uses a two-card swap followed by a fresh prompt.
 * Done with fewer than two selections keeps the current order; two commits the swap.
 */
function isBattlelineSwapPrompt(me: ObjectValue): boolean {
  if (me.selectCard !== true || me.selectOrder === true || me.menuTitle !== 'Select two creatures to swap')
    return false;
  const controls = arr(me.controls).map(obj);
  if (controls.length !== 1 || controls[0].type !== 'targeting') return false;
  const binding = str(controls[0].uuid);
  if (!binding.endsWith(':0') || !binding.slice(0, -2)) return false;
  return arr(me.buttons)
    .map(obj)
    .some(
      (b) =>
        b.text === 'Done' &&
        b.arg === 'done' &&
        b.command === 'menuButton' &&
        b.uuid === binding.slice(0, -2) &&
        b.disabled !== true,
    );
}
/** This observed AllocateDamagePrompt title publishes one click's damage, not the total allocation. */
function publicDamageStep(menuTitle: unknown): number | undefined {
  const match = /^Choose a creature to deal ([1-9][0-9]*) damage to[.!]?$/i.exec(label(menuTitle));
  if (!match) return undefined;
  const amount = Number(match[1]);
  return Number.isSafeInteger(amount) ? amount : undefined;
}
const normalize = (v: string): string =>
  v
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const houses = new Set<string>([
  'brobnar',
  'dis',
  'logos',
  'mars',
  'sanctum',
  'shadows',
  'untamed',
  'saurian',
  'staralliance',
  'unfathomable',
  'ekwidon',
  'geistoid',
  'skyborn',
  'redemption',
  'ouboros',
]);
const house = (v: unknown): House | undefined =>
  houses.has(normalize(str(v))) ? (normalize(str(v)) as House) : undefined;
const colors: KeyColor[] = ['red', 'blue', 'yellow'];
const bonusIcons = new Set<BonusIcon>(['amber', 'capture', 'damage', 'draw', 'discard', 'power']);
function resolveDefinition(
  raw: ObjectValue,
  context: 'reference' | 'card' = 'reference',
): CardDefinition | undefined {
  const id = str(raw.id);
  const externalToken = resolveExternalKeytekiToken(raw, context);
  if (externalToken !== undefined) return externalToken ?? undefined;
  if (Object.hasOwn(CATALOG, id)) return CATALOG[id];
  const candidates = Object.values(CATALOG).filter((c) => normalize(c.name) === normalize(str(raw.name))).filter(
    (c) => !c.id.startsWith('toc-token-'),
  );
  if (candidates.length === 1) return candidates[0];
  const numbered = candidates.filter((c) => c.number === str(raw.number));
  return numbered.length === 1 ? numbered[0] : undefined;
}
/** The current native house domain, with opaque option IDs and wire bindings untouched. */
function publicHouseChoices(me: ObjectValue): Map<string, House> {
  const controls = arr(me.controls).map(obj);
  if (controls.length !== 1 || controls[0].type !== 'house-select') return new Map();
  const declared = arr(controls[0].houses).map(house);
  const buttons = arr(me.buttons).map(obj);
  const offered = buttons.map((b, index) => ({ index, house: house(label(b.text)), button: b }));
  if (
    !declared.length ||
    !declared.every((h): h is House => h !== undefined) ||
    new Set(declared).size !== declared.length ||
    offered.length !== declared.length ||
    new Set(offered.map((x) => x.house)).size !== offered.length ||
    !offered.every(
      (x) =>
        x.house !== undefined &&
        declared.includes(x.house) &&
        x.button.disabled !== true &&
        (x.button.command ?? 'menuButton') === 'menuButton' &&
        x.button.method === undefined &&
        !!str(x.button.uuid),
    )
  )
    return new Map();
  return new Map(offered.map((x) => [`keyteki-button-${x.index}`, x.house!]));
}
function cardAbilityMenu(me: ObjectValue): boolean {
  return me.selectCard !== true && /^choose an ability:?\s*$/i.test(label(me.menuTitle));
}
function sourceUuid(
  me: ObjectValue,
  options: KeytekiProjectionOptions,
  cards: Map<string, CardView>,
): string | undefined {
  const choose = (matches: CardView[]): string | undefined => {
    const bound = matches.find((c) => c.id === options.sourceCardId);
    // A target click is not generally a source. Card.use explicitly opens an ability menu
    // for the clicked card; only that public transition can establish a nested source.
    const clicked = cardAbilityMenu(me) ? matches.find((c) => c.id === options.lastClickedCardId) : undefined;
    if (clicked) {
      // Two different same-name bindings cannot establish which physical card owns this
      // menu. Keep that ambiguity explicit instead of turning an unrelated target into a source.
      if (bound && bound.id !== clicked.id) return undefined;
      return clicked.id;
    }
    return bound?.id ?? (matches.length === 1 ? matches[0].id : undefined);
  };
  for (const control of arr(me.controls)) {
    const source = obj(obj(control).source),
      id = str(source.uuid),
      spec = resolveDefinition(source);
    if (cards.has(id)) return id;
    const matches = [...cards.values()].filter((c) =>
      spec ? c.definition === spec.id : normalize(c.spec.name) === normalize(str(source.name)),
    );
    const resolved = choose(matches);
    if (resolved) return resolved;
  }
  const title = normalize(label(me.promptTitle));
  const matched = [...cards.values()].filter((c) => normalize(c.spec.name) === title);
  return title ? choose(matched) : undefined;
}
function phaseOf(me: ObjectValue, finished: boolean): Phase {
  if (finished) return 'finished';
  const title = `${label(me.promptTitle)} ${label(me.menuTitle)}`;
  if (/mulligan|keep starting hand/i.test(title)) return 'mulligan';
  if (/access archives|take.*cards.*archives.*hand/i.test(title)) return 'archives';
  if (/choose active house|choose which house.*activate/i.test(title)) return 'house';
  if (/forge.*key|choose.*key.*forge/i.test(title) || str(me.phase) === 'forge') return 'forge';
  if (
    me.selectCard === true ||
    arr(me.controls).length ||
    /choose an ability|^play /i.test(label(me.menuTitle))
  )
    return 'choice';
  return str(me.phase) === 'main' ? 'main' : 'choice';
}

/** Hidden pile faces and deck ordering are never forwarded. Explicitly revealed, selectable
 * prompt candidates remain audience-visible choices, without exposing an opponent hand array.
 * A locally hosted test must still send getState(seatName), not Game/allCards/player instances.
 */
export function projectKeytekiState(input: unknown, options: KeytekiProjectionOptions): KeytekiProjection {
  if (
    !options.playerName ||
    !Number.isSafeInteger(options.revision) ||
    options.revision < 0 ||
    !Number.isSafeInteger(options.turn) ||
    options.turn < 1
  )
    throw Error('Invalid Keyteki projection identity/revision/turn');
  if (
    options.turnHistory &&
    (typeof options.turnHistory.fromGameStart !== 'boolean' ||
      !Number.isSafeInteger(options.turnHistory.observedEndTurns) ||
      options.turnHistory.observedEndTurns < 0 ||
      !Array.isArray(options.turnHistory.unknownReasons) ||
      options.turnHistory.unknownReasons.some((reason) => typeof reason !== 'string') ||
      (options.turnHistory.fromGameStart &&
        (options.turn !== options.turnHistory.observedEndTurns + 1 ||
          options.turnHistory.unknownReasons.length > 0)) ||
      (!options.turnHistory.fromGameStart && options.turn !== 1))
  )
    throw Error('Invalid or inconsistent public turn history');
  const raw = obj(input),
    rawPlayers = obj(raw.players),
    names = Object.keys(rawPlayers);
  if (names.length !== 2 || !names.includes(options.playerName))
    throw Error('Expected a two-player Keyteki player view');
  // Deterministic seat assignment, independent of object insertion order and which seat receives the view.
  names.sort((a, b) => a.localeCompare(b, 'en'));
  const you = names.indexOf(options.playerName) as Seat;
  const me = obj(rawPlayers[options.playerName]);
  const unknown = new Set<string>([
    'wire-omits-rule-version: external referee version is unreported',
    'wire-omits-turn-history: counters, prior house choices, restrictions and uses use compatibility defaults',
    'wire-omits-effective-armor-keywords-house: printed values except serialized power and taunt',
    'wire-omits-forge-sources: forgeAvailable contains only the public amber pool',
    'wire-omits-effect-state: lasting effects, play/forge restrictions, permissions and effective bonus-icon changes are unknown',
  ]);
  const confirmOneClick = obj(me.optionSettings).confirmOneClick;
  if (confirmOneClick === false)
    unknown.add(
      'one-click-auto-resolution-enabled: a card-entry click may directly resolve its single available action',
    );
  else if (confirmOneClick !== true) unknown.add('one-click-confirmation-unreported');
  const unsupported = new Set<string>();
  if (options.turnHistory && !options.turnHistory.fromGameStart)
    unknown.add(`wire-turn-ordinal-unverified: ${options.turnHistory.unknownReasons.join(', ')}`);
  if (!str(raw.id)) unsupported.add('missing-game-id');
  if (raw.manualMode === true) unsupported.add('manual-mode-is-not-a-legal-action-protocol');
  if (raw.started !== true) unsupported.add('game-not-started');
  const administrativeRequest = administrativeBinding(raw, me, names, you);
  if (administrativeTemplate(me) && !administrativeRequest)
    unsupported.add('administrative-request-schema-unsupported');
  const rawById = new Map<string, ObjectValue>();
  const cards = new Map<string, CardView>();
  const locations = new Map<string, string>();
  const underCards: Observation['underCards'] = [];
  const playerRaw = names.map((n) => obj(rawPlayers[n]));
  function card(
    rawValue: unknown,
    seat: Seat,
    location: string,
    parent: string | null = null,
    diagnosticReference?: CardDefinition,
  ): CardView | undefined {
    const r = obj(rawValue),
      id = str(r.uuid);
    if (!id || r.facedown === true || (!str(r.id) && !str(r.name))) return undefined;
    if (cards.has(id)) return cards.get(id);
    // Only the locally constructed, non-physical prompt source below can carry
    // a definition already verified as a reference. Native cards always use the
    // strict card-face resolver, including its actual isToken requirement.
    const printed = diagnosticReference ?? resolveDefinition(r, 'card');
    if (!printed) {
      unsupported.add(`unmapped-visible-card:${str(r.id) || str(r.name)}`);
      return undefined;
    }
    // The public wire explicitly reports the current attached upgrade form.
    // Use the public knowledge pack's declared-form projection; do not infer copied
    // text, arbitrary type-changing effects or hidden play history.
    const alternateUpgrade =
      location === 'upgrades' &&
      parent !== null &&
      r.type === 'upgrade' &&
      r.copying !== true &&
      !!printed.playAsUpgrade;
    const spec = alternateUpgrade ? upgradeForm(printed) : printed;
    if (cardKnowledgeIsPartial(spec))
      unknown.add('partial-strategy-knowledge:' + spec.id);
    if (r.copying === true) unknown.add(`copy-text-unreported:${id}`);
    const controllerName = str(r.controller),
      controller = names.includes(controllerName) ? (names.indexOf(controllerName) as Seat) : seat;
    const ownerName = str(r.owner);
    const owner = names.includes(ownerName)
      ? (names.indexOf(ownerName) as Seat)
      : r.controlled === true
        ? controller === 0
          ? 1
          : 0
        : seat;
    const tokens = obj(r.tokens),
      printedHouse = house(r.printedHouse) ?? spec.house;
    const keywords = [...(spec.keywords ?? [])];
    if (typeof r.taunt === 'boolean') {
      const index = keywords.indexOf('taunt');
      if (!r.taunt && index >= 0) keywords.splice(index, 1);
      if (r.taunt && index < 0) keywords.push('taunt');
    }
    const c: CardView = {
      id,
      definition: spec.id,
      owner,
      controller,
      ready: r.exhausted !== true,
      damage: nonnegative(tokens.damage),
      armorUsed: 0,
      elusiveUsed: false,
      captured: nonnegative(tokens.amber),
      stunned: r.stunned === true,
      powerCounters: nonnegative(tokens.power),
      attachedTo: parent,
      enteredController: controller,
      foreignArchiveHolder: location === 'archives' && owner !== seat ? seat : null,
      printedHouse,
      spec: structuredClone(spec),
      ...(alternateUpgrade ? { form: 'upgrade' as const } : {}),
      effective: {
        house: printedHouse,
        power: nonnegative(r.modifiedPower, nonnegative(r.powerPrinted, spec.power)),
        armor: nonnegative(r.armorPrinted, spec.armor),
        keywords,
        assault: spec.assault ?? 0,
        hazardous: spec.hazardous ?? 0,
        ...(spec.splashAttack ? { splashAttack: spec.splashAttack } : {}),
      },
      usesThisTurn: 0,
      ...(nonnegative(tokens.ward) > 0 || r.warded === true ? { warded: true } : {}),
      ...(nonnegative(tokens.enrage) > 0 || r.enraged === true ? { enraged: true } : {}),
    };
    if (r.isToken === true) {
      if (!spec.tokenReference) unsupported.add(`unmapped-token-face:${id}`);
      else {
        if (!Object.hasOwn(CATALOG, spec.id))
          unknown.add(`external-token-definition:${spec.id}: public-wire-only`);
        c.tokenCreature = { reference: spec.id, publicId: id };
        unknown.add(`token-maker-unreported:${id}`);
      }
      // Only the controller is entitled to the reverse face. Never inspect an
      // opponent's injected versusCard payload, even if a transport included it.
      if (controller === you && r.versusCard) {
        const reverse = obj(r.versusCard),
          reverseDefinition = resolveDefinition(reverse),
          enhancements = reverse.enhancements == null ? [] : arr(reverse.enhancements),
          amber = reverse.cardPrintedAmber;
        if (
          reverseDefinition &&
          reverse.uuid === id &&
          typeof amber === 'number' &&
          Number.isSafeInteger(amber) &&
          amber >= 0 &&
          (reverse.enhancements == null || Array.isArray(reverse.enhancements)) &&
          enhancements.every((icon) => bonusIcons.has(icon as BonusIcon) || house(icon) !== undefined)
        ) {
          const reverseHouses = enhancements
            .map(house)
            .filter((value): value is House => value !== undefined);
          c.tokenReverse = {
            definition: reverseDefinition.id,
            ...(house(reverse.printedHouse) ? { printedHouse: house(reverse.printedHouse)! } : {}),
            bonusIcons: [
              ...Array<BonusIcon>(amber).fill('amber'),
              ...enhancements.filter((icon): icon is BonusIcon => bonusIcons.has(icon as BonusIcon)),
            ],
            ...(reverseHouses.length ? { bonusHouses: reverseHouses } : {}),
          };
        } else unknown.add(`token-reverse-fields-unmapped:${id}`);
      }
    }
    // These are the printed amber prefix and per-copy enhancements actually sent to
    // this player. Do not infer effective icon replacement/copy effects from card text.
    if (
      typeof r.cardPrintedAmber === 'number' &&
      Number.isSafeInteger(r.cardPrintedAmber) &&
      r.cardPrintedAmber >= 0
    ) {
      // GiganticCard explicitly serializes an iconless half with enhancements:null.
      const enhancements = r.enhancements == null ? [] : arr(r.enhancements);
      if (
        (r.enhancements == null || Array.isArray(r.enhancements)) &&
        enhancements.every((icon) => bonusIcons.has(icon as BonusIcon) || house(icon) !== undefined)
      ) {
        c.bonusIcons = [
          ...Array<BonusIcon>(r.cardPrintedAmber).fill('amber'),
          ...enhancements.filter((icon): icon is BonusIcon => bonusIcons.has(icon as BonusIcon)),
        ];
        const addedHouses = enhancements.map(house).filter((value): value is House => value !== undefined);
        if (addedHouses.length) {
          c.bonusHouses = addedHouses;
          c.effective.houses = [...new Set([printedHouse, ...addedHouses])];
        }
      } else unsupported.add(`unmapped-visible-enhancement:${id}`);
    } else unknown.add(`printed-bonus-icons-unreported:${id}`);
    cards.set(id, c);
    rawById.set(id, r);
    locations.set(id, location);
    for (const upgrade of arr(r.upgrades)) card(upgrade, seat, 'upgrades', id);
    const children = arr(r.childCards);
    if (children.length) {
      const visible = children
        .map((child) => card(child, seat, 'under', id))
        .filter((x): x is CardView => !!x);
      underCards.push({ source: id, count: children.length, ...(visible.length ? { cards: visible } : {}) });
    }
    return c;
  }
  function pile(p: ObjectValue, key: string, seat: Seat): CardView[] {
    return arr(obj(p.cardPiles)[key])
      .map((r) => card(r, seat, key))
      .filter((x): x is CardView => !!x);
  }
  const players = playerRaw.map((p, i) => {
    const seat = i as Seat,
      own = seat === you,
      stats = obj(p.stats),
      piles = obj(p.cardPiles);
    const inPlay = pile(p, 'cardsInPlay', seat),
      discard = pile(p, 'discard', seat),
      purged = pile(p, 'purged', seat);
    const hand = own ? pile(p, 'hand', seat) : undefined;
    const archives = own ? pile(p, 'archives', seat) : undefined;
    const declaredHouses = arr(p.houses ?? stats.houses)
      .map(house)
      .filter((x): x is House => !!x);
    if (!declaredHouses.length) unsupported.add(`missing-houses:${names[i]}`);
    const amber = nonnegative(stats.amber),
      keys = obj(stats.keys);
    const pview: PlayerView = {
      houses: declaredHouses,
      amber,
      keys: colors.filter((k) => keys[k] === true),
      keyCost: nonnegative(stats.keyCost, 6),
      chains: nonnegative(stats.chains),
      skipForgeTurn: null,
      lastForgedTurn: null,
      forgedOn: {},
      forgeAvailable: amber,
      deckList: raw.hideDeckLists === true ? [] : structuredClone(options.deckLists?.[names[i]] ?? []),
      deckCount: nonnegative(p.numDeckCards),
      handCount: arr(piles.hand).length,
      archiveCount: nonnegative(p.numArchivesCards, arr(piles.archives).length),
      ...(own ? { hand, archives } : {}),
      battleline: inPlay.filter((c) => (rawById.get(c.id)?.type ?? c.spec.kind) === 'creature'),
      artifacts: inPlay.filter(
        (c) =>
          rawById.get(c.id)?.type === 'artifact' || (!rawById.get(c.id)?.type && c.spec.kind === 'artifact'),
      ),
      upgrades: [...cards.values()].filter(
        (c) => c.controller === seat && locations.get(c.id) === 'upgrades',
      ),
      discard,
      purged,
    };
    if (!pview.deckList.length) unknown.add(`public-deck-list-unavailable:${names[i]}`);
    if (typeof stats.keyCost !== 'number')
      unknown.add(`key-cost-unreported:${names[i]}: compatibility value 6`);
    const revealedTop = card(p.deckTopCard, seat, 'revealedTop');
    if (revealedTop) pview.revealedTop = revealedTop;
    return pview;
  }) as [PlayerView, PlayerView];
  const prophecies: NonNullable<Observation['prophecies']> = [];
  const prophecyFaces = new Map<string, { slot: string; face: 0 | 1; owner: Seat; raw: ObjectValue }>();
  for (const [index, p] of playerRaw.entries()) {
    if (p.prophecyCards === undefined || (Array.isArray(p.prophecyCards) && p.prophecyCards.length === 0))
      continue;
    const seat = index as Seat,
      faces = arr(p.prophecyCards).map(obj),
      ids = faces.map((r) => str(r.uuid));
    // Pinned player.getSummaryForCardList preserves order; prophecyFlipSide uses
    // adjacent indices (0/1 and 2/3). Never derive physical pairs by sorting four names.
    if (
      !Array.isArray(p.prophecyCards) ||
      faces.length !== 4 ||
      new Set(ids).size !== 4 ||
      new Set(faces.map((r) => r.id)).size !== 4 ||
      faces.some((r) => {
        const fact = prophecyFacts.get(str(r.id));
        return (
          !str(r.uuid) ||
          !fact ||
          r.type !== 'prophecy' ||
          r.facedown !== false ||
          r.number !== fact.number ||
          typeof r.activeProphecy !== 'boolean' ||
          typeof r.canActivateProphecy !== 'boolean' ||
          !Array.isArray(r.childCards) ||
          r.copying === true ||
          r.controlled === true ||
          cards.has(str(r.uuid)) ||
          prophecyFaces.has(str(r.uuid))
        );
      })
    ) {
      unsupported.add(`prophecy-public-pair-schema-unsupported:${names[index]}`);
      continue;
    }
    for (let pair = 0; pair < faces.length; pair += 2) {
      const physical = faces.slice(pair, pair + 2);
      if (
        physical.filter((r) => r.activeProphecy === true).length > 1 ||
        physical.filter((r) => arr(r.childCards).length > 0).length > 1 ||
        (physical.some((r) => r.activeProphecy === true) &&
          physical.some((r) => r.activeProphecy === false && arr(r.childCards).length > 0))
      ) {
        unsupported.add(`prophecy-public-pair-state-conflict:${names[index]}:${pair / 2}`);
        continue;
      }
      const ordered = [...physical].sort((a, b) => str(a.id).localeCompare(str(b.id), 'en'));
      const slot = `keyteki-prophecy:${index}:${physical
        .map((r) => str(r.uuid))
        .sort()
        .join(':')}`;
      const activeIndex = ordered.findIndex((r) => r.activeProphecy === true);
      const active = activeIndex >= 0;
      // FulfillProphecyAction deactivates the face before resolving its now-public
      // Fate card. Preserve that real intermediate state through the Fate prompt.
      const occupiedIndex = ordered.findIndex((r) => arr(r.childCards).length > 0);
      const currentIndex = active ? activeIndex : occupiedIndex >= 0 ? occupiedIndex : 0;
      const children = arr(ordered[currentIndex].childCards).map(obj);
      const visible: CardView[] = [];
      const childIds = new Set<string>();
      for (const child of children) {
        const childId = str(child.uuid);
        if (!childId || childIds.has(childId) || ids.includes(childId) || cards.has(childId)) {
          unsupported.add(`prophecy-latent-identity-conflict:${slot}`);
          continue;
        }
        childIds.add(childId);
        // The controller's facedown card is audience-visible in the actual wire.
        // An opponent's hidden child never gains a face from injected metadata.
        if (seat !== you && child.facedown !== false) continue;
        if (!str(child.id) || !str(child.name) || (child.facedown !== true && child.facedown !== false)) {
          if (seat === you) unknown.add(`own-prophecy-latent-face-unreported:${slot}`);
          continue;
        }
        const projected = card({ ...child, facedown: false }, seat, 'prophecy');
        if (projected) visible.push(projected);
      }
      prophecies.push({
        id: slot,
        owner: seat,
        faces: [str(ordered[0].id), str(ordered[1].id)],
        face: currentIndex as 0 | 1,
        active,
        count: children.length,
        revealed: children.length > 0 && children.every((c) => c.facedown === false),
        ...(visible.length ? { cards: visible } : {}),
      });
      ordered.forEach((r, face) =>
        prophecyFaces.set(str(r.uuid), {
          slot,
          face: face as 0 | 1,
          owner: seat,
          raw: r,
        }),
      );
    }
  }
  if (prophecies.length) {
    prophecies.sort((a, b) => a.id.localeCompare(b.id, 'en'));
    unknown.add(
      'public-prophecy-pairs: adjacent wire faces define physical slots; imported core pairing is not assumed',
    );
    unknown.add('prophecy-history-and-inactive-orientation-unreported: current activation affordances only');
  }
  // Revealed candidates in a prompted deck are player-visible choices, not access to remaining order.
  // Preserve only the actual selectable faces and discard the serialized array's ordering.
  if (me.selectCard === true && arr(me.promptedPiles).some((p) => obj(p).location === 'deck')) {
    for (const p of playerRaw) {
      for (const value of arr(obj(p.cardPiles).deck)) {
        const r = obj(value);
        if (r.selectable === true && r.facedown !== true) card(r, playerRaw.indexOf(p) as Seat, 'prompt');
      }
    }
    unknown.add('revealed-deck-candidates-are-unordered');
  }
  // A prompt may explicitly reveal an opposing hand to this audience. Preserve only
  // the exact selectable faces, never the opponent's hand container or unshown identities.
  if (
    me.selectCard === true &&
    arr(me.promptedPiles).some((p) => obj(p).location === 'hand' && obj(p).controller === 'opponent')
  ) {
    const opponent = (you === 0 ? 1 : 0) as Seat;
    for (const value of arr(obj(playerRaw[opponent].cardPiles).hand)) {
      const r = obj(value);
      if (r.facedown === false && r.selectable === true && r.unselectable !== true)
        card(r, opponent, 'prompt');
    }
    unknown.add('revealed-opponent-hand-candidates-only: unshown faces and the hand container stay hidden');
  }
  // Control summaries carry public identity but no physical UUID. A played action can be in
  // keyteki's unsent 'being played' zone. Retain the last clicked public ID when available;
  // otherwise use a non-clickable diagnostic ID solely for visible resolving-source semantics.
  for (const value of arr(me.controls)) {
    const source = obj(obj(value).source),
      spec = resolveDefinition(source);
    if (!spec || source.facedown === true) continue;
    const candidates = [...cards.values()].filter((c) => c.definition === spec.id);
    if (candidates.length === 0) {
      const reference = spec.tokenReference ? spec : undefined;
      const id =
        !reference && options.sourceCardId && !cards.has(options.sourceCardId)
          ? options.sourceCardId
          : `keyteki-prompt-source:${spec.id}`;
      // MakeToken's flank prompt names the public token reference before any
      // physical token has entered play. Its short summary is not a native
      // creature face. Keep only its verified identity for diagnostics: never
      // reuse a physical source UUID, invent isToken, or copy entity/target data.
      const diagnostic = reference
        ? {
            id: str(source.id),
            name: spec.name,
            uuid: id,
            printedHouse: spec.house,
            type: spec.kind,
            cardPrintedAmber: spec.amber,
            canPlay: false,
            exhausted: true,
          }
        : { ...source, uuid: id, printedHouse: spec.house, type: spec.kind, canPlay: false, exhausted: true };
      card(diagnostic, you, 'resolving', null, reference);
      unknown.add('prompt-source-location: public control source is outside serialized player piles');
    }
  }
  // These native Play sources can be in the unserialized being-played zone.
  // A visible namesake is not the physical card whose actual Play was selected.
  // Retain only that verified identity as a non-clickable resolving diagnostic.
  const rememberedPlay = options.resolvingPlaySource;
  const rememberedHousePrompt =
    rememberedPlay?.definition === 'they-tell-no-tales' &&
    me.selectCard === false &&
    label(me.promptTitle) === 'They Tell No Tales' &&
    label(me.menuTitle) === 'Choose a house' &&
    publicHouseChoices(me).size > 0;
  const rememberedSealPrompt =
    rememberedPlay?.definition === 'divine-seal' &&
    me.selectCard === true &&
    label(me.promptTitle) === 'Divine Seal' &&
    label(me.menuTitle) === 'Choose a creature' &&
    !arr(me.promptedPiles).length &&
    (() => {
      const controls = arr(me.controls).map(obj);
      if (controls.length !== 1 || controls[0].type !== 'targeting') return false;
      const source = obj(controls[0].source);
      if (
        source.facedown === true ||
        source.copying === true ||
        resolveDefinition(source)?.id !== 'divine-seal' ||
        (str(source.uuid) && str(source.uuid) !== rememberedPlay.id)
      )
        return false;
      const offered = [...rawById].filter(([, c]) => c.selectable === true && c.unselectable !== true);
      const creatures = new Set(players.flatMap((p) => p.battleline.map((c) => c.id)));
      return (
        ![...rawById.values()].some((c) => c.selected === true) &&
        offered.length > 0 &&
        offered.every(([id]) => creatures.has(id))
      );
    })();
  const rememberedGiftPrompt =
    rememberedPlay?.definition === 'a-gift-of-æmber' &&
    me.selectCard === true &&
    label(me.promptTitle) === 'A Gift of Æmber' &&
    str(obj(me.menuTitle).text) === 'Choose {{amount}} creatures' &&
    publicSelectionMaximum(me.menuTitle) === 2 &&
    !arr(me.promptedPiles).length &&
    (() => {
      const controls = arr(me.controls).map(obj),
        buttons = arr(me.buttons).map(obj),
        button = buttons[0],
        source = obj(controls[0]?.source);
      if (
        controls.length !== 1 ||
        controls[0].type !== 'targeting' ||
        buttons.length !== 1 ||
        button.text !== 'Done' ||
        button.arg !== 'done' ||
        button.command !== 'menuButton' ||
        button.method !== undefined ||
        button.disabled === true ||
        !str(button.uuid) ||
        controls[0].uuid !== `${button.uuid}:0` ||
        source.facedown === true ||
        source.copying === true ||
        resolveDefinition(source)?.id !== 'a-gift-of-æmber' ||
        (str(source.uuid) && str(source.uuid) !== rememberedPlay.id)
      )
        return false;
      const creatures = new Set(players.flatMap((p) => p.battleline.map((c) => c.id))),
        selected = [...rawById].filter(([, c]) => c.selected === true),
        offered = [...rawById].filter(([, c]) => c.selectable === true && c.unselectable !== true);
      return selected.length <= 2 && [...selected, ...offered].every(([id]) => creatures.has(id));
    })();
  const verifiedRememberedPlay =
    !administrativeRequest &&
    rememberedPlay &&
    rememberedPlay.id === options.sourceCardId &&
    rememberedPlay.gameId === str(raw.id) &&
    rememberedPlay.playerName === options.playerName &&
    rememberedPlay.turn === options.turn &&
    rememberedPlay.controller === you &&
    (rememberedPlay.owner === 0 || rememberedPlay.owner === 1) &&
    !options.prophecyActivation &&
    me.activePlayer === true &&
    me.selectOrder === false &&
    (rememberedHousePrompt || rememberedSealPrompt || rememberedGiftPrompt);
  if (verifiedRememberedPlay && !cards.has(rememberedPlay.id)) {
    const spec = CATALOG[rememberedPlay.definition];
    card(
      {
        uuid: rememberedPlay.id,
        id: spec.id,
        name: spec.name,
        owner: names[rememberedPlay.owner],
        controller: names[rememberedPlay.controller],
        printedHouse: spec.house,
        type: spec.kind,
        canPlay: false,
        exhausted: true,
        selectable: false,
        facedown: false,
      },
      you,
      'resolving',
    );
    unknown.add('prompt-source-location: verified played action is outside serialized player piles');
  }
  // HandlerMenuPrompt's card buttons bind the physical card in arg. The nested
  // card is only a short public summary, so it legitimately has no uuid (Survey).
  // Reading that explicit face does not inspect either player's remaining deck.
  const buttonCards = new Map<number, string>();
  for (const [index, value] of arr(me.buttons).entries()) {
    const button = obj(value),
      summary = obj(button.card),
      id = str(button.arg);
    if (
      button.disabled === true ||
      (button.command ?? 'menuButton') !== 'menuButton' ||
      !str(button.uuid) ||
      !id ||
      !str(summary.id) ||
      summary.facedown === true
    )
      continue;
    if (str(summary.uuid) && str(summary.uuid) !== id) {
      unsupported.add(`card-button-binding-mismatch:${index}`);
      continue;
    }
    const existing = cards.get(id);
    const definition = resolveDefinition(summary);
    if (existing && definition && existing.definition !== definition.id) {
      unsupported.add(`card-button-face-mismatch:${index}`);
      continue;
    }
    const projected = existing ?? card({ ...summary, uuid: id, canPlay: false }, you, 'prompt');
    if (projected) {
      buttonCards.set(index, id);
      if (!existing)
        unknown.add(
          'handler-card-summary: prompt candidate owner and effective attributes are not serialized',
        );
    }
  }
  const winner = names.includes(str(raw.winner)) ? (names.indexOf(str(raw.winner)) as Seat) : null;
  const phase = administrativeRequest ? 'choice' : phaseOf(me, winner !== null);
  const title = `${label(me.promptTitle)} ${label(me.menuTitle)}`;
  const fightTarget = me.selectCard === true && /choose a creature to attack/i.test(label(me.menuTitle));
  // A fight has already begun when its target is requested: the attacker may now be exhausted.
  // Only currently visible creatures in play can supply this source; a purged/discarded namesake
  // must not make the in-play identity ambiguous or replace a remembered physical attacker.
  const sourceCandidates = fightTarget
    ? new Map(players.flatMap((p) => p.battleline).map((c) => [c.id, c] as const))
    : cards;
  const infurnace = administrativeRequest
    ? undefined
    : keytekiInfurnaceContract({
        me,
        you,
        players,
        rawById,
      });
  if (infurnace?.unknown) unknown.add(infurnace.unknown);
  const source = administrativeRequest
    ? undefined
    : (infurnace?.contract?.source ?? sourceUuid(me, options, sourceCandidates));
  const sourceCard = source ? cards.get(source) : undefined;
  // A remembered navigation source alone is insufficient: the current public
  // title must bind that same card. These narrow Play prompts do not certify
  // arbitrary copied text, Fate, historical restrictions or complete effects.
  const boundPlaySource =
    !!sourceCard &&
    sourceCard.controller === you &&
    options.sourceCardId === source &&
    options.prophecyActivation === undefined &&
    rawById.get(source!)?.copying !== true &&
    phase === 'choice' &&
    normalize(label(me.promptTitle)) === normalize(sourceCard.spec.name);
  const upgradeTarget =
    me.selectCard === true &&
    /choose a (creature|card) to attach(?:ed)? this upgrade to/i.test(label(me.menuTitle));
  // A forced fight may expose a short source without UUID while two same-name
  // attackers are in play. The server still publishes exact selectable defenders.
  // Preserve those target clicks without inventing a physical attacker for scoring.
  if (fightTarget && !source)
    unknown.add('fight-attacker-unresolved: exact server-selectable defenders remain target choices');
  if (cardAbilityMenu(me) && !source)
    unknown.add('card-ability-source-unresolved: exact menu buttons remain generic choices');
  let pending: PendingView | null =
    phase === 'choice' || me.selectCard === true
      ? {
          kind: administrativeRequest
            ? 'option'
            : me.selectOrder === true
              ? 'order'
              : /archive/i.test(title)
                ? 'archive'
                : me.selectCard === true
                  ? 'target'
                  : 'option',
          source: source ?? '',
          actor: you,
          amount: 0,
          reward: 0,
          label: label(me.menuTitle),
          selected: [...rawById.entries()].filter(([, r]) => r.selected === true).map(([id]) => id),
          options: [],
        }
      : null;
  if (pending && me.selectCard === true) {
    const assigned: [string, number][] = [],
      wardBreaks: string[] = [];
    for (const [id, r] of rawById) {
      if (locations.get(id) !== 'cardsInPlay') continue;
      if (typeof r.pseudoDamage === 'number' && Number.isSafeInteger(r.pseudoDamage) && r.pseudoDamage > 0)
        assigned.push([id, r.pseudoDamage]);
      if (r.wardBroken === true) wardBreaks.push(id);
    }
    // Repeated targets remain selectable. Preview counters are neither settled damage nor selected cards.
    if (assigned.length || wardBreaks.length)
      pending.damagePreview = { assigned: Object.fromEntries(assigned), wardBreaks: wardBreaks.sort() };
  }
  const singleSearchCap = me.selectCard === true ? singleSearchMaximum(me) : undefined;
  const swapPrompt = isBattlelineSwapPrompt(me);
  const selectionMaximum =
    me.selectCard === true
      ? (publicSelectionMaximum(me.menuTitle) ??
        unnaturalSelectionMaximum(me) ??
        singleSearchCap ??
        (swapPrompt ? 2 : undefined))
      : undefined;
  if (singleSearchCap !== undefined && (pending?.selected?.length ?? 0) > singleSearchCap)
    unsupported.add('single-search-selection-contract-conflict');
  if (swapPrompt && (pending?.selected?.length ?? 0) > 2)
    unsupported.add('swap-pair-selection-contract-conflict');
  if (pending && selectionMaximum !== undefined) {
    pending.max = selectionMaximum;
    pending.amount = selectionMaximum;
    pending.selectedCount = pending.selected?.length ?? 0;
    unknown.add('selection-minimum-unreported: completion is offered by the current server Done button');
  }
  if (
    pending &&
    verifiedRememberedPlay &&
    rememberedGiftPrompt &&
    boundPlaySource &&
    source === rememberedPlay.id &&
    locations.get(source) === 'resolving'
  ) {
    // The played physical Gift and its current native Done establish this
    // optional selector. The generic "Choose 2" title alone does not certify a minimum.
    pending.min = 0;
    pending.max = 2;
    pending.amount = 2;
    pending.intent = { kind: 'target-operation', operation: 'destroy' };
    unknown.delete('selection-minimum-unreported: completion is offered by the current server Done button');
  }
  const rankedSelection =
    me.selectCard === true && !administrativeRequest
      ? publicRankedTargetSelection(me, playerRaw, rawById, locations, pending?.selected ?? [])
      : undefined;
  if (rankedSelection && 'error' in rankedSelection) unsupported.add(rankedSelection.error);
  else if (pending && rankedSelection) {
    unknown.delete('selection-minimum-unreported: completion is offered by the current server Done button');
    pending.min = rankedSelection.count;
    pending.max = rankedSelection.count;
    pending.amount = rankedSelection.count;
    pending.intent = { kind: 'target-operation', operation: rankedSelection.operation };
  }
  if (pending && (me.selectCard === true || buttonCards.size > 0) && !fightTarget) {
    const damageStep = me.selectCard === true ? publicDamageStep(me.menuTitle) : undefined;
    const operation: Operation | undefined =
      damageStep !== undefined
        ? 'damage'
        : /\bdestroy\b/i.test(title)
          ? 'destroy'
          : /\bpurge\b/i.test(title)
            ? 'purge'
            : /\bstun\b/i.test(title)
              ? 'stun'
              : /\bexhaust\b/i.test(title)
                ? 'exhaust'
                : /\bcapture\b/i.test(label(me.menuTitle))
                  ? 'capture'
                  : /\bdiscard\b/i.test(label(me.menuTitle))
                    ? 'discard'
                    : source &&
                        cards.get(source)?.definition === 'reaver' &&
                        /^Choose a captured amber to move to your pool\.$/i.test(label(me.menuTitle))
                      ? 'takeAmber'
                      : source &&
                          cards.get(source)?.definition === 'reaver' &&
                          /^Choose a card$/i.test(label(me.menuTitle)) &&
                          arr(me.promptedPiles).some(
                            (pile) => obj(pile).location === 'hand' && obj(pile).controller === 'self',
                          )
                        ? 'discard'
                        : undefined;
    if (operation) pending.intent = { kind: 'target-operation', operation };
    else if (
      boundPlaySource &&
      sourceCard?.definition === 'divine-seal' &&
      me.selectCard === true &&
      me.selectOrder !== true &&
      /^Choose a creature$/i.test(label(me.menuTitle).trim()) &&
      !arr(me.promptedPiles).length &&
      !pending.selected?.length
    ) {
      const targeting = arr(me.controls)
        .map(obj)
        .filter((c) => c.type === 'targeting');
      const publicSource = targeting.length === 1 ? obj(targeting[0].source) : undefined;
      const offered = [...rawById].filter(([, r]) => r.selectable === true && r.unselectable !== true);
      const creatures = new Set(players.flatMap((p) => p.battleline.map((c) => c.id)));
      // Native Divine Seal Play has this exact creature selector. Its Fate
      // purges a fixed bottom card and has no such target prompt. Never derive
      // the operation from the combined Play/Fate summary or expand the menu.
      if (
        publicSource &&
        publicSource.facedown !== true &&
        resolveDefinition(publicSource)?.id === 'divine-seal' &&
        (!str(publicSource.uuid) || str(publicSource.uuid) === source) &&
        offered.length > 0 &&
        offered.every(([id]) => creatures.has(id))
      )
        pending.intent = { kind: 'target-operation', operation: 'deckBottom' };
    }
    if (damageStep !== undefined) pending.amount = damageStep;
  }
  if (
    pending &&
    source &&
    cards.get(source)?.definition === 'cauldron' &&
    /^Choose a card to play$/i.test(label(me.menuTitle))
  )
    pending.label = `Cauldron: ${label(me.menuTitle)}`;
  const semanticHouses = new Map<string, House>();
  if (
    boundPlaySource &&
    sourceCard?.definition === 'they-tell-no-tales' &&
    me.selectCard !== true &&
    pending?.kind === 'option' &&
    pending.label === 'Choose a house'
  ) {
    for (const [id, h] of publicHouseChoices(me)) semanticHouses.set(id, h);
  }
  if (pending && infurnace?.contract) {
    pending.intent = infurnace.contract.intent;
    if (pending.intent.kind === 'infurnace-targets') {
      // This comes from the verified source + exact native Done/pile contract,
      // never from an arbitrary Choose 2 title. The current legal menu is unchanged.
      pending.min = 0;
      pending.max = 2;
      unknown.delete('selection-minimum-unreported: completion is offered by the current server Done button');
    }
  }
  const commands: Record<string, KeytekiCommand> = Object.create(null) as Record<string, KeytekiCommand>;
  const legalActions: LegalAction[] = [],
    navigationActionIds: string[] = [];
  function add(
    action: Action,
    command: KeytekiCommand,
    display?: string,
    useDescription?: LegalAction['useDescription'],
  ) {
    const id = JSON.stringify(action);
    if (Object.hasOwn(commands, id)) {
      unsupported.add(`ambiguous-wire-action:${id}`);
      return;
    }
    legalActions.push({
      id,
      action,
      ...(useDescription ? { useDescription: structuredClone(useDescription) } : {}),
    });
    commands[id] = command;
    if (command.navigation) navigationActionIds.push(id);
    if (display && action.kind === 'choose') {
      if (!pending)
        pending = { kind: 'option', source: source ?? '', actor: you, amount: 0, reward: 0, options: [] };
      const publicHouse = semanticHouses.get(action.option);
      pending.options!.push({
        id: action.option,
        label: display,
        ...(source ? { source } : {}),
        ...(publicHouse ? { house: publicHouse } : {}),
      });
    }
  }
  const abilityChoices: NonNullable<LegalAction['useDescription']>[] = [];
  if (sourceCard)
    for (const trigger of ['action', 'omni'] as const) {
      const printed = sourceCard.spec.abilities?.[trigger];
      if (printed) abilityChoices.push({ trigger, label: sourceCard.spec.name, effects: printed });
      for (const upgrade of players.flatMap((p) => p.upgrades).filter((c) => c.attachedTo === source)) {
        const granted = upgrade.spec.upgrade?.abilities?.[trigger];
        if (granted) abilityChoices.push({ trigger, label: upgrade.spec.name, effects: granted });
      }
    }
  const buttons = arr(me.buttons).map(obj);
  const prophecyPrompt =
    me.menuTitle === 'Activate prophecy?'
      ? 'confirm'
      : me.menuTitle === 'Choose a card from your hand to place under the prophecy'
        ? 'place'
        : undefined;
  let prophecyContinuation: KeytekiProphecyActivation | undefined;
  if (prophecyPrompt && !administrativeRequest) {
    const requested = options.prophecyActivation,
      binding = requested && prophecyFaces.get(requested.prophecyUuid),
      hand = requested && players[you].hand?.find((c) => c.id === requested.action.card),
      handRaw = hand && rawById.get(hand.id),
      controls = arr(me.controls).map(obj),
      control = controls[0],
      controlSource = obj(control?.source),
      buttonUuid = str(buttons[0]?.uuid);
    const sourceBound =
      binding &&
      controls.length === 1 &&
      control.type === 'targeting' &&
      controlSource.id === binding.raw.id &&
      controlSource.type === 'prophecy' &&
      controlSource.facedown === false &&
      (!str(controlSource.uuid) || controlSource.uuid === requested!.prophecyUuid) &&
      label(me.promptTitle) === prophecyFacts.get(str(binding.raw.id))!.name &&
      Array.isArray(control.targets) &&
      control.targets.length === 0 &&
      /^.+:0$/.test(str(control.uuid));
    const promptBound =
      prophecyPrompt === 'confirm'
        ? me.selectCard === false &&
          me.selectOrder === false &&
          buttons.length === 2 &&
          buttonUuid &&
          control?.uuid === `${buttonUuid}:0` &&
          (!requested?.confirmationUuid || requested.confirmationUuid === buttonUuid) &&
          !requested?.placementUuid &&
          buttons.every(
            (b) =>
              b.uuid === buttonUuid &&
              b.command === 'menuButton' &&
              b.method === undefined &&
              b.disabled !== true &&
              ((b.arg === 0 && b.text === 'Yes') || (b.arg === 1 && b.text === 'No')),
          ) &&
          new Set(buttons.map((b) => b.arg)).size === 2 &&
          binding?.raw.activeProphecy === false &&
          binding.raw.canActivateProphecy === true
        : me.selectCard === true &&
          me.selectOrder !== true &&
          buttons.length === 0 &&
          (!requested?.placementUuid || requested.placementUuid === control?.uuid) &&
          arr(me.promptedPiles).length === 1 &&
          obj(arr(me.promptedPiles)[0]).location === 'hand' &&
          obj(arr(me.promptedPiles)[0]).controller === 'self' &&
          binding?.raw.activeProphecy === true &&
          handRaw?.selectable === true &&
          handRaw.unselectable !== true &&
          handRaw.selected !== true;
    if (
      !requested ||
      requested.action.kind !== 'activateProphecy' ||
      !['confirm', 'place'].includes(requested.stage) ||
      (prophecyPrompt === 'place' && requested.stage !== 'place') ||
      !binding ||
      binding.owner !== you ||
      binding.slot !== requested.action.slot ||
      binding.face !== requested.action.face ||
      !hand ||
      handRaw?.facedown !== false ||
      me.activePlayer !== true ||
      !sourceBound ||
      !promptBound
    )
      unsupported.add('prophecy-activation-navigation-binding-required');
    else {
      prophecyContinuation = { ...requested, stage: prophecyPrompt };
      if (pending) pending.source = requested.prophecyUuid;
    }
  }
  const describedAbility = (button: ObjectValue) => {
    const text = label(button.text);
    if (
      button.disabled === true ||
      !(/^(action|omni)(\b|:)/i.test(text) || /^use this card's (action|omni) ability$/i.test(text))
    )
      return undefined;
    const trigger = /\bomni\b/i.test(text) ? 'omni' : 'action';
    const announced = normalize(str(obj(obj(button.tooltip).values).card));
    const matches = abilityChoices
      .map((description, index) => ({ description, index }))
      .filter(
        (c) =>
          c.description.trigger === trigger && (!announced || normalize(c.description.label) === announced),
      );
    return matches.length === 1 ? matches[0] : undefined;
  };
  const describedButtons = buttons.map(describedAbility);
  for (let i = 0; i < buttons.length; i++) {
    const b = buttons[i];
    if (b.disabled === true) continue;
    if ((b.command ?? 'menuButton') !== 'menuButton') {
      unsupported.add(`button-command:${str(b.command)}`);
      continue;
    }
    if (!str(b.uuid)) {
      unsupported.add(`button-missing-binding:${i}`);
      continue;
    }
    const text = label(b.text),
      lower = text.toLowerCase().trim();
    let action: Action = { kind: 'choose', option: `keyteki-button-${i}` };
    let navigation = false,
      intent: KeytekiCommand['intent'],
      useDescription: LegalAction['useDescription'];
    // Stale card prompt titles must not reinterpret the administrative Yes/No buttons.
    if (!administrativeRequest) {
      if (prophecyContinuation?.stage === 'confirm') {
        action = b.arg === 0 ? structuredClone(prophecyContinuation.action) : { kind: 'done' };
        navigation = b.arg === 0;
        intent = 'prophecy';
      } else if (phase === 'mulligan' && (b.arg === 'keep' || b.arg === 'mulligan')) action = { kind: b.arg };
      else if (phase === 'house' && house(text)) action = { kind: 'house', house: house(text)! };
      else if (phase === 'archives' && /^(yes|all cards)$/i.test(text)) action = { kind: 'takeArchives' };
      else if (phase === 'archives' && /^no$/i.test(text)) action = { kind: 'leaveArchives' };
      else if (phase === 'forge' && colors.includes(lower as KeyColor))
        action = { kind: 'forge', color: lower as KeyColor };
      else if (/raise the tide/i.test(title) && /^yes$/i.test(text)) action = { kind: 'raiseTide' };
      else if (/raise the tide/i.test(title) && /^no$/i.test(text)) action = { kind: 'done' };
      else if (/are you sure you want to end your turn/i.test(title) && /^yes$/i.test(text))
        action = { kind: 'endTurn' };
      else if (/are you sure you want to end your turn/i.test(title) && /^no$/i.test(text))
        action = { kind: 'done' };
      else if (b.arg === 'endturn' || /^end turn$/i.test(text)) action = { kind: 'endTurn' };
      else if (/^(done|cancel|cancel prompt)$/i.test(text)) action = { kind: 'done' };
      else if (source && /^reap with this creature$/i.test(text)) action = { kind: 'reap', card: source };
      else if (
        source &&
        /^(remove stun|remove stun from this creature|remove this creature's stun)$/i.test(text)
      )
        action = { kind: 'unstun', card: source };
      else if (source && /^return this card to hand$/i.test(text))
        action = { kind: 'returnDiscard', card: source };
      else if (source && /^discard (this )?card$/i.test(text)) {
        action = { kind: 'discard', card: source };
        intent = 'discard';
      } else if (source && /^play (this )?(card|creature|artifact|action|upgrade)$/i.test(text)) {
        action = {
          kind: 'play',
          card: source,
          ...(sourceCard && sourceCard.spec.kind !== 'upgrade' && /upgrade$/i.test(text)
            ? { asUpgrade: true as const }
            : {}),
        };
        navigation = true;
        intent = 'play';
      } else if (source && /^fight with this creature$/i.test(text)) {
        navigation = true;
        intent = 'fight';
      } else if (
        source &&
        (/^(action|omni)(\b|:)/i.test(text) || /^use this card's (action|omni) ability$/i.test(text))
      ) {
        const match = describedButtons[i];
        if (match && describedButtons.filter((candidate) => candidate?.index === match.index).length === 1) {
          action = { kind: 'use', card: source, ability: match.index };
          useDescription = match.description;
        } else unknown.add(`ability-description-unresolved:${source}:${i}`);
        intent = 'use';
      } else if (source && /^(left|right)$/i.test(text) && /flank|play|place/i.test(title)) {
        action = { kind: 'play', card: source, flank: lower as 'left' | 'right' };
        intent = 'play';
      } else if (buttonCards.has(i)) action = { kind: 'select', target: buttonCards.get(i)! };
      else if (b.card && cards.has(str(obj(b.card).uuid)))
        action = { kind: 'select', target: str(obj(b.card).uuid) };
    }
    // GameStartPrompt legitimately omits arg. Socket.IO serializes the frontend's undefined as null.
    const args: unknown[] = [b.arg === undefined ? null : structuredClone(b.arg), b.uuid];
    if (b.method !== undefined) args.push(b.method);
    add(
      action,
      {
        message: 'menuButton',
        args,
        navigation,
        ...(intent === 'prophecy' && prophecyContinuation
          ? { sourceCardId: prophecyContinuation.action.card }
          : source
            ? { sourceCardId: source }
            : {}),
        ...(intent ? { intent } : {}),
      },
      text,
      useDescription,
    );
  }
  const promptSelection = me.selectCard === true;
  if (winner === null) {
    if (promptSelection) {
      for (const [id, r] of [...rawById.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
        if (
          r.selectable !== true ||
          r.unselectable === true ||
          r.selected === true ||
          (rankedSelection && ('error' in rankedSelection || !rankedSelection.allowed.has(id))) ||
          (selectionMaximum !== undefined && (pending?.selected?.length ?? 0) >= selectionMaximum)
        )
          continue;
        const action: Action =
          prophecyContinuation?.stage === 'place' && id === prophecyContinuation.action.card
            ? structuredClone(prophecyContinuation.action)
            : fightTarget && source
              ? { kind: 'fight', card: source, target: id }
              : upgradeTarget && source
                ? {
                    kind: 'play',
                    card: source,
                    target: id,
                    ...(sourceCard && sourceCard.spec.kind !== 'upgrade' ? { asUpgrade: true as const } : {}),
                  }
                : { kind: 'select', target: id };
        add(action, {
          message: 'cardClicked',
          args: [id],
          navigation: false,
          ...(action.kind === 'activateProphecy'
            ? { sourceCardId: action.card, intent: 'prophecy' as const }
            : source
              ? { sourceCardId: source }
              : {}),
          ...(fightTarget ? { intent: 'fight' as const } : {}),
        });
      }
    } else if (str(me.phase) === 'main' && /end turn/i.test(buttons.map((b) => label(b.text)).join(' '))) {
      for (const [id, r] of rawById) {
        const c = cards.get(id)!;
        if (c.controller !== you || r.canPlay !== true || r.unselectable === true || r.facedown === true)
          continue;
        const location = locations.get(id);
        // These are card-entry affordances. The next server menu decides actual ability legality.
        const action: Action =
          location === 'hand'
            ? { kind: 'play', card: id }
            : location === 'discard'
              ? { kind: 'returnDiscard', card: id }
              : { kind: 'use', card: id };
        add(action, {
          message: 'cardClicked',
          args: [id],
          navigation: true,
          sourceCardId: id,
          intent: location === 'hand' ? 'play' : 'use',
        });
      }
      if (me.canRaiseTide === true)
        add({ kind: 'raiseTide' }, { message: 'clickTide', args: [], navigation: true });
      if (me.activePlayer === true) {
        const activatable = [...prophecyFaces].filter(([, binding]) => {
          const slot = prophecies.find((p) => p.id === binding.slot)!;
          return (
            binding.owner === you &&
            binding.raw.canActivateProphecy === true &&
            binding.raw.activeProphecy === false &&
            !slot.active &&
            slot.count === 0
          );
        });
        if (activatable.length) {
          const rawHandValue = obj(me.cardPiles).hand,
            rawHand = arr(rawHandValue).map(obj),
            projectedHand = players[you].hand ?? [],
            handIds = rawHand.map((r) => str(r.uuid));
          // Every own hand card is a possible latent choice. A hidden, missing or
          // duplicate entity must not silently shrink that legal action domain.
          const completeHand =
            Array.isArray(rawHandValue) &&
            rawHand.length > 0 &&
            rawHand.length === projectedHand.length &&
            new Set(handIds).size === rawHand.length &&
            rawHand.every(
              (r) =>
                str(r.uuid) &&
                r.facedown === false &&
                (str(r.id) || str(r.name)) &&
                locations.get(str(r.uuid)) === 'hand' &&
                projectedHand.some((c) => c.id === r.uuid),
            );
          if (!completeHand) unsupported.add('prophecy-own-hand-identity-incomplete');
          else
            for (const [uuid, binding] of activatable)
              for (const handCard of projectedHand)
                add(
                  {
                    kind: 'activateProphecy',
                    slot: binding.slot,
                    face: binding.face,
                    card: handCard.id,
                  },
                  {
                    message: 'clickProphecy',
                    args: [uuid],
                    navigation: true,
                    sourceCardId: handCard.id,
                    intent: 'prophecy',
                  },
                );
        }
      }
    }
  }
  // Free-form lookup/assignment controls need their own exact schema; selecting a random button is unsafe.
  for (const value of arr(me.controls)) {
    const control = obj(value),
      type = str(control.type);
    if (type === 'card-name' || type === 'trait-name') {
      const method = type === 'card-name' ? 'selectCardName' : 'selectTraitName';
      // Pinned name/trait targets expose a free picker backed by
      // the client's static catalogue, including when an ability was copied.
      // Recognize its exact UI schema, never the source's live effect prose.
      if (
        arr(me.controls).length !== 1 ||
        Object.keys(control).some((key) => !['type', 'command', 'method', 'uuid'].includes(key)) ||
        buttons.length !== 0 ||
        me.selectCard === true ||
        control.command !== 'menuButton' ||
        control.method !== method ||
        !/^.+:0$/.test(str(control.uuid))
      ) {
        unsupported.add(`unbound-${type}-control`);
        continue;
      }
      const domain =
        type === 'card-name'
          ? Object.values(CATALOG).map((card) => card.name)
          : Object.values(CATALOG).flatMap((card) => card.traits ?? []);
      for (const name of [...new Set(domain)].sort())
        add(
          { kind: 'choose', option: name },
          {
            message: 'menuButton',
            args: [name, control.uuid, method],
            navigation: false,
            ...(source ? { sourceCardId: source } : {}),
          },
          name,
        );
      unknown.add(`${type}-domain-local-static-catalog: external names outside this catalog are not offered`);
      continue;
    }
    if (type && !['targeting', 'house-select', 'options-select'].includes(type))
      unsupported.add(`prompt-control:${type}`);
  }
  if (swapPrompt && pending) {
    const candidates = [...rawById.entries()].filter(([, r]) => r.selectable === true || r.selected === true);
    const sides = new Set(candidates.map(([id]) => cards.get(id)?.controller));
    if (
      candidates.some(([id, r]) => locations.get(id) !== 'cardsInPlay' || r.type !== 'creature') ||
      sides.size > 1
    )
      unsupported.add('swap-pair-public-candidates-inconsistent');
    else if (candidates.length && sides.size === 1) {
      const player = [...sides][0];
      if (player === 0 || player === 1) {
        const done = legalActions.find((a) => a.action.kind === 'done' && commands[a.id].args[0] === 'done');
        pending.intent = {
          kind: 'battleline-reorder',
          player,
          mode: 'swap-pair',
          ...((pending.selected?.length ?? 0) < 2 && done ? { keepOrderActionId: done.id } : {}),
        };
      }
    }
  }
  const turnPlayer = playerRaw.findIndex((p) => p.activePlayer === true);
  const decisionActor = legalActions.length ? you : turnPlayer >= 0 ? (turnPlayer as Seat) : you;
  const tokenReferences = playerRaw.some((p) => p.tokenCard != null)
    ? (playerRaw.map((p, seat) => {
        if (p.tokenCard == null) return null;
        const reference = resolveDefinition(obj(p.tokenCard));
        if (!reference?.tokenReference) {
          unsupported.add(`unmapped-token-reference:${seat}`);
          return null;
        }
        if (!Object.hasOwn(CATALOG, reference.id))
          unknown.add(`external-token-definition:${reference.id}: public-wire-only`);
        return structuredClone(reference);
      }) as [CardDefinition | null, CardDefinition | null])
    : undefined;
  if (!options.firstPlayerName) unknown.add('first-player-unreported: compatibility seat 0');
  const observation: Observation = {
    schemaVersion: 2,
    publicStateCoverage: {
      turnHistoryComplete: false,
      effectsComplete: false,
      ...(options.turnHistory ? { turnOrdinalKnown: options.turnHistory.fromGameStart } : {}),
    },
    engineVersion: KEYTEKI_ADAPTER_VERSION,
    rulesVersion: 'keyteki-unreported',
    catalogVersion: 'local-static-card-bridge',
    revision: options.revision,
    turn: options.turn,
    you,
    firstPlayer: names.includes(options.firstPlayerName ?? '')
      ? (names.indexOf(options.firstPlayerName!) as Seat)
      : 0,
    turnUsage: {},
    handOperations: 0,
    playedThisTurn: 0,
    creaturesPlayedThisTurn: 0,
    activePlayer: decisionActor,
    phase,
    activeHouse: house(playerRaw[turnPlayer >= 0 ? turnPlayer : you].activeHouse) ?? null,
    players,
    ...(tokenReferences ? { tokenReferences } : {}),
    ...(prophecies.length ? { prophecies } : {}),
    legalActions: winner === null ? legalActions : [],
    resolving: [...cards.values()].filter((c) => locations.get(c.id) === 'resolving'),
    promptCards: [...cards.values()]
      .filter((c) => locations.get(c.id) === 'prompt')
      .sort((a, b) => a.id.localeCompare(b.id, 'en')),
    underCards,
    spanglerCards: [],
    controlLayers: [],
    nextReady: [],
    leaveEffects: [],
    publicCounters: {
      playedByHouse: {},
      discardedHouses: [[], []],
      creaturesPlayedLastTurn: [0, 0],
      enemyFightDeaths: 0,
      creaturesUsed: [],
    },
    pending,
    lasting: [],
    knowledge: [],
    permissions: [],
    cardEffects: [],
    houseRestrictions: [],
    futureHouseRestrictions: [],
    winner,
  };
  const tideStatus = str(obj(me.stats).tide);
  if (['high', 'low', 'neutral'].includes(tideStatus)) {
    observation.tide = {
      status: tideStatus as 'high' | 'low' | 'neutral',
      highFor: tideStatus === 'high' ? you : tideStatus === 'low' ? (you === 0 ? 1 : 0) : null,
      canRaise: me.canRaiseTide === true,
      rulesAbilityChains: 3,
    };
    unknown.add('tide-cost-modifiers-unreported: base rules ability costs 3 chains');
  }
  if (navigationActionIds.length)
    unknown.add(
      'navigation-granularity: card entry and unresolved fight menu differ from local atomic actions',
    );
  const result: KeytekiProjection = {
    protocol: KEYTEKI_ADAPTER_VERSION,
    gameId: str(raw.id),
    playerName: options.playerName,
    fingerprint: '',
    observation,
    commands,
    navigationActionIds,
    ...(administrativeRequest ? { administrativeRequest } : {}),
    unknown: [...unknown].sort(),
    unsupported: [...unsupported].sort(),
  };
  // No raw server object, user profile, chat text, hidden-card face, or token is hashed or forwarded.
  result.fingerprint = createHash('sha256')
    .update(
      canonical({
        gameId: result.gameId,
        playerName: result.playerName,
        observation,
        commands,
        ...(administrativeRequest ? { administrativeRequest } : {}),
        unsupported: result.unsupported,
      }),
    )
    .digest('hex');
  return result;
}

/** Compile exactly one action against a fresh observation; wait for the next game state before continuing. */
export function compileKeytekiCommand(
  projected: KeytekiProjection,
  actionId: string,
  current: { revision: number; fingerprint: string },
): KeytekiCommand {
  if (current.revision !== projected.observation.revision || current.fingerprint !== projected.fingerprint)
    throw Error('Stale Keyteki decision');
  if (projected.observation.winner !== null) throw Error('Keyteki game already finished');
  if (
    !projected.observation.legalActions.some((a) => a.id === actionId) ||
    !Object.hasOwn(projected.commands, actionId)
  )
    throw Error('Illegal Keyteki action');
  const request = projected.administrativeRequest;
  if (request) {
    // A valid refusal remains possible with an unknown card or manual mode already on.
    // This exception authorizes only the exact current No, never ordinary gameplay or Yes.
    const command = projected.commands[actionId];
    if (
      !['manual-mode-consent', 'manual-key-forge-consent'].includes(request.kind) ||
      (request.kind === 'manual-key-forge-consent' && !colors.includes(request.keyColor)) ||
      request.requester !== (projected.observation.you === 0 ? 1 : 0) ||
      !str(request.promptUuid).trim() ||
      !projected.gameId ||
      projected.unsupported.some((reason) =>
        ['missing-game-id', 'game-not-started', 'administrative-request-schema-unsupported'].includes(reason),
      ) ||
      actionId !== request.rejectActionId ||
      command.message !== 'menuButton' ||
      command.args.length !== 2 ||
      command.args[0] !== 'no' ||
      command.args[1] !== request.promptUuid ||
      command.navigation !== false ||
      command.sourceCardId !== undefined ||
      command.intent !== undefined
    )
      throw Error('Administrative requests only permit their bound refusal');
    return structuredClone(command);
  }
  if (projected.unsupported.length)
    throw Error('Unsupported Keyteki state: ' + projected.unsupported.join('; '));
  return structuredClone(projected.commands[actionId]);
}
