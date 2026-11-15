import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v65-memory-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: dataDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const memoryStore = await import('../src/memory-store.js');

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:legacy-project', {
    name: 'Legacy project',
    folder: 'legacy-project',
    added_at: '2026-07-28T00:00:00.000Z',
    created_by: 'alice',
    is_home: false,
  } as any);
  db.closeDatabase();

  const raw = new Database(databasePath);
  raw.exec(`
    DROP TRIGGER IF EXISTS trg_workspace_memory_store_after_workspace_insert;
    DROP TABLE IF EXISTS workspace_memory_fts;
    DROP TABLE IF EXISTS workspace_memory_audit_events;
    DROP TABLE IF EXISTS workspace_memory_outbox;
    DROP TABLE IF EXISTS workspace_memory_mutation_requests;
    DROP TABLE IF EXISTS workspace_memory_tombstones;
    DROP TABLE IF EXISTS workspace_memory_provenance;
    DROP TABLE IF EXISTS workspace_memory_versions;
    DROP TABLE IF EXISTS workspace_memory_items;
    DROP TABLE IF EXISTS workspace_memory_stores;
    UPDATE router_state SET value = '64' WHERE key = 'schema_version';
  `);
  raw.close();

  fs.mkdirSync(path.join(groupsDir, 'user-global', 'alice'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(groupsDir, 'user-global', 'alice', 'CLAUDE.md'),
    'legacy global must not be copied',
  );
  fs.mkdirSync(path.join(dataDir, 'memory', 'legacy-project'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDir, 'memory', 'legacy-project', '2026-07-28.md'),
    'legacy date must not be copied',
  );
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v65 Workspace Memory migration', () => {
  test('provisions PostgreSQL stores without importing global/date files', async () => {
    db.initDatabase();
    await memoryStore.initWorkspaceMemoryStore();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.ensureUserHomeGroup('new-user', 'member', 'new-user');
    expect(
      fs.existsSync(
        path.join(groupsDir, 'user-global', 'new-user', 'CLAUDE.md'),
      ),
    ).toBe(false);

    // Workspace Memory no longer lives in SQLite at all: the legacy tables are
    // not recreated by the SQLite migrations.
    const raw = new Database(databasePath, { readonly: true });
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace_memory_%'",
        )
        .all(),
    ).toEqual([]);
    raw.close();

    const store =
      await memoryStore.getWorkspaceMemoryStore('web:legacy-project');
    expect(store).toMatchObject({
      workspaceJid: 'web:legacy-project',
      revision: 0,
    });
    const items = await memoryStore.queryWorkspaceMemoryStoreDatabase(
      'SELECT COUNT(*)::int AS count FROM workspace_memory_items',
    );
    expect(items.rows[0]?.count).toBe(0);

    // A workspace created after bootstrap gets its store on first use.
    await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid: 'web:home-new-user',
      query: 'remember',
      limit: 5,
    });
    expect(
      await memoryStore.getWorkspaceMemoryStore('web:home-new-user'),
    ).toMatchObject({ workspaceJid: 'web:home-new-user', revision: 0 });
  });
});
