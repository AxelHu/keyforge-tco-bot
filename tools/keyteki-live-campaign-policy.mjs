import { joinedPendingSeatReleased } from './keyteki-joined-pending-exit.mjs';
import { verifiedUnjoinedReconciliation } from './keyteki-unjoined-reconciliation-contract.mjs';
/** Pure planning/accounting for continuous one-seat play. No I/O, browser writes or socket sends. */
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 160) =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const millis = (value) => (typeof value === 'number' ? value : Date.parse(value ?? ''));
const namesEqual = (a, b) => [...a].sort().join('\0') === [...b].sort().join('\0');
const lastTime = (row) => millis(row.endedAt ?? row.completedAt ?? row.startedAt ?? row.at);
const reasonCode = (value) => (/^[A-Z0-9_-]{1,120}$/i.test(value ?? '') ? value : null);
const keyCount = (player) =>
  Array.isArray(player?.keys) &&
  player.keys.every((key) => ['red', 'blue', 'yellow'].includes(key)) &&
  new Set(player.keys).size === player.keys.length
    ? player.keys.length
    : null;
const knownOwnNames = [];

export const CAMPAIGN_POLICY_DEFAULTS = Object.freeze({
  listingMaxAgeMs: 30000,
  listingFutureToleranceMs: 1000,
  opponentCooldownMs: 30000,
  failedOpponentCooldownMs: 30 * 60 * 1000,
  missedRoomCooldownMs: 5 * 60 * 1000,
  earlyGames: 5,
  earlyFailures: 2,
  consecutiveFailures: 2,
  rollingGames: 10,
  rollingMinimum: 5,
  rollingFailureRate: 0.2,
  stableNaturalGames: 3,
  maxConsecutiveOpponent: 2,
});

