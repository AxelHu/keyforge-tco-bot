/** Bounded material opportunity after the visible hand becomes available for ordinary plays. */
import type { CardView, Observation, Seat } from '../contracts/observation.js';
import type { PublicCardUseValue } from './card-lifecycle-value.js';
import { publicPlayEndsStep } from './public-card-value.js';
import { projectSequenceResources } from './public-play-sequence.js';
import { publicPlayCapacity } from './public-guidance-guards.js';

export interface HandWindowOptions {
  projected?: boolean;
  /** A witnessed terminal friendly-hand discard may return to the ordinary play step. */
  terminalDiscard?: boolean;
  /** Generic material value already included for each unbound play allowance. */
  playPermissionEstimate?: number;
  /** Enables one visible opener, followed by a fresh joint allocation in its projected state. */
  reprice?: (view: Observation, card: CardView) => PublicCardUseValue | undefined;
}
const board = (o: Observation) => o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
const houses = (c: CardView) => c.effective.houses ?? [c.effective.house];
export function publicArtifactPlayTax(o: Observation, owner: Seat): number {
  return board(o).filter((c) => c.controller !== owner).reduce((n, c) => n + (c.spec.opponentArtifactPlayTax ?? 0), 0);
}
const playCost = (o: Observation, c: CardView) =>
  (c.spec.playAmberCost ?? 0) + (c.spec.kind === 'artifact' ? publicArtifactPlayTax(o, o.you) : 0);

// Unknown instructions might dispatch another ability and leave an unobserved parent frame.
const ordinaryInstructions = new Set(['gain','loseOpponent','steal','capture','draw','healSelf','chains','resource',
  'target','all','self','archiveChoice','randomDiscard','randomArchive','forgeEffect','if','damageChoice',
  'storeAmber','reveal','sacrificeSelf','skipForge','finishAction','lasting','choose','chooseCards','bound']);
function mayCallAbility(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((child) => mayCallAbility(child,depth+1));
  const row = value as Record<string, unknown>;
  if (row.unmodeled || typeof row.kind === 'string' && !ordinaryInstructions.has(row.kind)) return true;
  return Object.entries(row).some(([key,child]) => key !== 'filter' && key !== 'countFilter' && mayCallAbility(child,depth+1));
}

// A copied/use/trigger caller can survive while the printed child is resolving.
function hasUnresolvedCaller(o: Observation): boolean {
  return [...board(o), ...o.players.flatMap((p) => p.discard)].some((x) =>
    x.spec.unmodeled || x.spec.reactions?.length || x.gainedTextBoxes?.length || x.spec.grantsAbilities?.length ||
    x.spec.friendlyPlayAsReap || x.spec.repeatFriendlyCreaturePlay || x.spec.upgrade?.abilities ||
    mayCallAbility(x.spec.abilities) || mayCallAbility(x.spec.afterAttach));
}

