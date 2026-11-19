import assert from "node:assert/strict";
import test from "node:test";
import { ALL_DEFINITIONS } from "../../dist/src/knowledge/catalog.js";
import {
  assessOpeningPolicy,
  OPENING_POLICY_IDS,
} from "../../dist/src/ai/opening-policy.js";
import {
  openingDeckFromPublicList,
  bindOpeningDeck,
} from "../../dist/src/ai/opening-deck.js";
import { rankTocV2 } from "../../dist/src/ai/tactical-strength-policy.js";
import {
  createCodePolicy,
  CODE_POLICY_IDS,
} from "../../dist/src/ai/code-strategies.js";

const HOUSE = "tactical-toc-opening-house-v1";
const MULLIGAN = "tactical-toc-opening-mulligan-v1";
const BOTH = "tactical-toc-opening-v1";
function card(definition, index, owner = 0) {
  const spec = ALL_DEFINITIONS[definition];
  assert.ok(spec, definition);
  return {
    id: "visible-" + index,
    definition,
    owner,
    controller: owner,
    spec,
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
    usesThisTurn: 0,
    effective: {
      house: spec.house,
      power: spec.power,
      armor: spec.armor,
      keywords: spec.keywords ?? [],
      assault: spec.assault ?? 0,
      hazardous: spec.hazardous ?? 0,
    },
  };
}
function view(
  definitions,
  { you = 0, first = you, phase = "house", deck } = {},
) {
  const hand = definitions.map((d, i) => card(d, i, you));
  const options = [
    ...new Set(
      (deck?.cards ?? definitions).map((d) => ALL_DEFINITIONS[d].house),
    ),
  ];
  const roster = new Map();
  for (const definition of deck?.cards ?? [])
    roster.set(definition, (roster.get(definition) ?? 0) + 1);
  const player = () => ({
    houses: options,
    amber: 0,
    forgeAvailable: 0,
    keys: [],
    keyCost: 6,
    chains: 0,
    skipForgeTurn: null,
    lastForgedTurn: null,
    forgedOn: {},
    handCount: 6,
    deckCount: 30,
    archiveCount: 0,
    archives: [],
    battleline: [],
    artifacts: [],
    upgrades: [],
    discard: [],
    purged: [],
    deckList: [...roster].map(([definition, count]) => ({
      definition,
      count,
      name: ALL_DEFINITIONS[definition].name,
      house: ALL_DEFINITIONS[definition].house,
    })),
  });
  const players = [player(), player()];
  players[you] = {
    ...players[you],
    hand,
    handCount: hand.length,
    deckCount: 36 - hand.length,
  };
  const legalActions =
    phase === "house"
      ? options.map((house) => ({
          id: house,
          action: { kind: "house", house },
        }))
      : [
          { id: "keep", action: { kind: "keep" } },
          { id: "mulligan", action: { kind: "mulligan" } },
        ];
  return {
    schemaVersion: 2,
    engineVersion: "test",
    rulesVersion: "18.4",
    catalogVersion: "test",
    revision: 0,
    turn: 1,
    you,
    activePlayer: you,
    firstPlayer: first,
    phase,
    activeHouse: null,
    turnUsage: {},
    handOperations: 0,
    playedThisTurn: 0,
    creaturesPlayedThisTurn: 0,
    turnStep: { step: 2, performed: [0, 0], omega: false },
    players,
    legalActions,
    resolving: [],
    promptCards: [],
    underCards: [],
    spanglerCards: [],
    controlLayers: [],
    nextReady: [],
    leaveEffects: [],
    pending: null,
    lasting: [],
    knowledge: [],
    permissions: [],
    cardEffects: [],
    houseRestrictions: [],
    futureHouseRestrictions: [],
    winner: null,
    publicCounters: {
      playedByHouse: {},
      discardedHouses: [[], []],
      creaturesPlayedLastTurn: [0, 0],
      enemyFightDeaths: 0,
      creaturesUsed: [],
    },
  };
}
const deck = {
  physicalDetailsComplete: true,
  cards: [
    ...Array(12).fill("ammonia-clouds"),
    ...Array(12).fill("dust-pixie"),
    ...Array(12).fill("troll"),
  ],
};
const context = { deck: openingDeckFromPublicList(deck) };
const chosen = (o, report) =>
  o.legalActions.find((a) => a.id === report.ranked[0].actionId).action;

test("empty-board seed-18 hand no longer rewards three unusable Mars cards as three opening plays", () => {
  for (const you of [0, 1]) {
    const o = view(
      [
        "ammonia-clouds",
        "ironyx-propaganda",
        "destroy-them-all",
        "beware-the-ides",
        "hedonistic-intent",
        "scrapscrounger",
        "æmbitrage",
      ],
      { you },
    );
    assert.equal(chosen(o, { ranked: rankTocV2(o) }).house, "mars");
    const snapshot = structuredClone(o),
      report = assessOpeningPolicy(o, HOUSE);
    assert.equal(report.status, "house");
    assert.notEqual(chosen(o, report).house, "mars");
    assert.equal(report.ranked.find((r) => r.actionId === "mars").score, 0.3);
    assert.deepEqual(o, snapshot);
  }
});

