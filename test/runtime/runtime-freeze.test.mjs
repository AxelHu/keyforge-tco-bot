import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { collectRuntimeFiles, freezeRuntime } from '../../tools/freeze-keyteki-live.mjs';
import { verifyCampaignRuntime } from '../../tools/keyteki-live-campaign.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-freeze-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return file;
  };
  write(
    'package.json',
    JSON.stringify({ name: 'runtime-fixture', version: '1.0.0', type: 'module', dependencies: {} }),
  );
  write('package-lock.json', '{"lockfileVersion":3}\n');
  write('tools/keyteki-live-campaign.mjs', 'export const campaign = true;\n');
  write('tools/keyteki-live-campaign-worker.mjs', 'export const worker = true;\n');
  write('tools/cli.mjs', 'export const cli = true;\n');
  write('bin/kf-auto.mjs', 'import "../tools/cli.mjs";\n');
  write('dist/src/ai/style-policy-upgrades.js', 'export const policy = true;\n');
  write('dist/src/ai/loop-guard.js', 'export const guard = true;\n');
  const executable = write('fixture-executable', 'not-executed\n');
  const executables = () => ({ node: executable, python: executable, chromium: executable });
  return { root, write, executable, executables };
}
test('freeze allowlist excludes private state, account examples, tests and research source', (t) => {
  const f = fixture(t);
  for (const name of [
    '.state/credentials.json',
    'examples/credentials.json',
    'test/runtime/private.test.mjs',
    'src/core/engine.ts',
    'artifacts/old/result.json',
    'tools/not-runtime.test.mjs',
  ])
    f.write(name, 'PRIVATE_FIXTURE_MARKER');
  const paths = collectRuntimeFiles(f.root).map((row) => row.path);
  assert.ok(paths.includes('bin/kf-auto.mjs'));
  assert.ok(paths.includes('tools/keyteki-live-campaign.mjs'));
  assert.ok(paths.includes('dist/src/ai/loop-guard.js'));
  assert.ok(
    paths.every(
      (name) =>
        !name.startsWith('.state/') &&
        !name.startsWith('examples/') &&
        !name.startsWith('test/') &&
        !name.startsWith('src/') &&
        !name.startsWith('artifacts/') &&
        !name.includes('.test.'),
    ),
  );
});
test('compiled replica code and symlinked runtime inputs fail closed', (t) => {
  const f = fixture(t);
  const engine = f.write('dist/src/core/engine.js', 'export const forbidden = true;');
  assert.throws(() => collectRuntimeFiles(f.root), /REPLICA_RUNTIME_FORBIDDEN/);
  fs.unlinkSync(engine);
  const outside = f.write('private/secret.txt', 'not-a-runtime-input');
  fs.symlinkSync(outside, path.join(f.root, 'tools/linked.mjs'));
  assert.throws(() => collectRuntimeFiles(f.root), /RUNTIME_SYMLINK_UNSUPPORTED/);
});
test('only production dependency closure is included, with transitive packages', (t) => {
  const f = fixture(t);
  f.write(
    'package.json',
    JSON.stringify({
      name: 'runtime-fixture',
      type: 'module',
      dependencies: { 'kf-fixture-a': '1.0.0' },
      devDependencies: { 'kf-fixture-dev': '1.0.0' },
    }),
  );
  f.write(
    'node_modules/kf-fixture-a/package.json',
    JSON.stringify({ name: 'kf-fixture-a', version: '1.0.0', dependencies: { 'kf-fixture-b': '1.0.0' } }),
  );
  f.write('node_modules/kf-fixture-a/index.js', 'export const a = 1;');
  f.write(
    'node_modules/kf-fixture-b/package.json',
    JSON.stringify({ name: 'kf-fixture-b', version: '1.0.0' }),
  );
  f.write('node_modules/kf-fixture-b/index.js', 'export const b = 1;');
  f.write(
    'node_modules/kf-fixture-dev/package.json',
    JSON.stringify({ name: 'kf-fixture-dev', version: '1.0.0' }),
  );
  const paths = collectRuntimeFiles(f.root).map((row) => row.path);
  assert.ok(paths.includes('node_modules/kf-fixture-a/index.js'));
  assert.ok(paths.includes('node_modules/kf-fixture-b/index.js'));
  assert.ok(!paths.some((name) => name.startsWith('node_modules/kf-fixture-dev/')));
});
test('frozen package verifies without Git and detects changed runtime or external execution bytes', (t) => {
  const f = fixture(t),
    output = path.join(f.root, 'runtimes/example');
  const result = freezeRuntime({
    root: f.root,
    output,
    externalFiles: [f.executable],
    executables: f.executables,
  });
  const config = {
    runtimeManifest: result.runtimeManifest,
    runtimeManifestSha256: result.runtimeManifestSha256,
  };
  const manifest = JSON.parse(fs.readFileSync(result.runtimeManifest, 'utf8'));
  assert.equal(manifest.sourceCommit, null);
  assert.match(manifest.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(
    verifyCampaignRuntime(config, { root: output, resolveExecutables: f.executables }).manifestSha256,
    result.runtimeManifestSha256,
  );
  assert.throws(
    () =>
      verifyCampaignRuntime(config, {
        root: output,
        resolveExecutables: () => ({ ...f.executables(), chromium: '/virtual/different-chromium' }),
      }),
    /RUNTIME_EXECUTABLE_SELECTION_CHANGED/,
  );
  const file = path.join(output, 'tools/keyteki-live-campaign.mjs'),
    before = fs.readFileSync(file);
  fs.appendFileSync(file, '// changed');
  assert.throws(
    () => verifyCampaignRuntime(config, { root: output, resolveExecutables: f.executables }),
    /RUNTIME_BYTES_CHANGED/,
  );
  fs.writeFileSync(file, before);
  fs.appendFileSync(f.executable, 'changed');
  assert.throws(
    () => verifyCampaignRuntime(config, { root: output, resolveExecutables: f.executables }),
    /EXTERNAL_RUNTIME_BYTES_CHANGED/,
  );
  assert.throws(
    () => freezeRuntime({ root: f.root, output, externalFiles: [f.executable], executables: f.executables }),
    /RUNTIME_ALREADY_EXISTS/,
  );
  assert.ok(fs.readFileSync(result.runtimeManifest, 'utf8').includes(result.sourceFingerprint));
});
test('runtime output cannot become one of its own input trees', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      freezeRuntime({
        root: f.root,
        output: path.join(f.root, 'tools/new-runtime'),
        externalFiles: [f.executable],
        executables: f.executables,
      }),
    /RUNTIME_OUTPUT_INSIDE_INPUT/,
  );
});

