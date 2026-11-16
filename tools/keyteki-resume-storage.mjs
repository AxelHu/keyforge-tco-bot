#!/usr/bin/env node
/** Explicit storage-only checkpoint recovery. Never starts a service, browser, lobby probe or game. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserRegistryRoot, humanBrowserAgentId, campaignAccountLockRoot } from './browser-paths.mjs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeCampaignConfig, verifyCampaignRuntime, campaignSummary } from './keyteki-live-campaign.mjs';
import {
  campaignHealth,
  classifyCampaignAttempt,
  focusedCampaignProgress,
} from './keyteki-live-campaign-policy.mjs';
import { normalizeHumanConfig, REPO_ROOT } from './keyteki-human-config.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const requireThat = (ok, code) => {
  if (!ok) throw Object.assign(Error(code), { code });
};
const sourceNames = [
  'tools/keyteki-resume-storage.mjs',
  'tools/keyteki-live-campaign.mjs',
  'tools/keyteki-live-campaign-policy.mjs',
  'tools/keyteki-human-config.mjs',
  'tools/keyteki-fuzhou-ui.mjs',
  'tools/keyteki-human-watchdog.mjs',
  'tools/keyteki-joined-pending-exit.mjs',
  'tools/keyteki-unjoined-reconciliation-contract.mjs',
  'tools/keyteki-live-lobby.mjs',
];
function bytes(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    requireThat(
      stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
      'STORAGE_RESUME_SOURCE_NOT_REGULAR',
    );
    return fs.readFileSync(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}
const digest = (file) => {
  const value = bytes(file, true);
  return value === null ? null : sha(value);
};
const read = (file) => JSON.parse(bytes(file));
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomic(file, value) {
  const temp = file + '.storage-resume-' + randomUUID() + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function immutable(file, value) {
  value = Buffer.isBuffer(value) ? value : jsonBytes(value);
  const before = bytes(file, true);
  if (before !== null) {
    requireThat(before.equals(value), 'STORAGE_RESUME_ARCHIVE_CHANGED');
    return;
  }
  const temp = file + '.stage-' + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // All writers hold the same owner locks. Recheck an existing immutable name before publishing.
    const appeared = bytes(file, true);
    if (appeared !== null) requireThat(appeared.equals(value), 'STORAGE_RESUME_ARCHIVE_CHANGED');
    else fs.renameSync(temp, file);
    syncDirectory(path.dirname(file));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function lockIdentity(file) {
  const stat = fs.lstatSync(file);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'STORAGE_RESUME_LOCK_NOT_REGULAR');
  return { file, dev: stat.dev, ino: stat.ino };
}
/** flock is inherited through the open file description; retain that descriptor, never replace a lease. */
function lockExisting(binding) {
  requireThat(same(lockIdentity(binding.file), binding), 'STORAGE_RESUME_LOCK_CHANGED');
  const fd = fs.openSync(binding.file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(fd);
  if (stat.dev !== binding.dev || stat.ino !== binding.ino || stat.nlink !== 1) {
    fs.closeSync(fd);
    requireThat(false, 'STORAGE_RESUME_LOCK_CHANGED');
  }
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 },
  );
  if (result.status !== 0) {
    fs.closeSync(fd);
    requireThat(false, 'STORAGE_RESUME_OWNER_LOCK_BUSY_OR_UNAVAILABLE');
  }
  return () => fs.closeSync(fd);
}
function processGone(pid) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'STORAGE_RESUME_PID_INVALID');
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
    throw error;
  }
}
const registryRoot = browserRegistryRoot;
const safetyFields = [
  'identityValid',
  'operatorPaused',
  'seatReleased',
  'runtimeRetired',
  'canContinue',
  'finalized',
  'awaitingDriverExit',
  'continuationBlock',
  'started',
  'terminal',
  'natural',
  'technicalFailure',
  'technicalReasons',
  'opponentName',
  'winner',
  'won',
  'keys',
  'outcome',
];

