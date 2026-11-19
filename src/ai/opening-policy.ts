/** Experimental opening-only corrections; historical ToC V2 remains an exact control. */
import type {
  CardView,
  House,
  LegalAction,
  Observation,
} from "../contracts/observation.js";
import {
  assessAlgorithmWithUncertainty,
  type ActionAssessment,
} from "./algorithm-policies.js";
import { rankTocV2 } from "./tactical-strength-policy.js";
import {
  assessPublicHandWindow,
  publicHandCardPlayable,
} from "./public-hand-window.js";
import { assessPublicCardUse } from "./public-card-opportunity.js";
import {
  assessPublicCardRetention,
  publicHandWaitingAdjustment,
} from "./public-card-retention.js";
import type { PublicCardUseValue } from "./card-lifecycle-value.js";
import { bindOpeningDeck, type PublicOpeningDeck } from "./opening-deck.js";
import type { Policy } from "./policies.js";

export const OPENING_POLICY_IDS = [
  "tactical-toc-opening-house-v1",
  "tactical-toc-opening-mulligan-v1",
  "tactical-toc-opening-v1",
] as const;
export type OpeningPolicyId = (typeof OPENING_POLICY_IDS)[number];
export interface OpeningPolicyContext {
  deck?: PublicOpeningDeck;
}
export interface OpeningDecision {
  ranked: ActionAssessment[];
  status:
    | "baseline"
    | "house"
    | "mulligan"
    | "missing-public-deck"
    | "unsupported-opening";
  mulligan?: {
    firstPlayer: boolean;
    keepCards: number;
    redrawCards: number;
    samples: number;
    keepValue: number;
    redrawMean: number;
    samplingStandardError: number;
    conservativeRedrawValue: number;
    cardEstimates: number;
  };
}
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, "en");
const features = {
  physicalBonuses: true,
  multipleHouses: true,
  targetIntent: true,
  netResources: true,
  contextualEffects: true,
  publicIntegerThirds: true,
  publicHouseChoices: true,
  publicAmberIconBindings: true,
  tokenEconomy: true,
  conditionalReapLocks: true,
} as const;
const complete = (o: Observation) =>
  o.publicStateCoverage?.effectsComplete !== false &&
  o.publicStateCoverage?.turnHistoryComplete !== false &&
  o.publicStateCoverage?.turnOrdinalKnown !== false;
const houses = (card: CardView) =>
  card.effective.houses ?? [card.effective.house];

/** No fabricated future table: this v1 handles the ordinary, empty-table game setup. */
function ordinaryOpening(o: Observation): boolean {
  const me = o.players[o.you];
  return (
    complete(o) &&
    o.turn === 1 &&
    [0, 1].includes(o.firstPlayer) &&
    o.you === o.activePlayer &&
    o.winner === null &&
    !o.pending &&
    o.handOperations === 0 &&
    o.playedThisTurn === 0 &&
    !o.turnStep?.omega &&
    o.permissions.length === 0 &&
    o.lasting.length === 0 &&
    o.houseRestrictions.length === 0 &&
    o.futureHouseRestrictions.length === 0 &&
    o.cardEffects.length === 0 &&
    o.leaveEffects.length === 0 &&
    o.resolving.length === 0 &&
    !o.prophecies?.some((p) => p.active) &&
    o.players.every(
      (p) =>
        !p.battleline.length &&
        !p.artifacts.length &&
        !p.upgrades.length &&
        !p.discard.length &&
        !p.purged.length &&
        !p.archiveCount &&
        !p.keys.length &&
        p.amber === 0 &&
        p.chains === 0,
    ) &&
    !!me.hand &&
    me.hand.length === me.handCount &&
    me.handCount >= 1 &&
    me.handCount <= 7 &&
    new Set(me.hand.map((c) => c.id)).size === me.handCount &&
    me.hand.every(
      (card) =>
        card.owner === o.you && card.controller === o.you && ordinaryCard(card),
    )
  );
}
function ordinaryCard(c: CardView): boolean {
  return (
    c.definition === c.spec.id &&
    !c.spec.unmodeled &&
    !c.spec.playCondition &&
    !c.spec.mimicAction &&
    !c.spec.mimicCreature &&
    !c.tokenCreature &&
    !c.copiedDefinition &&
    !c.copiedHouse &&
    !c.copiedCharacteristics &&
    !c.copiedAnimation &&
    !c.temporaryAnimation &&
    !c.animatedArtifact &&
    !c.form &&
    !c.copiedForm &&
    !c.gainedTextBoxes?.length &&
    !c.physicalParts?.length &&
    !c.giganticBonusIcons &&
    !c.spec.conditionalAbilities?.length
  );
}
function mainView(
  o: Observation,
  house: House,
  hand = o.players[o.you].hand!,
  turn = o.turn,
): Observation {
  const players = [...o.players] as Observation["players"];
  players[o.you] = {
    ...players[o.you],
    hand,
    handCount: hand.length,
    ...(o.phase === "mulligan" ? { deckCount: 36 - hand.length } : {}),
  };
  return {
    ...o,
    players,
    phase: "main",
    turn,
    activeHouse: house,
    pending: null,
    turnStep: { step: 3, performed: [0, 0], omega: false },
    legalActions: [],
  };
}

