/** V2 adds public Unity Prism and prophecy choices. V1 remains a frozen comparison control. */
import type { Action, CardView, House, LegalAction, Observation, Seat } from '../contracts/observation.js';
import {
  assessAlgorithm,
  type ActionAssessment,
  type PublicActionCorrections,
} from './algorithm-policies.js';
import { rankCardAware } from './card-aware-policy.js';
import { rankForgeAware } from './forge-lock-policy.js';
import { assessGuidedProphecy } from './prophecy-guided-policy.js';
import { directlyTriggers, prophecyOpportunity, type ProphecyOpportunity } from './prophecy-policy.js';
import { publicPlayCapacity, refillGuidanceStatus } from './public-guidance-guards.js';
import { explicitSeasonFilterZones } from './season-filter-policy.js';
import { effectUtility, other } from './season-utility.js';
import { publicPlayEndsStep } from './public-card-value.js';
import type { Policy } from './policies.js';

export const CARD_AWARE_V2_POLICY_IDS = ['tactical-card-aware-v2'] as const;
const CRITICAL = 5000;
const features = {
  physicalBonuses: true,
  multipleHouses: true,
  targetIntent: true,
  netResources: true,
  contextualEffects: true,
} as const;
const houses = (c: CardView): House[] => c.effective.houses ?? [c.effective.house];
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const prism = (c: CardView) => c.definition === 'unity-prism';
const typeLimitedForUs = (o: Observation) =>
  board(o).some((c) =>
    [c.spec, ...(c.gainedTextBoxes ?? [])].some(
      (box) =>
        box.onePlayPerType &&
        (box.onePlayPerType === 'self' ? c.controller === o.you : c.controller !== o.you),
    ),
  );
const prismPlayReplaced = (o: Observation) =>
  board(o).some(
    (c) =>
      c.controller !== o.you &&
      [c.spec, ...(c.gainedTextBoxes ?? [])].some((box) => box.replacesEnemyActionPlayWithOwnLeftDestruction),
  );
const compare = (a: ActionAssessment, b: ActionAssessment) =>
  b.score - a.score || a.actionId.localeCompare(b.actionId, 'en');

/** The discarded physical copy is already absent when Scrap reveals the remaining hand. */
export function prismScrapHouses(o: Observation, cardId: string): House[] {
  return [...new Set((o.players[o.you].hand ?? []).filter((c) => c.id !== cardId).flatMap(houses))].sort();
}

/** Reuse the existing gain/replacement evaluator, without awarding play icons or a play.
 * This private evaluation action is never returned, compiled or sent to a referee.
 */
function scrapAssessment(o: Observation, c: CardView): ActionAssessment {
  const id = 'v2-prism-scrap-value:' + c.id;
  const probe: LegalAction = {
    id,
    action: { kind: 'use', card: c.id },
    useDescription: {
      trigger: 'action',
      label: 'Unity Prism Scrap',
      effects: [{ kind: 'gain', amount: prismScrapHouses(o, c.id).length }],
    },
  };
  const r = assessAlgorithm({ ...o, legalActions: [...o.legalActions, probe] }, id, 'tempo-v1', features);
  return { ...r, score: r.score - 0.2 }; // Remove the evaluator's ordinary-use allowance.
}

