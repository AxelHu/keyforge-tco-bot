/** Bounded material opportunity after the visible hand becomes available for ordinary plays. */
import type { CardView, Observation, Seat } from '../contracts/observation.js';
import type { PublicCardUseValue } from './card-lifecycle-value.js';
import { publicPlayEndsStep } from './public-card-value.js';
import { publicPlayCapacity } from './public-guidance-guards.js';

export interface HandWindowOptions { projected?: boolean }
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

function terminalChoice(o: Observation): boolean {
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
  // A copied/use/trigger caller can survive while the printed child is resolving.
  if ([...board(o), ...o.players.flatMap((p) => p.discard)].some((x) =>
    x.spec.unmodeled || x.spec.reactions?.length || x.gainedTextBoxes?.length || x.spec.grantsAbilities?.length ||
    x.spec.friendlyPlayAsReap || x.spec.repeatFriendlyCreaturePlay || x.spec.upgrade?.abilities ||
    mayCallAbility(x.spec.abilities) || mayCallAbility(x.spec.afterAttach))) return false;
  const effect = effects[0];
  if (effect.kind === 'archiveChoice') return q.kind === 'archive';
  if (q.kind !== 'target' || q.intent?.kind !== 'target-operation' || effect.kind !== 'target' ||
    effect.after || effect.operation !== q.intent.operation || !['archive', 'returnHand'].includes(effect.operation)) return false;
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

function windowOpen(o: Observation): boolean {
  return o.you === o.activePlayer && !!o.activeHouse && !o.turnStep?.omega &&
    (o.phase === 'main' || o.phase === 'archives' || o.phase === 'choice' && terminalChoice(o));
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

export function publicHandCardPlayable(o: Observation, c: CardView, options: HandWindowOptions): boolean {
  const cap = publicPlayCapacity(o);
  return c.owner === o.you && windowOpen(o) && cap.known && !cap.blocked && routes(o, c, !!options.projected).length > 0;
}

export function assessPublicHandWindow(o: Observation, cards: readonly CardView[],
  useValue: (card: CardView) => PublicCardUseValue | undefined, options: HandWindowOptions = {}) {
  const empty = { score: 0, selectedIds: [] as string[], approximate: true, reasons: [] as string[] };
  const cap = publicPlayCapacity(o);
  if (!windowOpen(o) || !cap.known || cap.blocked) return empty;
  const unique = new Map(cards.map((c) => [c.id, c]));
  const rows = [...unique.values()].flatMap((card) => {
    if (card.owner !== o.you) return [];
    const ways = [...new Set(routes(o, card, !!options.projected))];
    if (!ways.length) return [];
    const use = useValue(card);
    if (!use?.playableNow || !Number.isFinite(use.currentScore) || !Number.isFinite(use.score) ||
      Math.abs(use.currentScore!) >= 5000 || Math.abs(use.score) >= 5000) return [];
    const premium = Math.max(0, use.currentScore! - Math.max(0, use.score) / 2);
    const cost = playCost(o, card);
    const last = publicPlayEndsStep(o, card) || changesFollowingPlay(card);
    return premium > 0 ? [{ card, ways, premium, cost, last }] : [];
  });
  // Alpha first, Omega last; among ordinary cards pay stricter pre-payment thresholds first.
  rows.sort((a,b) => Number(!!b.card.spec.alpha) - Number(!!a.card.spec.alpha) ||
    Number(a.last) - Number(b.last) ||
    (o.turn === 1 ? Number(b.ways.includes(undefined)) - Number(a.ways.includes(undefined)) : 0) ||
    Math.max(0,(b.card.spec.minAmberToPlay ?? 0)-b.cost) - Math.max(0,(a.card.spec.minAmberToPlay ?? 0)-a.cost) ||
    Number(houses(a.card).includes(o.activeHouse!)) - Number(houses(b.card).includes(o.activeHouse!)) ||
    b.premium - a.premium || a.card.id.localeCompare(b.card.id));
  const initial = { score: 0, ids: [] as string[], amber: o.players[o.you].amber, closed: false,
    names: new Map<string,number>(), permissions: new Map<number,number>(), uniques: new Map<number,number>() };
  let states = [initial];
  for (const { card, ways, premium, cost, last } of rows) {
    const next = [...states];
    for (const s of states) {
      if (s.closed || s.ids.length >= (cap.remaining ?? Infinity) || card.spec.alpha && s.ids.length ||
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
        const successor = { score: s.score + premium, ids: [...s.ids,card.id], amber: s.amber - cost, closed: last,
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
  }
  const best = states[0];
  return { ...empty, score: best.score, selectedIds: best.ids, reasons: best.ids.length ?
    ['shared current play opportunity for ' + best.ids.join(', ')] : [] };
}
