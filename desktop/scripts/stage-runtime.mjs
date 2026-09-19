#!/usr/bin/env node
/**
 * Stage the backend runtime that ships inside the desktop app.
 *
 * The desktop app runs the backend on the Node runtime vendored in `vendor/`, so
 * the production dependencies must be installed with **that** runtime: native
 * modules (`better-sqlite3`, `node-pty`) carry the ABI of the Node that built
 * them, and a mismatch fails at import time with `NODE_MODULE_VERSION ...`.
 *
 * This is also why `npmRebuild` is disabled in `electron-builder.yml`: the shell
 * itself has no native dependencies, and rebuilding the backend tree with
 * Electron's ABI would break the sidecar.
 *
 * Result layout (copied into `Resources/app` by electron-builder):
 *
 *   desktop/.runtime/{dist,web/dist,config,container,node_modules,package.json}
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');
const repoRoot = join(desktopDir, '..');
const stageDir = join(desktopDir, '.runtime');

const platform = process.platform;
const arch = process.arch === 'x64' ? 'x64' : 'arm64';
const nodeDir = join(desktopDir, 'vendor', `node-${platform}-${arch}`);
const nodeBinary = join(nodeDir, platform === 'win32' ? 'node.exe' : 'node');
const npmCli = join(nodeDir, 'npm', 'bin', 'npm-cli.js');

if (!existsSync(nodeBinary)) {
  throw new Error(
    `vendored Node runtime missing: ${nodeBinary} (run "npm run fetch-node" first)`,
  );
}
if (!existsSync(join(repoRoot, 'dist', 'index.js'))) {
  throw new Error(
    'backend build missing (run "npm run build" in the repository root first)',
  );
}
if (!existsSync(join(repoRoot, 'web', 'dist', 'index.html'))) {
  throw new Error(
    'web build missing (run "npm run build:web" in the repository root first)',
  );
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const entry of [
  'dist',
  'config',
  'container',
  'package.json',
  'package-lock.json',
]) {
  cpSync(join(repoRoot, entry), join(stageDir, entry), { recursive: true });
}
mkdirSync(join(stageDir, 'web'), { recursive: true });
cpSync(join(repoRoot, 'web', 'dist'), join(stageDir, 'web', 'dist'), {
  recursive: true,
});

console.log(
  `installing production dependencies with vendored Node ${execFileSync(nodeBinary, ['--version']).toString().trim()}`,
);
// The vendored Node must be first on PATH: prebuild-install/node-gyp resolve the
// target runtime by shelling out to `node`, and picking up the host Node would
// install prebuilt binaries for the wrong NODE_MODULE_VERSION.
const pathKey = platform === 'win32' ? 'Path' : 'PATH';
const vendorPath = `${nodeDir}${platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`;

execFileSync(
  nodeBinary,
  [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
  {
    cwd: stageDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      [pathKey]: vendorPath,
      npm_config_update_notifier: 'false',
    },
  },
);

console.log(`staged runtime at ${stageDir}`);
