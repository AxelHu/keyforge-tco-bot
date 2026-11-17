import test from 'node:test';
import assert from 'node:assert/strict';
import { projectKeytekiState } from '../../dist/src/adapters/keyteki.js';
import { ALL_DEFINITIONS } from '../../dist/src/knowledge/catalog.js';
import { assessPublicOperation, assessPublicOperationGroup } from '../../dist/src/ai/public-card-value.js';
import { publicCardLocation, assessCardLifecycle, assessLifecycleRefillDelta } from '../../dist/src/ai/card-lifecycle-value.js';

function observation() {
  const player = (name) => ({ name, houses: ['untamed', 'logos', 'brobnar'], activePlayer: name === 'alpha',
    activeHouse: 'untamed', phase: 'main', optionSettings: { confirmOneClick: true },
    stats: { amber: 0, chains: 0, keys: { red: false, blue: false, yellow: false }, keyCost: 6 },
    cardPiles: { hand: [], archives: [], discard: [], purged: [], cardsInPlay: [] },
    numDeckCards: 30, numArchivesCards: 0, buttons: [], controls: [] });
  const o = projectKeytekiState({ id: 'lifecycle-module-fixture', started: true, manualMode: false,
    players: { alpha: player('alpha'), beta: player('beta') }, messages: [] },
    { playerName: 'alpha', revision: 1, turn: 3 }).observation;
  delete o.publicStateCoverage;
  o.phase = 'main'; o.activeHouse = 'untamed'; o.pending = null; o.legalActions = [];
  o.players[0].hand = []; o.players[0].archives = [];
  return o;
}
function card(id, name = 'key-charge', owner = 0, extra = {}) {
  const spec = structuredClone(ALL_DEFINITIONS[name]); assert.ok(spec, name);
  return { id, definition: name, owner, controller: owner, spec,
    ready: true, damage: 0, armorUsed: 0, elusiveUsed: false, captured: 0, stunned: false,
    warded: false, powerCounters: 0, attachedTo: null, enteredController: owner,
    foreignArchiveHolder: null, printedHouse: spec.house, usesThisTurn: 0,
    effective: { house: spec.house, power: spec.power, armor: spec.armor, keywords: [], assault: 0, hazardous: 0 }, ...extra };
}
function put(o, c, zone, seat = c.owner) {
  for (const p of o.players) for (const z of ['hand', 'archives', 'discard', 'purged', 'battleline', 'artifacts', 'upgrades'])
    if (p[z]) p[z] = p[z].filter((x) => x.id !== c.id);
  o.resolving = o.resolving.filter((x) => x.id !== c.id);
  if (zone === 'resolving') o.resolving.push(c);
  else { o.players[seat][zone] ??= []; o.players[seat][zone].push(c); }
  for (const p of o.players) { if (p.hand) p.handCount = p.hand.length; if (p.archives) p.archiveCount = p.archives.length; }
  return c;
}
const quality = (score = 12, playableNow = true, currentScore = score) =>
  ({ useValue: () => ({ score, playableNow, currentScore, approximate: false }) });
const assess = (o, c, op, lifecycle = quality()) => {
  const original = structuredClone(o);
  const r = assessPublicOperation(o, c, op, 0, { lifecycle });
  assert.deepEqual(o, original, 'lifecycle assessment must not mutate public state');
  return r;
};
const counts = (hand, deck = 30, discard = 0) => ({ hand, deck, discard });

test('non-play archive is a known move, while legacy callers retain baseline behavior', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  const old = assessPublicOperation(o, c, 'archive');
  assert.equal(old.affected, false); assert.equal(old.score, 0); assert.equal(old.move, undefined);
  const r = assess(o, c, 'archive');
  assert.equal(r.affected, true); assert.equal(r.removed, false); assert.equal(r.ruleUncertain, false);
  assert.equal(r.utilityApproximate, true); assert.ok(r.score > 0);
  assert.deepEqual(r.move.from, { seat: 0, zone: 'discard' });
  assert.deepEqual(r.move.to, { seat: 0, zone: 'archives' });
});