function terminalChoice(o: Observation, terminalDiscard = false): boolean {
  const q = o.pending;
  if (!q || q.actor !== o.you || o.turnStep && o.turnStep.step !== 3 || q.reward || o.leaveEffects.length ||
    o.prophecies?.some((p) => p.active)) return false;
  const source = [...board(o), ...o.resolving].find((x) => x.id === q.source);
  if (!source || source.controller !== o.you || source.spec.omega || source.copiedDefinition ||
    source.form || source.gainedTextBoxes?.length || source.spec.conditionalAbilities?.length ||
    source.spec.reactions?.length || o.resolving.some((c) => c.id !== source.id)) return false;
  const abilities = Object.entries(source.spec.abilities ?? {}).filter(([, effects]) => effects?.length);
  if (abilities.length !== 1) return false;
  const [trigger, effects] = abilities[0];
  if (!effects || effects.length !== 1 || 'unmodeled' in effects[0] && effects[0].unmodeled) return false;
  if (trigger === 'play') {
    if (source.spec.kind !== 'action' || o.resolving.length !== 1) return false;
  } else if (trigger === 'reap' || trigger === 'action' || trigger === 'omni') {
    if (o.resolving.length || source.ready || !source.usesThisTurn) return false;
    if (trigger === 'reap' && (source.spec.kind !== 'creature' ||
      o.publicCounters.creaturesUsed.at(-1)?.currentCard !== source.id)) return false;
  } else return false;
  if (hasUnresolvedCaller(o)) return false;
  const effect = effects[0];
  if (effect.kind === 'archiveChoice') return q.kind === 'archive';
  if (q.kind !== 'target' || q.intent?.kind !== 'target-operation' || effect.kind !== 'target' ||
    effect.after || effect.operation !== q.intent.operation) return false;
  if (effect.operation === 'discard' && terminalDiscard) {
    if (source.spec.unmodeled || source.copiedCharacteristics || source.copiedAnimation ||
      source.temporaryAnimation || source.animatedArtifact || source.tokenCreature || source.copiedHouse ||
      Object.keys(effect).some((k) => !['kind','operation','filter','max','optional','label'].includes(k)) ||
      effect.filter?.side !== 'friendly' || effect.filter.zone !== 'hand' ||
      board(o).some((x) => x.spec.firstShadowDiscardSteal || x.spec.upgrade?.discardHandsUnderHost) ||
      o.lasting.some((e) => e.rule === 'archiveAfterDiscard' && e.appliesTo === o.you && e.turn >= o.turn)) return false;
    const me = o.players[o.you];
    // Probe both sides of the candidate: a virtually discarded card may already be in discard.
    const known = new Map([...(me.hand ?? []), ...me.discard].map((c) => [c.id,c]));
    const ids = [...(q.selected ?? []), ...o.legalActions.flatMap(({action:a}) => a.kind === 'select' ? [a.target] : [])];
    if (!ids.length || q.selectedCount !== undefined && q.selectedCount !== (q.selected?.length ?? 0) ||
      ids.some((id) => {
        const c = known.get(id);
        return !c || c.owner !== o.you || c.spec.unmodeled || c.gainedTextBoxes?.length ||
          c.copiedDefinition || c.form || c.spec.conditionalAbilities?.length || c.spec.abilities?.scrap?.length;
      })) return false;
  } else if (!['archive', 'returnHand'].includes(effect.operation)) return false;
  const selection = q.intent.selection;
  return (!selection || selection.ability === trigger && selection.path.length === 1 && selection.path[0] === 0) &&
    (q.max ?? 1) <= (effect.max ?? 1);
}

// Later cards were priced against the same public table. A play that changes a
// permission, closes a play window, or spends a shared target/pool can only be
// the final priced card without repricing the remainder in its new state.
function changesFollowingPlay(card: CardView): boolean {
  const d = card.spec;
  if (d.onePlayPerType || d.prohibitOwnCreatures || d.noPlayCreaturesWhileAhead ||
    d.creaturePlayLimits?.length || d.forbidMorePowerfulCreaturePlay || d.grantsEnemyOmega ||
    d.entersOpponentControl && (d.playLimitOpponent !== undefined || d.opponentArtifactPlayTax)) return true;
  const changes = (value: unknown, depth = 0): boolean => {
    if (depth > 12) return true;
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some((x) => changes(x,depth+1));
    const row = value as Record<string,unknown>;
    if (row.kind === 'lasting' && row.side !== 'opponent' &&
      ['noPlay','noActions','noCreatures','noMatchingPlay','onlyPlayHouse','noNamedPlayUse','playLimit'].includes(String(row.rule))) return true;
    if (row.kind === 'steal' || row.kind === 'capture' || row.kind === 'loseOpponent' ||
      row.kind === 'payOpponent' || row.kind === 'loseThen' || row.kind === 'forgeEffect' ||
      row.kind === 'resource' && (row.operation === 'lose' || row.operation === 'steal')) return true;
    if (['destroy','sacrifice','purge','discard','returnHand','archive','foreignArchive','deckTop','deckBottom',
      'shuffleDeck','shuffleIntoDeck'].includes(String(row.operation))) return true;
    return Object.values(row).some((x) => changes(x,depth+1));
  };
  return changes(d.abilities?.play);
}

