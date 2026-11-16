/** A bounded public risk estimate for an actual legal reap, never a rules executor.
 * Printed reactions can inform risk even when the adapter cannot report every effect.
 * No outcome, transfer, retained physical entry or future legal action is guaranteed here.
 */
import type { CardView, Effect, Observation, Reaction, Seat, Value } from '../contracts/observation.js';
import { contextualControlValue } from './public-card-value.js';

export interface PublicReapControlRisk {
  status: 'none' | 'risk' | 'uncertain';
  score: number;
  approximate: boolean;
  transferGuaranteed: false;
  sources: string[];
  possibleTransfer?: { card: string; from: Seat; to: Seat };
  reasons: string[];
}
interface Budget {
  left: number;
}
interface Transfer {
  controller: Seat;
  whileSource: boolean;
}
interface RulePlan {
  potential: boolean;
  understood: boolean;
  transfers: Transfer[];
}
const other = (seat: Seat): Seat => (seat === 0 ? 1 : 0);
const boxes = (c: CardView) => [c.spec, ...(c.gainedTextBoxes ?? [])];
const only = (value: object, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const spend = (budget: Budget, depth = 0) => --budget.left >= 0 && depth <= 6;
const none = (): PublicReapControlRisk => ({
  status: 'none',
  score: 0,
  approximate: false,
  transferGuaranteed: false,
  sources: [],
  reasons: [],
});

/** Core count filters default to battleline, not to all permanents in play. */
function scalar(o: Observation, v: Value, actor: Seat, budget: Budget, depth = 0): number | undefined {
  if (!spend(budget, depth)) return;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if ('count' in v) {
    const f = v.count;
    if (
      !only(v, ['count', 'multiplier']) ||
      !only(f, ['side', 'zone', 'kind']) ||
      (f.zone !== undefined && f.zone !== 'battleline') ||
      (f.kind !== undefined && f.kind !== 'creature') ||
      (f.side !== undefined && !['friendly', 'enemy', 'any'].includes(f.side)) ||
      (v.multiplier !== undefined && !Number.isFinite(v.multiplier))
    )
      return;
    const seat = f.side === 'friendly' ? actor : f.side === 'enemy' ? other(actor) : undefined;
    const line = seat === undefined ? o.players.flatMap((p) => p.battleline) : o.players[seat].battleline;
    return new Set(line.map((c) => c.id)).size * (v.multiplier ?? 1);
  }
  if ('add' in v && only(v, ['add'])) {
    const ns = v.add.map((x) => scalar(o, x, actor, budget, depth + 1));
    return ns.some((x) => x === undefined) ? undefined : ns.reduce<number>((sum, x) => sum + x!, 0);
  }
  if ('subtract' in v && only(v, ['subtract'])) {
    const [a, b] = v.subtract.map((x) => scalar(o, x, actor, budget, depth + 1));
    return a === undefined || b === undefined ? undefined : a - b;
  }
  return;
}
function matches(o: Observation, source: CardView, reaper: CardView, r: Reaction): boolean | undefined {
  if (
    !only(r, [
      'event',
      'side',
      'subjectStillOriginalEntry',
      'sourceReady',
      'selfOnly',
      'other',
      'house',
      'ownTurn',
      'effects',
    ]) ||
    (r.side !== undefined && !['friendly', 'enemy', 'any'].includes(r.side))
  )
    return;
  if (r.side === 'friendly' && source.controller !== reaper.controller) return false;
  if (r.side === 'enemy' && source.controller === reaper.controller) return false;
  if (r.selfOnly && source.id !== reaper.id) return false;
  if (r.other && source.id === reaper.id) return false;
  if (r.house && !(reaper.effective.houses ?? [reaper.effective.house]).includes(r.house)) return false;
  if (r.ownTurn && o.activePlayer !== source.controller) return false;
  if (r.sourceReady && !source.ready) return false;
  return true;
}

/** An unsupported AST is inspected only to detect a possible control rule, never executed. */
function containsControl(input: unknown, budget: Budget, depth = 0): boolean | undefined {
  if (!spend(budget, depth)) return;
  if (input === null || typeof input !== 'object') return false;
  if (!Array.isArray(input) && (input as { kind?: string }).kind === 'takeControl') return true;
  let unknown = false;
  for (const x of Array.isArray(input) ? input : Object.values(input)) {
    const result = containsControl(x, budget, depth + 1);
    if (result === true) return true;
    unknown ||= result === undefined;
  }
  return unknown ? undefined : false;
}

function planRule(o: Observation, source: CardView, effects: readonly Effect[], budget: Budget): RulePlan {
  const result: RulePlan = { potential: false, understood: true, transfers: [] };
  const walk = (
    xs: readonly Effect[],
    bound: ReadonlySet<string>,
    active: boolean | undefined,
    depth: number,
  ) => {
    for (const e of xs) {
      if (!spend(budget, depth)) {
        result.potential = true;
        result.understood = false;
        return;
      }
      if (e.kind === 'if' && only(e, ['kind', 'condition', 'then', 'otherwise'])) {
        const q = e.condition;
        let yes: boolean | undefined;
        if (only(q, ['left', 'comparison', 'right'])) {
          const l = scalar(o, q.left, source.controller, budget),
            r = scalar(o, q.right, source.controller, budget);
          if (l !== undefined && r !== undefined) {
            if (q.comparison === 'gt') yes = l > r;
            else if (q.comparison === 'gte') yes = l >= r;
            else if (q.comparison === 'eq') yes = l === r;
            else if (q.comparison === 'lt') yes = l < r;
            else if (q.comparison === 'lte') yes = l <= r;
          }
        }
        if (yes === undefined) result.understood = false;
        walk(
          e.then,
          bound,
          active === false || yes === false ? false : active === true && yes === true ? true : undefined,
          depth + 1,
        );
        walk(
          e.otherwise ?? [],
          bound,
          active === false || yes === true ? false : active === true && yes === false ? true : undefined,
          depth + 1,
        );
      } else if (
        e.kind === 'bindCards' &&
        only(e, ['kind', 'filter', 'bind', 'then']) &&
        only(e.filter, ['eventOnly', 'zone', 'kind']) &&
        e.filter.eventOnly === true &&
        (e.filter.zone === undefined || e.filter.zone === 'battleline') &&
        (e.filter.kind === undefined || e.filter.kind === 'creature') &&
        typeof e.bind === 'string' &&
        e.bind.length > 0
      ) {
        walk(e.then, new Set([...bound, e.bind]), active, depth + 1);
      } else if (e.kind === 'takeControl') {
        result.potential = true;
        if (
          !only(e, ['kind', 'key', 'side', 'whileSource']) ||
          !e.key ||
          !bound.has(e.key) ||
          (e.side !== undefined && e.side !== 'self' && e.side !== 'opponent')
        ) {
          result.understood = false;
          continue;
        }
        if (active === undefined) result.understood = false;
        if (active === true)
          result.transfers.push({
            controller: e.side === 'opponent' ? other(source.controller) : source.controller,
            whileSource: e.whileSource === true,
          });
      } else {
        const control = containsControl(e, budget, depth + 1);
        result.potential ||= control !== false;
        result.understood = false;
      }
    }
  };
  walk(effects, new Set(), true, 0);
  return result;
}

/** These immediate effects do not move an in-play body or change its controller/text.
 * Deck-to-archive bindings are accepted only as a complete, private-identity-free
 * structural pair; they never imply that arbitrary bound movement is harmless.
 * Conditional branches must both fit; unknown effects cannot become harmless by omission.
 */
function stableEffects(
  effects: readonly Effect[],
  budget: Budget,
  resourceChangesSafe: boolean,
  depth = 0,
): boolean {
  for (const e of effects) {
    if (!spend(budget, depth)) return false;
    if (
      ['gain', 'draw', 'chains', 'steal', 'loseOpponent'].includes(e.kind) &&
      'amount' in e &&
      typeof e.amount === 'number' &&
      Number.isFinite(e.amount) &&
      e.amount >= 0 &&
      only(e, ['kind', 'amount'])
    )
      continue;
    if (
      e.kind === 'resource' &&
      ['gain', 'lose', 'steal', 'draw', 'chains'].includes(e.operation) &&
      typeof e.amount === 'number' &&
      Number.isFinite(e.amount) &&
      e.amount >= 0 &&
      only(e, ['kind', 'operation', 'amount', 'side'])
    )
      continue;
    if (
      resourceChangesSafe &&
      e.kind === 'self' &&
      e.operation === 'removeAmber' &&
      typeof e.amount === 'number' &&
      Number.isFinite(e.amount) &&
      e.amount >= 0 &&
      only(e, ['kind', 'operation', 'amount'])
    )
      continue; // Captured amber leaves to supply; this is not player-pool income.
    if (
      resourceChangesSafe &&
      e.kind === 'bindDeckEdge' &&
      only(e, ['kind', 'edge', 'count', 'bind', 'then']) &&
      (e.edge === 'top' || e.edge === 'bottom') &&
      Number.isSafeInteger(e.count) &&
      e.count >= 0 &&
      typeof e.bind === 'string' &&
      e.bind.length > 0 &&
      e.then.length === 1
    ) {
      const destination = e.then[0];
      if (
        spend(budget, depth + 1) &&
        destination.kind === 'bound' &&
        only(destination, ['kind', 'key', 'operation']) &&
        destination.key === e.bind &&
        destination.operation === 'archive'
      )
        continue;
    }
    if (
      e.kind === 'if' &&
      only(e, ['kind', 'condition', 'then', 'otherwise']) &&
      stableEffects(e.then, budget, resourceChangesSafe, depth + 1) &&
      stableEffects(e.otherwise ?? [], budget, resourceChangesSafe, depth + 1)
    )
      continue;
    return false;
  }
  return true;
}

export function assessPublicReapControl(o: Observation, actionId: string): PublicReapControlRisk {
  const item = o.legalActions.find((x) => x.id === actionId);
  if (!item) throw Error('Cannot assess control risk for an illegal action');
  if (item.action.kind !== 'reap') return none();
  const action = item.action,
    board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]),
    reaper = o.players.flatMap((p) => p.battleline).find((c) => c.id === action.card),
    budget: Budget = { left: 128 };
  const uncertain = (sources: string[], reason: string): PublicReapControlRisk => ({
    status: 'uncertain',
    score: 0,
    approximate: true,
    transferGuaranteed: false,
    sources: [...new Set(sources)],
    reasons: ['reap-control: ' + reason + '; no guaranteed control or retained-entry outcome'],
  });
  if (!reaper) return uncertain([], 'the legal reaper has no current public battleline identity');
  const reactions = board.flatMap((source) =>
    boxes(source).flatMap((box) =>
      (box.reactions ?? [])
        .filter((r) => r.event === 'creatureReaped' || r.event === 'creatureUsed')
        .flatMap((reaction) => {
          const match = matches(o, source, reaper, reaction);
          // A publicly false event predicate cannot affect this use window. Avoid
          // spending the bounded AST budget on another controller's unrelated text.
          return match === false
            ? []
            : [{ source, reaction, match, plan: planRule(o, source, reaction.effects, budget) }];
        }),
    ),
  );
  const potential = reactions.filter((r) => r.plan.potential);
  if (!potential.length) return none();
  const ids = potential.map((r) => r.source.id);
  if (
    new Set(o.players.flatMap((p) => p.battleline).map((c) => c.id)).size !==
      o.players.reduce((n, p) => n + p.battleline.length, 0) ||
    o.players.some((p, seat) => p.battleline.some((c) => c.controller !== seat)) ||
    action.permission !== undefined ||
    reaper.controller !== o.you ||
    potential.some(
      (r) => r.match === undefined || !r.plan.understood || r.reaction.event !== 'creatureReaped',
    )
  )
    return uncertain(ids, 'a controller, event binding, predicate or control branch is unsupported');

  const relevant = [reaper, ...potential.map((r) => r.source)];
  const attached = board.filter((c) => c.attachedTo && relevant.some((r) => r.id === c.attachedTo));
  if (
    relevant.some((c) => c.copiedDefinition || c.copiedCharacteristics || c.gainedTextBoxes?.length) ||
    attached.some((u) => u.spec.upgrade?.blanksHost) ||
    (relevant.some((c) => c.spec.kind === 'artifact') &&
      board.some((c) => boxes(c).some((box) => box.blanksArtifacts))) ||
    o.lasting.some(
      (e) => e.turn === o.turn && ['blankCreatures', 'poolIncomeBecomesTokens'].includes(e.rule),
    ) ||
    board.some((c) =>
      boxes(c).some((box) =>
        box.grantsAbilities?.some((g) => g.abilities.reap?.length || g.abilities.afterUse?.length),
      ),
    ) ||
    relevant.some((c) =>
      boxes(c).some((box) => box.destroyFriendlyBeforeUse || box.conditionalAbilities?.length),
    )
  )
    return uncertain(ids, 'visible copied, gained, blanked or replacement text can alter this use window');

  // These extra resource-only nodes may still change a damaged creature's power
  // through public continuous text. Refuse such boards instead of forecasting
  // state-based deaths or reading the identities of the deck cards being archived.
  // This gate applies only to the newly admitted nodes, preserving older estimates.
  const dynamic = (v: Value | undefined) => v !== undefined && typeof v !== 'number';
  const resourceChangesSafe = !board.some(
    (c) =>
      c.copiedDefinition ||
      c.copiedCharacteristics ||
      c.gainedTextBoxes?.length ||
      boxes(c).some(
        (box) =>
          box.selfPower === 'captured' ||
          dynamic(box.powerBonus) ||
          dynamic(box.armorBonusValue) ||
          dynamic(box.upgrade?.hostPowerBonus) ||
          box.conditionalAbilities?.length ||
          box.conditionalKeywords?.length ||
          box.upgrade?.conditionalKeywords?.length ||
          box.grantsAbilities?.some((g) => g.sourceCondition) ||
          box.auras?.some(
            (a) =>
              a.sourceCondition ||
              a.sourceAmberMultiplier !== undefined ||
              a.targetAmberMultiplier !== undefined ||
              a.filter.withAmber !== undefined,
          ),
      ),
  );

  const ownEffects = [
    ...(reaper.spec.abilities?.reap ?? []),
    ...(reaper.spec.abilities?.afterUse ?? []),
    ...board
      .filter((u) => u.attachedTo === reaper.id)
      .flatMap((u) => [
        ...(u.spec.upgrade?.abilities?.reap ?? []),
        ...(u.spec.upgrade?.abilities?.afterUse ?? []),
      ]),
  ];
  if (
    !stableEffects(ownEffects, budget, resourceChangesSafe) ||
    reactions.some(
      (r) =>
        !potential.includes(r) &&
        (r.match === undefined || !stableEffects(r.reaction.effects, budget, resourceChangesSafe)),
    ) ||
    budget.left < 0
  )
    return uncertain(
      ids,
      'same-window Reap or reaction effects can move bodies, change counts/control, or are unmodeled',
    );

  const transfers = potential
    .flatMap((r) => r.plan.transfers)
    .filter((r) => r.controller !== reaper.controller);
  if (!transfers.length) return none();
  const destinations = new Set(transfers.map((x) => x.controller));
  if (destinations.size !== 1 || new Set(transfers.map((x) => x.whileSource)).size !== 1)
    return uncertain(
      ids,
      'conflicting control destinations or durations require an ordered native resolution',
    );
  const destination = transfers[0].controller;
  return {
    status: 'risk',
    score: contextualControlValue(o, reaper, destination, transfers[0].whileSource),
    approximate: true,
    transferGuaranteed: false,
    sources: [...new Set(ids)],
    possibleTransfer: { card: reaper.id, from: reaper.controller, to: destination },
    reasons: [
      'reap-control: supported public event-bound control risk, valued once for the physical reaper; normal reap income retained',
      ...(o.publicStateCoverage?.effectsComplete === false
        ? ['reap-control: incomplete effect state; printed public risk is not a guaranteed transfer']
        : []),
    ],
  };
}
