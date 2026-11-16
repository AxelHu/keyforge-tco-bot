/** Independent launcher supervisor. Its only browser writes are quarantine, reload and two fixed fault messages. */
import { createHumanWatchdog, createWatchdogNativeObserver } from './keyteki-human-watchdog.mjs';
import { checkOwnFullIdentity } from './keyteki-human-bridge-callback.mjs';
import { assertPublicBindingSource, publicGameFrameSummary } from './keyteki-public-browser-game.mjs';
import { validateKeytekiManagedFullState } from './keyteki-wire-session.mjs';
import { hostStopWasRequested, automaticUnjoinedStopMatches } from './keyteki-host-operator-intent.mjs';

const bounded = (promise, ms = 5000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('watchdog-browser-timeout')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Shared by the launcher and browser acceptance, including the asynchronous hold barrier. */
export function createHumanHoldController({ state, hostRequest, getWatchdog, save, onHeld = () => {} }) {
  let holdPromise = null;
  const hold = (code, { operator = false } = {}) => {
    if (operator) {
      state.operatorPaused = true;
      getWatchdog()?.operatorPause();
    }
    if (holdPromise && !operator) return holdPromise;
    state.held = true;
    state.phase = 'held-for-inspection';
    state.holdReason = /^[A-Z0-9_-]{1,100}$/i.test(code ?? '') ? code : 'ONE_SEAT_DRIVER_FAILURE';
    holdPromise = (async () => {
      if (operator) {
        try {
          await hostRequest('/operator', { action: 'pause' });
          state.hostPauseConfirmed = true;
        } catch {
          state.hostPauseConfirmed = false;
        }
      }
      try {
        await getWatchdog()?.quarantine();
      } catch {}
      getWatchdog()?.fault(state.holdReason);
      save();
      onHeld();
    })();
    return holdPromise;
  };
  return {
    hold,
    async clearAutomaticHold() {
      await holdPromise;
      if (state.operatorPaused)
        throw Object.assign(Error('Operator pause must be preserved'), {
          code: 'OPERATOR_PAUSE_MUST_BE_PRESERVED',
        });
      holdPromise = null;
      state.held = false;
      delete state.holdReason;
    },
  };
}

export async function installHumanWatchdog({
  page,
  config,
  connection,
  state,
  observer,
  save,
  hostRequest,
  restartHost,
  clearAutomaticHold,
  onEvent = () => {},
  validateFull,
  observationEnabled = config.watchdog.enabled,
}) {
  const identity = {
    gameId: config.room.gameId,
    playerName: config.self.name,
    participants: config.participants,
  };
  let busy = false,
    closed = false,
    watchdog,
    native,
    interval,
    lastHealth = null;
  const event = (row) => {
    state.watchdog = watchdog?.status();
    onEvent(row);
    save();
  };
  const snapshot = () => bounded(page.evaluate(() => window.__kfHumanFaultGuardian?.snapshot() ?? null));
  const health = async () => {
    if (hostStopWasRequested(config.profile, connection)) {
      state.operatorPaused = true;
      watchdog.operatorPause(true);
      return (lastHealth = { available: false, operatorStopRequested: true });
    }
    try {
      const result = await hostRequest('/status');
      // A stop can be recorded while this successful response was in flight.
      if (hostStopWasRequested(config.profile, connection)) {
        state.operatorPaused = true;
        watchdog.operatorPause(true);
        return (lastHealth = { available: false, operatorStopRequested: true });
      }
      lastHealth = { available: true, ...result };
      if (
        result.paused === true ||
        (result.stopping === true && !automaticUnjoinedStopMatches(config.profile, connection, result))
      )
        watchdog.operatorPause(true);
      const sessions = (result.sessions ?? []).filter(
        (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
      );
      if (sessions.length > 1) {
        watchdog.invalidate('ambiguous-host-session');
        return lastHealth;
      }
      if (sessions[0]) watchdog.bridge(sessions[0]);
      return lastHealth;
    } catch (error) {
      if (hostStopWasRequested(config.profile, connection)) {
        state.operatorPaused = true;
        watchdog.operatorPause(true);
        return (lastHealth = { available: false, operatorStopRequested: true });
      }
      if (error?.code === 'HOST_CONTROL_IDENTITY_CHANGED') watchdog.invalidate('host-identity-changed');
      lastHealth = { available: false };
      return lastHealth;
    }
  };
  const inspect = async (_scope, { purpose = 'act' } = {}) => {
    if (new URL(page.url()).origin !== config.origin) return { valid: false };
    const host = await health(),
      snap = await snapshot(),
      receipt = watchdog.status().receipt;
    if (state.operatorPaused || host.paused || host.stopping || snap?.operatorPaused)
      return { operatorPaused: true };
    if (
      !snap ||
      snap.invalid ||
      !receipt ||
      snap.gameId !== identity.gameId ||
      snap.playerName !== identity.playerName ||
      ['documentId', 'transportPath'].some((k) => snap[k] !== receipt[k]) ||
      (purpose !== 'recover' &&
        (state.watchdogObservationGap ||
          ['nativeSequence', 'frameToken'].some((k) => snap[k] !== receipt[k])))
    )
      return { valid: false };
    const owner = host.sessions?.find(
      (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
    );
    if (owner?.documentId && owner.documentId !== snap.documentId) {
      // A just-reloaded document may still await its attach receipt. Never act on another owner's ticket.
      if (Number.isSafeInteger(snap.ownerEpoch) && owner.ownerEpoch > snap.ownerEpoch)
        watchdog.invalidate('superseded-owner');
      return { valid: false };
    }
    if (owner && Number.isSafeInteger(snap.ownerEpoch) && owner.ownerEpoch !== snap.ownerEpoch)
      return { valid: false };
    return { valid: true, binding: snap };
  };
  watchdog = createHumanWatchdog({
    identity,
    config: config.watchdog,
    onEvent: event,
    inspect,
    recover: async ({ binding, signal, isCurrent, unknownSend }) => {
      const recoveryRunId = connection.runId,
        stillCurrent = () => !signal.aborted && isCurrent() && !state.operatorPaused;
      let receiptRecoveryGuard = null;
      if (!stillCurrent()) return { ok: false, reason: 'recovery-cancelled' };
      let isolated = false,
        currentBinding = binding;
      for (let attempt = 0; attempt < 3 && stillCurrent(); attempt++) {
        if (attempt) {
          const proof = await inspect(undefined, { purpose: 'recover' });
          if (!proof.valid) break;
          currentBinding = proof.binding;
        }
        isolated = await bounded(
          page.evaluate(
            (ticket) => window.__kfHumanFaultGuardian?.quarantine(ticket) ?? false,
            currentBinding,
          ),
        );
        if (isolated) break;
      }
      if (!isolated || !stillCurrent()) return { ok: false, reason: 'quarantine-binding-changed' };
      let isolatedSnapshot = await snapshot(),
        host = await health(),
        hostSession = host.sessions?.find(
          (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
        );
      if (isolatedSnapshot?.documentId !== currentBinding.documentId)
        return { ok: false, reason: 'quarantine-document-changed' };
      let unresolved = !!(
        unknownSend ||
        isolatedSnapshot.unknownSend ||
        hostSession?.sendPending ||
        hostSession?.status === 'send-outcome-unknown'
      );
      const sendCheck = (phase, proven = false) => {
        try {
          event({
            type: 'recovery-send-check',
            phase,
            observedReceiptProven: proven,
            cachedUnknown: unknownSend === true,
            browserUnknown: isolatedSnapshot?.unknownSend === true,
            deliveryPresent: isolatedSnapshot?.deliveryPresent === true,
            deliveryLedgerPresent: isolatedSnapshot?.deliveryLedgerPresent === true,
            hostAvailable: host.available === true,
            hostPending: !!hostSession?.sendPending,
            hostUnknown: hostSession?.status === 'send-outcome-unknown',
            ordinarySequence: Number.isSafeInteger(isolatedSnapshot?.ordinarySequence)
              ? isolatedSnapshot.ordinarySequence
              : null,
            ordinaryIngress: Object.fromEntries(
              ['startedSequence', 'settledSequence', 'skippedQueued', 'skippedNative'].map((key) => [
                key,
                Number.isSafeInteger(isolatedSnapshot?.ordinaryIngress?.[key]) &&
                isolatedSnapshot.ordinaryIngress[key] >= 0
                  ? isolatedSnapshot.ordinaryIngress[key]
                  : null,
              ]),
            ),
            pauseReason: [
              'watchdog-quarantine',
              'bridge-timeout',
              'bridge-unavailable',
              'bridge-request-failed',
              'current-document-unavailable',
              'superseded-owner',
              'transport-or-activity-stop',
            ].includes(isolatedSnapshot?.pauseReason)
              ? isolatedSnapshot.pauseReason
              : null,
          });
        } catch {
          state.watchdogDiagnosticFailures = (state.watchdogDiagnosticFailures ?? 0) + 1;
        }
      };
      sendCheck('quarantined');
      if (unresolved) {
        const runId = recoveryRunId;
        const exactIdleOwner = (healthResult, snap) => {
          const sessions = healthResult.sessions?.filter(
            (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
          );
          const owner = sessions?.[0];
          return (
            typeof runId === 'string' &&
            runId.length > 0 &&
            connection.runId === runId &&
            healthResult.available === true &&
            healthResult.runId === runId &&
            !healthResult.paused &&
            !healthResult.stopping &&
            sessions?.length === 1 &&
            !(healthResult.restoredSessions ?? []).some(
              (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
            ) &&
            snap?.documentId === currentBinding.documentId &&
            snap.ownerEpoch === currentBinding.ownerEpoch &&
            owner.documentId === snap.documentId &&
            owner.ownerEpoch === snap.ownerEpoch &&
            owner.sendPending === null &&
            Array.isArray(owner.pendingDeliveries) &&
            owner.pendingDeliveries.length === 0 &&
            ![
              'send-outcome-unknown',
              'awaiting-send-outcome',
              'send-not-confirmed',
              'error',
              'unsupported',
            ].includes(owner.status) &&
            !['stopped', 'settling', 'released', 'finished'].includes(owner.lifecycle)
          );
        };
        if (isolatedSnapshot.unknownSend && exactIdleOwner(host, isolatedSnapshot) && stillCurrent()) {
          let proof;
          try {
            proof = await bounded(
              page.evaluate(
                ({ ticket, expiresAt }) =>
                  window.__kfHumanFaultGuardian?.reconcileDelivery?.(ticket, expiresAt) ?? { ok: false },
                { ticket: isolatedSnapshot, expiresAt: Date.now() + 5000 },
              ),
              6000,
            );
          } catch {
            proof = { ok: false };
          }
          if (
            proof?.ok === true &&
            proof.reason === 'observed-delivery-proven' &&
            proof.documentId === currentBinding.documentId &&
            proof.ownerEpoch === currentBinding.ownerEpoch &&
            stillCurrent()
          ) {
            isolatedSnapshot = await snapshot();
            host = await health();
            hostSession = host.sessions?.find(
              (s) => s.gameId === identity.gameId && s.playerName === identity.playerName,
            );
            // Only this exact effect proof can supersede the captured unknown flag. Missing health
            // or another delivery is never treated as an empty host, including across host restarts.
            unresolved = !(
              stillCurrent() &&
              exactIdleOwner(host, isolatedSnapshot) &&
              isolatedSnapshot.unknownSend === false &&
              !isolatedSnapshot.operatorPaused &&
              !isolatedSnapshot.invalid
            );
            if (!unresolved) receiptRecoveryGuard = exactIdleOwner;
            sendCheck('receipt-checked', !unresolved);
          }
        }
        if (unresolved) {
          // Preserve the exact unknown ledger and native connection; no replay or guessed rejection.
          return { ok: false, reason: 'uncertain-send-preserved' };
        }
      }
      if (!stillCurrent() || host.paused || host.stopping)
        return { ok: false, reason: 'operator-or-progress-cancelled' };
      if (!host.available) {
        await restartHost({ signal });
        if (!stillCurrent()) return { ok: false, reason: 'recovery-cancelled-after-host-start' };
      }
      let proof = await inspect(undefined, { purpose: 'recover' });
      if (
        !stillCurrent() ||
        !proof.valid ||
        (receiptRecoveryGuard &&
          (!receiptRecoveryGuard(lastHealth, proof.binding) || proof.binding.unknownSend !== false))
      )
        return { ok: false, reason: 'recovery-binding-changed' };
      await clearAutomaticHold();
      if (receiptRecoveryGuard) {
        // The hold barrier can await older work. Re-read ownership and pending sends after it.
        proof = await inspect(undefined, { purpose: 'recover' });
        if (
          !stillCurrent() ||
          !proof.valid ||
          !receiptRecoveryGuard(lastHealth, proof.binding) ||
          proof.binding.unknownSend !== false
        )
          return { ok: false, reason: 'recovery-cancelled-before-reload' };
      }
      if (hostStopWasRequested(config.profile, connection)) {
        state.operatorPaused = true;
        watchdog.operatorPause(true);
        return { ok: false, reason: 'operator-stop-requested' };
      }
      if (!stillCurrent()) return { ok: false, reason: 'recovery-cancelled-before-reload' };
      state.phase = 'recovering-same-page';
      save();
      // Keep the same page/observer/selection and sessionStorage. This never calls login or selects a deck again.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      return { ok: true, reason: 'same-page-reloaded' };
    },
    act: async (kind, ticket) => {
      // Respect a stop that landed during the final browser snapshot await.
      if (hostStopWasRequested(config.profile, connection)) {
        state.operatorPaused = true;
        watchdog.operatorPause(true);
        return { queued: false, attempted: false, reason: 'operator-stop-requested' };
      }
      const result = await bounded(
        page.evaluate(
          ({ kind, ticket }) =>
            window.__kfHumanFaultGuardian?.act(kind, ticket) ?? {
              queued: false,
              reason: 'guardian-unavailable',
            },
          { kind, ticket },
        ),
      );
      state.lastFaultAction = {
        kind,
        episodeId: ticket.episodeId,
        documentId: ticket.documentId,
        ownerEpoch: ticket.ownerEpoch,
        nativeSequence: ticket.nativeSequence,
        ...result,
      };
      save();
      return result;
    },
  });
  native = createWatchdogNativeObserver({
    identity,
    validateFull:
      validateFull ??
      ((before, full) => {
        checkOwnFullIdentity({ fullState: full, nativeFullState: true, newEngineHandshake: true }, config);
        if (
          !observer.joinRequested ||
          Number(observer.selection?.serverDeckId) !== config.self.serverDeckId ||
          observer.selection?.isStandalone !== false
        )
          throw Error('watchdog-own-selection-unverified');
        validateKeytekiManagedFullState(before, full, identity);
      }),
    onState: (raw, receipt) => {
      watchdog.observe(raw, receipt);
      state.watchdogPublicView = publicGameFrameSummary(raw, identity);
      if (state.watchdogPublicView.winner) {
        state.finished = true;
        state.finalPublicView = state.watchdogPublicView;
        state.phase = 'finished-preserved';
      }
      state.watchdog = watchdog.status();
      save();
    },
  });
  const receiveNativeObservation = (frame, snap) => {
    if (!snap || snap.documentId !== frame?.documentId) return { ignored: true, reason: 'retired-document' };
    try {
      // The page and its game node may have different origins. The frozen guardian binds this
      // endpoint only after a native engine handshake and a full state for the exact game/pair.
      // Reading its current document also fences callbacks in flight across page.reload.
      const url = new URL(frame.transportPath);
      if (
        snap.enabled !== true ||
        snap.invalid ||
        snap.gameId !== identity.gameId ||
        snap.playerName !== identity.playerName ||
        frame.transportPath !== snap.transportPath ||
        !['http:', 'https:'].includes(url.protocol) ||
        !/^\/[^/]+\/socket\.io$/.test(url.pathname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        frame.transportPath !== url.origin + url.pathname
      )
        throw Error('watchdog-native-binding');
      const result = native.receive(frame);
      if (result.accepted && !result.duplicate) {
        state.watchdogObservationGap = false;
        save();
      }
      return result;
    } catch (error) {
      if (error?.message === 'watchdog-native-gap') {
        state.watchdogObservationGap = true;
        watchdog.fault('native-frame-gap-needs-full');
        save();
        return { accepted: false, reason: 'needs-native-full' };
      }
      watchdog.invalidate('native-observation-invalid');
      state.watchdog = watchdog.status();
      save();
      return { accepted: false, reason: 'native-observation-invalid' };
    }
  };
  const pullNativeObservations = async (before) => {
    const receiptBefore = watchdog.status().receipt;
    if (
      !before?.enabled ||
      before.invalid ||
      (!state.watchdogObservationGap &&
        before.observationPending !== undefined &&
        before.observationPending === 0 &&
        receiptBefore?.documentId === before.documentId &&
        receiptBefore?.nativeSequence === before.nativeSequence)
    )
      return;
    const batch = await bounded(page.evaluate(() => window.__kfHumanFaultGuardian?.observations?.() ?? null));
    if (!batch || !Array.isArray(batch.frames) || !batch.frames.length) return;
    const snap = await snapshot();
    // The pull is from the frozen guardian in this configured top document, and still fences
    // callbacks that crossed navigation. The payloads are original ingress frames, never a fabricated full.
    if (
      new URL(page.url()).origin !== config.origin ||
      !snap ||
      !batch.snapshot ||
      ['documentId', 'transportPath', 'gameId', 'playerName'].some(
        (key) => batch.snapshot[key] !== snap[key],
      ) ||
      !Number.isSafeInteger(batch.snapshot.nativeSequence) ||
      batch.snapshot.nativeSequence > snap.nativeSequence ||
      batch.frames.length > 128 ||
      batch.frames.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0) > 4 * 1024 * 1024
    )
      return;
    let accepted = 0;
    for (const frame of batch.frames) {
      const result = receiveNativeObservation(frame, snap);
      if (result.accepted && !result.duplicate) accepted++;
      if (watchdog.status().phase === 'disarmed') return;
    }
    const receipt = watchdog.status().receipt;
    if (receipt?.documentId === snap.documentId && receipt.transportPath === snap.transportPath) {
      // If a push ACK was lost or overtaken, the exact original receipt safely prunes its pending prefix.
      // This method cannot touch a strategy send ledger or cause a native game write.
      await bounded(
        page.evaluate(
          (value) => window.__kfHumanFaultGuardian?.acknowledgeObservation?.(value) ?? false,
          receipt,
        ),
      );
    }
    state.watchdogObservationReplay = {
      pulls: (state.watchdogObservationReplay?.pulls ?? 0) + 1,
      acceptedFrames: (state.watchdogObservationReplay?.acceptedFrames ?? 0) + accepted,
      acceptedNativeSequence: receipt?.nativeSequence ?? null,
      overflow: batch.snapshot.observationOverflow === true,
    };
    save();
  };
  await page.exposeBinding('__kfWatchdogFrame', async (source, frame) => {
    try {
      assertPublicBindingSource(source, { page, origin: config.origin });
    } catch {
      watchdog.invalidate('native-source-scope-invalid');
      save();
      return { accepted: false };
    }
    let snap;
    try {
      snap = await snapshot();
    } catch {
      return { ignored: true, reason: 'document-changing-or-unavailable' };
    }
    return receiveNativeObservation(frame, snap);
  });
  const tick = async () => {
    if (busy || closed) return;
    busy = true;
    try {
      await health();
      const snap = await snapshot();
      if (snap?.operatorPaused) watchdog.operatorPause(true);
      if (snap?.invalid) watchdog.invalidate('native-guardian-invalid');
      await pullNativeObservations(snap);
      if (!watchdog.status().receipt) return;
      if (config.watchdog.enabled) await watchdog.tick();
      state.watchdog = watchdog.status();
      save();
    } catch {
      watchdog.fault('watchdog-observation-unavailable');
    } finally {
      busy = false;
    }
  };
  if (observationEnabled) interval = setInterval(() => void tick(), config.watchdog.pollMs);
  return {
    watchdog,
    native,
    tick,
    snapshot,
    bridge: (next) => watchdog.bridge(next),
    async isCurrentDocument(documentId) {
      if (!observationEnabled) return true;
      try {
        const snap = await snapshot();
        return snap ? snap.documentId === documentId : null;
      } catch {
        return null;
      }
    },
    invalidate: (reason) => watchdog.invalidate(reason),
    fault: (reason) => watchdog.fault(reason),
    operatorPause: () => watchdog.operatorPause(true),
    async quarantine() {
      const snap = await snapshot();
      return bounded(
        page.evaluate((ticket) => window.__kfHumanFaultGuardian?.quarantine(ticket) ?? false, snap),
      );
    },
    close() {
      closed = true;
      clearInterval(interval);
      watchdog.close();
    },
  };
}
