/** A separate refusal lane. It never acknowledges, retries or commits gameplay decisions. */
import { createHash } from 'node:crypto';
import { canonical } from '../dist/src/shared/canonical.js';
import {
  compileKeytekiCommand,
  keytekiAdministrativeSurface,
  projectKeytekiState,
} from '../dist/src/adapters/keyteki.js';
import { StrategyController, strategyFrameHash } from '../dist/src/ai/strategy-controller.js';

const PREFIX = 'administrative:';
const hash = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const messageHash = (entry) => hash({ activePlayer: entry.activePlayer, message: entry.message });
const requestKey = (projection) =>
  canonical([projection.gameId, projection.playerName, projection.administrativeRequest]);
function freshMessages(previous, current, seen) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return null;
  const ids = (messages) => messages.map((entry) => entry?.id);
  const oldIds = ids(previous),
    nextIds = ids(current);
  if (
    [...oldIds, ...nextIds].some((id) => typeof id !== 'string' || !id) ||
    new Set(oldIds).size !== oldIds.length ||
    new Set(nextIds).size !== nextIds.length
  )
    return null;
  let fresh = current;
  if (oldIds.length) {
    const boundary = nextIds.indexOf(oldIds.at(-1));
    if (boundary < 0 || boundary >= oldIds.length) return null;
    const retained = previous.slice(oldIds.length - boundary - 1);
    if (
      retained.some(
        (entry, index) =>
          entry.id !== current[index].id || messageHash(entry) !== messageHash(current[index]),
      )
    )
      return null;
    fresh = current.slice(boundary + 1);
  }
  return fresh.some((entry) => seen.has(entry.id)) ? null : fresh;
}
function refusalEvent(entry, kind, name) {
  const alert = entry?.message?.alert,
    fragments = alert?.message;
  return (
    alert?.type === 'info' &&
    Array.isArray(fragments) &&
    fragments.length === 2 &&
    fragments[0]?.argType === 'nonAvatarPlayer' &&
    fragments[0].name === name &&
    fragments[1] ===
      (kind === 'manual-mode-consent' ? ' disallows enabling manual mode' : ' disallows forging a key')
  );
}

/** Evidence of an observed refusal, not a transport send receipt. Both runners
 * use the same pinned typed alert; ordinary chat and prompt changes are not proof.
 */
export function observeKeytekiAdministrativeRefusal(before, after, playerName, request) {
  const pending = (reason, requestClosed = false) => ({ status: 'pending', reason, requestClosed });
  const unsupported = (reason) => ({ status: 'unsupported', reason, requestClosed: false });
  if (
    !before?.id ||
    before.id !== after?.id ||
    !same(Object.keys(before.players ?? {}).sort(), Object.keys(after.players ?? {}).sort())
  )
    return unsupported('administrative-result-identity-mismatch');
  if (after.started !== true) return unsupported('administrative-result-game-not-started');
  let parsed;
  try {
    parsed = projectKeytekiState(before, { playerName, revision: 0, turn: 1 }).administrativeRequest;
  } catch {
    return unsupported('administrative-result-request-binding-invalid');
  }
  if (!parsed || !same(parsed, request)) return unsupported('administrative-result-request-binding-invalid');
  const fresh = freshMessages(
    before.messages,
    after.messages,
    new Set((before.messages ?? []).map((entry) => entry.id)),
  );
  if (fresh === null) return unsupported('administrative-result-message-window-unverifiable');
  const matches = fresh.filter((entry) => refusalEvent(entry, request.kind, playerName));
  if (matches.length > 1) return unsupported('administrative-result-ambiguous');
  if (keytekiAdministrativeSurface(after, playerName)) return pending('administrative-request-still-open');
  if (matches.length !== 1) return pending('administrative-refusal-event-unobserved', true);
  const names = Object.keys(before.players).sort((a, b) => a.localeCompare(b, 'en')),
    requester = names[request.requester];
  const unchanged =
    request.kind === 'manual-mode-consent'
      ? typeof before.manualMode === 'boolean' && after.manualMode === before.manualMode
      : typeof before.players[requester]?.stats?.keys?.[request.keyColor] === 'boolean' &&
        after.players[requester]?.stats?.keys?.[request.keyColor] ===
          before.players[requester].stats.keys[request.keyColor];
  if (!unchanged) return unsupported('administrative-refusal-state-contradiction');
  return {
    status: 'verified',
    requestClosed: true,
    resultMessage: { id: matches[0].id, sha256: messageHash(matches[0]) },
  };
}

