/** Exact native Infurnace prompt semantics. Never adds, removes or rewrites a wire command. */
import type { CardView, DecisionIntent, PlayerView, Seat } from '../contracts/observation.js';
type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(row) : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export interface KeytekiInfurnaceContract {
  source: string;
  intent: Extract<DecisionIntent, { kind: 'infurnace-pile' | 'infurnace-targets' }>;
}
export interface KeytekiInfurnaceResult {
  contract?: KeytekiInfurnaceContract;
  /** A legal but unrecognized semantic contract is an unknown, not a wire error. */
  unknown?: string;
}
export function keytekiInfurnaceContract(input: {
  me: Row;
  you: Seat;
  players: readonly PlayerView[];
  rawById: ReadonlyMap<string, Row>;
}): KeytekiInfurnaceResult | undefined {
  const { me, you, players, rawById } = input;
  const controls = rows(me.controls),
    publicSource = row(controls[0]?.source),
    menu = row(me.menuTitle);
  const pilePrompt = me.menuTitle === 'Choose which discard pile to purge from';
  const targetPrompt = menu.text === 'Choose {{amount}} cards' && row(menu.values).amount === 2;
  // Play/placement prompts still belong to the existing navigation code. This
  // contract begins only once the native creature's own Play effect is resolving.
  if (!pilePrompt && !targetPrompt) {
    if (me.promptTitle === 'Infurnace' && me.selectCard === true)
      return { unknown: 'infurnace-native-contract: unrecognized target prompt' };
    return;
  }
  if (me.promptTitle !== 'Infurnace' && publicSource.id !== 'infurnace') return;
  const fail = (reason: string): KeytekiInfurnaceResult => ({
    unknown: 'infurnace-native-contract: ' + reason,
  });
  if (
    me.promptTitle !== 'Infurnace' ||
    me.activePlayer !== true ||
    me.phase !== 'main' ||
    me.selectOrder !== false ||
    controls.length !== 1 ||
    controls[0].type !== 'targeting' ||
    publicSource.id !== 'infurnace' ||
    publicSource.type !== 'creature' ||
    publicSource.facedown !== false ||
    publicSource.copying === true ||
    !Array.isArray(me.promptedPiles)
  )
    return fail('source, actor or effect schema is unverified');
  const physical = (card: CardView): boolean => {
    const raw = rawById.get(card.id);
    return (
      card.controller === you &&
      card.definition === 'infurnace' &&
      card.spec.id === 'infurnace' &&
      !card.copiedDefinition &&
      !card.copiedCharacteristics &&
      !card.gainedTextBoxes?.length &&
      raw?.uuid === card.id &&
      raw.id === 'infurnace' &&
      raw.type === 'creature' &&
      raw.facedown === false &&
      raw.copying !== true
    );
  };
  // Infurnace is a creature already in play when its native pile/target window
  // appears, including Wild Wormhole's nested Play. Hand/discard namesakes and
  // the outer Wormhole action are never candidates for this leaf source.
  const candidates = players[you].battleline.filter(
    (card) =>
      card.definition === 'infurnace' ||
      card.spec.id === 'infurnace' ||
      rawById.get(card.id)?.id === 'infurnace',
  );
  const explicit = text(publicSource.uuid);
  if (publicSource.uuid !== undefined && !explicit) return fail('invalid physical source UUID');
  // A generic navigation source can be an older same-name creature during a
  // nested Play's flank window. Only an explicit native entity UUID can break
  // an in-play tie; ordinary commandSourceId is deliberately not used here.
  const source = explicit
    ? candidates.find((card) => card.id === explicit)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!source || !physical(source)) return fail('physical in-play source is missing or ambiguous');
  const buttons = rows(me.buttons),
    uuid = text(buttons[0]?.uuid);
  if (
    !buttons.length ||
    !uuid ||
    controls[0].uuid !== uuid + ':0' ||
    buttons.some(
      (b) =>
        b.command !== 'menuButton' ||
        b.method !== undefined ||
        b.disabled === true ||
        b.hidden === true ||
        b.visible === false ||
        b.uuid !== uuid,
    )
  )
    return fail('button/control binding is unverified');
  const selected = [...rawById].filter(([, card]) => card.selected === true);
  if (pilePrompt) {
    if (me.selectCard !== false || rows(me.promptedPiles).length || selected.length || buttons.length > 2)
      return fail('discard-pile selector shape is unverified');
    const options: { id: string; owner: Seat }[] = [];
    const owners = new Set<Seat>(),
      bindings = new Set<number>();
    for (const [index, button] of buttons.entries()) {
      const owner =
        button.text === 'Mine' ? you : button.text === "Opponent's" ? (you === 0 ? 1 : 0) : undefined;
      if (
        owner === undefined ||
        owners.has(owner) ||
        !Number.isSafeInteger(button.arg) ||
        (button.arg as number) < 0 ||
        bindings.has(button.arg as number) ||
        !players[owner].discard.length
      )
        return fail('discard-pile labels or native bindings are unverified');
      owners.add(owner);
      bindings.add(button.arg as number);
      // The ID preserves the existing adapter ID. Side comes from the exact
      // native label and public actor, never from this index or the wire arg.
      options.push({ id: `keyteki-button-${index}`, owner });
    }
    if (players.some((player, seat) => player.discard.length > 0 && !owners.has(seat as Seat)))
      return fail('discard-pile menu omits a nonempty public pile');
    return { contract: { source: source.id, intent: { kind: 'infurnace-pile', options } } };
  }
  const piles = rows(me.promptedPiles),
    pile = piles[0];
  const owner =
    pile?.controller === 'self' ? you : pile?.controller === 'opponent' ? (you === 0 ? 1 : 0) : undefined;
  if (
    me.selectCard !== true ||
    buttons.length !== 1 ||
    buttons[0].text !== 'Done' ||
    buttons[0].arg !== 'done' ||
    piles.length !== 1 ||
    pile.location !== 'discard' ||
    owner === undefined
  )
    return fail('up-to-two target/Done contract is unverified');
  const ids = new Set(players[owner].discard.map((card) => card.id));
  const offered = [...rawById].filter(([, card]) => card.selectable === true && card.unselectable !== true);
  const selectedIds = new Set(selected.map(([id]) => id));
  if (
    selected.length > 2 ||
    (selected.length === 2 && offered.some(([id]) => !selectedIds.has(id))) ||
    [...selected, ...offered].some(
      ([id, card]) => !ids.has(id) || card.facedown !== false || card.uuid !== id,
    )
  )
    return fail('selected or selectable cards do not belong to the one public discard pile');
  return { contract: { source: source.id, intent: { kind: 'infurnace-targets', owner } } };
}
