/** Single-seat liveness policy. Independent of the strategy host and of any chat model. */
import { createHash } from 'node:crypto';
import jsondiffpatch from 'jsondiffpatch';
import { watchdogApology } from './keyteki-language.mjs';

// Legacy named export remains the original Chinese text for existing callers.
export const WATCHDOG_APOLOGY = watchdogApology('zh-CN');
export const DEFAULT_WATCHDOG_CONFIG = Object.freeze({
  enabled: true,
  stallMs: 45000,
  modelGraceMs: 180000,
  recoveryGraceMs: 20000,
  pollMs: 1000,
  apologyEchoMs: 3000,
  terminalAckMs: 10000,
  maxRecoveries: 1,
});
export function normalizeWatchdogConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid watchdog config');
  const result = { ...DEFAULT_WATCHDOG_CONFIG };
  for (const key of Object.keys(value)) {
    if (!(key in result)) throw Error('Unknown watchdog option: ' + key);
    if (key === 'enabled') {
      if (typeof value[key] !== 'boolean') throw Error('Invalid watchdog enabled flag');
    } else if (
      !Number.isSafeInteger(value[key]) ||
      value[key] < (key === 'maxRecoveries' ? 0 : 10) ||
      value[key] > (key === 'maxRecoveries' ? 1 : 600000)
    )
      throw Error('Invalid watchdog option: ' + key);
    result[key] = value[key];
  }
  return Object.freeze(result);
}
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const winnerName = (raw) => (typeof raw?.winner === 'string' ? raw.winner : (raw?.winner?.name ?? null));
const buttonUsable = (b) => object(b) && b.disabled !== true;
const label = (x) => (typeof x === 'string' ? x : object(x) ? label(x.text) : '');
const dismissOnly = (b) => /^(back|cancel|返回|取消)$/i.test(label(b.arg) || label(b.text));

export function watchdogResponsibility(raw, playerName) {
  if (!raw || raw.started !== true) return { ours: false, reason: 'not-started' };
  if (winnerName(raw)) return { ours: false, reason: 'terminal', winner: winnerName(raw) };
  if (raw.manualMode !== false) return { ours: false, reason: 'manual-mode' };
  const me = raw.players?.[playerName];
  if (!me || me.left === true || me.disconnected === true) return { ours: false, reason: 'seat-unavailable' };
  const waiting = /\bwaiting\b|等待/i.test([me.menuTitle, me.promptTitle].map(label).join(' '));
  const buttons = (Array.isArray(me.buttons) ? me.buttons : []).filter(buttonUsable);
  const controls = (Array.isArray(me.controls) ? me.controls : []).filter(
    (c) =>
      object(c) &&
      ['options-select', 'house-select', 'card-name', 'trait-name'].includes(c.type) &&
      c.disabled !== true,
  );
  const selectable = me.selectCard === true || me.selectOrder === true;
  if (waiting && !selectable && !controls.length && buttons.every(dismissOnly))
    return { ours: false, reason: 'waiting-for-opponent' };
  if (selectable || controls.length || buttons.length) return { ours: true, reason: 'own-prompt' };
  return { ours: me.activePlayer === true, reason: me.activePlayer === true ? 'own-turn' : 'opponent-turn' };
}

