#!/usr/bin/env node
/**
 * Stage the backend runtime that ships inside the desktop app.
 *
 * The desktop app runs the backend (and the host-mode agent-runner) on the Node
 * runtime vendored in `vendor/`, so their production dependencies must be
 * installed with **that** runtime and with it first on PATH:
 *
 * - native modules (`better-sqlite3`, `node-pty`) carry the ABI of the Node that
 *   built them, and `prebuild-install`/`node-gyp` resolve the target runtime by
 *   shelling out to `node`; picking up the host Node installs the wrong
 *   `NODE_MODULE_VERSION`;
 * - this is also why `npmRebuild: false` is set in `electron-builder.yml`.
 *
 * After installation, artifacts for other platforms are pruned: prebuilt binaries
 * and source maps that the packaging target can never load.
 *
 * Result layout (copied into `Resources/app` by electron-builder):
 *
 *   desktop/.runtime/{dist,web/dist,config,container,node_modules,package.json}
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, '..');
const repoRoot = join(desktopDir, '..');

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--platform') options.platform = argv[++index];
    else if (argv[index] === '--arch') options.arch = argv[++index];
  }
  return options;
}

const cliArgs = parseArgs(process.argv.slice(2));
const platform = cliArgs.platform ?? process.platform;
const arch = (cliArgs.arch ?? process.arch) === 'x64' ? 'x64' : 'arm64';
const target = `${platform}-${arch}`;
const stageDir = join(desktopDir, `.runtime-${target}`);
const nodeDir = join(desktopDir, 'vendor', `node-${target}`);
const nodeBinary = join(nodeDir, platform === 'win32' ? 'node.exe' : 'node');
const npmCli = join(nodeDir, 'npm', 'bin', 'npm-cli.js');
const pathKey = platform === 'win32' ? 'Path' : 'PATH';

if (!existsSync(nodeBinary)) {
  throw new Error(
    `vendored Node runtime missing: ${nodeBinary} (run "npm run fetch-node" first)`,
  );
}
for (const required of [
  'dist/index.js',
  'web/dist/index.html',
  'container/agent-runner/package.json',
]) {
  if (!existsSync(join(repoRoot, required))) {
    throw new Error(
      `missing build output: ${required} (run "npm run build:all" in the repository root)`,
    );
  }
}

const installEnv = {
  ...process.env,
  [pathKey]: `${nodeDir}${platform === 'win32' ? ';' : ':'}${process.env[pathKey] ?? ''}`,
  npm_config_update_notifier: 'false',
};

function installProductionDeps(directory, label) {
  console.log(
    `installing ${label} production dependencies with ${execFileSync(nodeBinary, ['--version']).toString().trim()}`,
  );
  execFileSync(
    nodeBinary,
    [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
    {
      cwd: directory,
      stdio: 'inherit',
      env: installEnv,
    },
  );
}

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const entry of ['dist', 'config', 'package.json', 'package-lock.json']) {
  cpSync(join(repoRoot, entry), join(stageDir, entry), { recursive: true });
}
mkdirSync(join(stageDir, 'web'), { recursive: true });
cpSync(join(repoRoot, 'web', 'dist'), join(stageDir, 'web', 'dist'), {
  recursive: true,
});

// `container/` payload: the Docker assets plus the agent-runner that host mode
// spawns. Its dependencies are installed below rather than copied, so the
// packaged app does not carry devDependencies (TypeScript, tests, …).
mkdirSync(join(stageDir, 'container'), { recursive: true });
for (const entry of ['Dockerfile', 'entrypoint.sh', 'prompts']) {
  const source = join(repoRoot, 'container', entry);
  if (existsSync(source))
    cpSync(source, join(stageDir, 'container', entry), { recursive: true });
}
const runnerSource = join(repoRoot, 'container', 'agent-runner');
const runnerStage = join(stageDir, 'container', 'agent-runner');
mkdirSync(runnerStage, { recursive: true });
for (const entry of ['package.json', 'package-lock.json', 'dist', 'src']) {
  const source = join(runnerSource, entry);
  if (existsSync(source))
    cpSync(source, join(runnerStage, entry), { recursive: true });
}

installProductionDeps(stageDir, 'backend');
if (existsSync(join(runnerStage, 'package.json'))) {
  installProductionDeps(runnerStage, 'agent-runner');
}

/** Delete `entry` in `dir` when the predicate says it is for another platform. */
function pruneEntries(dir, predicate) {
  if (!existsSync(dir)) return 0;
  let freed = 0;
  for (const entry of readdirSync(dir)) {
    if (!predicate(entry)) continue;
    const full = join(dir, entry);
    freed += dirSizeKb(full);
    rmSync(full, { recursive: true, force: true });
  }
  return freed;
}

function dirSizeKb(target) {
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats === undefined) return 0;
  if (!stats.isDirectory()) return Math.ceil(stats.size / 1024);
  let total = 0;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    total += dirSizeKb(join(target, entry.name));
  }
  return total;
}

/**
 * Remove artifacts the packaged runtime cannot load: prebuilt binaries for other
 * operating systems and source maps. Deliberately a narrow allowlist — every
 * other file in the tree is something the backend may require at runtime.
 */
function pruneForTarget(root) {
  let freed = 0;
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.name.endsWith('.map')) {
          const full = join(dir, entry.name);
          freed += dirSizeKb(full);
          unlinkSync(full);
        }
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.name === 'node_modules') {
        freed += pruneEntries(
          join(full, 'node-pty', 'prebuilds'),
          (name) => name !== target,
        );
        freed += pruneEntries(
          join(full, '@img'),
          (name) => name.startsWith('sharp-') && !name.endsWith(target),
        );
        // Prebuilt browser binaries shipped for every platform.
        freed += pruneEntries(
          join(full, 'agent-browser', 'bin'),
          (name) =>
            /-(darwin|linux|linux-musl|win32)-(x64|arm64)(\.exe)?$/.test(
              name,
            ) && !name.includes(target),
        );
      }
      visit(full);
    }
  };
  visit(root);
  return freed;
}

const prunedKb = pruneForTarget(stageDir);
console.log(
  `pruned ${(prunedKb / 1024).toFixed(0)} MB (foreign-platform binaries + source maps); staged runtime is ${(dirSizeKb(stageDir) / 1024).toFixed(0)} MB`,
);
console.log(`staged runtime at ${stageDir}`);
