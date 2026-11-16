/** The actual one-seat browser binding. Chat delivery failures are isolated after scope verification. */
import { fail } from './keyteki-human-config.mjs';
import { assertPublicBindingSource, publicGameFrameSummary } from './keyteki-public-browser-game.mjs';
import { validateKeytekiManagedFullState } from './keyteki-wire-session.mjs';
import { acceptManagedPublicFrame, staleManagedBridgeState } from './keyteki-public-managed-observation.mjs';

const ROUTES = new Set([
  '/attach',
  '/state',
  '/transport-resume',
  '/decision',
  '/send-intent',
  '/sent',
  '/reject',
  '/detach',
  '/transport-close',
  '/unknown',
  '/disconnect',
  '/activity',
  '/clear',
  '/status',
  '/social/next',
  '/social/send-intent',
  '/social/sent',
]);
const STATE_ROUTES = new Set(['/attach', '/state', '/transport-resume']);
const STOP_STATES = new Set(['unsupported', 'error', 'send-not-confirmed', 'send-outcome-unknown']);
const EXPECTED_FENCES = new Set(['superseded-owner', 'managed-stale-send-intent', 'managed-stale-offer']);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** No settings, bridge, traffic capture or sends. The frontend caches this constructor at load.
 * Late installation restores native first, so userscript NativeWebSocket never captures this gate.
 */
export function pendingGameSocketBootstrap(origin) {
  return `(function(){
    if(window!==window.top||location.origin!==${JSON.stringify(origin)})return;
    const key='__kfHumanSocketBootstrapV1', installed=window[key];
    if(installed){if(installed.current!==window.WebSocket)throw Error('Human socket wrapper changed');return;}
    const Native=window.WebSocket;
    const Forward=new Proxy(Native,{construct(Target,args){
      let game=false;try{game=/^\\/[^/]+\\/socket\\.io\\/?$/.test(new URL(args[0],location.href).pathname);}catch{}
      const Current=game&&window.WebSocket!==Forward?window.WebSocket:Target;
      return Reflect.construct(Current,args);
    }});
    Object.defineProperty(window,key,{configurable:true,value:{stage:'pending',current:Forward,restore(){
      if(window.WebSocket!==Forward)throw Error('Human pending socket wrapper changed');
      window.WebSocket=Native;delete window[key];
    }}});
    window.WebSocket=Forward;
  })();`;
}

/** Idempotent on the current page and safe in either Playwright addInitScript ordering on refresh. */
export function managedHumanBootstrap(origin, source) {
  return `(function(){
    if(window!==window.top||location.origin!==${JSON.stringify(origin)})return;
    const key='__kfHumanSocketBootstrapV1', prior=window[key];
    if(prior){
      if(prior.current!==window.WebSocket)throw Error('Human socket wrapper changed');
      if(prior.stage==='managed')return;
      if(prior.stage!=='pending'||typeof prior.restore!=='function')throw Error('Unknown human socket bootstrap');
      prior.restore();
    }
    ${source}
    Object.defineProperty(window,key,{configurable:true,value:{stage:'managed',current:window.WebSocket}});
  })();`;
}

export function checkBoundBridgeRequest(request, config, connection) {
  let url, data;
  if (
    !object(request) ||
    typeof request.data !== 'string' ||
    Buffer.byteLength(request.data) > 8 * 1024 * 1024
  )
    fail('BRIDGE_REQUEST_INVALID');
  try {
    url = new URL(request.url);
    data = JSON.parse(request.data);
  } catch {
    fail('BRIDGE_REQUEST_INVALID');
  }
  if (
    url.origin !== connection.url ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !ROUTES.has(url.pathname) ||
    request.method !== 'POST' ||
    request.headers?.Authorization !== 'Bearer ' + connection.token
  )
    fail('BRIDGE_REQUEST_OUTSIDE_SCOPE');
  if (
    !object(data) ||
    data.origin !== config.origin ||
    data.playerName !== config.self.name ||
    data.gameId !== config.room.gameId
  )
    fail('BRIDGE_GAME_OR_SEAT_CHANGED');
  return { route: url.pathname, data };
}

export function checkOwnFullIdentity(request, config) {
  const raw = request.fullState;
  if (
    request.nativeFullState !== true ||
    request.newEngineHandshake !== true ||
    !object(raw) ||
    raw.id !== config.room.gameId ||
    !object(raw.players) ||
    !sameNames(Object.keys(raw.players), config.participants)
  )
    fail('FIRST_NATIVE_FULL_PAIR_REQUIRED');
  const own = raw.players[config.self.name],
    deck = own?.deckData;
  if (
    own?.name !== config.self.name ||
    raw.players[config.room.opponentName]?.name !== config.room.opponentName ||
    !object(deck) ||
    Number(deck.id) !== config.self.serverDeckId ||
    deck.name !== config.self.deckName ||
    (config.self.deckSelector !== undefined && deck.uuid !== config.self.deckSelector)
  )
    fail('FIRST_NATIVE_FULL_OWN_DECK_MISMATCH');
  return raw;
}