function windowOpen(o: Observation, terminalDiscard = false): boolean {
  return o.you === o.activePlayer && !!o.activeHouse && !o.turnStep?.omega &&
    (o.phase === 'main' || o.phase === 'archives' || o.phase === 'choice' && terminalChoice(o, terminalDiscard));
}

function routes(o: Observation, c: CardView, projected: boolean): (number | undefined)[] {
  const held = o.players[o.you].hand?.some((x) => x.id === c.id);
  if (!projected && held && o.phase === 'main')
    return o.legalActions.flatMap(({ action: a }) =>
      a.kind === 'play' && a.card === c.id && !a.copy && !a.otherHalf && !a.asUpgrade ? [a.permission] : []);
  const d = c.spec, me = o.players[o.you], enemy = o.players[o.you === 0 ? 1 : 0];
  const table = board(o);
  if (d.cannotPlay || d.playCondition || d.unmodeled || d.mimicCreature || d.mimicAction ||
    c.copiedDefinition || c.copiedHouse || c.copiedCharacteristics || c.copiedAnimation || c.temporaryAnimation ||
    c.animatedArtifact || c.form || c.copiedForm || c.tokenCreature || c.definition !== d.id || c.gainedTextBoxes?.length ||
    c.giganticBonusIcons || (c.physicalParts?.length ?? 0) > 1 ||
    d.alpha && (o.turnStep?.performed[o.you] ?? o.handOperations) > 0 ||
    me.amber < Math.max(d.minAmberToPlay ?? 0, playCost(o, c)) || (o.turnUsage[d.name] ?? 0) >= 6) return [];
  if (d.kind === 'upgrade' && !table.some((x) => x.spec.kind === (d.upgrade?.attachToArtifact ? 'artifact' : 'creature'))) return [];
  if (table.some((x) => x.spec.unmodeled || x.spec.onePlayPerType || x.gainedTextBoxes?.length ||
    d.kind === 'creature' && (x.spec.creaturePlayLimits?.length || x.spec.forbidMorePowerfulCreaturePlay ||
      x.spec.upgrade?.hostForbidMorePowerfulEnemyPlay || x.controller === o.you && x.spec.prohibitOwnCreatures ||
      x.spec.noPlayCreaturesWhileAhead && me.battleline.length > enemy.battleline.length ||
      x.controller !== o.you && x.spec.forbidsEnemyRightFlankPlay && !d.entersOpponentControl && !me.battleline.length))) return [];
  for (const e of o.lasting) {
    if (e.rule === 'noNamedPlayUse' && e.turn >= o.turn && e.affectedName === d.name) return [];
    if (e.appliesTo !== o.you || (e.begins ?? o.turn) > o.turn || e.turn < o.turn) continue;
    if (e.rule === 'noPlay' || e.rule === 'noActions' && d.kind === 'action' ||
      e.rule === 'noCreatures' && d.kind === 'creature' || e.rule === 'onlyPlayHouse' && e.house !== d.house ||
      e.rule === 'noMatchingPlay' && e.countFilter?.kind === d.kind && (!e.house || houses(c).includes(e.house))) return [];
  }
  const normal = houses(c).includes(o.activeHouse!) && (o.turn !== 1 || o.handOperations < 1);
  const matches = o.permissions.filter((p) => {
    if (p.mode !== 'play' && p.mode !== 'playOrUse' || p.remaining === 0 ||
      p.uniqueRemaining === 0 && !p.used.includes(c.id) || p.bound && (projected || !held || !p.bound.includes(c.id))) return false;
    const f = p.filter;
    if (p.id < 0) {
      // Referee-generated negative IDs represent live permissions from permanents.
      const source = table.find((x) => x.id === p.source && x.controller === o.you);
      if (!source || p.id <= -50000 && o.turn === 1 && o.handOperations >= 1) return false;
      if (f.notHouse && !(me.battleline.length % 2 && me.battleline[Math.floor(me.battleline.length / 2)].id === source.id))
        return false;
    }
    return Object.keys(f).every((k) => ['side','zone','kind','house','notHouse','name','trait'].includes(k)) &&
      f.side !== 'enemy' && (!f.kind || f.kind === d.kind) && (!f.house || houses(c).some((h) => h === f.house)) &&
      (!f.notHouse || f.notHouse !== 'chosenHouse' && !houses(c).some((h) => h === f.notHouse)) &&
      (!f.name || f.name === d.name) && (!f.trait || d.traits?.includes(f.trait));
  });
  const finite = matches.filter((p) => p.remaining !== null);
  return finite.length ? finite.map((p) => p.id) : normal ? [undefined] : matches.map((p) => p.id);
}

