#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';

const MANAGED_BACKUP_COMPONENTS = [
  'config',
  'groups',
  'sessions',
  'skills',
  'mcp-servers',
  'plugins',
  'memory',
  'avatars',
  'extra',
  'builtin-skills',
  'db',
];
const TAR_LISTING_BUFFER_LIMIT = 64 * 1024 * 1024;

function usage() {
  console.error(
    'Usage:\n' +
      '  node scripts/restore-backup.mjs assert-port-free <port>\n' +
      '  node scripts/restore-backup.mjs restore <archive.tar.gz> <data-dir> <port>',
  );
  process.exit(2);
}

function parsePort(raw) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid service port: ${raw}`);
  }
  return port;
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function assertPortFree(port) {
  const listening =
    (await canConnect('127.0.0.1', port)) || (await canConnect('::1', port));
  if (listening) {
    throw new Error(
      `Refusing to restore while a service is listening on port ${port}. Stop CommerceAgent first (make stop).`,
    );
  }
}

function runTar(args, errorPrefix) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: TAR_LISTING_BUFFER_LIMIT,
  });
  if (result.error?.code === 'ENOBUFS') {
    throw new Error(
      `${errorPrefix}: archive listing exceeds the ${TAR_LISTING_BUFFER_LIMIT / 1024 / 1024} MiB safety limit`,
    );
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${errorPrefix}: ${(result.stderr || result.stdout || 'tar failed').trim()}`,
    );
  }
  return result.stdout;
}

function validateArchiveEntries(archivePath) {
  const listing = runTar(
    ['-tzf', archivePath],
    'Unable to read backup archive',
  );
  const verboseListing = runTar(
    ['-tvzf', archivePath],
    'Unable to inspect backup archive types',
  );
  const entries = listing.split('\n').filter(Boolean);
  const entryTypes = verboseListing.split('\n').filter(Boolean);
  if (entries.length === 0) throw new Error('Backup archive is empty');
  if (entryTypes.length !== entries.length) {
    throw new Error('Unable to validate every backup archive entry');
  }
  for (const line of entryTypes) {
    // Tar verbose listings start with the entry type from the mode string.
    // Backups only need regular files and directories. Reject links, devices,
    // FIFOs and any future special type before extraction so an archive cannot
    // redirect writes outside the staging directory.
    if (line[0] !== '-' && line[0] !== 'd') {
      throw new Error(`Unsafe backup archive entry type: ${line[0] || '?'}`);
    }
  }
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
    const segments = normalized.split('/');
    if (
      normalized.startsWith('/') ||
      segments.includes('..') ||
      (normalized !== 'data' && !normalized.startsWith('data/'))
    ) {
      throw new Error(`Unsafe backup archive entry: ${entry}`);
    }
  }
}

function validateExtractedTree(rootDir) {
  const pending = [rootDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`Unsafe extracted backup entry: ${candidate}`);
      }
      if (stat.isDirectory()) pending.push(candidate);
    }
  }
}

function hardenSensitivePermissions(stagedDataDir) {
  for (const component of ['config', 'sessions', 'db']) {
    const rootDir = path.join(stagedDataDir, component);
    if (!fs.existsSync(rootDir)) continue;
    const pending = [rootDir];
    while (pending.length > 0) {
      const current = pending.pop();
      fs.chmodSync(current, 0o700);
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) {
          pending.push(candidate);
        } else {
          fs.chmodSync(candidate, 0o600);
        }
      }
    }
  }
}

function validateDatabase(dbPath) {
  const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const result = probe.pragma('integrity_check', { simple: true });
    if (result !== 'ok') {
      throw new Error(
        `Restored SQLite integrity_check failed: ${String(result)}`,
      );
    }
  } finally {
    probe.close();
  }
}

