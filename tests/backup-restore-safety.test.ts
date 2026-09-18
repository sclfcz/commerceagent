import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-restore-safety-'));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to resolve test server port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe('runtime backup and restore safety', () => {
  test('omits generated session .claude links but preserves the surrounding session', async () => {
    const sourceData = path.join(tmp, 'generated-link-source-data');
    const backupDir = path.join(tmp, 'generated-link-backups');
    const extractDir = path.join(tmp, 'generated-link-extract');
    const dbDir = path.join(sourceData, 'db');
    const sessionRoot = path.join(
      sourceData,
      'sessions',
      'workspace-1',
      'agents',
      'agent-1',
    );
    const claudeDir = path.join(sessionRoot, '.claude');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(claudeDir, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'conversation.json'), '{}');
    fs.symlinkSync('/tmp', path.join(claudeDir, 'skills', 'host-skill'));

    const { stdout } = await execFileAsync(
      'make',
      ['backup', `RUNTIME_DATA_DIR=${sourceData}`, `BACKUP_DIR=${backupDir}`],
      { cwd: root },
    );
    expect(stdout).toContain('可在运行时重建');
    const archive = path.join(
      backupDir,
      fs.readdirSync(backupDir).find((name) => name.endsWith('.tar.gz'))!,
    );
    fs.mkdirSync(extractDir, { recursive: true });
    await execFileAsync('tar', ['-xzf', archive, '-C', extractDir]);
    expect(
      fs.readFileSync(
        path.join(
          extractDir,
          'data',
          'sessions',
          'workspace-1',
          'agents',
          'agent-1',
          'conversation.json',
        ),
        'utf8',
      ),
    ).toBe('{}');
    expect(
      fs.existsSync(
        path.join(
          extractDir,
          'data',
          'sessions',
          'workspace-1',
          'agents',
          'agent-1',
          '.claude',
          'skills',
          'host-skill',
        ),
      ),
    ).toBe(false);
  });

  test('refuses to create an unrestorable archive from runtime symlinks', async () => {
    const sourceData = path.join(tmp, 'symlink-source-data');
    const backupDir = path.join(tmp, 'symlink-backups');
    const dbDir = path.join(sourceData, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(sourceData, 'skills'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(sourceData, 'skills', 'external'));

    await expect(
      execFileAsync(
        'make',
        ['backup', `RUNTIME_DATA_DIR=${sourceData}`, `BACKUP_DIR=${backupDir}`],
        { cwd: root },
      ),
    ).rejects.toThrow();
    expect(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
    ).toHaveLength(0);
  });

  test('refuses to create an unrestorable archive from hard-linked runtime files', async () => {
    // A regular file with nlink > 1 is stored by tar as a link-type ('h')
    // entry pointing at its first-seen sibling instead of a full copy.
    // restore-backup.mjs's validateArchiveEntries rejects link-type entries
    // outright, so a hard link that makes it into a backup produces an
    // archive that reports "backup complete" but can never be restored.
    // Must be caught at backup time, not discovered during a real restore.
    const sourceData = path.join(tmp, 'hardlink-source-data');
    const backupDir = path.join(tmp, 'hardlink-backups');
    const dbDir = path.join(sourceData, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(sourceData, 'config'), { recursive: true });
    const original = path.join(sourceData, 'config', 'settings.json');
    fs.writeFileSync(original, '{}');
    fs.linkSync(original, path.join(sourceData, 'config', 'settings-2.json'));

    await expect(
      execFileAsync(
        'make',
        ['backup', `RUNTIME_DATA_DIR=${sourceData}`, `BACKUP_DIR=${backupDir}`],
        { cwd: root },
      ),
    ).rejects.toThrow();
    expect(
      fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [],
    ).toHaveLength(0);
  });

  test('rejects symbolic links and other special archive entries before extraction', async () => {
    const archiveRoot = path.join(tmp, 'malicious-archive');
    const archive = path.join(tmp, 'malicious-backup.tar.gz');
    const restoreData = path.join(tmp, 'malicious-restore');
    fs.mkdirSync(path.join(archiveRoot, 'data', 'db'), { recursive: true });
    fs.symlinkSync('/tmp', path.join(archiveRoot, 'data', 'sessions'));
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);

    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow(/Unsafe backup archive entry type/);
    expect(fs.existsSync(restoreData)).toBe(false);
  });

  test('rejects forged symlink metadata that escapes restored data', async () => {
    const archiveRoot = path.join(tmp, 'malicious-metadata-archive');
    const archive = path.join(tmp, 'malicious-metadata-backup.tar.gz');
    const restoreData = path.join(tmp, 'malicious-metadata-restore');
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    fs.mkdirSync(path.join(archiveRoot, 'data', 'groups'), { recursive: true });
    fs.writeFileSync(
      path.join(archiveRoot, 'data', 'backup-symlinks.json'),
      JSON.stringify({
        formatVersion: 1,
        links: [{ path: 'groups/escape', target: '../../../tmp' }],
      }),
    );
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow(/escapes restored data/);
    expect(fs.existsSync(restoreData)).toBe(false);
  });

  test('restores realistic archives whose validated file listing exceeds one MiB', async () => {
    const archiveRoot = path.join(tmp, 'large-listing-archive');
    const archive = path.join(tmp, 'large-listing-backup.tar.gz');
    const restoreData = path.join(tmp, 'large-listing-restore');
    const dbDir = path.join(archiveRoot, 'data', 'db');
    const groupsDir = path.join(archiveRoot, 'data', 'groups');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    const suffix = 'x'.repeat(180);
    for (let index = 0; index < 5_000; index += 1) {
      fs.writeFileSync(path.join(groupsDir, `entry-${index}-${suffix}`), 'x');
    }
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archive,
        restoreData,
        String(port),
      ],
      { cwd: root },
    );
    expect(fs.readdirSync(path.join(restoreData, 'groups'))).toHaveLength(
      5_000,
    );
  }, 20_000);

  test('sweeps an orphaned staging directory left by a previously killed restore', async () => {
    // A `.commerceagent-restore-*` staging dir only survives past a restore
    // invocation if that invocation was killed hard enough to skip its own
    // `finally` cleanup (SIGKILL/OOM/host crash). It holds the pre-restore
    // rollback copy — i.e. real secrets/DB — and must not accumulate on
    // disk forever. Simulate that leak directly rather than reproducing a
    // real SIGKILL race, then confirm the next restore invocation sweeps it.
    const archiveRoot = path.join(tmp, 'orphan-sweep-archive');
    const archive = path.join(tmp, 'orphan-sweep-backup.tar.gz');
    const restoreData = path.join(tmp, 'orphan-sweep-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    fs.mkdirSync(restoreParent, { recursive: true });
    const orphan = fs.mkdtempSync(
      path.join(restoreParent, '.commerceagent-restore-'),
    );
    fs.mkdirSync(path.join(orphan, 'rollback', 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(orphan, 'rollback', 'db', 'messages.db'),
      'leaked pre-restore bytes from a killed run',
    );
    expect(fs.existsSync(orphan)).toBe(true);

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archive,
        restoreData,
        String(port),
      ],
      { cwd: root },
    );

    expect(fs.existsSync(orphan)).toBe(false);
    expect(
      fs
        .readdirSync(restoreParent)
        .filter((name) => name.startsWith('.commerceagent-restore-')),
    ).toHaveLength(0);
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
  });

  test('preserves an orphaned rollback directory when the new restore attempt itself fails validation', async () => {
    // A leaked `.commerceagent-restore-*` staging dir may hold the ONLY
    // surviving copy of good pre-restore data (e.g. a prior run killed
    // between moving the live component to rollback and moving the new one
    // into place). If a later restore attempt sweeps that orphan BEFORE
    // proving its own archive is valid, and that archive then fails
    // validation (corrupt DB here), the orphan's data is gone forever with
    // nothing successfully restored either — compounding data loss instead
    // of just leaving the earlier problem in place. The orphan must survive
    // a failed restore attempt.
    const archiveRoot = path.join(tmp, 'orphan-preserve-archive');
    const archive = path.join(tmp, 'orphan-preserve-backup.tar.gz');
    const restoreData = path.join(tmp, 'orphan-preserve-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    // Corrupt/invalid database content — validateDatabase's integrity_check
    // will fail on this, aborting the restore after extraction.
    fs.writeFileSync(path.join(dbDir, 'messages.db'), 'not a real sqlite db');
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    fs.mkdirSync(restoreParent, { recursive: true });
    const orphan = fs.mkdtempSync(
      path.join(restoreParent, '.commerceagent-restore-'),
    );
    fs.mkdirSync(path.join(orphan, 'rollback', 'db'), { recursive: true });
    const survivingBytes = 'the only surviving copy of the old database';
    fs.writeFileSync(
      path.join(orphan, 'rollback', 'db', 'messages.db'),
      survivingBytes,
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow();

    // The failed attempt's own stage dir is cleaned by its `finally`, but
    // the pre-existing orphan (and the only surviving data inside it) must
    // still be there — untouched by this failed attempt.
    expect(fs.existsSync(orphan)).toBe(true);
    expect(
      fs.readFileSync(
        path.join(orphan, 'rollback', 'db', 'messages.db'),
        'utf8',
      ),
    ).toBe(survivingBytes);
  });

  test("refuses to start a second restore while one is already in progress, so it cannot delete the other's in-flight staging dir", async () => {
    // cleanupOrphanedRestoreStagingDirs cannot tell "an abandoned staging
    // dir from a crashed run" apart from "another restore's staging/
    // rollback dir that is still in active use right now" — both just look
    // like a `.commerceagent-restore-*` directory that isn't this process's
    // own. Without serialization, whichever restore finishes first would
    // delete the other's in-flight rollback data. Simulate a live
    // in-progress restore by writing a lock file stamped with our own pid
    // (guaranteed alive for the duration of this test).
    const archiveRoot = path.join(tmp, 'lock-live-archive');
    const archive = path.join(tmp, 'lock-live-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-live-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    fs.mkdirSync(restoreParent, { recursive: true });
    fs.writeFileSync(
      path.join(restoreParent, '.commerceagent-restore.lock'),
      String(process.pid),
      { flag: 'wx' },
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow(/already in progress/);
    expect(fs.existsSync(restoreData)).toBe(false);
    // The live lock (still our own pid) must not have been touched.
    expect(
      fs.readFileSync(
        path.join(restoreParent, '.commerceagent-restore.lock'),
        'utf8',
      ),
    ).toBe(String(process.pid));
  });

  test('releases the restore lock when staging directory creation fails', async () => {
    const archiveRoot = path.join(tmp, 'lock-mkdtemp-failure-archive');
    const archive = path.join(tmp, 'lock-mkdtemp-failure-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-mkdtemp-failure-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const lockPath = path.join(restoreParent, '.commerceagent-restore.lock');
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    // Inject a deterministic ENOSPC at the exact fs.mkdtempSync call used by
    // restore-backup.mjs. The lock write immediately before it still succeeds,
    // reproducing the early-failure window without relying on real disk
    // exhaustion or filesystem-specific path-length limits.
    const preload = path.join(tmp, 'fail-restore-mkdtemp.cjs');
    fs.writeFileSync(
      preload,
      String.raw`
const fs = require('node:fs');
const originalMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) {
  if (String(prefix).endsWith('.commerceagent-restore-')) {
    const error = new Error('simulated ENOSPC while creating restore staging directory');
    error.code = 'ENOSPC';
    throw error;
  }
  return originalMkdtempSync.call(this, prefix, ...args);
};
`,
    );

    fs.mkdirSync(restoreParent, { recursive: true });
    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`]
              .filter(Boolean)
              .join(' '),
          },
        },
      ),
    ).rejects.toThrow(/simulated ENOSPC/);

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(
      fs
        .readdirSync(restoreParent)
        .filter((name) => name.startsWith('.commerceagent-restore-')),
    ).toHaveLength(0);

    // A normal retry must proceed immediately rather than fail closed on a
    // stale lock left by the failed staging allocation.
    await execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archive,
        restoreData,
        String(port),
      ],
      { cwd: root },
    );
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test('fails closed on a stale lock until an operator removes it', async () => {
    const archiveRoot = path.join(tmp, 'lock-stale-archive');
    const archive = path.join(tmp, 'lock-stale-backup.tar.gz');
    const restoreData = path.join(tmp, 'lock-stale-restore', 'data');
    const restoreParent = path.dirname(restoreData);
    const dbDir = path.join(archiveRoot, 'data', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(path.join(dbDir, 'messages.db'));
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');
    db.close();
    await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);

    fs.mkdirSync(restoreParent, { recursive: true });
    // Spawn a short-lived process and wait for it to exit so its pid is
    // guaranteed dead, then stamp the lock with that now-unused pid —
    // simulating a restore that was killed without releasing its lock.
    const deadPid = await new Promise((resolve) => {
      const child = spawn('node', ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve(child.pid));
    });
    fs.writeFileSync(
      path.join(restoreParent, '.commerceagent-restore.lock'),
      String(deadPid),
      { flag: 'wx' },
    );

    const portProbe = net.createServer();
    const port = await listen(portProbe);
    await close(portProbe);
    await expect(
      execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      ),
    ).rejects.toThrow(/remove this lock manually/);

    expect(fs.existsSync(restoreData)).toBe(false);
    // The script must not rename or unlink a pathname that could have been
    // replaced by a newly acquired live lock after its liveness check.
    expect(
      fs.existsSync(path.join(restoreParent, '.commerceagent-restore.lock')),
    ).toBe(true);

    fs.rmSync(path.join(restoreParent, '.commerceagent-restore.lock'));
    await execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archive,
        restoreData,
        String(port),
      ],
      { cwd: root },
    );
    expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(restoreParent, '.commerceagent-restore.lock')),
    ).toBe(false);
  });

  test('two restores observing the same stale lock both fail closed', async () => {
    const archiveRootA = path.join(tmp, 'lock-race-archive-a');
    const archiveRootB = path.join(tmp, 'lock-race-archive-b');
    const archiveA = path.join(tmp, 'lock-race-backup-a.tar.gz');
    const archiveB = path.join(tmp, 'lock-race-backup-b.tar.gz');
    const restoreData = path.join(tmp, 'lock-race-restore', 'data');
    const restoreParent = path.dirname(restoreData);

    for (const [archiveRoot, archive, marker] of [
      [archiveRootA, archiveA, 'A'],
      [archiveRootB, archiveB, 'B'],
    ] as const) {
      const dbDir = path.join(archiveRoot, 'data', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const db = new Database(path.join(dbDir, 'messages.db'));
      db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, marker TEXT)');
      db.prepare('INSERT INTO sample (marker) VALUES (?)').run(marker);
      db.close();
      await execFileAsync('tar', ['-czf', archive, '-C', archiveRoot, 'data']);
    }

    fs.mkdirSync(restoreParent, { recursive: true });
    const deadPid = await new Promise<number>((resolve) => {
      const child = spawn('node', ['-e', 'process.exit(0)']);
      child.on('exit', () => resolve(child.pid as number));
    });
    fs.writeFileSync(
      path.join(restoreParent, '.commerceagent-restore.lock'),
      String(deadPid),
      { flag: 'wx' },
    );

    const portProbeA = net.createServer();
    const portA = await listen(portProbeA);
    await close(portProbeA);
    const portProbeB = net.createServer();
    const portB = await listen(portProbeB);
    await close(portProbeB);

    const runA = execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archiveA,
        restoreData,
        String(portA),
      ],
      { cwd: root },
    );
    const runB = execFileAsync(
      'node',
      [
        'scripts/restore-backup.mjs',
        'restore',
        archiveB,
        restoreData,
        String(portB),
      ],
      { cwd: root },
    );

    const [resultA, resultB] = await Promise.allSettled([runA, runB]);
    const fulfilled = [resultA, resultB].filter(
      (r) => r.status === 'fulfilled',
    );
    const rejected = [resultA, resultB].filter(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(String(result.reason)).toMatch(/remove this lock manually/);
    }

    expect(fs.existsSync(restoreData)).toBe(false);
    // Neither contender may mutate the stale pathname or enter staging.
    expect(
      fs.existsSync(path.join(restoreParent, '.commerceagent-restore.lock')),
    ).toBe(true);
    const leftoverStaging = fs
      .readdirSync(restoreParent)
      .filter((name) => name.startsWith('.commerceagent-restore-'));
    expect(leftoverStaging).toHaveLength(0);
  });

  test('includes committed WAL rows and refuses restore while the service port is active', async () => {
    const sourceData = path.join(tmp, 'source-data');
    const backupDir = path.join(tmp, 'backups');
    const restoreData = path.join(tmp, 'restored-data');
    const dbDir = path.join(sourceData, 'db');
    const dbPath = path.join(dbDir, 'messages.db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(path.join(sourceData, 'config'), { recursive: true });
    const sessionSecretPath = path.join(
      sourceData,
      'config',
      'session-secret.key',
    );
    fs.writeFileSync(sessionSecretPath, 'test-only-secret', { mode: 0o644 });
    const persistentMarkers = [
      ['mcp-servers', 'user-1', 'servers.json'],
      ['plugins', 'users', 'user-1.json'],
      ['memory', 'workspace-1', 'memory.md'],
      ['avatars', 'agent-1.txt'],
      ['builtin-skills', 'catalog.json'],
    ];
    for (const parts of persistentMarkers) {
      const markerPath = path.join(sourceData, ...parts);
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `marker:${parts.join('/')}`);
    }
    const workspaceRoot = path.join(sourceData, 'groups', 'workspace-1');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'CLAUDE.md'), 'workspace rules');
    fs.symlinkSync('CLAUDE.md', path.join(workspaceRoot, 'AGENTS.md'));
    fs.symlinkSync('/tmp', path.join(workspaceRoot, 'external-cache'));

    const writer = new Database(dbPath);
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec(
        'CREATE TABLE audit_rows (id INTEGER PRIMARY KEY, value TEXT)',
      );
      writer.prepare('INSERT INTO audit_rows(value) VALUES (?)').run('main');
      writer.pragma('wal_checkpoint(TRUNCATE)');
      writer.prepare('INSERT INTO audit_rows(value) VALUES (?)').run('wal');

      expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);
      const detachedMain = path.join(tmp, 'detached-main.db');
      fs.copyFileSync(dbPath, detachedMain);
      const detached = new Database(detachedMain, { readonly: true });
      expect(
        (
          detached
            .prepare('SELECT COUNT(*) AS count FROM audit_rows')
            .get() as {
            count: number;
          }
        ).count,
      ).toBe(1);
      detached.close();

      await execFileAsync(
        'make',
        ['backup', `RUNTIME_DATA_DIR=${sourceData}`, `BACKUP_DIR=${backupDir}`],
        { cwd: root },
      );
      const archives = fs
        .readdirSync(backupDir)
        .filter((name) => name.endsWith('.tar.gz'));
      expect(archives).toHaveLength(1);
      const archive = path.join(backupDir, archives[0]);

      const activeServer = net.createServer();
      const port = await listen(activeServer);
      try {
        await expect(
          execFileAsync(
            'make',
            [
              'restore',
              `FILE=${archive}`,
              `RUNTIME_DATA_DIR=${restoreData}`,
              `PORT=${port}`,
            ],
            { cwd: root },
          ),
        ).rejects.toThrow();
        expect(fs.existsSync(path.join(restoreData, 'db', 'messages.db'))).toBe(
          false,
        );
      } finally {
        await close(activeServer);
      }

      const staleExtra = path.join(restoreData, 'extra', 'stale.txt');
      fs.mkdirSync(path.dirname(staleExtra), { recursive: true });
      fs.writeFileSync(staleExtra, 'must be removed by authoritative restore');
      await execFileAsync(
        'node',
        [
          'scripts/restore-backup.mjs',
          'restore',
          archive,
          restoreData,
          String(port),
        ],
        { cwd: root },
      );

      const restoredDbPath = path.join(restoreData, 'db', 'messages.db');
      expect(
        fs.statSync(path.join(restoreData, 'config', 'session-secret.key'))
          .mode & 0o777,
      ).toBe(0o600);
      for (const parts of persistentMarkers) {
        expect(fs.readFileSync(path.join(restoreData, ...parts), 'utf8')).toBe(
          `marker:${parts.join('/')}`,
        );
      }
      const restoredWorkspaceLink = path.join(
        restoreData,
        'groups',
        'workspace-1',
        'AGENTS.md',
      );
      expect(fs.lstatSync(restoredWorkspaceLink).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(restoredWorkspaceLink)).toBe('CLAUDE.md');
      expect(fs.readFileSync(restoredWorkspaceLink, 'utf8')).toBe(
        'workspace rules',
      );
      expect(
        fs.existsSync(
          path.join(restoreData, 'groups', 'workspace-1', 'external-cache'),
        ),
      ).toBe(false);
      expect(fs.existsSync(path.join(restoreData, 'extra'))).toBe(false);
      expect(fs.existsSync(`${restoredDbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${restoredDbPath}-shm`)).toBe(false);
      const restored = new Database(restoredDbPath, { readonly: true });
      expect(
        (
          restored
            .prepare('SELECT COUNT(*) AS count FROM audit_rows')
            .get() as { count: number }
        ).count,
      ).toBe(2);
      restored.close();
    } finally {
      writer.close();
    }
  }, 20_000);
});