interface HandWork {
  id: string;
  value: number;
  native: boolean;
  terminal: boolean;
  kind: string;
}
function knownHandWork(o: Observation, source: CardView, selectingHouse: boolean): HandWork[] {
  const own = o.players[o.you];
  const publicBoard = board(o);
  const noCreatures =
    own.battleline.concat(own.artifacts).some((c) => c.spec.prohibitOwnCreatures) ||
    o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'noCreatures');
  const noPlay = o.lasting.some((e) => e.turn === o.turn && e.appliesTo === o.you && e.rule === 'noPlay');
  if (noPlay) return [];
  const result: HandWork[] = [];
  for (const c of own.hand ?? []) {
    if (c.id === source.id || c.spec.alpha || prism(c)) continue;
    if (
      c.spec.kind === 'creature' &&
      (noCreatures || publicBoard.some((x) => x.spec.creaturePlayLimits?.length))
    )
      continue;
    if (Math.max(c.spec.minAmberToPlay ?? 0, c.spec.playAmberCost ?? 0) > own.amber) continue;
    const actual = o.legalActions.filter((x) => x.action.kind === 'play' && x.action.card === c.id);
    // Do not manufacture upgrade targets, copied forms, composite entries or conditional permissions.
    if (!actual.length && (c.spec.kind === 'upgrade' || c.spec.playCondition || c.physicalParts?.length))
      continue;
    const native = selectingHouse ? houses(c).includes(o.activeHouse!) : actual.length > 0;
    const probe: LegalAction = { id: 'v2-prism-hand-value:' + c.id, action: { kind: 'play', card: c.id } };
    const choices = actual.length ? actual : [probe];
    const view = actual.length ? o : { ...o, legalActions: [...o.legalActions, probe] };
    const value = Math.max(
      ...choices.map((a) => {
        const r = assessAlgorithm(view, a.id, 'tempo-v1', {
          ...features,
          publicIntegerThirds: c.definition === 'sir-jaune',
        });
        // Future legal availability is not certified. In particular, no hypothetical win
        // or denial can inherit an immediate-action priority of 5,000 or 100,000.
        return Math.max(0, Math.min(100, r.score));
      }),
    );
    result.push({ id: c.id, value, native, terminal: publicPlayEndsStep(o, c), kind: c.spec.kind });
  }
  return typeLimitedForUs(o)
    ? result.filter((c) => (o.playedTypes?.[o.you]?.[c.kind as CardView['spec']['kind']] ?? 0) === 0)
    : result;
}

function bestWork(cards: HandWork[], limit: number, onePerType = false): { value: number; ids: string[] } {
  if (onePerType) {
    const best = new Map<string, HandWork>();
    for (const c of cards) {
      const old = best.get(c.kind);
      if (!old || c.value > old.value || (c.value === old.value && c.id < old.id)) best.set(c.kind, c);
    }
    cards = [...best.values()];
  }
  const ordinary = cards
    .filter((c) => !c.terminal)
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id, 'en'));
  const take = (terminal?: HandWork) => {
    const chosen = [
      ...ordinary.slice(0, Math.max(0, limit - Number(!!terminal))),
      ...(terminal && limit > 0 ? [terminal] : []),
    ];
    return { value: chosen.reduce((n, c) => n + c.value, 0), ids: chosen.map((c) => c.id) };
  };
  return [take(), ...cards.filter((c) => c.terminal).map((c) => take(c))].sort(
    (a, b) => b.value - a.value || a.ids.join('|').localeCompare(b.ids.join('|'), 'en'),
  )[0];
}

export interface UnityPrismAssessment {
  additionalWork: number;
  retainedNativeWork: number;
  retainedAfterScrapWork: number;
  afterPlayCards: string[];
  afterPlayLimit: number;
  nativeWork: number;
  conditionalWork: number;
}
/** At most three subsequent plays, because Prism itself consumes one of its four.
 * This is a bounded public-hand opportunity estimate, not a future legal-action list.
 * It never gives cross-house permission to reap/fight/use, and never reads future draws.
 */
export function assessUnityPrism(o: Observation, c: CardView, selectingHouse = false): UnityPrismAssessment {
  if (prismPlayReplaced(o))
    return {
      additionalWork: 0,
      retainedNativeWork: 0,
      retainedAfterScrapWork: 0,
      afterPlayCards: [],
      afterPlayLimit: 0,
      nativeWork: 0,
      conditionalWork: 0,
    };
  const work = knownHandWork(o, c, selectingHouse);
  const capacity = publicPlayCapacity(o);
  const firstTurn = o.turn === 1 || o.publicStateCoverage?.turnOrdinalKnown === false;
  const priorLimit = firstTurn ? 1 : (capacity.remaining ?? capacity.limit ?? work.length + 1);
  const afterPlayLimit = firstTurn ? 0 : Math.max(0, Math.min(3, priorLimit - 1));
  const native = work.filter((x) => x.native);
  const typeLimited = typeLimitedForUs(o);
  const before = bestWork(native, priorLimit, typeLimited);
  const after = bestWork(
    typeLimited ? work.filter((c) => c.kind !== 'action') : work,
    afterPlayLimit,
    typeLimited,
  );
  return {
    additionalWork: after.value - before.value,
    retainedNativeWork:
      afterPlayLimit > 0
        ? bestWork(typeLimited ? native.filter((c) => c.kind !== 'action') : native, 1, typeLimited).value
        : 0,
    retainedAfterScrapWork: !firstTurn && priorLimit > 0 ? bestWork(native, 1, typeLimited).value : 0,
    afterPlayCards: after.ids,
    afterPlayLimit,
    nativeWork: before.value,
    conditionalWork: after.value,
  };
}