export class KeytekiAdministrativeSession {
  constructor({ strategy, playerName, onUnknown }) {
    this.controller = new StrategyController(strategy);
    this.playerName = playerName;
    this.onUnknown = onUnknown;
    this.current = undefined;
    this.ready = undefined;
    this.sent = undefined;
    this.preparing = undefined;
    this.generation = 0;
    this.blocked = false;
    this.error = null;
    this.status = 'idle';
    this.observed = new Set();
    this.completed = new Set();
    this.ledger = [];
    this.stats = {
      requestsObserved: 0,
      decisions: 0,
      commands: 0,
      queuedCommands: 0,
      refusalsConfirmed: 0,
      rejectedBeforeSend: 0,
      stale: 0,
      unknown: 0,
    };
  }
  owns(decisionId) {
    return typeof decisionId === 'string' && decisionId.startsWith(PREFIX);
  }
  get busy() {
    return !!(
      this.blocked ||
      this.current?.projection.administrativeRequest ||
      this.preparing ||
      this.ready ||
      this.sent
    );
  }
  invalidatePrepared() {
    this.generation++;
    this.preparing = undefined;
    if (this.ready) this.controller.discard(this.ready.id);
    this.ready = undefined;
  }
  observe(raw, projection, sequence, activity) {
    const frame = {
      matchId: projection.gameId,
      observation: projection.observation,
      qualifications: projection.unknown,
      ...(projection.administrativeRequest
        ? { administrativeRequest: projection.administrativeRequest }
        : {}),
    };
    this.current = { raw, projection, frame, sequence, activity };
    if (this.blocked) return;
    if (this.sent) {
      this.observeSent();
      return;
    }
    if (!projection.administrativeRequest) {
      this.invalidatePrepared();
      this.status = 'idle';
      return;
    }
    const key = requestKey(projection);
    if (this.completed.has(key)) {
      this.fail('administrative-request-reappeared-after-refusal');
      return;
    }
    if (!this.observed.has(key)) {
      this.observed.add(key);
      this.stats.requestsObserved++;
      this.ledger.push({
        event: 'request-observed',
        gameId: projection.gameId,
        request: structuredClone(projection.administrativeRequest),
        sequence,
      });
    }
    this.prepare();
  }
  prepare() {
    if (this.blocked || this.sent || !this.current?.projection.administrativeRequest) return;
    const { frame } = this.current,
      fingerprint = strategyFrameHash(frame);
    if (this.ready?.observationSha256 === fingerprint || this.preparing === fingerprint) return;
    this.invalidatePrepared();
    const generation = this.generation;
    this.preparing = fingerprint;
    this.status = 'thinking';
    this.error = null;
    let task;
    try {
      task = this.controller.prepare(frame);
    } catch (error) {
      this.fail('administrative-request-invalid: ' + error.message);
      return;
    }
    task
      .then((decision) => {
        if (this.blocked || generation !== this.generation || this.sent) {
          this.controller.discard(decision.id);
          this.stats.stale++;
          return;
        }
        this.preparing = undefined;
        this.ready = decision;
        this.stats.decisions++;
        this.status = 'ready';
      })
      .catch((error) => {
        if (this.blocked || generation !== this.generation) this.stats.stale++;
        else this.fail('administrative-decision-failed: ' + error.message);
      });
  }
  take() {
    if (this.blocked || this.sent || !this.ready || !this.current?.projection.administrativeRequest)
      return null;
    const { raw, projection, frame, sequence, activity } = this.current,
      decision = this.ready,
      command = compileKeytekiCommand(projection, decision.actionId, {
        revision: projection.observation.revision,
        fingerprint: projection.fingerprint,
      });
    this.controller.dispatch(decision, frame);
    this.ready = undefined;
    const request = structuredClone(projection.administrativeRequest),
      names = Object.keys(raw.players).sort((a, b) => a.localeCompare(b, 'en')),
      externalId = PREFIX + decision.id;
    this.sent = {
      decision,
      externalId,
      command,
      key: requestKey(projection),
      request,
      requesterName: names[request.requester],
      gameId: projection.gameId,
      sequence,
      activity,
      confirmed: false,
      queuedCount: 0,
      before: structuredClone(raw),
      closed: false,
    };
    this.stats.commands++;
    this.status = 'awaiting-client-send-confirmation';
    this.ledger.push({ event: 'dispatch', decisionId: externalId, request, sequence, activity });
    return {
      decisionId: externalId,
      gameId: projection.gameId,
      sequence,
      revision: projection.observation.revision,
      activity,
      command,
    };
  }
  observeSent() {
    const sent = this.sent,
      { raw, projection, sequence } = this.current;
    if (!sent || this.blocked || sequence <= sent.sequence) return;
    if (sent.uncertainReason) {
      if (sent.confirmed) this.fail(sent.uncertainReason);
      return;
    }
    if (projection.gameId !== sent.gameId) {
      this.fail('administrative-game-identity-changed');
      return;
    }
    const overlay = keytekiAdministrativeSurface(raw, this.playerName);
    if (
      (projection.administrativeRequest && requestKey(projection) !== sent.key) ||
      (overlay && (!projection.administrativeRequest || sent.closed))
    ) {
      this.uncertain('administrative-request-changed-before-confirmed-result');
      return;
    }
    const evidence = observeKeytekiAdministrativeRefusal(sent.before, raw, this.playerName, sent.request);
    if (evidence.status === 'unsupported') {
      this.uncertain(evidence.reason);
      return;
    }
    sent.closed ||= evidence.requestClosed;
    if (evidence.status === 'verified') sent.proof = { ...evidence.resultMessage, sequence };
    this.finishObserved();
  }
  uncertain(reason) {
    if (this.sent?.confirmed) this.fail(reason);
    else if (this.sent) {
      this.sent.uncertainReason ??= reason;
      this.status = 'awaiting-client-send-confirmation';
    }
  }
  finishObserved() {
    const sent = this.sent;
    if (sent?.confirmed && sent.uncertainReason) {
      this.fail(sent.uncertainReason);
      return false;
    }
    if (
      this.blocked ||
      !sent?.confirmed ||
      sent.queuedCount !== 1 ||
      !sent.closed ||
      !sent.proof ||
      this.current.sequence <= sent.sequence
    )
      return false;
    this.controller.acknowledge(sent.decision.id, true);
    this.completed.add(sent.key);
    this.stats.refusalsConfirmed++;
    this.ledger.push({
      event: 'refusal-confirmed',
      decisionId: sent.externalId,
      request: sent.request,
      sentSequence: sent.sequence,
      observedSequence: this.current.sequence,
      resultMessage: sent.proof,
    });
    this.sent = undefined;
    this.status = 'idle';
    return true;
  }
  confirmSent(decisionId, sequence, receipt) {
    const sent = this.sent;
    if (!sent || sent.externalId !== decisionId || sent.sequence !== sequence)
      throw Error('Unknown administrative send receipt');
    if (this.blocked) throw Error('Administrative outcome is unknown');
    if (sent.confirmed) throw Error('Duplicate administrative send receipt');
    if (
      receipt.planId !== undefined ||
      !Number.isSafeInteger(receipt.queuedCount) ||
      receipt.queuedCount < 0 ||
      receipt.queuedCount > 1
    )
      throw Error('Invalid administrative queued count');
    sent.queuedCount = receipt.queuedCount;
    this.stats.queuedCommands += receipt.queuedCount;
    if (receipt.queuedCount !== 1) {
      this.fail('partial-administrative-send');
      return;
    }
    sent.confirmed = true;
    this.status = 'awaiting-administrative-result';
    this.ledger.push({ event: 'queued', decisionId, sequence, queuedCount: 1 });
    this.finishObserved();
  }
  reject(decisionId, reason) {
    const sent = this.sent;
    if (!sent || sent.externalId !== decisionId) throw Error('Unknown administrative decision');
    if (this.blocked || sent.confirmed || sent.queuedCount)
      throw Error('Administrative outcome is unknown; a sent refusal cannot be retried');
    this.controller.acknowledge(sent.decision.id, false);
    this.stats.rejectedBeforeSend++;
    this.ledger.push({ event: 'not-sent', decisionId, reason, sequence: this.current.sequence });
    this.sent = undefined;
    this.status = 'idle';
    this.prepare();
  }
  unknown(decisionId, reason, queuedCount = 0) {
    if (!this.sent || this.sent.externalId !== decisionId) throw Error('Unknown administrative decision');
    if (!Number.isSafeInteger(queuedCount) || queuedCount < 0 || queuedCount > 1)
      throw Error('Invalid uncertain administrative queued count');
    if (queuedCount > this.sent.queuedCount) this.stats.queuedCommands += queuedCount - this.sent.queuedCount;
    this.sent.queuedCount = Math.max(this.sent.queuedCount, queuedCount);
    this.fail(reason);
  }
  fail(reason) {
    if (this.blocked) return;
    this.stop(reason);
    this.onUnknown(reason);
  }
  stop(reason) {
    if (this.blocked) return;
    this.blocked = true;
    this.invalidatePrepared();
    this.status = 'send-outcome-unknown';
    this.error = reason;
    if (this.sent) {
      this.stats.unknown++;
      this.ledger.push({
        event: 'outcome-unknown',
        decisionId: this.sent.externalId,
        request: this.sent.request,
        reason,
        queuedCount: this.sent.queuedCount,
      });
    }
  }
  describe() {
    return {
      status: this.status,
      error: this.error,
      stats: { ...this.stats },
      pending: this.sent
        ? {
            decisionId: this.sent.externalId,
            request: structuredClone(this.sent.request),
            sequence: this.sent.sequence,
            queuedCount: this.sent.queuedCount,
            clientConfirmed: this.sent.confirmed,
            requestClosed: this.sent.closed,
          }
        : null,
      ledger: structuredClone(this.ledger),
    };
  }
}
