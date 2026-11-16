#!/usr/bin/env node
/** Explicit, offline-owner reconciliation. No login, join, game command or process signal. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserRegistryRoot, humanBrowserAgentId, campaignAccountLockRoot } from './browser-paths.mjs';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizeCampaignConfig, verifyCampaignRuntime, campaignSummary } from './keyteki-live-campaign.mjs';
import { normalizeHumanConfig, REPO_ROOT } from './keyteki-human-config.mjs';
import {
  classifyCampaignAttempt,
  campaignHealth,
  focusedCampaignProgress,
} from './keyteki-live-campaign-policy.mjs';
import { readCampaignLobby } from './keyteki-live-lobby.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => sha(JSON.stringify(value));
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const requireThat = (ok, code) => {
  if (!ok) fail(code);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const preJoinGuard = 'CURRENT_PUBLIC_LISTING_NOT_OBSERVED';
// These reviewed standalone-package bytes place the timeout before joinRequested/SPA join.
// This does not authorize migration of an unrelated private or older installation.
// A generic PUBLIC_ROOM_PAIR_CHANGED is deliberately insufficient: it can occur after join.
export const LEGACY_PREJOIN_GUARD_HASHES = Object.freeze({
  "tools/keyteki-human-launcher.mjs": "b51ea38059832c50ccae9bdfc192179c9c3c0d34e020e07071cc3a25b3c937cd",
  "tools/keyteki-human-public-room-ui.mjs": "f6c50a08d6ef70eee1b3d555183f765148c392ab497cd9bb95682b867ef9e9c7",
  "tools/keyteki-fuzhou-ui.mjs": "6ddb20c7de53203db7c9a0515863a06bb15606a9f5fcd52cc2d414e454856a22",
  "tools/keyteki-ui-contract.mjs": "e58a29eabe7e34a5a21d1924226855bce9d78d1e4087c4d317e285786a496d76",
});

function bytes(file, optional = false) {
  try {
    const stat = fs.lstatSync(file);
    requireThat(stat.isFile() && !stat.isSymbolicLink(), 'RECONCILE_SOURCE_NOT_REGULAR');
    return fs.readFileSync(file);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
}
const read = (file) => JSON.parse(bytes(file));
const digest = (file) => {
  const value = bytes(file, true);
  return value === null ? null : sha(value);
};
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function exclusive(file, value) {
  fs.writeFileSync(file, Buffer.isBuffer(value) ? value : jsonBytes(value), { mode: 0o600, flag: 'wx' });
}
/** A complete immutable file may be reused only when its exact bytes match. */
function immutable(file, value) {
  value = Buffer.isBuffer(value) ? value : jsonBytes(value);
  const present = bytes(file, true);
  if (present !== null) {
    requireThat(present.equals(value), 'RECONCILE_IMMUTABLE_FILE_CHANGED');
    return;
  }
  const temp = file + '.stage-' + randomBytes(8).toString('hex');
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      requireThat(bytes(file).equals(value), 'RECONCILE_IMMUTABLE_FILE_CHANGED');
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function atomicBytes(file, value) {
  const temp = file + '.reconcile-' + randomBytes(8).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

/** The lock inode and old lease bytes are preserved. No stale PID guessing or lease replacement. */
function lockExisting(file) {
  requireThat(fs.existsSync(file), 'RECONCILE_LOCK_FILE_MISSING');
  const fd = fs.openSync(file, 'r+');
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
    fail('RECONCILE_OWNER_LOCK_BUSY_OR_UNAVAILABLE');
  }
  return () => fs.closeSync(fd);
}

export function inspectReconciliationProcess(pid) {
  requireThat(Number.isSafeInteger(pid) && pid > 0, 'RECONCILE_PID_INVALID');
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`);
    return {
      pid,
      state: fields[0],
      ppid: Number(fields[1]),
      startId: fields[19],
      exe: fs.readlinkSync(`/proc/${pid}/exe`),
      commandLineSha256: sha(cmdline),
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      // A zombie cannot use a profile, but is not confused with a running process with a flat argv[0].
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z') return null;
        fail('RECONCILE_PROCESS_IDENTITY_UNREADABLE');
      } catch (again) {
        if (again.code !== 'ENOENT' && again.code !== 'ESRCH') throw again;
      }
      return null;
    }
    throw error;
  }
}

async function endpointClosed(value) {
  const url = new URL(value);
  requireThat(
    ['http:', 'ws:'].includes(url.protocol) && url.hostname === '127.0.0.1' && url.port,
    'RECONCILE_ENDPOINT_SCOPE',
  );
  return await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(url.port) });
    let settled = false;
    const done = (closed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(closed);
    };
    socket.once('connect', () => done(false));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
    socket.setTimeout(1500, () => done(false));
  });
}

const registryRoot = browserRegistryRoot;

function loadTarget(configFile, request, options = {}) {
  const original = options.originalSnapshots;
  const read = (file) => JSON.parse(original?.get(file) ?? bytes(file));
  const digest = (file) =>
    original?.has(file)
      ? original.get(file) === null
        ? null
        : sha(original.get(file))
      : (() => {
          const value = bytes(file, true);
          return value === null ? null : sha(value);
        })();
  const input = read(configFile),
    config = normalizeCampaignConfig(input);
  requireThat(
    request?.schema === 'kf-unjoined-recovery-request-v1' &&
      request.action === 'retire-unjoined-attempt' &&
      request.acknowledgedLegacyStopSourceUnknown === true &&
      /^[a-z0-9-]{8,80}$/.test(request.id ?? '') &&
      /^\d{5}-join$/.test(request.attemptId ?? ''),
    'RECONCILE_EXPLICIT_REQUEST_REQUIRED',
  );
  const checkpointFile = path.join(config.output, 'checkpoint.json');
  const state = read(checkpointFile),
    attempt = state.activeAttempt;
  requireThat(
    state.id === config.id &&
      state.configSha256 === canonical(input) &&
      request.configSha256 === state.configSha256 &&
      request.campaignId === config.id &&
      request.runtimeManifestSha256 === config.runtimeManifestSha256 &&
      request.playerName === config.selfName &&
      request.gameId &&
      attempt?.attemptId === request.attemptId &&
      attempt.entry === 'join' &&
      attempt.gameId === request.gameId,
    'RECONCILE_CAMPAIGN_OR_ATTEMPT_BINDING',
  );
  const run = path.join(config.output, 'runs', request.attemptId);
  requireThat(attempt.output === run && fs.realpathSync(run) === run, 'RECONCILE_ATTEMPT_PATH');
  const attemptFile = path.join(config.output, request.attemptId + '.json');
  const attemptInput = read(attemptFile),
    seat = normalizeHumanConfig(attemptInput);
  requireThat(
    same(attemptInput, { ...config.seat, output: run, room: attemptInput.room }) &&
      seat.room.gameId === request.gameId &&
      seat.room.opponentName === attempt.opponentName &&
      seat.self.name === config.selfName &&
      seat.self.codePolicy === config.seat.self.codePolicy,
    'RECONCILE_ATTEMPT_CONFIG_CHANGED',
  );
  const handoffFile = path.join(run, 'handoff.json'),
    h = read(handoffFile);
  requireThat(
    h.gameId === request.gameId &&
      same(h.participants, seat.participants) &&
      h.codePolicy === seat.self.codePolicy &&
      h.driverPid === attempt.pid &&
      h.hostProfile === seat.profile &&
      h.browserProfile === seat.browserProfile &&
      h.agentId === humanBrowserAgentId(request.attemptId) &&
      !h.fullVerified &&
      !h.finished &&
      !h.finalPublicView &&
      !h.gameplayDiagnostics &&
      !h.bridgeStatus &&
      !h.lastGameplayFault &&
      !h.hostRestarts &&
      !h.evidenceWriteFailures &&
      !h.watchdog?.receipt &&
      !h.watchdog?.episode &&
      [preJoinGuard, 'OPERATOR_SIGNAL_PAUSED_AND_PRESERVED'].includes(h.holdReason),
    'RECONCILE_NOT_A_PROVEN_PREJOIN_HOLD',
  );
  for (const name of [
    'own-pending-receipt.json',
    'own-deck-selection.json',
    'first-player-view.json',
    'last-player-view.json',
    'terminal-player-view.json',
    'joined-pending-exit.json',
  ])
    requireThat(!fs.existsSync(path.join(run, name)), 'RECONCILE_NATIVE_OR_PENDING_EVIDENCE_EXISTS');
  const connectionFile = path.join(seat.profile, 'connection.json'),
    connection = read(connectionFile);
  const hostLockFile = path.join(seat.profile, 'runtime.lock'),
    hostLock = read(hostLockFile);
  const hostCheckpointFile = path.join(seat.profile, 'checkpoint.json'),
    hostCheckpoint = read(hostCheckpointFile);
  requireThat(
    hostLock.runId === connection.runId &&
      request.hostRunId === connection.runId &&
      hostCheckpoint.schema === 'kf-bridge-checkpoint-v1' &&
      Array.isArray(hostCheckpoint.manager?.sessions) &&
      hostCheckpoint.manager.sessions.length === 0 &&
      connection.managedSessions === true &&
      same(connection.participants, seat.participants),
    'RECONCILE_HOST_BINDING_OR_SESSIONS',
  );
  const evidenceFile = path.join(run, 'evidence.jsonl');
  const evidence = bytes(evidenceFile).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  requireThat(
    evidence.length > 0 &&
      evidence.some((row) => row.holdReason === preJoinGuard) &&
      evidence.every(
        (row) =>
          row.type === 'lifecycle-sample' &&
          row.gameId === request.gameId &&
          row.playerName === config.selfName &&
          row.codePolicy === seat.self.codePolicy &&
          row.hostRunId === connection.runId &&
          !row.publicView &&
          !row.diagnostics &&
          !row.hostRestarts &&
          [preJoinGuard, 'OPERATOR_SIGNAL_PAUSED_AND_PRESERVED'].includes(row.holdReason),
      ),
    'RECONCILE_PREJOIN_HISTORY_UNVERIFIED',
  );
  const watchdogFile = path.join(run, 'watchdog-events.jsonl');
  const events = bytes(watchdogFile).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
  requireThat(
    events.every(
      (row) =>
        row.gameId === request.gameId &&
        row.type === 'fault-observed' &&
        [preJoinGuard, 'OPERATOR_SIGNAL_PAUSED_AND_PRESERVED'].includes(row.reason),
    ),
    'RECONCILE_GAMEPLAY_HISTORY_PRESENT',
  );
  const manifest = read(config.runtimeManifest);
  const known = new Map(manifest.files?.map((row) => [row.path, row.sha256]) ?? []);
  requireThat(
    Object.entries(options.legacyGuardHashes ?? LEGACY_PREJOIN_GUARD_HASHES).every(
      ([file, hash]) => known.get(file) === hash,
    ),
    'RECONCILE_LEGACY_GUARD_RUNTIME_UNKNOWN',
  );
  const runtime = (options.verifyRuntime ?? verifyCampaignRuntime)(config, { root: manifest.root });
  requireThat(
    state.runtime?.manifestSha256 === config.runtimeManifestSha256 &&
      state.runtime.sourceCommit === runtime.sourceCommit,
    'RECONCILE_FROZEN_RUNTIME_CHANGED',
  );
  const browserRecordFile = path.join(
    options.registryRoot ?? registryRoot(),
    sha('profile:' + fs.realpathSync(seat.browserProfile)) + '.json',
  );
  const browser = read(browserRecordFile),
    clients = Object.values(browser.clients ?? {});
  requireThat(
    browser.managed === true &&
      browser.profileDir === seat.browserProfile &&
      browser.endpoint === h.cdpEndpoint &&
      clients.length === 1 &&
      clients[0].pid === h.driverPid &&
      clients[0].agentId === h.agentId &&
      /^\d+$/.test(clients[0].startId ?? '') &&
      /^\d+$/.test(browser.process?.startId ?? ''),
    'RECONCILE_BROWSER_LEASE_CHANGED',
  );
  const accountRoot = options.accountRoot ?? campaignAccountLockRoot();
  const accountStem = path.join(accountRoot, sha(config.origin + '\n' + config.selfName));
  const accountFile = accountStem + '.json',
    account = read(accountFile);
  requireThat(
    account.origin === config.origin &&
      account.selfName === config.selfName &&
      account.output === config.output &&
      account.pid === state.pid,
    'RECONCILE_FOREIGN_ACCOUNT_LEASE',
  );
  const stopReceipt = read(request.stopReceiptPath);
  requireThat(
    digest(request.stopReceiptPath) === request.stopReceiptSha256 &&
      ['kf-campaign05-explicit-unjoined-process-stop-v1', 'kf-unjoined-process-stop-v1'].includes(
        stopReceipt.schema,
      ) &&
      stopReceipt.completed === true &&
      stopReceipt.priorCompletedResultsUnchanged === true &&
      Array.isArray(stopReceipt.knownBrowserProcessesAfter) &&
      stopReceipt.knownBrowserProcessesAfter.length === 0 &&
      stopReceipt.events?.some((e) => e.kind === 'all-preconditions-passed' && e.gameId === request.gameId) &&
      stopReceipt.events.some((e) => e.kind === 'driver-exit-observed' && e.pid === h.driverPid),
    'RECONCILE_OPERATOR_STOP_RECEIPT_UNVERIFIED',
  );
  const prior = stopReceipt.processesBefore;
  requireThat(
    prior?.parent?.pid === state.pid &&
      prior.driver?.pid === h.driverPid &&
      prior.driver.ppid === state.pid &&
      prior.browser?.pid === browser.process.pid &&
      prior.browser.ppid === h.driverPid &&
      prior.browser.startTicks === browser.process.startId &&
      prior.driver.startTicks === clients[0].startId &&
      prior.parent.exeBasename === 'node' &&
      prior.driver.exeBasename === 'node' &&
      ['chrome', 'chromium', 'google-chrome'].includes(prior.browser.exeBasename),
    'RECONCILE_PROCESS_PROVENANCE_CHANGED',
  );
  const matching = state.records.filter((row) => row.attemptId === request.attemptId);
  requireThat(
    matching.length <= 1 && (!matching.length || state.records.at(-1) === matching[0]),
    'RECONCILE_ATTEMPT_RECORD_ORDER',
  );
  if (matching.length)
    requireThat(
      matching[0].gameId === request.gameId &&
        !matching[0].started &&
        !matching[0].terminal &&
        !matching[0].natural &&
        !matching[0].canContinue &&
        matching[0].outcome === 'operator-paused' &&
        matching[0].runtimeManifestSha256 === config.runtimeManifestSha256,
      'RECONCILE_EXISTING_RECORD_NOT_UNJOINED',
    );
  const priorRows = state.records.filter((row) => row.attemptId !== request.attemptId);
  for (const row of priorRows)
    requireThat(
      digest(path.join(config.output, row.attemptId + '-result.json')) ===
        stopReceipt.priorCompletedResultHashes?.[row.attemptId] &&
        same(row, read(path.join(config.output, row.attemptId + '-result.json'))),
      'RECONCILE_PRIOR_RESULT_CHANGED',
    );
  const files = {
    config: configFile,
    checkpoint: checkpointFile,
    handoff: handoffFile,
    summary: path.join(config.output, 'summary.json'),
    control: path.join(config.output, 'control.json'),
    attempt: attemptFile,
    result: path.join(config.output, request.attemptId + '-result.json'),
    connection: connectionFile,
    hostLock: hostLockFile,
    hostCheckpoint: hostCheckpointFile,
    operatorIntent: path.join(seat.profile, 'operator-intent.json'),
    browser: browserRecordFile,
    account: accountFile,
    evidence: evidenceFile,
    watchdog: watchdogFile,
    manifest: config.runtimeManifest,
    stopReceipt: request.stopReceiptPath,
    driverLog: path.join(config.output, request.attemptId + '.log'),
  };
  const hashes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, digest(file)]));
  requireThat(
    hashes.checkpoint === request.expectedCheckpointSha256 &&
      hashes.handoff === request.expectedHandoffSha256 &&
      hashes.control === request.expectedControlSha256 &&
      hashes.browser === request.expectedBrowserLeaseSha256 &&
      hashes.account === request.expectedAccountLeaseSha256,
    'RECONCILE_EXPECTED_SNAPSHOT_CHANGED',
  );
  requireThat(
    stopReceipt.after?.['checkpoint.json']?.sha256 === hashes.checkpoint &&
      stopReceipt.after?.['handoff.json']?.sha256 === hashes.handoff,
    'RECONCILE_POST_STOP_SNAPSHOT_CHANGED',
  );
  return {
    input,
    config,
    state,
    attempt,
    seat,
    h,
    connection,
    hostLock,
    browser,
    clients,
    stopReceipt,
    files,
    hashes,
    priorRows,
    accountStem,
    manifest,
    runtime,
    processes: {
      parent: { ...prior.parent, startId: prior.parent.startTicks },
      driver: { ...prior.driver, startId: clients[0].startId },
      host: { pid: hostLock.pid, runId: hostLock.runId },
      browser: { ...prior.browser, startId: browser.process.startId },
    },
  };
}

/** Preparation only pins existing evidence; --commit is the separate explicit operator action. */
export function prepareUnjoinedRecoveryRequest(
  configFile,
  stopReceiptPath,
  { resumeAfterReconcile = false, ...options } = {},
) {
  configFile = path.resolve(configFile);
  stopReceiptPath = path.resolve(stopReceiptPath);
  const input = read(configFile),
    config = normalizeCampaignConfig(input);
  const state = read(path.join(config.output, 'checkpoint.json')),
    attempt = state.activeAttempt;
  requireThat(attempt?.entry === 'join', 'RECONCILE_JOIN_ATTEMPT_REQUIRED');
  const h = read(path.join(attempt.output, 'handoff.json'));
  const connection = read(path.join(h.hostProfile, 'connection.json'));
  const browserRecord = path.join(
    options.registryRoot ?? registryRoot(),
    sha('profile:' + fs.realpathSync(h.browserProfile)) + '.json',
  );
  const accountFile = path.join(
    options.accountRoot ?? campaignAccountLockRoot(),
    sha(config.origin + '\n' + config.selfName) + '.json',
  );
  const request = {
    schema: 'kf-unjoined-recovery-request-v1',
    id: 'unjoined-' + randomBytes(12).toString('hex'),
    action: 'retire-unjoined-attempt',
    acknowledgedLegacyStopSourceUnknown: true,
    originalDriverExit: 'nonzero-or-unverified-not-assumed-successful',
    campaignId: config.id,
    attemptId: attempt.attemptId,
    gameId: attempt.gameId,
    playerName: config.selfName,
    configSha256: canonical(input),
    runtimeManifestSha256: config.runtimeManifestSha256,
    hostRunId: connection.runId,
    stopReceiptPath,
    stopReceiptSha256: digest(stopReceiptPath),
    expectedCheckpointSha256: digest(path.join(config.output, 'checkpoint.json')),
    expectedHandoffSha256: digest(path.join(attempt.output, 'handoff.json')),
    expectedControlSha256: digest(path.join(config.output, 'control.json')),
    expectedBrowserLeaseSha256: digest(browserRecord),
    expectedAccountLeaseSha256: digest(accountFile),
    resumeAfterReconcile: resumeAfterReconcile === true,
    preparedAt: new Date().toISOString(),
  };
  loadTarget(configFile, request, options);
  return request;
}

function nativeAbsent(snapshot, config) {
  return Boolean(
    snapshot?.source === 'native-lobby' &&
      snapshot.nativeFullRoster === true &&
      snapshot.anonymous === true &&
      snapshot.origin === config.origin &&
      Number.isFinite(snapshot.fullObservedAt) &&
      Date.now() - snapshot.fullObservedAt <= 30000 &&
      snapshot.fullObservedAt <= Date.now() + 1000 &&
      Array.isArray(snapshot.rooms) &&
      snapshot.rooms.every((row) => row.players && !Object.hasOwn(row.players, config.selfName)),
  );
}

async function confirmResourcesGone(target, options) {
  const inspect = options.inspectProcess ?? inspectReconciliationProcess;
  const processes = {};
  for (const [role, binding] of Object.entries(target.processes)) {
    const current = inspect(binding.pid);
    // Any live PID is a refusal, including PID reuse or a Chrome with one flat argv[0].
    requireThat(current === null, 'RECONCILE_PROCESS_STILL_LIVE_' + role.toUpperCase());
    processes[role] = { ...binding, exited: true, checkedAt: new Date().toISOString() };
  }
  const closed = options.endpointClosed ?? endpointClosed;
  requireThat(await closed(target.connection.url), 'RECONCILE_HOST_ENDPOINT_STILL_OPEN');
  requireThat(await closed(target.browser.endpoint), 'RECONCILE_BROWSER_ENDPOINT_STILL_OPEN');
  return processes;
}

/** Caller owns all three kernel locks. Immutable sources must stay unchanged through every await. */
function assertCurrentSources(target, allowed, observed) {
  for (const [key, file] of Object.entries(target.files)) {
    const current = digest(file);
    requireThat(
      (allowed?.[key] ?? [target.hashes[key]]).includes(current),
      'RECONCILE_SOURCE_CAS_FAILED_' + key.toUpperCase(),
    );
    if (observed)
      requireThat(current === observed[key], 'RECONCILE_SOURCE_CHANGED_DURING_PROBE_' + key.toUpperCase());
  }
}

export async function reconcileUnjoinedAttempt(configFile, requestFile, options = {}) {
  configFile = path.resolve(configFile);
  requestFile = path.resolve(requestFile);
  const requestBytes = bytes(requestFile),
    request = JSON.parse(requestBytes),
    requestSha256 = sha(requestBytes);
  const config = normalizeCampaignConfig(read(configFile));
  requireThat(
    /^[a-z0-9-]{8,80}$/.test(request.id ?? '') && /^\d{5}-join$/.test(request.attemptId ?? ''),
    'RECONCILE_REQUEST_ID_INVALID',
  );
  const transactionDir = path.join(config.output, 'reconciliations', request.attemptId + '-' + request.id);
  const journalFile = path.join(transactionDir, 'transaction.json');
  let journal = fs.existsSync(journalFile) ? read(journalFile) : null;
  if (journal) {
    requireThat(
      journal.schema === 'kf-unjoined-reconcile-transaction-v1' &&
        journal.requestSha256 === requestSha256 &&
        journal.configFile === configFile &&
        Array.isArray(journal.generations) &&
        journal.generations.length > 0,
      'RECONCILE_JOURNAL_BINDING_CHANGED',
    );
    requireThat(
      same(read(path.join(transactionDir, 'identity.json')), { requestSha256, configFile }) &&
        sha(bytes(path.join(transactionDir, 'operator-request.json'))) === requestSha256,
      'RECONCILE_TRANSACTION_IDENTITY_CHANGED',
    );
  }
  const originalSnapshots = new Map();
  if (journal) {
    for (const [key, item] of Object.entries(journal.originals)) {
      const value = item.sha256 === null ? null : bytes(path.join(transactionDir, 'original-' + key));
      requireThat(
        value === null ? item.sha256 === null : sha(value) === item.sha256,
        'RECONCILE_ARCHIVE_CHANGED',
      );
      originalSnapshots.set(item.file, value);
    }
  }
  const target = loadTarget(configFile, request, { ...options, originalSnapshots });
  if (journal)
    for (const [key, item] of Object.entries(journal.originals))
      requireThat(
        target.files[key] === item.file && target.hashes[key] === item.sha256,
        'RECONCILE_ARCHIVE_BINDING_CHANGED',
      );
  const allowed = Object.fromEntries(Object.entries(target.hashes).map(([key, value]) => [key, [value]]));
  for (const generation of journal?.generations ?? []) {
    requireThat(
      same(Object.keys(generation.after).sort(), ['checkpoint', 'handoff', 'result', 'summary']),
      'RECONCILE_STAGE_KEYS_CHANGED',
    );
    for (const [key, item] of Object.entries(generation.after)) {
      requireThat(
        path.basename(item.filename) === item.filename &&
          digest(path.join(transactionDir, item.filename)) === item.sha256,
        'RECONCILE_STAGE_CHANGED',
      );
      allowed[key].push(item.sha256);
    }
  }
  const release = [];
  try {
    for (const file of [target.accountStem + '.lock', target.files.hostLock, target.files.browser + '.lock'])
      release.push((options.lock ?? lockExisting)(file));
    if (journal) {
      const current = read(target.files.checkpoint);
      const applied = current.records?.filter((row) => row.attemptId === request.attemptId);
      if (applied?.some((row) => row.unjoinedReconciliation?.id === request.id)) {
        const latest = journal.generations.at(-1);
        const committedState = read(path.join(transactionDir, latest.after.checkpoint.filename));
        const committedRecord = read(path.join(transactionDir, latest.after.result.filename));
        requireThat(
          applied.length === 1 &&
            same(applied[0], committedRecord) &&
            committedRecord.unjoinedReconciliation?.requestSha256 === requestSha256 &&
            committedRecord.canContinue === true &&
            same(current.records.slice(0, target.priorRows.length), target.priorRows) &&
            current.id === config.id &&
            current.configSha256 === request.configSha256 &&
            same(
              current.reconciliations?.find((row) => row.id === request.id),
              committedState.reconciliations.at(-1),
            ) &&
            digest(configFile) === target.hashes.config &&
            digest(target.files.handoff) === latest.after.handoff.sha256 &&
            digest(target.files.result) === latest.after.result.sha256,
          'RECONCILE_APPLIED_RECORD_OR_OUTPUT_CHANGED',
        );
        requireThat(sha(bytes(requestFile)) === requestSha256, 'RECONCILE_REQUEST_CHANGED');
        if (journal.phase !== 'committed')
          atomicBytes(
            journalFile,
            jsonBytes({
              ...journal,
              phase: 'committed',
              committedAt: new Date().toISOString(),
              commitMarkerRecovered: true,
            }),
          );
        // This verifies a historical application, not whether a campaign may resume now.
        return {
          applied: true,
          alreadyApplied: true,
          historicalVerificationOnly: true,
          transactionDir,
          record: applied[0],
        };
      }
      requireThat(journal.phase !== 'committed', 'RECONCILE_COMMITTED_CHECKPOINT_CHANGED');
    }
    assertCurrentSources(target, allowed);
    const observed = Object.fromEntries(
      Object.entries(target.files).map(([key, file]) => [key, digest(file)]),
    );
    let processes = await confirmResourcesGone(target, options);
    assertCurrentSources(target, allowed, observed);
    const snapshot = await (options.probe ?? readCampaignLobby)({
      profileDir: path.join(config.output, 'reconcile-lobby', request.id),
      agentId: 'keyforge-tco-bot:reconcile-' + request.id,
      origin: config.origin,
      network: config.network,
      timeoutMs: 15000,
    });
    requireThat(nativeAbsent(snapshot, config), 'RECONCILE_FRESH_NATIVE_ABSENCE_REQUIRED');
    assertCurrentSources(target, allowed, observed);
    requireThat(sha(bytes(requestFile)) === requestSha256, 'RECONCILE_REQUEST_CHANGED');
    processes = await confirmResourcesGone(target, options);
    assertCurrentSources(target, allowed, observed);
    // Target runtime is deliberately separate from the current reconciliation tool's source tree.
    (options.verifyRuntime ?? verifyCampaignRuntime)(target.config, { root: target.manifest.root });
    const now = new Date().toISOString();
    const receipt = {
      schema: 'kf-unjoined-reconciliation-v1',
      id: request.id,
      status: 'verified-retired',
      attemptId: request.attemptId,
      gameId: request.gameId,
      playerName: config.selfName,
      requestSha256,
      configSha256: request.configSha256,
      operatorRecovery: {
        action: request.action,
        acknowledgedLegacyStopSourceUnknown: true,
        source: 'explicit-operator-reconciliation',
        stopReceiptPath: request.stopReceiptPath,
        stopReceiptSha256: request.stopReceiptSha256,
      },
      legacyStopProvenance: 'unknown',
      originalDriverExit: 'nonzero-or-unverified-not-assumed-successful',
      preJoinGuard,
      neverNativeActive: true,
      zeroGameplaySends: true,
      processes,
      locks: { account: true, host: true, browser: true },
      nativeAbsence: snapshot,
      resourceScope: {
        currentChecks: 'four-bound-pids-two-loopback-endpoints-three-owner-locks',
        browserTreeExit: 'bound-operator-stop-receipt-empty-after-list',
      },
      originalCheckpointSha256: target.hashes.checkpoint,
      originalHandoffSha256: target.hashes.handoff,
      originalAttemptResultSha256: target.hashes.result,
      originalRecordsSha256: canonical(target.state.records),
      originalOperatorIntentSha256: target.hashes.operatorIntent,
      runtimeManifestSha256: config.runtimeManifestSha256,
      runtimeSourceCommit: target.runtime.sourceCommit,
      runtimeRoot: target.manifest.root,
      reconciliationToolRoot: REPO_ROOT,
      reconciliationToolSha256: sha(fs.readFileSync(new URL(import.meta.url))),
      transactionDir,
      checkedAt: now,
    };
    // Original flags are retained. The classifier recognizes a separately verified operator reconciliation.
    const handoff = { ...target.h, unjoinedReconciliation: receipt, reconciliationUpdatedAt: now };
    const record = classifyCampaignAttempt({
      handoff,
      selfName: config.selfName,
      origin: config.origin,
      expectedGameId: request.gameId,
      exitCode: null,
      attemptId: request.attemptId,
      startedAt: target.attempt.startedAt,
      endedAt: now,
    });
    requireThat(
      record.canContinue &&
        record.outcome === 'matchmaking-miss' &&
        !record.started &&
        !record.terminal &&
        !record.natural,
      'RECONCILE_CLASSIFICATION_FAILED',
    );
    Object.assign(record, {
      entry: 'join',
      output: target.seat.output,
      codePolicy: target.seat.self.codePolicy,
      runtimeManifestSha256: config.runtimeManifestSha256,
      hostRestarts: 0,
      matchDetails: null,
      lastGameplayFault: null,
      gameplayDiagnostics: null,
      evidenceWriteFailures: 0,
    });
    const records = target.state.records.some((row) => row.attemptId === request.attemptId)
      ? target.state.records.map((row) => (row.attemptId === request.attemptId ? record : row))
      : [...target.state.records, record];
    requireThat(
      same(
        records.filter((row) => row.attemptId !== request.attemptId),
        target.priorRows,
      ),
      'RECONCILE_PRIOR_ROWS_CHANGED',
    );
    const control =
      target.hashes.control === null
        ? {}
        : JSON.parse(originalSnapshots.get(target.files.control) ?? bytes(target.files.control));
    const derived = new Set([
      'operator-paused-current-game',
      'current-game-unresolved',
      'setup-not-completed',
      'operator-paused',
      'unreleased-or-unresolved-attempt',
    ]);
    if (
      target.stopReceipt.events.some(
        (event) => event.kind === 'signal-sent' && event.role === 'parent' && event.signal === 'SIGTERM',
      )
    )
      derived.add('operator-stop-after-current');
    let reasons = [...target.state.pauseReasons];
    if (request.resumeAfterReconcile === true) reasons = reasons.filter((reason) => !derived.has(reason));
    if (control.pauseAfterCurrent === true && !reasons.includes('operator-pause-after-current'))
      reasons.push('operator-pause-after-current');
    const health = campaignHealth(records);
    reasons = [...new Set([...reasons, ...health.reasons])];
    const state = {
      ...target.state,
      records,
      activeAttempt: null,
      health,
      focus: focusedCampaignProgress(records, config),
      pauseReasons: reasons,
      paused: request.resumeAfterReconcile !== true || reasons.length > 0,
      phase:
        request.resumeAfterReconcile === true && !reasons.length
          ? 'ready-after-unjoined-reconciliation'
          : 'paused',
      updatedAt: now,
      reconciliations: [
        ...(target.state.reconciliations ?? []),
        {
          id: request.id,
          attemptId: request.attemptId,
          originalAttemptResultSha256: target.hashes.result,
          transactionDir,
          requestSha256,
          checkedAt: now,
        },
      ],
    };
    const payloads = {
      handoff: jsonBytes(handoff),
      result: jsonBytes(record),
      summary: jsonBytes(campaignSummary(config, state)),
      checkpoint: jsonBytes(state),
    };
    if (!journal) {
      fs.mkdirSync(path.dirname(transactionDir), { recursive: true, mode: 0o700 });
      fs.mkdirSync(transactionDir, { recursive: true, mode: 0o700 });
      requireThat(
        fs.lstatSync(transactionDir).isDirectory() && fs.realpathSync(transactionDir) === transactionDir,
        'RECONCILE_TRANSACTION_PATH',
      );
      immutable(path.join(transactionDir, 'identity.json'), { requestSha256, configFile });
      immutable(path.join(transactionDir, 'operator-request.json'), requestBytes);
      const originals = {};
      for (const [key, file] of Object.entries(target.files)) {
        const value = bytes(file, true);
        requireThat(
          (value === null ? null : sha(value)) === target.hashes[key],
          'RECONCILE_ARCHIVE_CAS_FAILED',
        );
        options.beforeArchive?.(key);
        if (value !== null) immutable(path.join(transactionDir, 'original-' + key), value);
        originals[key] = { file, sha256: target.hashes[key] };
      }
      journal = {
        schema: 'kf-unjoined-reconcile-transaction-v1',
        requestSha256,
        configFile,
        originals,
        generations: [],
      };
    }
    const generation = {
      number: journal.generations.length + 1,
      id: randomBytes(12).toString('hex'),
      preparedAt: now,
      after: {},
    };
    for (const [key, value] of Object.entries(payloads)) {
      const filename = 'after-' + generation.number + '-' + generation.id + '-' + key + '.json';
      options.beforeStage?.(key);
      immutable(path.join(transactionDir, filename), value);
      generation.after[key] = { filename, sha256: sha(value) };
    }
    journal = { ...journal, generations: [...journal.generations, generation], phase: 'prepared' };
    atomicBytes(journalFile, jsonBytes(journal));
    assertCurrentSources(target, allowed, observed);
    requireThat(nativeAbsent(snapshot, config), 'RECONCILE_NATIVE_ABSENCE_EXPIRED');
    const expected = { ...observed };
    // The checkpoint is the commit point, last. Partial generations are replayable under the same locks/CAS.
    for (const key of ['handoff', 'result', 'summary', 'checkpoint']) {
      assertCurrentSources(
        target,
        Object.fromEntries(Object.entries(expected).map(([k, value]) => [k, [value]])),
      );
      requireThat(sha(bytes(requestFile)) === requestSha256, 'RECONCILE_REQUEST_CHANGED');
      options.beforeWrite?.(key);
      (options.write ?? atomicBytes)(target.files[key], payloads[key]);
      expected[key] = sha(payloads[key]);
    }
    options.beforeCommitMarker?.();
    atomicBytes(
      journalFile,
      jsonBytes({ ...journal, phase: 'committed', committedAt: new Date().toISOString() }),
    );
    return {
      applied: true,
      alreadyApplied: false,
      transactionDir,
      record,
      paused: state.paused,
      pauseReasons: state.pauseReasons,
    };
  } finally {
    for (const close of release.reverse()) close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void (async () => {
    const args = process.argv.slice(2),
      arg = (name) => {
        const i = args.indexOf('--' + name);
        return i < 0 ? null : args[i + 1];
      };
    requireThat(arg('config'), 'RECONCILE_CONFIG_REQUIRED');
    if (args.includes('--prepare-request') && !args.includes('--commit')) {
      requireThat(arg('stop-receipt') && arg('output'), 'RECONCILE_PREPARATION_ARGUMENTS_REQUIRED');
      const request = prepareUnjoinedRecoveryRequest(arg('config'), arg('stop-receipt'), {
        resumeAfterReconcile: args.includes('--resume-after-reconcile'),
      });
      exclusive(path.resolve(arg('output')), request);
      console.log(
        JSON.stringify({
          prepared: true,
          request: path.resolve(arg('output')),
          id: request.id,
          attemptId: request.attemptId,
          gameId: request.gameId,
          resumeAfterReconcile: request.resumeAfterReconcile,
        }),
      );
    } else if (args.includes('--commit') && !args.includes('--prepare-request')) {
      requireThat(arg('request'), 'RECONCILE_REQUEST_FILE_REQUIRED');
      const result = await reconcileUnjoinedAttempt(arg('config'), arg('request'));
      console.log(
        JSON.stringify({
          applied: result.applied,
          alreadyApplied: result.alreadyApplied,
          historicalVerificationOnly: result.historicalVerificationOnly === true,
          transactionDir: result.transactionDir,
          outcome: result.record.outcome,
          recordedCanContinue: result.record.canContinue,
          paused: result.paused,
          pauseReasons: result.pauseReasons,
        }),
      );
    } else fail('RECONCILE_MODE_REQUIRED');
  })().catch((error) => {
    console.error(
      JSON.stringify({ event: 'unjoined-reconciliation-refused', code: error.code ?? error.message }),
    );
    process.exitCode = 1;
  });
}
