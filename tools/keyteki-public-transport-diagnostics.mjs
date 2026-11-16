import { normalizeGameSocketPaths } from './site-origin.mjs';
/** Passive, payload-free diagnostics. No connect/send/close/reload/recovery operations. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROUTES = new Set([
  '/state',
  '/attach',
  '/send-intent',
  '/detach',
  '/social/next',
  '/social/send-intent',
  '/social/sent',
  '/activity',
  '/decision',
  '/sent',
  '/unknown',
  '/reject',
  '/disconnect',
  '/transport-close',
  '/transport-resume',
  '/clear',
]);
const PAGE_PATHS = new Set(['/', '/play', '/login', '/logout', '/decks', '/about', '/profile']);
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError']);
const ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPIPE',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOMEM',
]);
const integer = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : undefined);
const label = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(x) ? x : 'unreported');
const decisionId = (x) => (typeof x === 'string' && /^decision-[0-9]{1,12}$/.test(x) ? x : undefined);
const defined = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));
const MAX_LISTENERS = 512;
const MAX_PENDING_REQUESTS = 256;

export function createPublicTransportDiagnostics({
  record,
  origin,
  gameSocketPaths = [],
  monotonicNow = () => performance.now(),
  wallNow = () => new Date(),
}) {
  if (typeof record !== 'function') throw new TypeError('A diagnostic record callback is required');
  const site = new URL(origin);
  const allowedPaths = normalizeGameSocketPaths(gameSocketPaths);
  if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password)
    throw new TypeError('Invalid diagnostic origin');
  let ordinal = 0,
    lastElapsed = 0,
    cleanup = false,
    disposed = false,
    finished;
  let recordErrors = 0,
    observerErrors = 0,
    written = 0,
    nextPage = 0,
    nextBrowser = 0,
    nextBridge = 0,
    nextRequest = 0,
    droppedListeners = 0,
    droppedRequests = 0;
  const pages = new WeakMap(),
    browsers = new WeakMap(),
    bridges = new WeakMap(),
    requests = new Map(),
    listeners = new Set();
  const counts = new Map();
  function readClock() {
    try {
      const value = monotonicNow();
      if (Number.isFinite(value)) return value;
    } catch {}
    observerErrors++;
    return null;
  }
  const started = readClock() ?? 0;
  function elapsed() {
    const now = readClock();
    if (now !== null) lastElapsed = Math.max(lastElapsed, now - started, 0);
    return lastElapsed;
  }
  function wall() {
    const value = wallNow();
    const date =
      value instanceof Date
        ? value
        : typeof value === 'number'
          ? new Date(value)
          : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
            ? new Date(value)
            : null;
    return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  function emit(row, at = elapsed()) {
    if (disposed) return;
    counts.set(row.event, (counts.get(row.event) ?? 0) + 1);
    try {
      record({
        schema: 'keyteki-public-transport-diagnostic-v1',
        ordinal: ++ordinal,
        elapsedMs: at,
        wallTime: wall(),
        cleanupStarted: cleanup,
        ...row,
      });
      written++;
    } catch {
      recordErrors++;
    }
  }
  function listen(emitter, event, handler) {
    const noop = () => {};
    if (!emitter || typeof emitter.on !== 'function') return noop;
    if (listeners.size >= MAX_LISTENERS) {
      droppedListeners++;
      return noop;
    }
    const safe = (...args) => {
      if (!disposed) {
        try {
          handler(...args);
        } catch {
          observerErrors++;
        }
      }
    };
    try {
      emitter.on(event, safe);
    } catch {
      observerErrors++;
      return noop;
    }
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      listeners.delete(remove);
      try {
        if (typeof emitter.off === 'function') emitter.off(event, safe);
        else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, safe);
      } catch {
        observerErrors++;
      }
    };
    listeners.add(remove);
    return remove;
  }
  function pageLocation(raw) {
    try {
      const u = new URL(raw);
      if (u.username || u.password || u.origin !== site.origin) return { originMatched: false };
      return { originMatched: true, path: PAGE_PATHS.has(u.pathname) ? u.pathname : 'other' };
    } catch {
      return { originMatched: false };
    }
  }
  function gameSocket(raw) {
    try {
      const u = new URL(raw),
        expectedScheme = site.protocol === 'https:' ? 'wss:' : 'ws:';
      const httpPath =
        (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host + u.pathname.replace(/\/$/, '');
      const httpOrigin = (u.protocol === 'wss:' ? 'https:' : 'http:') + '//' + u.host;
      if (
        u.protocol !== expectedScheme ||
        u.username ||
        u.password ||
        (httpOrigin !== site.origin && !allowedPaths.includes(httpPath)) ||
        !/^\/node(?:[1-9][0-9]*|-(?:0|[1-9][0-9]*))\/socket\.io\/?$/.test(u.pathname)
      )
        return null;
      return {
        endpoint: u.origin + u.pathname,
        engineProtocolVersion: /^[34]$/.test(u.searchParams.get('EIO') ?? '')
          ? Number(u.searchParams.get('EIO'))
          : null,
      };
    } catch {
      return null;
    }
  }
  function observeBrowser(browser) {
    if (!browser || typeof browser.on !== 'function') return undefined;
    if (browsers.has(browser)) return browsers.get(browser);
    const browserId = ++nextBrowser;
    browsers.set(browser, browserId);
    emit({ event: 'browser-observed', browserId });
    listen(browser, 'disconnected', () => emit({ event: 'browser-disconnected', browserId }));
    return browserId;
  }
  function observePage(page, playerName) {
    if (disposed || !page || typeof page.on !== 'function') return null;
    if (pages.has(page)) return pages.get(page).pageId;
    const browserId = observeBrowser(page.context?.()?.browser?.());
    const state = { pageId: ++nextPage, navigationId: 0, socketOrdinal: 0, player: label(playerName) };
    pages.set(page, state);
    const info = () =>
      defined({ player: state.player, pageId: state.pageId, navigationId: state.navigationId, browserId });
    emit({ event: 'page-observed', ...info() });
    listen(page, 'framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      // framenavigated can include same-document navigation: this is an event ordinal, not a document identity.
      state.navigationId++;
      emit({ event: 'page-main-navigation', ...info(), ...pageLocation(frame.url()) });
    });
    for (const [event, name] of [
      ['domcontentloaded', 'page-dom-content-loaded'],
      ['load', 'page-load'],
      ['close', 'page-close'],
      ['crash', 'page-crash'],
    ])
      listen(page, event, () => emit({ event: name, ...info() }));
    listen(page, 'pageerror', (error) =>
      emit({
        event: 'page-error-observed',
        ...info(),
        errorName: ERROR_NAMES.has(error?.name) ? error.name : 'other',
      }),
    );
    listen(page, 'websocket', (socket) => {
      const endpoint = gameSocket(socket.url());
      if (!endpoint) return;
      const socketInfo = { ...info(), socketId: ++state.socketOrdinal, ...endpoint };
      const stats = {
        receivedFrames: 0,
        sentFrames: 0,
        receivedBytes: 0,
        sentBytes: 0,
        lastReceivedMs: null,
        lastSentMs: null,
        normalPingsReceived: 0,
        normalPingsSent: 0,
        normalPongsReceived: 0,
        normalPongsSent: 0,
        probeFrames: 0,
        lastNormalPingReceivedMs: null,
        lastNormalPingSentMs: null,
        lastNormalPongReceivedMs: null,
        lastNormalPongSentMs: null,
      };
      const socketEmit = (row, at) => emit({ ...socketInfo, ...row }, at);
      // Playwright observed creation of a WebSocket; this is not an application handshake receipt.
      socketEmit({ event: 'socket-open-observed' });
      const onFrame = (direction) => (event) => {
        const payload = event?.payload,
          text = typeof payload === 'string' ? payload : null;
        const bytes =
          text !== null ? Buffer.byteLength(text) : ArrayBuffer.isView(payload) ? payload.byteLength : 0;
        const suffix = direction === 'received' ? 'Received' : 'Sent',
          at = elapsed();
        stats[direction + 'Frames']++;
        stats[direction + 'Bytes'] += bytes;
        stats['last' + suffix + 'Ms'] = at;
        if (text === null) return;
        const engineType = text[0],
          socketIoType = engineType === '4' ? text[1] : null;
        const probe = text === '2probe' || text === '3probe';
        const normalPing = text === '2',
          normalPong = text === '3';
        if (probe) stats.probeFrames++;
        if (normalPing || normalPong) {
          const kind = normalPing ? 'Ping' : 'Pong';
          stats['normal' + kind + 's' + suffix]++;
          stats['lastNormal' + kind + suffix + 'Ms'] = at;
        }
        if (
          !['0', '1', '2', '3'].includes(engineType) &&
          !(engineType === '4' && ['0', '1', '4'].includes(socketIoType))
        )
          return;
        let handshake;
        if (engineType === '0') {
          handshake = {};
          try {
            if (text.length > 4096) throw new Error('Handshake is too large');
            const hello = JSON.parse(text.slice(1));
            if (typeof hello?.sid === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(hello.sid))
              handshake.engineSessionSha256 = createHash('sha256').update(hello.sid).digest('hex');
            for (const [key, target] of [
              ['pingInterval', 'pingIntervalMs'],
              ['pingTimeout', 'pingTimeoutMs'],
            ])
              if (Number.isSafeInteger(hello?.[key]) && hello[key] >= 0 && hello[key] <= 86400000)
                handshake[target] = hello[key];
          } catch {
            handshake = { malformed: true };
          }
        }
        socketEmit(
          {
            event: 'protocol-control-frame',
            direction,
            engineType,
            socketIoType,
            bytes,
            probe,
            heartbeat: normalPing ? 'ping' : normalPong ? 'pong' : null,
            ...(handshake ? { handshake } : {}),
            state: { ...stats },
          },
          at,
        );
      };
      const socketListeners = [
        listen(socket, 'framereceived', onFrame('received')),
        listen(socket, 'framesent', onFrame('sent')),
        listen(socket, 'socketerror', () =>
          socketEmit({ event: 'socket-error-observed', state: { ...stats } }),
        ),
      ];
      socketListeners.push(
        listen(socket, 'close', () => {
          socketEmit({ event: 'socket-close-observed', state: { ...stats } });
          for (const remove of socketListeners.splice(0)) remove();
        }),
      );
    });
    return state.pageId;
  }
  function observeBridge(child) {
    if (disposed || !child || typeof child.on !== 'function') return null;
    if (bridges.has(child)) return bridges.get(child);
    const bridgeId = ++nextBridge;
    bridges.set(child, bridgeId);
    const info = () => defined({ bridgeId, pid: integer(child.pid) });
    emit({ event: 'bridge-process-observed', ...info() });
    listen(child, 'spawn', () => emit({ event: 'bridge-spawned', ...info() }));
    listen(child, 'error', (error) =>
      emit(
        defined({
          event: 'bridge-process-error',
          ...info(),
          errorName: ERROR_NAMES.has(error?.name) ? error.name : 'other',
          errorCode: ERROR_CODES.has(error?.code) ? error.code : undefined,
        }),
      ),
    );
    listen(child, 'exit', (code, signal) =>
      emit(
        defined({
          event: 'bridge-exit',
          ...info(),
          exitCode: integer(code),
          signal: typeof signal === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : null,
        }),
      ),
    );
    return bridgeId;
  }
  function requestStarted(value = {}) {
    if (disposed) return null;
    const requestId = ++nextRequest;
    if (requests.size >= MAX_PENDING_REQUESTS) {
      droppedRequests++;
      return null;
    }
    const token = Object.freeze({ requestId }),
      at = elapsed();
    const meta = defined({
      requestId: token.requestId,
      player: label(value.player),
      route: ROUTES.has(value.route) ? value.route : 'other',
      sequence: integer(value.sequence),
      decisionId: decisionId(value.decisionId),
    });
    requests.set(token, { meta, at });
    emit({ event: 'bridge-http-request-started', ...meta }, at);
    return token;
  }
  function requestCompleted(token, value, failed) {
    const saved = requests.get(token);
    if (!saved || disposed) return false;
    requests.delete(token);
    const at = elapsed();
    emit(
      defined({
        event: failed ? 'bridge-http-request-failed' : 'bridge-http-request-finished',
        ...saved.meta,
        decisionId: decisionId(value?.decisionId) ?? saved.meta.decisionId,
        httpStatus:
          Number.isSafeInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599
            ? value.httpStatus
            : undefined,
        durationMs: Math.max(0, at - saved.at),
      }),
      at,
    );
    return true;
  }
  function cleanupStarted(value = {}) {
    if (disposed || cleanup) return;
    // A phase boundary, not proof that cleanup caused a later transport close.
    cleanup = true;
    emit({ event: 'runner-cleanup-started', success: value.success === true });
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const remove of listeners) {
      try {
        remove();
      } catch {
        observerErrors++;
      }
    }
    requests.clear();
  }
  function finish() {
    if (finished) return finished;
    const pendingRequests = requests.size;
    emit({
      event: 'diagnostics-finished',
      pendingRequests,
      recordErrors,
      observerErrors,
      droppedListeners,
      droppedRequests,
    });
    dispose();
    finished = {
      schema: 'keyteki-public-transport-diagnostic-summary-v1',
      attemptedRecords: ordinal,
      writtenRecords: written,
      recordErrors,
      observerErrors,
      droppedListeners,
      droppedRequests,
      degraded: recordErrors + observerErrors + droppedListeners + droppedRequests > 0,
      pendingRequests,
      pages: nextPage,
      browsers: nextBrowser,
      bridgeProcesses: nextBridge,
      requests: nextRequest,
      eventCounts: Object.fromEntries(counts),
    };
    return finished;
  }
  const guarded =
    (fn, fallback = null) =>
    (...args) => {
      try {
        return fn(...args);
      } catch {
        observerErrors++;
        return fallback;
      }
    };
  return {
    observePage: guarded(observePage),
    observeBridge: guarded(observeBridge),
    requestStarted: guarded(requestStarted),
    requestFinished: guarded((token, value) => requestCompleted(token, value, false), false),
    requestFailed: guarded((token) => requestCompleted(token, undefined, true), false),
    cleanupStarted: guarded(cleanupStarted),
    finish: guarded(finish),
    dispose: guarded(dispose),
  };
}
