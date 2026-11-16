/** Stop only the exact host whose already-departed seat is described by the native receipt. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeRuntimeJson } from './keyteki-bridge-runtime.mjs';
import { hostOperatorIntentFingerprint, hostStopWasRequested, ownedHostOperatorAction } from './keyteki-host-operator-intent.mjs';
import { verifiedDisconnectedDeparture } from './keyteki-disconnected-exit-contract.mjs';
const fail = (code) => { throw Object.assign(Error(code), { code }); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function acceptAutomaticDisconnectedStop({ profile, runId, pid, configSha256, status, config, request }) {
  const exit = request?.departure;
  const sessions = status?.sessions;
  const expected = { origin: exit?.origin, gameId: exit?.gameId, playerName: exit?.playerName, participants: config?.participants };
  if (!profile || request?.expectedRunId !== runId || request?.expectedPid !== pid ||
      request.configSha256 !== configSha256 || !/^[a-f0-9]{32}$/.test(request.retirementId ?? '') ||
      !Array.isArray(config?.origins) || !config.origins.includes(exit?.origin) ||
      !Array.isArray(config?.players) || config.players.length !== 1 || config.players[0].name !== exit?.playerName ||
      !verifiedDisconnectedDeparture(exit, expected) || exit.binding.hostRunId !== runId ||
      exit.binding.hostPid !== pid || exit.binding.configSha256 !== configSha256 ||
      !Array.isArray(sessions) || sessions.length !== 1 ||
      !Array.isArray(status.restoredSessions) || status.restoredSessions.length ||
      status.paused || status.stopping || hostStopWasRequested(profile, { runId }) ||
      !['start', 'resume'].includes(ownedHostOperatorAction(profile, { runId })) ||
      !/^[a-f0-9]{64}$/.test(request.operatorIntentFingerprint ?? '') ||
      request.operatorIntentFingerprint !== hostOperatorIntentFingerprint(profile))
    fail('DISCONNECTED_HOST_STOP_BINDING_OR_OPERATOR_CHANGED');
  const session = sessions[0];
  if (session.origin !== exit.origin || session.gameId !== exit.gameId || session.playerName !== exit.playerName ||
      session.documentId !== exit.binding.documentId || session.ownerEpoch !== exit.binding.ownerEpoch ||
      session.sendPending != null || session.modelInFlight === true ||
      !Array.isArray(session.pendingDeliveries) || session.pendingDeliveries.length !== 0 ||
      !['waiting-for-opponent', 'waiting-for-attachment'].includes(session.status))
    fail('DISCONNECTED_HOST_SESSION_CHANGED');
  const receipt = { schema: 'kf-automatic-disconnected-host-stop-v1', profile: path.resolve(profile),
    runId, pid, configSha256, retirementId: request.retirementId,
    gameId: exit.gameId, playerName: exit.playerName, absenceOrdinal: exit.server.ordinal,
    operatorIntentFingerprint: request.operatorIntentFingerprint,
    source: 'automatic-disconnected-retirement', acceptedAt: new Date().toISOString() };
  writeRuntimeJson(path.join(profile, 'automatic-disconnected-retirement.json'), receipt);
  return receipt;
}

export async function stopDisconnectedHost(config, { expectedHost, expectedConnection, departure,
  fetcher = fetch, alive = (pid) => { try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; } }, wait = pause } = {}) {
  const connectionFile = path.join(config.profile, 'connection.json');
  const bytes = fs.readFileSync(connectionFile), connection = JSON.parse(bytes);
  const lock = JSON.parse(fs.readFileSync(path.join(config.profile, 'runtime.lock')));
  const url = new URL(connection.url);
  if (!expectedHost || !expectedConnection || connection.runId !== expectedHost.runId ||
      connection.runId !== expectedConnection.runId || connection.url !== expectedConnection.url ||
      connection.token !== expectedConnection.token || lock.runId !== expectedHost.runId ||
      lock.pid !== expectedHost.pid || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || !/^[a-f0-9]{64}$/.test(connection.token ?? '') ||
      connection.managedSessions !== true ||
      !verifiedDisconnectedDeparture(departure, { origin: config.origin, gameId: config.room.gameId,
        playerName: config.self.name, participants: config.participants }))
    fail('DISCONNECTED_HOST_IDENTITY_UNVERIFIED');
  const fingerprint = hostOperatorIntentFingerprint(config.profile);
  const unchanged = () => fs.readFileSync(connectionFile).equals(bytes) &&
    hostOperatorIntentFingerprint(config.profile) === fingerprint && !hostStopWasRequested(config.profile, connection);
  if (!/^[a-f0-9]{64}$/.test(fingerprint ?? '') || !unchanged() ||
      !['start', 'resume'].includes(ownedHostOperatorAction(config.profile, connection)))
    fail('DISCONNECTED_OPERATOR_STOP_MUST_BE_PRESERVED');
  const retirementId = randomBytes(16).toString('hex');
  const response = await fetcher(connection.url + '/operator', { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop', intent: 'automatic-disconnected-retirement',
      expectedRunId: expectedHost.runId, expectedPid: expectedHost.pid,
      configSha256: expectedHost.configSha256, retirementId, operatorIntentFingerprint: fingerprint, departure }) });
  const result = await response.json();
  if (!response.ok || result.runId !== expectedHost.runId || result.pid !== expectedHost.pid ||
      result.automaticRetirement?.retirementId !== retirementId)
    fail('DISCONNECTED_HOST_STOP_UNCONFIRMED');
  const deadline = Date.now() + 8000;
  while (alive(expectedHost.pid) && Date.now() < deadline) await wait(100);
  return { stopped: !alive(expectedHost.pid), runId: expectedHost.runId, pid: expectedHost.pid,
    retirementId, operatorIntervened: !unchanged(), operatorUnchanged: unchanged };
}