test('every supported non-play deck placement reports its actual destination and position', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  for (const [op, position] of [['deckTop', 'top'], ['deckBottom', 'bottom'], ['shuffleDeck', 'unknown'], ['shuffleIntoDeck', 'unknown']]) {
    const r = assess(o, c, op);
    assert.equal(r.affected, true); assert.equal(r.ruleUncertain, false);
    assert.deepEqual(r.move.to, { seat: 0, zone: 'deck', position });
  }
});

test('stronger ordinary use quality changes discard-to-archive value without terminal bonuses', () => {
  const o = observation(), strong = put(o, card('strong'), 'discard'), weak = put(o, card('weak', 'troll'), 'discard');
  const lifecycle = { useValue: c => ({ score: c.id === 'strong' ? 12 : 2, playableNow: false, approximate: false }) };
  assert.ok(assess(o, strong, 'archive', lifecycle).score > assess(o, weak, 'archive', lifecycle).score);
});

test('archiving a currently useful card loses current use; off-house retention does not', () => {
  const o = observation(), c = put(o, card('key'), 'hand');
  const now = assess(o, c, 'archive', quality(12, true));
  const later = assess(o, c, 'archive', quality(12, false));
  assert.ok(now.score < later.score); assert.equal(later.score, 0);
  assert.equal(now.affected, true); assert.equal(later.affected, true);
});

test('purging an owned hand card loses more opportunity than discarding it into the cycle', () => {
  const o = observation(), c = put(o, card('key'), 'hand');
  const purge = assess(o, c, 'purge'), discard = assess(o, c, 'discard');
  assert.ok(purge.score < discard.score); assert.ok(discard.score < 0);
  assert.equal(purge.move.to.zone, 'purged'); assert.equal(discard.move.to.zone, 'discard');
});

test('recovery distinguishes current legal opportunity from later retention', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  const available = assess(o, c, 'returnHand', quality(12, true));
  const blocked = assess(o, c, 'returnHand', quality(12, false));
  assert.ok(available.score > blocked.score); assert.ok(blocked.score > 0);
  assert.equal(available.ruleUncertain, false); assert.equal(blocked.ruleUncertain, false);
});

test('off-board ownership determines utility sign independently of stale controller', () => {
  const o = observation(), mine = put(o, card('mine'), 'discard'), theirs = put(o, card('theirs', 'key-charge', 1, { controller: 0 }), 'discard');
  const q = quality(12, false);
  assert.equal(assess(o, mine, 'purge', q).score, -assess(o, theirs, 'purge', q).score);
});

test('foreign archive purge/deck-bottom requests return to owner hand without false payment success', () => {
  const o = observation(), c = card('foreign', 'key-charge', 0, { foreignArchiveHolder: 1 });
  o.players[1].faceupArchives = [c]; o.players[1].archiveCount = 1;
  for (const op of ['purge', 'deckBottom', 'discard', 'archive']) {
    const r = assess(o, c, op);
    assert.equal(r.affected, false); assert.equal(r.ruleUncertain, false);
    assert.deepEqual(r.move.to, { seat: 0, zone: 'hand' });
    assert.equal(r.move.actualOperation, 'returnHand'); assert.equal(r.move.replaced, true);
    assert.equal(r.move.foreignArchiveHolder, null);
  }
  assert.equal(assess(o, c, 'returnHand').affected, true);
});

test('owner-equals-holder archive replacement marker still returns to hand and bypasses foreign-only lock', () => {
  const o = observation(), c = put(o, card('curse', 'key-charge', 0, { foreignArchiveHolder: 0 }), 'archives');
  const lock = put(o, card('lock', 'troll'), 'battleline'); lock.spec.locksForeignArchives = true;
  const r = assess(o, c, 'purge');
  assert.equal(r.affected, false); assert.deepEqual(r.move.to, { seat: 0, zone: 'hand' });
});

