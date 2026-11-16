#!/usr/bin/env node
/** Freeze only this standalone runtime and production dependencies. Account/profile/output files are excluded. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimeExecutables } from './runtime-executables.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
function walk(directory) {
  const files = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isSymbolicLink()) fail('RUNTIME_SYMLINK_UNSUPPORTED');
    if (item.isDirectory()) files.push(...walk(file));
    else if (item.isFile()) files.push(file);
    else fail('RUNTIME_NONREGULAR_FILE');
  }
  return files;
}
const relativeInside = (root, file) => {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..'))
    fail('RUNTIME_FILE_OUTSIDE_PACKAGE');
  return relative.split(path.sep).join('/');
};
/** The allowlist is explicit. No walk of the project root, private state, examples, test, or source engine. */
export function collectRuntimeFiles(root, { includeDependencies = true } = {}) {
  root = path.resolve(root);
  const files = new Set(['package.json', 'package-lock.json']);
  for (const directory of ['tools', 'dist/src']) {
    const base = path.join(root, directory);
    if (fs.lstatSync(base).isSymbolicLink()) fail('RUNTIME_SYMLINK_UNSUPPORTED');
    for (const file of walk(base)) {
      const name = relativeInside(root, file);
      if (!/\.(?:mjs|js)$/.test(name) || /(?:\.test\.|-smoke\.|-witness\.)/.test(name)) continue;
      if (name.startsWith('dist/src/core/') || name.startsWith('dist/src/server/'))
        fail('REPLICA_RUNTIME_FORBIDDEN');
      files.add(name);
    }
  }
  if (fs.existsSync(path.join(root, 'LICENSE'))) files.add('LICENSE');
  if (fs.existsSync(path.join(root, 'bin/kf-auto.mjs'))) files.add('bin/kf-auto.mjs');
  const dependencyRoots = new Set();
  const visitDependency = (name, from, optional = false) => {
    const require = createRequire(path.join(from, 'package.json'));
    let manifest;
    try {
      manifest = require.resolve(name + '/package.json');
    } catch (error) {
      if (optional && error.code === 'MODULE_NOT_FOUND') return;
      throw error;
    }
    const directory = path.dirname(manifest);
    const relative = relativeInside(root, directory);
    if (!relative.startsWith('node_modules/') && !relative.includes('/node_modules/'))
      fail('RUNTIME_DEPENDENCY_OUTSIDE_PACKAGE');
    if (fs.realpathSync(directory) !== directory) fail('RUNTIME_DEPENDENCY_SYMLINK_UNSUPPORTED');
    if (dependencyRoots.has(directory)) return;
    dependencyRoots.add(directory);
    const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const file of walk(directory)) files.add(relativeInside(root, file));
    for (const child of Object.keys(metadata.dependencies ?? {})) visitDependency(child, directory);
    for (const child of Object.keys(metadata.optionalDependencies ?? {}))
      visitDependency(child, directory, true);
  };
  if (includeDependencies) {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const name of Object.keys(metadata.dependencies ?? {})) visitDependency(name, root);
  }
  return [...files].sort().map((name) => {
    const file = path.join(root, name),
      stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('RUNTIME_NONREGULAR_FILE');
    return { path: name, bytes: stat.size, sha256: sha(fs.readFileSync(file)) };
  });
}
function externalExecutionFiles(executables) {
  const executable = executables.chromium;
  const files = new Set([executables.node, executables.python]);
  // A Playwright-managed browser includes resources beside the binary; system browsers pin their executable only.
  if (/[\\/]ms-playwright[\\/]/.test(executable))
    for (const file of walk(path.dirname(executable))) files.add(file);
  else files.add(executable);
  return [...files].sort();
}
export function freezeRuntime({
  root = ROOT,
  output,
  externalFiles,
  executables = resolveRuntimeExecutables,
} = {}) {
  root = path.resolve(root);
  if (!path.isAbsolute(output ?? '') || path.resolve(output) === root) fail('ABSOLUTE_NEW_RUNTIME_REQUIRED');
  output = path.resolve(output);
  if (fs.existsSync(output)) fail('RUNTIME_ALREADY_EXISTS');
  const relativeOutput = path.relative(root, output);
  if (
    ['tools', 'dist', 'node_modules', 'src'].some(
      (name) => relativeOutput === name || relativeOutput.startsWith(name + path.sep),
    )
  )
    fail('RUNTIME_OUTPUT_INSIDE_INPUT');
  const files = collectRuntimeFiles(root);
  const execution = executables();
  if (!execution || !['node', 'python', 'chromium'].every((key) => path.isAbsolute(execution[key] ?? '')))
    fail('RUNTIME_EXECUTABLES_INVALID');
  const external = (externalFiles ?? externalExecutionFiles(execution)).map((file) => {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) fail('EXTERNAL_RUNTIME_FILE_INVALID');
    return { path: file, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) };
  });
  if (
    !external.length ||
    !Object.values(execution).every((file) => external.some((row) => row.path === file))
  )
    fail('EXTERNAL_RUNTIME_FREEZE_REQUIRED');
  const sourceFingerprint = sha(JSON.stringify(files));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const staging = path.join(path.dirname(output), '.' + path.basename(output) + '.partial-' + randomUUID());
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const row of files) {
      const source = path.join(root, row.path),
        target = path.join(staging, row.path);
      if (sha(fs.readFileSync(source)) !== row.sha256) fail('RUNTIME_INPUT_CHANGED');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      if (sha(fs.readFileSync(target)) !== row.sha256) fail('RUNTIME_COPY_CHANGED');
    }
    if (JSON.stringify(collectRuntimeFiles(root)) !== JSON.stringify(files)) fail('RUNTIME_INPUT_CHANGED');
    for (const row of external)
      if (sha(fs.readFileSync(row.path)) !== row.sha256) fail('EXTERNAL_RUNTIME_INPUT_CHANGED');
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const manifest = {
      schema: 'kf-live-runtime-freeze-v1',
      root: output,
      sourceCommit: null,
      sourceFingerprint,
      packageName: metadata.name,
      packageVersion: metadata.version,
      createdAt: new Date().toISOString(),
      node: process.version,
      copied: ['allowlisted tools and compiled src', 'production npm dependency closure', 'package metadata'],
      excluded: [
        'credentials',
        'browser profiles',
        'connection files',
        'campaigns',
        'tests',
        'source engine',
        'Git metadata',
      ],
      files,
      externalFiles: external,
      executables: execution,
      qualification:
        'Runtime content hashes identify this installation. No Git commit or hermetic operating-system image is asserted. External paths belong to the local installation and are not public release assets.',
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(staging, 'runtime-manifest.json'), manifestBytes, { mode: 0o600, flag: 'wx' });
    // Exclusive output allocation avoids replacing another published runtime directory.
    fs.mkdirSync(output, { mode: 0o700 });
    try {
      for (const name of fs.readdirSync(staging).filter((name) => name !== 'runtime-manifest.json'))
        fs.renameSync(path.join(staging, name), path.join(output, name));
      fs.renameSync(path.join(staging, 'runtime-manifest.json'), path.join(output, 'runtime-manifest.json'));
      fs.rmdirSync(staging);
    } catch (error) {
      throw error;
    }
    return {
      output,
      sourceFingerprint,
      runtimeManifest: path.join(output, 'runtime-manifest.json'),
      runtimeManifestSha256: sha(manifestBytes),
      files: files.length,
      externalFiles: external.length,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    // A partial output is retained for inspection; no pre-existing path is overwritten or deleted.
    throw error;
  }
}
export function freezeCli(args = process.argv.slice(2)) {
  const i = args.indexOf('--output');
  if (i < 0 || !args[i + 1]) fail('ABSOLUTE_NEW_RUNTIME_REQUIRED');
  return freezeRuntime({ output: args[i + 1] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(freezeCli(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify({ event: 'runtime-freeze-failed', code: error.code ?? 'RUNTIME_FREEZE_FAILED' }),
    );
    process.exitCode = 1;
  }
}