/** A material allocation is meaningful only in a publicly established ordinary play window. */
export function publicHandWindowAvailable(o: Observation,
  options: Pick<HandWindowOptions,'terminalDiscard'> = {}): boolean {
  const cap = publicPlayCapacity(o);
  return cap.known && !cap.blocked && windowOpen(o,options.terminalDiscard);
}

const keyPriorityValue = 160;

export function publicHandCardPlayable(o: Observation, c: CardView, options: HandWindowOptions): boolean {
  return c.owner === o.you && publicHandWindowAvailable(o, options) && routes(o, c, !!options.projected).length > 0;
}

function allocateWindow(o: Observation, cards: readonly CardView[],
  useValue: (card: CardView) => PublicCardUseValue | undefined, options: HandWindowOptions = {},
  onAllocation?: (permissions: ReadonlyMap<number,number>) => void, priorKeyPriority = false) {
  const empty = { score: 0, selectedIds: [] as string[], keyPriorityUsed: false, approximate: true, reasons: [] as string[] };
  const cap = publicPlayCapacity(o);
  if (!windowOpen(o, options.terminalDiscard) || !cap.known || cap.blocked) return empty;
  const unique = new Map(cards.map((c) => [c.id, c]));
  const rows = [...unique.values()].flatMap((card) => {
    if (card.owner !== o.you) return [];
    const ways = [...new Set(routes(o, card, !!options.projected))];
    if (!ways.length) return [];
    const use = useValue(card);
    if (!use?.playableNow || !Number.isFinite(use.currentScore) || !Number.isFinite(use.score) ||
      Math.abs(use.currentScore!) >= 5000 || Math.abs(use.score) >= 5000) return [];
    let current = use.currentScore!;
    if (options.playPermissionEstimate) {
      const grants = card.spec.abilities?.play?.filter((e) => e.kind === 'permission') ?? [];
      // A pure play allowance has no independent immediate material value when this static
      // allocation never grants it. A separately repriced opener can realize its payoff.
      if (grants.length && grants.every((g) => g.mode === 'play') && ways.some((id) =>
        projectPublicPlaySequenceOpener(o,card,id,'left',!!options.projected,true)))
        current -= grants.length * options.playPermissionEstimate;
    }
    const premium = Math.max(0, current - Math.max(0, use.score) / 2);
    const cost = playCost(o, card);
    const last = publicPlayEndsStep(o, card) || changesFollowingPlay(card);
    const keyPriority = !!use.currentKeyPriority && !priorKeyPriority;
    return premium > 0 || keyPriority ? [{ card, ways, premium, cost, last, keyPriority }] : [];
  });
  // Alpha first, Omega last; among ordinary cards pay stricter pre-payment thresholds first.
  rows.sort((a,b) => Number(!!b.card.spec.alpha) - Number(!!a.card.spec.alpha) ||
    Number(b.keyPriority) - Number(a.keyPriority) || Number(a.last) - Number(b.last) ||
    (o.turn === 1 ? Number(b.ways.includes(undefined)) - Number(a.ways.includes(undefined)) : 0) ||
    Math.max(0,(b.card.spec.minAmberToPlay ?? 0)-b.cost) - Math.max(0,(a.card.spec.minAmberToPlay ?? 0)-a.cost) ||
    Number(houses(a.card).includes(o.activeHouse!)) - Number(houses(b.card).includes(o.activeHouse!)) ||
    b.premium - a.premium || a.card.id.localeCompare(b.card.id));
  const initial = { score: 0, ids: [] as string[], keyPriorityUsed:false, amber: o.players[o.you].amber, closed: false,
    names: new Map<string,number>(), permissions: new Map<number,number>(), uniques: new Map<number,number>() };
  let states = [initial];
  let prioritiesRemaining = rows.filter((row) => row.keyPriority).length;
  for (const { card, ways, premium, cost, last, keyPriority } of rows) {
    if (keyPriority) prioritiesRemaining--;
    const next = [...states];
    for (const s of states) {
      // The proof belongs to this priced observation, before any unmodeled earlier play.
      // A modeled funding/permission opener reprices a separate tail in its resulting state.
      const freshPriority = keyPriority && !s.ids.length;
      if (!premium && !freshPriority || s.closed || s.ids.length >= (cap.remaining ?? Infinity) || card.spec.alpha && s.ids.length ||
        s.amber < Math.max(cost, card.spec.minAmberToPlay ?? 0)) continue;
      const name = card.spec.name, count = s.names.get(name) ?? o.turnUsage[name] ?? 0;
      if (count >= 6) continue;
      // A qualifying finite allowance is mandatory while available. Once all
      // matching finite allowances are exhausted an ordinary house play reopens.
      const finite = ways.flatMap((id) => o.permissions.filter((p) => p.id === id && p.remaining !== null));
      const normalReopens = finite.length && houses(card).includes(o.activeHouse!) && finite.every((p) =>
        (s.permissions.get(p.id) ?? 0) >= p.remaining! ||
        !p.used.includes(card.id) && (s.uniques.get(p.id) ?? 0) >= (p.uniqueRemaining ?? Infinity));
      const available = normalReopens ? [...ways, undefined] : ways;
      for (const id of available) {
        if ((id === undefined || id <= -50000) && o.turn === 1 && o.handOperations + s.ids.length >= 1) continue;
        const permit = o.permissions.find((p) => p.id === id);
        if (id !== undefined && !permit) continue;
        if (permit && permit.id < 0 && permit.filter.notHouse && s.ids.some((prior) =>
          unique.get(prior)?.spec.kind === 'creature')) continue;
        const uses = id === undefined ? 0 : s.permissions.get(id) ?? 0;
        const uniques = id === undefined ? 0 : s.uniques.get(id) ?? 0;
        const newUnique = !!permit && !permit.used.includes(card.id);
        if (permit && (uses >= (permit.remaining ?? Infinity) || newUnique && uniques >= (permit.uniqueRemaining ?? Infinity))) continue;
        const successor = { score: s.score + premium + (freshPriority ? keyPriorityValue : 0),
          keyPriorityUsed: s.keyPriorityUsed || freshPriority, ids: [...s.ids,card.id], amber: s.amber - cost, closed: last,
          names: new Map(s.names).set(name,count+1), permissions: new Map(s.permissions), uniques: new Map(s.uniques) };
        if (id !== undefined) {
          successor.permissions.set(id,uses+1);
          successor.uniques.set(id,uniques+Number(newUnique));
        }
        next.push(successor);
      }
    }
    // Beam size bounds work even for exceptionally large public hands.
    states = next.sort((a,b) => b.score-a.score || b.amber-a.amber || a.ids.length-b.ids.length).slice(0,48);
    // Keep the option to spend the entire remaining budget on a later key response,
    // even if 48 earlier ordinary combinations all used the only permitted play.
    if (prioritiesRemaining && states.length === 48 && !states.includes(initial)) states[47] = initial;
  }
  const best = states[0];
  onAllocation?.(best.permissions);
  return { ...empty, score: best.score, selectedIds: best.ids, keyPriorityUsed: best.keyPriorityUsed, reasons: best.ids.length ?
    ['shared current play opportunity for ' + best.ids.join(', ')] : [] };
}

