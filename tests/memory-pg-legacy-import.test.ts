import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pg-import-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
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
const { LEGACY_IMPORT_MARKER_KEY } =
  await import('../src/memory-pg/legacy-sqlite-import.js');

const JID = 'web:legacy-import-workspace';
const STORE_ID = 'wms_legacy_import';
const AT = '2026-05-01T00:00:00.000Z';

/**
 * Recreate the retired SQLite Workspace Memory tables exactly as a pre-migration
 * install would still have them on disk.
 */
function seedLegacySqliteTables(): void {
  const raw = new Database(databasePath);
  raw.exec(`
    CREATE TABLE workspace_memory_stores (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE workspace_memory_items (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      importance REAL NOT NULL DEFAULT 0.5,
      confidence REAL NOT NULL DEFAULT 1,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      create_idempotency_key TEXT,
      create_request_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE workspace_memory_versions (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      workspace_jid TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      canonical_key TEXT,
      status TEXT NOT NULL,
      importance REAL NOT NULL,
      confidence REAL NOT NULL,
      valid_from TEXT,
      valid_until TEXT,
      expires_at TEXT,
      change_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision)
    );
    CREATE TABLE workspace_memory_platform_items (
      item_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE workspace_memory_provenance (
      item_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      session_id TEXT,
      observed_at TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (item_id, revision)
    );
    CREATE TABLE workspace_memory_tombstones (
      item_id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      deleted_revision INTEGER NOT NULL,
      reason TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE workspace_memory_mutation_requests (
      store_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      operation TEXT NOT NULL,
      item_id TEXT,
      request_hash TEXT,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (store_id, idempotency_key)
    );
    CREATE TABLE workspace_memory_outbox (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT,
      item_revision INTEGER,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE TABLE workspace_memory_audit_events (
      id TEXT PRIMARY KEY,
      workspace_jid TEXT NOT NULL,
      store_id TEXT NOT NULL,
      item_id TEXT,
      item_revision INTEGER,
      store_revision INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      source_id TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const insert = (sql: string, ...params: unknown[]) =>
    raw.prepare(sql).run(...params);

  insert(
    `INSERT INTO workspace_memory_stores (id, workspace_jid, revision, created_at, updated_at)
     VALUES (?, ?, 3, ?, ?)`,
    STORE_ID,
    JID,
    AT,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_items (
       id, store_id, workspace_jid, kind, title, content, canonical_key, status,
       importance, confidence, revision, created_at, updated_at
     ) VALUES (?, ?, ?, 'decision', '旧版决策', '旧版记忆里的中文内容需要能检索到',
       'legacy.decision.1', 'active', 0.8, 0.9, 2, ?, ?)`,
    'wmi_legacy_1',
    STORE_ID,
    JID,
    AT,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_items (
       id, store_id, workspace_jid, kind, title, content, status, revision,
       created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, 'open_loop', '已经被忘记的条目', 'forgotten legacy content',
       'deleted', 2, ?, ?, ?)`,
    'wmi_legacy_2',
    STORE_ID,
    JID,
    AT,
    AT,
    '2026-05-02T00:00:00.000Z',
  );
  for (const [itemId, revision, title, content, status, changeType] of [
    ['wmi_legacy_1', 1, '旧版决策', '旧版记忆内容', 'active', 'create'],
    [
      'wmi_legacy_1',
      2,
      '旧版决策',
      '旧版记忆里的中文内容需要能检索到',
      'active',
      'update',
    ],
    [
      'wmi_legacy_2',
      1,
      '已经被忘记的条目',
      'forgotten legacy content',
      'active',
      'create',
    ],
    [
      'wmi_legacy_2',
      2,
      '已经被忘记的条目',
      'forgotten legacy content',
      'deleted',
      'forget',
    ],
  ] as const) {
    insert(
      `INSERT INTO workspace_memory_versions (
         item_id, revision, workspace_jid, kind, title, content, status,
         importance, confidence, change_type, actor_type, actor_id, created_at
       ) VALUES (?, ?, ?, 'fact', ?, ?, ?, 0.5, 1, ?, 'web_user', 'legacy-owner', ?)`,
      itemId,
      revision,
      JID,
      title,
      content,
      status,
      changeType,
      AT,
    );
    insert(
      `INSERT INTO workspace_memory_provenance (
         item_id, revision, source_type, source_id, session_id, recorded_at
       ) VALUES (?, ?, 'web_user', ?, 'legacy-session', ?)`,
      itemId,
      revision,
      `legacy-source-${revision}`,
      AT,
    );
  }
  // A reserved Owner Profile item belongs to the platform, not to the user:
  // the import copies it, and the store keeps hiding it from list/search.
  insert(
    `INSERT INTO workspace_memory_items (
       id, store_id, workspace_jid, kind, title, content, canonical_key, status,
       importance, confidence, revision, created_at, updated_at
     ) VALUES ('wmi_legacy_platform', ?, ?, 'fact', 'Owner preferred address',
       'legacy owner preferred address',
       'happyclaw.owner.preferred_address', 'active', 0.5, 1, 1, ?, ?)`,
    STORE_ID,
    JID,
    AT,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_versions (
       item_id, revision, workspace_jid, kind, title, content, canonical_key,
       status, importance, confidence, change_type, actor_type, actor_id, created_at
     ) VALUES ('wmi_legacy_platform', 1, ?, 'fact', 'Owner preferred address',
       'legacy owner preferred address', 'happyclaw.owner.preferred_address',
       'active', 0.5, 1, 'create', 'agent_runtime', 'commerceagent', ?)`,
    JID,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_provenance (
       item_id, revision, source_type, source_id, session_id, recorded_at
     ) VALUES ('wmi_legacy_platform', 1, 'agent_runtime', 'legacy-owner-profile',
       'legacy-session', ?)`,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_platform_items (item_id, namespace, created_at)
     VALUES ('wmi_legacy_platform', 'commerceagent', ?)`,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_tombstones (
       item_id, workspace_jid, deleted_revision, reason, actor_type, actor_id, deleted_at
     ) VALUES ('wmi_legacy_2', ?, 2, 'legacy forget', 'web_user', 'legacy-owner', ?)`,
    JID,
    '2026-05-02T00:00:00.000Z',
  );
  insert(
    `INSERT INTO workspace_memory_mutation_requests (
       store_id, idempotency_key, operation, item_id, request_hash, response_json, created_at
     ) VALUES (?, 'legacy-idem-1', 'update', 'wmi_legacy_1', 'hash', '{"ok":true}', ?)`,
    STORE_ID,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_outbox (
       id, workspace_jid, store_id, item_id, item_revision, event_type,
       payload_json, status, created_at, updated_at
     ) VALUES ('wmo_legacy_1', ?, ?, 'wmi_legacy_1', 2, 'item_upserted',
       '{"id":"wmi_legacy_1"}', 'pending', ?, ?)`,
    JID,
    STORE_ID,
    AT,
    AT,
  );
  insert(
    `INSERT INTO workspace_memory_audit_events (
       id, workspace_jid, store_id, item_id, item_revision, store_revision,
       action, actor_type, actor_id, created_at
     ) VALUES ('wma_legacy_1', ?, ?, 'wmi_legacy_1', 2, 3, 'update',
       'web_user', 'legacy-owner', ?)`,
    JID,
    STORE_ID,
    AT,
  );
  raw.close();
}