function prismHouseCorrection(o: Observation, h: House): number {
  const copies = (o.players[o.you].hand ?? []).filter((c) => prism(c) && houses(c).includes(h));
  if (!copies.length) return 0;
  const view: Observation = { ...o, activeHouse: h, phase: 'main', pending: null };
  let current = view,
    scrap = 0;
  const usable = o.turn === 1 ? copies.slice(0, 1) : copies;
  for (const c of usable) {
    const r = scrapAssessment(current, c);
    scrap += Math.max(0, Math.min(CRITICAL - 1, r.score));
    const p = current.players[current.you];
    current = { ...current, players: [...current.players] as Observation['players'] };
    current.players[current.you] = {
      ...p,
      amber: r.estimatedAmber[0],
      hand: p.hand!.filter((x) => x.id !== c.id),
      handCount: p.handCount - 1,
    };
  }
  const plans = copies.map((c) => assessUnityPrism(view, c, true));
  const unlocked = Math.max(0, ...plans.map((p) => p.additionalWork));
  // houseWork already counted the native hand. Replace only its fixed Prism allowance.
  const fixed = copies.reduce(
    (n, c) =>
      n + 1.6 + (c.resolvedBonusIcons ?? c.bonusIcons ?? []).filter((x) => x === 'amber').length * 1.3,
    0,
  );
  return Math.max(scrap, unlocked) - fixed;
}

/** Outlook's public board test includes both players, artifacts, upgrades and all effective houses. */
export function cardAwareProphecyOpportunity(o: Observation, face: string, owner: Seat): ProphecyOpportunity {
  if (face !== 'outlook-not-so-good') return prophecyOpportunity(o, face, owner);
  const foe = o.players[other(owner)];
  if (
    o.publicStateCoverage?.effectsComplete !== false &&
    o.publicStateCoverage?.turnHistoryComplete !== false &&
    foe.keys.length === 2 &&
    foe.forgeAvailable >= foe.keyCost &&
    !foe.forgeBlocked &&
    foe.skipForgeTurn !== o.turn + 1 &&
    !foe.artifacts.some((c) => c.spec.skipForgeStep)
  )
    return { probability: 0, timing: 'early' }; // A completed third key ends the game before house selection.
  const available = new Set([
    ...foe.houses,
    ...foe.battleline.concat(foe.artifacts, foe.upgrades).flatMap(houses),
  ]);
  const represented = new Set(board(o).flatMap(houses));
  const restrictions = [...o.houseRestrictions, ...o.futureHouseRestrictions].filter(
    (r) => r.player === other(owner) && (r.turn === null || r.turn === o.turn + 1),
  );
  let choices = [...available].filter(
    (h) => !restrictions.some((r) => r.rule === 'cannotHouse' && r.house === h),
  );
  const forced = choices.filter(
    (h) =>
      restrictions.some((r) => r.rule === 'mustHouse' && r.house === h) ||
      foe.battleline.some((c) => c.spec.mustHouse === h),
  );
  const lastHouse = o.previousChosenHouses?.[other(owner)];
  if (lastHouse && board(o).some((c) => c.spec.forbidsPreviousHouse))
    choices = choices.filter((h) => h !== lastHouse);
  const stillForced = forced.filter((h) => choices.includes(h));
  if (stillForced.length) choices = stillForced;
  const missing = choices.filter((h) => !represented.has(h)).length;
  // Zero/all coverage are exact board facts. Partial coverage is an explicit equal-house
  // prior, not an assertion about the opponent's hand or what house they will choose.
  return { probability: choices.length ? missing / choices.length : 0, timing: 'early' };
}

