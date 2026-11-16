/** Exact empty-host retirement. It never records a human stop or kills a process. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { readRuntimeJson, writeRuntimeJson } from './keyteki-bridge-runtime.mjs';
import { hostOperatorIntentFingerprint, hostStopWasRequested } from './keyteki-host-operator-intent.mjs';

const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Called in the authenticated host before shutdown, using that host's own runtime identity. */
export function acceptAutomaticUnjoinedStop({ profile, runId, configSha256, status, request }) {
  if (
    !profile ||
    request?.expectedRunId !== runId ||
    request?.configSha256 !== configSha256 ||
    !/^[a-f0-9]{32}$/.test(request?.retirementId ?? '') ||
    !Array.isArray(status?.sessions) ||
    status.sessions.length ||
    !Array.isArray(status.restoredSessions) ||
    status.restoredSessions.length ||
    status.paused ||
    status.stopping ||
    hostStopWasRequested(profile, { runId }) ||
    request.operatorIntentFingerprint !== hostOperatorIntentFingerprint(profile)
  )
    fail('UNJOINED_HOST_STOP_BINDING_OR_OPERATOR_CHANGED');
  const receipt = {
    schema: 'kf-automatic-unjoined-host-stop-v1',
    profile: path.resolve(profile),
    runId,
    configSha256,
    retirementId: request.retirementId,
    operatorIntentFingerprint: request.operatorIntentFingerprint,
    source: 'automatic-unjoined-retirement',
    acceptedAt: new Date().toISOString(),
  };
  writeRuntimeJson(path.join(profile, 'automatic-retirement.json'), receipt);
  return receipt;
}

export async function stopUnjoinedHost(
  config,
  {
    expectedHost,
    expectedConnection,
    fetcher = fetch,
    alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    },
  } = {},
) {
  const profile = config.profile;
  const connectionFile = path.join(profile, 'connection.json');
  const bytes = fs.readFileSync(connectionFile);
  const connection = JSON.parse(bytes);
  const lock = readRuntimeJson(path.join(profile, 'runtime.lock'));
  const bridgeConfig = JSON.parse(fs.readFileSync(path.join(config.output, 'bridge-config.json')));
  const configSha256 = createHash('sha256').update(JSON.stringify(bridgeConfig)).digest('hex');
  const url = new URL(connection.url);
  if (
    !expectedHost ||
    !expectedConnection ||
    expectedHost.runId !== connection.runId ||
    expectedConnection.runId !== expectedHost.runId ||
    expectedHost.pid !== lock?.pid ||
    expectedConnection.url !== connection.url ||
    expectedConnection.token !== connection.token ||
    expectedHost.configSha256 !== configSha256 ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/.test(connection.token ?? '') ||
    connection.managedSessions !== true ||
    lock?.runId !== connection.runId ||
    !Number.isSafeInteger(lock.pid) ||
    lock.pid <= 0
  )
    fail('UNJOINED_HOST_IDENTITY_UNVERIFIED');
  const fingerprint = hostOperatorIntentFingerprint(profile);
  const unchanged = () =>
    fs.readFileSync(connectionFile).equals(bytes) &&
    hostOperatorIntentFingerprint(profile) === fingerprint &&
    !hostStopWasRequested(profile, connection);
  if (!unchanged()) fail('UNJOINED_OPERATOR_STOP_MUST_BE_PRESERVED');
  const retirementId = randomBytes(16).toString('hex');
  const response = await fetcher(connection.url + '/operator', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'stop',
      intent: 'automatic-unjoined-retirement',
      expectedRunId: connection.runId,
      configSha256,
      retirementId,
      operatorIntentFingerprint: fingerprint,
    }),
  });
  const result = await response.json();
  if (
    !response.ok ||
    result.runId !== connection.runId ||
    result.pid !== lock.pid ||
    result.automaticRetirement?.retirementId !== retirementId
  )
    fail('UNJOINED_HOST_STOP_UNCONFIRMED');
  const deadline = Date.now() + 8000;
  while (alive(lock.pid) && Date.now() < deadline) await pause(100);
  const stopped = !alive(lock.pid);
  return {
    stopped,
    runId: connection.runId,
    pid: lock.pid,
    retirementId,
    operatorIntervened: !unchanged(),
    operatorIntentFingerprint: fingerprint,
    // Recheck synchronously at each final ownership boundary; never clear a concurrent real intent.
    operatorUnchanged: unchanged,
  };
}
