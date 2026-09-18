import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-chunks-drop-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

// Seed a legacy database that still carries the pre-v65 chunk index.
const dbPath = path.join(tmpStoreDir, 'messages.db');
const seedDb = new Database(dbPath);
seedDb.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE memory_chunks (
    id INTEGER PRIMARY KEY,
    workspace TEXT,
    content TEXT,
    updated_at TEXT
  );
  CREATE VIRTUAL TABLE memory_chunks_fts USING fts5(content);
`);
seedDb
  .prepare(
    'INSERT INTO memory_chunks (workspace, content, updated_at) VALUES (?, ?, ?)',
  )
  .run('flow-legacy', 'stale chunk', '2026-02-28T00:00:00.000Z');
seedDb
  .prepare('INSERT INTO memory_chunks_fts (content) VALUES (?)')
  .run('stale chunk');
seedDb.close();

const { initDatabase, closeDatabase, CURRENT_SCHEMA_VERSION } =
  await import('../src/db.js');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('v67 legacy memory_chunks drop', () => {
  test('backs up an unversioned legacy index before dropping it', () => {
    initDatabase();
    closeDatabase();

    const probe = new Database(dbPath, { readonly: true });
    const leftover = probe
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'memory_chunks%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    expect(leftover).toEqual([]);
    expect(
      probe
        .prepare('SELECT value FROM router_state WHERE key = ?')
        .get('schema_version'),
    ).toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
    probe.close();

    const backupDir = path.join(tmpStoreDir, 'migration-backups');
    const backupNames = fs.readdirSync(backupDir);
    expect(backupNames).toHaveLength(1);
    const backup = new Database(path.join(backupDir, backupNames[0]), {
      readonly: true,
    });
    expect(
      backup
        .prepare(
          "SELECT name FROM sqlite_master WHERE name LIKE 'memory_chunks%' ORDER BY name",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { name: 'memory_chunks' },
        { name: 'memory_chunks_fts' },
      ]),
    );
    expect(
      backup
        .prepare(
          'SELECT workspace, content, updated_at FROM memory_chunks WHERE id = 1',
        )
        .get(),
    ).toEqual({
      workspace: 'flow-legacy',
      content: 'stale chunk',
      updated_at: '2026-02-28T00:00:00.000Z',
    });
    expect(
      backup
        .prepare(
          "SELECT content FROM memory_chunks_fts WHERE memory_chunks_fts MATCH 'stale'",
        )
        .all(),
    ).toEqual([{ content: 'stale chunk' }]);
    expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
    backup.close();
  });
});