/** Only existing finalized evidence is read; no policy decisions or native/network probes occur. */
function target(configFile, options = {}, originals = {}) {
  const sources = {};
  const get = (key, file, optional = false) => {
    const value = originals[key] ?? bytes(file, optional);
    sources[key] = { file, sha256: value === null ? null : sha(value) };
    return value;
  };
  const input = JSON.parse(get('config', configFile)),
    config = normalizeCampaignConfig(input);
  requireThat(fs.realpathSync(config.output) === config.output, 'STORAGE_RESUME_OUTPUT_PATH');
  const state = JSON.parse(get('checkpoint', path.join(config.output, 'checkpoint.json')));
  const summary = JSON.parse(get('summary', path.join(config.output, 'summary.json')));
  const control = JSON.parse(get('control', path.join(config.output, 'control.json')));
  requireThat(
    state.schema === 'keyteki-live-campaign-state-v1' &&
      state.id === config.id &&
      state.configSha256 === sha(JSON.stringify(input)) &&
      Array.isArray(state.records),
    'STORAGE_RESUME_CONFIG_BINDING',
  );
  requireThat(
    state.paused === true &&
      state.phase === 'paused' &&
      same(state.pauseReasons, ['storage-floor']) &&
      state.activeAttempt === null,
    'STORAGE_RESUME_EXACT_STORAGE_PAUSE_REQUIRED',
  );
  requireThat(
    control.unattendedEnabled === true && control.pauseAfterCurrent === false,
    'STORAGE_RESUME_CONTROL_INTENT_REQUIRED',
  );
  const health = campaignHealth(state.records),
    focus = focusedCampaignProgress(state.records, config);
  requireThat(health.pause === false && same(state.health, health), 'STORAGE_RESUME_HEALTH_BLOCKED');
  requireThat(
    !state.completion && !focus?.targetReached && same(state.focus, focus),
    'STORAGE_RESUME_CAMPAIGN_COMPLETED_OR_FOCUS_CHANGED',
  );
  requireThat(same(summary, campaignSummary(config, state)), 'STORAGE_RESUME_SUMMARY_BINDING');
  requireThat(
    state.storageRecoveries === undefined || Array.isArray(state.storageRecoveries),
    'STORAGE_RESUME_HISTORY_INVALID',
  );
  const manifest = JSON.parse(get('manifest', config.runtimeManifest));
  requireThat(path.isAbsolute(manifest.root ?? ''), 'STORAGE_RESUME_TARGET_RUNTIME_ROOT');
  const runtime = (options.verifyRuntime ?? verifyCampaignRuntime)(config, { root: manifest.root });
  requireThat(
    state.runtime?.manifestSha256 === config.runtimeManifestSha256 &&
      state.runtime.sourceCommit === runtime.sourceCommit,
    'STORAGE_RESUME_RUNTIME_BINDING',
  );
  const tool = {
    root: REPO_ROOT,
    nodeVersion: process.version,
    files: sourceNames.map((file) => ({ path: file, sha256: digest(path.join(REPO_ROOT, file)) })),
  };
  const frozen = new Map(manifest.files.map((row) => [row.path, row.sha256]));
  requireThat(
    tool.files.slice(1).every((row) => frozen.get(row.path) === row.sha256),
    'STORAGE_RESUME_VALIDATOR_RUNTIME_MISMATCH',
  );
  const accountRoot = options.accountRoot ?? campaignAccountLockRoot();
  const accountStem = path.join(accountRoot, sha(config.origin + '\n' + config.selfName));
  const account = JSON.parse(get('account', accountStem + '.json'));
  requireThat(
    account.origin === config.origin &&
      account.selfName === config.selfName &&
      account.output === config.output &&
      account.pid === state.pid,
    'STORAGE_RESUME_ACCOUNT_BINDING',
  );
  const locks = [lockIdentity(accountStem + '.lock')],
    processes = [{ role: 'parent', pid: state.pid }];
  const seen = new Set();
  for (const row of state.records) {
    requireThat(
      /^\d{5}-(join|create)$/.test(row.attemptId ?? '') && !seen.has(row.attemptId),
      'STORAGE_RESUME_RECORD_ID',
    );
    seen.add(row.attemptId);
    requireThat(
      row.finalized === true &&
        row.identityValid === true &&
        row.seatReleased === true &&
        row.runtimeRetired === true &&
        row.canContinue === true &&
        row.operatorPaused === false &&
        row.awaitingDriverExit === false &&
        row.continuationBlock === null &&
        row.selfName === config.selfName &&
        row.runtimeManifestSha256 === config.runtimeManifestSha256 &&
        row.codePolicy === config.seat.self.codePolicy,
      'STORAGE_RESUME_UNSAFE_RECORD',
    );
    const run = path.join(config.output, 'runs', row.attemptId),
      prefix = row.attemptId + ':';
    requireThat(row.output === run && fs.realpathSync(run) === run, 'STORAGE_RESUME_ATTEMPT_PATH');
    requireThat(
      same(row, JSON.parse(get(prefix + 'result', path.join(config.output, row.attemptId + '-result.json')))),
      'STORAGE_RESUME_RESULT_CHANGED',
    );
    const attemptInput = JSON.parse(
      get(prefix + 'attempt', path.join(config.output, row.attemptId + '.json')),
    );
    const seat = normalizeHumanConfig(attemptInput, { createPublic: row.entry === 'create' });
    requireThat(
      same(attemptInput, { ...config.seat, output: run, room: attemptInput.room }) &&
        row.entry === row.attemptId.split('-')[1] &&
        (row.entry !== 'join' ||
          (seat.room.gameId === row.gameId && seat.room.opponentName === row.opponentName)),
      'STORAGE_RESUME_ATTEMPT_CONFIG_CHANGED',
    );
    const handoff = JSON.parse(get(prefix + 'handoff', path.join(run, 'handoff.json')));
    requireThat(
      handoff.gameId === row.gameId &&
        handoff.codePolicy === row.codePolicy &&
        handoff.hostProfile === seat.profile &&
        handoff.browserProfile === seat.browserProfile &&
        handoff.agentId === humanBrowserAgentId(row.attemptId) &&
        handoff.runtimeRetired === true &&
        !handoff.finishRetirementError,
      'STORAGE_RESUME_RETIREMENT_BINDING',
    );
    const noOpponentBytes = get(prefix + 'noOpponent', path.join(run, 'no-opponent.json'), true);
    const watchdogBytes = get(prefix + 'watchdog', path.join(run, 'watchdog-events.jsonl'), true);
    // OS exit status was not persisted. Native terminal retirement can be verified with unknown exit status;
    // nonterminal paths requiring a known clean exit must fail closed.
    const classified = classifyCampaignAttempt({
      handoff,
      selfName: config.selfName,
      origin: config.origin,
      expectedGameId: row.gameId,
      exitCode: null,
      attemptId: row.attemptId,
      noOpponent: noOpponentBytes === null ? null : JSON.parse(noOpponentBytes),
      watchdogEvents:
        watchdogBytes === null
          ? []
          : watchdogBytes.toString('utf8').split('\n').filter(Boolean).map(JSON.parse),
    });
    requireThat(
      safetyFields.every((key) => same(row[key], classified[key])),
      'STORAGE_RESUME_RETIREMENT_NOT_VERIFIED',
    );
    const hostLock = JSON.parse(get(prefix + 'hostLock', path.join(seat.profile, 'runtime.lock')));
    const connection = JSON.parse(get(prefix + 'connection', path.join(seat.profile, 'connection.json')));
    requireThat(
      hostLock.runId === connection.runId &&
        typeof hostLock.runId === 'string' &&
        connection.managedSessions === true &&
        same(connection.participants, handoff.participants),
      'STORAGE_RESUME_HOST_BINDING',
    );
    const browser = path.join(
      options.registryRoot ?? registryRoot(),
      sha('profile:' + fs.realpathSync(seat.browserProfile)) + '.json',
    );
    requireThat(get(prefix + 'browser', browser, true) === null, 'STORAGE_RESUME_BROWSER_NOT_RELEASED');
    locks.push(lockIdentity(path.join(seat.profile, 'runtime.lock')), lockIdentity(browser + '.lock'));
    processes.push(
      { role: row.attemptId + ':driver', pid: handoff.driverPid },
      { role: row.attemptId + ':host', pid: hostLock.pid },
    );
  }
  return {
    config,
    state,
    summary,
    health,
    runtime: { root: manifest.root, ...runtime },
    sources,
    locks,
    processes,
    tool,
    recordsSha256: sha(JSON.stringify(state.records)),
  };
}
function assertSources(t, expected) {
  for (const [key, binding] of Object.entries(t.sources))
    requireThat(
      (expected[key] ?? [binding.sha256]).includes(digest(binding.file)),
      'STORAGE_RESUME_SOURCE_CHANGED_' + key.toUpperCase(),
    );
  for (const binding of t.locks)
    requireThat(same(lockIdentity(binding.file), binding), 'STORAGE_RESUME_LOCK_CHANGED');
}
function verifyAgain(t, options) {
  const runtime = (options.verifyRuntime ?? verifyCampaignRuntime)(t.config, { root: t.runtime.root });
  requireThat(
    runtime.sourceCommit === t.runtime.sourceCommit && runtime.manifestSha256 === t.runtime.manifestSha256,
    'STORAGE_RESUME_RUNTIME_BINDING',
  );
  requireThat(
    t.tool.files.every((row) => digest(path.join(REPO_ROOT, row.path)) === row.sha256),
    'STORAGE_RESUME_TOOL_CHANGED',
  );
  const checkedAt = new Date().toISOString();
  const processes = t.processes.map((row) => {
    requireThat((options.processGone ?? processGone)(row.pid), 'STORAGE_RESUME_PROCESS_STILL_LIVE');
    return { ...row, exited: true };
  });
  return { checkedAt, processes, locks: t.locks };
}
function storage(t, options) {
  const stat = (options.statfs ?? fs.statfsSync)(t.config.output, { bigint: true });
  const available = BigInt(stat.bavail) * BigInt(stat.bsize),
    minimum = BigInt(t.config.minimumFreeBytes);
  requireThat(available >= minimum, 'STORAGE_RESUME_STORAGE_FLOOR');
  return {
    checkedAt: new Date().toISOString(),
    path: t.config.output,
    availableBytes: available.toString(),
    minimumFreeBytes: minimum.toString(),
    basis: 'statfs.bavail * statfs.bsize',
  };
}

