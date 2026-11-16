#!/usr/bin/env node
/** Public command routing. Commands retain the underlying runtime's explicit run and ownership contracts. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeHumanConfig, humanPreflight, HUMAN_SCHEMA, REPO_ROOT } from './keyteki-human-config.mjs';
import { normalizeCampaignConfig } from './keyteki-live-campaign.mjs';
import { inspectBrowserProcess, signalOwnedBrowser } from './browser-provider.mjs';
import { createInterface } from 'node:readline/promises';
import { DEFAULT_CODE_POLICY, strategyMenu, strategyDetails, renderStrategyMenu, renderStrategyDetails, resolveStrategyChoice } from './strategy-menu.mjs';

export const HELP = `kf-auto：本机策略宿主与单账号浏览器运行器

  strategies list [--all] [--json]
  strategies show ID [--json]
  init --directory DIR --origin ORIGIN --account NAME --server-deck-id ID --deck-name NAME
       [--deck-uuid UUID] [--policy ID | --choose-policy] [--game-socket-path EXACT_HTTP_PATH] [--headful]
  preflight --config FILE [--create-public]
  seat run|create --config FILE
  host start --profile DIR --config FILE
  host status|pause|resume|stop --profile DIR
  campaign prepare --seat FILE --manifest FILE --config NEW_FILE --output NEW_DATA_DIR --id NAME
  campaign run|status|pause|enable-unattended --config FILE
  runtime freeze --output ABSOLUTE_NEW_DIR
  recovery storage prepare --config FILE --output NEW_REQUEST
  recovery storage commit --config FILE --request FILE
  recovery unjoined prepare --config FILE --stop-receipt FILE --output NEW_REQUEST [--resume-after-reconcile]
  recovery unjoined commit --config FILE --request FILE

Origins, accounts and decks are explicit. Site UI compatibility is documented separately.
No command starts a browser unless its operation requires it; preflight is offline.
`;
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const option = (args, name) => {
  const index = args.indexOf('--' + name);
  return index < 0 ? undefined : args[index + 1];
};
const required = (args, name) => {
  const value = option(args, name);
  if (!value || value.startsWith('--')) fail('MISSING_' + name.replaceAll('-', '_').toUpperCase());
  return value;
};
const repeated = (args, name) =>
  args.flatMap((value, index) => (value === '--' + name ? [required(args.slice(index), name)] : []));
const writeNewJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });

/** Validate policy flags before any directory or credential template can be created. */
export function initializationPolicy(args) {
  const explicit = args.filter((arg) => arg === '--policy').length;
  const interactive = args.filter((arg) => arg === '--choose-policy').length;
  if (explicit > 1 || interactive > 1) fail('POLICY_OPTION_DUPLICATED');
  if (explicit && interactive) fail('POLICY_SELECTION_CONFLICT');
  return { interactive: interactive === 1, policy: explicit ? required(args, 'policy') : DEFAULT_CODE_POLICY };
}
export async function choosePolicyInteractively({ input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) fail('INTERACTIVE_TERMINAL_REQUIRED');
  const terminal = createInterface({ input, output, terminal: true });
  const abort = new AbortController();
  terminal.once('close', () => abort.abort());
  terminal.once('SIGINT', () => abort.abort());
  output.write(renderStrategyMenu(strategyMenu()) + '\n\n');
  try {
    while (true) {
      let answer;
      try {
        answer = await terminal.question('输入常用编号或完整策略 ID；回车使用默认：', { signal: abort.signal });
      } catch {
        fail('POLICY_SELECTION_CANCELLED');
      }
      const selected = resolveStrategyChoice(answer);
      if (selected) return selected;
      output.write('无效选择，请输入 1–5、已注册策略 ID，或直接回车。\n');
    }
  } finally {
    terminal.close();
  }
}
export function strategyCommand(args) {
  const [action = 'list', ...rest] = args;
  const json = rest.includes('--json');
  if (action === 'list') {
    if (rest.some((arg) => !['--all', '--json'].includes(arg)) || new Set(rest).size !== rest.length)
      fail('STRATEGY_LIST_OPTIONS');
    const result = strategyMenu({ all: rest.includes('--all') });
    return json ? JSON.stringify(result, null, 2) : renderStrategyMenu(result);
  }
  if (action === 'show') {
    const [id, ...flags] = rest;
    if (!id || id.startsWith('--')) fail('STRATEGY_ID_REQUIRED');
    if (flags.some((arg) => arg !== '--json') || flags.length > 1) fail('STRATEGY_SHOW_OPTIONS');
    const result = strategyDetails(id);
    return json ? JSON.stringify(result, null, 2) : renderStrategyDetails(result);
  }
  fail('STRATEGY_ACTION_UNKNOWN');
}