// After-play formula views leave the selected action in resolving, even after its one
// terminal recovery has moved the cards. Complete only this witnessed native Play.
function finishProjectedRecovery(o: Observation): Observation | undefined {
  const [source] = o.resolving, you = o.you;
  if (o.resolving.length !== 1 || o.pending || o.phase !== 'main' || o.turnStep?.step !== 3 ||
    !o.turnStep.performed[you] || !o.playedThisTurn || !o.handOperations ||
    !source || source.owner !== you || source.controller !== you || !o.turnUsage[source.spec.name] ||
    source.spec.kind !== 'action' || source.spec.omega || source.spec.unmodeled || source.spec.retainedUpgrade ||
    source.spec.conditionalAbilities?.length || source.spec.reactions?.length || source.spec.grantsAbilities?.length ||
    source.definition !== source.spec.id || source.copiedDefinition || source.copiedHouse || source.form ||
    source.copiedForm || source.copiedCharacteristics || source.copiedAnimation || source.temporaryAnimation ||
    source.animatedArtifact || source.tokenCreature || source.physicalParts || source.gainedTextBoxes?.length ||
    source.giganticBonusIcons || (source.resolvedBonusIcons ?? source.bonusIcons ?? []).some((icon) => icon !== 'amber') ||
    !o.legalActions.some(({action:a}) => a.kind === 'play' && a.card === source.id && !a.copy &&
      !a.asUpgrade && !a.otherHalf && !a.entryOverride) || hasUnresolvedCaller(o)) return;
  const effects = source.spec.abilities?.play;
  if (Object.values(source.spec.abilities ?? {}).filter((es) => es?.length).length !== 1 ||
    effects?.length !== 1) return;
  const e = effects[0];
  if (e.kind !== 'target' || e.operation !== 'returnHand' || e.filter?.side !== 'friendly' ||
    e.filter.zone !== 'discard' || Object.keys(e).some((k) =>
      !['kind','operation','filter','max','optional','label'].includes(k))) return;
  const players = [...o.players] as Observation['players'];
  players[you] = { ...players[you], discard: [...players[you].discard,source] };
  return { ...o, players, resolving: [] };
}

