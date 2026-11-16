#!/usr/bin/env node
/** Local lifecycle commands for one managed bridge profile. Never opens a game or sends chat. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRuntimeJson } from './keyteki-bridge-runtime.mjs';
import { recordHostOperatorIntent, hostStopWasRequested } from './keyteki-host-operator-intent.mjs';

const args = process.argv.slice(2),
  action = args[0];
const arg = (name) => {
  const i = args.indexOf('--' + name);
  return i < 0 ? undefined : args[i + 1];
};
if (!['start', 'status', 'pause', 'resume', 'stop'].includes(action) || !arg('profile'))
  throw Error('Use start --config FILE --profile DIR, or status/pause/resume/stop --profile DIR');
const profile = path.resolve(arg('profile'));
const recoveryRunId = arg('recover-from-run-id');
if (recoveryRunId !== undefined && (action !== 'start' || !/^[a-f0-9]{32}$/.test(recoveryRunId)))
  throw Error('Invalid automatic recovery run identity');
const connectionFile = path.join(profile, 'connection.json');
const connection = () => {
  const value = readRuntimeJson(connectionFile, null);
  if (!value) return null;
  const url = new URL(value.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    value.managedSessions !== true
  )
    throw Error('Invalid local managed connection record');
  return value;
};
async function request(route, body) {
  const current = connection();
  if (!current) throw Error('No managed connection record');
  const response = await fetch(current.url + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + current.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(3000),
    redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? 'Local host request failed');
  if (result.runId !== current.runId) throw Error('Managed process identity changed');
  return result;
}

if (action === 'start') {
  if (recoveryRunId && connection()?.runId !== recoveryRunId)
    throw Error('Automatic recovery run identity changed');
  const recoveryCancelled = () =>
    !!recoveryRunId &&
    (hostStopWasRequested(profile, { runId: recoveryRunId }) || hostStopWasRequested(profile, connection()));
  const assertRecoveryAllowed = () => {
    if (recoveryCancelled()) throw Error('operator-stop-requested: automatic recovery cancelled');
  };
  assertRecoveryAllowed();
  const configArgument = arg('config');
  if (!configArgument) throw Error('start requires --config');
  const configFile = path.resolve(configArgument);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const configSha256 = createHash('sha256').update(JSON.stringify(config)).digest('hex');
  let running;
  try {
    running = await request('/status');
  } catch {}
  assertRecoveryAllowed();
  if (running) {
    if (running.configSha256 !== configSha256)
      throw Error('Profile is running a different configuration; stop it before replacing the configuration');
    if (!recoveryRunId) recordHostOperatorIntent(profile, connection(), 'start');
    console.log(JSON.stringify({ running: true, reused: true, ...running }, null, 2));
  } else {
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
    const logFile = path.join(profile, 'host.log');
    const log = fs.openSync(logFile, 'a', 0o600);
    const bridge = fileURLToPath(new URL('./keyteki-browser-bridge.mjs', import.meta.url));
    const child = spawn(process.execPath, [bridge, '--config', configFile, '--profile', profile], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      detached: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    child.unref();
    const deadline = Date.now() + 20000;
    let ready;
    while (Date.now() < deadline) {
      if (recoveryCancelled()) {
        child.kill('SIGTERM');
        throw Error('operator-stop-requested: automatic recovery cancelled');
      }
      if (child.exitCode !== null) throw Error('Host exited before ready; inspect ' + logFile);
      try {
        ready = await request('/status');
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) throw Error('Host readiness not observed; inspect ' + logFile);
    if (recoveryCancelled()) {
      child.kill('SIGTERM');
      throw Error('operator-stop-requested: automatic recovery cancelled');
    }
    if (!recoveryRunId) recordHostOperatorIntent(profile, connection(), 'start');
    console.log(JSON.stringify({ running: true, reused: false, profile, connectionFile, ...ready }, null, 2));
  }
} else if (action === 'status') {
  console.log(JSON.stringify(await request('/status'), null, 2));
} else {
  if (['stop', 'pause', 'resume'].includes(action)) recordHostOperatorIntent(profile, connection(), action);
  const result = await request('/operator', { action });
  if (action === 'stop') {
    let stopped = false;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        process.kill(result.pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          stopped = true;
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(JSON.stringify({ ...result, stopped }));
    if (!stopped) process.exitCode = 1;
  } else console.log(JSON.stringify(result, null, 2));
}
