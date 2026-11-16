/** Optional TCO departure after a native opponent disconnect and an explicit no-loss Leave offer. */
import { beginFinishedRoomSeatCheck } from './keyteki-finished-room-exit.mjs';
import { watchdogResponsibility, watchdogProgressHash } from './keyteki-human-watchdog.mjs';
import { disconnectedNoLossNotice, verifiedDisconnectedDeparture } from './keyteki-disconnected-exit-contract.mjs';
import { hostOperatorIntentFingerprint, hostStopWasRequested } from './keyteki-host-operator-intent.mjs';

const same = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const fail = (code) => { throw Object.assign(Error(code), { code }); };
const bounded = async (promise, ms = 5000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('DISCONNECTED_EXIT_OPERATION_TIMEOUT')), ms);
  })]); } finally { clearTimeout(timer); }
};

/** Transport polls and chat rows cannot manufacture a disconnected native player or renew this timer. */
export function currentDisconnectedOpponentProof(config, state, snap, receipt, raw, host, hostIdentity) {
  const opponentName = config.participants.find((name) => name !== config.self.name);
  const me = raw?.players?.[config.self.name], opponent = raw?.players?.[opponentName];
  const sessions = host?.sessions;
  const session = Array.isArray(sessions) && sessions.length === 1 ? sessions[0] : null;
  const stats = session?.stats;
  const valid = Boolean(
    config.disconnectedOpponentExit?.enabled === true && config.origin === 'https://thecrucible.online' &&
    config.participants.length === 2 && same(Object.keys(raw?.players ?? {}), config.participants) &&
    state.fullVerified === true && !state.finished && !state.held && !state.operatorPaused && !state.runtimeRetired &&
    !state.lastGameplayFault && !state.evidenceWriteFailures && !state.watchdogObservationGap &&
    raw?.id === config.room.gameId && raw.started === true && raw.manualMode === false && !raw.winner &&
    me && me.name === config.self.name && me.disconnected === false && me.left !== true &&
    opponent && opponent.name === opponentName && opponent.disconnected === true &&
    ['waiting-for-opponent', 'opponent-turn'].includes(watchdogResponsibility(raw, config.self.name).reason) &&
    snap?.enabled === true && snap.invalid === false && snap.connected === true &&
    snap.operatorPaused === false && snap.strategyPaused === false && snap.unknownSend === false &&
    snap.deliveryPresent === false && snap.deliveryLedgerPresent === false &&
    snap.gameId === config.room.gameId && snap.playerName === config.self.name &&
    receipt && typeof receipt.documentId === 'string' && receipt.documentId.length > 0 &&
    typeof receipt.frameToken === 'string' && receipt.frameToken.length > 0 &&
    typeof receipt.transportPath === 'string' && receipt.transportPath.length > 0 &&
    Number.isSafeInteger(receipt.nativeSequence) && receipt.nativeSequence > 0 &&
    Number.isSafeInteger(receipt.ownerEpoch) && receipt.ownerEpoch > 0 &&
    ['documentId', 'ownerEpoch', 'nativeSequence', 'frameToken', 'transportPath'].every((key) => snap[key] === receipt[key]) &&
    host && hostIdentity && host.runId === hostIdentity.runId && host.pid === hostIdentity.pid &&
    host.configSha256 === hostIdentity.configSha256 && !host.paused && !host.stopping &&
    Array.isArray(host.restoredSessions) && host.restoredSessions.length === 0 &&
    session?.origin === config.origin && session.gameId === config.room.gameId && session.playerName === config.self.name &&
    session.documentId === snap.documentId && session.ownerEpoch === snap.ownerEpoch &&
    session.status === 'waiting-for-opponent' && session.sendPending == null && session.modelInFlight !== true &&
    Array.isArray(session.pendingDeliveries) && session.pendingDeliveries.length === 0 &&
    Number.isSafeInteger(stats?.commands) && stats.commands >= 0 && stats.queuedCommands === stats.commands &&
    stats.acknowledged === stats.commands,
  );
  if (!valid) return null;
  return { opponentName, progressHash: watchdogProgressHash(raw),
    binding: { gameId: config.room.gameId, playerName: config.self.name, documentId: snap.documentId,
      ownerEpoch: snap.ownerEpoch, nativeSequence: snap.nativeSequence, frameToken: snap.frameToken,
      transportPath: snap.transportPath, hostRunId: hostIdentity.runId, hostPid: hostIdentity.pid,
      configSha256: hostIdentity.configSha256 } };
}