/** A projected observation is never an executable action. Native callers must supply the actual ordinary play route. */
export function projectPublicPlaySequenceOpener(o: Observation, card: CardView, permission?: number,
  flank: 'left' | 'right' = 'left', projected = false, includeUnconsumedPermission = false): Observation | undefined {
  if (!windowOpen(o, true)) return;
  if (o.phase === 'main' && o.resolving.length) {
    const after = projected && finishProjectedRecovery(o);
    if (!after) return;
    o = after;
  }
  const cap = publicPlayCapacity(o);
  const grants = includeUnconsumedPermission ? card.spec.abilities?.play?.filter((e) => e.kind === 'permission') : undefined;
  const settleGrant = !!grants?.length && grants.every((e) => e.mode === 'play');
  const endsStep = publicPlayEndsStep(o, card);
  if (endsStep && !settleGrant || !cap.known || cap.blocked || cap.remaining === 1 && !settleGrant ||
    !routes(o, card, projected).includes(permission)) return;
  if (!projected && (o.phase !== 'main' || !o.legalActions.some(({action:a}) =>
    a.kind === 'play' && a.card === card.id && a.permission === permission && !a.copy && !a.asUpgrade &&
    !a.otherHalf && !a.entryOverride && a.position === undefined && (!a.flank || a.flank === flank)))) return;
  const tax = publicArtifactPlayTax(o, o.you);
  const next = projectSequenceResources(o, card, tax, permission, flank, !!settleGrant);
  if (!next) return;
  // The grant resolves before Omega closes the step, leaving no ordinary play to spend it on.
  if (endsStep) return { ...next, turnStep: { ...next.turnStep!, omega:true } };
  if (settleGrant) return next;
  const originalIds = new Set(o.permissions.map((p) => p.id));
  let sharedCost = 0;
  for (const other of next.players[o.you].hand ?? []) {
    if (other.owner !== o.you) continue;
    const ways = routes(next,other,true);
    if (!ways.length) continue;
    if (ways.some((id) => id !== undefined && !originalIds.has(id))) return next;
    if (next.players[o.you].amber <= o.players[o.you].amber) continue;
    sharedCost += (other.spec.playAmberCost ?? 0) + (other.spec.kind === 'artifact' ? tax : 0);
    if (sharedCost > o.players[o.you].amber || (other.spec.minAmberToPlay ?? 0) > o.players[o.you].amber) return next;
  }
  return;
}

