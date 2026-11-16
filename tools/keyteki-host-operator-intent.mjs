/** Minimal management intent. No game state, credentials or bearer tokens are recorded. */
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { readRuntimeJson, writeRuntimeJson } from './keyteki-bridge-runtime.mjs';

const intentFile = (profile) => path.join(path.resolve(profile), 'operator-intent.json');
// Only this process's validated recovery transaction can extend an identity chain.
// A field supplied on a config/connection object cannot authorize an older run.
const recoveredConnections = new WeakMap();
const boundRunIds = (profile, connection) => {
  const recovered = recoveredConnections.get(connection);
  return new Set([connection?.runId, ...(recovered?.profile === path.resolve(profile) ? recovered.runIds : [])]
    .filter((runId) => /^[a-f0-9]{32}$/.test(runId ?? '')));
};

export function bindRecoveredHostConnection(profile, connection, previousHost, next, host, { readAction = ownedHostOperatorAction } = {}) {
  const reject = () => { throw Object.assign(Error('HOST_CONTROL_IDENTITY_CHANGED'), { code: 'HOST_CONTROL_IDENTITY_CHANGED' }); };
  if (typeof profile !== 'string' || !path.isAbsolute(profile) || !connection || !next ||
      previousHost?.runId !== connection.runId || !/^[a-f0-9]{32}$/.test(connection.runId ?? '') ||
      !Number.isSafeInteger(previousHost?.pid) || previousHost.pid < 1 ||
      !/^[a-f0-9]{64}$/.test(previousHost.configSha256 ?? '') ||
      host?.running !== true || ![true, false].includes(host.reused) ||
      !/^[a-f0-9]{32}$/.test(host.runId ?? '') || host.runId !== next.runId ||
      !Number.isSafeInteger(host.pid) || host.pid < 1 || host.configSha256 !== previousHost.configSha256 ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(connection.url ?? '') ||
      !/^[a-f0-9]{64}$/.test(connection.token ?? '') ||
      next.url !== connection.url || next.token !== connection.token || next.managedSessions !== true ||
      !Array.isArray(connection.participants) || !Array.isArray(next.participants) ||
      JSON.stringify([...connection.participants].sort()) !== JSON.stringify([...next.participants].sort()) ||
      (host.reused ? host.runId !== previousHost.runId || host.pid !== previousHost.pid : host.runId === previousHost.runId)) reject();
  const prior = recoveredConnections.get(connection), exactProfile = path.resolve(profile);
  if (prior && prior.profile !== exactProfile) reject();
  const actions = [readAction(profile, connection), readAction(profile, next)];
  // Another process can change the intent between these reads, even without an await.
  // A pause/stop already observed always wins over an earlier start/resume.
  if (actions.some((action) => ['pause', 'stop'].includes(action)))
    throw Object.assign(Error('OPERATOR_STOP_MUST_BE_PRESERVED'), { code: 'OPERATOR_STOP_MUST_BE_PRESERVED' });
  if (!actions.some((action) => ['start', 'resume'].includes(action)))
    throw Object.assign(Error('HOST_OPERATOR_INTENT_UNCONFIRMED'), { code: 'HOST_OPERATOR_INTENT_UNCONFIRMED' });
  const runIds = new Set([...(prior?.runIds ?? []), connection.runId]);
  const result = { pid: host.pid, runId: host.runId, configSha256: host.configSha256 };
  // No await and no operator-intent write: all rejection checks precede the in-memory commit.
  Object.assign(connection, next);
  recoveredConnections.set(connection, { profile: exactProfile, runIds });
  return result;
}

export function recordHostOperatorIntent(profile, connection, action) {
  if (
    !['start', 'stop', 'pause', 'resume'].includes(action) ||
    !/^[a-f0-9]{32}$/.test(connection?.runId ?? '')
  )
    throw Error('Invalid host operator intent');
  const value = {
    schema: 'kf-host-operator-intent-v1',
    profile: path.resolve(profile),
    runId: connection.runId,
    action,
    source: 'operator',
    intentId: randomBytes(16).toString('hex'),
    requestedAt: new Date().toISOString(),
  };
  writeRuntimeJson(intentFile(profile), value);
  return value;
}
export function hostStopWasRequested(profile, connection) {
  if (!profile) return false;
  const value = readRuntimeJson(intentFile(profile), null);
  return (
    value?.schema === 'kf-host-operator-intent-v1' &&
    value.profile === path.resolve(profile) &&
    boundRunIds(profile, connection).has(value.runId) &&
    ['stop', 'pause'].includes(value.action)
  );
}

/** Exact managed-run intent; unknown or replaced metadata is never treated as permission. */
export function ownedHostOperatorAction(profile, connection) {
  let value;
  try { value = JSON.parse(fs.readFileSync(intentFile(profile), 'utf8')); }
  catch (error) { return error.code === 'ENOENT' ? null : 'unconfirmed'; }
  if (value?.schema !== 'kf-host-operator-intent-v1' || value.profile !== path.resolve(profile) ||
      !boundRunIds(profile, connection).has(value.runId) || !['start', 'stop', 'pause', 'resume'].includes(value.action))
    return 'unconfirmed';
  return value.action;
}

/** Compare actual bytes, including a real operator action that arrives during an awaited stop. */
export function hostOperatorIntentFingerprint(profile) {
  try {
    return createHash('sha256')
      .update(fs.readFileSync(intentFile(profile)))
      .digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function automaticUnjoinedStopMatches(profile, connection, status) {
  if (!profile || !status?.automaticRetirement) return false;
  const value = readRuntimeJson(path.join(profile, 'automatic-retirement.json'), null);
  return Boolean(
    value?.schema === 'kf-automatic-unjoined-host-stop-v1' &&
      value.profile === path.resolve(profile) &&
      value.runId === connection?.runId &&
      value.retirementId === status?.automaticRetirement?.retirementId &&
      value.configSha256 === status?.configSha256 &&
      value.operatorIntentFingerprint === hostOperatorIntentFingerprint(profile) &&
      !hostStopWasRequested(profile, connection),
  );
}
