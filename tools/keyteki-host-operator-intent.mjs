/** Minimal management intent. No game state, credentials or bearer tokens are recorded. */
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { readRuntimeJson, writeRuntimeJson } from './keyteki-bridge-runtime.mjs';

const intentFile = (profile) => path.join(path.resolve(profile), 'operator-intent.json');
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
    value.runId === connection?.runId &&
    ['stop', 'pause'].includes(value.action)
  );
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