/** This function runs in the actual page. All final checks, quarantine, and the normal UI click are synchronous. */
export function disconnectedDepartureUi({ expectedOrigin, notice, binding, click = false }) {
  const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    const style = getComputedStyle(element);
    return element.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const guardian = window.__kfHumanFaultGuardian;
  const snap = guardian?.snapshot();
  const bound = location.origin === expectedOrigin && snap?.enabled === true && snap.invalid === false &&
    snap.connected === true && snap.operatorPaused === false && snap.strategyPaused === false &&
    snap.unknownSend === false && snap.deliveryPresent === false && snap.deliveryLedgerPresent === false &&
    ['gameId', 'playerName', 'documentId', 'ownerEpoch', 'nativeSequence', 'frameToken', 'transportPath']
      .every((key) => snap[key] === binding?.[key]);
  const alerts = [...document.querySelectorAll('[role="alert"], .alert')]
    .filter((element) => visible(element) && normalize(element.textContent) === notice);
  const buttons = [...document.querySelectorAll('button')]
    .filter((element) => visible(element) && normalize(element.textContent) === 'Leave Game');
  const noLossNoticeMatched = alerts.length === 1;
  const buttonReady = buttons.length === 1 && buttons[0].disabled === false && buttons[0].getAttribute('aria-disabled') !== 'true';
  if (!bound || !noLossNoticeMatched || !buttonReady)
    return { allowed: false, attempted: false, noLossNoticeMatched, buttonReady };
  if (!click) return { allowed: true, attempted: false, noLossNoticeMatched, buttonReady };
  if (guardian.prepareDisconnectedLeave?.(binding) !== true)
    return { allowed: false, attempted: false, noLossNoticeMatched, buttonReady, quarantineConfirmed: false };
  // Do not send a socket command, manufacture a winner, or invoke the fault-concession path.
  try {
    buttons[0].click();
    const departure = guardian.snapshot()?.departureLedger;
    return { allowed: true, attempted: true, clicked: true, noLossNoticeMatched, quarantineConfirmed: true,
      nativeLeaveObserved: departure?.nativeLeaveObserved === true && departure.opcode === 'game/leavegame',
      nativeLeaveOpcode: departure?.opcode ?? null };
  } catch {
    return { allowed: true, attempted: true, clicked: false, outcome: 'unknown', noLossNoticeMatched, quarantineConfirmed: true };
  }
}

