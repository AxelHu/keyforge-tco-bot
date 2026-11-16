import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { CODE_POLICY_IDS } from '../../dist/src/ai/code-strategies.js';
import { STRATEGY_ELO_BENCHMARK } from '../../tools/strategy-benchmark.mjs';
import {
  REGISTERED_CODE_POLICY_IDS, DEFAULT_CODE_POLICY, COMMON_STRATEGIES,
  strategyMenu, strategyDetails, resolveStrategyChoice,
} from '../../tools/strategy-menu.mjs';
import { initializeConfig, strategyCommand, choosePolicyInteractively } from '../../tools/cli.mjs';
import { normalizeHumanConfig, humanPreflight } from '../../tools/keyteki-human-config.mjs';
import { collectRuntimeFiles } from '../../tools/freeze-keyteki-live.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-strategy-menu-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const initArgs = (dir) => ['--directory', dir, '--origin', 'https://keyteki.example',
  '--account', 'ExampleBot', '--server-deck-id', '123', '--deck-name', 'Example Deck'];
const cli = (packageRoot, args) => spawnSync(process.execPath,
  [path.join(packageRoot, 'bin/kf-auto.mjs'), ...args],
  { cwd: packageRoot, encoding: 'utf8', timeout: 10000 });

test('synchronous menu snapshot matches the actual built strategy registry exactly', () => {
  assert.deepEqual(REGISTERED_CODE_POLICY_IDS, CODE_POLICY_IDS);
  assert.equal(new Set(REGISTERED_CODE_POLICY_IDS).size, 89);
  assert.equal(COMMON_STRATEGIES.length, 5);
  for (const row of COMMON_STRATEGIES) assert.ok(CODE_POLICY_IDS.includes(row.policyId));
  assert.equal(COMMON_STRATEGIES[0].policyId, DEFAULT_CODE_POLICY);
});

test('common and complete menus preserve every strategy without treating all entries as recommendations', () => {
  const common = JSON.parse(strategyCommand(['list', '--json']));
  const all = JSON.parse(strategyCommand(['list', '--all', '--json']));
  assert.equal(common.shownCount, 5);
  assert.equal(all.shownCount, 89);
  assert.deepEqual(new Set(all.strategies.map((x) => x.policyId)), new Set(CODE_POLICY_IDS));
  assert.equal(common.strategies.filter((x) => x.default).length, 1);
  assert.ok(common.strategies.every((x) => x.group === 'common' && x.historicalRating.currentImplementationMayDiffer));
  assert.ok(!common.strategies.some((x) => x.policyId === 'tactical-ladder-balanced-v2'));
  assert.equal(strategyDetails('tactical-ladder-balanced-v2').group, 'advanced');
  assert.equal(strategyDetails('tullibint-well-island-guided-v5').group, 'specialized');
  assert.equal(strategyDetails('random').historicalRating, null);
  assert.match(strategyCommand(['show', 'tactical-dok-combined-v1']), /CodeStrategyContext/);
  assert.match(strategyCommand(['list']), /历史本地同池测试/);
  assert.throws(() => strategyCommand(['show', 'not-registered']), /CODE_POLICY_UNAVAILABLE/);
  assert.throws(() => strategyCommand(['show']), /STRATEGY_ID_REQUIRED/);
  assert.throws(() => strategyCommand(['list', '--al']), /STRATEGY_LIST_OPTIONS/);
  assert.throws(() => strategyCommand(['list', '--all', '--all']), /STRATEGY_LIST_OPTIONS/);
});

test('public Elo data and frozen-runtime metadata agree with explicit denominators and historical scope', () => {
  const publicData = JSON.parse(fs.readFileSync(path.join(root, 'docs/data/strategy-elo-20261113.json'), 'utf8'));
  assert.deepEqual(STRATEGY_ELO_BENCHMARK, publicData);
  assert.equal(publicData.currentImplementationMayDiffer, true);
  assert.equal(publicData.totalGames, publicData.ratingGames + publicData.mirrorGames);
  assert.equal(publicData.rows.reduce((n, row) => n + row.wins, 0), publicData.ratingGames);
  assert.equal(publicData.rows.reduce((n, row) => n + row.losses, 0), publicData.ratingGames);
  for (const row of publicData.rows) {
    assert.ok(CODE_POLICY_IDS.includes(row.policyId));
    assert.equal(row.wins + row.losses, row.games);
    assert.equal(row.games, publicData.gamesPerPolicy);
    assert.ok(row.low95 < row.elo && row.elo < row.high95);
  }
  assert.equal(publicData.rows.at(-1).policyId, 'tactical-ladder-balanced-v2');
  assert.equal(publicData.rows.at(-1).elo.toFixed(1), '1438.8');
});

test('init rejects unavailable, missing, duplicate and conflicting policy choices before writing any files', (t) => {
  const parent = temp(t);
  const cases = [
    [['--policy', 'valid-but-unregistered'], /CODE_POLICY_UNAVAILABLE/],
    [['--policy'], /MISSING_POLICY/],
    [['--policy', '--headful'], /MISSING_POLICY/],
    [['--policy', 'random', '--policy', 'greedy'], /POLICY_OPTION_DUPLICATED/],
    [['--choose-policy', '--choose-policy'], /POLICY_OPTION_DUPLICATED/],
    [['--policy', 'random', '--choose-policy'], /POLICY_SELECTION_CONFLICT/],
  ];
  cases.forEach(([flags, error], i) => {
    const directory = path.join(parent, 'invalid-' + i);
    assert.throws(() => initializeConfig([...initArgs(directory), ...flags]), error);
    assert.equal(fs.existsSync(directory), false);
  });
  const directory = path.join(parent, 'valid');
  const result = initializeConfig([...initArgs(directory), '--policy', 'tactical-card-effects-v3']);
  assert.equal(result.codePolicy, 'tactical-card-effects-v3');
  const seat = JSON.parse(fs.readFileSync(result.config, 'utf8'));
  assert.equal(seat.self.codePolicy, result.codePolicy);
  assert.equal(fs.statSync(result.credentials).mode & 0o777, 0o600);
  assert.throws(() => initializeConfig(initArgs(directory)), /CONFIG_DIRECTORY_ALREADY_EXISTS/);
});