test("Phase Shift can contribute a real extra public card instead of being capped as an ordinary second play", () => {
  const o = view([
    "phase-shift",
    "dust-pixie",
    "troll",
    "troll",
    "troll",
    "troll",
    "troll",
  ]);
  const report = assessOpeningPolicy(o, HOUSE);
  const logos = report.ranked.find((row) => row.actionId === "logos").score;
  const only = view(["phase-shift"]);
  assert.ok(logos > assessOpeningPolicy(only, HOUSE).ranked[0].score);
  assert.equal(chosen(o, report).house, "logos");
});

test("upgrades without an attachment target do not create a fictional first play", () => {
  const o = view([...Array(6).fill("rocket-boots"), "troll"]);
  const report = assessOpeningPolicy(o, HOUSE);
  assert.equal(report.status, "house");
  assert.equal(chosen(o, report).house, "brobnar");
  assert.equal(report.ranked.find((row) => row.actionId === "logos").score, 0);
});

test("opening house candidate preserves later turns, non-opening seats and unknown history", () => {
  const base = view(["troll", "dust-pixie"]);
  for (const patch of [
    { turn: 2 },
    { firstPlayer: 1 },
    {
      publicStateCoverage: {
        effectsComplete: true,
        turnHistoryComplete: false,
      },
    },
  ]) {
    const o = { ...base, ...patch };
    assert.deepEqual(assessOpeningPolicy(o, HOUSE).ranked, rankTocV2(o));
  }
  const o = {
    ...base,
    phase: "main",
    activeHouse: "brobnar",
    legalActions: [
      {
        id: "play",
        action: {
          kind: "play",
          card: base.players[0].hand[0].id,
          flank: "left",
        },
      },
      { id: "end", action: { kind: "endTurn" } },
    ],
  };
  assert.deepEqual(assessOpeningPolicy(o, BOTH).ranked, rankTocV2(o));
});

test("the three opt-in policies isolate house and mulligan changes and preserve old registered IDs", () => {
  assert.equal(CODE_POLICY_IDS.length, 92);
  for (const id of OPENING_POLICY_IDS) assert.ok(CODE_POLICY_IDS.includes(id));
  const o = view([
    "ammonia-clouds",
    "ironyx-propaganda",
    "destroy-them-all",
    "beware-the-ides",
    "hedonistic-intent",
    "scrapscrounger",
    "æmbitrage",
  ]);
  assert.deepEqual(assessOpeningPolicy(o, MULLIGAN).ranked, rankTocV2(o));
  assert.equal(createCodePolicy("tactical-toc-v2")(o), "mars");
  assert.notEqual(createCodePolicy(HOUSE)(o), "mars");
});

test("mulligan requires full public physical information rather than treating absent enhancement data as zero", () => {
  const o = view(Array(7).fill("ammonia-clouds"), { phase: "mulligan", deck });
  assert.equal(assessOpeningPolicy(o, MULLIGAN).status, "missing-public-deck");
  assert.equal(chosen(o, assessOpeningPolicy(o, MULLIGAN)).kind, "keep");
  assert.throws(
    () =>
      openingDeckFromPublicList({ ...deck, physicalDetailsComplete: false }),
    /complete public/,
  );
  const incomplete = {
    deck: { ...context.deck, cards: context.deck.cards.slice(0, 35) },
  };
  assert.equal(
    chosen(o, assessOpeningPolicy(o, MULLIGAN, incomplete)).kind,
    "keep",
  );
  o.players[0].hand[0].bonusIcons = ["amber"];
  assert.equal(bindOpeningDeck(o, context.deck), undefined);
  assert.equal(
    chosen(o, assessOpeningPolicy(o, MULLIGAN, context)).kind,
    "keep",
  );
});

test("complete public physical enhancements bind exactly and lose their original slot order", () => {
  const enhanced = {
    ...deck,
    bonusIcons: { 0: ["amber", "draw"] },
    bonusHouses: { 0: ["logos"] },
  };
  const publicDeck = openingDeckFromPublicList(enhanced);
  const o = view(Array(7).fill("ammonia-clouds"), { phase: "mulligan", deck });
  const physical = o.players[0].hand[0];
  physical.bonusIcons = ["amber", "draw"];
  physical.bonusHouses = ["logos"];
  physical.effective.houses = ["mars", "logos"];
  const bound = bindOpeningDeck(o, publicDeck);
  assert.ok(bound);
  assert.deepEqual(bound.hand[0].bonusIcons, physical.bonusIcons);
  assert.deepEqual(bound.hand[0].effective.houses, physical.effective.houses);
  const reordered = openingDeckFromPublicList({
    ...deck,
    cards: [...deck.cards].reverse(),
    bonusIcons: { 35: ["amber", "draw"] },
    bonusHouses: { 35: ["logos"] },
  });
  assert.deepEqual(reordered, publicDeck);
  physical.bonusIcons.reverse();
  assert.equal(bindOpeningDeck(o, publicDeck), undefined);
});

