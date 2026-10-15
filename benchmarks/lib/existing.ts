import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseCandidates, privateJson } from './contracts.js';

export async function importExisting(repository: string, runDirectory: string) {
  const copyRoot = path.join(runDirectory, 'provider-snapshot');
  const config = path.join(copyRoot, 'config');
  fs.mkdirSync(config, { recursive: true, mode: 0o700 });
  try {
    const source = path.resolve(
      process.env.BENCH_EXISTING_DATA_DIR || path.join(repository, 'data'),
    );
    for (const name of ['claude-provider.json', 'claude-provider.key']) {
      const target = path.join(config, name);
      fs.copyFileSync(path.join(source, 'config', name), target);
      fs.chmodSync(target, 0o600);
    }
    const imported = await new Promise<Array<Record<string, any>>>(
      (resolve, reject) => {
        const child = fork(
          path.join(repository, 'benchmarks/scripts/read-existing.ts'),
          [],
          {
            cwd: copyRoot,
            execArgv: [
              '--import',
              pathToFileURL(
                path.join(repository, 'node_modules/tsx/dist/loader.mjs'),
              ).href,
            ],
            env: {
              PATH: process.env.PATH,
              HOME: copyRoot,
              COMMERCEAGENT_DATA_DIR: copyRoot,
              LOG_LEVEL: 'silent',
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('candidate_import_timeout'));
        }, 15000);
        let value: Array<Record<string, any>> | null = null;
        child.on('message', (message) => {
          if (Array.isArray(message)) value = message;
        });
        child.on('error', () => {
          clearTimeout(timer);
          reject(new Error('candidate_import_failed'));
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0 && value) resolve(value);
          else reject(new Error('candidate_import_failed'));
        });
      },
    );
    const candidates = parseCandidates(imported);
    for (const item of imported) process.env[item.apiKeyEnv] = item.credential;
    // Reproducible private mapping; plaintext credentials stay in memory only.
    privateJson(path.join(runDirectory, 'candidates.json'), candidates);
    return candidates;
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
}