export function assessPublicHandWindow(o: Observation, cards: readonly CardView[],
  useValue: (card: CardView) => PublicCardUseValue | undefined, options: HandWindowOptions = {}) {
  const baseline = allocateWindow(o, cards, useValue, options);
  const reprice = options.reprice;
  if (!reprice || cards.length < 2 || cards.length > 12 || !windowOpen(o, options.terminalDiscard)) return baseline;
  const unique = [...new Map(cards.map((c) => [c.id,c])).values()].sort((a,b) => a.id.localeCompare(b.id));
  const cardIds = new Set(unique.map((c) => c.id));
  let best = baseline, projections = 0, routesChecked = 0;
  for (const card of unique) {
    for (const permission of new Set(routes(o,card,!!options.projected))) {
      if (++routesChecked > 24) return best;
      const next = projectPublicPlaySequenceOpener(o,card,permission,'left',!!options.projected);
      if (!next) continue;
      // At most 4 successors, each with at most 11 fresh material estimates.
      if (++projections > 4) return best;
      const use = useValue(card);
      if (!use?.playableNow || !Number.isFinite(use.currentScore) || !Number.isFinite(use.score) ||
        Math.abs(use.currentScore!) >= 5000 || Math.abs(use.score) >= 5000) continue;
      const remaining = next.players[o.you].hand!.filter((c) => cardIds.has(c.id));
      const granted = next.permissions.slice(o.permissions.length);
      const pure = granted.every((p) => p.mode === 'play');
      let grantCount = 0;
      const tail = allocateWindow(next, remaining, (c) => reprice(next,c),
        { projected:true, playPermissionEstimate:options.playPermissionEstimate }, (used) => {
          // An unused play-or-use allowance can still be spent on the board. Consuming
          // it for a priced hand play removes its generic estimate just once per grant.
          grantCount = granted.filter((p) => pure || used.has(p.id)).length;
        }, !!use.currentKeyPriority);
      const score = use.currentScore! - Math.max(0,use.score) / 2 + tail.score -
        grantCount * (options.playPermissionEstimate ?? 0) + (use.currentKeyPriority ? keyPriorityValue : 0);
      if (tail.selectedIds.length && score > best.score) {
        const ids = [card.id,...tail.selectedIds];
        best = { score, selectedIds: ids, keyPriorityUsed: !!use.currentKeyPriority || tail.keyPriorityUsed, approximate: true,
          reasons: ['shared current play opportunity after ' + card.id + ' funds or permits ' + tail.selectedIds.join(', ')] };
      }
    }
  }
  return best;
}