// Diagnostics are an explicit public/operational allowlist, never a copy of a bridge
// response, a command, a transport ticket, or a player-filtered raw observation.
const diagnosticFields = (value, keys) =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const item = value?.[key];
      if (item === null || typeof item === 'boolean') return [[key, item]];
      if (typeof item === 'number' && Number.isFinite(item)) return [[key, item]];
      if (typeof item === 'string') return [[key, item.slice(0, 1024)]];
      return [];
    }),
  );
const guardLimits = (value) => diagnosticFields(value, ['repeatLimit', 'maxTurnActions', 'resolutionGrace']);
function guardEventDiagnostic(value) {
  if (!object(value)) return null;
  return {
    ...diagnosticFields(value, [
      'type',
      'version',
      'status',
      'reason',
      'outcome',
      'haltReason',
      'accounting',
      'matchId',
      'actor',
      'turn',
      'revision',
      'phase',
      'proposedActionId',
      'selectedActionId',
      'stateFingerprint',
      'repeatedActionCount',
      'acceptedTurnActions',
    ]),
    limits: guardLimits(value.limits),
    ...(object(value.publicStateCoverage)
      ? {
          publicStateCoverage: diagnosticFields(value.publicStateCoverage, [
            'turnHistoryComplete',
            'effectsComplete',
            'turnOrdinalKnown',
          ]),
        }
      : {}),
  };
}
function guardSnapshotDiagnostic(value) {
  if (!object(value)) return null;
  return {
    ...diagnosticFields(value, [
      'version',
      'actor',
      'turn',
      'lastObservedRevision',
      'acceptedTurnActions',
      'observedRevisionAcknowledgements',
      'explicitAcknowledgements',
      'trackedStateActions',
      'interventionCount',
      'haltCount',
      'eventsDropped',
    ]),
    limits: guardLimits(value.limits),
    ...(value.lastEvent ? { lastEvent: guardEventDiagnostic(value.lastEvent) } : {}),
  };
}
export function oneSeatGameplayDiagnostics(bridge) {
  const diagnostics = bridge?.diagnostics;
  return {
    schema: 'kf-keyteki-gameplay-diagnostics-v1',
    ...diagnosticFields(bridge, [
      'gameId',
      'status',
      'errorCode',
      'error',
      'ownerEpoch',
      'nodeSequence',
      'receiptOrdinal',
    ]),
    stats: diagnosticFields(bridge?.stats, [
      'states',
      'decisions',
      'commands',
      'queuedCommands',
      'acknowledged',
      'model',
      'fallbacks',
      'stale',
    ]),
    unsupported: Array.isArray(bridge?.unsupported)
      ? bridge.unsupported
          .filter((x) => typeof x === 'string')
          .slice(0, 64)
          .map((x) => x.slice(0, 1024))
      : [],
    loopGuard: guardSnapshotDiagnostic(bridge?.loopGuard),
    loopGuardEvents: Array.isArray(diagnostics?.loopGuardEvents)
      ? diagnostics.loopGuardEvents.slice(-128).map(guardEventDiagnostic).filter(Boolean)
      : [],
    loopGuardEventsDropped: Number.isSafeInteger(diagnostics?.loopGuardEventsDropped)
      ? diagnostics.loopGuardEventsDropped
      : 0,
    lastStrategyFault: object(diagnostics?.lastStrategyFault)
      ? diagnosticFields(diagnostics.lastStrategyFault, [
          'code',
          'message',
          'gameId',
          'revision',
          'turn',
          'sequence',
        ])
      : null,
    lastCommandRejection: object(diagnostics?.lastCommandRejection)
      ? diagnosticFields(diagnostics.lastCommandRejection, ['reason', 'decisionId', 'revision', 'sequence'])
      : null,
  };
}

