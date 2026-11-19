/** Public, unordered physical deck information for the optional mulligan estimator. */
import type {
  BonusIcon,
  CardView,
  House,
  Observation,
  Seat,
} from "../contracts/observation.js";
import {
  ALL_DEFINITIONS,
  cardKnowledgeIsPartial,
} from "../knowledge/catalog.js";

export interface PublicOpeningCard {
  definition: string;
  house: House;
  /** The complete printed and enhanced icon sequence, not only added enhancements. */
  bonusIcons: readonly BonusIcon[];
  bonusHouses: readonly House[];
}
export interface PublicOpeningDeck {
  schema: "kf-public-opening-deck-v1";
  cards: readonly PublicOpeningCard[];
}
export interface PublicOpeningDeckList {
  /** Explicitly confirms that omitted physical overrides mean ordinary printed defaults. */
  physicalDetailsComplete: true;
  cards: readonly string[];
  bonusIcons?: Readonly<Record<string, readonly BonusIcon[]>>;
  bonusHouses?: Readonly<Record<string, readonly House[]>>;
  houseOverrides?: Readonly<Record<string, House>>;
  skybeastHouses?: Readonly<Record<string, House>>;
}
const iconNames = new Set([
  "amber",
  "capture",
  "damage",
  "draw",
  "discard",
  "power",
]);
const signature = (c: PublicOpeningCard) =>
  JSON.stringify([
    c.definition,
    c.house,
    c.bonusIcons,
    [...c.bonusHouses].sort(),
  ]);

/** Accept a complete public deck list, never an ordered hidden deck or GameState.
 * Sorting erases the source slot order; duplicate physical variants remain distinct.
 */
export function openingDeckFromPublicList(
  input: PublicOpeningDeckList,
): PublicOpeningDeck {
  if (
    input.physicalDetailsComplete !== true ||
    !Array.isArray(input.cards) ||
    input.cards.length !== 36
  )
    throw Error(
      "Opening estimation requires a complete public 36-card physical list",
    );
  for (const overrides of [
    input.bonusIcons,
    input.bonusHouses,
    input.houseOverrides,
    input.skybeastHouses,
  ]) {
    if (
      overrides &&
      Object.keys(overrides).some(
        (key) => !/^(?:[0-9]|[12][0-9]|3[0-5])$/.test(key),
      )
    )
      throw Error("Invalid public physical card index");
  }
  const cards = input.cards
    .map((definition, index) => {
      const d = ALL_DEFINITIONS[definition],
        key = String(index);
      if (!d) throw Error("Unknown public opening definition: " + definition);
      const house =
        input.skybeastHouses?.[key] ?? input.houseOverrides?.[key] ?? d.house;
      const bonusIcons = [
        ...(input.bonusIcons?.[key] ?? Array<BonusIcon>(d.amber).fill("amber")),
      ];
      const bonusHouses = [...(input.bonusHouses?.[key] ?? [])].sort();
      if (
        typeof house !== "string" ||
        !house.length ||
        bonusIcons.some((icon) => !iconNames.has(icon)) ||
        bonusHouses.some((h) => typeof h !== "string" || !h.length) ||
        new Set(bonusHouses).size !== bonusHouses.length
      )
        throw Error("Invalid public opening physical detail");
      return Object.freeze({
        definition,
        house,
        bonusIcons: Object.freeze(bonusIcons),
        bonusHouses: Object.freeze(bonusHouses),
      });
    })
    .sort((a, b) => signature(a).localeCompare(signature(b), "en"));
  return Object.freeze({
    schema: "kf-public-opening-deck-v1",
    cards: Object.freeze(cards),
  });
}

function publicCard(
  row: PublicOpeningCard,
  index: number,
  owner: Seat,
): CardView {
  const spec = ALL_DEFINITIONS[row.definition];
  return {
    id: "opening-public-" + index,
    definition: row.definition,
    owner,
    controller: owner,
    ready: false,
    damage: 0,
    armorUsed: 0,
    elusiveUsed: false,
    captured: 0,
    stunned: false,
    powerCounters: 0,
    attachedTo: null,
    enteredController: owner,
    foreignArchiveHolder: null,
    printedHouse: row.house,
    bonusIcons: [...row.bonusIcons],
    bonusHouses: [...row.bonusHouses],
    spec,
    usesThisTurn: 0,
    effective: {
      house: row.house,
      houses: [...new Set([row.house, ...row.bonusHouses])],
      power: spec.power,
      armor: spec.armor,
      keywords: spec.keywords ?? [],
      assault: spec.assault ?? 0,
      hazardous: spec.hazardous ?? 0,
    },
  };
}

/** Bind the provided public multiset to the observed roster and every physical starting card. */
export function bindOpeningDeck(
  o: Observation,
  input?: PublicOpeningDeck,
): { cards: CardView[]; hand: CardView[] } | undefined {
  if (
    input?.schema !== "kf-public-opening-deck-v1" ||
    !Array.isArray(input.cards) ||
    input.cards.length !== 36
  )
    return;
  const me = o.players[o.you],
    hand = me.hand;
  if (!hand || hand.length !== me.handCount || !Array.isArray(me.deckList))
    return;
  const expected = new Map<string, number>();
  for (const item of me.deckList) {
    if (
      !Number.isSafeInteger(item.count) ||
      item.count < 1 ||
      !ALL_DEFINITIONS[item.definition]
    )
      return;
    const key = JSON.stringify([item.definition, item.house]);
    expected.set(key, (expected.get(key) ?? 0) + item.count);
  }
  if ([...expected.values()].reduce((n, count) => n + count, 0) !== 36) return;
  const observed = new Map<string, number>();
  const rows: PublicOpeningCard[] = [];
  for (const row of input.cards) {
    if (
      !row ||
      !ALL_DEFINITIONS[row.definition] ||
      typeof row.house !== "string" ||
      !Array.isArray(row.bonusIcons) ||
      !Array.isArray(row.bonusHouses) ||
      row.bonusIcons.some((icon: string) => !iconNames.has(icon)) ||
      row.bonusHouses.some((h: string) => typeof h !== "string" || !h.length) ||
      new Set(row.bonusHouses).size !== row.bonusHouses.length ||
      cardKnowledgeIsPartial(ALL_DEFINITIONS[row.definition])
    )
      return;
    const key = JSON.stringify([row.definition, row.house]);
    observed.set(key, (observed.get(key) ?? 0) + 1);
    rows.push(row);
  }
  if (
    observed.size !== expected.size ||
    [...expected].some(([key, n]) => observed.get(key) !== n)
  )
    return;
  rows.sort((a, b) => signature(a).localeCompare(signature(b), "en"));
  const cards = rows.map((row, index) => publicCard(row, index, o.you));
  const available = rows.map((row, index) => ({
    signature: signature(row),
    index,
  }));
  const bound: CardView[] = [];
  for (const card of hand) {
    const actual: PublicOpeningCard = {
      definition: card.definition,
      house: card.effective.house,
      bonusIcons:
        card.resolvedBonusIcons ??
        card.bonusIcons ??
        Array<BonusIcon>(card.spec.amber).fill("amber"),
      bonusHouses: card.bonusHouses ?? [],
    };
    const index = available.findIndex(
      (row) => row.signature === signature(actual),
    );
    if (index < 0) return;
    bound.push(cards[available[index].index]);
    available.splice(index, 1);
  }
  return { cards, hand: bound };
}
