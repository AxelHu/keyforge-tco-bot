/** Small local runtime records. Kernel-held profile lock; no persisted game snapshot. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export function readRuntimeJson(file, fallback = undefined) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw Error('Invalid runtime record');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function writeRuntimeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * flock belongs to the inherited open file description. Python acquires it on fd 3;
 * this Node process keeps the same descriptor open, so its exit releases the lock.
 * There is no PID guessing, stale-file deletion, or overlapping replacement process.
 */
export function acquireBridgeRuntime(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lockFile = path.join(root, 'runtime.lock');
  const fd = fs.openSync(lockFile, 'a+', 0o600);
  const result = spawnSync(
    'python3',
    [
      '-c',
      'import fcntl,sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000 },
  );
  if (result.status !== 0) {
    fs.closeSync(fd);
    throw Error(
      result.status === 73 ? 'Bridge profile already running' : 'Could not acquire bridge profile lock',
    );
  }
  const runId = randomBytes(16).toString('hex');
  const metadata = { schema: 1, pid: process.pid, runId, startedAt: new Date().toISOString() };
  fs.ftruncateSync(fd, 0);
  fs.writeFileSync(fd, JSON.stringify(metadata) + '\n');
  fs.fsyncSync(fd);
  let released = false;
  return {
    root,
    runId,
    metadata,
    connectionFile: path.join(root, 'connection.json'),
    checkpointFile: path.join(root, 'checkpoint.json'),
    release() {
      if (!released) {
        released = true;
        fs.closeSync(fd);
      }
    },
  };
}