export function initializeConfig(args) {
  const selected = initializationPolicy(args);
  if (selected.interactive) fail('INTERACTIVE_SELECTION_NOT_RESOLVED');
  const directory = path.resolve(required(args, 'directory'));
  if (fs.existsSync(directory)) fail('CONFIG_DIRECTORY_ALREADY_EXISTS');
  const account = required(args, 'account');
  const seat = {
    schema: HUMAN_SCHEMA,
    origin: required(args, 'origin'),
    self: {
      name: account,
      serverDeckId: Number(required(args, 'server-deck-id')),
      deckName: required(args, 'deck-name'),
      mode: 'code',
      codePolicy: selected.policy,
      ...(option(args, 'deck-uuid') ? { deckSelector: option(args, 'deck-uuid') } : {}),
    },
    room: { name: 'AI game', gameType: 'beginner', gameFormat: 'normal' },
    credentialsPath: path.join(directory, 'credentials.json'),
    output: path.join(directory, 'seat-run'),
    headless: !args.includes('--headful'),
    leaveAfterFinish: true,
    watchdog: { enabled: true },
    social: { enabled: false },
    ownAccountNames: [account],
    gameSocketPaths: repeated(args, 'game-socket-path'),
  };
  normalizeHumanConfig(seat, { createPublic: true });
  // An empty password is deliberate: this generates a private local template, never a credential.
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory, { mode: 0o700 });
  writeNewJson(path.join(directory, 'credentials.json'), {
    origin: seat.origin,
    accounts: { [account]: { username: account, password: '' } },
  });
  writeNewJson(path.join(directory, 'seat.json'), seat);
  return {
    created: true,
    config: path.join(directory, 'seat.json'),
    credentials: seat.credentialsPath,
    codePolicy: seat.self.codePolicy,
    passwordMustBeFilledLocally: true,
    browserStarted: false,
  };
}
export function prepareCampaign(args) {
  const seatFile = path.resolve(required(args, 'seat'));
  const manifestFile = path.resolve(required(args, 'manifest'));
  const configFile = path.resolve(required(args, 'config'));
  if (fs.existsSync(configFile)) fail('CAMPAIGN_CONFIG_ALREADY_EXISTS');
  const manifestBytes = fs.readFileSync(manifestFile),
    manifest = JSON.parse(manifestBytes);
  if (
    manifest.schema !== 'kf-live-runtime-freeze-v1' ||
    !path.isAbsolute(manifest.root ?? '') ||
    !Array.isArray(manifest.files)
  )
    fail('RUNTIME_FREEZE_INVALID');
  const input = {
    schema: 'keyteki-live-campaign-v1',
    id: required(args, 'id'),
    output: path.resolve(required(args, 'output')),
    runtimeManifest: manifestFile,
    runtimeManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    seat: JSON.parse(fs.readFileSync(seatFile, 'utf8')),
  };
  normalizeCampaignConfig(input);
  if (fs.existsSync(input.output)) fail('CAMPAIGN_OUTPUT_ALREADY_EXISTS');
  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  writeNewJson(configFile, input);
  return {
    prepared: true,
    config: configFile,
    runtimeRoot: manifest.root,
    runtimeManifestSha256: input.runtimeManifestSha256,
    runFrom: path.join(manifest.root, 'tools', 'cli.mjs'),
    browserStarted: false,
  };
}
/** Pure mapping is shared by the binary wrapper and offline CLI tests. */
export function commandFor(args) {
  const [command, action, ...rest] = args;
  if (command === 'preflight') {
    if (args.includes('--run')) fail('PREFLIGHT_CANNOT_RUN');
    return { operation: 'offline-preflight', args: args.slice(1) };
  }
  if (command === 'seat' && ['run', 'create'].includes(action))
    return {
      script: 'keyteki-human-launcher.mjs',
      args: [...rest, '--run', ...(action === 'create' ? ['--create-public'] : [])],
    };
  if (command === 'host' && ['start', 'status', 'pause', 'resume', 'stop'].includes(action))
    return { script: 'keyteki-session-host.mjs', args: [action, ...rest] };
  if (command === 'campaign' && ['run', 'status', 'pause', 'enable-unattended'].includes(action)) {
    if (rest.some((value) => ['--run', '--pause', '--enable-unattended'].includes(value)))
      fail('CAMPAIGN_ACTION_DUPLICATED');
    return {
      script: 'keyteki-live-campaign.mjs',
      args: [...rest, ...(action === 'status' ? [] : ['--' + action])],
    };
  }
  if (command === 'runtime' && action === 'freeze') return { script: 'freeze-keyteki-live.mjs', args: rest };
  if (command === 'recovery' && ['storage', 'unjoined'].includes(action)) {
    const [mode, ...options] = rest;
    if (
      !['prepare', 'commit'].includes(mode) ||
      options.includes('--prepare-request') ||
      options.includes('--commit')
    )
      fail('RECOVERY_MODE_REQUIRED');
    return {
      script: action === 'storage' ? 'keyteki-resume-storage.mjs' : 'keyteki-reconcile-unjoined.mjs',
      args: [...options, mode === 'prepare' ? '--prepare-request' : '--commit'],
    };
  }
  fail('UNKNOWN_COMMAND');
}
export async function runCli(args = process.argv.slice(2)) {
  if (!args.length || args[0] === 'help' || args.includes('--help')) {
    console.log(HELP);
    return 0;
  }
  if (args[0] === 'strategies') {
    console.log(strategyCommand(args.slice(1)));
    return 0;
  }
  if (args[0] === 'init') {
    let options = args.slice(1);
    const selected = initializationPolicy(options);
    if (selected.interactive) {
      // Check required arguments before asking; selection itself still creates no files.
      for (const name of ['directory', 'origin', 'account', 'server-deck-id', 'deck-name']) required(options, name);
      if (fs.existsSync(path.resolve(required(options, 'directory')))) fail('CONFIG_DIRECTORY_ALREADY_EXISTS');
      const id = await choosePolicyInteractively();
      options = [...options.filter((arg) => arg !== '--choose-policy'), '--policy', id];
    }
    console.log(JSON.stringify(initializeConfig(options), null, 2));
    return 0;
  }
  if (args[0] === 'campaign' && args[1] === 'prepare') {
    console.log(JSON.stringify(prepareCampaign(args.slice(2)), null, 2));
    return 0;
  }
  const command = commandFor(args);
  if (command.operation === 'offline-preflight') {
    // A missing build must be reported, not imported through the live launcher.
    const input = JSON.parse(fs.readFileSync(path.resolve(required(command.args, 'config')), 'utf8'));
    const { report } = humanPreflight(input, { createPublic: command.args.includes('--create-public') });
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'tools', command.script), ...command.args], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  // Bind the spawned Node child once; later signals use a pidfd, never a reusable bare PID.
  const identity = inspectBrowserProcess(child.pid);
  const binding = {
    pid: child.pid,
    startId: identity.startId,
    executable: fs.realpathSync(process.execPath),
  };
  const forward = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      signalOwnedBrowser(binding, signal);
    } catch {
      console.error(
        JSON.stringify({ event: 'child-signal-preserved', code: 'CHILD_SIGNAL_IDENTITY_UNCONFIRMED' }),
      );
    }
  };
  const interrupt = () => forward('SIGINT'),
    terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(JSON.stringify({ event: 'kf-auto-failed', code: error.code ?? 'COMMAND_FAILED' }));
      process.exitCode = 1;
    },
  );
}