test('an added nested dependency that shadows a frozen require is rejected even when every old hash matches', (t) => {
  const f = fixture(t);
  f.write(
    'package.json',
    JSON.stringify({ name: 'runtime-fixture', type: 'module', dependencies: { 'kf-fixture-a': '1.0.0' } }),
  );
  f.write(
    'node_modules/kf-fixture-a/package.json',
    JSON.stringify({ name: 'kf-fixture-a', main: 'index.cjs', dependencies: { 'kf-fixture-b': '1.0.0' } }),
  );
  f.write('node_modules/kf-fixture-a/index.cjs', "module.exports = require('kf-fixture-b');");
  f.write(
    'node_modules/kf-fixture-b/package.json',
    JSON.stringify({ name: 'kf-fixture-b', main: 'index.cjs' }),
  );
  f.write('node_modules/kf-fixture-b/index.cjs', "module.exports = 'original';");
  const output = path.join(f.root, 'runtimes/shadow-check');
  const frozen = freezeRuntime({
    root: f.root,
    output,
    externalFiles: [f.executable],
    executables: f.executables,
  });
  const config = {
    runtimeManifest: frozen.runtimeManifest,
    runtimeManifestSha256: frozen.runtimeManifestSha256,
  };
  assert.doesNotThrow(() =>
    verifyCampaignRuntime(config, { root: output, resolveExecutables: f.executables }),
  );
  const nested = path.join(output, 'node_modules/kf-fixture-a/node_modules/kf-fixture-b');
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(
    path.join(nested, 'package.json'),
    JSON.stringify({ name: 'kf-fixture-b', main: 'index.cjs' }),
  );
  fs.writeFileSync(path.join(nested, 'index.cjs'), "module.exports = 'shadow';");
  const consumer = createRequire(path.join(output, 'node_modules/kf-fixture-a/index.cjs'));
  assert.equal(consumer.resolve('kf-fixture-b'), path.join(nested, 'index.cjs'));
  const manifest = JSON.parse(fs.readFileSync(frozen.runtimeManifest, 'utf8'));
  for (const row of manifest.files)
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(output, row.path)))
        .digest('hex'),
      row.sha256,
    );
  assert.throws(
    () => verifyCampaignRuntime(config, { root: output, resolveExecutables: f.executables }),
    /RUNTIME_FILE_SET_CHANGED/,
  );
});
