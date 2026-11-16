/** Reconstruct the player-filtered Socket.IO deltas used by the official Keyteki client. */
import jsondiffpatch from 'jsondiffpatch';
import { createHash } from 'node:crypto';
import { canonical } from '../dist/src/shared/canonical.js';
import {
  compileKeytekiCommand,
  keytekiAdministrativeSurface,
  projectKeytekiState,
} from '../dist/src/adapters/keyteki.js';
import { KeytekiNavigation } from '../dist/src/adapters/keyteki-navigation.js';
import {
  KeytekiAllocationTracker,
  observePublicVeilSettlement,
  prepareKeytekiAllocationPlan,
  validatePublicVeilRuleContract,
  validateKeytekiAllocationPlan,
} from '../dist/src/adapters/keyteki-allocation.js';
import { StrategyController } from '../dist/src/ai/strategy-controller.js';
import { isAILoopHaltError } from '../dist/src/ai/loop-guard.js';
import {
  validatePublicCaptureRuleContract,
  observePublicCaptureSettlement,
} from '../dist/src/adapters/keyteki-public-capture.js';
import { KeytekiPublicHistory } from './keyteki-public-history.mjs';
import { KeytekiAdministrativeSession } from './keyteki-administrative-session.mjs';
import {
  KEYTEKI_TRANSPORT_RECOVERY_MS,
  keytekiTransportBinding,
  keytekiTransportCloseDiagnostic,
  validateKeytekiTransportFullState,
} from './keyteki-transport-recovery.mjs';
const hash = (x) => createHash('sha256').update(canonical(x)).digest('hex');
const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => canonical(a) === canonical(b);
const promptSurface = (raw, name) => {
  const p = raw.players?.[name] ?? {};
  return {
    buttons: p.buttons ?? [],
    controls: p.controls ?? [],
    promptTitle: p.promptTitle ?? '',
    menuTitle: p.menuTitle ?? '',
    selectCard: !!p.selectCard,
    selectOrder: !!p.selectOrder,
  };
};
function findCard(raw, id) {
  for (const player of Object.values(raw.players ?? {}))
    for (const cards of Object.values(player.cardPiles ?? {})) {
      if (!Array.isArray(cards)) continue;
      const found = cards.find((c) => c?.uuid === id);
      if (found) return found;
    }
  return null;
}
/** This is observed advancement, not a server action acknowledgement. Only the acting
 * player's prompt binding or the clicked/source card may establish progress; an opponent's
 * unrelated resource change must not commit a decision into model history.
 */
export function keytekiCommandProgress(before, after, name, command) {
  if (keytekiAdministrativeSurface(before, name) || keytekiAdministrativeSurface(after, name)) return false;
  if (!same(promptSurface(before, name), promptSurface(after, name))) return true;
  if (command.message === 'clickTide')
    return before.players?.[name]?.stats?.tide !== after.players?.[name]?.stats?.tide;
  const ids = [command.sourceCardId, command.message === 'cardClicked' ? command.args[0] : undefined].filter(
    Boolean,
  );
  return ids.some((id) => !same(findCard(before, id), findCard(after, id)));
}
/** A managed document replacement validates a native player view, not an idle
 * transport exception or proof that an outstanding command did not run.
 */