function fateValueAtTrigger(o: Observation, card: CardView, face: string, owner: Seat): number {
  const actor = other(owner),
    p = o.players[actor];
  const timing = cardAwareProphecyOpportunity(o, face, owner).timing;
  const utility = (view: Observation) =>
    effectUtility(view, card.spec.abilities?.fate ?? [], actor, card, timing);
  const now = utility(o);
  // Both house selection and the Forge-Ahead event are after the normal forge payment.
  // Never value Sir Jaune using six amber that has already paid for a six-cost key.
  const mayForge =
    p.keys.length < 3 && p.forgeAvailable >= p.keyCost && !p.forgeBlocked && p.skipForgeTurn !== o.turn + 1;
  if (!mayForge || !['outlook-not-so-good', 'forge-ahead-with-confidence'].includes(face)) return now;
  const after: Observation = { ...o, players: [...o.players] as Observation['players'] };
  after.players[actor] = {
    ...p,
    amber: Math.max(0, p.amber - p.keyCost),
    forgeAvailable: Math.max(0, p.forgeAvailable - p.keyCost),
  };
  // Alternative forge sources or unknown restrictions are not invented. The less
  // favorable of these public resource endpoints is used as a conservative estimate.
  return Math.min(now, utility(after));
}

export interface CardAwareProphecyAssessment {
  score: number;
  triggerProbability: number;
  fateValue: number;
  cycleValue: number;
  retentionCost: number;
  slotCost: number;
  refillKnown: boolean;
}
export function assessCardAwareProphecy(
  o: Observation,
  a: Extract<Action, { kind: 'activateProphecy' }>,
  bestPlayScore = 0,
): CardAwareProphecyAssessment {
  const card = o.players[o.you].hand?.find((c) => c.id === a.card);
  const slot = o.prophecies?.find((p) => p.id === a.slot);
  const base = assessGuidedProphecy(o, a, bestPlayScore);
  const refillKnown = refillGuidanceStatus(o).known;
  if (!card || !slot || base.score === -100) return { ...base, refillKnown };
  const face = slot.faces[a.face];
  const probability = cardAwareProphecyOpportunity(o, face, o.you).probability;
  const offHouse = !houses(card).includes(o.activeHouse!);
  const cycleValue = refillKnown ? (base.additionalRefill * 1.9 + (offHouse ? 0.35 : 0)) * probability : 0;
  const fateValue = fateValueAtTrigger(o, card, face, o.you) * probability;
  const openSlots = (o.prophecies ?? []).filter(
    (p) => p.owner === o.you && !p.active && p.count === 0,
  ).length;
  const slotCost = 0.35 + (1 - probability) * 1.5 + (openSlots <= 1 ? 0.4 : 0);
  const retentionCost = Math.max(
    base.retentionCost,
    prism(card) ? Math.max(0, Math.min(CRITICAL - 1, scrapAssessment(o, card).score)) : 0,
  );
  return {
    score: fateValue + cycleValue - retentionCost - slotCost,
    triggerProbability: probability,
    fateValue,
    cycleValue,
    retentionCost,
    slotCost,
    refillKnown,
  };
}