/** These private valuation menus are never passed to the referee as commands. */
function playMenu(view: Observation): Observation {
  const actions: LegalAction[] = [
    { id: "opening-end", action: { kind: "endTurn" } },
  ];
  for (const card of view.players[view.you].hand ?? []) {
    if (publicHandCardPlayable(view, card, { projected: true })) {
      actions.push({
        id: "opening-play:" + card.id,
        action: {
          kind: "play",
          card: card.id,
          ...(card.spec.kind === "creature" ? { flank: "left" as const } : {}),
        },
      });
    }
    if (
      view.activeHouse &&
      houses(card).includes(view.activeHouse) &&
      (view.turn !== 1 || view.handOperations === 0)
    )
      actions.push({
        id: "opening-discard:" + card.id,
        action: { kind: "discard", card: card.id },
      });
  }
  return { ...view, legalActions: actions };
}

function firstHouseValue(o: Observation, house: House): number {
  const view = playMenu(mainView(o, house)),
    rows = rankTocV2(view);
  const values = new Map(rows.map((r) => [r.actionId, r.score]));
  const use = (card: CardView): PublicCardUseValue | undefined => {
    const score = values.get("opening-play:" + card.id);
    return score === undefined
      ? undefined
      : { score: 0, currentScore: score, playableNow: true, approximate: true };
  };
  const window = assessPublicHandWindow(view, view.players[o.you].hand!, use, {
    projected: true,
    playPermissionEstimate: 1.5,
    reprice: (next, card) => {
      const menu = playMenu(next),
        row = rankTocV2(menu).find(
          (r) => r.actionId === "opening-play:" + card.id,
        );
      return row
        ? {
            score: 0,
            currentScore: row.score,
            playableNow: true,
            approximate: true,
          }
        : undefined;
    },
  });
  const discards = rows
    .filter((r) => r.actionId.startsWith("opening-discard:"))
    .map((r) => r.score);
  return Math.max(0, window.score, ...discards);
}

/** Independent card priors are computed once, then shared by every sampled hand.
 * The score is a bounded heuristic, not a predicted win probability or a complete simulation.
 */