export function validateKeytekiManagedFullState(before, after, { playerName, participants }) {
  if (
    !object(after) ||
    typeof after.id !== 'string' ||
    !after.id ||
    after.started !== true ||
    after.manualMode !== false ||
    !object(after.players) ||
    !Array.isArray(participants) ||
    participants.length !== 2 ||
    new Set(participants).size !== 2 ||
    !participants.includes(playerName) ||
    !same(Object.keys(after.players).sort(), [...participants].sort()) ||
    (before && (before.id !== after.id || before.started !== true))
  )
    throw Error('managed-full-game-identity-invalid');
  for (const name of participants) {
    const player = after.players[name];
    if (
      !object(player) ||
      player.name !== name ||
      typeof player.activePlayer !== 'boolean' ||
      typeof player.phase !== 'string' ||
      !object(player.cardPiles) ||
      !['hand', 'archives', 'discard', 'purged', 'cardsInPlay'].every((zone) =>
        Array.isArray(player.cardPiles[zone]),
      ) ||
      !Number.isSafeInteger(player.numDeckCards) ||
      player.numDeckCards < 0 ||
      !Number.isSafeInteger(player.numArchivesCards) ||
      player.numArchivesCards < 0 ||
      !object(player.stats) ||
      !Number.isSafeInteger(player.stats.amber) ||
      player.stats.amber < 0 ||
      !Number.isSafeInteger(player.stats.chains) ||
      player.stats.chains < 0 ||
      !object(player.stats.keys) ||
      !['red', 'blue', 'yellow'].every((key) => typeof player.stats.keys[key] === 'boolean') ||
      player.left === true
    )
      throw Error('managed-full-player-state-required');
    if (before) {
      const old = before.players?.[name];
      if (!old || !same(old.houses, player.houses)) throw Error('managed-full-deck-houses-changed');
      for (const key of ['uuid', 'id', 'name', 'expansion'])
        if (!same(old.deckData?.[key], player.deckData?.[key]))
          throw Error('managed-full-deck-identity-changed');
    }
  }
  const me = after.players[playerName];
  if (me.disconnected === true || !Array.isArray(me.buttons) || !Array.isArray(me.controls))
    throw Error('managed-full-current-player-required');
  const validWindow = (rows) =>
    Array.isArray(rows) &&
    rows.every((row) => object(row) && typeof row.id === 'string' && row.id) &&
    new Set(rows.map((row) => row.id)).size === rows.length;
  if (!validWindow(after.messages)) throw Error('managed-full-message-window-invalid');
  let continuous = !before;
  if (before && validWindow(before.messages)) {
    const old = before.messages,
      next = after.messages;
    if (!old.length) continuous = !next.length;
    else {
      const boundary = next.findIndex((row) => row.id === old.at(-1).id);
      continuous =
        boundary >= 0 &&
        boundary < old.length &&
        same(old.slice(old.length - boundary - 1), next.slice(0, boundary + 1)) &&
        !next.slice(boundary + 1).some((row) => old.some((prior) => prior.id === row.id));
    }
  }
  return {
    kind: 'managed-native-full-state',
    gameId: after.id,
    playerName,
    beforeStateSha256: before ? hash(before) : null,
    afterStateSha256: hash(after),
    publicWindowContinuous: continuous,
  };
}
export class KeytekiStateStream {
  constructor() {
    this.patcher = jsondiffpatch.create({
      objectHash: (o, i) => o.uuid || o.name || o.id || o._id || '$$index:' + i,
    });
    this.clear();
  }
  clear() {
    this.root = undefined;
    this.sequence = 0;
    this.turn = 1;
    this.history = new KeytekiPublicHistory();
    this.firstPlayerName = undefined;
  }
  replaceFull(full, sequence, identity) {
    if (!this.root || !Number.isSafeInteger(sequence) || sequence !== this.sequence + 1)
      throw Error('Transport resync sequence mismatch');
    validateKeytekiTransportFullState(this.root, full, identity);
    this.root = structuredClone(full);
    this.sequence = sequence;
    const history = this.history.observe(this.root);
    this.turn = history.currentTurn ?? 1;
    this.firstPlayerName = history.firstPlayerName;
    return structuredClone(this.root);
  }
  replaceManagedFull(full, sequence, identity) {
    if (!Number.isSafeInteger(sequence) || sequence !== this.sequence + 1)
      throw Error('Managed full sequence mismatch');
    const proof = validateKeytekiManagedFullState(this.root, full, identity);
    if (this.root && !proof.publicWindowContinuous)
      this.history.invalidate('managed-attach-message-window-gap');
    this.root = structuredClone(full);
    this.sequence = sequence;
    const history = this.history.observe(this.root);
    this.turn = history.currentTurn ?? 1;
    this.firstPlayerName = history.firstPlayerName;
    return { raw: structuredClone(this.root), proof };
  }
  receive(delta, sequence) {
    if (!Number.isSafeInteger(sequence) || sequence !== this.sequence + 1) {
      this.history.invalidate('state-sequence-gap');
      throw Error('State sequence gap: a full resync is required');
    }
    if (!this.root) {
      if (!object(delta) || typeof delta.id !== 'string' || !object(delta.players))
        throw Error('Initial full player state required');
      this.root = structuredClone(delta);
    } else if (delta !== null && delta !== undefined && (!object(delta) || Object.keys(delta).length)) {
      this.root = this.patcher.patch(structuredClone(this.root), structuredClone(delta));
    }
    this.sequence = sequence;
    const history = this.history.observe(this.root);
    this.turn = history.currentTurn ?? 1;
    this.firstPlayerName = history.firstPlayerName;
    return structuredClone(this.root);
  }
}
export class KeytekiWireSession {
  constructor(options) {
    if (
      !options.playerName ||
      !Array.isArray(options.participants) ||
      options.participants.length !== 2 ||
      !options.participants.includes(options.playerName) ||
      new Set(options.participants).size !== 2
    )
      throw Error('Configure both private-test participants');
    this.options = {
      ...options,
      ...(options.publicVeilRuleContract
        ? { publicVeilRuleContract: structuredClone(options.publicVeilRuleContract) }
        : {}),
      ...(options.publicCaptureRuleContract
        ? { publicCaptureRuleContract: structuredClone(options.publicCaptureRuleContract) }
        : {}),
    };
    if (options.publicVeilRuleContract)
      validatePublicVeilRuleContract(options.publicVeilRuleContract, {
        origin: options.origin,
        frontendBundleSha256: options.frontendBundleSha256,
        participants: options.participants,
        deckLists: options.deckLists,
      });
    this.stream = new KeytekiStateStream();
    if (options.publicCaptureRuleContract)
      validatePublicCaptureRuleContract(options.publicCaptureRuleContract, {
        origin: options.origin,
        frontendBundleSha256: options.frontendBundleSha256,
        participants: options.participants,
        deckLists: options.deckLists,
      });
    this.loopGuardEvents = [];
    this.loopGuardEventsDropped = 0;
    this.lastStrategyFault = null;
    this.lastCommandRejection = null;
    this.controller = new StrategyController({
      ...options.strategy,
      onLoopGuardEvent: (event) => {
        // The shared controller emits only accepted replacements and terminal halts.
        // Queries, prepared choices and rejected sends never enter this ledger.
        this.loopGuardEvents.push(structuredClone(event));
        if (this.loopGuardEvents.length > 128) {
          this.loopGuardEvents.shift();
          this.loopGuardEventsDropped++;
        }
        options.strategy?.onLoopGuardEvent?.(event);
      },
    });
    this.navigation = new KeytekiNavigation();
    this.allocation = new KeytekiAllocationTracker({
      verifiedVeilScope: options.verifiedVeilScope,
      publicVeilRuleContract: this.options.publicVeilRuleContract,
      publicCaptureRuleContract: this.options.publicCaptureRuleContract,
      origin: options.origin,
      frontendBundleSha256: options.frontendBundleSha256,
    });
    this.publicVeilSettlements = [];
    this.publicCaptureSettlements = [];
    this.allocationState = { status: 'none' };
    this.revision = 0;
    this.sourceCardId = undefined;
    this.projection = undefined;
    this.frame = undefined;
    this.ready = undefined;
    this.readyPlan = undefined;
    this.sent = undefined;
    this.generation = 0;
    this.positionHash = undefined;
    this.latestRaw = undefined;
    this.activity = 0;
    this.blocked = false;
    this.status = 'waiting-for-full-state';
    this.preparingTasks = 0;
    this.transport = undefined;
    this.transportRecovery = undefined;
    this.transportLedger = [];
    this.managedDetached = false;
    this.managedFullReceipt = null;
    this.error = null;
    this.errorCode = null;
    this.stats = {
      states: 0,
      decisions: 0,
      commands: 0,
      queuedCommands: 0,
      acknowledged: 0,
      model: 0,
      fallbacks: 0,
      stale: 0,
      allocationPlans: 0,
      allocationUnitsPrepared: 0,
      allocationPlansDispatched: 0,
      allocationPlansObserved: 0,
      allocationPlansUnknown: 0,
      publicVeilPlansDispatched: 0,
      publicVeilSettlementsVerified: 0,
      publicVeilSettlementsUnverifiable: 0,
      publicCapturePlansDispatched: 0,
      publicCaptureSettlementsVerified: 0,
      publicCaptureSettlementsUnverifiable: 0,
    };
    this.administrative = new KeytekiAdministrativeSession({
      strategy: options.strategy,
      playerName: options.playerName,
      onUnknown: (reason) => this.unknown(undefined, reason, this.sent?.queuedCount ?? 0, false),
    });
  }
  receive(delta, sequence, transport) {
    if (this.transportRecovery) {
      this.disconnect('state-delta-during-transport-recovery');
      return this.describe();
    }
    let raw;
    try {
      if (transport !== undefined) {
        const binding = keytekiTransportBinding(transport, this.options.origin, this.options.gameSocketPaths);
        if (
          (this.transport && !same(this.transport, binding)) ||
          (!this.transport && (this.stream.sequence !== 0 || binding.epoch !== 0))
        )
          throw Error('transport-generation-changed-without-resync');
        this.transport ??= binding;
      } else if (this.transport) throw Error('transport-binding-missing');
      raw = this.stream.receive(delta, sequence);
    } catch (error) {
      this.disconnect('state-stream-unusable: ' + error.message);
      throw error;
    }
    return this.observeRaw(raw, sequence);
  }
  invalidateManagedPreparation() {
    this.suspendGamePreparation();
    if (this.frame && !this.sent)
      this.controller.invalidatePrepared(this.frame.matchId, this.frame.observation.you);
    const admin = this.administrative;
    if (!admin.sent) {
      admin.invalidatePrepared();
      if (admin.current?.frame)
        admin.controller.invalidatePrepared(admin.current.frame.matchId, admin.current.frame.observation.you);
    }
  }
  detachManaged() {
    this.managedDetached = true;
    this.invalidateManagedPreparation();
    if (!this.blocked && !this.sent && !this.administrative.sent && this.status !== 'finished')
      this.status = 'waiting-for-attachment';
    return this.describe();
  }
  attachManaged(fullState, sequence, transport, { hold = false } = {}) {
    // Validate before invalidating live work or changing either connection generation.
    validateKeytekiManagedFullState(this.latestRaw, fullState, this.options);
    const binding = keytekiTransportBinding(transport, this.options.origin, this.options.gameSocketPaths);
    if (!Number.isSafeInteger(sequence) || sequence !== this.stream.sequence + 1)
      throw Error('Managed full sequence mismatch');
    this.invalidateManagedPreparation();
    this.managedDetached = hold;
    const { raw, proof } = this.stream.replaceManagedFull(fullState, sequence, this.options);
    this.transport = binding;
    this.transportRecovery = undefined;
    this.managedFullReceipt = { ...proof, sequence, transport: structuredClone(binding) };
    // Keep navigation/source/allocation/history; the full wire view omits some
    // observed semantic evidence. Only the decision revision is always refreshed.
    this.positionHash = undefined;
    return this.observeRaw(raw, sequence);
  }
  observeRaw(raw, sequence) {
    if (!same(Object.keys(raw.players ?? {}).sort(), [...this.options.participants].sort())) {
      this.disconnect('game-participants-changed');
      throw Error('Only the configured private-test participants are allowed');
    }
    if (this.latestRaw?.id && raw.id !== this.latestRaw.id) {
      this.unknown(
        this.sent?.decision.id,
        'game-identity-changed-without-clear',
        this.sent?.queuedCount ?? 0,
        false,
      );
      return this.describe();
    }
    const wasStarted = this.latestRaw?.started === true,
      wasAdministrative =
        this.administrative.busy || keytekiAdministrativeSurface(this.latestRaw, this.options.playerName);
    this.latestRaw = raw;
    if (raw.started !== true) {
      if (wasStarted)
        this.unknown(undefined, 'game-started-state-regressed', this.sent?.queuedCount ?? 0, false);
      else if (!this.blocked) this.status = 'waiting-for-game-start';
      return this.describe();
    }
    const options = {
      playerName: this.options.playerName,
      revision: this.revision + 1,
      turn: this.stream.turn,
      turnHistory: this.stream.history.snapshot(),
      firstPlayerName: this.stream.firstPlayerName,
      sourceCardId: this.sourceCardId,
      deckLists: this.options.deckLists,
    };
    const overlay = keytekiAdministrativeSurface(raw, this.options.playerName);
    let p = overlay ? projectKeytekiState(raw, options) : this.navigation.project(raw, options);
    const positionHash = hash({
      observation: { ...p.observation, revision: 0 },
      commands: p.commands,
      unsupported: p.unsupported,
      unknown: p.unknown,
      administrativeRequest: p.administrativeRequest,
    });
    this.stats.states++;
    const changed = positionHash !== this.positionHash;
    if (changed) {
      this.positionHash = positionHash;
      this.revision++;
    } else
      p = overlay
        ? projectKeytekiState(raw, { ...options, revision: this.revision })
        : this.navigation.project(raw, { ...options, revision: this.revision });
    this.projection = p;
    this.frame = {
      matchId: p.gameId,
      observation: p.observation,
      qualifications: [
        ...p.unknown,
        ...(p.navigationActionIds.length
          ? [
              'Card-click choices may only open a server menu. Reassess each prompt; navigation does not guarantee a completed play or use.',
            ]
          : []),
      ],
      ...(p.administrativeRequest ? { administrativeRequest: p.administrativeRequest } : {}),
    };
    if (this.blocked) return this.describe();
    this.administrative.observe(raw, p, sequence, this.activity);
    if (overlay || this.administrative.busy) {
      this.suspendGamePreparation();
      if (!this.administrative.busy) {
        this.status = p.unsupported.length ? 'unsupported' : 'waiting-for-opponent';
        this.error = p.unsupported.length ? p.unsupported.join('; ') : null;
        this.errorCode = p.unsupported.length ? 'KEYTEKI_UNSUPPORTED' : null;
      }
      return this.describe();
    }
    // An administrative overlay must not clear an unfinished allocation descriptor.
    this.allocationState = this.allocation.observe(raw, p);
    if (!changed && !wasAdministrative) return this.describe();
    this.advanceGameplay();
    return this.describe();
  }
  suspendGamePreparation() {
    this.generation++;
    if (this.ready) this.controller.discard(this.ready.id);
    this.ready = undefined;
    this.readyPlan = undefined;
  }
  advanceGameplay() {
    if (
      this.blocked ||
      this.transportRecovery ||
      this.administrative.busy ||
      keytekiAdministrativeSurface(this.latestRaw, this.options.playerName)
    )
      return;
    if (this.sent) {
      if (
        this.sent.plan &&
        this.allocationState.status === 'unsupported' &&
        this.allocationPromptStillOpen(this.sent.plan)
      ) {
        this.unknown(this.sent.decision.id, 'allocation-public-position-changed', this.sent.queuedCount);
        return;
      }
      if (!this.sent.confirmed) {
        this.status = 'awaiting-client-send-confirmation';
        return;
      }
      if (!this.finishObservedCommand()) {
        if (!this.blocked) this.status = 'awaiting-command-effect';
        return;
      }
    }
    this.prepareCurrent();
  }
  allocationPromptStillOpen(plan) {
    const me = this.latestRaw?.players?.[this.options.playerName] ?? {};
    return (me.controls ?? []).some((c) => c.uuid === plan.descriptor.promptUuid + ':0');
  }
  finishObservedCommand() {
    const sent = this.sent;
    if (
      this.blocked ||
      this.administrative.busy ||
      !sent?.confirmed ||
      this.stream.sequence <= sent.sequence ||
      (sent.plan &&
        (sent.queuedCount !== sent.plan.commands.length || this.allocationPromptStillOpen(sent.plan))) ||
      !keytekiCommandProgress(sent.before, this.latestRaw, this.options.playerName, sent.command)
    )
      return false;
    if (sent.plan?.descriptor.amountEvidence.kind === 'public-rule-contract-and-visible-discard') {
      const settlement = observePublicVeilSettlement(sent.plan, sent.before, this.latestRaw);
      this.publicVeilSettlements.push({
        ...settlement,
        beforeSequence: sent.sequence,
        afterSequence: this.stream.sequence,
        queuedCommands: sent.queuedCount,
      });
      if (settlement.status !== 'verified') {
        this.stats.publicVeilSettlementsUnverifiable++;
        this.unknown(
          sent.decision.id,
          settlement.reason ?? 'public-veil-settlement-unverifiable',
          sent.queuedCount,
          false,
        );
        return false;
      }
      this.stats.publicVeilSettlementsVerified++;
    }
    if (sent.plan?.descriptor.amountEvidence.kind === 'public-capture-contract-and-visible-state') {
      const settlement = observePublicCaptureSettlement(
        sent.plan,
        sent.before,
        this.latestRaw,
        this.options.publicCaptureRuleContract,
      );
      this.publicCaptureSettlements.push({
        ...settlement,
        beforeSequence: sent.sequence,
        afterSequence: this.stream.sequence,
        queuedCommands: sent.queuedCount,
      });
      if (settlement.status !== 'verified') {
        this.stats.publicCaptureSettlementsUnverifiable++;
        this.unknown(
          sent.decision.id,
          settlement.reason ?? 'public-capture-settlement-unverifiable',
          sent.queuedCount,
          false,
        );
        return false;
      }
      this.stats.publicCaptureSettlementsVerified++;
    }
    this.controller.acknowledge(sent.decision.id, true);
    this.stats.acknowledged++;
    if (sent.plan) this.stats.allocationPlansObserved++;
    this.sent = undefined;
    return true;
  }
  prepared(d, allocation = false) {
    this.stats.decisions++;
    if (d.controller === 'model') this.stats.model++;
    if (d.controller === 'code-fallback') this.stats.fallbacks++;
    if (allocation) this.stats.allocationUnitsPrepared++;
  }
  prepareCurrent() {
    if (
      this.blocked ||
      this.managedDetached ||
      this.transportRecovery ||
      this.administrative.busy ||
      keytekiAdministrativeSurface(this.latestRaw, this.options.playerName) ||
      this.sent ||
      !this.projection
    )
      return;
    if (this.ready) {
      this.controller.discard(this.ready.id);
      this.ready = undefined;
      this.readyPlan = undefined;
    }
    const p = this.projection,
      frame = this.frame,
      generation = ++this.generation;
    if (p.observation.winner !== null) {
      this.status = 'finished';
      return;
    }
    if (p.unsupported.length || this.allocationState.status === 'unsupported') {
      this.status = 'unsupported';
      this.errorCode = 'KEYTEKI_UNSUPPORTED';
      this.error = [
        ...p.unsupported,
        ...(this.allocationState.status === 'unsupported' ? [this.allocationState.reason] : []),
      ].join('; ');
      return;
    }
    if (!p.observation.legalActions.length) {
      this.status = 'waiting-for-opponent';
      return;
    }
    this.status = 'thinking';
    this.error = null;
    this.errorCode = null;
    const allocating = this.allocationState.status === 'ready';
    const current = () =>
      generation === this.generation && !this.blocked && !this.managedDetached && !this.sent;
    const task = allocating
      ? prepareKeytekiAllocationPlan(
          this.controller,
          frame,
          p,
          this.allocationState.descriptor,
          current,
          (d) => this.prepared(d, true),
        )
      : this.controller.prepare(frame).then((d) => {
          this.prepared(d);
          return d;
        });
    this.preparingTasks++;
    task
      .then((value) => {
        const d = allocating ? value.finalDecision : value;
        if (!current()) {
          this.controller.discard(d.id);
          this.stats.stale++;
          return;
        }
        this.ready = d;
        this.readyPlan = allocating ? value : undefined;
        if (allocating) this.stats.allocationPlans++;
        this.status = 'ready';
      })
      .catch((error) => {
        if (generation === this.generation && !this.blocked) {
          this.status = 'error';
          this.error = error instanceof Error ? error.message : 'Strategy preparation failed';
          this.errorCode = isAILoopHaltError(error)
            ? 'AI_LOOP_GUARD_HALT'
            : /^[A-Z][A-Z0-9_]{1,99}$/.test(error?.code ?? '')
              ? error.code
              : 'KEYTEKI_STRATEGY_ERROR';
          this.lastStrategyFault = {
            code: this.errorCode,
            message: this.error,
            gameId: frame.matchId,
            revision: frame.observation.revision,
            turn: frame.observation.turn,
            sequence: this.stream.sequence,
          };
        } else this.stats.stale++;
      })
      .finally(() => {
        this.preparingTasks--;
      });
  }
  offer() {
    this.checkTransportDeadline();
    if (this.blocked || this.managedDetached || this.transportRecovery) return null;
    if (this.administrative.busy) {
      const admin = this.administrative;
      if (admin.blocked || admin.sent || !admin.ready || !admin.current?.projection.administrativeRequest)
        return null;
      const { projection, sequence, activity } = admin.current;
      return {
        decisionId: 'administrative:' + admin.ready.id,
        gameId: projection.gameId,
        sequence,
        revision: projection.observation.revision,
        activity,
        command: compileKeytekiCommand(projection, admin.ready.actionId, {
          revision: projection.observation.revision,
          fingerprint: projection.fingerprint,
        }),
      };
    }
    if (!this.ready || this.sent) return null;
    const d = this.ready,
      p = this.projection,
      plan = this.readyPlan;
    let command;
    if (plan) {
      validateKeytekiAllocationPlan(plan, p);
      command = plan.commands.at(-1);
    } else
      command = compileKeytekiCommand(p, d.actionId, {
        revision: p.observation.revision,
        fingerprint: p.fingerprint,
      });
    return {
      decisionId: d.id,
      gameId: p.gameId,
      sequence: this.stream.sequence,
      revision: this.revision,
      activity: this.activity,
      ...(plan
        ? {
            plan: {
              kind: plan.kind,
              id: plan.id,
              promptUuid: plan.descriptor.promptUuid,
              sourceCardId: plan.descriptor.sourceCardId,
              amount: plan.descriptor.amount,
              ...(plan.descriptor.pointsPerClick ? { pointsPerClick: plan.descriptor.pointsPerClick } : {}),
              allowedTargets: plan.descriptor.allowedTargets,
              commands: plan.commands,
              targets: plan.targets,
            },
          }
        : { command }),
    };
  }
  take(expectedDecisionId) {
    const offered = this.offer();
    if (expectedDecisionId && offered?.decisionId !== expectedDecisionId)
      throw Error('Stale offered decision');
    if (!offered) return null;
    if (this.administrative.busy) return this.administrative.take();
    const d = this.ready,
      p = this.projection,
      plan = this.readyPlan,
      command = plan ? plan.commands.at(-1) : offered.command;
    const dispatchFrame = plan ? plan.finalFrame : this.frame;
    this.controller.dispatch(d, dispatchFrame);
    this.ready = undefined;
    this.readyPlan = undefined;
    this.sent = {
      decision: d,
      command,
      plan,
      before: structuredClone(this.latestRaw),
      sequence: this.stream.sequence,
      activity: this.activity,
      confirmed: false,
      queuedCount: 0,
      previousSource: this.sourceCardId,
    };
    if (plan) {
      // Only the final decision is pending in the shared controller; the ordered
      // command group has its own receipt and never fabricates prefix acknowledgements.
      this.navigation.recordCommand(p, d.actionId, command);
      this.stats.allocationPlansDispatched++;
    } else this.navigation.recordCommand(p, d.actionId, command);
    this.sourceCardId = command.sourceCardId ?? this.sourceCardId;
    this.stats.commands += plan ? plan.commands.length : 1;
    this.status = 'awaiting-client-send-confirmation';
    // Private optional evidence only. Dispatch does not prove a client queue receipt or ACK.
    if (this.options.onDecisionEvidence) {
      try {
        this.options.onDecisionEvidence(
          structuredClone({
            frame: dispatchFrame,
            decision: d,
            playerName: this.options.playerName,
            nodeSequence: this.stream.sequence,
            ...(plan
              ? {
                  allocation: {
                    id: plan.id,
                    decisionIds: plan.decisions.map((decision) => decision.id),
                    targets: plan.targets,
                  },
                }
              : {}),
          }),
        );
      } catch {
        /* Evidence must never change the dispatched command or its lifecycle. */
      }
    }
    return offered;
  }
  confirmSent(decisionId, sequence, receipt = {}) {
    if (this.administrative.owns(decisionId)) {
      if (this.blocked) throw Error('Command outcome is unknown; no acknowledgement is inferred');
      this.administrative.confirmSent(decisionId, sequence, receipt);
      if (!this.administrative.busy) {
        this.allocationState = this.allocation.observe(this.latestRaw, this.projection);
        this.advanceGameplay();
      }
      return;
    }
    if (!this.sent || this.sent.decision.id !== decisionId || this.sent.sequence !== sequence)
      throw Error('Unknown command send receipt');
    if (this.blocked) throw Error('Command outcome is unknown; no acknowledgement is inferred');
    if (this.sent.confirmed) throw Error('Duplicate client send receipt');
    const expected = this.sent.plan ? this.sent.plan.commands.length : 1;
    const queued = receipt.queuedCount ?? (this.sent.plan ? undefined : 1);
    if (!Number.isSafeInteger(queued) || queued < 0 || queued > expected)
      throw Error('Invalid queued command count');
    if (this.sent.plan && receipt.planId !== this.sent.plan.id)
      throw Error('Allocation plan receipt mismatch');
    this.stats.queuedCommands += queued;
    this.sent.queuedCount = queued;
    if (queued !== expected) {
      this.unknown(decisionId, 'partial-allocation-send', queued, false);
      return;
    }
    this.sent.confirmed = true;
    // This public counter represents a complete client queue receipt, not merely
    // handing a draft to a userscript which can still reject it without sending.
    if (this.sent.plan?.descriptor.amountEvidence.kind === 'public-rule-contract-and-visible-discard')
      this.stats.publicVeilPlansDispatched++;
    if (this.sent.plan?.descriptor.amountEvidence.kind === 'public-capture-contract-and-visible-state')
      this.stats.publicCapturePlansDispatched++;
    this.status = 'awaiting-command-effect';
    if (this.finishObservedCommand()) this.prepareCurrent();
  }
  unknown(decisionId, reason, queuedCount = 0, countReceipt = true) {
    if (this.administrative.owns(decisionId)) {
      this.administrative.unknown(decisionId, reason, queuedCount);
      return;
    }
    if (decisionId && (!this.sent || this.sent.decision.id !== decisionId))
      throw Error('Unknown uncertain command');
    if (this.blocked) return;
    if (this.sent) {
      const expected = this.sent.plan ? this.sent.plan.commands.length : 1;
      if (!Number.isSafeInteger(queuedCount) || queuedCount < 0 || queuedCount > expected)
        throw Error('Invalid uncertain queued count');
      if (countReceipt && queuedCount > this.sent.queuedCount)
        this.stats.queuedCommands += queuedCount - this.sent.queuedCount;
      this.sent.queuedCount = Math.max(this.sent.queuedCount, queuedCount);
      if (this.sent.plan) this.stats.allocationPlansUnknown++;
    }
    if (this.transportRecovery) {
      this.transportLedger.push({
        event: 'failed',
        epoch: this.transportRecovery.epoch,
        sequence: this.stream.sequence,
        reason,
      });
      this.transportRecovery = undefined;
    }
    this.blocked = true;
    this.administrative.stop(reason);
    this.generation++;
    if (this.ready) {
      this.controller.discard(this.ready.id);
      this.ready = undefined;
      this.readyPlan = undefined;
    }
    this.allocation.markUnknown(reason);
    this.allocationState = { status: 'unsupported', reason: 'allocation-outcome-unknown: ' + reason };
    this.status = 'send-outcome-unknown';
    this.error = reason;
    this.errorCode = 'KEYTEKI_SEND_OUTCOME_UNKNOWN';
    // A dispatched decision stays unacknowledged. Neither its draft model history
    // nor an estimated number of accepted clicks is committed or replayed.
  }
  externalActivity(epoch, reason = 'external-game-command') {
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw Error('Invalid client activity epoch');
    if (epoch <= this.activity) return;
    this.activity = epoch;
    if (this.status === 'finished') return;
    this.unknown(this.sent?.decision.id, reason, this.sent?.queuedCount ?? 0, false);
  }
  checkTransportDeadline() {
    if (this.transportRecovery && Date.now() >= this.transportRecovery.deadline)
      this.disconnect('transport-recovery-timeout');
  }
  suspendTransport(request) {
    this.checkTransportDeadline();
    if (this.blocked || this.status === 'finished') return this.describe();
    try {
      const binding = keytekiTransportBinding(
        request.transport,
        this.options.origin,
        this.options.gameSocketPaths,
      );
      const diagnostic = keytekiTransportCloseDiagnostic(request.diagnostic);
      const me = this.latestRaw?.players?.[this.options.playerName];
      if (
        this.transportRecovery ||
        !this.transport ||
        !same(binding, this.transport) ||
        request.nextEpoch !== binding.epoch + 1 ||
        request.sequence !== this.stream.sequence ||
        request.activity !== this.activity ||
        request.gameId !== this.latestRaw?.id ||
        this.latestRaw?.started !== true ||
        this.latestRaw?.manualMode !== false ||
        me?.activePlayer !== false ||
        me?.selectCard === true ||
        me?.selectOrder === true ||
        !Array.isArray(me?.buttons) ||
        me.buttons.length ||
        !Array.isArray(me?.controls) ||
        me.controls.length ||
        this.status !== 'waiting-for-opponent' ||
        this.error ||
        this.preparingTasks !== 0 ||
        this.ready ||
        this.readyPlan ||
        this.sent ||
        this.administrative.busy ||
        keytekiAdministrativeSurface(this.latestRaw, this.options.playerName) ||
        this.allocationState.status !== 'none' ||
        this.projection?.unsupported.length ||
        !this.projection ||
        this.projection.observation.legalActions.length
      )
        throw Error('transport-close-not-completely-idle');
      // Validate the old public window now; it must be a usable full starting point.
      validateKeytekiTransportFullState(this.latestRaw, this.latestRaw, {
        playerName: this.options.playerName,
        participants: this.options.participants,
      });
      const closedAt = Date.now();
      this.transportRecovery = {
        epoch: request.nextEpoch,
        previousEpoch: binding.epoch,
        path: binding.path,
        sequence: request.sequence,
        activity: request.activity,
        gameId: request.gameId,
        closedAt,
        deadline: closedAt + KEYTEKI_TRANSPORT_RECOVERY_MS,
      };
      this.transportLedger.push({ event: 'idle-close', ...this.transportRecovery, diagnostic });
      this.generation++;
      this.status = 'waiting-for-transport';
    } catch (error) {
      this.disconnect(error.message);
    }
    return this.describe();
  }
  resumeTransport(request) {
    this.checkTransportDeadline();
    if (this.blocked) return this.describe();
    const recovery = this.transportRecovery;
    try {
      const binding = keytekiTransportBinding(
        request.transport,
        this.options.origin,
        this.options.gameSocketPaths,
      );
      if (
        !recovery ||
        request.nativeFullState !== true ||
        request.newEngineHandshake !== true ||
        binding.epoch !== recovery.epoch ||
        binding.path !== recovery.path ||
        request.previousEpoch !== recovery.previousEpoch ||
        request.sequence !== recovery.sequence + 1 ||
        this.stream.sequence !== recovery.sequence ||
        request.activity !== recovery.activity ||
        this.activity !== recovery.activity ||
        request.gameId !== recovery.gameId
      )
        throw Error('transport-resume-binding-invalid');
      const identity = { playerName: this.options.playerName, participants: this.options.participants };
      const proof = validateKeytekiTransportFullState(this.latestRaw, request.fullState, identity);
      const raw = this.stream.replaceFull(request.fullState, request.sequence, identity);
      this.transport = binding;
      this.transportRecovery = undefined;
      // The old controller, its dedupe IDs and all outcome ledgers survive. Only
      // transient card/menu inference is discarded; no action is replayed or ACKed.
      this.navigation.reset();
      this.sourceCardId = undefined;
      this.positionHash = undefined;
      this.allocation.reset();
      this.allocationState = { status: 'none' };
      this.transportLedger.push({
        event: 'resumed',
        epoch: binding.epoch,
        previousEpoch: recovery.previousEpoch,
        beforeSequence: recovery.sequence,
        sequence: request.sequence,
        nativeFullState: true,
        newEngineHandshake: true,
        ...proof,
      });
      return this.observeRaw(raw, request.sequence);
    } catch (error) {
      this.disconnect(error.message);
      return this.describe();
    }
  }
  disconnect(reason = 'game-transport-closed') {
    if (this.status === 'finished') return;
    this.unknown(this.sent?.decision.id, reason, this.sent?.queuedCount ?? 0, false);
  }
  reject(decisionId, reason) {
    if (this.administrative.owns(decisionId)) {
      if (this.blocked) throw Error('Command outcome is unknown; no acknowledgement is inferred');
      this.administrative.reject(decisionId, reason);
      if (!this.administrative.busy) {
        this.allocationState = this.allocation.observe(this.latestRaw, this.projection);
        this.advanceGameplay();
      }
      return;
    }
    if (!this.sent || this.sent.decision.id !== decisionId) throw Error('Unknown dispatched decision');
    if (this.sent.confirmed || this.sent.queuedCount || this.blocked)
      throw Error('Send outcome is unknown; a sent command cannot be automatically retried');
    this.controller.acknowledge(decisionId, false);
    this.sourceCardId = this.sent.previousSource;
    this.sent = undefined;
    this.error = reason;
    this.errorCode = 'KEYTEKI_CLIENT_REJECTED';
    this.lastCommandRejection = {
      reason,
      decisionId,
      revision: this.revision,
      sequence: this.stream.sequence,
    };
    this.navigation.reset();
    const options = {
      playerName: this.options.playerName,
      revision: ++this.revision,
      turn: this.stream.turn,
      turnHistory: this.stream.history.snapshot(),
      firstPlayerName: this.stream.firstPlayerName,
      sourceCardId: this.sourceCardId,
      deckLists: this.options.deckLists,
    };
    const overlay = keytekiAdministrativeSurface(this.latestRaw, this.options.playerName);
    this.projection = overlay
      ? projectKeytekiState(this.latestRaw, options)
      : this.navigation.project(this.latestRaw, options);
    if (!overlay && !this.administrative.busy)
      this.allocationState = this.allocation.observe(this.latestRaw, this.projection);
    this.frame = {
      matchId: this.projection.gameId,
      observation: this.projection.observation,
      qualifications: this.projection.unknown,
      ...(this.projection.administrativeRequest
        ? { administrativeRequest: this.projection.administrativeRequest }
        : {}),
    };
    this.positionHash = undefined;
    this.administrative.observe(this.latestRaw, this.projection, this.stream.sequence, this.activity);
    this.advanceGameplay();
  }
  describe() {
    this.checkTransportDeadline();
    const administration = this.administrative.describe(),
      activeAdministration = !this.blocked && this.administrative.busy;
    return {
      status: activeAdministration ? administration.status : this.status,
      error: activeAdministration ? administration.error : this.error,
      errorCode: activeAdministration
        ? administration.error
          ? 'KEYTEKI_ADMINISTRATIVE_ERROR'
          : null
        : this.errorCode,
      loopGuard: this.frame
        ? (this.controller.loopGuardSnapshot(this.frame.matchId, this.frame.observation.you) ?? null)
        : null,
      diagnostics: {
        loopGuardEvents: structuredClone(this.loopGuardEvents),
        loopGuardEventsDropped: this.loopGuardEventsDropped,
        lastStrategyFault: structuredClone(this.lastStrategyFault),
        lastCommandRejection: structuredClone(this.lastCommandRejection),
      },
      gameId: this.projection?.gameId,
      sequence: this.stream.sequence,
      revision: this.revision,
      activity: this.activity,
      transport: this.transport ? structuredClone(this.transport) : null,
      transportRecovery: this.transportRecovery ? structuredClone(this.transportRecovery) : null,
      transportLedger: structuredClone(this.transportLedger),
      turnHistory: this.stream.history.snapshot(),
      stats: this.stats,
      administrative: administration,
      navigation: this.navigation.summary(),
      allocation:
        this.allocationState.status === 'ready'
          ? {
              status: 'ready',
              id: this.allocationState.descriptor.id,
              amount: this.allocationState.descriptor.amount,
            }
          : this.allocationState,
      verifiedVeilScope: this.options.verifiedVeilScope?.id ?? null,
      publicVeilRuleContract: this.options.publicVeilRuleContract
        ? {
            id: this.options.publicVeilRuleContract.id,
            origin: this.options.publicVeilRuleContract.origin,
            frontendBundleSha256: this.options.publicVeilRuleContract.frontendBundleSha256,
            backendRuleVersion: 'unreported',
          }
        : null,
      publicVeilSettlements: structuredClone(this.publicVeilSettlements),
      publicCaptureRuleContract: this.options.publicCaptureRuleContract
        ? {
            id: this.options.publicCaptureRuleContract.id,
            origin: this.options.publicCaptureRuleContract.origin,
            frontendBundleSha256: this.options.publicCaptureRuleContract.frontendBundleSha256,
            backendRuleVersion: 'unreported',
            profile: this.options.publicCaptureRuleContract.profile,
          }
        : null,
      publicCaptureSettlements: structuredClone(this.publicCaptureSettlements),
      unsupported: [
        ...(this.projection?.unsupported ?? []),
        ...(this.allocationState.status === 'unsupported' ? [this.allocationState.reason] : []),
      ],
      unknown: this.projection?.unknown ?? [],
    };
  }
}