export function rankCardAwareV2(
  o: Observation,
  corrections: PublicActionCorrections = {},
): ActionAssessment[] {
  const inherited = rankCardAware(o, true, corrections);
  const normalized = explicitSeasonFilterZones(o);
  const legal = new Map(o.legalActions.map((a) => [a.id, a.action]));
  const ownHand = new Map((normalized.players[o.you].hand ?? []).map((c) => [c.id, c]));
  const sirJaunePlay = (id: string) => {
    const a = legal.get(id)!;
    return a.kind === 'play' && ownHand.get(a.copy ?? a.card)?.definition === 'sir-jaune';
  };
  const thirdRows = inherited.some((r) => sirJaunePlay(r.actionId))
    ? new Map(
        rankForgeAware(o, 'tactical', {
          netResources: true,
          contextualEffects: true,
          publicIntegerThirds: true,
        }).map((r) => [r.actionId, r]),
      )
    : new Map<string, ActionAssessment>();
  const rows = inherited.map((r) =>
    sirJaunePlay(r.actionId)
      ? {
          ...thirdRows.get(r.actionId)!,
          reasons: [
            ...thirdRows.get(r.actionId)!.reasons,
            'card-aware v2: Sir Jaune captures an integer third of the current public pool after earlier icons; original replacement and forge-lock checks retained',
          ],
        }
      : r,
  );
  const unsequenced = (normalized.players[o.you].hand ?? []).some(prism)
    ? new Map(rankCardAware(o, false).map((r) => [r.actionId, r]))
    : new Map<string, ActionAssessment>();

  const play = new Map<string, number>();
  for (const row of rows) {
    const a = legal.get(row.actionId)!;
    if (a.kind === 'play') play.set(a.card, Math.max(play.get(a.card) ?? 0, row.score));
  }
  return rows
    .map((original) => {
      const a = legal.get(original.actionId)!;
      if (original.score >= CRITICAL || a.kind === 'forge' || a.kind === 'payForge') return original;
      const c = 'card' in a ? ownHand.get(a.card) : undefined;
      let row = original,
        score = row.score;
      const reasons: string[] = [];
      if (a.kind === 'discard' && c && prism(c) && c.spec.abilities?.scrap?.length) {
        const r = scrapAssessment(normalized, c);
        row = {
          ...row,
          estimatedAmber: r.estimatedAmber,
          projectedKey: r.projectedKey,
          deniesKey: r.deniesKey,
          approximate: r.approximate,
        };
        const retained = assessUnityPrism(normalized, c).retainedAfterScrapWork;
        score = (unsequenced.get(original.actionId) ?? original).score + r.score + retained;
        reasons.push(
          'card-aware v2: Prism Scrap counts remaining physical hand houses, without play icons; income replacements retained',
        );
      }
      if (
        a.kind === 'play' &&
        c &&
        prism(c) &&
        c.spec.alpha &&
        !prismPlayReplaced(normalized) &&
        c.spec.abilities?.play?.some((e) => e.kind === 'permission')
      ) {
        const p = assessUnityPrism(normalized, c);
        // 1.8 was the old empty action (0.3) plus generic permission (1.5).
        score =
          (unsequenced.get(original.actionId) ?? original).score -
          1.8 +
          p.additionalWork +
          p.retainedNativeWork;
        reasons.push(
          'card-aware v2: Prism conditional hand work uses ' +
            p.afterPlayCards.length +
            ' of at most ' +
            p.afterPlayLimit +
            ' follow-up plays; no cross-house uses or future draws',
        );
      }
      if (a.kind === 'house' && a.house) {
        const delta = prismHouseCorrection(normalized, a.house);
        if (delta) {
          score += delta;
          reasons.push(
            'card-aware v2: active house includes visible Prism Scrap or bounded cross-house hand work',
          );
        }
      }
      if (a.kind === 'activateProphecy') {
        const p = assessCardAwareProphecy(normalized, a, play.get(a.card) ?? 0);
        score = p.score;
        reasons.push(
          'card-aware v2: actual own Fate, opponent resolving perspective, public trigger coverage and post-forge payment; ' +
            (p.refillKnown ? 'bounded normal refill' : 'unknown refill receives no draw credit'),
        );
      }
      for (const p of normalized.prophecies ?? []) {
        if (
          p.active &&
          p.owner !== o.you &&
          !p.revealed &&
          directlyTriggers(normalized, a, p.faces[p.face])
        ) {
          score -= 1.1; // Existing tactical-season risk; hidden Fate identity remains unknown.
          reasons.push('card-aware v2: modest opposing public-trigger risk; facedown Fate is not inspected');
        }
        if (
          p.owner === o.you &&
          p.active &&
          p.faces[p.face] === 'outlook-not-so-good' &&
          p.cards?.length &&
          a.kind === 'play' &&
          c &&
          ['creature', 'artifact', 'upgrade'].includes(c.spec.kind)
        ) {
          const future: Observation = {
            ...normalized,
            players: [...normalized.players] as Observation['players'],
          };
          const me = future.players[o.you];
          future.players[o.you] = { ...me, artifacts: [...me.artifacts, c] }; // Only the public house union is queried.
          const before = cardAwareProphecyOpportunity(normalized, 'outlook-not-so-good', o.you).probability;
          const after = cardAwareProphecyOpportunity(future, 'outlook-not-so-good', o.you).probability;
          const lost =
            Math.max(0, before - after) *
            Math.max(0, fateValueAtTrigger(normalized, p.cards[0], 'outlook-not-so-good', o.you));
          if (lost) {
            score -= lost;
            reasons.push(
              'card-aware v2: this permanent represents a missing house and can release own active Outlook pressure',
            );
          }
        }
      }
      if (!reasons.length) return original;
      if (!Number.isFinite(score)) throw Error('Nonfinite card-aware v2 score');
      // New utility and continuation estimates never inherit an immediate win/denial priority.
      score = Math.min(CRITICAL - 1, score);
      return { ...row, score, approximate: true, reasons: [...row.reasons, ...reasons] };
    })
    .sort(compare);
}
export function cardAwarePolicyV2(): Policy {
  return (o) => {
    if (!o.legalActions.length) throw Error('No legal decision');
    return rankCardAwareV2(o)[0].actionId;
  };
}
