/** Bounded cleanup of an exact room that we joined before its opponent departed. */
import { fuzhouSocketEvent } from './keyteki-fuzhou-ui.mjs';
import { exactSiteOrigin } from './site-origin.mjs';
import { readLobbyFromBrowser } from './keyteki-live-lobby.mjs';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const JOINED_PENDING_TIMINGS = Object.freeze({
  graceMs: 15000,
  pollMs: 1000,
  proofMs: 60000,
  ackMs: 5000,
  maxAgeMs: 30000,
});

/** This observer is additional evidence. It never relaxes PublicRoomObserver's existing guards. */
export function createJoinedPendingRoomTracker(config, { now = Date.now } = {}) {
  const self = config.self?.name,
    gameId = config.room?.gameId,
    opponent = config.room?.opponentName;
  const state = {
    joined: null,
    current: null,
    currentSource: null,
    currentObservedAt: null,
    ordinal: 0,
    departedAt: null,
    everStarted: false,
    blockedReason: null,
    continuity: null,
    leave: { attempts: 0, sent: 0, sentOrdinal: null, acknowledgement: null },
  };
  let epoch = 0,
    boundTransport = null,
    socketId = null,
    transportOrdinal = 0,
    upgradeOrdinal = null,
    expectedBrowserClose = false;
  const heartbeatWindows = new Map(),
    channels = new Map(),
    requests = new Map();
  const block = (reason) => {
    state.blockedReason ??= reason;
  };
  const stamp = () => ({ ordinal: ++state.ordinal, observedAt: now() });
  const transport = (meta = {}) => ({
    documentEpoch: meta.documentEpoch ?? epoch,
    transportKey: meta.transportKey ?? 'direct',
    transportKind: meta.transportKind ?? 'unknown',
    channelId: meta.channelId ?? null,
    requestId: meta.requestId ?? null,
    method: meta.method ?? null,
  });
  const observeTransport = (kind, value = {}) => {
    const meta = transport(value);
    if (meta.documentEpoch !== epoch || config.createPublic) return;
    const order = ++transportOrdinal;
    if (state.joined && meta.transportKey !== boundTransport) {
      block('JOINED_PENDING_TRANSPORT_CHANGED');
      return;
    }
    if (
      state.joined &&
      state.continuity?.kind === 'polling' &&
      kind === 'request-start' &&
      ![...requests.values()].some((r) => r.key === boundTransport && r.method === 'GET') &&
      now() - state.continuity.lastActivityAt > 2000
    )
      block('JOINED_PENDING_POLLING_INACTIVE');
    if (kind === 'socket-open') {
      channels.set(meta.channelId, { open: true, key: meta.transportKey, lastReceivedAt: null });
      if (
        state.joined &&
        state.continuity?.kind === 'websocket' &&
        state.continuity.channelId !== meta.channelId
      )
        block('JOINED_PENDING_SOCKET_REPLACED');
    } else if (kind === 'socket-close' || kind === 'socket-error') {
      const channel = channels.get(meta.channelId);
      if (channel) channel.open = false;
      if (state.joined && !expectedBrowserClose) block('JOINED_PENDING_TRANSPORT_CLOSED');
    } else if (kind === 'request-start') {
      requests.set(meta.requestId, { order, method: meta.method, key: meta.transportKey });
    } else if (kind === 'request-complete' || kind === 'request-failed') {
      const request = requests.get(meta.requestId);
      requests.delete(meta.requestId);
      // Engine.IO upgrades retire the old polling request after the new WebSocket is confirmed.
      const retiredPolling =
        state.continuity?.kind === 'websocket' &&
        channels.get(state.continuity.channelId)?.open &&
        request &&
        upgradeOrdinal !== null &&
        request.order < upgradeOrdinal;
      if (kind === 'request-failed' && state.joined && !retiredPolling && !expectedBrowserClose)
        block('JOINED_PENDING_POLLING_FAILED');
    }
  };
  const activity = (meta, { received = false, upgrade = false, native = false } = {}) => {
    if (!state.joined || meta.transportKey !== boundTransport) return;
    const source = state.continuity;
    if (Number.isFinite(source.silenceLimitMs) && now() - source.lastActivityAt > source.silenceLimitMs)
      block('JOINED_PENDING_TRANSPORT_SILENT');
    if (received) {
      source.lastActivityAt = now();
      const channel = channels.get(meta.channelId);
      if (channel) channel.lastReceivedAt = now();
    }
    if (
      meta.transportKind === 'websocket' &&
      (upgrade || (received && (native || source.kind === 'websocket')))
    ) {
      if (source.kind !== 'websocket') upgradeOrdinal = ++transportOrdinal;
      source.kind = 'websocket';
      source.channelId = meta.channelId;
    }
  };
  const checkContinuity = () => {
    const source = state.continuity;
    let reason = state.blockedReason;
    if (
      !reason &&
      (!state.joined ||
        !source ||
        !Number.isFinite(source.silenceLimitMs) ||
        !Number.isFinite(source.lastActivityAt))
    )
      reason = 'JOINED_PENDING_CONTINUITY_UNVERIFIED';
    if (!reason && (now() < source.lastActivityAt || now() - source.lastActivityAt > source.silenceLimitMs))
      reason = 'JOINED_PENDING_TRANSPORT_SILENT';
    if (!reason && source.kind === 'websocket' && !channels.get(source.channelId)?.open)
      reason = 'JOINED_PENDING_TRANSPORT_CLOSED';
    if (
      !reason &&
      source.kind === 'polling' &&
      ![...requests.values()].some((r) => r.key === boundTransport && r.method === 'GET') &&
      now() - source.lastActivityAt > 2000
    )
      reason = 'JOINED_PENDING_POLLING_INACTIVE';
    if (!reason && !['websocket', 'polling'].includes(source.kind))
      reason = 'JOINED_PENDING_CONTINUITY_UNVERIFIED';
    if (reason) {
      block(reason);
      fail(reason);
    }
    source.verified = true;
    source.checkedAt = now();
    return structuredClone(source);
  };

  const pending = (raw) => {
    if (
      !object(raw) ||
      raw.id !== gameId ||
      raw.name !== config.room.name ||
      raw.started !== false ||
      raw.gamePrivate !== false ||
      raw.needsPassword !== false ||
      raw.gameType !== config.room.gameType ||
      raw.gameFormat !== config.room.gameFormat ||
      !object(raw.players)
    )
      return null;
    const names = Object.keys(raw.players);
    if (
      names.length < 1 ||
      names.length > 2 ||
      names.some((name) => !object(raw.players[name]) || raw.players[name].name !== name) ||
      !names.includes(self) ||
      !names.includes(raw.owner)
    )
      return null;
    if (socketId && typeof raw.players[self].id === 'string' && raw.players[self].id !== socketId)
      return null;
    return {
      gameId,
      playerName: self,
      opponentName: opponent,
      participants: names,
      owner: typeof raw.owner === 'string' ? raw.owner : null,
      started: false,
      ownSelected: raw.players[self].deck?.selected === true,
      source: 'gamestate',
      ...stamp(),
    };
  };
  return {
    observeTransport,
    checkContinuity,
    expectOwnedBrowserClose() {
      checkContinuity();
      expectedBrowserClose = true;
    },
    documentChanged(nextEpoch) {
      if (nextEpoch === epoch) return;
      if (state.joined) block('JOINED_PENDING_DOCUMENT_CHANGED');
      epoch = nextEpoch;
      socketId = null;
    },
    ingest(
      payload,
      {
        sent = false,
        joinRequested = false,
        documentEpoch = epoch,
        transportKey = 'direct',
        transportKind = 'unknown',
        channelId = null,
        requestId = null,
      } = {},
    ) {
      if (config.createPublic || !gameId || !self || !opponent || documentEpoch !== epoch) return;
      const text =
        typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
      if (!text || text.length > 4 * 1024 * 1024) return;
      for (const part of text.split('\x1e')) {
        const meta = { documentEpoch, transportKey, transportKind, channelId, requestId };
        if (!sent && /^0\{/.test(part)) {
          try {
            const hello = JSON.parse(part.slice(1));
            if (state.joined) block('JOINED_PENDING_ENGINE_REPLACED');
            if (
              typeof hello.sid === 'string' &&
              Number.isSafeInteger(hello.pingInterval) &&
              hello.pingInterval > 0 &&
              Number.isSafeInteger(hello.pingTimeout) &&
              hello.pingTimeout > 0
            ) {
              const limit = Math.min(90000, hello.pingInterval + hello.pingTimeout);
              heartbeatWindows.set(transportKey, limit);
              heartbeatWindows.set(hello.sid, limit);
            }
          } catch {
            if (state.joined) block('JOINED_PENDING_ENGINE_REPLACED');
          }
          continue;
        }
        if (state.joined && ['1', '41'].includes(part)) {
          block('JOINED_PENDING_TRANSPORT_CLOSED');
          continue;
        }
        if (['2', '3', '2probe', '3probe', '5'].includes(part)) {
          if (state.joined && boundTransport !== transportKey) block('JOINED_PENDING_TRANSPORT_CHANGED');
          else activity(meta, { received: !sent, upgrade: sent && part === '5' });
          continue;
        }

        if (!sent && /^40\{/.test(part)) {
          try {
            const sid = JSON.parse(part.slice(2)).sid;
            if (
              state.joined &&
              (boundTransport !== transportKey || typeof sid !== 'string' || (socketId && sid !== socketId))
            )
              block('JOINED_PENDING_SOCKET_IDENTITY_CHANGED');
            if (typeof sid === 'string') socketId = sid;
          } catch {
            if (state.joined) block('JOINED_PENDING_SOCKET_IDENTITY_CHANGED');
          }
          continue;
        }
        const event = sent && part === '42["leavegame"]' ? ['leavegame'] : fuzhouSocketEvent(part);
        if (
          !event ||
          ![
            'leavegame',
            'gamestate',
            'cleargamestate',
            'games',
            'newgame',
            'updategame',
            'removegame',
          ].includes(event[0])
        )
          continue;
        if (typeof transportKey !== 'string' || !transportKey || transportKey === 'polling-unbound') {
          if (state.joined) block('JOINED_PENDING_TRANSPORT_CHANGED');
          continue;
        }
        if (state.joined && boundTransport !== transportKey) {
          block('JOINED_PENDING_TRANSPORT_CHANGED');
          continue;
        }
        activity(meta, { received: !sent, native: true });
        if (sent) {
          if (event[0] !== 'leavegame' || !state.joined) continue;
          if (
            state.leave.attempts !== 1 ||
            state.leave.sent ||
            state.current?.owner !== self ||
            !same(state.current?.participants ?? [], [self])
          ) {
            block('JOINED_PENDING_UNEXPECTED_LEAVE');
            continue;
          }
          state.leave.sent = 1;
          state.leave.sentOrdinal = stamp().ordinal;
          continue;
        }
        if (event[0] === 'gamestate' && object(event[1])) {
          const raw = event[1];
          if (raw.id !== gameId) {
            if (state.joined && Object.hasOwn(raw.players ?? {}, self))
              block('JOINED_PENDING_DIFFERENT_GAME');
            continue;
          }
          if (raw.started === true) {
            state.everStarted = true;
            if (state.departedAt !== null) block('JOINED_PENDING_GAME_STARTED');
            continue;
          }
          const current = pending(raw);
          if (!current) {
            if (state.joined) block('JOINED_PENDING_NATIVE_SHAPE_CHANGED');
            continue;
          }
          if (!state.joined) {
            if (!joinRequested || !same(current.participants, [self, opponent]) || current.owner !== opponent)
              continue;
            state.joined = { ...current, nativeTransportBound: true, documentEpoch: epoch };
            boundTransport = transportKey;
            if (transportKind === 'websocket') upgradeOrdinal ??= ++transportOrdinal;
            state.continuity = {
              kind: transportKind,
              channelId,
              lastActivityAt: now(),
              silenceLimitMs: heartbeatWindows.get(transportKey) ?? null,
              verified: false,
              checkedAt: null,
            };
          } else {
            if (state.currentSource === 'cleargamestate' || state.leave.acknowledgement)
              block('JOINED_PENDING_SEAT_REAPPEARED');
            if (state.departedAt !== null && current.participants.some((name) => name !== self))
              block('JOINED_PENDING_OTHER_SEAT');
            if (current.participants.some((name) => ![self, opponent].includes(name)))
              block('JOINED_PENDING_OTHER_SEAT');
          }
          state.current = current;
          state.currentSource = 'gamestate';
          state.currentObservedAt = current.observedAt;
          if (same(current.participants, [self])) {
            if (current.owner !== self) block('JOINED_PENDING_OWNER_CHANGED');
            state.departedAt ??= current.observedAt;
          }
          continue;
        }
        if (!state.joined) continue;
        if (event[0] === 'cleargamestate') {
          const next = stamp();
          state.current = null;
          state.currentSource = 'cleargamestate';
          state.currentObservedAt = next.observedAt;
          state.departedAt ??= next.observedAt;
          if (state.leave.sent === 1)
            state.leave.acknowledgement = { gameId, playerName: self, source: 'cleargamestate', ...next };
          continue;
        }
        if (['games', 'newgame', 'updategame', 'removegame'].includes(event[0]) && Array.isArray(event[1])) {
          for (const raw of event[1]) {
            if (!object(raw)) continue;
            if (raw.id !== gameId) {
              if (Object.hasOwn(raw.players ?? {}, self)) block('JOINED_PENDING_DIFFERENT_GAME');
              continue;
            }
            if (event[0] === 'removegame') {
              if (state.leave.sent === 1)
                state.leave.acknowledgement = { gameId, playerName: self, source: 'removegame', ...stamp() };
              continue;
            }
            if (raw.started === true) {
              state.everStarted = true;
              if (state.departedAt !== null) block('JOINED_PENDING_GAME_STARTED');
            }
            if (!object(raw.players)) {
              block('JOINED_PENDING_NATIVE_SHAPE_CHANGED');
              continue;
            }
            if (
              Object.keys(raw.players).some((name) => ![self, opponent].includes(name)) ||
              (state.departedAt !== null && Object.keys(raw.players).some((name) => name !== self))
            )
              block('JOINED_PENDING_OTHER_SEAT');
            if (
              (state.currentSource === 'cleargamestate' || state.leave.acknowledgement) &&
              Object.hasOwn(raw.players, self)
            )
              block('JOINED_PENDING_SEAT_REAPPEARED');
          }
        }
      }
    },
    beginLeave() {
      if (
        !state.joined ||
        state.blockedReason ||
        state.everStarted ||
        state.departedAt === null ||
        state.currentSource !== 'gamestate' ||
        state.current?.owner !== self ||
        !same(state.current?.participants ?? [], [self]) ||
        state.leave.attempts !== 0
      )
        fail('JOINED_PENDING_LEAVE_NOT_ELIGIBLE');
      state.leave.attempts = 1;
      return structuredClone(state.leave);
    },
    snapshot: () => structuredClone(state),
  };
}

function fullRosterProof(roster, config, now, maxAgeMs, present, notBefore = null) {
  if (
    !Number.isFinite(now) ||
    roster?.source !== 'native-lobby' ||
    roster.nativeFullRoster !== true ||
    roster.anonymous !== true ||
    roster.origin !== config.origin ||
    !Number.isFinite(roster.fullObservedAt) ||
    (notBefore !== null && (!Number.isFinite(notBefore) || roster.fullObservedAt < notBefore)) ||
    now - roster.fullObservedAt > maxAgeMs ||
    roster.fullObservedAt > now + 1000 ||
    !Array.isArray(roster.rooms) ||
    roster.rooms.some(
      (row) =>
        !object(row) ||
        typeof row.id !== 'string' ||
        !object(row.players) ||
        Object.entries(row.players).some(([name, value]) => !object(value) || value.name !== name),
    ) ||
    new Set(roster.rooms.map((row) => row.id)).size !== roster.rooms.length
  )
    fail('JOINED_PENDING_FRESH_FULL_ROSTER_REQUIRED');
  const exact = roster.rooms.find((room) => room.id === config.room.gameId);
  if (
    exact &&
    (exact.started !== false || Object.keys(exact.players).some((name) => name !== config.self.name))
  )
    fail('JOINED_PENDING_CURRENT_ROOM_CHANGED');
  const own = roster.rooms.filter((room) => Object.hasOwn(room.players, config.self.name));
  if (present) {
    if (
      own.length !== 1 ||
      own[0].id !== config.room.gameId ||
      own[0].started !== false ||
      own[0].owner !== config.self.name ||
      !same(Object.keys(own[0].players), [config.self.name])
    )
      fail('JOINED_PENDING_CURRENT_ROOM_NOT_OWN_ONLY');
  } else if (own.length) fail('JOINED_PENDING_ACCOUNT_STILL_SEATED');
  return roster;
}
const noGameplay = (state) =>
  !state.fullVerified &&
  !state.gameStarted &&
  !state.finished &&
  !state.finalPublicView &&
  !state.operatorPaused &&
  !state.held &&
  !state.lastGameplayFault &&
  !state.evidenceWriteFailures &&
  !state.hostRestarts &&
  !state.finishRetirementError &&
  state.bridgeStatus == null &&
  [
    state.gameplayDiagnostics?.stats?.commands,
    state.gameplayDiagnostics?.stats?.queuedCommands,
    state.commands,
  ].every((value) => value === undefined || value === null || value === 0);

/** The timer only starts a bounded exit after an observed departure; a present host is never timed out here. */
export function installJoinedPendingRoomExit({
  page,
  config,
  state,
  tracker,
  hostIdentity,
  inspectHost,
  stopHost,
  release,
  quiesce = () => {},
  afterRetired = () => {},
  save = () => {},
  externalCancellation = () => false,
  probe = readLobbyFromBrowser,
  now = Date.now,
  wait = pause,
  timings = JOINED_PENDING_TIMINGS,
  autoPoll = true,
}) {
  let closed = false,
    busy = false,
    attempted = false,
    interval;
  const close = () => {
    closed = true;
    clearInterval(interval);
  };
  const guard = ({ current = 'either', afterStop = false } = {}) => {
    tracker.checkContinuity();
    const snap = tracker.snapshot();
    if (
      closed ||
      !noGameplay(state) ||
      (!afterStop && externalCancellation()) ||
      !snap.joined ||
      snap.everStarted ||
      snap.blockedReason ||
      snap.departedAt === null
    )
      fail(snap.blockedReason ?? 'JOINED_PENDING_RUNTIME_CHANGED');
    if (
      new URL(page.url()).origin !== config.origin ||
      !Number.isFinite(snap.currentObservedAt) ||
      snap.currentObservedAt < snap.joined.observedAt ||
      snap.currentObservedAt > now() + 1000
    )
      fail('JOINED_PENDING_CURRENT_NATIVE_STATE_REQUIRED');
    if (snap.currentSource === 'gamestate') {
      if (
        current === 'cleared' ||
        snap.current?.gameId !== config.room.gameId ||
        snap.current.owner !== config.self.name ||
        !same(snap.current.participants, [config.self.name])
      )
        fail('JOINED_PENDING_CURRENT_ROOM_NOT_OWN_ONLY');
    } else if (snap.currentSource !== 'cleargamestate' || snap.current !== null || current === 'own')
      fail('JOINED_PENDING_CURRENT_NATIVE_STATE_REQUIRED');
    return snap;
  };
  const status = async () => {
    if (
      !Number.isSafeInteger(hostIdentity?.pid) ||
      hostIdentity.pid <= 0 ||
      !/^[a-f0-9]{32}$/.test(hostIdentity.runId ?? '')
    )
      fail('JOINED_PENDING_HOST_IDENTITY_REQUIRED');
    const result = await inspectHost();
    guard();
    if (
      result?.runId !== hostIdentity.runId ||
      result.pid !== hostIdentity.pid ||
      result.paused === true ||
      result.stopping === true ||
      !Array.isArray(result.sessions) ||
      result.sessions.length
    )
      fail('JOINED_PENDING_HOST_NOT_IDLE');
    return { runId: result.runId, pid: result.pid, sessionCount: 0, observedAt: now() };
  };
  const phase = (value) => {
    state.joinedPendingExit.phase = value;
    save();
  };
  const tick = async () => {
    if (closed || busy || attempted) return;
    const initial = tracker.snapshot();
    if (!initial.joined || initial.departedAt === null) {
      if (state.fullVerified || initial.everStarted) close();
      return;
    }
    if (now() - initial.departedAt < timings.graceMs) return;
    busy = true;
    attempted = true;
    state.joinedPendingExit = {
      schema: 'keyteki-joined-pending-exit-v1',
      phase: 'checking',
      gameId: config.room.gameId,
      playerName: config.self.name,
      opponentName: config.room.opponentName,
      startedAt: now(),
      joined: initial.joined,
      uiLeaveAttempts: 0,
      nativeLeaveSends: 0,
    };
    const result = state.joinedPendingExit;
    try {
      guard();
      save();
      result.hostBefore = await status();
      const beforeProbeStartedAt = now();
      const before = await probe(page.context().browser(), {
        origin: config.origin,
        timeoutMs: timings.proofMs,
      });
      let current = guard();
      const wasOwn = current.currentSource === 'gamestate';
      fullRosterProof(before, config, now(), timings.maxAgeMs, wasOwn, beforeProbeStartedAt);
      result.before = {
        native: current,
        roster: before,
        probeStartedAt: beforeProbeStartedAt,
        verifiedAt: now(),
      };
      if (wasOwn) {
        result.route = 'single-native-leave';
        const leave = page.getByRole('button', { name: '离开', exact: true });
        if (!(await leave.isVisible()) || !(await leave.isEnabled()))
          fail('JOINED_PENDING_LEAVE_UI_NOT_READY');
        result.hostBeforeLeave = await status();
        fullRosterProof(before, config, now(), timings.maxAgeMs, true, beforeProbeStartedAt);
        current = guard({ current: 'own' });
        tracker.beginLeave();
        result.leaveIntent = { recordedAt: now(), nativeOrdinal: current.current.ordinal, attempts: 1 };
        phase('leave-intent-recorded');
        guard({ current: 'own' });
        result.uiLeaveAttempts = 1;
        result.phase = 'leaving';
        try {
          await leave.click({ timeout: timings.ackMs });
        } catch {
          result.uiClickUnconfirmed = true;
        }
        const deadline = now() + timings.ackMs;
        while (now() < deadline) {
          current = guard();
          if (
            current.leave.sent === 1 &&
            current.leave.acknowledgement &&
            current.currentSource === 'cleargamestate'
          )
            break;
          await wait(Math.min(100, Math.max(1, deadline - now())));
        }
        current = guard({ current: 'cleared' });
        result.nativeLeaveSends = current.leave.sent;
        if (
          current.leave.sent !== 1 ||
          !current.leave.acknowledgement ||
          current.leave.acknowledgement.ordinal <= current.leave.sentOrdinal
        )
          fail('JOINED_PENDING_LEAVE_UNCONFIRMED');
        result.nativeLeave = current.leave;
      } else {
        result.route = 'external-clear';
        if (current.leave.attempts || current.leave.sent)
          fail('JOINED_PENDING_EXTERNAL_CLEAR_AFTER_LEAVE_ATTEMPT');
      }
      phase('verifying-account-absence');
      const absenceProbeStartedAt = now();
      const absent = await probe(page.context().browser(), {
        origin: config.origin,
        timeoutMs: timings.proofMs,
      });
      guard({ current: 'cleared' });
      fullRosterProof(absent, config, now(), timings.maxAgeMs, false, absenceProbeStartedAt);
      result.after = {
        native: tracker.snapshot(),
        roster: absent,
        probeStartedAt: absenceProbeStartedAt,
        verifiedAt: now(),
      };
      result.wholeAccountAbsent = true;
      result.hostBeforeRetirement = await status();
      guard({ current: 'cleared' });
      phase('stopping-host');
      await quiesce();
      guard({ current: 'cleared' });
      const stopped = await stopHost();
      guard({ current: 'cleared', afterStop: true });
      if (stopped?.stopped !== true || stopped.runId !== hostIdentity.runId)
        fail('JOINED_PENDING_HOST_STOP_UNCONFIRMED');
      result.hostStopped = { runId: stopped.runId, pid: hostIdentity.pid, stopped: true };
      phase('releasing-browser');
      guard({ current: 'cleared', afterStop: true });
      tracker.expectOwnedBrowserClose();
      const released = await release();
      if (
        state.operatorPaused ||
        !noGameplay(state) ||
        tracker.snapshot().blockedReason ||
        tracker.snapshot().everStarted ||
        released?.leaseReleased !== true ||
        released.managed !== true
      )
        fail('JOINED_PENDING_BROWSER_RELEASE_UNCONFIRMED');
      result.browserReleased = released;
      afterRetired();
      result.neverNativeActive = true;
      result.zeroGameplaySends = true;
      result.completedAt = now();
      result.phase = 'retired';
      state.runtimeRetired = true;
      state.phase = 'joined-pending-retired';
      close();
      save();
    } catch (error) {
      result.phase = 'blocked-preserved';
      result.reason = /^[A-Z0-9_]+$/.test(error?.code ?? '')
        ? error.code
        : 'JOINED_PENDING_RETIREMENT_UNCONFIRMED';
      result.nativeLeaveSends = tracker.snapshot().leave.sent;
      result.observedNative = tracker.snapshot();
      close();
      save();
    } finally {
      busy = false;
    }
  };
  if (autoPoll) interval = setInterval(() => void tick().catch(() => close()), timings.pollMs);
  return { tick, close };
}

/** Validation used by classification; no automatic success is inferred from UI disappearance. */
export function joinedPendingSeatReleased(receipt, { origin, gameId, selfName, participants }) {
  try {
    exactSiteOrigin(origin);
  } catch {
    return false;
  }
  if (
    receipt?.schema !== 'keyteki-joined-pending-exit-v1' ||
    receipt.phase !== 'retired' ||
    receipt.gameId !== gameId ||
    receipt.playerName !== selfName ||
    !Array.isArray(participants) ||
    participants.length !== 2 ||
    new Set(participants).size !== 2 ||
    receipt.opponentName === selfName ||
    !same(participants, [selfName, receipt.opponentName]) ||
    receipt.joined?.gameId !== gameId ||
    receipt.joined.playerName !== selfName ||
    receipt.joined.opponentName !== receipt.opponentName ||
    receipt.joined.started !== false ||
    receipt.joined.source !== 'gamestate' ||
    receipt.joined.nativeTransportBound !== true ||
    !same(receipt.joined.participants ?? [], participants) ||
    receipt.neverNativeActive !== true ||
    receipt.zeroGameplaySends !== true ||
    receipt.wholeAccountAbsent !== true ||
    receipt.hostBefore?.sessionCount !== 0 ||
    receipt.hostBeforeRetirement?.sessionCount !== 0 ||
    receipt.hostStopped?.stopped !== true ||
    receipt.hostStopped.runId !== receipt.hostBefore.runId ||
    receipt.hostStopped.runId !== receipt.hostBeforeRetirement.runId ||
    receipt.hostStopped.pid !== receipt.hostBefore.pid ||
    receipt.hostStopped.pid !== receipt.hostBeforeRetirement.pid ||
    receipt.browserReleased?.leaseReleased !== true ||
    receipt.browserReleased.managed !== true ||
    receipt.after?.native?.current !== null ||
    receipt.after.native.currentSource !== 'cleargamestate' ||
    receipt.after.native.everStarted !== false ||
    receipt.after.native.blockedReason !== null
  )
    return false;
  if (
    !Number.isFinite(receipt.completedAt) ||
    !Number.isFinite(receipt.startedAt) ||
    receipt.completedAt < receipt.startedAt ||
    !/^[a-f0-9]{32}$/.test(receipt.hostStopped.runId ?? '') ||
    !Number.isSafeInteger(receipt.hostStopped.pid) ||
    receipt.hostStopped.pid <= 0 ||
    receipt.joined.owner !== receipt.opponentName ||
    !Number.isSafeInteger(receipt.joined.ordinal) ||
    receipt.joined.ordinal < 1
  )
    return false;
  const before = receipt.before?.native,
    after = receipt.after.native;
  if (
    !before ||
    before.joined?.gameId !== gameId ||
    before.joined?.ordinal !== receipt.joined.ordinal ||
    before.everStarted !== false ||
    before.blockedReason !== null ||
    !Number.isFinite(after.currentObservedAt) ||
    !Number.isSafeInteger(after.ordinal) ||
    after.ordinal <= receipt.joined.ordinal ||
    !Number.isFinite(after.departedAt) ||
    after.departedAt > receipt.completedAt
  )
    return false;
  if (
    receipt.route === 'external-clear' &&
    (before.current !== null || before.currentSource !== 'cleargamestate')
  )
    return false;
  if (
    receipt.route === 'single-native-leave' &&
    (before.currentSource !== 'gamestate' ||
      before.current?.gameId !== gameId ||
      before.current.owner !== selfName ||
      before.current.started !== false ||
      !same(before.current.participants ?? [], [selfName]))
  )
    return false;
  if (
    before.continuity?.verified !== true ||
    after.continuity?.verified !== true ||
    !['websocket', 'polling'].includes(after.continuity.kind) ||
    !Number.isFinite(receipt.after.probeStartedAt) ||
    !Number.isFinite(receipt.after.verifiedAt) ||
    receipt.after.verifiedAt < receipt.after.probeStartedAt ||
    receipt.after.verifiedAt > receipt.completedAt ||
    receipt.after.probeStartedAt < receipt.startedAt
  )
    return false;
  const roster = receipt.after.roster;
  try {
    fullRosterProof(
      roster,
      { origin, self: { name: selfName }, room: { gameId } },
      receipt.after.verifiedAt,
      JOINED_PENDING_TIMINGS.maxAgeMs,
      false,
      receipt.after.probeStartedAt,
    );
  } catch {
    return false;
  }
  if (receipt.route === 'external-clear')
    return (
      receipt.uiLeaveAttempts === 0 &&
      receipt.nativeLeaveSends === 0 &&
      receipt.after.native.leave.attempts === 0 &&
      receipt.after.native.leave.sent === 0 &&
      receipt.after.native.leave.acknowledgement === null
    );
  return (
    receipt.route === 'single-native-leave' &&
    receipt.leaveIntent?.attempts === 1 &&
    Number.isSafeInteger(receipt.leaveIntent.nativeOrdinal) &&
    receipt.leaveIntent.nativeOrdinal >= receipt.joined.ordinal &&
    receipt.hostBeforeLeave?.sessionCount === 0 &&
    receipt.hostBeforeLeave.runId === receipt.hostStopped.runId &&
    receipt.hostBeforeLeave.pid === receipt.hostStopped.pid &&
    receipt.uiLeaveAttempts === 1 &&
    receipt.nativeLeaveSends === 1 &&
    receipt.nativeLeave?.attempts === 1 &&
    receipt.nativeLeave.sent === 1 &&
    receipt.nativeLeave.acknowledgement?.gameId === gameId &&
    receipt.nativeLeave.acknowledgement.playerName === selfName &&
    ['cleargamestate', 'removegame'].includes(receipt.nativeLeave.acknowledgement.source) &&
    Number.isSafeInteger(receipt.nativeLeave.sentOrdinal) &&
    receipt.nativeLeave.sentOrdinal > receipt.leaveIntent.nativeOrdinal &&
    receipt.after.native.ordinal >= receipt.nativeLeave.acknowledgement.ordinal &&
    receipt.nativeLeave.acknowledgement.ordinal > receipt.nativeLeave.sentOrdinal
  );
}
