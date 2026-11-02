#!/usr/bin/env node
/**
 * DLQ helper: `npm run dist:dlq -- list` / `npm run dist:dlq -- replay 3`.
 *
 * The logic lives in src/distributed/cli-dlq.ts so it can be typed and tested;
 * this wrapper just runs it under tsx.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(ROOT, 'src/distributed/cli-dlq.ts');

const child = spawn(
  process.execPath,
  ['--import', 'tsx', entry, ...process.argv.slice(2)],
  { cwd: ROOT, stdio: 'inherit' },
);
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
