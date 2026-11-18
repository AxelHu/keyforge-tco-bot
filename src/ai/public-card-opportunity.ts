/** Bounded card-use estimates reuse the public effect evaluator; they never grant a play action. */
import type { Action, CardView, Observation, Seat } from '../contracts/observation.js';
import { publicCardLocation, type PublicCardUseValue } from './card-lifecycle-value.js';
import { contextualBoardWorth } from './public-card-value.js';
import { publicPlayCapacity } from './public-guidance-guards.js';

import { publicHandCardPlayable, publicPlayCost, type HandWindowOptions } from './public-hand-window.js';

export interface PublicMaterialEstimate { score: number; approximate: boolean; unresolvedValues: boolean; currentKeyPriority?: boolean; }
export type PublicMaterialEvaluator = (observation: Observation, actionId: string) => PublicMaterialEstimate;
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);

/** A timing discount may use this opportunity, but only the separate strict recovery proof earns urgency. */
function currentWindow(o: Observation, c: CardView, owner: Seat): boolean {
  if (owner !== o.you || o.activePlayer !== owner || !o.activeHouse || o.turnStep?.omega ||
    !['main', 'archives', 'choice'].includes(o.phase) ||
    !(c.effective.houses ?? [c.effective.house]).includes(o.activeHouse) ||
    c.spec.cannotPlay || c.spec.playCondition || c.spec.conditionalAbilities?.length ||
    c.gainedTextBoxes?.length || c.spec.alpha && o.handOperations > 0 ||
    (o.turnUsage[c.spec.name] ?? 0) >= 6 || o.turn === 1 && o.handOperations >= 1) return false;
  const playTax = c.spec.kind === 'artifact' ? board(o).filter((x) => x.controller !== owner)
    .reduce((n, x) => n + (x.spec.opponentArtifactPlayTax ?? 0), 0) : 0;
  if (o.players[owner].amber < (c.spec.minAmberToPlay ?? 0) ||
    o.players[owner].amber < (c.spec.playAmberCost ?? 0) + playTax ||
    c.spec.kind === 'creature' && board(o).some((x) => x.controller === owner && x.spec.prohibitOwnCreatures) ||
    c.spec.kind === 'action' && board(o).some((x) => x.controller !== owner && x.spec.replacesEnemyActionPlayWithOwnLeftDestruction)) return false;
  const capacity = publicPlayCapacity(o);
  if (!capacity.known || capacity.blocked) return false;
  if (o.phase === 'choice') {
    const q = o.pending;
    if (!q || o.turnStep && o.turnStep.step !== 3 || (q.max ?? 1) !== 1) return false;
    const visible = [...board(o), ...o.resolving, ...o.promptCards];
    const source = visible.find((x) => x.id === q.source);
    if (!source || source.controller !== owner || source.spec.omega || source.gainedTextBoxes?.length ||
      source.spec.conditionalAbilities?.length || source.copiedDefinition ||
      o.resolving.some((x) => x.id !== source.id)) return false;
    const printed = Object.entries(source.spec.abilities ?? {});
    // A single terminal printed operation can open a normal main window. This is a
    // utility timing estimate, not the strict no-parent third-key proof.
    if (printed.length !== 1 || !['play', 'reap', 'action', 'omni'].includes(printed[0][0])) return false;
    const effects = printed[0][1];
    if (!effects || effects.length !== 1) return false;
    const effect = effects[0];
    const operation = q.intent?.kind === 'target-operation' ? q.intent.operation : q.kind === 'archive' ? 'archive' : undefined;
    if (!(effect.kind === 'archiveChoice' && operation === 'archive') &&
      !(effect.kind === 'target' && effect.operation === operation && !effect.after && (effect.max ?? 1) === 1)) return false;
  }
  for (const e of o.lasting) {
    if (e.rule === 'noNamedPlayUse' && e.turn >= o.turn && e.affectedName === c.spec.name) return false;
    if (e.appliesTo !== owner || (e.begins ?? o.turn) > o.turn || e.turn < o.turn) continue;
    if (e.rule === 'noPlay' || e.rule === 'noActions' && c.spec.kind === 'action' ||
      e.rule === 'noCreatures' && c.spec.kind === 'creature' ||
      e.rule === 'onlyPlayHouse' && e.house !== c.spec.house) return false;
  }
  return !board(o).some((x) => [x.spec, ...(x.gainedTextBoxes ?? [])].some((d) =>
    d.unmodeled || d.onePlayPerType || d.grantsAbilities?.length));
}

