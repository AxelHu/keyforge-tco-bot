/** Retire a timed-out, never-started room that this exact seat created. */
import { readLobbyFromBrowser } from './keyteki-live-lobby.mjs';
import { keytekiUiButton } from './keyteki-ui-contract.mjs';
import { exactSiteOrigin } from './site-origin.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && [...a].sort().join('\0') === [...b].sort().join('\0');
const fail = (code) => { throw Object.assign(Error(code), { code }); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const CREATED_PENDING_TIMINGS = Object.freeze({ proofMs: 60000, ackMs: 5000, maxAgeMs: 30000 });
const noGameplay = (state) => !state.fullVerified && !state.gameStarted && !state.finished &&
  !state.finalPublicView && !state.operatorPaused && !state.held && !state.lastGameplayFault &&
  !state.evidenceWriteFailures && !state.hostRestarts && !state.finishRetirementError && state.bridgeStatus == null &&
  [state.gameplayDiagnostics?.stats?.commands, state.gameplayDiagnostics?.stats?.queuedCommands, state.commands]
    .every((value) => value === undefined || value === null || value === 0);

/** A failed compound readiness predicate does not identify which seat failed to prepare. */
export function createdPendingReadiness(native, config) {
  const current = native?.current, selected = native?.ownSelection;
  const ownSelectionVerified = current?.ownSelected === true && current.ownDeckName === config.self.deckName &&
    selected?.gameId === config.room.gameId && selected.serverDeckId === config.self.serverDeckId &&
    selected.isStandalone === false && Number.isSafeInteger(selected.ordinal) && selected.ordinal < current.ordinal;
  const opponentPresent = current?.participants?.includes(config.room.opponentName) === true;
  const opponentNotReady = opponentPresent && current?.otherSelected === false && current?.allSelected === false;
  const neutral = ownSelectionVerified && (!opponentPresent || opponentNotReady);
  return { ownSelectionVerified, opponentPresent, opponentNotReady,
    ownSelected: current?.ownSelected === true, ownDeckMatches: current?.ownDeckName === config.self.deckName,
    allSelected: current?.allSelected === true,
    reason: neutral ? (opponentPresent ? 'opponent-deck-not-ready' : 'opponent-left-before-start')
      : 'readiness-timeout-unresolved', preparationFailure: !neutral };
}

function rosterProof(roster, config, now, maxAgeMs, present, notBefore) {
  if (!Number.isFinite(now) || roster?.source !== 'native-lobby' || roster.nativeFullRoster !== true ||
      roster.anonymous !== true || roster.origin !== config.origin || !Number.isFinite(roster.fullObservedAt) ||
      !Number.isFinite(notBefore) || roster.fullObservedAt < notBefore || now - roster.fullObservedAt > maxAgeMs ||
      roster.fullObservedAt > now + 1000 || !Array.isArray(roster.rooms) ||
      roster.rooms.some((row) => !object(row) || typeof row.id !== 'string' || !object(row.players) ||
        Object.entries(row.players).some(([name, player]) => !object(player) || player.name !== name)) ||
      new Set(roster.rooms.map((row) => row.id)).size !== roster.rooms.length)
    fail('CREATED_PENDING_FRESH_FULL_ROSTER_REQUIRED');
  const own = roster.rooms.filter((row) => Object.hasOwn(row.players, config.self.name));
  const exact = roster.rooms.find((row) => row.id === config.room.gameId);
  if (exact && (exact.started !== false || Object.keys(exact.players).some((name) => !config.participants.includes(name))))
    fail('CREATED_PENDING_ROSTER_GAME_CHANGED');
  if (present) {
    if (own.length !== 1 || own[0] !== exact || exact.owner !== config.self.name || exact.started !== false ||
        !Object.hasOwn(exact.players, config.self.name)) fail('CREATED_PENDING_OWN_ROOM_UNVERIFIED');
  } else if (own.length) fail('CREATED_PENDING_ACCOUNT_STILL_SEATED');
  return roster;
}

/** This is called only after the existing Start-readiness wait times out, before an automatic hold. */
export async function retireCreatedPendingRoom({
  page, config, state, tracker, hostIdentity, inspectHost, stopHost, release,
  quiesce = () => {}, afterRetired = () => {}, save = () => {}, externalCancellation = () => false,
  probe = readLobbyFromBrowser, now = Date.now, wait = pause, timings = CREATED_PENDING_TIMINGS,
}) {
  if (state.createdPendingExit) fail('CREATED_PENDING_EXIT_ALREADY_ATTEMPTED');
  const result = state.createdPendingExit = { schema: 'keyteki-created-pending-exit-v1', phase: 'checking',
    gameId: config.room.gameId, playerName: config.self.name, opponentName: config.room.opponentName,
    deck: { serverDeckId: config.self.serverDeckId, name: config.self.deckName },
    timeout: structuredClone(state.createdPreparationWait), startedAt: now(), uiLeaveAttempts: 0, nativeLeaveSends: 0 };
  let stopReceipt;
  const guard = ({ cleared = false, afterStop = false } = {}) => {
    tracker.checkContinuity();
    const native = tracker.snapshot(), bound = native.createdPair;
    if (!noGameplay(state) || (!afterStop && externalCancellation()) || stopReceipt?.operatorIntervened === true ||
        stopReceipt?.operatorUnchanged?.() === false || native.blockedReason || native.everStarted ||
        !bound || bound.gameId !== config.room.gameId || bound.playerName !== config.self.name ||
        bound.opponentName !== config.room.opponentName || bound.owner !== config.self.name ||
        !same(bound.participants, config.participants) || new URL(page.url()).origin !== config.origin)
      fail(native.blockedReason ?? 'CREATED_PENDING_RUNTIME_CHANGED');
    if (cleared) {
      if (native.current !== null || native.currentSource !== 'cleargamestate') fail('CREATED_PENDING_NATIVE_CLEAR_REQUIRED');
    } else if (native.currentSource !== 'gamestate' || native.current?.gameId !== config.room.gameId ||
        native.current.owner !== config.self.name || native.current.started !== false ||
        !native.current.participants.includes(config.self.name) ||
        native.current.participants.some((name) => !config.participants.includes(name)))
      fail('CREATED_PENDING_CURRENT_OWN_ROOM_REQUIRED');
    return native;
  };
  const status = async (cleared = false) => {
    if (!Number.isSafeInteger(hostIdentity?.pid) || hostIdentity.pid <= 0 || !/^[a-f0-9]{32}$/.test(hostIdentity.runId ?? ''))
      fail('CREATED_PENDING_HOST_IDENTITY_REQUIRED');
    const current = await inspectHost(); guard({ cleared });
    if (current?.runId !== hostIdentity.runId || current.pid !== hostIdentity.pid || current.paused || current.stopping ||
        !Array.isArray(current.sessions) || current.sessions.length ||
        !Array.isArray(current.restoredSessions) || current.restoredSessions.length)
      fail('CREATED_PENDING_HOST_NOT_IDLE');
    return { runId: current.runId, pid: current.pid, sessionCount: 0, restoredSessionCount: 0, observedAt: now() };
  };
  const phase = (value) => { result.phase = value; save(); };
  try {
    exactSiteOrigin(config.origin);
    const timeout = state.createdPreparationWait;
    if (state.phase !== 'waiting-for-human-deck' || timeout?.code !== 'HUMAN_DECK_NOT_READY' ||
        !Number.isFinite(timeout.startedAt) || !Number.isFinite(timeout.deadlineAt) ||
        timeout.deadlineAt - timeout.startedAt !== config.setupTimeoutMs || now() < timeout.deadlineAt ||
        !Number.isFinite(timeout.expiredAt) || timeout.expiredAt < timeout.deadlineAt)
      fail('CREATED_PENDING_READINESS_TIMEOUT_REQUIRED');
    let native = guard(); result.binding = native.createdPair; save();
    result.hostBefore = await status();
    const beforeProbeStartedAt = now();
    const before = await probe(page.context().browser(), { origin: config.origin, timeoutMs: timings.proofMs });
    native = guard(); rosterProof(before, config, now(), timings.maxAgeMs, true, beforeProbeStartedAt);
    result.before = { native, roster: before, probeStartedAt: beforeProbeStartedAt, verifiedAt: now() };
    const leave = keytekiUiButton(page, 'leavePending');
    if (!(await leave.isVisible()) || !(await leave.isEnabled())) fail('CREATED_PENDING_LEAVE_UI_NOT_READY');
    result.hostBeforeLeave = await status();
    rosterProof(before, config, now(), timings.maxAgeMs, true, beforeProbeStartedAt);
    native = guard(); result.beforeLeave = native; result.readiness = createdPendingReadiness(native, config);
    tracker.beginLeave();
    result.leaveIntent = { attempts: 1, nativeOrdinal: native.current.ordinal, recordedAt: now() };
    phase('leave-intent-recorded'); guard(); result.uiLeaveAttempts = 1;
    phase('leaving');
    try { await leave.click({ timeout: timings.ackMs }); } catch { result.uiClickUnconfirmed = true; }
    const deadline = now() + timings.ackMs;
    while (now() < deadline) {
      const current = tracker.snapshot();
      if (current.currentSource === 'cleargamestate' && current.leave.sent === 1 && current.leave.acknowledgement) break;
      guard({ cleared: current.currentSource === 'cleargamestate' });
      await wait(Math.min(100, Math.max(1, deadline - now())));
    }
    native = guard({ cleared: true }); result.nativeLeaveSends = native.leave.sent;
    if (native.leave.sent !== 1 || !native.leave.acknowledgement ||
        native.leave.acknowledgement.ordinal <= native.leave.sentOrdinal) fail('CREATED_PENDING_LEAVE_UNCONFIRMED');
    result.nativeLeave = native.leave; phase('verifying-account-absence');
    const afterProbeStartedAt = now();
    const absent = await probe(page.context().browser(), { origin: config.origin, timeoutMs: timings.proofMs });
    guard({ cleared: true }); rosterProof(absent, config, now(), timings.maxAgeMs, false, afterProbeStartedAt);
    result.after = { native: tracker.snapshot(), roster: absent, probeStartedAt: afterProbeStartedAt, verifiedAt: now() };
    result.wholeAccountAbsent = true; result.hostBeforeRetirement = await status(true);
    guard({ cleared: true }); phase('stopping-host'); await quiesce(); guard({ cleared: true });
    stopReceipt = await stopHost(); guard({ cleared: true, afterStop: true });
    if (stopReceipt?.stopped !== true || stopReceipt.runId !== hostIdentity.runId || stopReceipt.pid !== hostIdentity.pid ||
        !/^[a-f0-9]{32}$/.test(stopReceipt.retirementId ?? '')) fail('CREATED_PENDING_HOST_STOP_UNCONFIRMED');
    result.hostStopped = { stopped: true, runId: stopReceipt.runId, pid: stopReceipt.pid, retirementId: stopReceipt.retirementId };
    phase('releasing-browser'); guard({ cleared: true, afterStop: true }); tracker.expectOwnedBrowserClose();
    const released = await release();
    if (!noGameplay(state) || stopReceipt.operatorUnchanged?.() === false || tracker.snapshot().blockedReason ||
        tracker.snapshot().everStarted || released?.leaseReleased !== true || released.managed !== true)
      fail('CREATED_PENDING_BROWSER_RELEASE_UNCONFIRMED');
    result.browserReleased = released; await afterRetired();
    result.neverNativeActive = true; result.zeroGameplaySends = true;
    result.completedAt = now(); result.phase = 'retired'; state.runtimeRetired = true;
    state.preparationFailure = result.readiness.preparationFailure;
    state.phase = 'created-pending-retired'; save(); return true;
  } catch (error) {
    result.phase = 'blocked-preserved'; result.reason = /^[A-Z0-9_]+$/.test(error?.code ?? '')
      ? error.code : 'CREATED_PENDING_RETIREMENT_UNCONFIRMED';
    result.observedNative = tracker?.snapshot(); result.nativeLeaveSends = result.observedNative?.leave.sent ?? 0;
    save(); return false;
  }
}

/** Completed pending-room cancellation is separate from natural results and from continuation permission. */
export function createdPendingSeatReleased(receipt, { origin, gameId, selfName, participants }) {
  try {
    exactSiteOrigin(origin);
    const pair = receipt?.binding, before = receipt?.beforeLeave, after = receipt?.after?.native;
    if (receipt?.schema !== 'keyteki-created-pending-exit-v1' || receipt.phase !== 'retired' || receipt.gameId !== gameId ||
        receipt.playerName !== selfName || !Array.isArray(participants) || participants.length !== 2 ||
        new Set(participants).size !== 2 || !same(participants, [selfName, receipt.opponentName]) ||
        receipt.opponentName === selfName || !Number.isSafeInteger(receipt.deck?.serverDeckId) ||
        typeof receipt.deck?.name !== 'string' || !receipt.deck.name ||
        pair?.gameId !== gameId || pair.playerName !== selfName || pair.opponentName !== receipt.opponentName ||
        pair.owner !== selfName || pair.started !== false || pair.source !== 'gamestate' ||
        pair.nativeTransportBound !== true || !same(pair.participants, participants) ||
        pair.ownSelected !== true || pair.ownDeckName !== receipt.deck.name ||
        pair.selection?.gameId !== gameId || pair.selection.serverDeckId !== receipt.deck.serverDeckId ||
        pair.selection.isStandalone !== false || !Number.isSafeInteger(pair.ordinal) ||
        !Number.isSafeInteger(pair.selection.ordinal) || pair.selection.ordinal >= pair.ordinal ||
        receipt.timeout?.code !== 'HUMAN_DECK_NOT_READY' || !Number.isFinite(receipt.timeout.startedAt) ||
        !Number.isFinite(receipt.timeout.deadlineAt) || !Number.isFinite(receipt.timeout.expiredAt) ||
        receipt.timeout.deadlineAt <= receipt.timeout.startedAt || receipt.timeout.expiredAt < receipt.timeout.deadlineAt ||
        !Number.isFinite(receipt.startedAt) || receipt.startedAt < receipt.timeout.expiredAt ||
        !Number.isFinite(receipt.completedAt) || receipt.completedAt < receipt.startedAt ||
        receipt.neverNativeActive !== true || receipt.zeroGameplaySends !== true || receipt.wholeAccountAbsent !== true ||
        before?.createdPair?.ordinal !== pair.ordinal || before.everStarted !== false || before.blockedReason !== null ||
        before.currentSource !== 'gamestate' || before.current?.gameId !== gameId || before.current.owner !== selfName ||
        before.current.started !== false || !before.current.participants.includes(selfName) ||
        before.current.participants.some((name) => !participants.includes(name)) ||
        after?.createdPair?.ordinal !== pair.ordinal || after.current !== null || after.currentSource !== 'cleargamestate' ||
        after.everStarted !== false || after.blockedReason !== null ||
        receipt.uiLeaveAttempts !== 1 || receipt.nativeLeaveSends !== 1 || receipt.nativeLeave?.attempts !== 1 ||
        receipt.nativeLeave.sent !== 1 || receipt.nativeLeave.acknowledgement?.gameId !== gameId ||
        receipt.nativeLeave.acknowledgement.playerName !== selfName ||
        !['cleargamestate', 'removegame'].includes(receipt.nativeLeave.acknowledgement.source) ||
        !Number.isSafeInteger(receipt.leaveIntent?.nativeOrdinal) || receipt.leaveIntent.nativeOrdinal !== before.current.ordinal ||
        !Number.isSafeInteger(receipt.nativeLeave.sentOrdinal) || receipt.nativeLeave.sentOrdinal <= receipt.leaveIntent.nativeOrdinal ||
        receipt.nativeLeave.acknowledgement.ordinal <= receipt.nativeLeave.sentOrdinal ||
        after.ordinal < receipt.nativeLeave.acknowledgement.ordinal || receipt.hostStopped?.stopped !== true ||
        !Number.isSafeInteger(receipt.hostStopped.pid) || receipt.hostStopped.pid <= 0 ||
        !/^[a-f0-9]{32}$/.test(receipt.hostStopped.runId ?? '') || !/^[a-f0-9]{32}$/.test(receipt.hostStopped.retirementId ?? '') ||
        receipt.browserReleased?.managed !== true || receipt.browserReleased.leaseReleased !== true) return false;
    if (JSON.stringify(before.createdPair) !== JSON.stringify(pair) ||
        JSON.stringify(after.createdPair) !== JSON.stringify(pair) ||
        JSON.stringify(after.leave) !== JSON.stringify(receipt.nativeLeave) ||
        before.leave?.attempts !== 0 || before.leave.sent !== 0 || before.leave.acknowledgement !== null ||
        !Number.isSafeInteger(after.ordinal) || !Number.isSafeInteger(receipt.nativeLeave.acknowledgement.ordinal) ||
        receipt.timeout.deadlineAt - receipt.timeout.startedAt < 1000 ||
        receipt.timeout.deadlineAt - receipt.timeout.startedAt > 180000 ||
        !Number.isFinite(receipt.leaveIntent.recordedAt) || receipt.leaveIntent.recordedAt < receipt.startedAt ||
        receipt.leaveIntent.recordedAt > receipt.completedAt) return false;
    for (const host of [receipt.hostBefore, receipt.hostBeforeLeave, receipt.hostBeforeRetirement])
      if (host?.sessionCount !== 0 || host.restoredSessionCount !== 0 || host.runId !== receipt.hostStopped.runId ||
          host.pid !== receipt.hostStopped.pid) return false;
    for (const native of [receipt.before.native, before, after])
      if (JSON.stringify(native.createdPair) !== JSON.stringify(pair) || native.everStarted !== false ||
          native.blockedReason !== null || native.continuity?.verified !== true ||
          !Number.isFinite(native.continuity.checkedAt) ||
          !Number.isFinite(native.continuity.lastActivityAt) || !Number.isFinite(native.continuity.silenceLimitMs) ||
          native.continuity.checkedAt < native.continuity.lastActivityAt ||
          native.continuity.checkedAt - native.continuity.lastActivityAt > native.continuity.silenceLimitMs) return false;
    const config = { origin, self: { name: selfName, serverDeckId: receipt.deck.serverDeckId, deckName: receipt.deck.name },
      room: { gameId, opponentName: receipt.opponentName }, participants };
    for (const [proof, present] of [[receipt.before, true], [receipt.after, false]])
      rosterProof(proof.roster, config, proof.verifiedAt, CREATED_PENDING_TIMINGS.maxAgeMs, present, proof.probeStartedAt);
    return JSON.stringify(createdPendingReadiness(before, config)) === JSON.stringify(receipt.readiness);
  } catch { return false; }
}