/** The collector supplies local receive time, never a remote room clock. Revalidate at actual join. */
export function selectCampaignRoom(snapshot, options = {}) {
  const settings = { ...CAMPAIGN_POLICY_DEFAULTS, ...options },
    now = millis(options.now ?? Date.now()),
    observedAt = millis(snapshot?.observedAt),
    selfName = options.selfName,
    own = new Set([...knownOwnNames, selfName, ...(options.ownAccountNames ?? [])]);
  const empty = (reason) => ({ candidate: null, eligible: [], skipped: [], reason });
  if (!text(selfName) || !Number.isFinite(now)) return empty('invalid-planning-identity');
  const focusOpponentName = options.focusOpponentName ?? null;
  if (
    focusOpponentName !== null &&
    (typeof focusOpponentName !== 'string' ||
      !/^[A-Za-z0-9_-]{3,15}$/.test(focusOpponentName) ||
      own.has(focusOpponentName))
  )
    return empty('invalid-focus-opponent');
  if (
    snapshot?.source !== 'native-lobby' ||
    snapshot.nativeFullRoster !== true ||
    !Array.isArray(snapshot.rooms) ||
    !Number.isFinite(observedAt)
  )
    return empty('native-lobby-snapshot-required');
  if (now - observedAt > settings.listingMaxAgeMs || observedAt - now > settings.listingFutureToleranceMs)
    return empty('native-lobby-snapshot-not-fresh');
  const recent = (options.recentAttempts ?? []).filter(object);
  let preferred =
    focusOpponentName ??
    options.preferredOpponent ??
    [...recent]
      .reverse()
      .find(
        (row) =>
          row.canContinue === true &&
          row.technicalFailure === false &&
          ['natural', 'opponent-concession'].includes(row.outcome),
      )?.opponentName;
  const lastGames = recent.filter((row) => row.started).slice(-settings.maxConsecutiveOpponent);
  if (
    focusOpponentName === null &&
    lastGames.length >= settings.maxConsecutiveOpponent &&
    lastGames.every((row) => row.opponentName === preferred)
  )
    preferred = null;
  const duplicateIds = new Set(),
    counts = new Map();
  for (const row of snapshot.rooms) if (text(row?.id, 100)) counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const [id, count] of counts) if (count > 1) duplicateIds.add(id);
  const eligible = [],
    skipped = [];
  for (const raw of snapshot.rooms) {
    let reason = null;
    const id = text(raw?.id, 100) ? raw.id : null;
    const names = object(raw?.players) ? Object.keys(raw.players) : [];
    const opponentName = names.length === 1 ? names[0] : null;
    if (!object(raw) || !id || !text(raw.name, 100)) reason = 'room-identity-invalid';
    else if (duplicateIds.has(id)) reason = 'duplicate-room-id';
    else if (raw.started !== false || raw.gamePrivate !== false || raw.needsPassword !== false)
      reason = 'not-open-public-room';
    else if (raw.gameFormat !== 'normal' || !['beginner', 'casual'].includes(raw.gameType))
      reason = 'unsupported-room-format';
    else if (
      names.length !== 1 ||
      !text(opponentName) ||
      !object(raw.players[opponentName]) ||
      raw.players[opponentName].name !== opponentName ||
      raw.owner !== opponentName
    )
      reason = 'one-open-host-seat-required';
    else if (own.has(opponentName)) reason = 'owned-opponent';
    else if (focusOpponentName !== null && opponentName !== focusOpponentName)
      reason = 'not-focused-opponent';
    else if (raw.players[opponentName].left === true || raw.players[opponentName].disconnected === true)
      reason = 'host-not-present';
    else if (raw.joinable === false || raw.canJoin === false) reason = 'room-explicitly-not-joinable';
    else if (
      raw.observedAt !== undefined &&
      (!Number.isFinite(millis(raw.observedAt)) ||
        now - millis(raw.observedAt) > settings.listingMaxAgeMs ||
        millis(raw.observedAt) - now > settings.listingFutureToleranceMs)
    )
      reason = 'room-observation-not-fresh';
    const sameRoom = recent.filter((row) => row.gameId === id);
    if (!reason && sameRoom.length) {
      const previous = sameRoom.at(-1),
        at = lastTime(previous);
      if (previous.outcome !== 'matchmaking-miss' || previous.canContinue !== true)
        reason = 'room-already-attempted';
      else if (!Number.isFinite(at) || now - at < settings.missedRoomCooldownMs)
        reason = 'missed-room-cooldown';
    }
    const opponentRuns = recent.filter((row) => row.opponentName === opponentName);
    if (
      !reason &&
      opponentRuns.some(
        (row) =>
          row.technicalFailure === true &&
          (!Number.isFinite(lastTime(row)) || now - lastTime(row) < settings.failedOpponentCooldownMs),
      )
    )
      reason = 'failed-opponent-cooldown';
    if (
      !reason &&
      opponentRuns.some(
        (row) => Number.isFinite(lastTime(row)) && now - lastTime(row) < settings.opponentCooldownMs,
      )
    )
      reason = 'opponent-cooldown';
    if (reason) {
      skipped.push({ gameId: id, reason });
      continue;
    }
    const prior = opponentRuns.map(lastTime).filter(Number.isFinite);
    eligible.push({
      gameId: id,
      name: raw.name,
      opponentName,
      gameType: raw.gameType,
      gameFormat: 'normal',
      observedAt,
      preferredRematch: opponentName === preferred,
      previousOpponentAt: prior.length ? Math.max(...prior) : null,
    });
  }
  eligible.sort(
    (a, b) =>
      Number(b.preferredRematch) - Number(a.preferredRematch) ||
      (a.previousOpponentAt ?? -Infinity) - (b.previousOpponentAt ?? -Infinity) ||
      a.gameId.localeCompare(b.gameId),
  );
  return {
    candidate: eligible[0] ?? null,
    eligible,
    skipped,
    reason: eligible.length ? null : 'no-eligible-room',
  };
}

/** Only distinct, naturally finished and safely retired target games satisfy a focused quota. */
export function focusedCampaignProgress(
  records,
  { focusOpponentName = null, focusNaturalGameLimit = null } = {},
) {
  if (focusOpponentName === null) return null;
  const games = new Map();
  for (const row of Array.isArray(records) ? records : []) {
    if (
      row?.opponentName !== focusOpponentName ||
      !text(row.gameId, 150) ||
      row.finalized !== true ||
      row.started !== true ||
      row.terminal !== true ||
      row.natural !== true ||
      row.technicalFailure !== false ||
      row.canContinue !== true
    )
      continue;
    games.set(row.gameId, row);
  }
  const natural = [...games.values()];
  return {
    opponentName: focusOpponentName,
    naturalGameLimit: focusNaturalGameLimit,
    naturalGames: natural.length,
    wins: natural.filter((row) => row.won === true).length,
    losses: natural.filter((row) => row.won === false).length,
    remainingNaturalGames:
      focusNaturalGameLimit === null ? null : Math.max(0, focusNaturalGameLimit - natural.length),
    targetReached: focusNaturalGameLimit !== null && natural.length >= focusNaturalGameLimit,
    observedOpponentDeckUuids: [
      ...new Set(
        natural
          .map((row) => row.matchDetails?.players?.[focusOpponentName]?.deckUuid)
          .filter((value) => text(value, 100)),
      ),
    ].sort(),
  };
}

