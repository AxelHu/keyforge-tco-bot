/** Read-only, bounded wait for this seat's existing terminal chat work. Never sends a message. */
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const count = (x) => Number.isSafeInteger(x) && x >= 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const FINISHED_CHAT_DRAIN_MS = 65000;

/** Project only scheduling metadata; message text, credentials and other seats never enter the receipt. */
export function finishedChatStatus(status, identity) {
  if (status?.paused === true || status?.stopping === true)
    return { observable: true, operatorPaused: true, drained: false, reason: 'operator-paused' };
  if (!object(status) || !Array.isArray(status.social))
    return { observable: false, drained: false, reason: 'social-status-unavailable' };
  const rows = status.social.filter(
    (row) =>
      object(row) &&
      row.origin === identity.origin &&
      row.gameId === identity.gameId &&
      row.playerName === identity.playerName,
  );
  if (rows.length !== 1)
    return {
      observable: rows.length === 0,
      drained: false,
      reason: rows.length ? 'ambiguous-social-session' : 'same-seat-session-unobserved',
    };
  const row = rows[0];
  if (
    !['idle', 'generating', 'ready', 'closed'].includes(row.phase) ||
    !count(row.pending) ||
    !count(row.pendingIssuedCount) ||
    typeof row.terminalObserved !== 'boolean'
  )
    return { observable: false, drained: false, reason: 'social-status-shape-unverified' };
  const outstanding =
    ['generating', 'ready'].includes(row.phase) || row.pending > 0 || row.pendingIssuedCount > 0;
  const drained = row.terminalObserved && !outstanding && row.phase !== 'closed';
  return {
    observable: true,
    drained,
    phase: row.phase,
    terminalObserved: row.terminalObserved,
    pending: row.pending,
    pendingIssuedCount: row.pendingIssuedCount,
    outstanding,
    reason: drained
      ? 'no-unsettled-local-chat-work'
      : row.phase === 'closed'
        ? 'social-session-closed'
        : !row.terminalObserved
          ? 'terminal-chat-not-yet-observed'
          : 'chat-work-outstanding',
  };
}

const boundedRead = (readStatus, timeoutMs) => {
  let timer;
  return Promise.race([
    Promise.resolve().then(readStatus),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('chat-status-timeout')), Math.max(1, timeoutMs));
    }),
  ]).finally(() => clearTimeout(timer));
};

/** A drained receipt means local work settled; it never claims a server echo or successful farewell. */
export async function waitForFinishedChat({
  identity,
  readStatus,
  socialEnabled,
  cancelled = () => null,
  timeoutMs = FINISHED_CHAT_DRAIN_MS,
  pollMs = 250,
  readTimeoutMs = 3000,
  clock = Date.now,
  wait = pause,
}) {
  const budget = socialEnabled === false ? 0 : Math.max(1, Math.min(FINISHED_CHAT_DRAIN_MS, timeoutMs));
  const started = clock(),
    deadline = started + budget;
  let checks = 0,
    last = { observable: false, drained: false, reason: 'not-yet-checked' };
  const receipt = (outcome, reason) => ({
    gameId: identity.gameId,
    playerName: identity.playerName,
    outcome,
    reason,
    checks,
    budgetMs: budget,
    elapsedMs: Math.max(0, clock() - started),
    last,
    serverEchoConfirmed: false,
  });
  // Only an explicit normalized false skips polling; missing/unknown configuration still waits.
  if (socialEnabled === false) {
    const reason = cancelled();
    if (reason) return receipt('cancelled', reason);
    last = { observable: false, drained: false, reason: 'social-disabled' };
    return receipt('skipped', 'social-disabled');
  }
  while (clock() < deadline) {
    const before = cancelled();
    if (before) return receipt('cancelled', before);
    try {
      last = finishedChatStatus(
        await boundedRead(readStatus, Math.min(readTimeoutMs, deadline - clock())),
        identity,
      );
    } catch {
      last = { observable: false, drained: false, reason: 'social-status-unavailable' };
    }
    checks++;
    const after = cancelled();
    if (after || last.operatorPaused) return receipt('cancelled', after || 'operator-paused');
    if (last.drained) return receipt('drained', last.reason);
    if (clock() >= deadline) break;
    await wait(Math.min(pollMs, deadline - clock()));
  }
  const finalReason = cancelled();
  return finalReason ? receipt('cancelled', finalReason) : receipt('timed-out', last.reason);
}
