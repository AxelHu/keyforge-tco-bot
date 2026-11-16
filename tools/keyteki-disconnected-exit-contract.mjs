/** A server-offered, nonterminal departure is separate from a win, loss, or bot fault. */
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const text = (x) => typeof x === 'string' && x.length > 0;
const hash = (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const fail = () => { throw Object.assign(Error('DISCONNECTED_EXIT_CONFIG_INVALID'), { code: 'DISCONNECTED_EXIT_CONFIG_INVALID' }); };

export function normalizeDisconnectedOpponentExit(value = {}) {
  if (!object(value) || Object.keys(value).some((key) => !['enabled', 'waitMs'].includes(key))) fail();
  const enabled = value.enabled ?? false, waitMs = value.waitMs ?? 120000;
  if (typeof enabled !== 'boolean' || !Number.isSafeInteger(waitMs) || waitMs < 120000 || waitMs > 900000) fail();
  return Object.freeze({ enabled, waitMs });
}

export function disconnectedNoLossNotice(playerName, opponentName) {
  return `${opponentName} has disconnected. ${playerName} may wait for them to reconnect, or after 30 seconds may leave without recording a loss.`;
}

const membership = (value, gameId, playerName, present) => Boolean(
  value?.gameId === gameId && value.playerName === playerName && value.seatPresent === present &&
  value.ownSeatPreviouslyObserved === true && Number.isSafeInteger(value.ordinal) && value.ordinal >= 1 &&
  ['games', 'newgame', 'updategame', 'removegame'].includes(value.source) &&
  (present || value.serverSeatAbsent === true),
);

/** Used by both the exact-host retirement request and the campaign's result classifier. */
export function verifiedDisconnectedDeparture(exit, { origin, gameId, playerName, participants, requireRetired = false }) {
  const binding = exit?.binding;
  return Boolean(
    exit?.schema === 'kf-disconnected-opponent-exit-v1' &&
    exit.origin === origin && exit.gameId === gameId && exit.playerName === playerName &&
    same(exit.participants, participants) && participants.length === 2 && participants.includes(playerName) &&
    exit.opponentName === participants.find((name) => name !== playerName) &&
    exit.reason === 'native-opponent-disconnected' &&
    ['left-confirmed', 'retired'].includes(exit.phase) &&
    exit.noWinnerAtIntent === true && exit.opponentDisconnectedAtIntent === true &&
    exit.ownActionAtIntent === false && exit.noPendingGameplayAtIntent === true &&
    exit.noLossNoticeMatched === true && exit.quarantineConfirmed === true &&
    Number.isSafeInteger(exit.waitMs) && exit.waitMs >= 120000 && exit.waitMs <= 900000 &&
    Number.isFinite(exit.observedForMs) && exit.observedForMs >= exit.waitMs &&
    Number.isSafeInteger(exit.nativeDisconnectEpoch) && exit.nativeDisconnectEpoch >= 1 &&
    exit.leaveUiAttempts === 1 && exit.leaveUiClicked === true &&
    exit.nativeLeaveObserved === true && exit.nativeLeaveOpcode === 'game/leavegame' &&
    binding?.gameId === gameId && binding.playerName === playerName &&
    text(binding.documentId) && text(binding.frameToken) && text(binding.transportPath) &&
    Number.isSafeInteger(binding.nativeSequence) && binding.nativeSequence >= 1 &&
    Number.isSafeInteger(binding.ownerEpoch) && binding.ownerEpoch >= 1 &&
    /^[a-f0-9]{32}$/.test(binding.hostRunId ?? '') &&
    Number.isSafeInteger(binding.hostPid) && binding.hostPid >= 1 && hash(binding.configSha256) &&
    membership(exit.serverBeforeLeave, gameId, playerName, true) &&
    membership(exit.serverAtLeave, gameId, playerName, true) &&
    membership(exit.server, gameId, playerName, false) &&
    exit.server.ordinal > exit.serverAtLeave.ordinal &&
    exit.serverAtLeave.ordinal >= exit.serverBeforeLeave.ordinal &&
    (!requireRetired || (exit.phase === 'retired' && exit.hostStopped === true && exit.browserLeaseReleased === true)),
  );
}
