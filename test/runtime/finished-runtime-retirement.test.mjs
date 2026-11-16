import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordHostOperatorIntent, ownedHostOperatorAction, hostStopWasRequested, bindRecoveredHostConnection } from '../../tools/keyteki-host-operator-intent.mjs';
import { retireFinishedHumanRuntime } from '../../tools/keyteki-finished-runtime-retirement.mjs';

function fixture(t) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-finish-intent-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const config = { profile, self: { name: 'FixtureBot' }, room: { gameId: 'fixture-game' }, participants: ['FixtureBot', 'Visitor'] };
  const connection = { runId: 'a'.repeat(32), url: 'http://127.0.0.1:12345', token: 'c'.repeat(64),
    managedSessions: true, participants: ['FixtureBot', 'Visitor'] };
  const hostIdentity = { runId: connection.runId, pid: 12345, configSha256: 'd'.repeat(64) };
  const state = { fullVerified: true, finished: true, finalPublicView: { gameId: 'fixture-game', playerName: 'FixtureBot',
    started: true, winner: 'FixtureBot', players: { FixtureBot: {}, Visitor: {} } },
    roomExit: { gameId: 'fixture-game', playerName: 'FixtureBot', phase: 'left-confirmed', serverSeatAbsent: true,
      server: { gameId: 'fixture-game', playerName: 'FixtureBot', serverSeatAbsent: true, seatPresent: false,
        ownSeatPreviouslyObserved: true, source: 'removegame', ordinal: 2 } } };
  recordHostOperatorIntent(profile, connection, 'start');
  const calls = { stop: 0, release: 0, retired: 0, saves: 0 };
  const args = { config, state, connection, hostIdentity,
    stopHost: async () => { calls.stop++; recordHostOperatorIntent(profile, connection, 'stop'); return { ...hostIdentity, stopped: true }; },
    releaseBrowser: async () => { calls.release++; }, afterRetired: () => { calls.retired++; }, save: () => { calls.saves++; },
  };
  return { args, config, state, connection, hostIdentity, calls };
}

test('normal exact-game retirement tolerates only its committed stop and records completed resources', async (t) => {
  const f = fixture(t);
  await retireFinishedHumanRuntime(f.args);
  assert.equal(f.state.hostStoppedAfterFinish, true);
  assert.equal(f.state.browserLeaseReleasedAfterFinish, true);
  assert.equal(f.state.runtimeRetired, true);
  assert.equal(f.state.retirementCommit.hostRunId, f.connection.runId);
  assert.deepEqual(f.calls, { stop: 1, release: 1, retired: 1, saves: 2 });
});

for (const action of ['pause', 'stop']) test('pre-existing operator ' + action + ' precedes retirement commit', async (t) => {
  const f = fixture(t); recordHostOperatorIntent(f.config.profile, f.connection, action);
  await assert.rejects(retireFinishedHumanRuntime(f.args), { code: 'OPERATOR_PAUSE_MUST_BE_PRESERVED' });
  assert.equal(f.calls.stop, 0); assert.equal(f.calls.release, 0); assert.equal(f.state.retirementCommit, undefined);
  assert.equal(f.state.operatorPaused, true);
});

for (const stage of ['stop', 'browser']) test('disk pause during awaited ' + stage + ' remains authoritative after watchdog shutdown', async (t) => {
  const f = fixture(t);
  if (stage === 'stop') f.args.stopHost = async () => {
    f.calls.stop++; recordHostOperatorIntent(f.config.profile, f.connection, 'stop');
    await Promise.resolve(); recordHostOperatorIntent(f.config.profile, f.connection, 'pause');
    return { ...f.hostIdentity, stopped: true };
  };
  else f.args.releaseBrowser = async () => {
    f.calls.release++; await Promise.resolve(); recordHostOperatorIntent(f.config.profile, f.connection, 'pause');
  };
  await assert.rejects(retireFinishedHumanRuntime(f.args), { code: 'OPERATOR_PAUSE_MUST_BE_PRESERVED' });
  assert.equal(f.state.hostStoppedAfterFinish, true);
  assert.equal(f.state.browserLeaseReleasedAfterFinish, stage === 'browser' ? true : undefined);
  assert.equal(f.state.runtimeRetired, undefined); assert.equal(f.calls.retired, 0);
  assert.equal(f.calls.release, stage === 'browser' ? 1 : 0);
  assert.equal(fs.existsSync(f.config.profile), true);
});