function legacySqliteCounts(): Record<string, number> {
  const raw = new Database(databasePath, { readonly: true });
  try {
    const tables = [
      'workspace_memory_stores',
      'workspace_memory_items',
      'workspace_memory_versions',
      'workspace_memory_platform_items',
      'workspace_memory_provenance',
      'workspace_memory_tombstones',
      'workspace_memory_mutation_requests',
      'workspace_memory_outbox',
      'workspace_memory_audit_events',
    ];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table] = (
        raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count;
    }
    return counts;
  } finally {
    raw.close();
  }
}

async function postgresCounts(): Promise<Record<string, number>> {
  const tables = [
    'workspace_memory_stores',
    'workspace_memory_items',
    'workspace_memory_versions',
    'workspace_memory_platform_items',
    'workspace_memory_provenance',
    'workspace_memory_tombstones',
    'workspace_memory_mutation_requests',
    'workspace_memory_outbox',
    'workspace_memory_audit_events',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      count: number;
    }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function importMarker(): Promise<{
  completedAt: string;
  source: string;
  counts: Record<string, number>;
} | null> {
  const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
    value: string;
  }>('SELECT value FROM workspace_memory_meta WHERE key = $1', [
    LEGACY_IMPORT_MARKER_KEY,
  ]);
  const raw = result.rows[0]?.value;
  return raw ? JSON.parse(raw) : null;
}