test('a live holder lock blocks foreign departure before its hand-return replacement', () => {
  const o = observation(), c = put(o, card('foreign', 'key-charge', 1, { foreignArchiveHolder: 0 }), 'archives', 0);
  const lock = put(o, card('lock', 'troll'), 'battleline'); lock.spec.locksForeignArchives = true;
  const blocked = assess(o, c, 'purge');
  assert.equal(blocked.affected, false); assert.equal(blocked.move, undefined); assert.equal(blocked.ruleUncertain, false);
  delete lock.spec.locksForeignArchives;
  const released = assess(o, c, 'purge');
  assert.deepEqual(released.move.to, { seat: 1, zone: 'hand' });
  assert.equal(released.affected, false, 'unblocked replacement still is not a successful purge');
});

test('foreignArchive records resolved destination holder and the owner-return marker', () => {
  const o = observation(), c = put(o, card('enemy', 'troll', 1, { captured: 2 }), 'battleline');
  const r = assess(o, c, 'foreignArchive', { ...quality(12, false), actor: 0 });
  assert.equal(r.removed, true); assert.equal(r.affected, true); assert.equal(r.destroyed, false);
  assert.deepEqual(r.move.to, { seat: 0, zone: 'archives' }); assert.equal(r.move.foreignArchiveHolder, 0);
  assert.deepEqual(r.released, [2, 0]);
  const sameOwner = assess(o, c, 'foreignArchive', { ...quality(), actor: 0, archiveTo: 1, archiveReturnToOwner: true });
  assert.equal(sameOwner.move.to.seat, 1); assert.equal(sameOwner.move.foreignArchiveHolder, 1);
});

test('Ward prevents board relocation and retains its existing bounded consumption value', () => {
  const o = observation(), c = put(o, card('enemy', 'troll', 1, { warded: true, captured: 2 }), 'battleline');
  const r = assess(o, c, 'archive');
  assert.equal(r.move, undefined); assert.equal(r.affected, false); assert.equal(r.removed, false);
  assert.deepEqual(r.released, [0, 0]); assert.ok(r.score > 0 && r.score < 2);
  const group = assessPublicOperationGroup(o, [c], 'discard', 0, { lifecycle: quality() });
  assert.deepEqual(group.consumedWards, [c.id]);
});

test('hand discard with a public host replacement stays rule-unknown instead of claiming discard payment', () => {
  const o = observation(), c = put(o, card('key'), 'hand'), host = put(o, card('host', 'troll'), 'battleline');
  const upgrade = put(o, card('glue', 'experimental-therapy', 0, { attachedTo: host.id }), 'upgrades');
  upgrade.spec.upgrade = { discardHandsUnderHost: true };
  const r = assess(o, c, 'discard');
  assert.equal(r.ruleUncertain, true); assert.equal(r.affected, false); assert.equal(r.move, undefined);
});

test('Scrap is a typed continuation only for actual active-player hand discard', () => {
  const o = observation(), c = put(o, card('scrap'), 'hand'); c.spec.abilities.scrap = [{ kind: 'gain', amount: 2 }];
  const hand = assess(o, c, 'discard');
  assert.equal(hand.affected, true); assert.equal(hand.ruleUncertain, false);
  assert.deepEqual(hand.continuationKinds, ['scrap']); assert.equal(hand.move.to.zone, 'discard');
  put(o, c, 'archives'); assert.equal(assess(o, c, 'discard').continuationUncertain, undefined);
  const theirs = card('other-scrap', 'key-charge', 1); theirs.spec.abilities.scrap = [{ kind: 'gain', amount: 2 }];
  o.promptCards.push(theirs);
  const other = assess(o, theirs, 'discard', { ...quality(), from: { seat: 1, zone: 'hand' } });
  assert.equal(other.affected, true); assert.equal(other.continuationUncertain, undefined);
});

test('whole-candidate refill counts two removals from seven cards as one new slot', () => {
  const o = observation();
  const r = assessLifecycleRefillDelta(o, [counts(7), counts(6)], [counts(5), counts(6)]);
  assert.deepEqual(r.drawDelta, [1, 0]); assert.equal(r.score, 0.9);
  const reverse = assessLifecycleRefillDelta(o, [counts(5), counts(6)], [counts(7), counts(6)]);
  assert.deepEqual(reverse.drawDelta, [-1, 0]); assert.equal(reverse.score, -0.9);
});

