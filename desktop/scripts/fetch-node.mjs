#!/usr/bin/env node
/**
 * Download the official Node runtime used to run the bundled backend sidecar.
 *
 * Why a separate stock Node instead of Electron's own runtime
 * (`ELECTRON_RUN_AS_NODE=1`): the backend depends on the native modules
 * `better-sqlite3` and `node-pty`. Those are built for the Node ABI; reusing
 * Electron's ABI would force an `electron-rebuild` per platform and per arch.
 * Bundling stock Node keeps the backend byte-identical to its normal deployment.
 *
 * Usage: node scripts/fetch-node.mjs [--platform darwin|win32] [--arch arm64|x64]
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const NODE_VERSION = process.env.DESKTOP_NODE_VERSION ?? '22.13.0';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');
const vendorDir = join(desktopDir, 'vendor');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--platform') options.platform = argv[++index];
    else if (key === '--arch') options.arch = argv[++index];
  }
  return options;
}

const platform = parseArgs(process.argv.slice(2)).platform ?? process.platform;
const arch = parseArgs(process.argv.slice(2)).arch ?? os.arch();
const archLabel = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;

const distName = `node-v${NODE_VERSION}-${platform === 'win32' ? 'win' : platform}-${archLabel}`;
const archiveName = `${distName}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
const targetDir = join(vendorDir, `node-${platform}-${archLabel}`);

if (existsSync(join(targetDir, platform === 'win32' ? 'node.exe' : 'node'))) {
  console.log(`node runtime already vendored: ${targetDir}`);
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });
const tmpRoot = join(os.tmpdir(), `commerceagent-node-${Date.now()}`);
mkdirSync(tmpRoot, { recursive: true });
const archivePath = join(tmpRoot, archiveName);

console.log(`downloading ${url}`);
const response = await fetch(url);
if (!response.ok)
  throw new Error(`download failed: ${response.status} ${response.statusText}`);
// `fetch` returns a Web Stream; write the archive in one shot (tens of MB).
writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()));

if (archiveName.endsWith('.zip')) {
  // PowerShell keeps the dependency surface small on Windows runners.
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpRoot}' -Force`,
    ],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('tar', ['-xzf', archivePath, '-C', tmpRoot], {
    stdio: 'inherit',
  });
}

const extracted = join(tmpRoot, distName);
const binaryName = platform === 'win32' ? 'node.exe' : 'node';
const sourceBinary = join(
  extracted,
  platform === 'win32' ? 'node.exe' : join('bin', 'node'),
);
if (!existsSync(sourceBinary)) {
  throw new Error(
    `unexpected archive layout, missing ${sourceBinary} (found: ${readdirSync(extracted).join(', ')})`,
  );
}
cpSync(sourceBinary, join(targetDir, binaryName));
// npm travels with the runtime so packaging always installs production
// dependencies with exactly this Node ABI (avoids NODE_MODULE_VERSION drift).
// Windows archives keep npm at the archive root instead of under lib/.
const npmDir = [
  join(extracted, 'lib', 'node_modules', 'npm'),
  join(extracted, 'node_modules', 'npm'),
].find((candidate) => existsSync(candidate));
if (npmDir !== undefined)
  cpSync(npmDir, join(targetDir, 'npm'), { recursive: true });
// Keep the license next to the runtime: redistributing Node requires it.
const licenseSource =
  platform === 'win32'
    ? join(extracted, 'LICENSE')
    : join(extracted, 'LICENSE');
if (existsSync(licenseSource))
  cpSync(licenseSource, join(targetDir, 'LICENSE'));
rmSync(tmpRoot, { recursive: true, force: true });
console.log(
  `vendored ${statSync(join(targetDir, binaryName)).size} bytes -> ${join(targetDir, binaryName)}`,
);