function mulliganValues(
  o: Observation,
  deck: PublicOpeningDeck,
): OpeningDecision["mulligan"] | undefined {
  const bound = bindOpeningDeck(o, deck);
  if (!bound || bound.cards.some((card) => !ordinaryCard(card))) return;
  const first = o.firstPlayer === o.you,
    expectedSize = first ? 7 : 6;
  if (
    o.players[o.you].handCount !== expectedSize ||
    o.players[o.you].deckCount !== 36 - expectedSize
  )
    return;
  const turn = first ? 1 : 2,
    options = o.players[o.you].houses;
  if (
    !options.length ||
    options.some((h) => typeof h !== "string") ||
    new Set(options).size !== options.length
  )
    return;
  const priors = new Map<House, Map<string, PublicCardUseValue>>();
  let cardEstimates = 0;
  for (const house of options) {
    const cache = new Map<string, PublicCardUseValue>();
    for (const card of bound.cards) {
      const view = mainView(o, house, [card], turn);
      let unresolved = false;
      const value = assessPublicCardUse(
        view,
        card,
        o.you,
        (probe, id) => {
          const row = assessAlgorithmWithUncertainty(
            probe,
            id,
            "tempo-v1",
            features,
          );
          unresolved ||= row.unresolvedValues;
          return {
            score: row.score,
            approximate: row.approximate,
            unresolvedValues: row.unresolvedValues,
          };
        },
        { projected: true, requireFundedMaterial: true },
      );
      if (
        unresolved ||
        !value ||
        !Number.isFinite(value.score) ||
        Math.abs(value.score) >= 5000 ||
        (value.currentScore !== undefined &&
          (!Number.isFinite(value.currentScore) ||
            Math.abs(value.currentScore) >= 5000))
      )
        return;
      cache.set(card.id, value);
      cardEstimates++;
    }
    priors.set(house, cache);
  }
  const handValue = (hand: CardView[]) =>
    Math.max(
      ...options.map((house) => {
        const view = mainView(o, house, hand, turn),
          cache = priors.get(house)!;
        const use = (card: CardView) => cache.get(card.id);
        const window = assessPublicHandWindow(view, hand, use, {
          projected: true,
          playPermissionEstimate: 1.5,
          waitingAdjustment: publicHandWaitingAdjustment(view, use),
        });
        const material = hand.reduce(
          (n, card) => n + cache.get(card.id)!.score / 2,
          0,
        );
        const retained = assessPublicCardRetention(
          view,
          hand,
          use,
          new Set(window.selectedIds),
        );
        return material + retained.score + window.score;
      }),
    );
  const keepValue = handValue(bound.hand),
    redrawCards = expectedSize - 1,
    samples = 32;
  let random = 0x7f4a7c15;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) / 4294967296;
  };
  const values: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const draw = [...bound.cards];
    for (let index = 0; index < redrawCards; index++) {
      const other = index + Math.floor(next() * (draw.length - index));
      [draw[index], draw[other]] = [draw[other], draw[index]];
    }
    values.push(handValue(draw.slice(0, redrawCards)));
  }
  const redrawMean = values.reduce((n, value) => n + value, 0) / samples;
  const variance =
    values.reduce((n, value) => n + (value - redrawMean) ** 2, 0) /
    (samples - 1);
  const samplingStandardError = Math.sqrt(variance / samples);
  // The card cost is already represented by the smaller hand. This extra margin
  // only guards finite Monte Carlo noise; it is not a calibrated game-strength interval.
  return {
    firstPlayer: first,
    keepCards: expectedSize,
    redrawCards,
    samples,
    keepValue,
    redrawMean,
    samplingStandardError,
    conservativeRedrawValue: redrawMean - 2 * samplingStandardError,
    cardEstimates,
  };
}

export function assessOpeningPolicy(
  o: Observation,
  policy: OpeningPolicyId,
  context: OpeningPolicyContext = {},
): OpeningDecision {
  if (!OPENING_POLICY_IDS.includes(policy))
    throw Error("Unknown opening policy");
  const ranked = rankTocV2(o),
    baseline: OpeningDecision = { ranked, status: "baseline" };
  const houseEnabled = policy !== "tactical-toc-opening-mulligan-v1";
  const mulliganEnabled = policy !== "tactical-toc-opening-house-v1";
  if (
    o.phase === "house" &&
    o.turn === 1 &&
    o.you === o.firstPlayer &&
    houseEnabled
  ) {
    if (
      !ordinaryOpening(o) ||
      o.legalActions.some((row) => row.action.kind !== "house")
    )
      return { ...baseline, status: "unsupported-opening" };
    const byAction = new Map(o.legalActions.map((a) => [a.id, a.action]));
    return {
      status: "house",
      ranked: ranked
        .map((row) => {
          const action = byAction.get(row.actionId)!;
          if (action.kind !== "house" || action.house === null) return row;
          return {
            ...row,
            score: firstHouseValue(o, action.house),
            approximate: true,
            reasons: [
              ...row.reasons,
              "opening v1: bounded first-turn hand opportunity, not whole-house card count",
            ],
          };
        })
        .sort(compare),
    };
  }
  if (o.phase !== "mulligan" || !mulliganEnabled) return baseline;
  if (
    !ordinaryOpening(o) ||
    o.legalActions.length !== 2 ||
    !o.legalActions.some((r) => r.action.kind === "keep") ||
    !o.legalActions.some((r) => r.action.kind === "mulligan")
  )
    return { ...baseline, status: "unsupported-opening" };
  if (!context.deck) return { ...baseline, status: "missing-public-deck" };
  const result = mulliganValues(o, context.deck);
  if (!result) return { ...baseline, status: "unsupported-opening" };
  const take = result.conservativeRedrawValue > result.keepValue + 1e-9;
  return {
    status: "mulligan",
    mulligan: result,
    ranked: ranked
      .map((row) => {
        const action = o.legalActions.find(
          (a) => a.id === row.actionId,
        )!.action;
        return {
          ...row,
          score: Number((action.kind === "mulligan") === take),
          approximate: true,
          reasons: [
            ...row.reasons,
            "opening v1: public physical deck, smaller redraw hand, shared material/retention valuation",
          ],
        };
      })
      .sort(compare),
  };
}

export function openingPolicy(
  policy: OpeningPolicyId,
  context: OpeningPolicyContext = {},
): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error("No legal decision");
    return assessOpeningPolicy(o, policy, context).ranked[0].actionId;
  };
}
