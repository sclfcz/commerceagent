#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

function usage() {
  console.error(
    'Usage: node scripts/sqlite-snapshot.mjs <source.db> <snapshot.db>',
  );
  process.exit(2);
}

const [, , sourceArg, snapshotArg] = process.argv;
if (!sourceArg || !snapshotArg) usage();

const sourcePath = path.resolve(sourceArg);
const snapshotPath = path.resolve(snapshotArg);

if (sourcePath === snapshotPath) {
  throw new Error('SQLite snapshot destination must differ from the source');
}
if (!fs.existsSync(sourcePath)) {
  throw new Error(`SQLite source does not exist: ${sourcePath}`);
}
if (fs.existsSync(snapshotPath)) {
  throw new Error(
    `SQLite snapshot destination already exists: ${snapshotPath}`,
  );
}

fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });

let source;
let probe;
try {
  source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000,
  });
  source.pragma('busy_timeout = 5000');

  // better-sqlite3's online backup API reads a transactionally consistent
  // snapshot from SQLite itself. Committed pages still resident in WAL are
  // therefore included without stopping the running CommerceAgent process.
  await source.backup(snapshotPath);
  source.close();
  source = undefined;

  probe = new Database(snapshotPath, { readonly: true, fileMustExist: true });
  const result = probe.pragma('quick_check', { simple: true });
  if (result !== 'ok') {
    throw new Error(`SQLite snapshot quick_check failed: ${String(result)}`);
  }
  probe.close();
  probe = undefined;
  fs.chmodSync(snapshotPath, 0o600);
} catch (error) {
  try {
    probe?.close();
  } catch {
    // Preserve the original backup/validation error.
  }
  try {
    source?.close();
  } catch {
    // Preserve the original backup/validation error.
  }
  for (const candidate of [
    snapshotPath,
    `${snapshotPath}-wal`,
    `${snapshotPath}-shm`,
  ]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch {
      // Cleanup must not hide the snapshot failure.
    }
  }
  throw error;
}
