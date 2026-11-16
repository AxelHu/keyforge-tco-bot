/** One observation-only strategy boundary for the local engine and remote player clients. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Command, KeyColor, Observation, Seat } from '../contracts/observation.js';
import { canonical } from '../shared/canonical.js';
import { createCodePolicy } from './code-strategies.js';
import { DOK_POLICY_IDS, snapshotCodeStrategyContext, type CodeStrategyContext } from './dok-policy.js';
import { acceptDecision, type Policy } from './policies.js';
import {
  AILoopGuard,
  type AILoopGuardOptions,
  type LoopGuardEvent,
  type LoopGuardSnapshot,
} from './loop-guard.js';
import { buildMirrorInput } from './mirror-input.js';
import type { ChoiceContent } from '../contracts/model-choice.js';
import {
  newDsfDialogue,
  makeDsfProfile,
  commitDsfDialogue,
  validDsfFinal,
  type DsfDialogueMemory,
  type DsfRequestProfile,
} from './dsf-dialogue.js';

/** A current public platform request, identified by its adapter rather than card text. */
export type StrategyAdministrativeRequest =
  | {
      kind: 'manual-mode-consent';
      requester: Seat;
      promptUuid: string;
      rejectActionId: string;
    }
  | {
      kind: 'manual-key-forge-consent';
      requester: Seat;
      promptUuid: string;
      rejectActionId: string;
      keyColor: KeyColor;
    };
export interface StrategyFrame {
  matchId: string;
  observation: Observation;
  /** Visible protocol qualifications, including navigation granularity and unknown fields. */
  qualifications?: string[];
  administrativeRequest?: StrategyAdministrativeRequest;
}
export interface StrategyModelReply {
  status: 'accepted' | 'rejected';
  choice?: string;
  plan?: string;
  reason: string | null;
  /** Provider-owned, credential-free receipt. No private reasoning is retained here. */
  receipt?: unknown;
}
export interface StrategyModelProvider {
  id: string;
  choose(content: ChoiceContent, profile: DsfRequestProfile): Promise<StrategyModelReply>;
}
export type StrategyMode = 'code' | 'model-all' | 'model-house';
export interface StrategyControllerOptions {
  codePolicy: string;
  /** Optional public, preloaded strategy data; never added to frames or model input. */
  strategyContext?: CodeStrategyContext;
  explorationSeed?: number;
  mode?: StrategyMode;
  model?: StrategyModelProvider;
  context?: 'independent' | 'rolling';
  loopGuard?: Omit<AILoopGuardOptions, 'onEvent'>;
  onLoopGuardEvent?: (event: LoopGuardEvent & { matchId: string }) => void;
}
export interface StrategyDecision {
  id: string;
  matchId: string;
  actor: Seat;
  revision: number;
  actionId: string;
  observationSha256: string;
  strategy: string;
  controller: 'code' | 'forced' | 'model' | 'code-fallback';
  reason: string | null;
  elapsedMs: number;
  modelReceipt?: unknown;
  /** Prepared safety override; accepted events are emitted only after platform acknowledgement. */
  loopGuard?: LoopGuardEvent;
}
interface PendingDecision {
  decision: StrategyDecision;
  frame: StrategyFrame;
  status: 'prepared' | 'dispatched';
  profile?: DsfRequestProfile;
  content?: ChoiceContent;
  answer?: string;
}
interface Slot {
  generation: number;
  snapshot?: string;
  promise?: Promise<StrategyDecision>;
  lastAcknowledgedRevision: number;
  memory: DsfDialogueMemory;
  policy: Policy;
  loopGuard: AILoopGuard;
}
export function strategyFrameHash(frame: StrategyFrame): string {
  return createHash('sha256').update(canonical(frame)).digest('hex');
}
function validateFrame(frame: StrategyFrame): void {
  const o = frame.observation;
  if (
    !frame.matchId ||
    !o ||
    ![0, 1].includes(o.you) ||
    !Number.isSafeInteger(o.revision) ||
    o.revision < 0 ||
    o.winner !== null ||
    o.activePlayer !== o.you ||
    !o.legalActions.length ||
    new Set(o.legalActions.map((a) => a.id)).size !== o.legalActions.length
  ) {
    throw Error('Invalid strategy frame');
  }
  // Current hidden hands/archives must never be copied from an authoritative server snapshot.
  const foe = o.players[o.you === 0 ? 1 : 0];
  if (foe.hand !== undefined || foe.archives !== undefined)
    throw Error('Opponent hidden zones in strategy frame');
  const request = frame.administrativeRequest;
  if (request !== undefined) {
    const pending = o.pending,
      options = pending?.options;
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) =>
          ![
            'kind',
            'requester',
            'promptUuid',
            'rejectActionId',
            ...(request.kind === 'manual-key-forge-consent' ? ['keyColor'] : []),
          ].includes(key),
      ) ||
      !['manual-mode-consent', 'manual-key-forge-consent'].includes(request.kind) ||
      (request.kind === 'manual-key-forge-consent' &&
        !['red', 'blue', 'yellow'].includes(request.keyColor)) ||
      request.requester !== (o.you === 0 ? 1 : 0) ||
      typeof request.promptUuid !== 'string' ||
      !request.promptUuid.trim() ||
      typeof request.rejectActionId !== 'string' ||
      !request.rejectActionId ||
      pending?.kind !== 'option' ||
      pending.actor !== o.you ||
      !Array.isArray(options) ||
      options.length !== 2 ||
      options.some((option) => !option || typeof option.id !== 'string' || !option.id) ||
      new Set(options.map((option) => option.id)).size !== 2 ||
      o.legalActions.length !== 2 ||
      o.legalActions.some((entry) => entry.action.kind !== 'choose') ||
      new Set(
        o.legalActions.map((entry) => (entry.action.kind === 'choose' ? entry.action.option : undefined)),
      ).size !== 2
    )
      throw Error('Invalid administrative request');
    for (const entry of o.legalActions) {
      const action = entry.action;
      const option =
        action.kind === 'choose' ? options.find((candidate) => candidate.id === action.option) : undefined;
      if (!option || option.label !== (entry.id === request.rejectActionId ? 'No' : 'Yes'))
        throw Error('Invalid administrative request');
    }
    if (!o.legalActions.some((entry) => entry.id === request.rejectActionId))
      throw Error('Invalid administrative request');
  }
}