test('refill values real draw availability, chains and opposing slots instead of nominal hand changes', () => {
  const o = observation();
  assert.deepEqual(assessLifecycleRefillDelta(o, [counts(6, 0), counts(6)], [counts(5, 0), counts(6)]).drawDelta, [0, 0]);
  assert.deepEqual(assessLifecycleRefillDelta(o, [counts(6, 0), counts(6)], [counts(5, 0, 1), counts(6)]).drawDelta, [1, 0]);
  o.players[0].chains = 6;
  assert.deepEqual(assessLifecycleRefillDelta(o, [counts(6), counts(6)], [counts(5), counts(5)]).drawDelta, [0, 1]);
  assert.equal(assessLifecycleRefillDelta(o, [counts(6), counts(6)], [counts(5), counts(5)]).score, -0.9);
});

test('unknown refill counts do not erase a separately known archive movement', () => {
  const o = observation(), c = put(o, card('key'), 'hand');
  const delta = assessLifecycleRefillDelta(o, [counts(1), counts(6)], [counts(NaN), counts(6)]);
  assert.equal(delta.approximate, true); assert.equal(delta.score, 0);
  const move = assess(o, c, 'archive'); assert.equal(move.affected, true); assert.equal(move.ruleUncertain, false);
});

test('shared future recovery channels are not spent separately on every matching card', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  const without = assess(o, c, 'purge', quality(12, false));
  put(o, card('witch', 'witch-of-the-eye'), 'battleline');
  const withWitch = assess(o, c, 'purge', quality(12, false));
  assert.equal(withWitch.score, without.score, 'one future Witch use is not independently allocated per discarded card');
  const second = put(o, card('second'), 'discard');
  assert.equal(assess(o, second, 'purge', quality(12, false)).score, without.score);
  o.legalActions = [{ id: 'native-return', action: { kind: 'returnDiscard', card: c.id } }];
  assert.ok(assess(o, c, 'purge', quality(12, false)).score < without.score,
    'a current legal self-return is this physical card own access option');
  const purged = structuredClone(o); put(purged, c, 'purged');
  const pure = assessCardLifecycle(purged, c, 'returnHand', quality(12, false));
  assert.ok(pure.score > 0, 'a discard-only return action does not give a purged card existing access');
});

test('ordinary useful duplicates are not uniformly divided by copy count', () => {
  const o = observation(), c = put(o, card('recover'), 'discard');
  const before = assess(o, c, 'returnHand');
  put(o, card('copy'), 'hand');
  assert.equal(assess(o, c, 'returnHand').score, before.score);
});

test('ordinary unknown deck order is never read, while real shuffle uses only public counts', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  const normal = assess(o, c, 'shuffleDeck');
  const clone = structuredClone(o); clone.players[0].deck = [{ secret: 'not-a-public-face' }];
  assert.deepEqual(assess(clone, c, 'shuffleDeck'), normal);
  const longer = structuredClone(o); longer.players[0].deckCount = 60;
  assert.ok(assess(longer, c, 'deckBottom').score < assess(o, c, 'deckBottom').score);
});

test('opponent private arrays cannot establish a source zone, even if accidentally supplied', () => {
  const o = observation(), secret = card('secret', 'key-charge', 1);
  o.players[1].hand = [secret]; o.players[1].archives = [secret]; o.promptCards = [secret];
  assert.equal(publicCardLocation(o, secret), undefined);
  const r = assess(o, secret, 'purge');
  assert.equal(r.ruleUncertain, true); assert.equal(r.move, undefined);
  o.players[1].faceupArchives = [secret];
  assert.deepEqual(publicCardLocation(o, secret), { seat: 1, zone: 'archives' });
});

test('known public-target valuation is invariant to extra opponent private arrays', () => {
  const o = observation(), c = put(o, card('key'), 'discard'), before = assess(o, c, 'archive');
  o.players[1].hand = [card('hidden-1', 'troll', 1)];
  o.players[1].archives = [card('hidden-2', 'witch-of-the-eye', 1)];
  assert.deepEqual(assess(o, c, 'archive'), before);
});

