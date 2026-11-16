#!/usr/bin/env node
/** Optional real local-browser smoke. Uses fresh temporary profiles and inline HTML only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  AgentBrowser, inspectBrowserProcess, browserProcessDisposition, signalOwnedBrowser,
} from '../tools/browser-provider.mjs';
import { browserRecordPath } from '../tools/browser-paths.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keyforge-tco-browser-smoke-'));
process.env.KF_BOT_BROWSER_REGISTRY = path.join(directory, 'registry');
const profileDir = path.join(directory, 'profile');
const pool = new AgentBrowser({ keepAlive: false, cleanupOnExit: false });
const one = 'keyforge-tco-bot:smoke-one', two = 'keyforge-tco-bot:smoke-two';
let complete = false, ownedChild, childBinding, childExit, failure;
const checks = {};
async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(Error(code), { code })), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
try {
  const first = await pool.getBrowser(one, { mode: 'per-agent', profileDir, headless: true });
  await first.page.setContent('<title>local strategy smoke</title><p>Inline fixture only.</p>');
  const second = await pool.getBrowser(two, { mode: 'per-agent', profileDir, headless: true });
  await second.page.setContent('<title>second local client</title>');
  const recordPath = browserRecordPath(profileDir);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  assert.equal(first.cdpEndpoint, second.cdpEndpoint);
  assert.equal(Object.keys(record.clients).length, 2);
  assert.equal(await first.page.title(), 'local strategy smoke');
  assert.equal(await second.page.title(), 'second local client');
  checks.twoClientsShareOwnedBrowser = true;

  await pool.close(one);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(recordPath, 'utf8')).clients).length, 1);
  assert.equal(await second.page.title(), 'second local client');
  assert.equal(browserProcessDisposition(record.process, inspectBrowserProcess(record.process.pid)), 'same');
  checks.firstReleasePreservesOtherClient = true;

  await pool.close(two);
  assert.equal(fs.existsSync(recordPath), false);
  assert.equal(browserProcessDisposition(record.process, inspectBrowserProcess(record.process.pid)), 'gone');
  assert.equal(fs.existsSync(profileDir), true);
  assert.equal(fs.existsSync(recordPath + '.lock'), true);
  checks.finalReleaseConfirmsExitAndPreservesProfileLock = true;

  // Exercise the real kernel signal helper against only a child created by this test.
  ownedChild = spawn(process.execPath, ['-e', 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'inherit'] });
  childExit = once(ownedChild, 'exit');
  void childExit.catch(() => {});
  const ready = once(ownedChild.stdout, 'data');
  void ready.catch(() => {});
  await within(once(ownedChild, 'spawn'), 5000, 'SMOKE_CHILD_SPAWN_TIMEOUT');
  const observed = inspectBrowserProcess(ownedChild.pid);
  assert.equal(observed.state, 'present');
  childBinding = { pid: ownedChild.pid, startId: observed.startId, executable: observed.executable };
  await within(ready, 5000, 'SMOKE_CHILD_READY_TIMEOUT');
  assert.equal(browserProcessDisposition(childBinding, inspectBrowserProcess(childBinding.pid)), 'same');
  assert.throws(
    () => signalOwnedBrowser({ ...childBinding, startId: (BigInt(childBinding.startId) + 1n).toString() }, 'SIGTERM'),
    /BROWSER_PIDFD_IDENTITY_UNCONFIRMED/,
  );
  assert.equal(browserProcessDisposition(childBinding, inspectBrowserProcess(childBinding.pid)), 'same');
  assert.equal(signalOwnedBrowser(childBinding, 'SIGTERM'), 'sent');
  const [, signal] = await within(childExit, 5000, 'SMOKE_CHILD_EXIT_TIMEOUT');
  assert.equal(signal, 'SIGTERM');
  checks.pidfdRejectsChangedIdentityAndSignalsOwnedChild = true;
  complete = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  try { await within(pool.closeAll(), 20000, 'SMOKE_BROWSER_CLEANUP_TIMEOUT'); }
  catch (error) { errors.push(error); }
  try {
    if (childBinding) {
      const state = browserProcessDisposition(childBinding, inspectBrowserProcess(childBinding.pid));
      if (state === 'unknown') throw Error('SMOKE_CHILD_IDENTITY_UNOBSERVED');
      if (state === 'same') signalOwnedBrowser(childBinding, 'SIGTERM');
      await within(childExit, 5000, 'SMOKE_CHILD_CLEANUP_TIMEOUT');
    } else if (ownedChild?.pid && ownedChild.exitCode === null && ownedChild.signalCode === null) {
      throw Error('SMOKE_CHILD_UNBOUND');
    }
  } catch (error) { errors.push(error); }
  if (complete && !failure && !errors.length) fs.rmSync(directory, { recursive: true, force: true });
  else {
    console.error(JSON.stringify({ retainedDiagnosticDirectory: directory }));
    throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Local browser smoke failed; diagnostics retained');
  }
}
console.log(JSON.stringify({
  schema: 'keyforge-tco-browser-smoke-v1',
  result: 'passed',
  checks,
  chromiumSandbox: process.env.KF_BOT_NO_SANDBOX !== '1',
  testNavigation: 'inline HTML only',
  loginAttempts: 0,
  gamesStarted: 0,
}, null, 2));