/** The sole permitted state transition, also used to validate every archived candidate byte. */
function expectedPayloads(t, request, requestSha256, transactionDir, now) {
  const history = {
    id: request.id,
    action: request.action,
    requestSha256,
    checkedAt: now,
    previousPauseReasons: t.state.pauseReasons,
    previousCheckpointSha256: t.sources.checkpoint.sha256,
    recordsSha256: t.recordsSha256,
    recordCount: t.state.records.length,
    transactionDir,
  };
  const state = {
    ...t.state,
    paused: false,
    pauseReasons: [],
    phase: 'ready-after-storage-recovery',
    updatedAt: now,
    storageRecoveries: [...(t.state.storageRecoveries ?? []), history],
  };
  return {
    summary: jsonBytes({
      ...t.summary,
      paused: false,
      pauseReasons: [],
      phase: state.phase,
      updatedAt: now,
    }),
    checkpoint: jsonBytes(state),
  };
}

/** Read-only preparation returns an explicit request; it is not a storage or launch authorization. */
export function prepareStorageResumeRequest(configFile, options = {}) {
  configFile = path.resolve(configFile);
  const t = target(configFile, options);
  return {
    schema: 'kf-storage-resume-request-v1',
    action: 'resume-storage-floor',
    id: randomUUID(),
    preparedAt: new Date().toISOString(),
    configFile,
    campaignId: t.config.id,
    configSha256: t.state.configSha256,
    output: t.config.output,
    runtime: {
      root: t.runtime.root,
      sourceCommit: t.runtime.sourceCommit,
      manifestSha256: t.runtime.manifestSha256,
    },
    minimumFreeBytes: t.config.minimumFreeBytes,
    recordsSha256: t.recordsSha256,
    recordCount: t.state.records.length,
    health: t.health,
    sources: t.sources,
    locks: t.locks,
    tool: t.tool,
  };
}