async function restartMemoryStore(): Promise<void> {
  await memoryStore.closeWorkspaceMemoryStore();
  await memoryStore.initWorkspaceMemoryStore();
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Legacy import workspace',
    folder: 'legacy-import-workspace',
    added_at: AT,
    created_by: 'legacy-owner',
    is_home: false,
  } as never);
  db.closeDatabase();
  seedLegacySqliteTables();
  db.initDatabase();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy SQLite → PostgreSQL Workspace Memory import', () => {
  test('copies every legacy table once and keeps SQLite as a read-only backup', async () => {
    await memoryStore.initWorkspaceMemoryStore();

    const sqliteCounts = legacySqliteCounts();
    expect(sqliteCounts).toEqual({
      workspace_memory_stores: 1,
      workspace_memory_items: 3,
      workspace_memory_versions: 5,
      workspace_memory_platform_items: 1,
      workspace_memory_provenance: 5,
      workspace_memory_tombstones: 1,
      workspace_memory_mutation_requests: 1,
      workspace_memory_outbox: 1,
      workspace_memory_audit_events: 1,
    });
    expect(await postgresCounts()).toEqual(sqliteCounts);

    // Store revision and timestamps survive the copy unchanged.
    await expect(
      memoryStore.getWorkspaceMemoryStore(JID),
    ).resolves.toMatchObject({
      id: STORE_ID,
      workspaceJid: JID,
      revision: 3,
      createdAt: AT,
    });

    const marker = await importMarker();
    expect(marker).toMatchObject({ source: 'sqlite', counts: sqliteCounts });

    // The imported rows behave like native rows, including Chinese recall and
    // the tombstone that hides the forgotten item.
    const search = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid: JID,
      query: '中文内容',
      limit: 10,
    });
    expect(search.hits.map((hit) => hit.item.id)).toEqual(['wmi_legacy_1']);
    expect(
      (await memoryStore.listWorkspaceMemoryItems({ workspaceJid: JID })).items,
    ).toEqual([expect.objectContaining({ id: 'wmi_legacy_1', revision: 2 })]);
    // The tombstone survives the copy: the forgotten item is hidden from list
    // and search above, yet its detail and revision history remain readable,
    // and the reserved platform item stays out of every generic read.
    await expect(
      memoryStore.getWorkspaceMemoryItem(JID, 'wmi_legacy_1'),
    ).resolves.toMatchObject({ item: { id: 'wmi_legacy_1' } });
    await expect(
      memoryStore.getWorkspaceMemoryItem(JID, 'wmi_legacy_platform'),
    ).rejects.toMatchObject({ code: 'item_not_found' });
    expect(
      (
        await memoryStore.listWorkspaceMemoryVersions({
          workspaceJid: JID,
          itemId: 'wmi_legacy_2',
          limit: 10,
        })
      ).versions.map((version) => version.changeType),
    ).toEqual(['forget', 'create']);

    // SQLite still holds the original rows as a backup and is not written.
    expect(legacySqliteCounts()).toEqual(sqliteCounts);
  });

  test('a second start re-uses the marker instead of copying twice', async () => {
    const before = await postgresCounts();
    const markerBefore = await importMarker();

    await restartMemoryStore();

    expect(await postgresCounts()).toEqual(before);
    expect(await importMarker()).toEqual(markerBefore);
    await expect(
      memoryStore.getWorkspaceMemoryStore(JID),
    ).resolves.toMatchObject({ id: STORE_ID, revision: 3 });
  });

  test('new writes go only to PostgreSQL after the import', async () => {
    const sqliteBefore = legacySqliteCounts();
    await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'fact', content: '导入之后写入的新记忆' },
      context: {
        actorId: 'legacy-owner',
        sourceType: 'web_user',
        sourceId: 'post-import-source',
        sessionId: 'post-import-session',
      },
    });

    // The legacy tables are a frozen backup: the new item exists only in PG.
    expect(legacySqliteCounts()).toEqual(sqliteBefore);
    expect((await postgresCounts()).workspace_memory_items).toBe(
      sqliteBefore.workspace_memory_items + 1,
    );
    expect(
      (await memoryStore.listWorkspaceMemoryItems({ workspaceJid: JID })).items,
    ).toHaveLength(2);
  });
});