/** No chat/log rows, clocks, network flags, user settings, or polling counters can renew liveness. */
export function watchdogProgressHashes(raw) {
  const clean = (x) => {
    if (Array.isArray(x)) return x.map(clean);
    if (!object(x)) return x;
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .filter(
          (k) =>
            ![
              'clock',
              'timerSettings',
              'user',
              'optionSettings',
              'disconnected',
              'inactive',
              'messages',
              'lastEventAt',
              'selected',
              'selectable',
              'unselectable',
              'pseudoDamage',
              'wardBroken',
              'canPlay',
              'canUse',
              'selectionOrder',
            ].includes(k),
        )
        .map((k) => [k, clean(x[k])]),
    );
  };
  const seats = Object.fromEntries(
    Object.entries(raw?.players ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, p]) => [
        name,
        clean({
          activePlayer: p.activePlayer,
          activeHouse: p.activeHouse,
          phase: p.phase,
          stats: p.stats,
          numDeckCards: p.numDeckCards,
          numArchivesCards: p.numArchivesCards,
          cardPiles: p.cardPiles,
          prophecyCards: p.prophecyCards,
          tokenCard: p.tokenCard,
        }),
      ]),
  );
  const digest = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
  const normalizePrompt = (x) => {
    if (typeof x === 'string')
      return x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
    if (Array.isArray(x)) return x.map(normalizePrompt);
    if (!object(x)) return x;
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .filter((k) => !['uuid', 'promptUuid', 'id'].includes(k))
        .map((k) => [k, normalizePrompt(x[k])]),
    );
  };
  const prompts = Object.fromEntries(
    Object.entries(raw?.players ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, p]) => [
        name,
        normalizePrompt({
          buttons: p.buttons,
          controls: p.controls,
          promptTitle: p.promptTitle,
          menuTitle: p.menuTitle,
          selectCard: p.selectCard,
          selectOrder: p.selectOrder,
        }),
      ]),
  );
  const board = digest({
    id: raw?.id,
    started: raw?.started,
    manualMode: raw?.manualMode,
    turn: raw?.turn,
    winner: winnerName(raw),
    players: seats,
  });
  return { board, prompt: digest(prompts), combined: digest({ board, prompts }) };
}
export const watchdogProgressHash = (raw) => watchdogProgressHashes(raw).combined;

/** Reconstruct native frames independently, including while the strategy bridge is down/paused. */
export function createWatchdogNativeObserver({ identity, validateFull, onState }) {
  const patcher = jsondiffpatch.create({
    objectHash: (x, i) => x.uuid || x.name || x.id || x._id || '$$index:' + i,
  });
  let raw = null,
    documentId = null,
    sequence = 0,
    receipt = null,
    lastFrameSha256 = null;
  const retired = new Set();
  return {
    receive(frame) {
      if (
        !object(frame) ||
        frame.gameId !== identity.gameId ||
        frame.playerName !== identity.playerName ||
        typeof frame.documentId !== 'string' ||
        typeof frame.frameToken !== 'string' ||
        !Number.isSafeInteger(frame.nativeSequence) ||
        frame.nativeSequence < 1
      )
        throw Error('watchdog-native-scope');
      if (retired.has(frame.documentId)) return { ignored: true };
      const frameSha256 = createHash('sha256').update(JSON.stringify(frame)).digest('hex'),
        full = object(frame.delta) && frame.delta.id === identity.gameId && object(frame.delta.players);
      if (frame.documentId !== documentId) {
        if (!full || frame.nativeSequence !== 1 || frame.newEngineHandshake !== true)
          throw Error('watchdog-native-full-required');
        validateFull(raw, frame.delta);
        if (documentId) retired.add(documentId);
        documentId = frame.documentId;
        sequence = 0;
        raw = structuredClone(frame.delta);
      } else {
        if (frame.nativeSequence < sequence) return { ignored: true };
        if (frame.nativeSequence === sequence) {
          if (frameSha256 !== lastFrameSha256) throw Error('watchdog-native-frame-conflict');
          // A lost callback response may repeat the same original frame. ACK it without observing twice.
          return { accepted: true, duplicate: true, receipt: { ...receipt } };
        }
        if (frame.nativeSequence !== sequence + 1 && !full) throw Error('watchdog-native-gap');
        if (full) {
          validateFull(raw, frame.delta);
          raw = structuredClone(frame.delta);
        } else raw = patcher.patch(structuredClone(raw), structuredClone(frame.delta));
      }
      sequence = frame.nativeSequence;
      if (raw?.id !== identity.gameId || !same(Object.keys(raw.players ?? {}), identity.participants))
        throw Error('watchdog-native-pair');
      receipt = {
        documentId,
        nativeSequence: sequence,
        frameToken: frame.frameToken,
        transportPath: frame.transportPath,
        ownerEpoch: frame.ownerEpoch ?? null,
      };
      lastFrameSha256 = frameSha256;
      onState(raw, receipt);
      return { accepted: true, receipt: { ...receipt } };
    },
    snapshot: () => raw,
  };
}

