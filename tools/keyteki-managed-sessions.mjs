/** Local Node owns a game-seat; browser documents borrow a fenced sending lease. */
import { createHash, randomBytes } from 'node:crypto';
import { validateKeytekiManagedFullState } from './keyteki-wire-session.mjs';
import { keytekiTransportBinding } from './keyteki-transport-recovery.mjs';
import { normalizeGameSocketPaths } from './site-origin.mjs';

const clone = (value) => structuredClone(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const browserSequence = (data) => data.browserSequence ?? data.sequence;
const documentId = (data) => data.documentId ?? data.sessionId;
const identityKey = ({ origin, gameId, playerName }) => JSON.stringify([origin, gameId, playerName]);
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message = code) => {
  const error = Error(message);
  error.code = code;
  error.managed = true;
  throw error;
};
const deckIdentity = (full) =>
  Object.fromEntries(
    Object.entries(full.players)
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(([name, player]) => [
        name,
        {
          houses: player.houses ?? null,
          deck: Object.fromEntries(
            ['uuid', 'id', 'name', 'expansion'].map((key) => [key, player.deckData?.[key] ?? null]),
          ),
        },
      ]),
  );

export class KeytekiManagedSessions {
  constructor({ createSession, checkpoint, now = Date.now, gameSocketPaths = [] } = {}) {
    if (typeof createSession !== 'function') throw Error('Managed session factory required');
    this.createSession = createSession;
    this.gameSocketPaths = normalizeGameSocketPaths(gameSocketPaths);
    this.now = now;
    this.records = new Map();
    this.restored = new Map();
    if (checkpoint !== undefined) {
      if (checkpoint?.version !== 1 || !Array.isArray(checkpoint.sessions))
        throw Error('Invalid managed session checkpoint');
      for (const row of checkpoint.sessions) {
        if (
          !object(row) ||
          typeof row.origin !== 'string' ||
          typeof row.gameId !== 'string' ||
          !row.gameId ||
          typeof row.playerName !== 'string' ||
          !integer(row.lastOwnerEpoch) ||
          !Array.isArray(row.pendingDeliveries) ||
          !object(row.deckIdentity)
        )
          throw Error('Invalid managed session checkpoint record');
        const key = identityKey(row);
        if (this.restored.has(key)) throw Error('Duplicate managed session checkpoint identity');
        this.restored.set(key, clone(row));
      }
    }
  }
  identity(data) {
    let origin;
    try {
      origin = new URL(data.origin).origin;
    } catch {
      fail('managed-origin-invalid');
    }
    if (origin !== data.origin || typeof data.playerName !== 'string' || !data.playerName)
      fail('managed-identity-invalid');
    const gameId = data.gameId ?? data.fullState?.id;
    if (typeof gameId !== 'string' || !gameId) fail('managed-game-id-required');
    return { origin, gameId, playerName: data.playerName };
  }
  record(data, { owner = true } = {}) {
    let identity;
    if (!data.gameId && !data.fullState?.id) {
      const found = [...this.records.values()].filter(
        (record) =>
          record.identity.origin === data.origin &&
          record.identity.playerName === data.playerName &&
          record.owner?.documentId === documentId(data),
      );
      if (found.length !== 1) fail('managed-game-id-required');
      identity = found[0].identity;
    } else identity = this.identity(data);
    const record = this.records.get(identityKey(identity));
    if (!record) fail('managed-session-not-attached');
    if (owner && (record.owner?.documentId !== documentId(data) || record.owner?.epoch !== data.ownerEpoch))
      fail('superseded-owner');
    return record;
  }
  sync(record) {
    for (const [id, delivery] of record.deliveries) {
      const sent = record.wire.administrative.owns(id) ? record.wire.administrative.sent : record.wire.sent;
      const actualId = sent?.externalId ?? sent?.decision.id;
      if (actualId !== id) {
        record.deliveries.delete(id);
        record.lastDelivery = { decisionId: id, stage: delivery.rejected ? 'not-sent' : 'observed' };
        record.closedDeliveries.set(id, { ...delivery, ...record.lastDelivery });
        if (record.closedDeliveries.size > 32)
          record.closedDeliveries.delete(record.closedDeliveries.keys().next().value);
      } else {
        delivery.queuedCount = Math.max(sent.queuedCount, delivery.reportedQueuedCount ?? 0);
        delivery.stage =
          record.wire.blocked || delivery.uncertainReason
            ? 'unknown'
            : sent.confirmed
              ? 'queued'
              : 'authorized';
        delivery.confirmed = sent.confirmed;
      }
    }
    if (record.wire.status === 'finished') record.finished = true;
  }
  held(record) {
    return (
      !!record.restoredUnknown ||
      [...record.deliveries.values()].some((delivery) => delivery.ownerEpoch !== record.owner?.epoch)
    );
  }
  administrativeRefusalAllowed(record) {
    const wire = record.wire,
      admin = wire.administrative,
      request = admin.current?.projection.administrativeRequest;
    return !!(
      record.owner?.attached &&
      !record.released &&
      !record.restoredUnknown &&
      !wire.blocked &&
      !wire.managedDetached &&
      !admin.blocked &&
      !admin.sent &&
      request &&
      admin.ready?.controller === 'forced' &&
      admin.ready.actionId === request.rejectActionId &&
      record.deliveries.size > 0 &&
      [...record.deliveries.values()].every(
        (delivery) =>
          !admin.owns(delivery.decisionId) &&
          delivery.confirmed === true &&
          delivery.queuedCount === delivery.expectedCount,
      )
    );
  }
  view(record) {
    this.sync(record);
    record.receiptOrdinal = (record.receiptOrdinal ?? 0) + 1;
    const state = record.wire.describe(),
      held = this.held(record),
      detached = !record.owner?.attached,
      pending = record.deliveries.values().next().value ?? record.restoredPending?.[0],
      status = record.restoredUnknown
        ? 'send-outcome-unknown'
        : record.wire.blocked
          ? state.status
          : held
            ? 'awaiting-send-outcome'
            : detached && !record.finished
              ? 'waiting-for-attachment'
              : state.status;
    return {
      ...state,
      managed: true,
      gameId: record.identity.gameId,
      status,
      ...(record.restoredUnknown
        ? { error: record.restoredStopReason ?? 'restored-authorized-send-outcome-unknown' }
        : {}),
      ownerEpoch: record.owner?.epoch ?? record.lastOwnerEpoch,
      documentId: record.owner?.documentId ?? null,
      tabId: record.owner?.tabId ?? null,
      sequence: record.owner?.sequence ?? 0,
      browserSequence: record.owner?.sequence ?? 0,
      nodeSequence: record.wire.stream.sequence,
      receiptOrdinal: record.receiptOrdinal,
      lifecycle: record.finished
        ? 'finished'
        : record.released
          ? 'released'
          : record.wire.blocked || record.restoredUnknown
            ? 'stopped'
            : held
              ? 'settling'
              : detached
                ? 'detached'
                : 'attached',
      resumeReady: !detached && !held && !record.released && !record.wire.blocked && !record.restoredUnknown,
      administrativeOnly: held && this.administrativeRefusalAllowed(record),
      sendPending: pending
        ? {
            decisionId: pending.decisionId,
            sendTicket: pending.sendTicket,
            ownerEpoch: pending.ownerEpoch,
            sequence: pending.browserSequence ?? pending.sequence,
            queuedCount: pending.queuedCount,
            confirmed: pending.confirmed ?? pending.stage === 'queued',
          }
        : null,
      pendingDeliveries: record.restoredUnknown
        ? clone(record.restoredPending)
        : [...record.deliveries.values()].map((delivery) => this.deliverySummary(delivery)),
      lastDelivery: record.lastDelivery ?? null,
      resumeReceipt: clone(record.wire.managedFullReceipt),
    };
  }
  deliverySummary(delivery) {
    return {
      decisionId: delivery.decisionId,
      sendTicket: delivery.sendTicket,
      ownerEpoch: delivery.ownerEpoch,
      documentId: delivery.documentId,
      sequence: delivery.browserSequence,
      nodeSequence: delivery.nodeSequence,
      stage: delivery.stage,
      queuedCount: delivery.queuedCount,
      confirmed: delivery.confirmed ?? false,
      expectedCount: delivery.expectedCount,
      planId: delivery.planId ?? null,
      commandSha256: delivery.commandSha256,
    };
  }
  attach(data) {
    const identity = this.identity(data),
      key = identityKey(identity),
      doc = documentId(data),
      sequence = browserSequence(data),
      tab = data.tabId;
    if (
      typeof doc !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(doc) ||
      typeof tab !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(tab) ||
      data.nativeFullState !== true ||
      data.newEngineHandshake !== true ||
      !object(data.fullState) ||
      data.fullState.id !== identity.gameId
    )
      fail('managed-native-attach-required');
    let record = this.records.get(key);
    const restored = this.restored.get(key);
    for (const active of this.records.values())
      if (
        active.identity.origin === identity.origin &&
        active.identity.playerName === identity.playerName &&
        active.identity.gameId !== identity.gameId &&
        !active.finished &&
        !active.released
      )
        fail('player-has-active-game');
    for (const active of this.restored.values())
      if (
        active.origin === identity.origin &&
        active.playerName === identity.playerName &&
        active.gameId !== identity.gameId &&
        !active.finished &&
        !active.released
      )
        fail('player-has-active-game');
    if (record) {
      if (record.retiredDocuments.has(doc)) fail('superseded-owner');
      const current = record.owner;
      if (current?.documentId === doc) {
        if (
          current.attached ||
          data.ownerEpoch !== current.epoch ||
          sequence !== current.sequence + 1 ||
          data.transport?.epoch !== record.wire.transport?.epoch + 1
        )
          fail('managed-same-document-reattach-invalid');
      } else {
        if (sequence !== 1) fail('managed-new-document-sequence-invalid');
        if (current?.attached && (current.tabId !== tab || data.previousOwnerEpoch !== current.epoch))
          fail('owner-already-attached');
      }
    } else {
      if (sequence !== 1) fail('managed-new-document-sequence-invalid');
      const wire = this.createSession(identity);
      record = {
        identity,
        wire,
        owner: null,
        lastOwnerEpoch: restored?.lastOwnerEpoch ?? 0,
        deliveries: new Map(),
        closedDeliveries: new Map(),
        retiredDocuments: new Set(restored?.retiredDocuments ?? []),
        finished: false,
        restoredUnknown: !!restored?.stopped || !!restored?.pendingDeliveries.length,
        restoredStopReason: restored?.stopped ? (restored.stopReason ?? 'restored-stopped-session') : null,
        restoredPending: clone(restored?.pendingDeliveries ?? []),
      };
      if (record.retiredDocuments.has(doc)) fail('superseded-owner');
    }
    // These validation failures leave the existing owner and its preparation intact.
    validateKeytekiManagedFullState(record.wire.latestRaw, data.fullState, record.wire.options);
    keytekiTransportBinding(data.transport, identity.origin, this.gameSocketPaths);
    if (restored && digest(restored.deckIdentity) !== digest(deckIdentity(data.fullState)))
      fail('managed-restored-deck-identity-mismatch');
    if (data.deliveryLedger) this.reconcileLedger(record, data.deliveryLedger);
    const oldOwner = record.owner;
    record.wire.attachManaged(data.fullState, record.wire.stream.sequence + 1, data.transport, {
      hold: record.restoredUnknown,
    });
    if (oldOwner?.documentId && oldOwner.documentId !== doc) record.retiredDocuments.add(oldOwner.documentId);
    record.lastOwnerEpoch++;
    record.released = false;
    record.owner = {
      documentId: doc,
      tabId: tab,
      epoch: record.lastOwnerEpoch,
      sequence,
      attached: true,
      lastSeen: this.now(),
    };
    this.records.set(key, record);
    this.restored.delete(key);
    if (record.restoredUnknown)
      record.wire.unknown(
        undefined,
        record.restoredStopReason ?? 'restored-authorized-send-outcome-unknown',
        0,
        false,
      );
    this.sync(record);
    return this.view(record);
  }
  receive(data) {
    const record = this.record(data),
      sequence = browserSequence(data);
    if (!record.owner.attached) fail('managed-reattach-required');
    if (sequence !== record.owner.sequence + 1) fail('managed-browser-sequence-gap');
    record.wire.receive(data.delta, record.wire.stream.sequence + 1, data.transport);
    record.owner.sequence = sequence;
    record.owner.lastSeen = this.now();
    return this.view(record);
  }
  mappedDecision(record, decision, authorized = false, ticket) {
    if (!decision) return null;
    return {
      ...clone(decision),
      nodeSequence: decision.sequence,
      sequence: record.owner.sequence,
      browserSequence: record.owner.sequence,
      ownerEpoch: record.owner.epoch,
      documentId: record.owner.documentId,
      sendAuthorized: authorized,
      ...(ticket ? { sendTicket: ticket } : {}),
    };
  }
  offer(data) {
    const record = this.record(data),
      state = this.view(record);
    const decision = state.resumeReady || state.administrativeOnly ? record.wire.offer() : null;
    return { ...state, decision: this.mappedDecision(record, decision) };
  }
  authorize(data) {
    const record = this.record(data),
      state = this.view(record);
    if (!state.resumeReady && !state.administrativeOnly) fail('managed-send-lane-held');
    if (
      browserSequence(data) !== record.owner.sequence ||
      (data.activity !== undefined && data.activity !== record.wire.activity)
    )
      fail('managed-stale-send-intent');
    if (record.deliveries.has(data.decisionId)) fail('managed-send-intent-already-issued');
    const offered = record.wire.offer();
    if (!offered || offered.decisionId !== data.decisionId) fail('managed-stale-offer');
    if (state.administrativeOnly && !record.wire.administrative.owns(offered.decisionId))
      fail('managed-send-lane-held');
    const decision = record.wire.take(data.decisionId),
      sendTicket = randomBytes(16).toString('hex'),
      delivery = {
        decisionId: decision.decisionId,
        sendTicket,
        ownerEpoch: record.owner.epoch,
        documentId: record.owner.documentId,
        browserSequence: record.owner.sequence,
        nodeSequence: decision.sequence,
        stage: 'authorized',
        queuedCount: 0,
        expectedCount: decision.plan?.commands.length ?? 1,
        planId: decision.plan?.id,
        commandSha256: digest(decision.plan ?? decision.command),
      };
    record.deliveries.set(decision.decisionId, delivery);
    return { ...this.view(record), decision: this.mappedDecision(record, decision, true, sendTicket) };
  }
  receipt(record, data) {
    const delivery = record.deliveries.get(data.decisionId);
    if (
      !delivery ||
      data.sendTicket !== delivery.sendTicket ||
      browserSequence(data) !== delivery.browserSequence
    )
      fail('managed-delivery-receipt-mismatch');
    return delivery;
  }
  closedReceipt(record, data) {
    const delivery = record.closedDeliveries.get(data.decisionId);
    return delivery &&
      delivery.sendTicket === data.sendTicket &&
      delivery.browserSequence === browserSequence(data)
      ? delivery
      : null;
  }
  confirmSent(data) {
    const record = this.record(data);
    if (data.receiptOnly === true) {
      // A recovery probe may read a proven effect, never confirm or resend an uncertain command.
      this.sync(record);
      const observed = this.closedReceipt(record, data);
      if (
        observed?.stage !== 'observed' ||
        observed.documentId !== record.owner.documentId ||
        observed.ownerEpoch !== record.owner.epoch ||
        data.sequence !== observed.browserSequence ||
        data.queuedCount !== observed.expectedCount ||
        data.planId !== observed.planId
      )
        fail('managed-observed-receipt-unavailable');
      return {
        ...this.view(record),
        observedDelivery: {
          stage: 'observed',
          decisionId: observed.decisionId,
          sendTicket: observed.sendTicket,
          sequence: observed.browserSequence,
          documentId: observed.documentId,
          ownerEpoch: observed.ownerEpoch,
          queuedCount: observed.expectedCount,
          ...(observed.planId ? { planId: observed.planId } : {}),
        },
      };
    }
    const closed = this.closedReceipt(record, data);
    if (closed?.stage === 'observed') {
      if (data.queuedCount !== closed.expectedCount || (closed.planId && data.planId !== closed.planId))
        fail('managed-delivery-receipt-mismatch');
      return this.view(record);
    }
    const delivery = this.receipt(record, data);
    if (delivery.ownerEpoch !== record.owner.epoch) fail('managed-delivery-needs-reattach-ledger');
    if (delivery.confirmed) {
      if (data.queuedCount !== delivery.expectedCount || (delivery.planId && data.planId !== delivery.planId))
        fail('managed-delivery-receipt-mismatch');
      return this.view(record);
    }
    record.wire.confirmSent(delivery.decisionId, delivery.nodeSequence, {
      queuedCount: data.queuedCount,
      planId: data.planId,
    });
    delete delivery.uncertainReason;
    return this.view(record);
  }
  reconcileLedger(record, data) {
    if (!record.deliveries.size) return;
    const closed = this.closedReceipt(record, data);
    if (closed && data.ownerEpoch === closed.ownerEpoch && data.documentId === closed.documentId) return;
    const delivery = this.receipt(record, data);
    if (data.ownerEpoch !== delivery.ownerEpoch || data.documentId !== delivery.documentId)
      fail('managed-delivery-ledger-owner-mismatch');
    if (data.stage === 'queued') {
      if (
        !integer(data.queuedCount) ||
        data.queuedCount > delivery.expectedCount ||
        (delivery.planId && data.planId !== delivery.planId)
      )
        fail('managed-delivery-receipt-mismatch');
      if (data.queuedCount !== delivery.expectedCount) {
        delivery.reportedQueuedCount = Math.max(delivery.reportedQueuedCount ?? 0, data.queuedCount);
        delivery.uncertainReason = 'partial-send-ledger';
        return;
      }
    }
    if (data.stage === 'queued' && !delivery.confirmed) {
      record.wire.confirmSent(delivery.decisionId, delivery.nodeSequence, {
        queuedCount: data.queuedCount,
        planId: data.planId,
      });
      delete delivery.uncertainReason;
      this.sync(record);
    } else if (!['intent', 'authorized', 'sending', 'queued', 'receipted'].includes(data.stage))
      fail('managed-delivery-ledger-stage-invalid');
    else if (['intent', 'sending', 'authorized'].includes(data.stage)) {
      if (!integer(data.queuedCount) || data.queuedCount > delivery.expectedCount)
        fail('managed-delivery-ledger-count-invalid');
      delivery.reportedQueuedCount = Math.max(delivery.reportedQueuedCount ?? 0, data.queuedCount);
    }
  }
  reject(data) {
    const record = this.record(data),
      delivery = record.deliveries.get(data.decisionId);
    if (delivery) {
      this.receipt(record, data);
      if (delivery.ownerEpoch !== record.owner.epoch) fail('managed-delivery-needs-reattach-ledger');
      record.wire.reject(data.decisionId, data.reason ?? 'known-not-sent');
      delivery.rejected = true;
    } else {
      const offered = record.wire.offer();
      if (offered?.decisionId === data.decisionId) {
        record.wire.invalidateManagedPreparation();
        if (record.wire.administrative.busy) record.wire.administrative.prepare();
        else record.wire.prepareCurrent();
      }
    }
    return this.view(record);
  }
  detach(data) {
    const record = this.record(data);
    record.owner.attached = false;
    record.owner.lastSeen = this.now();
    record.detachReason = data.reason ?? 'browser-detached';
    record.wire.detachManaged();
    return this.view(record);
  }
  unknown(data) {
    const record = this.record(data);
    if (this.closedReceipt(record, data)?.stage === 'observed') return this.view(record);
    if (data.decisionId) {
      const delivery = this.receipt(record, data);
      if (!integer(data.queuedCount ?? 0) || (data.queuedCount ?? 0) > delivery.expectedCount)
        fail('managed-delivery-ledger-count-invalid');
      delivery.reportedQueuedCount = Math.max(delivery.reportedQueuedCount ?? 0, data.queuedCount ?? 0);
      delivery.uncertainReason = data.reason ?? 'browser-send-outcome-unknown';
      record.owner.attached = false;
      record.wire.detachManaged();
    } else
      record.wire.unknown(undefined, data.reason ?? 'browser-send-outcome-unknown', data.queuedCount ?? 0);
    return this.view(record);
  }
  externalActivity(data) {
    const record = this.record(data);
    record.wire.externalActivity(data.activity ?? data.epoch, data.reason);
    return this.view(record);
  }
  clear(data) {
    const record = this.record(data);
    record.owner.attached = false;
    record.released = true;
    record.detachReason = 'game-cleared';
    record.wire.detachManaged();
    return this.view(record);
  }
  getSession(data) {
    return this.record(data).wire;
  }
  describe(data) {
    return data ? this.view(this.record(data)) : this.summary();
  }
  summary() {
    return {
      protocol: 'kf-managed-sessions-v1',
      sessions: [...this.records.values()].map((record) => ({
        ...record.identity,
        ...this.view(record),
      })),
      restoredSessions: [...this.restored.values()].map((row) => ({
        origin: row.origin,
        gameId: row.gameId,
        playerName: row.playerName,
        status:
          row.stopped || row.pendingDeliveries.length ? 'send-outcome-unknown' : 'waiting-for-attachment',
        finished: !!row.finished,
      })),
    };
  }
  exportCheckpoint() {
    const sessions = [...this.restored.values()].map(clone);
    for (const record of this.records.values()) {
      this.sync(record);
      sessions.push({
        ...record.identity,
        lastOwnerEpoch: record.lastOwnerEpoch,
        retiredDocuments: [...record.retiredDocuments, ...(record.owner ? [record.owner.documentId] : [])],
        finished: record.finished,
        released: !!record.released,
        stopped: !!record.wire.blocked || !!record.restoredUnknown,
        stopReason: record.restoredStopReason ?? (record.wire.blocked ? record.wire.error : null),
        deckIdentity: deckIdentity(record.wire.latestRaw),
        pendingDeliveries: record.restoredUnknown
          ? record.restoredPending
          : [...record.deliveries.values()].map((delivery) => this.deliverySummary(delivery)),
      });
    }
    return { version: 1, sessions };
  }
}