test('current critical bonuses cannot enter ordinary card quality through the callback', () => {
  const o = observation(), c = put(o, card('key'), 'discard');
  const r = assess(o, c, 'returnHand', quality(7000, true));
  assert.ok(Math.abs(r.score) < 5000); assert.equal(r.utilityApproximate, true);
  assert.equal(r.ruleUncertain, false); assert.equal(r.affected, true);
});

test('a resolving action self-purge loses its later cycle option, not its already-scored Play effect', () => {
  const o = observation(), c = put(o, card('access', 'library-access'), 'resolving');
  const r = assess(o, c, 'purge', quality(12, false));
  assert.ok(r.score < 0 && r.score > -12); assert.equal(r.move.from.zone, 'resolving');
  assert.equal(r.move.to.zone, 'purged'); assert.equal(r.affected, true);
});

test('unmodeled refill hooks gate their own count forecast without wiping the other known seat', () => {
  const o = observation(), hook = put(o, card('hook', 'troll'), 'battleline');
  hook.spec.abilities.startDrawStep = [{ kind: 'draw', amount: 1 }];
  const r = assessLifecycleRefillDelta(o, [counts(6), counts(6)], [counts(5), counts(5)]);
  assert.equal(r.approximate, true); assert.deepEqual(r.drawDelta, [0, 1]); assert.equal(r.score, -0.9);
});

test('post-refill Tick-Tock end-turn archive changes earn no present refill slot reward', () => {
  const o = observation(); o.phase = 'choice';
  o.pending = { kind: 'target', actor: 0, source: 'tick', amount: 0, reward: 0,
    intent: { kind: 'target-operation', operation: 'archive', selection: { ability: 'endTurn', path: [0] } } };
  o.turnStep = { step: 5, performed: [0, 0], omega: false };
  const r = assessLifecycleRefillDelta(o, [counts(7), counts(6)], [counts(5), counts(6)]);
  assert.equal(r.score, 0); assert.deepEqual(r.drawDelta, [0, 0]); assert.equal(r.approximate, true);
  delete o.turnStep;
  assert.equal(assessLifecycleRefillDelta(o, [counts(7), counts(6)], [counts(5), counts(6)]).score, 0,
    'typed public end-turn timing alone also proves the refill has already occurred');
  o.pending = null; o.turnStep = { step: 5, performed: [0, 0], omega: false };
  assert.equal(assessLifecycleRefillDelta(o, [counts(7), counts(6)], [counts(5), counts(6)]).approximate, true,
    'unlocalized step 5 cannot establish a pre-refill slot');
});

test('incomplete archive replacement coverage is local unknown, while positive same-owner markers remain useful', () => {
  const o = observation(), c = put(o, card('archive'), 'archives');
  o.publicStateCoverage = { effectsComplete: false, turnHistoryComplete: true };
  const unknown = assess(o, c, 'purge');
  assert.equal(unknown.ruleUncertain, true); assert.equal(unknown.move, undefined); assert.equal(unknown.affected, false);
  c.foreignArchiveHolder = 0;
  const known = assess(o, c, 'purge');
  assert.equal(known.ruleUncertain, false); assert.deepEqual(known.move.to, { seat: 0, zone: 'hand' });
  const other = put(o, card('foreign', 'key-charge', 1, { foreignArchiveHolder: 0 }), 'archives', 0);
  assert.equal(assess(o, other, 'purge').ruleUncertain, true, 'positive foreign marker does not prove absence of a live lock');
});

test('a hand/archive/hand round trip has no card-quality or refill windfall', () => {
  const o = observation(), c = put(o, card('key'), 'hand');
  const archived = assess(o, c, 'archive', quality(12, true));
  put(o, c, 'archives');
  const returned = assess(o, c, 'returnHand', quality(12, true));
  assert.equal(archived.score + returned.score, 0);
  const refill = assessLifecycleRefillDelta(o, [counts(1), counts(6)], [counts(1), counts(6)]);
  assert.equal(refill.score, 0);
});
