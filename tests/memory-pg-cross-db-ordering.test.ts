import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pg-ordering-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const memoryStore = await import('../src/memory-store.js');

const AT = '2026-05-01T00:00:00.000Z';
const JID = 'web:ordering-workspace';
const FOLDER = 'ordering-workspace';

function withRawDatabase(work: (raw: Database.Database) => void): void {
  const raw = new Database(path.join(storeDir, 'messages.db'));
  try {
    work(raw);
  } finally {
    raw.close();
  }
}

function registerWorkspace(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: `Workspace ${folder}`,
    folder,
    added_at: AT,
    created_by: 'ordering-owner',
    is_home: false,
  });
}

async function seedMemory(jid: string, content: string): Promise<void> {
  await memoryStore.createWorkspaceMemoryItem({
    workspaceJid: jid,
    value: { kind: 'fact', content },
    context: {
      actorId: 'ordering-owner',
      sourceType: 'web_user',
      sourceId: 'ordering-source',
      sessionId: 'ordering-session',
    },
  });
}

beforeAll(async () => {
  db.initDatabase();
  registerWorkspace(JID, FOLDER);
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('cross-database delete ordering', () => {
  test('deleting workspace memory twice is a no-op', async () => {
    await seedMemory(JID, '即将被删除的记忆');
    await expect(
      memoryStore.getWorkspaceMemoryStore(JID),
    ).resolves.toMatchObject({ workspaceJid: JID });

    await memoryStore.deleteWorkspaceMemoryData(JID);
    await expect(memoryStore.getWorkspaceMemoryStore(JID)).resolves.toBeNull();
    // A retried or duplicated delete must not raise `store_not_found`.
    await expect(
      memoryStore.deleteWorkspaceMemoryData(JID),
    ).resolves.toBeUndefined();
    // Deleting memory never touches the workspace row itself.
    expect(db.getRegisteredGroup(JID)).toBeDefined();
  });

  test('a failed SQLite delete leaves empty memory and a retry converges', async () => {
    await seedMemory(JID, '删除失败时也不应该残留在这');
    withRawDatabase((raw) => {
      raw.exec(`
        CREATE TRIGGER fail_registered_group_delete
        BEFORE DELETE ON registered_groups
        WHEN OLD.jid = '${JID}'
        BEGIN SELECT RAISE(ABORT, 'injected registered group delete failure'); END;
      `);
    });

    try {
      await expect(db.deleteRegisteredGroup(JID)).rejects.toThrow(
        /injected registered group delete failure/,
      );

      // Memory is deleted first and commits on its own, so it is already gone…
      await expect(
        memoryStore.getWorkspaceMemoryStore(JID),
      ).resolves.toBeNull();
      // …while the workspace itself survives, so nothing points at a deleted
      // workspace and a retry sees exactly the state it expects.
      expect(db.getRegisteredGroup(JID)).toBeDefined();
    } finally {
      withRawDatabase((raw) => {
        raw.exec('DROP TRIGGER fail_registered_group_delete');
      });
    }

    await expect(db.deleteRegisteredGroup(JID)).resolves.toBeUndefined();
    expect(db.getRegisteredGroup(JID)).toBeUndefined();
    await expect(memoryStore.getWorkspaceMemoryStore(JID)).resolves.toBeNull();
  });
});

describe('cross-database rebuild ordering', () => {
  const REBUILD_JID = 'web:ordering-rebuild';
  const REBUILD_FOLDER = 'ordering-rebuild';

  test('rebuild preconditions run before the memory reset', async () => {
    registerWorkspace(REBUILD_JID, REBUILD_FOLDER);
    await seedMemory(REBUILD_JID, '预检失败时必须保留的记忆');

    await expect(
      db.rebuildWorkspacePersistentState({
        groupFolder: REBUILD_FOLDER,
        workspaceJids: ['web:ordering-workspace-that-does-not-exist'],
        siblingJids: [],
      }),
    ).rejects.toMatchObject({ code: 'workspace_missing' });

    // The rejected rebuild must not have reset any memory store.
    await expect(
      memoryStore.listWorkspaceMemoryItems({
        workspaceJid: REBUILD_JID,
        limit: 10,
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ content: '预检失败时必须保留的记忆' })],
    });
  });

  test('a successful rebuild replaces the store with an empty one', async () => {
    const before = await memoryStore.getWorkspaceMemoryStore(REBUILD_JID);

    await expect(
      db.rebuildWorkspacePersistentState({
        groupFolder: REBUILD_FOLDER,
        workspaceJids: [REBUILD_JID],
        siblingJids: [],
      }),
    ).resolves.toMatchObject({ recycledTaskIds: [] });

    const after = await memoryStore.getWorkspaceMemoryStore(REBUILD_JID);
    expect(after).toMatchObject({ workspaceJid: REBUILD_JID, revision: 0 });
    expect(after?.id).not.toBe(before?.id);
    await expect(
      memoryStore.listWorkspaceMemoryItems({
        workspaceJid: REBUILD_JID,
        limit: 10,
      }),
    ).resolves.toMatchObject({ items: [] });
  });
});
