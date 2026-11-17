/** Normal post-game UI leave with independent server membership readback. */
import { fuzhouSocketEvent } from './keyteki-fuzhou-ui.mjs';
import { keytekiUiButton } from './keyteki-ui-contract.mjs';
import { waitForFinishedChat, FINISHED_CHAT_DRAIN_MS } from './keyteki-finished-chat-drain.mjs';

const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('FINISHED_LEAVE_TIMEOUT')), Math.max(1, ms));
    }),
  ]).finally(() => clearTimeout(timer));
};
const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const winnerName = (raw) => (typeof raw?.winner === 'string' ? raw.winner : raw?.winner?.name);
const lobbyUrl = (value, origin) => {
  try {
    const url = new URL(value);
    if (url.protocol === 'ws:') url.protocol = 'http:';
    if (url.protocol === 'wss:') url.protocol = 'https:';
    return url.origin === origin && /^\/socket\.io\/?$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
};

/** Only a complete native roster or an exact room update/removal proves seat absence. */
export function createFinishedRoomMembership({ gameId, playerName }) {
  let receipt = null;
  let ordinal = 0;
  let ownSeatPreviouslyObserved = false;
  return {
    ingest(payload) {
      const text =
        typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
      if (text.length > 4 * 1024 * 1024) return;
      for (const part of text.split('\x1e')) {
        const event = fuzhouSocketEvent(part);
        if (
          !event ||
          !['games', 'newgame', 'updategame', 'removegame'].includes(event[0]) ||
          !Array.isArray(event[1])
        )
          continue;
        const [kind, rows] = event;
        const targets = rows.filter((row) => object(row) && row.id === gameId);
        if (targets.length > 1) continue;
        if (kind === 'removegame') {
          if (targets.length === 1 && ownSeatPreviouslyObserved)
            receipt = {
              gameId,
              playerName,
              seatPresent: false,
              ownSeatPreviouslyObserved,
              source: kind,
              ordinal: ++ordinal,
            };
          continue;
        }
        if (
          kind === 'games' &&
          rows.some((row) => !object(row) || typeof row.id !== 'string' || !object(row.players))
        )
          continue;
        if (!targets.length) {
          if (kind === 'games')
            receipt = {
              gameId,
              playerName,
              seatPresent: ownSeatPreviouslyObserved ? false : null,
              ownSeatPreviouslyObserved,
              source: kind,
              ordinal: ++ordinal,
            };
          continue;
        }
        const target = targets[0];
        if (
          !object(target.players) ||
          Object.entries(target.players).some(([name, player]) => !object(player) || player.name !== name)
        )
          continue;
        ownSeatPreviouslyObserved ||= Object.hasOwn(target.players, playerName);
        receipt = {
          gameId,
          playerName,
          seatPresent: Object.hasOwn(target.players, playerName),
          ownSeatPreviouslyObserved,
          source: kind,
          ordinal: ++ordinal,
        };
      }
    },
    snapshot: () => (receipt ? { ...receipt } : null),
  };
}

/** Fixed diagnostic vocabulary: never persist raw errors, URLs, cookies, headers or frame payloads. */
function membershipProbeError(error, stage, elapsedMs, deadlineReached) {
  const name = ['Error', 'TimeoutError', 'TypeError', 'AbortError', 'TargetClosedError'].includes(error?.name)
    ? error.name
    : 'Error';
  const message = typeof error?.message === 'string' ? error.message : '';
  const net = /net::(ERR_[A-Z0-9_]{1,48})\b/.exec(message)?.[1] ?? null;
  const knownCodes = new Set([
    'FINISHED_LEAVE_TIMEOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
  ]);
  const code = knownCodes.has(error?.code)
    ? error.code
    : message === 'FINISHED_LEAVE_TIMEOUT'
      ? 'FINISHED_LEAVE_TIMEOUT'
      : net;
  const category =
    name === 'TimeoutError' || ['FINISHED_LEAVE_TIMEOUT', 'ETIMEDOUT'].includes(code)
      ? 'timeout'
      : name === 'AbortError' || code === 'ERR_ABORTED'
        ? 'aborted'
        : name === 'TargetClosedError' ||
            /(?:page, context or browser has been closed|browser has been closed|connection closed)/i.test(
              message,
            )
          ? 'browser-closed'
          : code
            ? 'transport-error'
            : 'operation-error';
  return { stage, name, category, code, elapsedMs, deadlineReached };
}

/** A new anonymous context cannot take over either authenticated player's connection. */
export async function beginFinishedRoomSeatCheck(page, { origin, gameId, playerName, timeoutMs = 60000 }) {
  const started = Date.now(),
    deadline = started + timeoutMs;
  const observed = createFinishedRoomMembership({ gameId, playerName });
  const remaining = () => Math.max(1, deadline - Date.now());
  const elapsed = () => Math.max(0, Date.now() - started);
  const diagnostic = {
    schema: 'keyteki-membership-probe-diagnostics-v1',
    startedAt: new Date(started).toISOString(),
    setupBudgetMs: timeoutMs,
    phase: 'creating-context',
    failed: false,
    timings: {},
    network: {
      lobbySockets: 0,
      lobbyFrames: 0,
      pollingResponses: 0,
      pollingBodyFailures: 0,
      pollingHttpStatuses: {},
      lobbyRequestFailures: 0,
      navigationHttpStatus: null,
    },
    page: {
      sameOriginScriptRequests: 0,
      sameOriginScriptResponses: 0,
      sameOriginScriptCompletions: 0,
      sameOriginScriptFailures: 0,
      errors: 0,
    },
    native: {
      acceptedReceipts: 0,
      firstReceiptMs: null,
      lastSource: null,
      lastSeatPresent: null,
      ownSeatPreviouslyObserved: false,
    },
  };
  const diagnostics = () => structuredClone({ ...diagnostic, elapsedMs: elapsed() });
  let context,
    abandoned = false,
    expectedEpoch = 0,
    documentEpoch = 0,
    lastAcceptedEpoch = 0,
    lastFullReceipt = null,
    verifyUntil = null,
    refreshAttempted = false;
  const requestEpochs = new WeakMap();
  // Count only fixed categories/times; never retain asset URLs, query strings or error text.
  const sameOriginScript = (request) => {
    try {
      return request.resourceType?.() === 'script' && new URL(request.url()).origin === origin;
    } catch {
      return false;
    }
  };
  const pageEvent = (key, timing) => {
    if (abandoned || diagnostic.pageClosed) return;
    diagnostic.page[key] = Math.min(10000, diagnostic.page[key] + 1);
    if (timing) diagnostic.timings[timing] ??= elapsed();
  };
  const ingest = (payload, epoch = 0) => {
    if (
      abandoned ||
      diagnostic.pageClosed ||
      epoch !== expectedEpoch ||
      (refreshAttempted && Date.now() >= verifyUntil)
    ) {
      diagnostic.native.ignoredRetiredPackets = Math.min(
        10000,
        (diagnostic.native.ignoredRetiredPackets ?? 0) + 1,
      );
      return;
    }
    const text =
      typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : '';
    if (!text || text.length > 4 * 1024 * 1024) return;
    // Polling can bundle a full roster and later deltas in one HTTP body. Retain the full
    // witness while allowing the final membership snapshot to veto a subsequent reappearance.
    for (const part of text.split('\x1e')) {
      const before = observed.snapshot();
      observed.ingest(part);
      const after = observed.snapshot();
      if (after && after.ordinal !== before?.ordinal) {
        diagnostic.native.acceptedReceipts = Math.min(10000, diagnostic.native.acceptedReceipts + 1);
        diagnostic.native.firstReceiptMs ??= elapsed();
        diagnostic.native.lastSource = after.source;
        diagnostic.native.lastSeatPresent = after.seatPresent;
        diagnostic.native.ownSeatPreviouslyObserved = after.ownSeatPreviouslyObserved;
        diagnostic.native.lastDocumentEpoch = epoch;
        lastAcceptedEpoch = epoch;
        if (after.source === 'games') {
          lastFullReceipt = after;
          if (refreshAttempted) {
            diagnostic.refresh.freshRosterObservedMs = elapsed();
            diagnostic.refresh.freshRosterOrdinal = after.ordinal;
            diagnostic.refresh.freshRosterSeatPresent = after.seatPresent;
          }
        }
      }
    }
  };
  const close = async () => {
    abandoned = true;
    diagnostic.timings.closeRequestedMs ??= elapsed();
    if (context) {
      try {
        await bounded(context.close(), 1000);
        diagnostic.contextCloseConfirmed = true;
      } catch (error) {
        diagnostic.contextCloseConfirmed = false;
        diagnostic.closeError = membershipProbeError(
          error,
          'closing-context',
          elapsed(),
          Date.now() >= deadline,
        );
      }
    }
    diagnostic.timings.closedMs = elapsed();
  };
  try {
    // Keep synchronous acquisition failures inside this phase's bounded diagnostic receipt too.
    const creating = Promise.resolve().then(() => page.context().browser().newContext());
    void creating
      .then((created) => {
        if (abandoned) {
          diagnostic.lateContextCleanupRequested = true;
          void bounded(created.close(), 1000)
            .then(() => {
              diagnostic.lateContextCleanupConfirmed = true;
            })
            .catch((error) => {
              diagnostic.lateContextCleanupConfirmed = false;
              diagnostic.lateCloseError = membershipProbeError(
                error,
                'closing-late-context',
                elapsed(),
                Date.now() >= deadline,
              );
            });
        }
      })
      .catch(() => {});
    context = await bounded(creating, remaining());
    diagnostic.timings.contextCreatedMs = elapsed();
    diagnostic.phase = 'creating-page';
    const probe = await bounded(context.newPage(), remaining());
    diagnostic.timings.pageCreatedMs = elapsed();
    diagnostic.phase = 'installing-observers';
    probe.on('close', () => {
      diagnostic.pageClosed = true;
    });
    probe.on('domcontentloaded', () => {
      if (!abandoned) diagnostic.timings.domContentLoadedMs ??= elapsed();
    });
    probe.on('load', () => {
      if (!abandoned) diagnostic.timings.documentLoadMs ??= elapsed();
    });
    probe.on('pageerror', () => pageEvent('errors'));
    probe.on('framenavigated', (frame) => {
      if (!diagnostic.refresh?.navigationPending || frame !== probe.mainFrame()) return;
      let sameLobby = false;
      try {
        const url = new URL(frame.url());
        sameLobby = url.origin === origin && url.pathname === '/play' && !url.search && !url.hash;
      } catch {}
      if (!sameLobby) {
        diagnostic.refresh.unexpectedNavigation = true;
        return;
      }
      documentEpoch = expectedEpoch;
      diagnostic.refresh.documentObserved = true;
      diagnostic.refresh.documentObservedMs = elapsed();
    });
    probe.on('websocket', (socket) => {
      if (!lobbyUrl(socket.url(), origin)) return;
      const epoch = documentEpoch;
      diagnostic.network.lobbySockets = Math.min(10000, diagnostic.network.lobbySockets + 1);
      socket.on('framereceived', ({ payload }) => {
        diagnostic.network.lobbyFrames = Math.min(10000, diagnostic.network.lobbyFrames + 1);
        ingest(payload, epoch);
      });
    });
    probe.on('request', (request) => {
      if (sameOriginScript(request)) pageEvent('sameOriginScriptRequests', 'firstSameOriginScriptRequestMs');
      if (lobbyUrl(request.url(), origin) && request.method() === 'GET')
        requestEpochs.set(request, documentEpoch);
    });
    probe.on('requestfinished', (request) => {
      if (sameOriginScript(request))
        pageEvent('sameOriginScriptCompletions', 'firstSameOriginScriptCompletedMs');
    });
    probe.on('requestfailed', (request) => {
      if (sameOriginScript(request)) pageEvent('sameOriginScriptFailures', 'firstSameOriginScriptFailureMs');
      if (!lobbyUrl(request.url(), origin)) return;
      diagnostic.network.lobbyRequestFailures = Math.min(10000, diagnostic.network.lobbyRequestFailures + 1);
      diagnostic.network.lastLobbyRequestFailure = membershipProbeError(
        { name: 'Error', message: request.failure()?.errorText },
        'lobby-request',
        elapsed(),
        Date.now() >= deadline,
      );
    });
    probe.on('response', (response) => {
      if (sameOriginScript(response.request()))
        pageEvent('sameOriginScriptResponses', 'firstSameOriginScriptResponseMs');
      const url = lobbyUrl(response.url(), origin);
      if (!url || url.searchParams.get('transport') !== 'polling' || response.request().method() !== 'GET')
        return;
      // Bind the asynchronous body to its request's document, not the document current at resolution.
      const epoch = requestEpochs.get(response.request()) ?? (expectedEpoch === 0 ? 0 : -1);
      diagnostic.network.pollingResponses = Math.min(10000, diagnostic.network.pollingResponses + 1);
      const status = response.status();
      if (
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599 &&
        (Object.hasOwn(diagnostic.network.pollingHttpStatuses, status) ||
          Object.keys(diagnostic.network.pollingHttpStatuses).length < 8)
      )
        diagnostic.network.pollingHttpStatuses[status] = Math.min(
          10000,
          (diagnostic.network.pollingHttpStatuses[status] ?? 0) + 1,
        );
      void bounded(response.text(), 5000)
        .then((payload) => ingest(payload, epoch))
        .catch((error) => {
          diagnostic.network.pollingBodyFailures = Math.min(
            10000,
            diagnostic.network.pollingBodyFailures + 1,
          );
          diagnostic.network.lastPollingBodyFailure = membershipProbeError(
            error,
            'polling-body',
            elapsed(),
            Date.now() >= deadline,
          );
        });
    });
    diagnostic.phase = 'navigating';
    diagnostic.timings.navigationStartedMs = elapsed();
    // This anonymous monitor needs a committed lobby document and its native roster.
    // Waiting for DOMContentLoaded can couple room retirement to unrelated page assets.
    diagnostic.navigationReadiness = 'commit-then-native-roster';
    const navigation = await bounded(
      probe.goto(origin + '/play', { waitUntil: 'commit', timeout: remaining() }),
      remaining(),
    );
    diagnostic.timings.navigationCompletedMs = elapsed();
    const navigationStatus = navigation?.status?.();
    if (Number.isInteger(navigationStatus) && navigationStatus >= 100 && navigationStatus <= 599)
      diagnostic.network.navigationHttpStatus = navigationStatus;
    const currentUrl = new URL(probe.url());
    if (
      !Number.isInteger(navigationStatus) ||
      navigationStatus < 200 ||
      navigationStatus >= 400 ||
      currentUrl.origin !== origin ||
      currentUrl.pathname !== '/play' ||
      currentUrl.search ||
      currentUrl.hash
    )
      throw Error('INITIAL_ROSTER_NAVIGATION_UNVERIFIED');
    diagnostic.phase = 'waiting-initial-roster';
    while (!observed.snapshot() && Date.now() < deadline) await pause(Math.min(100, remaining()));
    diagnostic.phase = 'ready';
    diagnostic.timings.setupCompletedMs = elapsed();
    diagnostic.initialRosterObserved = observed.snapshot() !== null;
    return {
      beforeLeave: observed.snapshot(),
      diagnostics,
      currentMembership: () => (abandoned || diagnostic.pageClosed ? null : observed.snapshot()),
      async verify({ timeoutMs: verifyMs = 20000, refreshAfterMs = 2000 } = {}) {
        const verificationStarted = Date.now();
        verifyUntil ??= verificationStarted + verifyMs;
        const until = Math.min(verifyUntil, verificationStarted + verifyMs);
        const refreshAt = verificationStarted + Math.min(refreshAfterMs, Math.floor(verifyMs / 3));
        diagnostic.phase = 'verifying-membership';
        diagnostic.timings.verificationStartedMs = elapsed();
        do {
          const receipt = observed.snapshot();
          const freshAfterRefresh =
            !refreshAttempted ||
            (diagnostic.refresh.navigationCompleted === true &&
              diagnostic.refresh.documentObserved === true &&
              diagnostic.refresh.unexpectedNavigation !== true &&
              diagnostic.refresh.failed !== true &&
              lastAcceptedEpoch === expectedEpoch &&
              lastFullReceipt?.seatPresent === false &&
              lastFullReceipt.ordinal > diagnostic.refresh.beforeOrdinal);
          if (
            !abandoned &&
            !diagnostic.pageClosed &&
            Date.now() < until &&
            receipt?.seatPresent === false &&
            freshAfterRefresh
          ) {
            diagnostic.phase = 'verified-absent';
            diagnostic.timings.verificationCompletedMs = elapsed();
            return {
              ...receipt,
              serverSeatAbsent: true,
              anonymous: true,
              observedAt: new Date().toISOString(),
              probe: diagnostics(),
            };
          }
          if (abandoned || diagnostic.pageClosed || diagnostic.refresh?.failed || Date.now() >= until) break;
          if (!refreshAttempted && receipt?.ownSeatPreviouslyObserved === true && Date.now() >= refreshAt) {
            // Refresh this anonymous read-only page once. Keep the exact same membership tracker:
            // an initially absent room in a new tracker would not prove that our old seat left.
            refreshAttempted = true;
            expectedEpoch++;
            lastFullReceipt = null;
            diagnostic.refresh = {
              attempted: true,
              attempts: 1,
              beforeOrdinal: receipt.ordinal,
              documentEpoch: expectedEpoch,
              startedMs: elapsed(),
              navigationPending: true,
              navigationCompleted: false,
              failed: false,
              budgetMs: Math.min(8000, until - Date.now()),
            };
            diagnostic.phase = 'refreshing-anonymous-roster';
            try {
              const response = await bounded(
                Promise.resolve().then(() =>
                  probe.reload({
                    waitUntil: 'commit',
                    timeout: diagnostic.refresh.budgetMs,
                  }),
                ),
                diagnostic.refresh.budgetMs,
              );
              const status = response?.status?.();
              diagnostic.refresh.navigationHttpStatus = Number.isInteger(status) ? status : null;
              if (Date.now() >= until) throw Error('FINISHED_LEAVE_TIMEOUT');
              if (!Number.isInteger(status) || status < 200 || status >= 400)
                throw Error('REFRESH_NAVIGATION_HTTP_UNVERIFIED');
              diagnostic.refresh.navigationCompleted = true;
              diagnostic.refresh.completedMs = elapsed();
            } catch (error) {
              diagnostic.refresh.failed = true;
              diagnostic.refresh.error = membershipProbeError(
                error,
                'refreshing-anonymous-roster',
                elapsed(),
                Date.now() >= until,
              );
            } finally {
              diagnostic.refresh.navigationPending = false;
              diagnostic.phase = 'verifying-membership';
            }
            continue;
          }
          const nextWake =
            !refreshAttempted && receipt?.ownSeatPreviouslyObserved === true
              ? Math.min(until, refreshAt)
              : until;
          await pause(Math.min(200, Math.max(1, nextWake - Date.now())));
        } while (Date.now() < until);
        diagnostic.phase = 'verification-inconclusive';
        diagnostic.timings.verificationCompletedMs = elapsed();
        return {
          gameId,
          playerName,
          serverSeatAbsent: false,
          anonymous: true,
          receipt: observed.snapshot(),
          reason:
            abandoned || diagnostic.pageClosed
              ? 'native-probe-unavailable'
              : diagnostic.refresh?.failed
                ? 'native-refresh-failed'
                : refreshAttempted &&
                    (!lastFullReceipt || lastFullReceipt.ordinal <= diagnostic.refresh.beforeOrdinal)
                  ? 'fresh-native-roster-not-confirmed'
                  : observed.snapshot()?.seatPresent === true
                    ? 'seat-still-listed'
                    : 'native-membership-inconclusive',
          probe: diagnostics(),
        };
      },
      close,
    };
  } catch (error) {
    diagnostic.failed = true;
    diagnostic.error = membershipProbeError(error, diagnostic.phase, elapsed(), Date.now() >= deadline);
    diagnostic.phase = 'setup-failed';
    diagnostic.timings.setupFailedMs = elapsed();
    await close();
    return {
      beforeLeave: null,
      diagnostics,
      currentMembership: () => null,
      verify: async () => ({
        gameId,
        playerName,
        serverSeatAbsent: false,
        anonymous: true,
        reason: 'native-roster-unavailable',
        probe: diagnostics(),
      }),
      close: async () => {},
    };
  }
}

/** Standalone readback cannot infer absence from an initially invisible room. */
export async function verifyFinishedRoomSeat(page, options) {
  const deadline = Date.now() + (options.timeoutMs ?? 20000);
  const monitor = await beginFinishedRoomSeatCheck(page, options);
  try {
    return await monitor.verify({ timeoutMs: Math.max(1, deadline - Date.now()) });
  } finally {
    await monitor.close();
  }
}

export function finishedRoomMatches(state, config) {
  const frame = state.finalPublicView;
  return (
    state.finished === true &&
    frame?.started === true &&
    frame.gameId === config.room.gameId &&
    frame.playerName === config.self.name &&
    config.participants.includes(frame.winner) &&
    sameNames(Object.keys(frame.players ?? {}), config.participants)
  );
}

/** Exactly one ordinary Leave click; local navigation alone never counts as a released seat. */
export async function leaveFinishedRoom({
  page,
  config,
  state,
  save,
  inspectCurrent,
  quiesce,
  prepareSeatCheck = beginFinishedRoomSeatCheck,
  timeoutMs = 90000,
  externalCancellation = () => false,
}) {
  const operatorPaused = () => {
    if (externalCancellation() === true) state.operatorPaused = true;
    return state.operatorPaused === true;
  };
  if (!finishedRoomMatches(state, config) || operatorPaused() || state.roomExit?.attempted)
    return { skipped: true };
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  // A fresh anonymous context has no warm application cache. Keep one cold-start
  // window alive instead of repeatedly closing it before the native lobby connects.
  // The fixed overall deadline also reserves time for the one Leave and its proof.
  const setupDeadline = deadline - Math.min(30000, Math.max(1, Math.floor(timeoutMs / 3)));
  const exit = (state.roomExit = {
    gameId: config.room.gameId,
    playerName: config.self.name,
    attempted: true,
    terminalWinner: state.finalPublicView.winner,
    terminalRecordedAt: new Date().toISOString(),
    phase: 'checking-current-terminal',
    leaveCommandAttempts: 0,
  });
  save();
  let monitor;
  try {
    let proof;
    for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
      exit.proofAttempts = attempt + 1;
      try {
        proof = await bounded(inspectCurrent(), Math.min(5000, remaining()));
      } catch {
        proof = null;
      }
      if (
        proof?.gameId === config.room.gameId &&
        proof.playerName === config.self.name &&
        proof.winner === state.finalPublicView.winner &&
        proof.current === true
      )
        break;
      proof = null;
      if (attempt < 2) await pause(Math.min(300, remaining()));
    }
    if (!proof || operatorPaused() || new URL(page.url()).origin !== config.origin)
      throw Error('CURRENT_TERMINAL_VIEW_REQUIRED');
    const leave = keytekiUiButton(page, 'leaveFinished');
    if (!(await bounded(leave.isVisible(), Math.min(3000, remaining()))))
      throw Error('NORMAL_LEAVE_UNAVAILABLE');
    const ownSeatPresent = (receipt) =>
      receipt?.gameId === config.room.gameId &&
      receipt.playerName === config.self.name &&
      receipt.seatPresent === true &&
      receipt.ownSeatPreviouslyObserved === true &&
      ['games', 'newgame', 'updategame'].includes(receipt.source) &&
      Number.isSafeInteger(receipt.ordinal) &&
      receipt.ordinal >= 1;
    exit.phase = 'preparing-server-membership';
    exit.monitorAttempts = [];
    save();
    // Retry only read-only anonymous setup. Every failed owned context is closed before
    // the next attempt; the normal game Leave below is still attempted at most once.
    for (let attempt = 0; attempt < 3 && Date.now() < setupDeadline; attempt++) {
      if (operatorPaused() || !finishedRoomMatches(state, config))
        throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
      const started = Date.now();
      const setupBudgetMs = Math.min(60000, setupDeadline - started);
      const row = { attempt: attempt + 1, startedAt: new Date(started).toISOString(), setupBudgetMs };
      exit.monitorAttempts.push(row);
      let prepared,
        abandoned = false;
      const preparing = Promise.resolve().then(() =>
        prepareSeatCheck(page, {
          origin: config.origin,
          gameId: config.room.gameId,
          playerName: config.self.name,
          timeoutMs: setupBudgetMs,
        }),
      );
      void preparing
        .then((late) => {
          if (abandoned && late?.close) void bounded(late.close(), 1000).catch(() => {});
        })
        .catch(() => {});
      try {
        prepared = await bounded(
          preparing,
          Math.min(setupBudgetMs + 1000, Math.max(1, setupDeadline - Date.now())),
        );
        row.probe = prepared?.diagnostics?.() ?? null;
        row.beforeLeave = prepared?.currentMembership?.() ?? null;
        if (operatorPaused() || !finishedRoomMatches(state, config))
          throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
        if (Date.now() < setupDeadline && ownSeatPresent(row.beforeLeave)) {
          row.outcome = 'own-seat-present';
          row.elapsedMs = Date.now() - started;
          monitor = prepared;
          break;
        }
        row.outcome =
          Date.now() >= setupDeadline
            ? 'setup-deadline-exhausted'
            : row.probe?.failed
              ? 'setup-failed'
              : 'no-positive-own-seat';
      } catch (error) {
        row.outcome = 'setup-error';
        row.error = membershipProbeError(
          error,
          'preparing-monitor',
          Date.now() - started,
          Date.now() >= deadline,
        );
      } finally {
        if (!monitor) {
          abandoned = true;
          if (prepared?.close) {
            try {
              await bounded(prepared.close(), Math.min(1000, remaining()));
              row.closeCallCompleted = true;
            } catch (error) {
              row.closeCallCompleted = false;
              row.closeError = membershipProbeError(
                error,
                'closing-attempt',
                Date.now() - started,
                Date.now() >= deadline,
              );
            }
            row.probe = prepared.diagnostics?.() ?? row.probe;
          }
        }
        row.elapsedMs = Date.now() - started;
        save();
      }
      if (operatorPaused() || !finishedRoomMatches(state, config))
        throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
      if (attempt < 2 && Date.now() < setupDeadline)
        await pause(Math.min(100, Math.max(1, setupDeadline - Date.now())));
    }
    if (!monitor) throw Error('INITIAL_SERVER_SEAT_NOT_CONFIRMED');
    exit.serverBeforeLeave = monitor.currentMembership();
    exit.serverProbe = monitor.diagnostics?.() ?? null;
    if (!ownSeatPresent(exit.serverBeforeLeave) || Date.now() >= deadline)
      throw Error('INITIAL_SERVER_SEAT_NOT_CONFIRMED');
    await bounded(quiesce(), Math.min(8000, remaining()));
    if (
      operatorPaused() ||
      !finishedRoomMatches(state, config) ||
      new URL(page.url()).origin !== config.origin
    )
      throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
    const current = await bounded(inspectCurrent(), Math.min(5000, remaining()));
    if (
      operatorPaused() ||
      !current?.current ||
      current.gameId !== proof.gameId ||
      current.playerName !== proof.playerName ||
      current.winner !== proof.winner
    )
      throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
    const currentMembership = monitor.currentMembership();
    if (operatorPaused() || !ownSeatPresent(currentMembership) || Date.now() >= deadline)
      throw Error('CURRENT_SERVER_SEAT_REQUIRED');
    exit.serverAtLeave = currentMembership;
    exit.phase = 'leaving';
    save();
    // This last synchronous marker check stays active after watchdog.close().
    if (operatorPaused()) throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
    exit.leaveCommandAttempts = 1;
    await bounded(leave.click({ timeout: Math.min(5000, remaining()) }), Math.min(5000, remaining()));
    exit.leaveClicked = true;
    await bounded(
      leave.waitFor({ state: 'hidden', timeout: Math.min(5000, remaining()) }),
      Math.min(5000, remaining()),
    );
    exit.localLeaveObserved = true;
    save();
    exit.server = await bounded(monitor.verify({ timeoutMs: Math.min(20000, remaining()) }), remaining());
    exit.serverSeatAbsent = exit.server.serverSeatAbsent === true;
    exit.phase = exit.serverSeatAbsent ? 'left-confirmed' : 'leave-unconfirmed';
    state.phase = exit.serverSeatAbsent ? 'finished-left' : 'finished-leave-unconfirmed';
  } catch (error) {
    exit.phase = 'leave-unconfirmed';
    exit.reason = /^[A-Z0-9_-]+$/.test(error?.message ?? '') ? error.message : 'NORMAL_LEAVE_NOT_CONFIRMED';
    state.phase = 'finished-leave-unconfirmed';
  } finally {
    if (monitor) {
      await bounded(monitor.close(), Math.min(1000, remaining())).catch(() => {});
      exit.serverProbe = monitor.diagnostics?.() ?? exit.serverProbe ?? null;
    }
  }
  exit.completedAt = new Date().toISOString();
  save();
  return exit;
}

