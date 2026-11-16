/** Resolve this invocation's execution programs without launching a browser. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { browserExecutable } from './browser-provider.mjs';
export function resolveRuntimeExecutables() {
  const python = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 4096,
  }).trim();
  return {
    node: fs.realpathSync(process.execPath),
    python: fs.realpathSync(python),
    chromium: browserExecutable(),
  };
}
