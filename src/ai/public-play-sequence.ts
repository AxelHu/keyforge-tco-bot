/** Model one ordinary, fully visible play that can fund or authorize another known hand card. */
import type { CardView, Effect, Observation, PermissionView } from '../contracts/observation.js';

const scalar = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const simpleFields = new Set(['id', 'name', 'number', 'house', 'kind', 'power', 'armor', 'amber', 'traits',
  'summary', 'variant', 'keywords', 'assault', 'hazardous', 'splashAttack', 'alpha', 'omega',
  'playAmberCost', 'minAmberToPlay', 'abilities', 'ruleInterpretations', 'summaryFeatures']);
const plainEntry = (c: CardView) => Object.keys(c.spec).every((key) => simpleFields.has(key) ||
  key === 'opponentArtifactPlayTax' || key === 'grantsEnemyOmega');
const permittedRules = new Set(['playLimit', 'noPlay', 'noActions', 'noCreatures', 'onlyPlayHouse',
  'noNamedPlayUse', 'noMatchingPlay', 'keyCost', 'noFight', 'noUse', 'noReap']);
// These schedules and named locks have no corresponding per-source public observation field.
function hasUnrepresentedRule(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object') return false;
  if (depth > 16) return true;
  const row = value as Record<string,unknown>;
  return ['chooseForbiddenName','forbidName','scheduleActionReturn'].includes(String(row.kind)) ||
    Object.values(row).some((x) => hasUnrepresentedRule(x,depth + 1));
}
const playEvents = new Set(['cardPlayed','creaturePlayed','creatureEntered','artifactPlayed',
  'actionBeforePlay','actionPlacedAfterPlay','bonusResolved']);

export function simplePlayFilter(filter: PermissionView['filter']): boolean {
  return Object.keys(filter).every((k) => ['side','zone','kind','house','notHouse','name','trait'].includes(k)) &&
    filter.house !== 'chosenHouse' && filter.notHouse !== 'chosenHouse';
}

type Grant = Extract<Effect, {kind: 'permission'}> & {limit?: number; uniqueLimit?: number; bound?: string};
function readGrant(e: Grant, id: number, source: string): PermissionView | undefined {
  if (!['play','playOrUse'].includes(e.mode) || !simplePlayFilter(e.filter) || e.bound !== undefined ||
    Object.keys(e).some((k) => !['kind','mode','filter','limit','uniqueLimit'].includes(k)) ||
    e.limit !== undefined && (!scalar(e.limit) || e.limit === 0) ||
    e.uniqueLimit !== undefined && (!scalar(e.uniqueLimit) || e.uniqueLimit === 0)) return;
  return { id, source, mode: e.mode, filter: e.filter, remaining: e.limit ?? null,
    uniqueRemaining: e.uniqueLimit ?? null, used: [], bound: null };
}