test('preflight rejects unregistered policy IDs before browser or output creation', (t) => {
  const directory = path.join(temp(t), 'settings');
  const result = initializeConfig(initArgs(directory));
  const seat = JSON.parse(fs.readFileSync(result.config, 'utf8'));
  seat.self.codePolicy = 'valid-but-unregistered';
  assert.throws(() => normalizeHumanConfig(seat, { createPublic: true }), /CODE_POLICY_UNAVAILABLE/);
  assert.throws(() => humanPreflight(seat, { createPublic: true }), /CODE_POLICY_UNAVAILABLE/);
  assert.equal(fs.existsSync(seat.output), false);
  fs.writeFileSync(result.config, JSON.stringify(seat));
  const invoked = cli(root, ['preflight', '--config', result.config, '--create-public']);
  assert.notEqual(invoked.status, 0);
  assert.match(invoked.stderr, /CODE_POLICY_UNAVAILABLE/);
  assert.equal(fs.existsSync(seat.output), false);
});

test('menu answers accept whole in-range integers or exact registered IDs', () => {
  assert.equal(resolveStrategyChoice(''), DEFAULT_CODE_POLICY);
  assert.equal(resolveStrategyChoice('  '), DEFAULT_CODE_POLICY);
  assert.equal(resolveStrategyChoice('2'), 'tactical-toc-v2');
  assert.equal(resolveStrategyChoice('tactical-ladder-balanced'), 'tactical-ladder-balanced');
  for (const value of ['0', '6', '-1', '01', '2oops', '1.5', 'not-registered'])
    assert.equal(resolveStrategyChoice(value), undefined);
});

test('interactive init rejects non-TTY input without creating a configuration directory', async (t) => {
  const directory = path.join(temp(t), 'not-created');
  await assert.rejects(choosePolicyInteractively({ input: { isTTY: false }, output: { isTTY: false } }), /INTERACTIVE_TERMINAL_REQUIRED/);
  const result = cli(root, ['init', ...initArgs(directory), '--choose-policy']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INTERACTIVE_TERMINAL_REQUIRED/);
  assert.equal(fs.existsSync(directory), false);
});

test('interactive selection handles a valid answer, EOF and cancellation without hanging', { timeout: 5000 }, async () => {
  for (const mode of ['answer', 'eof', 'cancel']) {
    const input = new PassThrough(), output = new PassThrough();
    input.isTTY = true; output.isTTY = true; output.columns = 100;
    output.resume();
    const chosen = choosePolicyInteractively({ input, output });
    setImmediate(() => mode === 'answer' ? input.write('4\n') : mode === 'eof' ? input.end() : input.write('\x03'));
    try {
      if (mode === 'answer') assert.equal(await chosen, 'tactical-card-effects-v4');
      else await assert.rejects(chosen, /POLICY_SELECTION_CANCELLED/);
    } finally { input.destroy(); output.destroy(); }
  }
});

test('menu and preflight work with installed dependencies but no build; frozen shape needs no src or Git', (t) => {
  const isolated = path.join(temp(t), 'package');
  fs.mkdirSync(isolated);
  fs.cpSync(path.join(root, 'tools'), path.join(isolated, 'tools'), { recursive: true });
  fs.cpSync(path.join(root, 'bin'), path.join(isolated, 'bin'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, file), path.join(isolated, file));
  // Match npm ci's real production closure; the CLI deliberately depends on Playwright.
  // This fixture owns these copies and removes them on success or failure.
  const dependencies = collectRuntimeFiles(root).filter((row) => row.path.startsWith('node_modules/'));
  assert.ok(dependencies.length > 0);
  assert.ok(dependencies.reduce((n, row) => n + row.bytes, 0) < 128 * 1024 ** 2);
  for (const row of dependencies) {
    const target = path.join(isolated, row.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, row.path), target);
  }
  const listed = cli(isolated, ['strategies', 'list', '--all', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).shownCount, 89);
  const initialized = cli(isolated, ['init', ...initArgs(path.join(isolated, 'settings')), '--policy', 'tactical-toc-v2']);
  assert.equal(initialized.status, 0, initialized.stderr);
  const config = JSON.parse(initialized.stdout).config;
  const missing = cli(isolated, ['preflight', '--config', config, '--create-public']);
  assert.equal(missing.status, 0, missing.stderr);
  const report = JSON.parse(missing.stdout);
  assert.equal(report.readyForExplicitRun, false);
  assert.equal(report.credentialContentsRead, false);
  assert.ok(report.files.some((row) => row.name.startsWith('dist/') && !row.available));
  fs.cpSync(path.join(root, 'dist'), path.join(isolated, 'dist'), { recursive: true });
  const frozen = cli(isolated, ['strategies', 'show', 'tactical-style-engine-v3', '--json']);
  assert.equal(frozen.status, 0, frozen.stderr);
  assert.equal(JSON.parse(frozen.stdout).default, true);
  const files = collectRuntimeFiles(isolated, { includeDependencies: false }).map((row) => row.path);
  assert.ok(files.includes('tools/strategy-menu.mjs'));
  assert.ok(files.includes('tools/strategy-benchmark.mjs'));
  assert.equal(fs.existsSync(path.join(isolated, 'src')), false);
  assert.equal(fs.existsSync(path.join(isolated, '.git')), false);
});
