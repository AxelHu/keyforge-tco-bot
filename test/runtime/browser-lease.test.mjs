import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inspectBrowserProcess,
  browserProcessDisposition,
  validateBrowserLease,
  retainBrowserClients,
  signalOwnedBrowser,
  browserExecutable,
} from '../../tools/browser-provider.mjs';
import {
  browserRegistryRoot,
  browserRecordPath,
  humanBrowserAgentId,
  campaignAccountLockRoot,
} from '../../tools/browser-paths.mjs';

const binding = { pid: 42, startId: '12345', executable: '/virtual/chromium' };
const stat = (state = 'S', startId = '12345') =>
  '42 (chrome (worker)) ' + [state, ...Array(18).fill('0'), startId].join(' ');
test('process observation preserves unknown and missing identity as different outcomes', () => {
  const readLink = () => '/virtual/chromium';
  const observed = inspectBrowserProcess(42, { readFile: () => stat(), readLink });
  assert.equal(browserProcessDisposition(binding, observed), 'same');
  assert.equal(
    browserProcessDisposition(
      binding,
      inspectBrowserProcess(42, { readFile: () => stat('S', '999'), readLink }),
    ),
    'gone',
  );
  assert.equal(
    browserProcessDisposition(
      binding,
      inspectBrowserProcess(42, {
        readFile: () => {
          throw Object.assign(Error(), { code: 'EACCES' });
        },
        readLink,
      }),
    ),
    'unknown',
  );
  assert.equal(
    browserProcessDisposition(
      binding,
      inspectBrowserProcess(42, {
        readFile: () => {
          throw Object.assign(Error(), { code: 'ENOENT' });
        },
        readLink,
      }),
    ),
    'gone',
  );
  assert.equal(
    browserProcessDisposition(
      binding,
      inspectBrowserProcess(42, {
        readFile: () => stat(),
        readLink: () => {
          throw Error();
        },
      }),
    ),
    'unknown',
  );
  assert.equal(
    browserProcessDisposition(binding, inspectBrowserProcess(42, { readFile: () => 'invalid', readLink })),
    'unknown',
  );
});
test('unknown clients are retained while proved absent or reused identities can be removed', () => {
  const clients = {
    unknown: { pid: 1, startId: '10' },
    absent: { pid: 2, startId: '20' },
    reused: { pid: 3, startId: '30' },
    live: { pid: 4, startId: '40' },
  };
  const states = {
    1: { state: 'unknown' },
    2: { state: 'absent' },
    3: { state: 'present', startId: '31' },
    4: { state: 'present', startId: '40' },
  };
  assert.deepEqual(Object.keys(retainBrowserClients(clients, (pid) => states[pid])).sort(), [
    'live',
    'unknown',
  ]);
});
test('lease release cannot select another profile, endpoint or client identity', () => {
  const record = {
    version: 2,
    managed: true,
    profileDir: '/virtual/profile',
    endpoint: 'ws://127.0.0.1:9000/devtools/browser/example',
    process: binding,
    clients: { one: { agentId: 'keyforge-tco-bot:human-demo', pid: 7 } },
  };
  const expected = {
    profileDir: record.profileDir,
    endpoint: record.endpoint,
    clientId: 'one',
    agentId: 'keyforge-tco-bot:human-demo',
    clientPid: 7,
  };
  assert.equal(validateBrowserLease(record, expected), record);
  for (const mutation of [
    { profileDir: '/virtual/foreign' },
    { endpoint: 'ws://127.0.0.1:9001/devtools/browser/example' },
    { clientId: 'foreign' },
    { clientPid: 8 },
    { agentId: 'another' },
  ])
    assert.throws(() => validateBrowserLease(record, { ...expected, ...mutation }));
  assert.throws(() => validateBrowserLease({ ...record, managed: false }, expected));
});
test('owned signals use a kernel pidfd and do not downgrade on an unavailable or mismatched identity', () => {
  let call;
  assert.equal(
    signalOwnedBrowser(binding, 'SIGTERM', {
      execute: (...args) => {
        call = args;
        return '{"state":"sent"}';
      },
    }),
    'sent',
  );
  assert.equal(call[0], 'python3');
  assert.deepEqual(call[1].slice(-4), ['42', '12345', '/virtual/chromium', 'SIGTERM']);
  assert.match(call[1][1], /os\.pidfd_open/);
  assert.match(call[1][1], /signal\.pidfd_send_signal/);
  assert.ok(call[1][1].indexOf('os.pidfd_open') < call[1][1].indexOf("text=open('/proc/"));
  for (const state of ['binding-changed', 'unobserved'])
    assert.throws(
      () => signalOwnedBrowser(binding, 'SIGTERM', { execute: () => JSON.stringify({ state }) }),
      /PIDFD_IDENTITY_UNCONFIRMED/,
    );
  assert.throws(
    () =>
      signalOwnedBrowser(binding, 'SIGTERM', {
        execute: () => {
          throw Error();
        },
      }),
    /PIDFD_SIGNAL_UNAVAILABLE/,
  );
  assert.throws(
    () =>
      signalOwnedBrowser({ ...binding, startId: null }, 'SIGTERM', {
        execute: () => {
          assert.fail('must not execute');
        },
      }),
    /SIGNAL_BINDING_INVALID/,
  );
});
test('launcher and recovery use one package registry and namespace', () => {
  assert.equal(
    browserRegistryRoot({}, '/virtual/home'),
    '/virtual/home/.cache/keyforge-tco-bot/browsers/.registry-v2',
  );
  assert.equal(
    browserRegistryRoot({ KF_BOT_BROWSER_REGISTRY: '/virtual/registry' }, '/virtual/home'),
    '/virtual/registry',
  );
  assert.ok(
    browserRecordPath('/virtual/profile', {}, '/virtual/home').startsWith(
      browserRegistryRoot({}, '/virtual/home') + '/',
    ),
  );
  assert.equal(humanBrowserAgentId('/virtual/output/attempt-1'), 'keyforge-tco-bot:human-attempt-1');
  assert.equal(campaignAccountLockRoot('/virtual/home'), '/virtual/home/.cache/keyforge-tco-bot/accounts');
});
test('a shell wrapper is rejected before any browser spawn', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-binary-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const wrapper = path.join(directory, 'wrapper');
  fs.writeFileSync(wrapper, '#!/bin/sh\nexit 0\n');
  assert.throws(() => browserExecutable({ chromePath: wrapper }, {}), /DIRECT_CHROMIUM_BINARY_REQUIRED/);
  const binary = path.join(directory, 'binary');
  fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0]));
  assert.equal(browserExecutable({ chromePath: binary }, {}), binary);
});