/** The caller validates the precise play route and the presence of a subsequent play window. */
export function projectSequenceResources(o: Observation, card: CardView, tax: number,
  permission?: number, flank: 'left' | 'right' = 'left', settleGrant = false): Observation | undefined {
  const you = o.you, them = you === 0 ? 1 : 0, me = o.players[you], d = card.spec;
  const hand = me.hand;
  if (!hand || hand.length !== me.handCount || !settleGrant && hand.length < 2 || hand.length > 12 ||
    new Set(hand.map((c) => c.id)).size !== hand.length || !hand.some((x) => x.id === card.id) ||
    !plainEntry(card) || d.kind === 'upgrade' || card.owner !== you || card.controller !== you ||
    card.definition !== d.id || card.form || card.copiedForm || card.copiedDefinition || card.copiedHouse ||
    card.copiedCharacteristics || card.copiedAnimation || card.temporaryAnimation || card.animatedArtifact ||
    card.tokenCreature || card.physicalParts || card.gainedTextBoxes?.length || card.giganticBonusIcons ||
    card.copiedBonusIcons || card.copiedBonusHouses || !scalar(d.amber) || !scalar(tax) ||
    !scalar(d.playAmberCost ?? 0) || !scalar(d.minAmberToPlay ?? 0)) return;
  const cost = (d.playAmberCost ?? 0) + (d.kind === 'artifact' ? tax : 0);
  if (me.amber < Math.max(cost, d.minAmberToPlay ?? 0)) return;
  const icons = card.resolvedBonusIcons ?? card.bonusIcons;
  if (icons?.some((i) => i !== 'amber')) return;
  let income = icons?.length ?? d.amber;
  const grants: PermissionView[] = [];
  for (const e of d.abilities?.play ?? []) {
    if (e.kind === 'gain' && scalar(e.amount) && Object.keys(e).every((k) => k === 'kind' || k === 'amount'))
      income += e.amount;
    else if (e.kind === 'resource' && e.operation === 'gain' && (!e.side || e.side === 'self') && scalar(e.amount) &&
      Object.keys(e).every((k) => ['kind','operation','amount','side'].includes(k))) income += e.amount;
    else if (e.kind === 'permission') {
      const next = o.permissions.reduce((n,p) => Math.max(n,p.id + 1), 0) + grants.length;
      const grant = readGrant(e, next, card.id);
      if (!grant) return;
      grants.push(grant);
    } else return;
  }
  const rest = hand.filter((x) => x.id !== card.id);
  const needsFunding = rest.reduce((sum,c) => sum + (c.spec.playAmberCost ?? 0) +
    (c.spec.kind === 'artifact' ? tax : 0), 0) > me.amber || rest.some((c) => (c.spec.minAmberToPlay ?? 0) > me.amber);
  if (!(needsFunding && income > cost) && !grants.length) return;

  const board = o.players.flatMap((p) => [...p.battleline, ...p.artifacts, ...p.upgrades]);
  if ([...board, ...o.resolving, ...o.players.flatMap((p) => p.discard)].some((c) =>
    hasUnrepresentedRule(c.spec.abilities)) || o.cardEffects?.length || o.prophecies?.some((p) => p.active) || o.leaveEffects.length ||
    o.nextCreatureEntries?.length || o.lasting.some((e) => (e.begins ?? o.turn) <= o.turn &&
      e.turn >= o.turn && (!permittedRules.has(e.rule) || e.keyTaxValue || e.countFilter && e.rule === 'keyCost')) ||
    o.permissions.some((p) => (p.mode === 'play' || p.mode === 'playOrUse') && p.remaining !== 0 &&
      (p.bound || !simplePlayFilter(p.filter)))) return;
  // Complex entry modifiers can invalidate the projected position, ready state, or surviving table.
  // An ordinary action leaves that table in place; still reject all play/income replacements.
  if (board.some((c) => {
    const b = c.spec;
    return d.kind !== 'action' && !plainEntry(c) || b.unmodeled || c.gainedTextBoxes?.length ||
      b.reactions?.some((r) => playEvents.has(r.event)) || b.grantsAbilities?.length || b.conditionalAbilities?.length ||
      b.replacesEnemyActionPlayWithOwnLeftDestruction || b.capturesIncomingAmber || b.bonusReplacements?.length ||
      b.opponentPoolForgeLimit || b.forgeRestrictions?.length || b.friendlyAmberSpendCondition || b.keyTaxes?.some((t) => t.condition || typeof t.amount !== 'number');
  })) return;
  if (board.some((c) => c.controller === them && c.spec.blocksOpponentBonusIcons)) income -= icons?.length ?? d.amber;
  if (!(needsFunding && income > cost) && !grants.length) return;
  const delta = income - cost, transfer = d.kind === 'artifact' ? tax : 0;
  const players = o.players.map((p,s) => {
    const change = s === you ? delta : transfer;
    return { ...p, amber: p.amber + change, forgeAvailable: p.forgeAvailable + change,
      ...(p.forgeSources ? { forgeSources: { ...p.forgeSources, pool: p.amber + change } } : {}) };
  }) as Observation['players'];
  const own = players[you];
  own.hand = rest;
  own.handCount--;
  // The qualified terminal recovery action also finishes before another normal play can occur.
  const finished = o.phase === 'choice' ? o.resolving : [];
  if (finished.some((c) => c.spec.kind !== 'action' || c.owner !== you || c.spec.retainedUpgrade)) return;
  own.discard = [...own.discard, ...finished];
  const played = { ...card, ready: false, usesThisTurn: 0 };
  if (d.kind === 'action') own.discard.push(played);
  else if (d.kind === 'artifact') own.artifacts = [...own.artifacts, played];
  else own.battleline = flank === 'left' ? [played, ...own.battleline] : [...own.battleline, played];
  // Avoid carrying a stale haunted-dependent board/forge state across the threshold.
  if (o.haunted && !o.haunted[you] && (own.discard.length >= 10 || board.some((c) => c.spec.hauntedWithPurged) &&
    own.discard.length + own.purged.length >= 10)) return;
  const playedByHouse = { ...o.publicCounters.playedByHouse };
  for (const h of new Set(card.effective.houses ?? [card.effective.house])) playedByHouse[h] = (playedByHouse[h] ?? 0) + 1;
  const playedTypes = o.playedTypes && [...o.playedTypes] as Observation['playedTypes'];
  if (playedTypes) playedTypes[you] = { ...playedTypes[you], [d.kind]: (playedTypes[you][d.kind] ?? 0) + 1 };
  const performed: [number,number] = o.turnStep ? [...o.turnStep.performed] : [0,0];
  performed[you] += 1;
  return { ...o, players, phase: 'main', pending: null, resolving: [], promptCards: [], legalActions: [],
    handOperations: o.handOperations + 1, playedThisTurn: o.playedThisTurn + 1, playedTypes,
    creaturesPlayedThisTurn: o.creaturesPlayedThisTurn + Number(d.kind === 'creature'),
    turnUsage: { ...o.turnUsage, [d.name]: (o.turnUsage[d.name] ?? 0) + 1 },
    turnStep: { step: 3, omega: false, performed }, publicCounters: { ...o.publicCounters, playedByHouse },
    permissions: [...o.permissions.map((p) => p.id !== permission ? p : { ...p,
      remaining: p.remaining === null ? null : p.remaining - 1,
      uniqueRemaining: p.uniqueRemaining === null ? null : p.uniqueRemaining - Number(!p.used.includes(card.id)),
      used: p.used.includes(card.id) ? p.used : [...p.used, card.id] }), ...grants] };
}