export function createOneSeatBridgeBinding({
  page,
  config,
  connection,
  observer,
  state,
  mirror,
  hold,
  save,
  watchdog,
  onEvidence,
  fetchImpl = fetch,
}) {
  let lastBridge = null,
    ingressOrdinal = 0;
  const evidenceFailure = () => {
    state.evidenceWriteFailures = (state.evidenceWriteFailures ?? 0) + 1;
    state.lastEvidenceWriteError = 'EVIDENCE_SINK_FAILED';
    // Observation recording must not introduce a new gameplay hold or hide its own failure.
    try {
      save();
    } catch {}
  };
  const evidence = (entry) => {
    if (typeof onEvidence !== 'function') return;
    try {
      const result = onEvidence(
        structuredClone({
          schema: 'kf-one-seat-evidence-v1',
          observedAt: new Date().toISOString(),
          gameId: config.room.gameId,
          playerName: config.self.name,
          codePolicy: config.self.codePolicy,
          ...entry,
        }),
      );
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(evidenceFailure);
    } catch {
      evidenceFailure();
    }
  };
  const chatDiagnostic = (reason, status) => {
    state.chatSkipped = (state.chatSkipped ?? 0) + 1;
    state.lastChatSkip = { reason, ...(status ? { status } : {}), observedAt: new Date().toISOString() };
    save();
  };
  return async (source, request) => {
    let socialBindingVerified = false,
      authenticationFailed = false,
      boundDocument = null,
      ingressRequest = null,
      ingressPhase = 'initial-document-fence',
      ingressResult = 'exception',
      ingressReplyStatus = null;
    const ingress = (phase, result = 'pending', emit = false) => {
      if (!ingressRequest) return;
      ingressPhase = phase;
      try {
        const diagnostic = {
          schema: 'kf-one-seat-ingress-diagnostics-v1',
          ...ingressRequest,
          phase,
          result,
          ...(ingressReplyStatus === null ? {} : { replyStatus: ingressReplyStatus }),
        };
        // A late older callback must not replace the newest request's in-flight phase.
        // Existing handoff saves include this bounded snapshot; only start and terminal
        // evidence are emitted here, rather than a log row for every intermediate phase.
        if (ingressRequest.requestOrdinal === ingressOrdinal) state.ingressDiagnostics = diagnostic;
        if (emit) evidence({ type: 'ingress-diagnostics', diagnostics: diagnostic });
      } catch {
        // Diagnostics never change ownership, delivery, hold decisions or the reply.
      }
    };
    const documentFence = async () => {
      if (!boundDocument || !watchdog) return null;
      let current;
      try {
        current = await watchdog.isCurrentDocument(boundDocument);
      } catch {
        current = null;
      }
      if (current === true) return null;
      return {
        status: current === false ? 409 : 503,
        responseText: JSON.stringify({
          code: current === false ? 'superseded-owner' : 'current-document-unavailable',
        }),
      };
    };
    try {
      assertPublicBindingSource(source, { page, origin: config.origin });
      const { route, data } = checkBoundBridgeRequest(request, config, connection);
      boundDocument = data.documentId ?? data.sessionId;
      if (STATE_ROUTES.has(route)) {
        ingressRequest = {
          requestOrdinal: ++ingressOrdinal,
          ordinarySequence: Number.isSafeInteger(data.sequence) && data.sequence >= 0 ? data.sequence : null,
          route,
        };
        ingress('initial-document-fence', 'started', true);
      }
      const initialFence = await documentFence();
      if (initialFence) {
        ingressResult = initialFence.status === 503 ? 'document-unavailable' : 'superseded-owner';
        ingressReplyStatus = initialFence.status;
        return initialFence;
      }
      if (route === '/activity') {
        watchdog?.operatorPause();
        await hold('EXTERNAL_GAME_COMMAND', { operator: true });
      }
      socialBindingVerified = route.startsWith('/social/');
      if (state.held && ['/decision', '/send-intent', '/social/next', '/social/send-intent'].includes(route))
        fail('DRIVER_ALREADY_HELD');
      if (STATE_ROUTES.has(route)) {
        if (!observer.joinRequested) fail('GAME_STATE_BEFORE_EXPLICIT_JOIN');
        if (route === '/attach' || route === '/transport-resume') {
          const full = checkOwnFullIdentity(data, config);
          if (
            !observer.selection ||
            Number(observer.selection.serverDeckId) !== config.self.serverDeckId ||
            observer.selection.isStandalone !== false
          )
            fail('OWN_DECK_SELECTION_NOT_OBSERVED');
          validateKeytekiManagedFullState(mirror.root, full, {
            playerName: config.self.name,
            participants: config.participants,
          });
        } else if (!state.fullVerified) fail('FIRST_NATIVE_FULL_REQUIRED');
      }
      if (route === '/clear' && !state.finalPublicView?.winner) fail('GAME_CLEARED_BEFORE_TERMINAL_WINNER');
      ingress('host-fetch');
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.data,
        redirect: 'error',
        signal: AbortSignal.timeout(16000),
      });
      if (
        ingressRequest &&
        Number.isSafeInteger(response.status) &&
        response.status >= 100 &&
        response.status <= 599
      )
        ingressRequest.hostResponseStatus = response.status;
      authenticationFailed = [401, 403].includes(response.status);
      if (authenticationFailed) fail('HOST_AUTHENTICATION_REJECTED');
      ingress('response-body');
      const responseText = await response.text();
      ingress('response-document-fence');
      const responseFence = await documentFence();
      if (responseFence) {
        ingressResult = responseFence.status === 503 ? 'document-unavailable' : 'superseded-owner';
        ingressReplyStatus = responseFence.status;
        return responseFence;
      }
      ingress('response-body', 'validating');
      let answer;
      try {
        answer = JSON.parse(responseText);
      } catch {
        fail('HOST_NON_JSON_RESPONSE');
      }
      if (!object(answer)) fail('HOST_RESPONSE_SHAPE');
      const bridge = answer.lastState ?? (answer.status ? answer : null);
      if (response.status === 200 && STATE_ROUTES.has(route)) {
        ingress('mirror');
        const accepted = acceptManagedPublicFrame(mirror, route, data, bridge, {
          gameId: config.room.gameId,
          participants: config.participants,
          playerName: config.self.name,
        });
        if (!accepted.ignored) {
          state.fullVerified = true;
          state.finalPublicView = publicGameFrameSummary(accepted.raw, {
            gameId: config.room.gameId,
            participants: config.participants,
            playerName: config.self.name,
          });
          evidence({
            type: 'verified-public-state',
            ownerEpoch: bridge.ownerEpoch,
            nodeSequence: bridge.nodeSequence,
            publicView: state.finalPublicView,
          });
        }
      }
      if (bridge && !staleManagedBridgeState(bridge, lastBridge)) {
        ingress('publish');
        lastBridge = bridge;
        watchdog?.bridge(bridge);
        state.bridgeStatus = bridge.status;
        state.ownerEpoch = bridge.ownerEpoch;
        state.nodeSequence = bridge.nodeSequence;
        state.gameplayDiagnostics = oneSeatGameplayDiagnostics(bridge);
        if (STOP_STATES.has(bridge.status))
          state.lastGameplayFault = structuredClone(state.gameplayDiagnostics);
        evidence({ type: 'gameplay-diagnostics', diagnostics: state.gameplayDiagnostics });
        if (bridge.publicCaptureRuleContract || bridge.publicVeilRuleContract || bridge.verifiedVeilScope) {
          await hold('UNEXPECTED_RULE_CAPABILITY');
          fail('UNEXPECTED_RULE_CAPABILITY');
        }
        if (STOP_STATES.has(bridge.status))
          await hold('STRATEGY_' + bridge.status.toUpperCase().replaceAll('-', '_'));
        if (bridge.status === 'finished' && state.finalPublicView?.winner) {
          state.finished = true;
          if (!state.held) state.phase = 'finished-preserved';
        } else if (state.fullVerified && !state.held) state.phase = 'playing';
        save();
      }
      if (!response.ok) {
        if (answer.code === 'superseded-owner') watchdog?.invalidate('superseded-owner');
        if (socialBindingVerified) chatDiagnostic('HTTP_INVALIDATION_OR_SERVICE_FAILURE', response.status);
        else if (
          !EXPECTED_FENCES.has(answer.code) &&
          !(
            route === '/sent' &&
            data.receiptOnly === true &&
            answer.code === 'managed-observed-receipt-unavailable'
          )
        )
          await hold('HOST_REQUEST_REJECTED');
      }
      ingressPhase = 'return';
      ingressResult = response.ok ? 'returned' : 'http-rejected';
      ingressReplyStatus =
        Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599
          ? response.status
          : null;
      return { status: response.status, responseText };
    } catch (error) {
      ingress(ingressPhase, 'exception');
      const errorFence = await documentFence();
      if (errorFence) {
        ingressResult = errorFence.status === 503 ? 'error-document-unavailable' : 'error-superseded-owner';
        ingressReplyStatus = errorFence.status;
        return errorFence;
      }
      if (!socialBindingVerified || authenticationFailed) {
        if (
          authenticationFailed ||
          /SCOPE|CHANGED|MISMATCH|REQUIRED|INVALID|CAPABILITY|UNVERIFIED/.test(error?.code ?? '')
        )
          watchdog?.invalidate(error?.code ?? 'binding-invalid');
        await hold(error?.code ?? 'OWN_BRIDGE_CALLBACK_FAILED');
        throw Error('One-seat controller is held; inspect its local handoff record');
      }
      chatDiagnostic('CHAT_RESPONSE_OR_TRANSPORT_UNAVAILABLE');
      throw Error('Chat delivery skipped; gameplay remains independent');
    } finally {
      ingress(ingressPhase, ingressResult, true);
    }
  };
}