for (const condition of ['foreign-run', 'malformed', 'missing', 'memory-pause', 'watchdog-pause'])
  test('post-stop retirement preserves ' + condition + ' instead of silently closing the browser', async (t) => {
    const f = fixture(t);
    let watchdogPaused = false;
    f.args.operatorPaused = () => watchdogPaused;
    f.args.stopHost = async () => {
      f.calls.stop++; recordHostOperatorIntent(f.config.profile, f.connection, 'stop');
      await Promise.resolve();
      if (condition === 'foreign-run') recordHostOperatorIntent(f.config.profile, { runId: 'b'.repeat(32) }, 'stop');
      if (condition === 'malformed') fs.writeFileSync(path.join(f.config.profile, 'operator-intent.json'), '{');
      if (condition === 'missing') fs.unlinkSync(path.join(f.config.profile, 'operator-intent.json'));
      if (condition === 'memory-pause') f.state.operatorPaused = true;
      if (condition === 'watchdog-pause') watchdogPaused = true;
      return { ...f.hostIdentity, stopped: true };
    };
    await assert.rejects(retireFinishedHumanRuntime(f.args), { code: condition.endsWith('pause') ? 'OPERATOR_PAUSE_MUST_BE_PRESERVED' : 'HOST_OPERATOR_INTENT_UNCONFIRMED' });
    assert.equal(f.state.hostStoppedAfterFinish, true); assert.equal(f.calls.release, 0);
    assert.equal(f.state.runtimeRetired, undefined);
  });

test('foreign terminal, absence, and host stop identities never release a browser', async (t) => {
  for (const changed of ['game', 'absence', 'host']) {
    const f = fixture(t);
    if (changed === 'game') f.state.finalPublicView.gameId = 'foreign-game';
    if (changed === 'absence') f.state.roomExit.server.playerName = 'Visitor';
    if (changed === 'host') f.args.stopHost = async () => ({ ...f.hostIdentity, runId: 'b'.repeat(32), stopped: true });
    await assert.rejects(retireFinishedHumanRuntime(f.args), { code: changed === 'host' ? 'FINISHED_HOST_STOP_UNCONFIRMED' : 'FINISHED_RETIREMENT_IDENTITY_UNCONFIRMED' });
    assert.equal(f.calls.release, 0); assert.equal(f.state.runtimeRetired, undefined);
  }
});

test('operator intent reader binds exact profile and run without exposing stored content', (t) => {
  const f = fixture(t);
  assert.equal(ownedHostOperatorAction(f.config.profile, f.connection), 'start');
  assert.equal(ownedHostOperatorAction(f.config.profile, { runId: 'b'.repeat(32) }), 'unconfirmed');
  const filename = path.join(f.config.profile, 'operator-intent.json');
  const value = JSON.parse(fs.readFileSync(filename)); value.profile += '-other';
  fs.writeFileSync(filename, JSON.stringify(value));
  assert.equal(ownedHostOperatorAction(f.config.profile, f.connection), 'unconfirmed');
});

function recover(f, runId, pid, reused = false) {
  const next = { ...f.connection, runId };
  const host = { running: true, reused, runId, pid, configSha256: f.hostIdentity.configSha256 };
  f.hostIdentity = bindRecoveredHostConnection(f.config.profile, f.connection, f.hostIdentity, next, host);
  f.args.hostIdentity = f.hostIdentity;
  f.args.stopHost = async () => {
    f.calls.stop++; recordHostOperatorIntent(f.config.profile, f.connection, 'stop');
    return { ...f.hostIdentity, stopped: true };
  };
}

for (const reused of [false, true]) test('verified ' + (reused ? 'reused' : 'replacement') + ' host preserves the old intent and retires its actual final identity', async (t) => {
  const f = fixture(t), intentFile = path.join(f.config.profile, 'operator-intent.json');
  const originalIntent = fs.readFileSync(intentFile, 'utf8');
  recover(f, reused ? f.connection.runId : 'b'.repeat(32), reused ? 12345 : 12346, reused);
  assert.equal(fs.readFileSync(intentFile, 'utf8'), originalIntent);
  assert.equal(ownedHostOperatorAction(f.config.profile, f.connection), 'start');
  await retireFinishedHumanRuntime(f.args);
  assert.equal(f.state.runtimeRetired, true);
  assert.equal(f.state.retirementCommit.hostRunId, f.connection.runId);
  assert.equal(f.calls.release, 1);
});