/** Each controller owns one policy instance and isolated match/seat memories.
 * prepare is idempotent for the same frame; dispatch validates a fresh frame;
 * acknowledge commits model memory only after the platform accepted the command.
 */
export class StrategyController {
  readonly mode: StrategyMode;
  private readonly slots = new Map<string, Slot>();
  private readonly pending = new Map<string, PendingDecision>();
  private sequence = 0;
  private readonly strategyContext?: CodeStrategyContext;
  constructor(readonly options: StrategyControllerOptions) {
    this.mode = options.mode ?? 'code';
    if (!['code', 'model-all', 'model-house'].includes(this.mode)) throw Error('Unknown strategy mode');
    if (this.mode !== 'code' && !options.model) throw Error('Model strategy needs a configured provider');
    this.strategyContext = DOK_POLICY_IDS.some((id) => id === options.codePolicy)
      ? snapshotCodeStrategyContext(options.strategyContext)
      : undefined;
    createCodePolicy(options.codePolicy, options.explorationSeed ?? 1, this.strategyContext); // Validate now.
  }
  private slotKey(frame: StrategyFrame): string {
    return JSON.stringify([frame.matchId, frame.observation.you]);
  }
  prepare(input: StrategyFrame): Promise<StrategyDecision> {
    validateFrame(input);
    const frame = structuredClone(input),
      o = frame.observation;
    const key = this.slotKey(frame),
      fingerprint = strategyFrameHash(frame);
    let slot = this.slots.get(key);
    if (!slot) {
      const loopGuard = new AILoopGuard({
        ...this.options.loopGuard,
        onEvent: (event) => this.options.onLoopGuardEvent?.({ ...event, matchId: frame.matchId }),
      });
      slot = {
        generation: 0,
        memory: newDsfDialogue(o.you),
        lastAcknowledgedRevision: -1,
        loopGuard,
        policy: createCodePolicy(
          this.options.codePolicy,
          this.options.explorationSeed ?? 1,
          this.strategyContext,
          { guard: loopGuard, accounting: 'acknowledged' },
        ),
      };
      this.slots.set(key, slot);
    }
    if (o.revision <= slot.lastAcknowledgedRevision) throw Error('Strategy frame was already acknowledged');
    if (slot.snapshot === fingerprint && slot.promise)
      return slot.promise.then((value) => structuredClone(value));
    const active = [...this.pending.values()].find(
      (p) => this.slotKey(p.frame) === key && p.status === 'dispatched',
    );
    if (active) throw Error('Await platform acknowledgement before another decision');
    slot.loopGuard.discardPrepared();
    slot.generation++;
    const generation = slot.generation;
    slot.snapshot = fingerprint;
    for (const [id, p] of this.pending) if (this.slotKey(p.frame) === key) this.pending.delete(id);
    const fixedSlot = slot;
    const promise = this.choose(frame, fingerprint, fixedSlot, generation)
      .then((pending) => {
        if (fixedSlot.generation !== generation) throw Error('Superseded strategy decision');
        this.pending.set(pending.decision.id, pending);
        return pending.decision;
      })
      .catch((error) => {
        if (fixedSlot.generation === generation) {
          fixedSlot.loopGuard.discardPrepared();
          fixedSlot.snapshot = undefined;
          fixedSlot.promise = undefined;
        }
        throw error;
      });
    slot.promise = promise;
    return promise.then((value) => structuredClone(value));
  }
  private async choose(
    frame: StrategyFrame,
    fingerprint: string,
    slot: Slot,
    generation: number,
  ): Promise<PendingDecision> {
    const started = performance.now(),
      o = frame.observation;
    const decision: StrategyDecision = {
      id: 'decision-' + ++this.sequence,
      matchId: frame.matchId,
      actor: o.you,
      revision: o.revision,
      observationSha256: fingerprint,
      actionId: '',
      strategy: this.mode === 'code' ? this.options.codePolicy : this.options.model!.id + '/' + this.mode,
      controller: 'code',
      reason: null,
      elapsedMs: 0,
    };
    const pending: PendingDecision = { decision, frame, status: 'prepared' };
    if (frame.administrativeRequest) {
      decision.actionId = frame.administrativeRequest.rejectActionId;
      decision.controller = 'forced';
      decision.reason =
        frame.administrativeRequest.kind === 'manual-mode-consent'
          ? 'manual-mode-request-declined-by-policy'
          : 'manual-key-forge-request-declined-by-policy';
    } else if (o.legalActions.length === 1) {
      decision.actionId = o.legalActions[0].id;
      decision.controller = 'forced';
    } else if (
      this.mode === 'code' ||
      (this.mode === 'model-house' && !o.legalActions.some((a) => a.action.kind === 'house'))
    ) {
      decision.actionId = slot.policy(o);
    } else {
      const built = buildMirrorInput(o);
      const content: ChoiceContent = {
        ...built,
        questions: { decision: { ...built.questions.decision, type: 'choice' } },
      };
      if (frame.qualifications?.length) {
        content.questions.decision.instructions +=
          ' Adapter qualifications: ' +
          JSON.stringify(frame.qualifications) +
          '. A navigation option opens a server prompt; it is not a completed game action.';
      }
      // Existing rolling history supports compact visible snapshots. Larger snapshots are still
      // sent in full; they use an independent profile and do not get truncated into the history.
      const retainable = Buffer.byteLength(JSON.stringify(content)) <= 28000;
      const profile = makeDsfProfile(
        slot.memory,
        retainable ? (this.options.context ?? 'rolling') : 'independent',
        'thinking-low',
        o.you,
        o.revision,
      );
      try {
        const reply = await this.options.model!.choose(structuredClone(content), structuredClone(profile));
        if (slot.generation !== generation) throw Error('Superseded strategy decision');
        decision.modelReceipt = reply.receipt;
        const answer = { choice: reply.choice, plan: reply.plan ?? '' };
        if (reply.status !== 'accepted') throw Error(reply.reason ?? 'provider-rejected');
        if (!validDsfFinal(answer, Object.keys(content.questions.decision.criteria), true))
          throw Error('invalid-model-choice');
        const index = Object.keys(content.questions.decision.criteria).indexOf(answer.choice);
        decision.actionId = o.legalActions[index].id;
        decision.controller = 'model';
        if (retainable) {
          pending.content = content;
          pending.profile = profile;
          pending.answer = JSON.stringify(answer);
        } else {
          decision.reason = 'full-input-without-history-retention';
        }
      } catch (error) {
        if (slot.generation !== generation) throw Error('Superseded strategy decision');
        decision.actionId = slot.policy(o);
        decision.controller = 'code-fallback';
        decision.reason = error instanceof Error ? error.message : 'provider-failure';
      }
    }
    // Administrative policy can only decline. A safety fallback must never grant consent.
    const guardObservation = frame.administrativeRequest
      ? {
          ...o,
          legalActions: o.legalActions.filter((a) => a.id === frame.administrativeRequest!.rejectActionId),
        }
      : o;
    const guarded = slot.loopGuard.select(guardObservation, decision.actionId);
    decision.actionId = guarded.actionId;
    if (guarded.intervention) {
      decision.loopGuard = guarded.intervention;
      decision.reason = [decision.reason, 'ai-loop-guard:' + guarded.intervention.reason]
        .filter(Boolean)
        .join(';');
      // Keep the original receipt for audit, but do not tell rolling dialogue that its unexecuted
      // model action happened. The next actual observation supplies the resulting state.
      pending.content = undefined;
      pending.profile = undefined;
      pending.answer = undefined;
    }
    acceptDecision(o, decision);
    decision.elapsedMs = performance.now() - started;
    return pending;
  }
  dispatch(decision: StrategyDecision, currentFrame: StrategyFrame): Command {
    const p = this.pending.get(decision.id);
    if (!p || p.status !== 'prepared' || canonical(p.decision) !== canonical(decision))
      throw Error('Unknown or already dispatched decision');
    if (strategyFrameHash(currentFrame) !== p.decision.observationSha256)
      throw Error('Stale strategy decision');
    acceptDecision(currentFrame.observation, decision);
    p.status = 'dispatched';
    return { actor: decision.actor, revision: decision.revision, actionId: decision.actionId };
  }
  acknowledge(decisionId: string, accepted: boolean): void {
    const p = this.pending.get(decisionId);
    if (!p || p.status !== 'dispatched') throw Error('No dispatched decision to acknowledge');
    const slot = this.slots.get(this.slotKey(p.frame))!;
    slot.loopGuard.acknowledge(p.decision.revision, p.decision.actionId, accepted);
    if (accepted) {
      if (p.content && p.profile && p.answer)
        slot.memory = commitDsfDialogue(slot.memory, p.profile, p.content, p.answer);
      slot.lastAcknowledgedRevision = p.decision.revision;
    }
    this.pending.delete(decisionId);
    slot.snapshot = undefined;
    slot.promise = undefined;
    slot.generation++;
  }
  discard(decisionId: string): void {
    const p = this.pending.get(decisionId);
    if (!p) return;
    if (p.status === 'dispatched') throw Error('Dispatched decision needs an explicit acknowledgement');
    this.pending.delete(decisionId);
    const slot = this.slots.get(this.slotKey(p.frame))!;
    slot.loopGuard.discardPrepared();
    slot.snapshot = undefined;
    slot.promise = undefined;
    slot.generation++;
  }
  /** Cancel unissued work for a replaced browser document without losing acknowledged
   * dialogue or the per-seat policy. A dispatched choice still requires its real outcome.
   */
  invalidatePrepared(matchId: string, actor: Seat): void {
    const key = JSON.stringify([matchId, actor]),
      slot = this.slots.get(key);
    if (!slot) return;
    for (const pending of this.pending.values())
      if (this.slotKey(pending.frame) === key && pending.status === 'dispatched')
        throw Error('Dispatched decision needs an explicit acknowledgement');
    slot.loopGuard.discardPrepared();
    slot.generation++;
    slot.snapshot = undefined;
    slot.promise = undefined;
    for (const [id, pending] of this.pending)
      if (this.slotKey(pending.frame) === key) this.pending.delete(id);
  }
  loopGuardSnapshot(matchId: string, actor: Seat): LoopGuardSnapshot | undefined {
    return this.slots.get(JSON.stringify([matchId, actor]))?.loopGuard.snapshot();
  }
  drainLoopGuardEvents(matchId: string, actor: Seat): LoopGuardEvent[] {
    return this.slots.get(JSON.stringify([matchId, actor]))?.loopGuard.drainEvents() ?? [];
  }
}