export function installDisconnectedOpponentExit({ config, state, page, watchdog, inspectHost,
  getHostIdentity, connection, stopHost, releaseBrowser, closePeers, afterRetired = () => {}, save = () => {},
  prepareSeatCheck = beginFinishedRoomSeatCheck, now = Date.now, autoPoll = true,
  pollMs = 1000, timeoutMs = 90000,
  operatorChanged = () => hostStopWasRequested(config.profile, connection),
  operatorFingerprint = () => hostOperatorIntentFingerprint(config.profile),
}) {
  let closed = false, busy = false, attempted = false, since = null, continuity = null, interval;
  let nativeEpoch = 0, nativeWaiting = false, nativeContinuity = null, observationBroken = false;
  let previousNativeReceipt = null;
  let unsubscribeNative = () => {};
  const close = () => { closed = true; clearInterval(interval); unsubscribeNative(); };
  const cancelled = () => closed || observationBroken || state.operatorPaused || operatorChanged();
  const inspect = async () => {
    if (cancelled() || new URL(page.url()).origin !== config.origin) return null;
    const host = await bounded(inspectHost()), snap = await bounded(watchdog.snapshot());
    const observed = watchdog.watchdog.status();
    if (cancelled() || observed.enabled !== true || observed.phase !== 'waiting-for-opponent') return null;
    return currentDisconnectedOpponentProof(config, state, snap, observed.receipt,
      watchdog.native.snapshot(), host, getHostIdentity());
  };
  const scope = (proof) => [proof.binding.gameId, proof.binding.documentId, proof.binding.ownerEpoch,
    proof.binding.hostRunId, proof.binding.configSha256, proof.binding.transportPath, proof.progressHash, nativeEpoch].join(':');
  const ownSeatPresent = (receipt) => receipt?.gameId === config.room.gameId && receipt.playerName === config.self.name &&
    receipt.seatPresent === true && receipt.ownSeatPreviouslyObserved === true &&
    ['games', 'newgame', 'updategame'].includes(receipt.source) && Number.isSafeInteger(receipt.ordinal) && receipt.ordinal >= 1;
  const reset = () => { since = null; continuity = null; };
  const observeNative = (raw, receipt) => {
    const contiguous = previousNativeReceipt === null ||
      (['documentId', 'ownerEpoch', 'transportPath'].every((key) => receipt[key] === previousNativeReceipt[key]) &&
        receipt.nativeSequence === previousNativeReceipt.nativeSequence + 1);
    previousNativeReceipt = { ...receipt };
    const opponentName = config.participants.find((name) => name !== config.self.name);
    const waiting = raw?.id === config.room.gameId && raw.started === true && raw.manualMode === false && !raw.winner &&
      same(Object.keys(raw.players ?? {}), config.participants) &&
      raw.players?.[config.self.name]?.disconnected === false && raw.players[config.self.name].left !== true &&
      raw.players?.[opponentName]?.disconnected === true &&
      ['waiting-for-opponent', 'opponent-turn'].includes(watchdogResponsibility(raw, config.self.name).reason);
    const key = waiting ? [receipt.documentId, receipt.ownerEpoch, receipt.transportPath, watchdogProgressHash(raw)].join(':') : null;
    if (!contiguous || waiting !== nativeWaiting || key !== nativeContinuity) {
      nativeEpoch++;
      nativeWaiting = waiting;
      nativeContinuity = key;
      reset();
    }
  };
  if (config.disconnectedOpponentExit?.enabled === true) {
    if (typeof watchdog.native?.subscribeNative !== 'function') observationBroken = true;
    else unsubscribeNative = watchdog.native.subscribeNative(observeNative, () => {
      observationBroken = true; nativeWaiting = false; nativeEpoch++; reset();
    });
  }
  const tick = async () => {
    if (closed || busy || attempted || config.disconnectedOpponentExit?.enabled !== true) return;
    busy = true;
    let monitor;
    try {
      const proof = await inspect();
      if (!proof || !nativeWaiting) { reset(); return; }
      const key = scope(proof);
      if (continuity !== key) { continuity = key; since = now(); }
      const observedForMs = now() - since;
      if (!Number.isFinite(observedForMs) || observedForMs < 0) { reset(); return; }
      if (observedForMs < config.disconnectedOpponentExit.waitMs) return;
      const notice = disconnectedNoLossNotice(config.self.name, proof.opponentName);
      const offer = await bounded(page.evaluate(disconnectedDepartureUi,
        { expectedOrigin: config.origin, notice, binding: proof.binding }));
      if (offer.allowed !== true || cancelled()) { reset(); return; }
      const deadline = now() + timeoutMs, remaining = () => Math.max(1, deadline - now());
      const fingerprint = operatorFingerprint();
      if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '')) fail('DISCONNECTED_EXIT_OPERATOR_INTENT_UNCONFIRMED');
      const unchanged = () => !cancelled() && operatorFingerprint() === fingerprint;
      monitor = await bounded(prepareSeatCheck(page, { origin: config.origin, gameId: config.room.gameId,
        playerName: config.self.name, timeoutMs: Math.min(60000, remaining()) }), remaining());
      const before = monitor.currentMembership();
      if (!ownSeatPresent(before) || !unchanged()) fail('DISCONNECTED_EXIT_INITIAL_SEAT_UNCONFIRMED');
      const current = await inspect();
      if (!current || scope(current) !== key || !unchanged() || now() >= deadline) {
        reset(); return;
      }
      const atLeave = monitor.currentMembership();
      if (!ownSeatPresent(atLeave)) fail('DISCONNECTED_EXIT_CURRENT_SEAT_UNCONFIRMED');
      const exit = state.disconnectedOpponentExit = {
        schema: 'kf-disconnected-opponent-exit-v1', reason: 'native-opponent-disconnected',
        origin: config.origin, gameId: config.room.gameId, playerName: config.self.name,
        participants: [...config.participants], opponentName: current.opponentName,
        phase: 'leave-intent-recorded', waitMs: config.disconnectedOpponentExit.waitMs,
        observedForMs: now() - since, observedSince: new Date(since).toISOString(), nativeDisconnectEpoch: nativeEpoch,
        noWinnerAtIntent: true, opponentDisconnectedAtIntent: true, ownActionAtIntent: false,
        noPendingGameplayAtIntent: true, noLossNoticeMatched: true, binding: current.binding,
        serverBeforeLeave: before, serverAtLeave: atLeave, leaveUiAttempts: 1,
        createdAt: new Date(now()).toISOString(),
      };
      attempted = true;
      save();
      if (!unchanged()) fail('DISCONNECTED_EXIT_OPERATOR_CHANGED');
      let action;
      try { action = await bounded(page.evaluate(disconnectedDepartureUi,
        { expectedOrigin: config.origin, notice, binding: current.binding, click: true }), Math.min(5000, remaining())); }
      catch { action = { attempted: true, clicked: false, outcome: 'unknown' }; }
      if (action.attempted === false && action.quarantineConfirmed !== true) {
        exit.phase = 'cancelled-before-leave'; exit.leaveUiAttempts = 0;
        exit.reasonCode = 'DISCONNECTED_EXIT_PAGE_CONTEXT_CHANGED';
        attempted = false; reset(); save(); return;
      }
      exit.leaveUiClicked = action.clicked === true;
      exit.quarantineConfirmed = action.quarantineConfirmed === true;
      exit.leaveUiOutcome = action.clicked ? 'clicked' : 'unknown';
      exit.nativeLeaveObserved = action.nativeLeaveObserved === true;
      exit.nativeLeaveOpcode = action.nativeLeaveOpcode ?? null;
      exit.phase = 'verifying-server-absence'; save();
      if (!unchanged()) fail('DISCONNECTED_EXIT_OPERATOR_CHANGED');
      const server = await bounded(monitor.verify({ timeoutMs: Math.min(20000, remaining()) }), remaining());
      exit.server = server;
      // Polling can flush after the UI callback returns. Read the separate, persisted departure
      // ledger after native absence; never infer a sent command from the button click alone.
      const afterLeave = await bounded(watchdog.snapshot(), Math.min(5000, remaining()));
      const ledger = afterLeave?.departureLedger;
      if (afterLeave?.operatorPaused !== false || afterLeave.unknownSend !== false ||
          ledger?.nativeLeaveObserved !== true || ledger.opcode !== 'game/leavegame' ||
          !['gameId', 'playerName', 'documentId', 'ownerEpoch', 'nativeSequence', 'frameToken', 'transportPath']
            .every((field) => ledger[field] === exit.binding[field]))
        fail('DISCONNECTED_EXIT_NATIVE_LEAVE_UNCONFIRMED');
      exit.nativeLeaveObserved = true; exit.nativeLeaveOpcode = ledger.opcode;
      exit.nativeLeaveObservedAt = ledger.observedAt;
      exit.phase = 'left-confirmed';
      if (!verifiedDisconnectedDeparture(exit, { origin: config.origin, gameId: config.room.gameId,
        playerName: config.self.name, participants: config.participants }) || !unchanged())
        fail('DISCONNECTED_EXIT_SERVER_ABSENCE_UNCONFIRMED');
      save();
      // The independent native absence is proven before any host/browser shutdown.
      closePeers();
      if (!unchanged()) fail('DISCONNECTED_EXIT_OPERATOR_CHANGED');
      const expectedHost = getHostIdentity();
      if (expectedHost.runId !== exit.binding.hostRunId || expectedHost.pid !== exit.binding.hostPid ||
          expectedHost.configSha256 !== exit.binding.configSha256)
        fail('DISCONNECTED_EXIT_HOST_CHANGED');
      const stopped = await bounded(stopHost(exit, expectedHost), Math.min(15000, remaining()));
      if (!unchanged() || stopped?.operatorIntervened || stopped?.operatorUnchanged?.() === false)
        fail('DISCONNECTED_EXIT_OPERATOR_CHANGED');
      if (stopped?.stopped !== true || stopped.runId !== expectedHost.runId || stopped.pid !== expectedHost.pid)
        fail('DISCONNECTED_EXIT_HOST_STOP_UNCONFIRMED');
      exit.hostStopped = true; exit.hostRetirementId = stopped.retirementId; save();
      const released = await bounded(releaseBrowser(), Math.min(15000, remaining()));
      if (!unchanged() || stopped?.operatorUnchanged?.() === false)
        fail('DISCONNECTED_EXIT_OPERATOR_CHANGED');
      if (released?.leaseReleased !== true) fail('DISCONNECTED_EXIT_BROWSER_RELEASE_UNCONFIRMED');
      exit.browserLeaseReleased = true; exit.phase = 'retired';
      exit.completedAt = new Date(now()).toISOString();
      state.runtimeRetired = true; state.phase = 'opponent-disconnected-left';
      afterRetired(); save(); close();
    } catch (error) {
      if (attempted) {
        const exit = state.disconnectedOpponentExit;
        exit.phase = 'blocked-preserved';
        exit.reasonCode = /^[A-Z0-9_-]+$/.test(error?.message ?? '') ? error.message : 'DISCONNECTED_EXIT_UNCONFIRMED';
        state.phase = 'opponent-disconnect-exit-unconfirmed';
        save();
      } else {
        state.disconnectedOpponentWait = { phase: 'inspection-deferred',
          reasonCode: /^[A-Z0-9_-]+$/.test(error?.message ?? '') ? error.message : 'DISCONNECTED_EXIT_INSPECTION_UNAVAILABLE',
          checkedAt: new Date(now()).toISOString() };
        reset(); save();
      }
    } finally {
      if (monitor) await bounded(monitor.close(), 3000).catch(() => {});
      busy = false;
    }
  };
  if (autoPoll && config.disconnectedOpponentExit?.enabled === true)
    interval = setInterval(() => void tick(), pollMs);
  return { tick, close, status: () => ({ closed, busy, attempted, disconnectedSince: since, continuity, nativeEpoch, observationBroken }) };
}