test("bad starting hands can mulligan while good hands keep, for both first-player seats", () => {
  for (const you of [0, 1])
    for (const first of [0, 1]) {
      const n = you === first ? 7 : 6;
      const poor = view(Array(n).fill("ammonia-clouds"), {
        you,
        first,
        phase: "mulligan",
        deck,
      });
      const good = view(Array(n).fill("dust-pixie"), {
        you,
        first,
        phase: "mulligan",
        deck,
      });
      const before = structuredClone(poor),
        badReport = assessOpeningPolicy(poor, MULLIGAN, context);
      assert.equal(badReport.status, "mulligan");
      assert.equal(chosen(poor, badReport).kind, "mulligan");
      assert.equal(
        chosen(good, assessOpeningPolicy(good, MULLIGAN, context)).kind,
        "keep",
      );
      assert.equal(badReport.mulligan.keepCards, n);
      assert.equal(badReport.mulligan.redrawCards, n - 1);
      assert.equal(badReport.mulligan.firstPlayer, you === first);
      assert.equal(badReport.mulligan.samples, 32);
      assert.equal(badReport.mulligan.cardEstimates, 108);
      assert.deepEqual(poor, before);
      assert.equal(
        chosen(poor, assessOpeningPolicy(poor, HOUSE, context)).kind,
        "keep",
      );
    }
});

test("identical-card redraws account for the lost card and never pay to obtain the same hand", () => {
  const identical = {
    physicalDetailsComplete: true,
    cards: Array(36).fill("troll"),
  };
  const ctx = { deck: openingDeckFromPublicList(identical) };
  for (const first of [0, 1]) {
    const n = first === 0 ? 7 : 6;
    const o = view(Array(n).fill("troll"), {
      first,
      phase: "mulligan",
      deck: identical,
    });
    const report = assessOpeningPolicy(o, MULLIGAN, ctx);
    assert.equal(chosen(o, report).kind, "keep");
    assert.ok(report.mulligan.redrawMean < report.mulligan.keepValue);
    assert.ok(report.mulligan.samplingStandardError < 1e-10);
  }
});

test("public deck and hand permutations cannot supply a hidden order or change the mulligan score", () => {
  const o = view(
    [
      "ammonia-clouds",
      "ammonia-clouds",
      "ammonia-clouds",
      "troll",
      "troll",
      "dust-pixie",
      "dust-pixie",
    ],
    { phase: "mulligan", deck },
  );
  const expected = assessOpeningPolicy(o, MULLIGAN, context);
  assert.equal(expected.status, "mulligan");
  const shuffled = {
    ...context.deck,
    cards: [...context.deck.cards].reverse(),
  };
  o.players[0].hand.reverse();
  assert.deepEqual(
    assessOpeningPolicy(o, MULLIGAN, { deck: shuffled }),
    expected,
  );
});

test("wrong deck, unknown knowledge, nonstandard setup and missing ordinal retain the safe baseline", () => {
  const o = view(Array(7).fill("ammonia-clouds"), { phase: "mulligan", deck });
  const variants = [
    {
      ...o,
      publicStateCoverage: {
        effectsComplete: true,
        turnHistoryComplete: true,
        turnOrdinalKnown: false,
      },
    },
    { ...o, handOperations: 1 },
    { ...o, players: [{ ...o.players[0], chains: 1 }, o.players[1]] },
    { ...o, players: [{ ...o.players[0], handCount: 6 }, o.players[1]] },
  ];
  for (const item of variants)
    assert.equal(
      chosen(item, assessOpeningPolicy(item, BOTH, context)).kind,
      "keep",
    );
  const bad = {
    deck: {
      ...context.deck,
      cards: context.deck.cards.map((row, i) =>
        i ? row : { ...row, definition: "unknown" },
      ),
    },
  };
  assert.equal(chosen(o, assessOpeningPolicy(o, MULLIGAN, bad)).kind, "keep");
});

test("unresolved strategic values keep even when the public physical deck is fully known", () => {
  const unresolved = {
    ...deck,
    cards: deck.cards.map((id) =>
      id === "ammonia-clouds" ? "destroy-them-all" : id,
    ),
  };
  const ctx = { deck: openingDeckFromPublicList(unresolved) };
  const o = view(Array(7).fill("destroy-them-all"), {
    phase: "mulligan",
    deck: unresolved,
  });
  assert.ok(bindOpeningDeck(o, ctx.deck));
  for (const id of [MULLIGAN, BOTH]) {
    const report = assessOpeningPolicy(o, id, ctx);
    assert.equal(report.status, "unsupported-opening");
    assert.equal(report.mulligan, undefined);
    assert.equal(chosen(o, report).kind, "keep");
  }
});