export function currentFinishedRoomProof(config, state, snap, receipt, raw) {
  return {
    gameId: raw?.id,
    playerName: snap?.playerName,
    winner: winnerName(raw),
    current: Boolean(
      snap &&
        receipt &&
        snap.enabled === true &&
        snap.invalid === false &&
        snap.operatorPaused === false &&
        snap.connected === true &&
        !state.operatorPaused &&
        !state.watchdogObservationGap &&
        snap.gameId === config.room.gameId &&
        snap.playerName === config.self.name &&
        typeof receipt.documentId === 'string' &&
        receipt.documentId &&
        typeof receipt.frameToken === 'string' &&
        receipt.frameToken &&
        typeof receipt.transportPath === 'string' &&
        receipt.transportPath &&
        Number.isSafeInteger(receipt.nativeSequence) &&
        receipt.nativeSequence >= 1 &&
        ['documentId', 'transportPath', 'nativeSequence', 'frameToken'].every(
          (key) => snap[key] === receipt[key],
        ) &&
        (receipt.ownerEpoch == null || receipt.ownerEpoch === snap.ownerEpoch) &&
        raw?.id === config.room.gameId &&
        sameNames(Object.keys(raw?.players ?? {}), config.participants),
    ),
  };
}

/** One-match launchers allow terminal chat to settle within a fixed bound; operator pause wins. */
export function installFinishedRoomExit({
  config,
  state,
  save,
  page,
  watchdog,
  quiesce,
  inspectChat,
  externalCancellation = () => false,
  onComplete = () => {},
  delayMs = 10000,
  chatDrainMs = FINISHED_CHAT_DRAIN_MS,
  prepareSeatCheck,
}) {
  let busy = false,
    closed = false,
    finishedAt = null;
  const cancelled = () => {
    if (externalCancellation() === true) state.operatorPaused = true;
    if (state.operatorPaused || watchdog.watchdog.status().phase === 'operator-paused')
      return 'operator-paused';
    if (closed) return 'exit-closed';
    if (!finishedRoomMatches(state, config)) return 'terminal-context-changed';
    return null;
  };
  const tick = async () => {
    if (
      busy ||
      closed ||
      config.leaveAfterFinish === false ||
      state.operatorPaused ||
      state.roomExit?.attempted
    )
      return;
    if (!finishedRoomMatches(state, config)) {
      finishedAt = null;
      return;
    }
    if (cancelled()) return;
    finishedAt ??= Date.now();
    if (Date.now() - finishedAt < delayMs) return;
    busy = true;
    try {
      state.phase = 'finished-chat-drain';
      state.finishChatDrain = {
        gameId: config.room.gameId,
        playerName: config.self.name,
        outcome: 'waiting',
        graceMs: delayMs,
        startedAt: new Date().toISOString(),
      };
      save();
      const drain = await waitForFinishedChat({
        identity: { origin: config.origin, gameId: config.room.gameId, playerName: config.self.name },
        readStatus: inspectChat,
        socialEnabled: config.social?.enabled,
        cancelled,
        timeoutMs: chatDrainMs,
      });
      state.finishChatDrain = { ...state.finishChatDrain, ...drain, completedAt: new Date().toISOString() };
      if (drain.outcome === 'cancelled' || cancelled()) {
        if (drain.reason === 'operator-paused' || cancelled() === 'operator-paused')
          state.operatorPaused = true;
        save();
        return;
      }
      save();
      const result = await leaveFinishedRoom({
        page,
        config,
        state,
        save,
        prepareSeatCheck,
        externalCancellation,
        quiesce: async () => {
          const before = cancelled();
          if (before) throw Error('FINISHED_LEAVE_CONTEXT_CHANGED');
          const confirmation = await quiesce();
          state.finishChatDrain.quiescedAt = new Date().toISOString();
          state.finishChatDrain.cancellationRequested = drain.outcome !== 'drained';
          state.finishChatDrain.chatCancellationConfirmed = confirmation?.chatCancellationConfirmed === true;
          save();
        },
        inspectCurrent: async () => {
          cancelled();
          const snap = await watchdog.snapshot();
          cancelled();
          const status = watchdog.watchdog.status();
          if (status.phase === 'operator-paused') state.operatorPaused = true;
          const raw = watchdog.native.snapshot();
          return currentFinishedRoomProof(config, state, snap, status.receipt, raw);
        },
      });
      if (result.serverSeatAbsent) {
        const stopReason = cancelled();
        close();
        if (stopReason) {
          save();
          return;
        }
        await onComplete(result);
      }
    } finally {
      busy = false;
    }
  };
  const interval = setInterval(() => void tick().catch(() => {}), 1000);
  interval.unref?.();
  function close() {
    closed = true;
    clearInterval(interval);
  }
  return { tick, close };
}