/** Checkpoint is the commit point. A repeated request only verifies history; it never grants new launch permission. */
export function resumeStorageCampaign(configFile, requestFile, options = {}) {
  configFile = path.resolve(configFile);
  requestFile = path.resolve(requestFile);
  const requestBytes = bytes(requestFile),
    request = JSON.parse(requestBytes),
    requestSha256 = sha(requestBytes);
  requireThat(
    request.schema === 'kf-storage-resume-request-v1' &&
      request.action === 'resume-storage-floor' &&
      /^[a-f0-9-]{36}$/.test(request.id ?? '') &&
      request.configFile === configFile,
    'STORAGE_RESUME_EXPLICIT_REQUEST_REQUIRED',
  );
  const config = normalizeCampaignConfig(read(configFile));
  requireThat(request.output === config.output, 'STORAGE_RESUME_REQUEST_OUTPUT_CHANGED');
  const transactionDir = path.join(config.output, 'storage-recoveries', request.id),
    transactionFile = path.join(transactionDir, 'transaction.json');
  let journal = fs.existsSync(transactionFile) ? read(transactionFile) : null;
  const originals = {};
  if (journal) {
    requireThat(
      journal.schema === 'kf-storage-resume-transaction-v1' &&
        journal.requestSha256 === requestSha256 &&
        journal.configFile === configFile &&
        Array.isArray(journal.generations) &&
        journal.generations.length > 0 &&
        digest(path.join(transactionDir, 'request.json')) === requestSha256,
      'STORAGE_RESUME_TRANSACTION_CHANGED',
    );
    for (const key of ['checkpoint', 'summary']) {
      originals[key] = bytes(path.join(transactionDir, 'before-' + key + '.json'));
      requireThat(sha(originals[key]) === request.sources[key]?.sha256, 'STORAGE_RESUME_ARCHIVE_CHANGED');
    }
  }
  const t = target(configFile, options, originals);
  requireThat(
    request.campaignId === config.id &&
      request.configSha256 === t.state.configSha256 &&
      request.minimumFreeBytes === config.minimumFreeBytes &&
      request.recordsSha256 === t.recordsSha256 &&
      request.recordCount === t.state.records.length &&
      same(request.health, t.health) &&
      same(request.sources, t.sources) &&
      same(request.locks, t.locks) &&
      same(request.tool, t.tool) &&
      same(request.runtime, {
        root: t.runtime.root,
        sourceCommit: t.runtime.sourceCommit,
        manifestSha256: t.runtime.manifestSha256,
      }),
    'STORAGE_RESUME_REQUEST_BINDING_CHANGED',
  );
  if (journal)
    requireThat(
      same(journal.before, t.sources) &&
        journal.recordsSha256 === t.recordsSha256 &&
        journal.recordCount === t.state.records.length &&
        same(journal.health, t.health),
      'STORAGE_RESUME_TRANSACTION_METADATA_CHANGED',
    );
  const allowed = Object.fromEntries(Object.entries(t.sources).map(([key, row]) => [key, [row.sha256]]));
  for (const generation of journal?.generations ?? []) {
    requireThat(
      same(Object.keys(generation.after).sort(), ['checkpoint', 'summary']),
      'STORAGE_RESUME_STAGE_KEYS_CHANGED',
    );
    const expected = expectedPayloads(t, request, requestSha256, transactionDir, generation.preparedAt);
    for (const [key, item] of Object.entries(generation.after)) {
      requireThat(
        path.basename(item.filename) === item.filename &&
          digest(path.join(transactionDir, item.filename)) === item.sha256,
        'STORAGE_RESUME_STAGE_CHANGED',
      );
      requireThat(
        sha(expected[key]) === item.sha256 &&
          bytes(path.join(transactionDir, item.filename)).equals(expected[key]),
        'STORAGE_RESUME_STAGE_PAYLOAD_CHANGED',
      );
      allowed[key].push(item.sha256);
    }
  }
  const release = [];
  try {
    for (const binding of t.locks) release.push((options.lock ?? lockExisting)(binding));
    requireThat(digest(requestFile) === requestSha256, 'STORAGE_RESUME_REQUEST_CHANGED');
    if (journal) {
      const current = read(t.sources.checkpoint.file),
        applied = current.storageRecoveries?.find((row) => row.id === request.id);
      if (applied) {
        const latest = journal.generations.at(-1),
          committed = read(path.join(transactionDir, latest.after.checkpoint.filename));
        requireThat(
          digest(t.sources.checkpoint.file) === latest.after.checkpoint.sha256 &&
            digest(t.sources.summary.file) === latest.after.summary.sha256 &&
            same(applied, committed.storageRecoveries.at(-1)),
          'STORAGE_RESUME_APPLIED_CHECKPOINT_CHANGED',
        );
        assertSources(t, {
          ...allowed,
          checkpoint: [latest.after.checkpoint.sha256],
          summary: [latest.after.summary.sha256],
        });
        if (journal.phase !== 'committed')
          atomic(
            transactionFile,
            jsonBytes({
              ...journal,
              phase: 'committed',
              committedAt: new Date().toISOString(),
              commitMarkerRecovered: true,
              finalStorageSampleRecovered: Boolean(latest.commitStorage),
            }),
          );
        return {
          applied: true,
          alreadyApplied: true,
          historicalVerificationOnly: true,
          launchAuthorized: false,
          transactionDir,
        };
      }
      requireThat(journal.phase !== 'committed', 'STORAGE_RESUME_COMMITTED_CHECKPOINT_CHANGED');
      // Before the commit point only the summary may have changed; an unfamiliar checkpoint is never overwritten.
      allowed.checkpoint = [t.sources.checkpoint.sha256];
    }
    assertSources(t, allowed);
    const observed = Object.fromEntries(
      Object.entries(t.sources).map(([key, row]) => [key, [digest(row.file)]]),
    );
    const retirement = verifyAgain(t, options),
      firstStorage = storage(t, options);
    assertSources(t, observed);
    const now = new Date().toISOString(),
      payloads = expectedPayloads(t, request, requestSha256, transactionDir, now);
    fs.mkdirSync(path.dirname(transactionDir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
    requireThat(fs.realpathSync(transactionDir) === transactionDir, 'STORAGE_RESUME_TRANSACTION_PATH');
    immutable(path.join(transactionDir, 'request.json'), requestBytes);
    for (const key of ['checkpoint', 'summary'])
      immutable(
        path.join(transactionDir, 'before-' + key + '.json'),
        originals[key] ?? bytes(t.sources[key].file),
      );
    if (!journal)
      journal = {
        schema: 'kf-storage-resume-transaction-v1',
        requestSha256,
        configFile,
        before: t.sources,
        recordsSha256: t.recordsSha256,
        recordCount: t.state.records.length,
        health: t.health,
        generations: [],
      };
    const number = journal.generations.length + 1,
      generation = { number, preparedAt: now, retirement, storage: firstStorage, after: {} };
    for (const [key, value] of Object.entries(payloads)) {
      const filename = 'after-' + number + '-' + randomUUID() + '-' + key + '.json';
      immutable(path.join(transactionDir, filename), value);
      generation.after[key] = { filename, sha256: sha(value) };
    }
    journal = { ...journal, phase: 'prepared', generations: [...journal.generations, generation] };
    atomic(transactionFile, jsonBytes(journal));
    const previousSummary = bytes(t.sources.summary.file),
      expected = { ...observed };
    try {
      for (const key of ['summary', 'checkpoint']) {
        options.beforeWrite?.(key);
        assertSources(t, expected);
        requireThat(digest(requestFile) === requestSha256, 'STORAGE_RESUME_REQUEST_CHANGED');
        verifyAgain(t, options);
        const finalStorage = storage(t, options);
        if (key === 'checkpoint') {
          generation.preCommitStorage = finalStorage;
          atomic(transactionFile, jsonBytes(journal));
          // Recheck after recording the sample: metadata writes must not themselves cross the original floor.
          generation.commitStorage = storage(t, options);
          assertSources(t, expected);
        }
        (options.write ?? atomic)(t.sources[key].file, payloads[key]);
        expected[key] = [sha(payloads[key])];
      }
    } catch (error) {
      // Ordinary late refusal keeps the authoritative checkpoint paused and restores only our own summary bytes.
      if (
        digest(t.sources.checkpoint.file) === t.sources.checkpoint.sha256 &&
        digest(t.sources.summary.file) === sha(payloads.summary)
      )
        atomic(t.sources.summary.file, previousSummary);
      throw error;
    }
    options.beforeCommitMarker?.();
    atomic(
      transactionFile,
      jsonBytes({ ...journal, phase: 'committed', committedAt: new Date().toISOString() }),
    );
    return {
      applied: true,
      alreadyApplied: false,
      historicalVerificationOnly: false,
      launchAuthorized: false,
      transactionDir,
      paused: false,
      recordsSha256: t.recordsSha256,
      health: t.health,
    };
  } finally {
    for (const close of release.reverse()) close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2),
      arg = (name) => {
        const i = args.indexOf('--' + name);
        return i < 0 ? null : args[i + 1];
      };
    requireThat(arg('config'), 'STORAGE_RESUME_CONFIG_REQUIRED');
    if (args.includes('--prepare-request') && !args.includes('--commit')) {
      requireThat(arg('output'), 'STORAGE_RESUME_REQUEST_OUTPUT_REQUIRED');
      const request = prepareStorageResumeRequest(arg('config'));
      const output = path.resolve(arg('output'));
      const fd = fs.openSync(output, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, jsonBytes(request));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      console.log(
        JSON.stringify({
          prepared: true,
          request: output,
          id: request.id,
          action: request.action,
          launchAuthorized: false,
        }),
      );
    } else if (args.includes('--commit') && !args.includes('--prepare-request')) {
      requireThat(arg('request'), 'STORAGE_RESUME_REQUEST_REQUIRED');
      console.log(JSON.stringify(resumeStorageCampaign(arg('config'), arg('request'))));
    } else requireThat(false, 'STORAGE_RESUME_MODE_REQUIRED');
  } catch (error) {
    const code = /^[A-Z0-9_-]+$/.test(error?.code ?? '') ? error.code : 'STORAGE_RESUME_REFUSED';
    console.error(JSON.stringify({ event: 'storage-resume-refused', code }));
    process.exitCode = 1;
  }
}
