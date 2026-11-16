// ==UserScript==
// @name         KF Shared Strategy Bridge
// @namespace    keyforge-lab
// @version      0.4.1
// @description  Use your received player view with a configured local strategy host and optional AI table chat.
// @match        https://thecrucible.online/*
// @match        http://127.0.0.1/*
// @match        http://localhost/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==
(() => {
  'use strict';
  const settings = GM_getValue('kf-bridge-settings', null);
  GM_registerMenuCommand('Configure local KF bridge', () => {
    const raw = prompt(
      'Paste local connection settings with url, token, and playerName:',
      JSON.stringify(settings ?? {}),
    );
    if (raw === null) return;
    try {
      const next = JSON.parse(raw),
        url = new URL(next.url);
      if (
        url.hostname !== '127.0.0.1' ||
        url.protocol !== 'http:' ||
        !/^[a-f0-9]{64}$/.test(next.token) ||
        !next.playerName
      )
        throw Error('Invalid local connection');
      GM_setValue('kf-bridge-settings', next);
      alert('Saved. Reload the private-test game page to capture its complete initial player view.');
    } catch (error) {
      alert(error.message);
    }
  });
  if (!settings) return;
  const base = new URL(settings.url);
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') return;
  const managed = settings.managedSessions === true;
  // Installed only by the one-seat launcher. It never chooses a game action or calls a model.
  const faultSettings = settings.humanWatchdog;
  const faultEnabled =
    managed &&
    faultSettings?.enabled === true &&
    typeof faultSettings.gameId === 'string' &&
    Array.isArray(faultSettings.participants) &&
    faultSettings.participants.length === 2 &&
    new Set(faultSettings.participants).size === 2 &&
    faultSettings.participants.includes(settings.playerName);
  const FAULT_APOLOGY = '抱歉，我这边的自动对战程序卡住了，恢复没有成功。这局我认输，不耽误你时间。';
  const FAULT_OBSERVATION_PACKETS = 128,
    FAULT_OBSERVATION_CHARS = 4 * 1024 * 1024,
    FAULT_OBSERVATION_ATTEMPTS = 6,
    FAULT_OBSERVATION_ACK_MS = 6000;
  const storageKey = 'kf-local-session:' + settings.url + ':' + settings.playerName;
  const randomId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  let stored = {};
  if (managed) {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}');
      if (value && typeof value === 'object' && /^[a-f0-9]{32}$/.test(value.tabId ?? '')) stored = value;
    } catch {}
  }
  const tabId = stored.tabId ?? randomId();
  function saveSession(ctx, deliveryLedger = ctx.deliveryLedger) {
    if (!managed) return;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        tabId,
        gameId: ctx.gameId ?? (faultEnabled ? faultSettings.gameId : null),
        ownerEpoch: ctx.ownerEpoch,
        deliveryLedger: deliveryLedger ?? null,
        faultLedger: ctx.faultLedger ?? null,
        operatorPaused: ctx.operatorPaused === true,
      }),
    );
  }
  function acceptOwner(ctx, reply, route) {
    if (
      !managed ||
      current !== ctx ||
      reply.gameId !== ctx.gameId ||
      reply.documentId !== ctx.id ||
      !Number.isSafeInteger(reply.ownerEpoch) ||
      !Number.isSafeInteger(reply.receiptOrdinal)
    )
      return;
    if (Number.isSafeInteger(ctx.ownerEpoch) && reply.ownerEpoch < ctx.ownerEpoch) return;
    if (ctx.ownerEpoch === reply.ownerEpoch && reply.receiptOrdinal <= ctx.ownerReceiptOrdinal) return;
    if (route === '/attach' || route === '/transport-resume') {
      if (ctx.ownerEpoch !== reply.ownerEpoch) ctx.ownerReceiptOrdinal = 0;
      ctx.ownerEpoch = reply.ownerEpoch;
    }
    if (ctx.ownerEpoch !== reply.ownerEpoch) return;
    ctx.ownerReceiptOrdinal = reply.receiptOrdinal;
    // An earlier no-pending response may arrive after a newer send-intent. Only
    // the newest accepted state may clear the synchronously recorded send ledger.
    if (reply.sendPending === null) ctx.deliveryLedger = null;
    saveSession(ctx);
  }
  // getRandomValues is also available on the public HTTP server; randomUUID is secure-context-only.
  // This opaque transport-session ID is independent of the bridge authentication token.
  const fresh = () => ({
    id: randomId(),
    ownerEpoch: null,
    ownerReceiptOrdinal: 0,
    previousOwnerEpoch: stored.ownerEpoch,
    previousGameId: stored.gameId,
    deliveryLedger: stored.deliveryLedger ?? null,
    faultLedger: stored.gameId === faultSettings?.gameId ? (stored.faultLedger ?? null) : null,
    operatorPaused: stored.gameId === faultSettings?.gameId && stored.operatorPaused === true,
    watchdog: {
      sequence: 0,
      frameToken: null,
      key: null,
      engineId: null,
      socket: null,
      prefix: '42',
      observations: [],
      observationChars: 0,
      observationAck: 0,
      observationOverflow: false,
      observationDraining: false,
      invalid: false,
      closing: false,
    },
    socialPolling: false,
    socialLastPoll: 0,
    socialSent: new Set(),
    sequence: 0,
    queue: Promise.resolve(),
    paused: false,
    pauseReason: null,
    ingress: { startedSequence: 0, settledSequence: 0, skippedQueued: 0, skippedNative: 0, lastResult: null },
    receiptProbe: false,
    activity: 0,
    polling: false,
    socket: null,
    key: null,
    prefix: '42',
    sent: new Set(),
    gameId: null,
    delivery: null,
    transportEpoch: 0,
    engineId: null,
    recovery: null,
  });
  let current = fresh();
  const socketInfo = new WeakMap(),
    socketsByPath = new Map();
  function faultSnapshot() {
    const ctx = current,
      w = ctx.watchdog,
      ws = w.socket,
      info = ws && socketInfo.get(ws);
    return {
      enabled: faultEnabled,
      gameId: faultSettings?.gameId,
      playerName: settings.playerName,
      documentId: ctx.id,
      ownerEpoch: ctx.ownerEpoch,
      ownerReceiptOrdinal: ctx.ownerReceiptOrdinal,
      nativeSequence: w.sequence,
      frameToken: w.frameToken,
      transportPath: w.key,
      connected:
        !!ws &&
        ws.readyState === 1 &&
        info?.ready === true &&
        info.sessionId === ctx.id &&
        info.engineId === w.engineId,
      invalid: w.invalid || w.closing,
      operatorPaused: ctx.operatorPaused === true,
      strategyPaused: ctx.paused === true,
      pauseReason: ctx.pauseReason,
      ordinarySequence: ctx.sequence,
      ordinaryIngress: { ...ctx.ingress },
      deliveryPresent: ctx.delivery != null,
      deliveryLedgerPresent: ctx.deliveryLedger != null,
      unknownSend: ctx.deliveryLedger != null || ctx.delivery != null,
      observationPending: w.observations.length,
      observationAck: w.observationAck,
      observationOverflow: w.observationOverflow,
      ledger: ctx.faultLedger ?? null,
    };
  }
  function faultMatches(ticket, requireConnected = true) {
    const snap = faultSnapshot();
    return (
      faultEnabled &&
      !snap.invalid &&
      !snap.operatorPaused &&
      (!requireConnected || snap.connected) &&
      [
        'gameId',
        'playerName',
        'documentId',
        'ownerEpoch',
        'nativeSequence',
        'frameToken',
        'transportPath',
      ].every((k) => ticket?.[k] === snap[k])
    );
  }
  function faultBindSocket(ctx, ws) {
    if (!faultEnabled || !ws) return;
    const w = ctx.watchdog,
      info = socketInfo.get(ws);
    if (info?.ready && info.sessionId === ctx.id && info.key === w.key && info.engineId === w.engineId) {
      if (w.socket && w.socket !== ws && w.socket.readyState === 1) {
        w.invalid = true;
        return;
      }
      w.socket = ws;
    }
  }
  function acknowledgeFaultObservation(ctx, receipt) {
    if (current !== ctx || ctx.watchdog.invalid || ctx.watchdog.closing || !receipt) return false;
    const w = ctx.watchdog,
      index = w.observations.findIndex((entry) =>
        ['documentId', 'ownerEpoch', 'nativeSequence', 'frameToken', 'transportPath'].every(
          (key) => entry.frame[key] === receipt[key],
        ),
      );
    if (index < 0) return false;
    // This receipt only prunes original observation packets. It never settles a strategy delivery.
    const accepted = w.observations.splice(0, index + 1);
    w.observationChars -= accepted.reduce((sum, entry) => sum + entry.json.length, 0);
    w.observationAck = receipt.nativeSequence;
    return true;
  }
  async function drainFaultObservations(ctx) {
    const w = ctx.watchdog;
    if (!faultEnabled || current !== ctx || w.invalid || w.closing || w.observationDraining) return;
    w.observationDraining = true;
    try {
      for (let count = 0; count < 16 && current === ctx && !w.invalid && !w.closing; count++) {
        const entry = w.observations[0];
        if (!entry || entry.attempts >= FAULT_OBSERVATION_ATTEMPTS || Date.now() < entry.retryAt) break;
        entry.attempts++;
        let reply, timer;
        try {
          reply = await Promise.race([
            Promise.resolve(unsafeWindow.__kfWatchdogFrame?.(JSON.parse(entry.json))),
            new Promise((resolve) => {
              timer = setTimeout(() => resolve(null), FAULT_OBSERVATION_ACK_MS);
            }),
          ]);
        } catch {
          // Keep the original frame on a missing callback, a transient read failure or a lost ACK.
        } finally {
          clearTimeout(timer);
        }
        if (reply?.accepted === true && acknowledgeFaultObservation(ctx, reply.receipt)) continue;
        // The supervisor may have pulled and acknowledged this same packet while the callback awaited.
        if (!w.observations.includes(entry)) continue;
        entry.retryAt = Date.now() + Math.min(4000, 250 * 2 ** (entry.attempts - 1));
        break;
      }
    } finally {
      w.observationDraining = false;
    }
  }
  function retainFaultObservation(ctx, frame, full) {
    const w = ctx.watchdog,
      json = JSON.stringify(frame),
      entry = { frame: JSON.parse(json), json, attempts: 0, retryAt: 0 };
    if (full) {
      // Only a real received full may supersede missing deltas. Preserve the first native full
      // until its exact ACK so a new observer still starts at sequence one.
      const first =
          w.observationAck === 0 ? w.observations.find((row) => row.frame.nativeSequence === 1) : null,
        replacement = first ? [first, entry] : [entry],
        chars = replacement.reduce((sum, row) => sum + row.json.length, 0);
      if (chars <= FAULT_OBSERVATION_CHARS) {
        w.observations = replacement;
        w.observationChars = chars;
        w.observationOverflow = false;
        void drainFaultObservations(ctx);
        return;
      }
    }
    if (
      w.observationOverflow ||
      w.observations.length >= FAULT_OBSERVATION_PACKETS ||
      w.observationChars + json.length > FAULT_OBSERVATION_CHARS
    ) {
      w.observationOverflow = true;
      return;
    }
    w.observations.push(entry);
    w.observationChars += json.length;
    void drainFaultObservations(ctx);
  }
  function faultReceive(ctx, info, packet, key, ws) {
    if (!faultEnabled || ctx !== current || info.sessionId !== ctx.id || !packet) return;
    const w = ctx.watchdog;
    if (packet.event[0] === 'cleargamestate') {
      w.invalid = true;
      return;
    }
    if (packet.event[0] !== 'gamestate' || w.invalid || w.closing) return;
    const delta = packet.event[1],
      full = isFullState(delta);
    if (
      full &&
      (delta.id !== faultSettings.gameId ||
        JSON.stringify(Object.keys(delta.players).sort()) !==
          JSON.stringify([...faultSettings.participants].sort()))
    ) {
      w.invalid = true;
      return;
    }
    if (w.key && w.key !== key) {
      w.invalid = true;
      return;
    }
    if (!w.sequence && (!full || !info.engineId)) return;
    if (w.engineId && info.engineId !== w.engineId) {
      if (!full || !info.engineId || (w.socket && w.socket.readyState === 1)) {
        w.invalid = true;
        return;
      }
      w.socket = null;
    }
    w.key = key;
    w.engineId = info.engineId;
    w.prefix = packet.prefix;
    if (ws) {
      info.ready = true;
      faultBindSocket(ctx, ws);
    } else faultBindSocket(ctx, socketsByPath.get(key));
    w.sequence++;
    w.frameToken = randomId();
    const frame = {
      gameId: faultSettings.gameId,
      playerName: settings.playerName,
      documentId: ctx.id,
      ownerEpoch: ctx.ownerEpoch,
      nativeSequence: w.sequence,
      frameToken: w.frameToken,
      transportPath: key,
      newEngineHandshake: !!info.engineId,
      delta,
    };
    // Keep original ingress packets until an exact observation ACK, even with a paused strategy lane.
    retainFaultObservation(ctx, frame, full);
  }
  if (faultEnabled)
    Object.defineProperty(unsafeWindow, '__kfHumanFaultGuardian', {
      value: Object.freeze({
        snapshot: faultSnapshot,
        observations() {
          return {
            snapshot: faultSnapshot(),
            // A read-only pull recovers a failed callback without a reload or a game/socket write.
            frames: current.watchdog.observations.map((entry) => JSON.parse(entry.json)),
          };
        },
        acknowledgeObservation(receipt) {
          return acknowledgeFaultObservation(current, receipt);
        },
        quarantine(ticket) {
          if (!faultMatches(ticket, false)) return false;
          if (!current.paused) current.pauseReason = 'watchdog-quarantine';
          current.paused = true;
          return true;
        },
        reconcileDelivery: reconcileObservedDelivery,
        act(kind, ticket) {
          if (
            !['apology', 'concede'].includes(kind) ||
            !faultMatches(ticket) ||
            typeof ticket?.episodeId !== 'string' ||
            !/^[a-f0-9]{24}$/.test(ticket.episodeId)
          )
            return { queued: false, attempted: false, reason: 'current-native-binding-required' };
          const ctx = current,
            w = ctx.watchdog,
            prior = ctx.faultLedger;
          if (prior?.[kind + 'Attempted'])
            return { queued: false, attempted: true, reason: 'already-attempted', ledger: prior };
          if (kind === 'concede' && !prior?.apologyAttempted && ticket.apologyCompleted !== true)
            return { queued: false, attempted: false, reason: 'apology-attempt-required' };
          ctx.paused = true;
          ctx.faultLedger = {
            ...prior,
            gameId: faultSettings.gameId,
            episodeId: ticket.episodeId,
            [kind + 'Attempted']: true,
            [kind + 'At']: Date.now(),
            [kind + 'Outcome']: 'unknown',
          };
          // Persist before touching native send; a thrown/unknown write never authorizes replay.
          saveSession(ctx);
          const info = socketInfo.get(w.socket);
          info.managed = true;
          try {
            w.socket.send(
              w.prefix +
                JSON.stringify(kind === 'apology' ? ['game', 'chat', FAULT_APOLOGY] : ['game', 'concede']),
            );
            ctx.faultLedger[kind + 'Outcome'] = 'native-queued';
            saveSession(ctx);
            return { queued: true, attempted: true, outcome: 'native-queued', ledger: ctx.faultLedger };
          } catch {
            return { queued: false, attempted: true, outcome: 'unknown', ledger: ctx.faultLedger };
          } finally {
            info.managed = false;
          }
        },
      }),
      configurable: false,
      writable: false,
    });
  function transportKey(url) {
    try {
      const u = new URL(url, location.href);
      // Current upstream has a separate /<game-node>/socket.io transport. Ignore the lobby.
      if (!/^\/[^/]+\/socket\.io\/?$/.test(u.pathname)) return null;
      return u.origin.replace(/^ws/, 'http') + u.pathname.replace(/\/$/, '');
    } catch {
      return null;
    }
  }
  // Engine.IO session IDs are used only in memory to distinguish a native
  // reconnect from polling->WS upgrade. Never forward them, URLs with queries,
  // authentication values, or arbitrary CloseEvent.reason text.
  const RECOVERY_MS = 60000,
    RECOVERY_PACKETS = 128,
    RECOVERY_CHARS = 4 * 1024 * 1024;
  function transportInfo(url) {
    let engineId = null;
    try {
      engineId = new URL(url, location.href).searchParams.get('sid');
    } catch {}
    return {
      key: transportKey(url),
      epoch: current.recovery?.epoch ?? current.transportEpoch,
      sessionId: current.id,
      engineId,
      hadSid: engineId !== null,
    };
  }
  function transportBinding(ctx) {
    return { epoch: ctx.transportEpoch, path: ctx.key };
  }
  function isFullState(value) {
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.id === 'string' &&
      value.players &&
      typeof value.players === 'object' &&
      !Array.isArray(value.players)
    );
  }
  function closeDiagnostic(event) {
    const reason =
      typeof event?.reason !== 'string'
        ? 'unreported'
        : event.reason === ''
          ? 'empty'
          : ['transport close', 'transport error', 'ping timeout'].includes(event.reason)
            ? event.reason
            : 'nonempty-redacted';
    return {
      code: Number.isSafeInteger(event?.code) && event.code >= 1000 && event.code <= 4999 ? event.code : null,
      wasClean: typeof event?.wasClean === 'boolean' ? event.wasClean : null,
      reason,
    };
  }
  function recoveryFailure(ctx, reason) {
    if (managed) {
      if (ctx.delivery?.sendTicket) notifyStop(ctx, '/unknown', { ...ctx.delivery, reason });
      else notifyStop(ctx, '/detach', { reason });
    } else notifyStop(ctx, '/disconnect', { reason });
  }
  function observeHandshake(ctx, info, part) {
    if (!part.startsWith('0{')) return;
    let sid;
    try {
      sid = JSON.parse(part.slice(1)).sid;
    } catch {
      return;
    }
    if (typeof sid !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(sid)) return;
    if (info.engineId && info.engineId !== sid) return;
    info.engineId = sid;
    const r = ctx.recovery;
    if (!r || info.sessionId !== ctx.id || info.epoch !== r.epoch || info.key !== ctx.key || info.hadSid)
      return;
    if (sid === ctx.engineId) return;
    if (r.engineId && r.engineId !== sid && (r.buffer.length || r.resuming)) {
      recoveryFailure(ctx, 'transport-generation-changed-during-resync');
      return;
    }
    r.engineId = sid;
  }
  function bindRecoverySocket(ctx, ws) {
    const r = ctx.recovery,
      info = socketInfo.get(ws);
    if (
      r &&
      info?.ready &&
      info.sessionId === ctx.id &&
      info.epoch === r.epoch &&
      info.key === ctx.key &&
      r.engineId &&
      info.engineId === r.engineId
    ) {
      if (r.socket && r.socket !== ws) recoveryFailure(ctx, 'transport-socket-replaced-during-resync');
      else {
        r.socket = ws;
        resumeWhenReady(ctx);
      }
    }
  }
  async function establishIdleClose(ctx) {
    const r = ctx.recovery;
    if (!r || r.starting || r.accepted || ctx.paused) return;
    r.starting = true;
    try {
      // All old received frames and any already issued decision request must
      // reach the bridge before it tests whether the old position was idle.
      await ctx.queue;
      if (current !== ctx || ctx.paused || ctx.recovery !== r) return;
      if (ctx.polling) return; // Its finally block re-enters this handshake.
      if (ctx.delivery) throw Error('transport-close-with-unsettled-delivery');
      const reply = await post(ctx, '/transport-close', {
        sequence: ctx.sequence,
        activity: ctx.activity,
        gameId: ctx.gameId,
        transport: transportBinding(ctx),
        nextEpoch: r.epoch,
        diagnostic: r.diagnostic,
      });
      if (current !== ctx || ctx.paused || ctx.recovery !== r) return;
      if (reply.status === 'finished' && reply.gameId === ctx.gameId && reply.sequence === ctx.sequence) {
        ctx.recovery = null;
        ctx.paused = true;
        return;
      }
      if (
        (!managed &&
          (reply.status !== 'waiting-for-transport' || reply.transportRecovery?.epoch !== r.epoch)) ||
        (managed && reply.lifecycle !== 'detached') ||
        reply.sequence !== ctx.sequence ||
        reply.activity !== ctx.activity ||
        reply.gameId !== ctx.gameId
      )
        throw Error('transport-close-not-confirmed-idle');
      r.accepted = true;
      resumeWhenReady(ctx);
    } catch (error) {
      pause(ctx, error);
      recoveryFailure(ctx, 'transport-idle-close-failed');
    } finally {
      r.starting = false;
    }
  }
  function beginRecovery(ctx, event) {
    const diagnostic = closeDiagnostic(event);
    console.info(
      '[KF bridge transport-close] ' + JSON.stringify({ epoch: ctx.transportEpoch, ...diagnostic }),
    );
    if (ctx.recovery || ctx.delivery || !ctx.engineId || !ctx.gameId || !ctx.sequence) {
      recoveryFailure(ctx, 'game-transport-closed');
      return;
    }
    ctx.recovery = {
      epoch: ctx.transportEpoch + 1,
      deadline: Date.now() + RECOVERY_MS,
      diagnostic,
      buffer: [],
      chars: 0,
      engineId: null,
      socket: null,
      accepted: false,
      starting: false,
      resuming: false,
    };
    void establishIdleClose(ctx);
  }
  function bufferRecoveryState(ctx, packet, info, ws, chars) {
    const r = ctx.recovery;
    if (!r || info.epoch !== r.epoch) return;
    if (!r.engineId || info.engineId !== r.engineId) {
      recoveryFailure(ctx, 'transport-full-state-without-new-engine-handshake');
      return;
    }
    const full = isFullState(packet.event[1]);
    if (!r.buffer.length && !r.resuming && !full) {
      recoveryFailure(ctx, 'transport-new-generation-needs-full-state');
      return;
    }
    if ((r.buffer.length || r.resuming) && full) {
      recoveryFailure(ctx, 'transport-repeated-full-state');
      return;
    }
    if (r.buffer.length >= RECOVERY_PACKETS || (r.chars += chars) > RECOVERY_CHARS) {
      recoveryFailure(ctx, 'transport-recovery-buffer-limit');
      return;
    }
    r.buffer.push({ delta: packet.event[1], prefix: packet.prefix });
    if (ws) {
      socketInfo.get(ws).ready = true;
      bindRecoverySocket(ctx, ws);
    } else {
      const candidate = socketsByPath.get(ctx.key);
      if (candidate) bindRecoverySocket(ctx, candidate);
    }
    resumeWhenReady(ctx);
  }
  function resumeWhenReady(ctx) {
    const r = ctx.recovery;
    if (
      !r ||
      !r.accepted ||
      r.resuming ||
      ctx.paused ||
      !r.buffer.length ||
      !r.socket ||
      r.socket.readyState !== NativeWebSocket.OPEN ||
      !socketInfo.get(r.socket)?.ready
    )
      return;
    r.resuming = true;
    const first = r.buffer.shift();
    ctx.queue = (async () => {
      const sequence = ctx.sequence + 1;
      const reply = await post(ctx, '/transport-resume', {
        sequence,
        activity: ctx.activity,
        gameId: ctx.gameId,
        transport: { epoch: r.epoch, path: ctx.key },
        previousEpoch: ctx.transportEpoch,
        nativeFullState: true,
        newEngineHandshake: true,
        fullState: first.delta,
        ...(managed ? { previousOwnerEpoch: ctx.ownerEpoch, deliveryLedger: ctx.deliveryLedger } : {}),
      });
      if (current !== ctx || ctx.paused || ctx.recovery !== r) return;
      if (
        reply.status === 'send-outcome-unknown' ||
        reply.transportRecovery ||
        reply.transport?.epoch !== r.epoch ||
        reply.sequence !== sequence ||
        reply.activity !== ctx.activity ||
        reply.gameId !== ctx.gameId
      )
        throw Error('transport-full-resync-not-accepted');
      ctx.transportEpoch = r.epoch;
      ctx.engineId = r.engineId;
      ctx.socket = r.socket;
      ctx.sequence = sequence;
      ctx.prefix = first.prefix;
      while (r.buffer.length) {
        if (current !== ctx || ctx.paused || ctx.recovery !== r) return;
        const next = r.buffer.shift();
        ctx.prefix = next.prefix;
        await post(ctx, '/state', {
          sequence: ++ctx.sequence,
          delta: next.delta,
          transport: transportBinding(ctx),
        });
      }
      ctx.recovery = null;
    })().catch((error) => {
      pause(ctx, error);
      recoveryFailure(ctx, 'transport-full-resync-failed');
    });
  }
  function sameDelivery(a, b) {
    return (
      !!a &&
      !!b &&
      ['decisionId', 'sendTicket', 'sequence', 'documentId', 'ownerEpoch', 'queuedCount', 'planId'].every(
        (key) => a[key] === b[key],
      )
    );
  }
  async function reconcileObservedDelivery(ticket, expiresAt) {
    const ctx = current,
      now = Date.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return { ok: false, reason: 'receipt-expired' };
    if (!faultMatches(ticket, false) || !ctx.paused || ctx.receiptProbe)
      return { ok: false, reason: 'receipt-binding-changed' };
    const ledger = ctx.deliveryLedger,
      delivery = ctx.delivery,
      candidate = ledger ?? delivery;
    if (
      !candidate ||
      candidate.documentId !== ctx.id ||
      candidate.ownerEpoch !== ctx.ownerEpoch ||
      typeof candidate.decisionId !== 'string' ||
      typeof candidate.sendTicket !== 'string' ||
      !Number.isSafeInteger(candidate.sequence) ||
      candidate.sequence < 1 ||
      !Number.isSafeInteger(candidate.queuedCount) ||
      candidate.queuedCount < 1 ||
      (ledger ? ledger.stage !== 'queued' : delivery.queuedCount !== delivery.expectedCount) ||
      (ledger && delivery && !sameDelivery(ledger, delivery))
    )
      return { ok: false, reason: 'receipt-ledger-not-complete' };
    const sent = { ...candidate },
      deadline = Math.min(expiresAt, now + 5000);
    ctx.receiptProbe = true;
    try {
      // Independent of the ordinary queue. This endpoint only proves an existing observed effect.
      const reply = await post(
        ctx,
        '/sent',
        { ...sent, receiptOnly: true },
        { acceptReceipt: false, timeout: Math.max(1, deadline - Date.now()) },
      );
      if (
        Date.now() >= deadline ||
        current !== ctx ||
        !ctx.paused ||
        ctx.operatorPaused ||
        ctx.watchdog.invalid ||
        ctx.watchdog.closing ||
        ctx.deliveryLedger !== ledger ||
        ctx.delivery !== delivery ||
        (ledger && !sameDelivery(ledger, sent)) ||
        (delivery && !sameDelivery(delivery, sent)) ||
        reply.gameId !== ctx.gameId ||
        reply.documentId !== ctx.id ||
        reply.ownerEpoch !== ctx.ownerEpoch ||
        !Number.isSafeInteger(reply.receiptOrdinal) ||
        reply.receiptOrdinal <= ctx.ownerReceiptOrdinal ||
        reply.sendPending !== null ||
        !Array.isArray(reply.pendingDeliveries) ||
        reply.pendingDeliveries.length !== 0 ||
        reply.observedDelivery?.stage !== 'observed' ||
        !sameDelivery(reply.observedDelivery, sent)
      )
        return { ok: false, reason: 'receipt-proof-unavailable' };
      // Persist first; a storage failure must leave both in-memory ledgers and the ordinal intact.
      // There is no await between the successful write and these exact-CAS memory updates.
      saveSession(ctx, null);
      ctx.ownerReceiptOrdinal = reply.receiptOrdinal;
      ctx.deliveryLedger = null;
      ctx.delivery = null;
      // Stay paused: skipped deltas require a fresh native full state after the controlled reload.
      return { ok: true, reason: 'observed-delivery-proven', documentId: ctx.id, ownerEpoch: ctx.ownerEpoch };
    } catch {
      return { ok: false, reason: 'receipt-proof-unavailable' };
    } finally {
      ctx.receiptProbe = false;
    }
  }
  function post(ctx, route, payload, { acceptReceipt = true, timeout = 15000 } = {}) {
    return new Promise((resolve, reject) =>
      GM_xmlhttpRequest({
        method: 'POST',
        url: settings.url + route,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.token },
        data: JSON.stringify({
          origin: location.origin,
          playerName: settings.playerName,
          sessionId: ctx.id,
          ...(managed ? { documentId: ctx.id, tabId, gameId: ctx.gameId, ownerEpoch: ctx.ownerEpoch } : {}),
          ...payload,
        }),
        timeout,
        onload: (r) => {
          try {
            const body = JSON.parse(r.responseText);
            if (r.status === 200) {
              if (acceptReceipt) acceptOwner(ctx, body, route);
              resolve(body);
            } else
              reject(
                Object.assign(Error(body.error ?? 'Bridge request failed'), {
                  code: body.code,
                  managed: body.managed,
                }),
              );
          } catch (e) {
            reject(e);
          }
        },
        onerror: () =>
          reject(Object.assign(Error('Local bridge unavailable'), { code: 'bridge-unavailable' })),
        ontimeout: () => reject(Object.assign(Error('Local bridge timeout'), { code: 'bridge-timeout' })),
      }),
    );
  }
  function pause(ctx, error) {
    ctx.paused = true;
    ctx.pauseReason = [
      'superseded-owner',
      'current-document-unavailable',
      'bridge-timeout',
      'bridge-unavailable',
    ].includes(error?.code)
      ? error.code
      : 'bridge-request-failed';
    if (error?.code === 'superseded-owner') ctx.watchdog.invalid = true;
    console.warn('[KF bridge paused]', error.message);
  }
  function notifyStop(ctx, route, payload) {
    ctx.paused = true;
    ctx.pauseReason = 'transport-or-activity-stop';
    void post(ctx, route, payload).catch((error) => pause(ctx, error));
  }
  function outgoing(raw, key) {
    const ctx = current;
    if (faultEnabled && key === ctx.watchdog.key && typeof raw === 'string') {
      for (const part of raw.split('\x1e')) {
        const event = parsePacket(part)?.event;
        if (
          event?.[0] === 'game' &&
          !(event.length === 3 && event[1] === 'showDrawDeck' && event[2] === false) &&
          !(event.length === 3 && event[1] === 'chat' && plainChat(event[2]))
        ) {
          ctx.operatorPaused = true;
          saveSession(ctx);
        }
      }
    }
    if (!key || key !== ctx.key || ctx.paused) return;
    if (typeof raw !== 'string') {
      ctx.activity++;
      notifyStop(ctx, '/activity', { epoch: ctx.activity, reason: 'uninspectable-game-transport-write' });
      return;
    }
    for (const part of raw.split('\x1e')) {
      const event = parsePacket(part)?.event;
      if (event?.[0] !== 'game') continue;
      // DrawDeck automatically emits this exact presentation notification when a
      // server-driven search popup closes. It is not a card choice or an ACK.
      // Inspect the remaining polling packets: a later real action still pauses.
      if (event.length === 3 && event[1] === 'showDrawDeck' && event[2] === false) {
        console.info('[KF bridge presentation] showDrawDeck(false)');
        continue;
      }
      // Ordinary chat cannot change the game. Slash/command text still takes the
      // external-action path because manual-mode servers can execute it.
      if (event.length === 3 && event[1] === 'chat' && plainChat(event[2])) {
        console.info('[KF bridge social] ordinary-chat');
        continue;
      }
      const knownNames = [
        'cardClicked',
        'menuButton',
        'menuItemClick',
        'clickTide',
        'clickProphecy',
        'showDrawDeck',
        'showDeck',
        'shuffleDeck',
        'drop',
        'chat',
        'concede',
        'forcePass',
        'leavegame',
        'toggleManualMode',
        'toggleMuteSpectators',
        'toggleOptionSetting',
        'changeActiveHouse',
        'changeStat',
        'modifyKey',
      ];
      const name = knownNames.includes(event[1]) ? event[1] : 'other';
      // Only a fixed opcode name is diagnostic; never copy message arguments.
      console.info('[KF bridge external-command] ' + name);
      ctx.activity++;
      notifyStop(ctx, '/activity', { epoch: ctx.activity, reason: 'external-game-command' });
      return;
    }
  }
  function plainChat(text) {
    return (
      typeof text === 'string' &&
      text.length > 0 &&
      text.length <= 500 &&
      !/^[\s\u200b-\u200f\u202a-\u202e\u2060-\u2069]*[\/!]/u.test(text) &&
      !/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u.test(text)
    );
  }
  function parsePacket(raw) {
    if (typeof raw !== 'string' || !raw.startsWith('42')) return null;
    const i = raw.indexOf('[');
    if (i < 0) return null;
    const header = raw.slice(2, i),
      comma = header.startsWith('/') ? header.indexOf(',') : -1;
    const prefix = '42' + (comma >= 0 ? header.slice(0, comma + 1) : ''); // Do not reuse an incoming acknowledgement id.
    try {
      const event = JSON.parse(raw.slice(i));
      return Array.isArray(event) ? { prefix, event } : null;
    } catch {
      return null;
    }
  }
  function receive(raw, url, ws, info) {
    const key = transportKey(url);
    if (!key || typeof raw !== 'string' || !info) return;
    for (const part of raw.split('\x1e')) {
      const ctx = current;
      if (info.sessionId === ctx.id) {
        observeHandshake(ctx, info, part);
        const beforeNative = ctx.watchdog.sequence;
        faultReceive(ctx, info, parsePacket(part), key, ws);
        if (ctx.paused && ctx.watchdog.sequence > beforeNative) ctx.ingress.skippedNative++;
      }
      if (ctx.paused || info.sessionId !== ctx.id || info.epoch < (ctx.recovery?.epoch ?? ctx.transportEpoch))
        continue;
      observeHandshake(ctx, info, part);
      const packet = parsePacket(part);
      if (!packet) continue;
      if (ctx.key && ctx.key !== key && ['gamestate', 'cleargamestate'].includes(packet.event[0])) {
        recoveryFailure(ctx, 'game-transport-path-changed');
        continue;
      }
      if (packet.event[0] === 'cleargamestate' && ctx.key === key) {
        if (ctx.recovery) {
          recoveryFailure(ctx, 'game-cleared-during-transport-recovery');
          continue;
        }
        const old = ctx;
        old.paused = true;
        old.queue = old.queue.then(() => post(old, '/clear', {})).catch((error) => pause(old, error));
        current = fresh();
        // Native clear can keep the same connection for a different game. It
        // remains a separate path; a reconnect never rotates this identity.
        if (ws) {
          info.sessionId = current.id;
          info.epoch = 0;
        }
        continue;
      }
      if (packet.event[0] !== 'gamestate' || ctx.paused) continue;
      if (ctx.recovery) {
        bufferRecoveryState(ctx, packet, info, ws, part.length);
        continue;
      }
      if (info.epoch !== ctx.transportEpoch) {
        recoveryFailure(ctx, 'transport-generation-unbound');
        continue;
      }
      if (ctx.engineId && info.engineId && info.engineId !== ctx.engineId) {
        recoveryFailure(ctx, 'game-engine-replaced-without-close');
        continue;
      }
      ctx.key = key;
      ctx.engineId ??= info.engineId;
      if (!ctx.gameId && typeof packet.event[1]?.id === 'string') ctx.gameId = packet.event[1].id;
      ctx.prefix = packet.prefix;
      if (ws) {
        if (ctx.socket && ctx.socket !== ws) {
          recoveryFailure(ctx, 'game-socket-replaced-without-clear');
          continue;
        }
        ctx.socket = ws;
        socketInfo.get(ws).ready = true;
      } else {
        const candidate = socketsByPath.get(key),
          candidateInfo = candidate && socketInfo.get(candidate);
        if (
          candidateInfo?.ready &&
          candidateInfo.epoch === ctx.transportEpoch &&
          candidateInfo.sessionId === ctx.id &&
          (!ctx.engineId || candidateInfo.engineId === ctx.engineId)
        )
          ctx.socket = candidate;
      }
      const sequence = ++ctx.sequence,
        delta = packet.event[1],
        transport = transportBinding(ctx);
      let skipped = false;
      ctx.queue = ctx.queue
        .then(() => {
          if (ctx.paused) {
            skipped = true;
            ctx.ingress.skippedQueued++;
            return;
          }
          ctx.ingress.startedSequence = sequence;
          ctx.ingress.lastResult = 'pending';
          if (managed && sequence === 1) {
            if (!isFullState(delta)) throw Error('Managed attach needs a native full player state');
            return post(ctx, '/attach', {
              sequence,
              fullState: delta,
              transport,
              nativeFullState: true,
              newEngineHandshake: Boolean(ctx.engineId),
              previousOwnerEpoch: ctx.previousGameId === ctx.gameId ? ctx.previousOwnerEpoch : undefined,
              deliveryLedger: ctx.previousGameId === ctx.gameId ? ctx.deliveryLedger : undefined,
            });
          }
          return post(ctx, '/state', { sequence, delta, transport });
        })
        .then(() => {
          ctx.ingress.settledSequence = sequence;
          ctx.ingress.lastResult = skipped ? 'skipped-paused' : 'accepted';
        })
        .catch((error) => {
          ctx.ingress.settledSequence = sequence;
          ctx.ingress.lastResult = 'failed';
          pause(ctx, error);
        });
    }
  }
  const NativeWebSocket = unsafeWindow.WebSocket;
  unsafeWindow.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args) {
      const ws = new Target(...args),
        key = transportKey(args[0]);
      socketInfo.set(ws, { ...transportInfo(args[0]), ready: false, managed: false });
      if (key) socketsByPath.set(key, ws);
      const send = ws.send;
      ws.send = function (data) {
        if (!socketInfo.get(ws).managed) outgoing(data, key);
        const result = send.call(ws, data);
        if (data === '5') {
          socketInfo.get(ws).ready = true;
          faultBindSocket(current, ws);
          if (key && current.key === key && !current.paused) {
            if (current.recovery) bindRecoverySocket(current, ws);
            else if (socketInfo.get(ws).epoch !== current.transportEpoch) return result;
            else if (current.engineId && socketInfo.get(ws).engineId !== current.engineId)
              recoveryFailure(current, 'game-engine-replaced-without-close');
            else if (current.socket && current.socket !== ws)
              recoveryFailure(current, 'game-socket-replaced-without-clear');
            else if (!current.paused) current.socket = ws;
          }
        }
        return result;
      };
      ws.addEventListener('message', (event) => receive(event.data, args[0], ws, socketInfo.get(ws)));
      ws.addEventListener('close', (event) => {
        if (current.paused || current.key !== key) return;
        if (current.recovery?.socket === ws) recoveryFailure(current, 'transport-reconnected-socket-closed');
        else if (current.socket === ws && !current.recovery) beginRecovery(current, event);
      });
      return ws;
    },
  });
  // Engine.IO normally starts with HTTP polling. Capture that initial full view before WS upgrade.
  const NativeXHR = unsafeWindow.XMLHttpRequest;
  if (NativeXHR) {
    const open = NativeXHR.prototype.open,
      send = NativeXHR.prototype.send,
      xhrInfo = new WeakMap();
    NativeXHR.prototype.open = function (method, url, ...rest) {
      const info = { ...transportInfo(url), method: String(method).toUpperCase() };
      xhrInfo.set(this, info);
      if (transportKey(url))
        this.addEventListener(
          'load',
          () => {
            if (!this.responseType || this.responseType === 'text')
              receive(this.responseText, url, null, info);
          },
          { once: true },
        );
      return open.call(this, method, url, ...rest);
    };
    if (typeof send === 'function')
      NativeXHR.prototype.send = function (body) {
        const info = xhrInfo.get(this);
        if (info?.method === 'POST') outgoing(body, info.key);
        return send.call(this, body);
      };
  }
  if (unsafeWindow.fetch) {
    const nativeFetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function (input, ...rest) {
      const url = typeof input === 'string' ? input : input?.url;
      const method = String(rest[0]?.method ?? input?.method ?? 'GET').toUpperCase(),
        info = transportInfo(url);
      if (method === 'POST') outgoing(rest[0]?.body, transportKey(url));
      const promise = nativeFetch.call(this, input, ...rest);
      if (transportKey(url))
        promise
          .then((response) =>
            response
              .clone()
              .text()
              .then((raw) => receive(raw, url, null, info)),
          )
          .catch(() => {});
      return promise;
    };
  }
  function commandsFor(d) {
    if (!d || typeof d.decisionId !== 'string' || !d.decisionId) throw Error('Missing decision binding');
    if (d.plan) {
      const p = d.plan;
      if (
        d.command ||
        p.kind !== 'keyteki-allocation-plan-v1' ||
        typeof p.id !== 'string' ||
        typeof p.promptUuid !== 'string' ||
        !p.promptUuid ||
        typeof p.sourceCardId !== 'string' ||
        !p.sourceCardId ||
        !Number.isSafeInteger(p.amount) ||
        p.amount < 1 ||
        !Array.isArray(p.commands) ||
        p.commands.length !== p.amount ||
        !Array.isArray(p.targets) ||
        p.targets.length !== p.amount ||
        !Array.isArray(p.allowedTargets) ||
        !p.allowedTargets.length ||
        new Set(p.allowedTargets).size !== p.allowedTargets.length ||
        p.allowedTargets.some((t) => typeof t !== 'string' || !t) ||
        p.commands.some(
          (c, i) =>
            c.message !== 'cardClicked' ||
            !Array.isArray(c.args) ||
            c.args.length !== 1 ||
            c.args[0] !== p.targets[i] ||
            !p.allowedTargets.includes(c.args[0]) ||
            c.sourceCardId !== p.sourceCardId,
        )
      )
        throw Error('Invalid complete allocation plan');
      return p.commands;
    }
    if (
      !d.command ||
      !['cardClicked', 'menuButton', 'clickTide', 'clickProphecy'].includes(d.command.message) ||
      !Array.isArray(d.command.args)
    )
      throw Error('Unrecognized game command');
    return [d.command];
  }
  async function pollSocial(ctx) {
    if (
      !managed ||
      settings.socialEnabled !== true ||
      ctx.socialPolling ||
      Date.now() - ctx.socialLastPoll < 2000
    )
      return;
    ctx.socialPolling = true;
    ctx.socialLastPoll = Date.now();
    let packet = null,
      queued = false;
    const valid = (value, ws) =>
      current === ctx &&
      !ctx.paused &&
      !ctx.recovery &&
      ctx.socket === ws &&
      ws?.readyState === NativeWebSocket.OPEN &&
      value?.binding?.gameId === ctx.gameId &&
      value.binding.playerName === settings.playerName &&
      value.binding.ownerEpoch === String(ctx.ownerEpoch) &&
      value.expiresAt >= Date.now() &&
      plainChat(value.text);
    try {
      const ws = ctx.socket;
      const next = await post(ctx, '/social/next', {});
      packet = next.packet;
      if (!packet) return;
      if (!valid(packet, ws) || ctx.socialSent.has(packet.messageId)) return;
      const authorized = await post(ctx, '/social/send-intent', { messageId: packet.messageId });
      packet = authorized.packet;
      if (!authorized.authorized || !valid(packet, ws)) return;
      const info = socketInfo.get(ws);
      ctx.socialSent.add(packet.messageId);
      info.managed = true;
      try {
        ws.send(ctx.prefix + JSON.stringify(['game', 'chat', packet.text]));
        queued = true;
      } finally {
        info.managed = false;
      }
      console.info('[KF bridge social] queued');
    } catch (error) {
      if (error.code === 'superseded-owner') pause(ctx, error);
      // Chat inference/transport failure never stops gameplay or retries a message.
      console.info('[KF bridge social] skipped');
    } finally {
      if (packet) {
        await post(ctx, '/social/sent', {
          messageId: packet.messageId,
          outcome: queued ? 'confirmed' : 'not-sent',
        }).catch(() => {});
      }
      ctx.socialPolling = false;
    }
  }
  if (managed && typeof unsafeWindow.addEventListener === 'function') {
    unsafeWindow.addEventListener('pagehide', () => {
      const ctx = current;
      ctx.watchdog.closing = true;
      if (!ctx.gameId || !Number.isSafeInteger(ctx.ownerEpoch)) return;
      ctx.paused = true;
      // This is a best-effort detach; the next document can also use its stored
      // previous epoch when navigation destroys the request before delivery.
      void post(ctx, '/detach', { reason: 'document-pagehide' }).catch(() => {});
    });
  }
  setInterval(async () => {
    const ctx = current,
      ws = ctx.socket;
    // Observation retries are independent of strategy polling, pause and unresolved game sends.
    void drainFaultObservations(ctx);
    if (ctx.recovery && !ctx.paused) {
      if (Date.now() >= ctx.recovery.deadline) recoveryFailure(ctx, 'transport-recovery-timeout');
      else void establishIdleClose(ctx);
      return;
    }
    if (
      ctx.paused ||
      ctx.polling ||
      !ctx.key ||
      !ctx.gameId ||
      ctx.sequence < 1 ||
      !ws ||
      ws.readyState !== NativeWebSocket.OPEN ||
      !socketInfo.get(ws)?.ready
    )
      return;
    if (Number.isSafeInteger(ctx.ownerEpoch)) void pollSocial(ctx);
    ctx.polling = true;
    try {
      await ctx.queue;
      if (current !== ctx || ctx.paused || ctx.recovery || ctx.socket !== ws) return;
      const reply = await post(ctx, '/decision', {});
      let d = reply.decision;
      if (current !== ctx || ctx.paused || ctx.socket !== ws) return;
      if (ctx.recovery) {
        if (d && !managed) recoveryFailure(ctx, 'transport-close-with-pending-decision');
        return;
      }
      if (!d) return;
      if (ctx.sent.has(d.decisionId)) throw Error('Duplicate command delivery');
      if (d.sequence !== ctx.sequence || d.activity !== ctx.activity || d.gameId !== ctx.gameId) {
        await post(ctx, '/reject', { decisionId: d.decisionId, reason: 'newer-player-state' });
        return;
      }
      if (managed) {
        const authorization = await post(ctx, '/send-intent', {
          decisionId: d.decisionId,
          sequence: d.sequence,
        });
        d = authorization.decision;
        if (!d?.sendAuthorized || !d.sendTicket) throw Error('Missing managed send authorization');
        if (
          current !== ctx ||
          ctx.paused ||
          ctx.recovery ||
          ctx.socket !== ws ||
          d.sequence !== ctx.sequence ||
          d.activity !== ctx.activity ||
          d.gameId !== ctx.gameId
        ) {
          await post(ctx, '/reject', {
            decisionId: d.decisionId,
            sequence: d.sequence,
            sendTicket: d.sendTicket,
            reason: 'client-not-sent',
          });
          return;
        }
      }
      const commands = commandsFor(d),
        info = socketInfo.get(ws);
      ctx.delivery = {
        decisionId: d.decisionId,
        sequence: d.sequence,
        ...(d.plan ? { planId: d.plan.id } : {}),
        queuedCount: 0,
        expectedCount: commands.length,
        ...(managed ? { sendTicket: d.sendTicket, ownerEpoch: ctx.ownerEpoch, documentId: ctx.id } : {}),
      };
      if (managed) {
        ctx.deliveryLedger = { ...ctx.delivery, stage: 'sending' };
        saveSession(ctx);
      }
      // Mark before the first send: an exception never authorizes replay of a prefix.
      ctx.sent.add(d.decisionId);
      info.managed = true;
      try {
        // Ordinary messages on the original game connection, queued synchronously.
        // Native send returning means queued locally, never accepted by the server.
        for (const command of commands) {
          if (current !== ctx || ctx.paused || ctx.socket !== ws || ws.readyState !== NativeWebSocket.OPEN)
            throw Error('Game transport interrupted during send');
          ws.send(ctx.prefix + JSON.stringify(['game', command.message, ...command.args]));
          ctx.delivery.queuedCount++;
          if (managed) {
            ctx.deliveryLedger = {
              ...ctx.delivery,
              stage: ctx.delivery.queuedCount === commands.length ? 'queued' : 'sending',
            };
            saveSession(ctx);
          }
        }
      } finally {
        info.managed = false;
      }
      await post(ctx, '/sent', ctx.delivery);
      ctx.delivery = null;
    } catch (error) {
      if (managed && ['managed-stale-send-intent', 'managed-stale-offer'].includes(error.code)) return;
      pause(ctx, error);
      if (ctx.delivery) {
        // A lost local receipt is also unknown. Do not reinterpret it as "not sent".
        try {
          await post(ctx, '/unknown', { ...ctx.delivery, reason: error.message });
        } catch {
          await post(ctx, managed ? '/detach' : '/disconnect', {
            reason: 'client-send-receipt-unavailable',
          }).catch(() => {});
        }
      } else if (managed && error.code !== 'superseded-owner') {
        await post(ctx, '/detach', { reason: 'client-request-interrupted' }).catch(() => {});
      } else if (!managed) await post(ctx, '/disconnect', { reason: error.message }).catch(() => {});
    } finally {
      ctx.polling = false;
      if (ctx.recovery && !ctx.paused) void establishIdleClose(ctx);
    }
  }, 250);
})();