/** The only hidden-zone identities in a probe are cards already visible to the original observer. */
function publicProbe(o: Observation, c: CardView, owner: Seat, action: Action): Observation {
  const origin = publicCardLocation(o, c);
  const physical = { ...c, controller: owner, enteredController: owner, captured: 0, damage: 0, armorUsed: 0,
    stunned: false, warded: false, powerCounters: 0, ready: false, attachedTo: null, foreignArchiveHolder: null };
  const players = o.players.map((p, seat) => {
    const ownVisible = seat === o.you;
    const held = ownVisible ? (p.hand ?? []).filter((x) => x.id !== c.id) : [];
    const oldHand = origin?.seat === seat && origin.zone === 'hand';
    const oldArchive = origin?.seat === seat && origin.zone === 'archives';
    return { ...p,
      handCount: p.handCount - Number(oldHand) + Number(seat === owner),
      archiveCount: p.archiveCount - Number(oldArchive),
      deckCount: p.deckCount - Number(origin?.seat === seat && origin.zone === 'deck'),
      revealedTop: p.revealedTop?.id === c.id ? undefined : p.revealedTop,
      faceupArchives: p.faceupArchives?.filter((x) => x.id !== c.id),
      // A reframed opponent estimate never inherits either side's private arrays.
      hand: seat === owner ? [...(owner === o.you ? held : []), physical] : undefined,
      archives: seat === owner && owner === o.you ? p.archives?.filter((x) => x.id !== c.id) : undefined,
      discard: p.discard.filter((x) => x.id !== c.id), purged: p.purged.filter((x) => x.id !== c.id),
      battleline: p.battleline.filter((x) => x.id !== c.id), artifacts: p.artifacts.filter((x) => x.id !== c.id),
      upgrades: p.upgrades.filter((x) => x.id !== c.id),
    };
  }) as Observation['players'];
  // Public counters belong to this observed turn, so enemy/future histories are not fabricated as complete.
  return { ...o, you: owner, activePlayer: owner, phase: 'main', activeHouse: c.effective.house,
    players, pending: null, resolving: [], promptCards: [],
    legalActions: [{ id: 'public-material-probe', action }],
    ...(owner !== o.you ? { publicStateCoverage: { effectsComplete: o.publicStateCoverage?.effectsComplete !== false,
      turnHistoryComplete: false }, turnUsage: {}, handOperations: 0, playedThisTurn: 0,
      creaturesPlayedThisTurn: 0 } : {}),
  };
}

export function assessPublicCardUse(
  o: Observation, c: CardView, owner: Seat, evaluate: PublicMaterialEvaluator, options?: HandWindowOptions & { keyTiming?: boolean; requireFundedMaterial?: boolean },
): PublicCardUseValue | undefined {
  if (c.tokenCreature || c.copiedDefinition || c.definition !== c.spec.id ||
    (c.physicalParts?.length ?? 0) > 1) return undefined;
  const cost = options?.requireFundedMaterial ? publicPlayCost(o, c, owner) : 0;
  const funded = !options?.requireFundedMaterial || o.players[owner].amber >= Math.max(cost, c.spec.minAmberToPlay ?? 0);
  // Preserve the existing one-point physical option floor. The fallback is not an
  // executed Play: its board/icon component must also bear the full known pool cost.
  const fallback = 1 + Math.max(0, Math.max(0, contextualBoardWorth(o, c)) * (c.spec.kind === 'creature' ? 0.45 : 0.2) +
    Math.min(2, c.spec.amber) * 0.5 - 3.5 * cost);
  const actual = owner === o.you && !options?.projected ? o.legalActions.filter((x) => x.action.kind === 'play' &&
    x.action.card === c.id && !x.action.copy) : [];
  const current = (funded ? actual.slice(0, 16) : []).map((x) => evaluate(o, x.id));
  const currentScore = current.length ? Math.max(...current.map((x) => x.score)) : undefined;
  const actions: Action[] = c.spec.kind === 'upgrade'
    ? board(o).filter((x) => x.spec.kind === (options && c.spec.upgrade?.attachToArtifact ? 'artifact' : 'creature')).slice(0, 12)
        .map((x) => ({ kind: 'play', card: c.id, target: x.id }))
    : [{ kind: 'play', card: c.id, ...(c.spec.kind === 'creature' ? { flank: 'left' as const } : {}) }];
  // A material probe cannot debit an amount the payer does not have. An unfunded
  // hypothetical play would otherwise keep its full printed payoff for a partial price.
  // Keep the existing physical-card fallback until a public projection can pay in full.
  const probes = (funded ? actions : []).map((action) => {
    const view = publicProbe(o, c, owner, action);
    return evaluate(view, 'public-material-probe');
  });
  // A presently unpayable condition does not erase the retained option. No future amber is invented.
  const material = probes.filter((x) => Number.isFinite(x.score) && Math.abs(x.score) < 5000).map((x) => x.score);
  const quality = Math.max(fallback, ...material, ...(currentScore === undefined ? [] : [currentScore]));
  const alreadyHeld = owner === o.you && o.players[owner].hand?.some((x) => x.id === c.id);
  const playableNow = options ? owner === o.you && publicHandCardPlayable(o, c, options) : actual.length > 0 || (!alreadyHeld || o.phase !== 'main') && currentWindow(o, c, owner);
  // A cross-house permission or a physical extra house keeps the actual active house.
  // House-dependent effects in a future material probe may therefore have a different payoff.
  let usableMaterial = material;
  let currentEstimates = current;
  if (options && funded && playableNow && currentScore === undefined) {
    const currentProbes = o.activeHouse === c.effective.house ? probes : actions.map((action) =>
      evaluate({ ...publicProbe(o, c, owner, action), activeHouse: o.activeHouse }, 'public-material-probe'));
    currentEstimates = currentProbes;
    usableMaterial = currentProbes.filter((x) => !x.unresolvedValues && Number.isFinite(x.score) &&
      Math.abs(x.score) < 5000).map((x) => x.score);
  }
  return { score: quality, currentScore: currentScore ?? (playableNow && usableMaterial.length ? Math.max(...usableMaterial) : undefined),
    playableNow, approximate: true,
    ...(options?.keyTiming && playableNow && c.spec.kind === 'action' && currentEstimates.length === 1 &&
      !currentEstimates[0].unresolvedValues && currentEstimates[0].currentKeyPriority
      ? { currentKeyPriority: true } : {}),
  };
}
