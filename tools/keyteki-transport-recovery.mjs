/** Narrow public-player full-state continuity checks. No reconnect or game command is issued here. */
import { createHash } from 'node:crypto';
import { normalizeGameSocketPaths } from './site-origin.mjs';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sort = (x) =>
  Array.isArray(x)
    ? x.map(sort)
    : object(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, sort(x[k])]),
        )
      : x;
const canonical = (x) => JSON.stringify(sort(x));
const same = (a, b) => canonical(a) === canonical(b);
const nonempty = (x) => typeof x === 'string' && x.length > 0;
const hash = (x) => createHash('sha256').update(canonical(x)).digest('hex');
export const KEYTEKI_TRANSPORT_RECOVERY_MS = 60000;

export function keytekiTransportBinding(value, origin, allowedGameSocketPaths = []) {
  if (
    !object(value) ||
    !same(Object.keys(value).sort(), ['epoch', 'path']) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    !nonempty(value.path)
  )
    throw Error('transport-binding-invalid');
  const url = new URL(value.path);
  const allowed = normalizeGameSocketPaths(allowedGameSocketPaths);
  if (
    (url.origin !== origin && !allowed.includes(value.path)) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^\/[A-Za-z0-9_-]{1,80}\/socket\.io$/.test(url.pathname) ||
    value.path !== url.origin + url.pathname
  )
    throw Error('transport-path-invalid');
  return { epoch: value.epoch, path: value.path };
}

export function keytekiTransportCloseDiagnostic(value) {
  if (
    !object(value) ||
    !same(Object.keys(value).sort(), ['code', 'reason', 'wasClean']) ||
    !(
      value.code === null ||
      (Number.isSafeInteger(value.code) && value.code >= 1000 && value.code <= 4999)
    ) ||
    !(value.wasClean === null || typeof value.wasClean === 'boolean') ||
    ![
      'empty',
      'transport close',
      'transport error',
      'ping timeout',
      'nonempty-redacted',
      'unreported',
    ].includes(value.reason)
  )
    throw Error('transport-close-diagnostic-invalid');
  return { code: value.code, wasClean: value.wasClean, reason: value.reason };
}

function fullPlayer(raw, name) {
  const p = raw.players?.[name];
  if (
    !object(p) ||
    p.name !== name ||
    typeof p.activePlayer !== 'boolean' ||
    typeof p.phase !== 'string' ||
    !object(p.cardPiles) ||
    !object(p.stats) ||
    !['hand', 'archives', 'discard', 'purged', 'cardsInPlay'].every((z) => Array.isArray(p.cardPiles[z])) ||
    !Number.isSafeInteger(p.numDeckCards) ||
    p.numDeckCards < 0 ||
    !Number.isSafeInteger(p.numArchivesCards) ||
    p.numArchivesCards < 0 ||
    !Number.isSafeInteger(p.stats.amber) ||
    p.stats.amber < 0 ||
    !Number.isSafeInteger(p.stats.chains) ||
    p.stats.chains < 0 ||
    !object(p.stats.keys) ||
    !['red', 'blue', 'yellow'].every((k) => typeof p.stats.keys[k] === 'boolean') ||
    p.left === true
  )
    throw Error('transport-full-player-state-required');
  return p;
}

/** Only an unchanged retained suffix followed by fresh message IDs proves a continuous window.
 * This does not prove every intermediate state was observed, nor any command acceptance.
 */
export function validateKeytekiTransportFullState(before, after, { playerName, participants }) {
  if (
    !object(before) ||
    !object(after) ||
    !nonempty(before.id) ||
    before.id !== after.id ||
    before.started !== true ||
    after.started !== true ||
    before.manualMode !== false ||
    after.manualMode !== false ||
    !object(before.players) ||
    !object(after.players) ||
    !Array.isArray(participants) ||
    participants.length !== 2 ||
    new Set(participants).size !== 2 ||
    !participants.includes(playerName) ||
    !same(Object.keys(before.players).sort(), [...participants].sort()) ||
    !same(Object.keys(after.players).sort(), [...participants].sort())
  )
    throw Error('transport-full-game-identity-invalid');
  for (const name of participants) {
    const a = fullPlayer(before, name),
      b = fullPlayer(after, name);
    if (!same(a.houses, b.houses)) throw Error('transport-deck-houses-changed');
    for (const k of ['uuid', 'id', 'name', 'expansion'])
      if (!same(a.deckData?.[k], b.deckData?.[k])) throw Error('transport-deck-identity-changed');
  }
  const old = before.players[playerName],
    current = after.players[playerName];
  if (
    old.activePlayer !== false ||
    old.selectCard === true ||
    old.selectOrder === true ||
    !Array.isArray(old.buttons) ||
    old.buttons.length ||
    !Array.isArray(old.controls) ||
    old.controls.length ||
    current.disconnected !== false ||
    !Array.isArray(current.buttons) ||
    !Array.isArray(current.controls)
  )
    throw Error('transport-player-not-idle-or-full');
  for (const rows of [before.messages, after.messages])
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.some((m) => !object(m) || !nonempty(m.id)) ||
      new Set(rows.map((m) => m.id)).size !== rows.length
    )
      throw Error('transport-message-window-unavailable');
  const a = before.messages,
    b = after.messages;
  const end = b.findIndex((m) => m.id === a.at(-1).id);
  if (end < 0 || end >= a.length || !same(a.slice(a.length - end - 1), b.slice(0, end + 1)))
    throw Error('transport-message-window-discontinuous');
  const oldIds = new Set(a.map((m) => m.id)),
    fresh = b.slice(end + 1);
  if (fresh.some((m) => oldIds.has(m.id))) throw Error('transport-message-id-reused');
  return {
    kind: 'native-full-state-with-continuous-public-window',
    gameId: after.id,
    playerName,
    beforeStateSha256: hash(before),
    afterStateSha256: hash(after),
    anchorMessageId: a.at(-1).id,
    retainedMessages: end + 1,
    freshMessageIds: fresh.map((m) => m.id),
  };
}