export function createHumanWatchdog({
  identity,
  config: input,
  language,
  origin,
  clock = Date.now,
  recover,
  inspect,
  act,
  operationTimeoutMs = 10000,
  onEvent = () => {},
}) {
  const config = normalizeWatchdogConfig(input);
  const apology = watchdogApology(language, origin);
  let raw = null,
    receipt = null,
    progress = null,
    lastProgressAt = clock(),
    ownSince = null,
    operatorPaused = false,
    invalidated = false,
    modelSince = null,
    modelInFlight = false,
    bridge = null,
    episode = null,
    running = false,
    closed = false,
    boardHash = null;
  const seenPrompts = new Set();
  const events = [];
  const emit = (type, extra = {}) => {
    const e = { type, at: clock(), gameId: identity.gameId, ...extra };
    events.push(e);
    if (events.length > 64) events.shift();
    onEvent(e);
  };
  const responsibility = () => watchdogResponsibility(raw, identity.playerName);
  const reset = (why) => {
    if (episode?.concedeAttempted) return;
    if (episode) emit('escalation-cancelled', { reason: why });
    episode = null;
    modelSince = null;
    modelInFlight = false;
  };
  const scope = () => ({
    gameId: identity.gameId,
    playerName: identity.playerName,
    ...receipt,
    ownerEpoch: receipt?.ownerEpoch ?? bridge?.ownerEpoch ?? null,
    documentId: receipt?.documentId,
  });
  const eligible = () =>
    config.enabled && !closed && !invalidated && !operatorPaused && receipt && responsibility().ours;
  const current = (id, hash) => eligible() && episode?.id === id && progress === hash;
  const view = () => ({
    enabled: config.enabled,
    phase: closed
      ? 'closed'
      : invalidated
        ? 'disarmed'
        : operatorPaused
          ? 'operator-paused'
          : responsibility().winner
            ? 'terminal'
            : (episode?.phase ?? (responsibility().ours ? 'watching-own-action' : 'waiting-for-opponent')),
    lastProgressAt,
    ownSince,
    modelSince,
    progressHash: progress,
    receipt,
    bridgeStatus: bridge?.status ?? null,
    episode: episode ? { ...episode } : null,
    events: [...events],
  });
  const bounded = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error('watchdog-operation-timeout')), operationTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const inspectCurrent = async (id, hash, purpose = 'act') => {
    if (!current(id, hash)) return null;
    let proof;
    try {
      proof = await bounded(inspect(scope(), { purpose }));
    } catch {
      emit('binding-check-unavailable');
      return null;
    }
    if (proof?.operatorPaused) {
      operatorPaused = true;
      reset('operator-pause');
      return null;
    }
    if (!current(id, hash) || proof?.valid !== true) return null;
    return { ...scope(), ...proof.binding };
  };
  async function tick() {
    if (running || closed) return view();
    running = true;
    try {
      if (!eligible()) {
        if (!responsibility().winner) reset('not-own-action');
        return view();
      }
      const t = clock(),
        base = Math.max(lastProgressAt, ownSince ?? t),
        deadline = Math.max(
          base + config.stallMs,
          !modelInFlight || modelSince === null ? 0 : modelSince + config.modelGraceMs,
        );
      if (!episode && t < deadline) return view();
      if (!episode) {
        episode = {
          id: createHash('sha256')
            .update(identity.gameId + ':' + progress + ':' + t)
            .digest('hex')
            .slice(0, 24),
          progressHash: progress,
          phase: 'stalled',
          recoveries: 0,
          startedAt: t,
          apologyAttempted: false,
          concedeAttempted: false,
        };
        emit('stall-confirmed', { reason: responsibility().reason });
      }
      const id = episode.id,
        hash = episode.progressHash;
      if (episode.phase === 'recovering' || episode.phase === 'observing-recovery') {
        if (t < (episode.recoveryDeadline ?? Infinity)) return view();
        episode.phase = 'fallback';
      }
      if (episode.phase === 'stalled' && episode.recoveries < config.maxRecoveries) {
        const proof = await inspectCurrent(id, hash, 'recover');
        if (!proof) return view();
        episode.recoveries++;
        episode.phase = 'recovering';
        emit('recovery-started', { attempt: episode.recoveries });
        let result;
        const controller = new AbortController();
        let timer;
        try {
          result = await Promise.race([
            recover({
              binding: proof,
              signal: controller.signal,
              isCurrent: () => current(id, hash),
              unknownSend: bridge?.sendPending != null || bridge?.status === 'send-outcome-unknown',
            }),
            new Promise((resolve) => {
              timer = setTimeout(() => {
                controller.abort();
                resolve({ ok: false, reason: 'recovery-timeout' });
              }, 30000);
            }),
          ]);
        } catch {
          result = { ok: false, reason: 'recovery-error' };
        } finally {
          clearTimeout(timer);
        }
        if (!current(id, hash)) return view();
        episode.phase = 'observing-recovery';
        episode.recoveryDeadline = clock() + config.recoveryGraceMs;
        emit('recovery-attempt-finished', { ok: result?.ok === true, reason: result?.reason ?? null });
        return view();
      }
      if (episode.phase === 'stalled') episode.phase = 'fallback';
      if (episode.phase === 'fallback') {
        const proof = await inspectCurrent(id, hash);
        if (!proof) return view();
        if (!episode.apologyAttempted) {
          episode.apologyRequests = (episode.apologyRequests ?? 0) + 1;
          episode.apologyAt ??= clock();
          let result;
          try {
            result = await bounded(act('apology', { ...proof, episodeId: id }));
          } catch {
            result = { queued: false, outcome: 'unknown' };
          }
          if (!current(id, hash)) return view();
          if (
            result?.attempted === false &&
            episode.apologyRequests < 3 &&
            clock() - episode.apologyAt < config.apologyEchoMs
          ) {
            emit('apology-precondition-retry', { attempt: episode.apologyRequests });
            return view();
          }
          episode.apologyAttempted = true;
          episode.apologyQueued = result?.queued === true;
          episode.apologyOutcome =
            result?.outcome ?? (result?.attempted === false ? 'not-attempted' : 'unknown');
          emit('apology-attempted', { queued: episode.apologyQueued, outcome: episode.apologyOutcome });
          episode.phase = 'awaiting-apology';
          return view();
        }
      }
      if (episode.phase === 'awaiting-apology') {
        if (!episode.apologyEcho && t - (episode.apologyAt ?? t) < config.apologyEchoMs) return view();
        const proof = await inspectCurrent(id, hash);
        if (!proof) return view();
        if (!episode.concedeAttempted) {
          episode.concedeRequests = (episode.concedeRequests ?? 0) + 1;
          episode.concedeAt ??= clock();
          // Mark before a possibly queued write; only an explicit pre-send refusal permits another attempt.
          episode.concedeAttempted = true;
          episode.phase = 'awaiting-terminal';
          let result;
          try {
            result = await bounded(act('concede', { ...proof, episodeId: id, apologyCompleted: true }));
          } catch {
            result = { queued: false, outcome: 'unknown' };
          }
          if (episode?.id !== id) return view();
          if (result?.attempted === false) {
            episode.concedeAttempted = false;
            if (!current(id, hash)) {
              emit('concede-not-sent', { reason: 'position-or-responsibility-changed' });
              reset('progress-before-concede-write');
              return view();
            }
          }
          if (
            result?.attempted === false &&
            episode.concedeRequests < 3 &&
            clock() - episode.concedeAt < config.terminalAckMs
          ) {
            episode.concedeAttempted = false;
            episode.phase = 'awaiting-apology';
            emit('concede-precondition-retry', { attempt: episode.concedeRequests });
            return view();
          }
          episode.concedeAttempted = true;
          episode.concedeQueued = result?.queued === true;
          episode.concedeOutcome =
            result?.outcome ?? (result?.attempted === false ? 'not-attempted' : 'unknown');
          emit('concede-attempted', { queued: episode.concedeQueued, outcome: episode.concedeOutcome });
        }
      }
      if (
        episode?.phase === 'awaiting-terminal' &&
        clock() - (episode.concedeAt ?? clock()) >= config.terminalAckMs
      ) {
        episode.phase = 'terminal-unconfirmed';
        emit('terminal-unconfirmed', { concedeQueued: episode.concedeQueued });
      }
      return view();
    } finally {
      running = false;
    }
  }
  return {
    config,
    observe(next, nextReceipt) {
      if (next?.id !== identity.gameId || !same(Object.keys(next.players ?? {}), identity.participants))
        throw Error('watchdog-game-scope');
      raw = next;
      receipt = { ...nextReceipt };
      const t = clock(),
        hash = watchdogProgressHash(raw),
        responsible = responsibility();
      if (responsible.winner) {
        if (episode?.concedeAttempted && episode.phase !== 'terminal-confirmed') {
          episode.phase = 'terminal-confirmed';
          episode.winner = responsible.winner;
          emit('terminal-confirmed', { winner: responsible.winner });
        } else reset('game-finished');
        return view();
      }
      const hashes = watchdogProgressHashes(raw);
      if (boardHash !== hashes.board) {
        boardHash = hashes.board;
        seenPrompts.clear();
      }
      if (!seenPrompts.has(hashes.prompt) && seenPrompts.size < 128) {
        seenPrompts.add(hashes.prompt);
        progress = hash;
        lastProgressAt = t;
        reset('meaningful-progress');
      }
      if (responsible.ours) {
        ownSince ??= t;
      } else {
        ownSince = null;
        reset('opponent-or-unavailable');
      }
      if (episode?.apologyAttempted) {
        episode.apologyEcho = (raw.messages ?? []).some((row) => {
          const m = row.message;
          return (
            Array.isArray(m) &&
            ((m.length === 3 &&
              m[0]?.name === identity.playerName &&
              m[0]?.argType === 'player' &&
              m[1] === ' ' &&
              m[2] === apology) ||
              (m.length === 5 &&
                m[0] === '' &&
                m[1]?.name === identity.playerName &&
                m[1]?.argType === 'player' &&
                m[2] === ' ' &&
                m[3] === apology &&
                m[4] === ''))
          );
        });
      }
      return view();
    },
    bridge(next) {
      bridge = { ...next };
      if (next.operatorPaused === true) {
        operatorPaused = true;
        reset('operator-pause');
      }
      modelInFlight = next.modelInFlight === true;
      if (modelInFlight && eligible()) modelSince ??= clock();
    },
    operatorPause(value = true) {
      operatorPaused = value;
      if (value) reset('operator-pause');
      else {
        lastProgressAt = clock();
        ownSince = responsibility().ours ? clock() : null;
      }
    },
    invalidate(reason) {
      invalidated = true;
      reset('ownership-invalid');
      emit('disarmed', { reason });
    },
    fault(reason) {
      emit('fault-observed', { reason });
    },
    tick,
    status: view,
    close() {
      closed = true;
      reset('closed');
    },
  };
}