function restoreRecordedSymlinks(stagedDataDir) {
  const metadataPath = path.join(stagedDataDir, 'backup-symlinks.json');
  if (!fs.existsSync(metadataPath)) return;
  const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (parsed?.formatVersion !== 1 || !Array.isArray(parsed.links)) {
    throw new Error('Unsupported or malformed backup symlink metadata');
  }
  if (parsed.links.length > 100_000) {
    throw new Error('Backup contains too many symbolic links');
  }

  const seen = new Set();
  const normalizedLinks = parsed.links.map((link) => {
    if (
      !link ||
      typeof link.path !== 'string' ||
      typeof link.target !== 'string' ||
      link.path.length === 0 ||
      link.target.length === 0 ||
      link.path.includes('\\') ||
      path.posix.isAbsolute(link.path) ||
      path.isAbsolute(link.target)
    ) {
      throw new Error('Backup contains invalid symbolic link metadata');
    }
    const segments = link.path.split('/');
    if (
      segments.some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
      !MANAGED_BACKUP_COMPONENTS.includes(segments[0]) ||
      seen.has(link.path)
    ) {
      throw new Error(`Unsafe backup symbolic link path: ${link.path}`);
    }
    seen.add(link.path);
    return link;
  });

  for (const link of normalizedLinks) {
    const segments = link.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      if (seen.has(segments.slice(0, index).join('/'))) {
        throw new Error(
          `Backup symbolic link is nested beneath another link: ${link.path}`,
        );
      }
    }
    const candidate = path.join(stagedDataDir, ...segments);
    const resolvedTarget = path.resolve(path.dirname(candidate), link.target);
    const relativeTarget = path.relative(stagedDataDir, resolvedTarget);
    if (
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      throw new Error(
        `Backup symbolic link escapes restored data: ${link.path}`,
      );
    }
    const parent = path.dirname(candidate);
    if (!fs.statSync(parent, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Backup symbolic link parent is missing: ${link.path}`);
    }
    if (fs.existsSync(candidate)) {
      throw new Error(
        `Backup symbolic link collides with an archive entry: ${link.path}`,
      );
    }
  }

  for (const link of normalizedLinks) {
    fs.symlinkSync(
      link.target,
      path.join(stagedDataDir, ...link.path.split('/')),
    );
  }
}

function readBackupManifest(stagedDataDir) {
  const manifestPath = path.join(stagedDataDir, 'backup-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // Backups created before format v2 were partial. Preserve their historical
    // behavior instead of deleting components they never knew how to capture.
    return {
      authoritative: false,
      managedComponents: MANAGED_BACKUP_COMPONENTS,
      presentComponents: MANAGED_BACKUP_COMPONENTS.filter((component) =>
        fs.existsSync(path.join(stagedDataDir, component)),
      ),
    };
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (
    parsed?.formatVersion !== 2 ||
    !Array.isArray(parsed.managedComponents) ||
    !Array.isArray(parsed.presentComponents)
  ) {
    throw new Error('Unsupported or malformed backup manifest');
  }
  const allowed = new Set(MANAGED_BACKUP_COMPONENTS);
  const managedComponents = [...new Set(parsed.managedComponents)];
  const presentComponents = [...new Set(parsed.presentComponents)];
  if (
    managedComponents.length !== MANAGED_BACKUP_COMPONENTS.length ||
    managedComponents.some(
      (value) => typeof value !== 'string' || !allowed.has(value),
    ) ||
    presentComponents.some(
      (value) =>
        typeof value !== 'string' || !managedComponents.includes(value),
    ) ||
    !presentComponents.includes('db')
  ) {
    throw new Error('Backup manifest contains invalid components');
  }
  for (const component of presentComponents) {
    if (
      !fs
        .statSync(path.join(stagedDataDir, component), {
          throwIfNoEntry: false,
        })
        ?.isDirectory()
    ) {
      throw new Error(`Backup manifest component is missing: ${component}`);
    }
  }
  return { authoritative: true, managedComponents, presentComponents };
}

function replaceComponents(stagedDataDir, dataDir, stageRoot, manifest) {
  const rollbackDir = path.join(stageRoot, 'rollback');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(rollbackDir, { recursive: true });

  const replaced = [];
  try {
    for (const component of manifest.managedComponents) {
      const source = path.join(stagedDataDir, component);
      const hasSource = manifest.presentComponents.includes(component);
      if (!hasSource && !manifest.authoritative) continue;

      const destination = path.join(dataDir, component);
      const previous = path.join(rollbackDir, component);
      const hadPrevious = fs.existsSync(destination);
      if (hadPrevious) fs.renameSync(destination, previous);
      if (hasSource) {
        try {
          fs.renameSync(source, destination);
        } catch (error) {
          if (hadPrevious && fs.existsSync(previous)) {
            fs.renameSync(previous, destination);
          }
          throw error;
        }
      }
      replaced.push({
        destination,
        previous,
        hadPrevious,
        installed: hasSource,
      });
    }
  } catch (error) {
    for (const item of replaced.reverse()) {
      if (item.installed) {
        fs.rmSync(item.destination, { recursive: true, force: true });
      }
      if (item.hadPrevious && fs.existsSync(item.previous)) {
        fs.renameSync(item.previous, item.destination);
      }
    }
    throw error;
  }
}

// A `.commerceagent-restore-*` staging directory (holding the pre-restore
// rollback copy, i.e. real user secrets/DB) only survives past a restore
// invocation if that invocation was killed hard enough to skip the
// `finally` cleanup below (SIGKILL, OOM kill, host crash — not a normal
// thrown error, which is already caught and cleaned up). Such a leaked
// directory's `rollback/` subtree may be the ONLY surviving copy of good
// pre-restore data (e.g. if that prior run was killed between moving the
// live component out to rollback and moving the new one into place). It
// must only be swept AFTER the current restore has proven the new backup
// is valid and successfully applied to `dataDir` — sweeping it up front,
// before this run's own archive/manifest/integrity validation, would
// destroy the last recoverable copy if THIS run's archive later turns out
// to be corrupt and the restore aborts, compounding data loss instead of
// fixing it. `excludeStageRoot` skips the current run's own staging dir
// (still in use; its own `finally` cleans it up separately).
function cleanupOrphanedRestoreStagingDirs(parentDir, excludeStageRoot) {
  let entries;
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.commerceagent-restore-'))
      continue;
    const orphan = path.join(parentDir, entry.name);
    if (excludeStageRoot && orphan === excludeStageRoot) continue;
    try {
      fs.rmSync(orphan, { recursive: true, force: true });
      console.warn(
        `⚠️  Removed orphaned restore staging directory from a previous interrupted restore: ${orphan}`,
      );
    } catch (error) {
      console.warn(
        `⚠️  Failed to remove orphaned restore staging directory ${orphan}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 does no actual kill — it only checks the process exists and
    // is signalable by us. Throws ESRCH if the pid is gone.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM'; // exists, owned by another user — treat as alive
  }
}

// Two concurrent restores targeting the same parentDir must not run at once:
// cleanupOrphanedRestoreStagingDirs (called after a successful restore)
// cannot distinguish "a genuinely abandoned staging dir from an earlier
// crashed run" from "another restore's staging/rollback dir that is still
// in active use right now" — both just look like a `.commerceagent-restore-*`
// directory that isn't the current process's own stageRoot. Whichever
// restore finishes first would delete the other's in-flight rollback data.
// Serialize with a PID-stamped exclusive lock file instead of trying to
// infer liveness from directory contents.
//
// Never auto-reclaim a stale lock. PID liveness is only a snapshot: between
// checking a dead owner and renaming/unlinking the file, another process can
// replace it with a fresh live lock. Portable Node filesystem APIs do not
// provide compare-and-delete for a pathname, so automatic takeover cannot be
// made race-free. Restore is destructive; fail closed and require an operator
// to verify no restore is running before removing a stale lock manually.
function acquireRestoreLock(parentDir) {
  const lockPath = path.join(parentDir, '.commerceagent-restore.lock');
  try {
    fs.writeFileSync(lockPath, String(process.pid), {
      flag: 'wx',
      mode: 0o600,
    });
    return lockPath;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let heldBy = NaN;
    try {
      heldBy = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    } catch {
      // An unreadable lock is still a lock: fail closed.
    }
    if (isProcessAlive(heldBy)) {
      throw new Error(
        `Another restore (pid ${heldBy}) is already in progress for ${parentDir}. ` +
          'Wait for it to finish before starting a new restore.',
      );
    }
    throw new Error(
      `A stale or unreadable restore lock exists at ${lockPath}. ` +
        'Verify that no restore is running, remove this lock manually, then retry.',
    );
  }
}

function releaseRestoreLock(lockPath) {
  try {
    if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}

async function restore(archiveArg, dataDirArg, port) {
  // Check immediately before any filesystem mutation as well as in Makefile's
  // early preflight, closing the prompt-to-restore race window.
  await assertPortFree(port);

  const archivePath = path.resolve(archiveArg);
  const dataDir = path.resolve(dataDirArg);
  if (!fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Backup archive does not exist: ${archivePath}`);
  }
  validateArchiveEntries(archivePath);

  const parentDir = path.dirname(dataDir);
  fs.mkdirSync(parentDir, { recursive: true });
  const lockPath = acquireRestoreLock(parentDir);
  let stageRoot;
  try {
    // Staging creation itself can fail (ENOSPC, inode exhaustion, quota,
    // permissions). Keep it inside the lock's try/finally so such an early
    // failure does not strand a stale lock that blocks every later restore.
    stageRoot = fs.mkdtempSync(path.join(parentDir, '.commerceagent-restore-'));
    runTar(
      [
        '-xzf',
        archivePath,
        '-C',
        stageRoot,
        '--no-same-owner',
        '--no-same-permissions',
      ],
      'Unable to extract backup archive',
    );
    validateExtractedTree(stageRoot);
    const stagedDataDir = path.join(stageRoot, 'data');
    const manifest = readBackupManifest(stagedDataDir);
    hardenSensitivePermissions(stagedDataDir);
    const stagedDbDir = path.join(stagedDataDir, 'db');
    const stagedDbPath = path.join(stagedDbDir, 'messages.db');
    if (!fs.statSync(stagedDbPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('Backup archive is missing data/db/messages.db');
    }

    // A database snapshot is self-contained. Never carry stale sidecars from
    // current data or a legacy archive into the restored database.
    fs.rmSync(`${stagedDbPath}-wal`, { force: true });
    fs.rmSync(`${stagedDbPath}-shm`, { force: true });
    validateDatabase(stagedDbPath);
    // integrity_check may create empty WAL/SHM sidecars because the snapshot
    // retains WAL journal mode. They are not part of the restored state.
    fs.rmSync(`${stagedDbPath}-wal`, { force: true });
    fs.rmSync(`${stagedDbPath}-shm`, { force: true });
    restoreRecordedSymlinks(stagedDataDir);
    replaceComponents(stagedDataDir, dataDir, stageRoot, manifest);
    // Only sweep leftover staging dirs from previous crashed attempts once
    // THIS restore's archive has been fully validated and successfully
    // applied — see the function's doc comment for why sweeping earlier is
    // unsafe.
    cleanupOrphanedRestoreStagingDirs(parentDir, stageRoot);
  } finally {
    if (stageRoot) {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    }
    releaseRestoreLock(lockPath);
  }
}

const [, , command, ...args] = process.argv;
if (command === 'assert-port-free' && args.length === 1) {
  await assertPortFree(parsePort(args[0]));
} else if (command === 'restore' && args.length === 3) {
  await restore(args[0], args[1], parsePort(args[2]));
} else {
  usage();
}