function finishedSeatReleased(exit, gameId, selfName) {
  const server = exit?.server;
  return (
    exit?.gameId === gameId &&
    exit.playerName === selfName &&
    exit.phase === 'left-confirmed' &&
    exit.serverSeatAbsent === true &&
    server?.gameId === gameId &&
    server.playerName === selfName &&
    server.serverSeatAbsent === true &&
    server.seatPresent === false &&
    server.ownSeatPreviouslyObserved === true &&
    ['games', 'newgame', 'updategame', 'removegame'].includes(server.source) &&
    Number.isSafeInteger(server.ordinal) &&
    server.ordinal >= 1
  );
}

function emptySeatReleased(receipt, gameId) {
  const native = receipt?.serverLeaveReceipt;
  return (
    receipt?.gameId === gameId &&
    receipt.status === 'no-opponent' &&
    receipt.noOpponentObserved === true &&
    receipt.serverLeaveConfirmed === true &&
    receipt.normalUiLeaveConfirmed === true &&
    native?.gameId === gameId &&
    native.nativeLeaveObserved === true &&
    ['cleargamestate', 'removegame', 'games', 'updategame'].includes(native.source)
  );
}

/** Classify only accepted public summaries and exact lifecycle receipts; chat is never a gameplay fault. */
export function classifyCampaignAttempt({
  handoff = {},
  noOpponent = null,
  watchdogEvents = [],
  selfName,
  origin = null,
  expectedGameId = null,
  exitCode = null,
  concessionEvidence = null,
  startedAt = null,
  endedAt = null,
  attemptId = null,
} = {}) {
  const gameId = expectedGameId ?? handoff.gameId ?? noOpponent?.gameId ?? null;
  const frame = handoff.finalPublicView;
  const frameNames = object(frame?.players) ? Object.keys(frame.players) : [];
  const participants = Array.isArray(handoff.participants) ? handoff.participants : frameNames;
  const identityValid =
    text(selfName) &&
    text(gameId, 150) &&
    (!handoff.gameId || handoff.gameId === gameId) &&
    (!frame ||
      (frame.gameId === gameId &&
        frame.playerName === selfName &&
        frameNames.length === 2 &&
        frameNames.includes(selfName) &&
        namesEqual(frameNames, participants)));
  const started =
    handoff.fullVerified === true ||
    handoff.gameStarted === true ||
    (identityValid && frame?.started === true);
  const terminal =
    identityValid &&
    handoff.finished === true &&
    frame?.started === true &&
    frameNames.includes(frame.winner);
  const winner = terminal ? frame.winner : null;
  const opponentName = participants.find((name) => name !== selfName) ?? null;
  const events = [
    ...(Array.isArray(handoff.watchdog?.events) ? handoff.watchdog.events : []),
    ...(Array.isArray(watchdogEvents) ? watchdogEvents : []),
  ].filter((event) => event?.gameId === gameId);
  const episode = handoff.watchdog?.episode;
  const concedeQueued = Boolean(
    episode?.concedeQueued === true ||
      episode?.concedeOutcome === 'unknown' ||
      events.some(
        (event) =>
          event.type === 'concede-attempted' &&
          (event.queued === true || ['native-queued', 'unknown'].includes(event.outcome)),
      ),
  );
  const reconciledUnjoined = Boolean(
    identityValid &&
      !started &&
      !frame &&
      !handoff.fullVerified &&
      !handoff.gameplayDiagnostics &&
      [handoff, handoff.stats, handoff.wireStats, handoff.gameplay, handoff.lastGameplayFault?.stats]
        .flatMap((scope) => [scope?.commands, scope?.queuedCommands])
        .every((value) => value === undefined || value === null || value === 0) &&
      verifiedUnjoinedReconciliation(handoff.unjoinedReconciliation, { gameId, selfName, attemptId }),
  );
  const originalOperatorPaused =
    handoff.operatorPaused === true || handoff.watchdog?.phase === 'operator-paused';
  const operatorPaused = originalOperatorPaused && !reconciledUnjoined;
  const faults = new Set();
  if (started && !operatorPaused && handoff.held === true)
    faults.add(reasonCode(handoff.holdReason) ?? 'OWN_GAMEPLAY_HELD');
  if (started && concedeQueued) faults.add('WATCHDOG_FAULT_CONCESSION');
  if (
    started &&
    !operatorPaused &&
    ['unsupported', 'error', 'send-not-confirmed', 'send-outcome-unknown'].includes(handoff.bridgeStatus) &&
    !terminal
  )
    faults.add('UNRESOLVED_GAMEPLAY_' + handoff.bridgeStatus.toUpperCase());
  const technicalFailure = faults.size > 0;
  const natural = terminal && keyCount(frame.players[winner]) === 3 && !technicalFailure;
  const concessionVerified =
    terminal &&
    concessionEvidence?.source === 'native-system-log' &&
    concessionEvidence.gameId === gameId &&
    concessionEvidence.playerName === opponentName &&
    winner === selfName;
  const miss = handoff.matchmakingMiss;
  const observedCommands = [
    handoff.gameplayDiagnostics?.stats?.commands,
    handoff.gameplayDiagnostics?.stats?.queuedCommands,
    handoff.lastGameplayFault?.stats?.commands,
    handoff.gameplay?.commands,
    handoff.wireStats?.commands,
    handoff.stats?.commands,
    handoff.commands,
  ].filter(Number.isFinite);
  const missValid =
    identityValid &&
    !started &&
    !frame &&
    object(miss) &&
    miss.serverSeatAbsent === true &&
    miss.nativeFullRoster === true &&
    miss.neverNativeActive === true &&
    miss.zeroGameplaySends === true &&
    miss.gameId === gameId &&
    miss.playerName === selfName &&
    observedCommands.every((n) => n === 0);
  const empty =
    identityValid &&
    !started &&
    !frame &&
    handoff.finishedNoOpponent === true &&
    emptySeatReleased(noOpponent, gameId);
  const joinedPending =
    identityValid &&
    !started &&
    !frame &&
    !operatorPaused &&
    !handoff.held &&
    !handoff.lastGameplayFault &&
    !handoff.evidenceWriteFailures &&
    !handoff.hostRestarts &&
    handoff.bridgeStatus == null &&
    [
      handoff.gameplayDiagnostics?.stats?.commands,
      handoff.gameplayDiagnostics?.stats?.queuedCommands,
      handoff.commands,
    ].every((n) => n === undefined || n === null || n === 0) &&
    observedCommands.every((n) => n === 0) &&
    joinedPendingSeatReleased(handoff.joinedPendingExit, { origin, gameId, selfName, participants });
  const seatReleased = terminal
    ? finishedSeatReleased(handoff.roomExit, gameId, selfName)
    : empty || missValid || joinedPending || reconciledUnjoined;
  const retired = handoff.runtimeRetired === true || reconciledUnjoined;
  const awaitingDriverExit =
    !reconciledUnjoined && (missValid || joinedPending) && retired && exitCode === null;
  const canContinue =
    identityValid &&
    !operatorPaused &&
    retired &&
    seatReleased &&
    (terminal || empty || reconciledUnjoined || ((missValid || joinedPending) && exitCode === 0)) &&
    (reconciledUnjoined || exitCode === null || exitCode === 0);
  let outcome;
  if (!identityValid) outcome = 'identity-unverified';
  else if (operatorPaused) outcome = 'operator-paused';
  else if (technicalFailure) outcome = 'technical-failure';
  else if (natural) outcome = 'natural';
  else if (concessionVerified) outcome = 'opponent-concession';
  else if (terminal) outcome = 'terminal-non-natural';
  else if (empty) outcome = 'no-opponent';
  else if (joinedPending) outcome = 'joined-pending-departure';
  else if (missValid || reconciledUnjoined) outcome = 'matchmaking-miss';
  else if (started) outcome = 'active-or-unresolved';
  else outcome = handoff.held === true || exitCode !== null ? 'setup-unresolved' : 'preparing';
  const finalized =
    !awaitingDriverExit &&
    (retired ||
      exitCode !== null ||
      operatorPaused ||
      handoff.roomExit?.phase === 'leave-unconfirmed' ||
      Boolean(handoff.finishRetirementError));
  const continuationBlock = canContinue
    ? null
    : operatorPaused
      ? 'operator-paused'
      : !identityValid
        ? 'identity-unverified'
        : awaitingDriverExit
          ? 'awaiting-driver-exit'
          : !seatReleased
            ? 'server-seat-release-unconfirmed'
            : !retired
              ? 'runtime-retirement-unconfirmed'
              : exitCode !== null && exitCode !== 0
                ? 'driver-exit-not-clean'
                : 'attempt-not-complete';
  return {
    attemptId,
    gameId,
    selfName,
    opponentName,
    startedAt,
    endedAt,
    outcome,
    started,
    terminal,
    winner,
    natural,
    technicalFailure,
    technicalReasons: [...faults].sort(),
    operatorPaused,
    ...(reconciledUnjoined
      ? { unjoinedReconciliation: handoff.unjoinedReconciliation, originalOperatorPaused }
      : {}),
    identityValid: Boolean(identityValid),
    ...(joinedPending ? { joinedPendingExit: handoff.joinedPendingExit } : {}),
    seatReleased: Boolean(seatReleased),
    runtimeRetired: retired,
    canContinue: Boolean(canContinue),
    finalized: Boolean(finalized),
    awaitingDriverExit,
    continuationBlock,
    won: terminal ? winner === selfName : null,
    keys: terminal
      ? Object.fromEntries(frameNames.map((name) => [name, keyCount(frame.players[name])]))
      : null,
    recoveredIncidents: new Set(
      events
        .filter((event) => event.type === 'recovery-started')
        .map((event) => String(event.at) + ':' + String(event.attempt)),
    ).size,
  };
}