test('two verified recoveries retain the earliest run pause without trusting object-supplied histories', async (t) => {
  const f = fixture(t), firstRun = f.connection.runId;
  recover(f, 'b'.repeat(32), 12346); recover(f, 'e'.repeat(32), 12347);
  assert.equal(ownedHostOperatorAction(f.config.profile, f.connection), 'start');
  recordHostOperatorIntent(f.config.profile, { runId: firstRun }, 'pause');
  assert.equal(hostStopWasRequested(f.config.profile, f.connection), true);
  const forged = { ...f.connection, priorRunIds: [firstRun], runIds: [firstRun], recoveredRunIds: [firstRun] };
  assert.equal(ownedHostOperatorAction(f.config.profile, forged), 'unconfirmed');
  assert.equal(hostStopWasRequested(f.config.profile, forged), false);
  await assert.rejects(retireFinishedHumanRuntime(f.args), { code: 'OPERATOR_PAUSE_MUST_BE_PRESERVED' });
  assert.equal(f.calls.stop, 0); assert.equal(f.calls.release, 0);
});

for (const oldRun of [true, false]) test('late pause on the ' + (oldRun ? 'prior' : 'replacement') + ' host wins during final stop', async (t) => {
  const f = fixture(t), firstRun = f.connection.runId;
  recover(f, 'b'.repeat(32), 12346);
  f.args.stopHost = async () => {
    f.calls.stop++; recordHostOperatorIntent(f.config.profile, f.connection, 'stop');
    await Promise.resolve();
    recordHostOperatorIntent(f.config.profile, { runId: oldRun ? firstRun : f.connection.runId }, 'pause');
    return { ...f.hostIdentity, stopped: true };
  };
  await assert.rejects(retireFinishedHumanRuntime(f.args), { code: 'OPERATOR_PAUSE_MUST_BE_PRESERVED' });
  assert.equal(f.state.hostStoppedAfterFinish, true); assert.equal(f.calls.release, 0);
});

test('recovery validates every identity and retains the connection on refusal', (t) => {
  for (const fault of ['run', 'pid', 'config', 'url', 'token', 'participants', 'reused', 'profile', 'old-pause', 'new-pause']) {
    const f = fixture(t);
    recover(f, 'b'.repeat(32), 12346);
    const before = JSON.stringify(f.connection), oldIdentity = { ...f.hostIdentity };
    const next = { ...f.connection, runId: 'e'.repeat(32) };
    const host = { running: true, reused: false, runId: next.runId, pid: 12347, configSha256: f.hostIdentity.configSha256 };
    let profile = f.config.profile;
    if (fault === 'run') host.runId = 'f'.repeat(32);
    if (fault === 'pid') host.pid = 0;
    if (fault === 'config') host.configSha256 = 'f'.repeat(64);
    if (fault === 'url') next.url = 'http://127.0.0.1:54321';
    if (fault === 'token') next.token = 'f'.repeat(64);
    if (fault === 'participants') next.participants = ['FixtureBot', 'Other'];
    if (fault === 'reused') host.reused = true;
    if (fault === 'profile') profile += '-other';
    if (fault === 'old-pause') recordHostOperatorIntent(profile, { runId: 'a'.repeat(32) }, 'pause');
    if (fault === 'new-pause') recordHostOperatorIntent(profile, next, 'pause');
    assert.throws(() => bindRecoveredHostConnection(profile, f.connection, f.hostIdentity, next, host),
      fault.endsWith('pause') ? /OPERATOR_STOP_MUST_BE_PRESERVED/ : /HOST_CONTROL_IDENTITY_CHANGED/);
    assert.equal(JSON.stringify(f.connection), before); assert.deepEqual(f.hostIdentity, oldIdentity);
    recordHostOperatorIntent(f.config.profile, { runId: 'e'.repeat(32) }, 'pause');
    assert.equal(hostStopWasRequested(f.config.profile, f.connection), false);
  }
});

for (const action of ['pause', 'stop']) test('cross-process recovery readback [start, ' + action + '] never commits the new connection', (t) => {
  const f = fixture(t), before = JSON.stringify(f.connection), next = { ...f.connection, runId: 'b'.repeat(32) };
  const host = { running: true, reused: false, runId: next.runId, pid: 12346, configSha256: f.hostIdentity.configSha256 };
  const sequence = ['start', action];
  assert.throws(() => bindRecoveredHostConnection(f.config.profile, f.connection, f.hostIdentity, next, host,
    { readAction: () => sequence.shift() }), /OPERATOR_STOP_MUST_BE_PRESERVED/);
  assert.equal(sequence.length, 0); assert.equal(JSON.stringify(f.connection), before);
  recordHostOperatorIntent(f.config.profile, next, 'pause');
  assert.equal(hostStopWasRequested(f.config.profile, f.connection), false);
});
