#!/usr/bin/env node
import { runCli } from '../tools/cli.mjs';
runCli().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(JSON.stringify({ event: 'kf-auto-failed', code: error.code ?? 'COMMAND_FAILED' }));
    process.exitCode = 1;
  },
);