/** Finalized records are append-only; re-reading a game cannot inflate either denominator. */
export function campaignHealth(records, overrides = {}) {
  const settings = { ...CAMPAIGN_POLICY_DEFAULTS, ...overrides };
  const rows = Array.isArray(records) ? records.filter(object) : [];
  const settled = rows.filter((row) => row.finalized === true);
  const latestByGame = new Map();
  for (const row of settled)
    if (row.started === true && text(row.gameId, 150)) latestByGame.set(row.gameId, row);
  const games = [...latestByGame.values()];
  const failures = (list) => list.filter((row) => row.technicalFailure === true).length;
  const early = games.slice(0, settings.earlyGames),
    rolling = games.slice(-settings.rollingGames);
  let consecutiveFailures = 0;
  for (const row of [...games].reverse()) {
    if (row.technicalFailure !== true) break;
    consecutiveFailures++;
  }
  const reasons = [];
  const unresolved = settled.find((row) => row.canContinue !== true);
  if (unresolved)
    reasons.push(unresolved.operatorPaused ? 'operator-paused' : 'unreleased-or-unresolved-attempt');
  if (failures(early) >= settings.earlyFailures) reasons.push('early-technical-failure-threshold');
  if (consecutiveFailures >= settings.consecutiveFailures)
    reasons.push('consecutive-technical-failure-threshold');
  const rollingFailures = failures(rolling),
    rate = rolling.length ? rollingFailures / rolling.length : null;
  if (rolling.length >= settings.rollingMinimum && rate >= settings.rollingFailureRate)
    reasons.push('rolling-technical-failure-rate');
  const naturalGames = games.filter((row) => row.natural === true && row.canContinue === true).length;
  const totalFailures = failures(games);
  const stable = reasons.length === 0 && totalFailures === 0 && naturalGames >= settings.stableNaturalGames;
  return {
    pause: reasons.length > 0,
    reasons,
    stable,
    phase: reasons.length ? 'paused' : stable ? 'stable-observed' : 'observation',
    completedGames: games.length,
    naturalGames,
    technicalFailures: totalFailures,
    consecutiveFailures,
    early: { games: early.length, failures: failures(early) },
    rolling: { games: rolling.length, failures: rollingFailures, errorRate: rate },
    waitingAttempts: settled.filter((row) =>
      ['no-opponent', 'joined-pending-departure'].includes(row.outcome),
    ).length,
    joinedPendingDepartures: settled.filter((row) => row.outcome === 'joined-pending-departure').length,
    matchmakingMisses: settled.filter((row) => row.outcome === 'matchmaking-miss').length,
    thresholds: {
      earlyGames: settings.earlyGames,
      earlyFailures: settings.earlyFailures,
      consecutiveFailures: settings.consecutiveFailures,
      rollingGames: settings.rollingGames,
      rollingMinimum: settings.rollingMinimum,
      rollingFailureRate: settings.rollingFailureRate,
      stableNaturalGames: settings.stableNaturalGames,
    },
  };
}
