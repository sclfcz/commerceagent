import type { MemoryDatabase, MemorySql } from './index.js';

/**
 * Read-only handle on the SQLite database that used to own Workspace Memory.
 * The store layer receives it through `bindWorkspaceMemoryDatabase`.
 */
export interface LegacySqliteDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const LEGACY_IMPORT_MARKER_KEY = 'legacy_sqlite_import';

export interface LegacyImportOutcome {
  imported: boolean;
  reason:
    | 'already_imported'
    | 'no_legacy_tables'
    | 'no_legacy_rows'
    | 'postgres_not_empty'
    | 'imported';
  counts: Record<string, number>;
}

interface LegacyTable {
  table: string;
  columns: Array<{ name: string; default: unknown }>;
}

/**
 * Copy order follows the foreign keys: stores → items → versions → platform
 * items → provenance → tombstones → mutation requests → outbox → audit.
 */
const LEGACY_TABLES: readonly LegacyTable[] = [
  {
    table: 'workspace_memory_stores',
    columns: [
      { name: 'id', default: null },
      { name: 'workspace_jid', default: null },
      { name: 'revision', default: 0 },
      { name: 'created_at', default: null },
      { name: 'updated_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_items',
    columns: [
      { name: 'id', default: null },
      { name: 'store_id', default: null },
      { name: 'workspace_jid', default: null },
      { name: 'kind', default: null },
      { name: 'title', default: null },
      { name: 'content', default: '' },
      { name: 'canonical_key', default: null },
      { name: 'status', default: 'active' },
      { name: 'importance', default: 0.5 },
      { name: 'confidence', default: 1 },
      { name: 'valid_from', default: null },
      { name: 'valid_until', default: null },
      { name: 'expires_at', default: null },
      { name: 'revision', default: 1 },
      { name: 'create_idempotency_key', default: null },
      { name: 'create_request_hash', default: null },
      { name: 'created_at', default: null },
      { name: 'updated_at', default: null },
      { name: 'deleted_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_versions',
    columns: [
      { name: 'item_id', default: null },
      { name: 'revision', default: 1 },
      { name: 'workspace_jid', default: null },
      { name: 'kind', default: null },
      { name: 'title', default: null },
      { name: 'content', default: '' },
      { name: 'canonical_key', default: null },
      { name: 'status', default: null },
      { name: 'importance', default: 0.5 },
      { name: 'confidence', default: 1 },
      { name: 'valid_from', default: null },
      { name: 'valid_until', default: null },
      { name: 'expires_at', default: null },
      { name: 'change_type', default: null },
      { name: 'actor_type', default: 'migration' },
      { name: 'actor_id', default: 'legacy-sqlite-import' },
      { name: 'created_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_platform_items',
    columns: [
      { name: 'item_id', default: null },
      { name: 'namespace', default: null },
      { name: 'created_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_provenance',
    columns: [
      { name: 'item_id', default: null },
      { name: 'revision', default: 1 },
      { name: 'source_type', default: 'migration' },
      { name: 'source_id', default: null },
      { name: 'session_id', default: null },
      { name: 'observed_at', default: null },
      { name: 'recorded_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_tombstones',
    columns: [
      { name: 'item_id', default: null },
      { name: 'workspace_jid', default: null },
      { name: 'deleted_revision', default: 1 },
      { name: 'reason', default: null },
      { name: 'actor_type', default: 'migration' },
      { name: 'actor_id', default: 'legacy-sqlite-import' },
      { name: 'deleted_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_mutation_requests',
    columns: [
      { name: 'store_id', default: null },
      { name: 'idempotency_key', default: null },
      { name: 'operation', default: 'update' },
      { name: 'item_id', default: null },
      { name: 'request_hash', default: null },
      { name: 'response_json', default: '{}' },
      { name: 'created_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_outbox',
    columns: [
      { name: 'id', default: null },
      { name: 'workspace_jid', default: null },
      { name: 'store_id', default: null },
      { name: 'item_id', default: null },
      { name: 'item_revision', default: 1 },
      { name: 'event_type', default: null },
      { name: 'payload_json', default: '{}' },
      { name: 'status', default: 'pending' },
      { name: 'attempt', default: 0 },
      { name: 'available_at', default: null },
      { name: 'error', default: null },
      { name: 'created_at', default: null },
      { name: 'updated_at', default: null },
      { name: 'delivered_at', default: null },
    ],
  },
  {
    table: 'workspace_memory_audit_events',
    columns: [
      { name: 'id', default: null },
      { name: 'workspace_jid', default: null },
      { name: 'store_id', default: null },
      { name: 'item_id', default: null },
      { name: 'item_revision', default: 1 },
      { name: 'store_revision', default: 0 },
      { name: 'action', default: null },
      { name: 'actor_type', default: 'migration' },
      { name: 'actor_id', default: 'legacy-sqlite-import' },
      { name: 'source_id', default: null },
      { name: 'session_id', default: null },
      { name: 'created_at', default: null },
    ],
  },
];

const BATCH_SIZE = 100;

export async function buildMemoryMetaSchema(db: MemoryDatabase): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT COLLATE "C" NOT NULL
    );
  `);
}

async function readMeta(
  db: MemoryDatabase,
  key: string,
): Promise<string | null> {
  const result = await db.query<{ value: string }>(
    'SELECT value FROM workspace_memory_meta WHERE key = $1',
    [key],
  );
  return result.rows[0]?.value ?? null;
}

async function writeMeta(
  sql: MemorySql,
  key: string,
  value: string,
  at: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_memory_meta (key, value, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
    [key, value, at],
  );
}

function sqliteTableExists(
  sqlite: LegacySqliteDatabase,
  table: string,
): boolean {
  try {
    const row = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function sqliteColumns(
  sqlite: LegacySqliteDatabase,
  table: string,
): Set<string> {
  try {
    const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

function readLegacyRows(
  sqlite: LegacySqliteDatabase,
  spec: LegacyTable,
): Array<Record<string, unknown>> {
  const present = sqliteColumns(sqlite, spec.table);
  const select = spec.columns
    .map((column) =>
      present.has(column.name)
        ? `"${column.name}"`
        : `NULL AS "${column.name}"`,
    )
    .join(', ');
  const rows = sqlite
    .prepare(`SELECT ${select} FROM ${spec.table}`)
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => {
    const mapped: Record<string, unknown> = {};
    for (const column of spec.columns) {
      const value = row[column.name];
      mapped[column.name] = value === undefined ? column.default : value;
    }
    return mapped;
  });
}

async function insertRows(
  sql: MemorySql,
  spec: LegacyTable,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  const columnNames = spec.columns.map((column) => column.name);
  const columnList = columnNames.map((name) => `"${name}"`).join(', ');
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const params: unknown[] = [];
    const tuples = batch.map((row) => {
      const placeholders = columnNames.map((name) => {
        params.push(row[name] ?? null);
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await sql.query(
      `INSERT INTO ${spec.table} (${columnList}) VALUES ${tuples.join(', ')}
       ON CONFLICT DO NOTHING`,
      params,
    );
  }
}

async function postgresMemoryIsEmpty(db: MemoryDatabase): Promise<boolean> {
  for (const table of LEGACY_TABLES.map((spec) => spec.table)) {
    const result = await db.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM ${table}) AS present`,
    );
    if (result.rows[0]?.present) return false;
  }
  return true;
}

/**
 * One-shot copy of the retired SQLite Workspace Memory tables into PostgreSQL.
 *
 * The SQLite tables are never modified or dropped: they stay on disk as a
 * backup, and are read exactly once by this import. After the marker row is
 * committed the store never touches them again, so there is no dual-write and
 * no divergence to reconcile.
 *
 * The whole copy commits in one PostgreSQL transaction together with the
 * marker, so a crash either imports everything or nothing. A second start is a
 * no-op because the marker already exists.
 */
export async function importLegacySqliteMemory(input: {
  db: MemoryDatabase;
  sqlite: LegacySqliteDatabase;
  at?: string;
}): Promise<LegacyImportOutcome> {
  const { db, sqlite } = input;
  const at = input.at ?? new Date().toISOString();
  await buildMemoryMetaSchema(db);
  if (await readMeta(db, LEGACY_IMPORT_MARKER_KEY)) {
    return { imported: false, reason: 'already_imported', counts: {} };
  }
  const available = LEGACY_TABLES.filter((spec) =>
    sqliteTableExists(sqlite, spec.table),
  );
  if (available.length === 0) {
    return { imported: false, reason: 'no_legacy_tables', counts: {} };
  }
  const counts: Record<string, number> = {};
  const source = available.map((spec) => {
    const rows = readLegacyRows(sqlite, spec);
    counts[spec.table] = rows.length;
    return { spec, rows };
  });
  if (source.every((entry) => entry.rows.length === 0)) {
    return { imported: false, reason: 'no_legacy_rows', counts };
  }
  if (!(await postgresMemoryIsEmpty(db))) {
    return { imported: false, reason: 'postgres_not_empty', counts };
  }
  await db.transaction(async (sql) => {
    for (const entry of source) {
      await insertRows(sql, entry.spec, entry.rows);
    }
    await writeMeta(
      sql,
      LEGACY_IMPORT_MARKER_KEY,
      JSON.stringify({ completedAt: at, source: 'sqlite', counts }),
      at,
    );
  });
  return { imported: true, reason: 'imported', counts };
}

/** Live workspace JIDs (the `workspaces` mirror), for store provisioning. */
export function listWorkspaceJids(
  sqlite: LegacySqliteDatabase,
): string[] | null {
  if (!sqliteTableExists(sqlite, 'workspaces')) return null;
  const rows = sqlite
    .prepare("SELECT jid FROM workspaces WHERE status = 'active'")
    .all() as Array<{ jid?: string }>;
  return rows
    .map((row) => row.jid)
    .filter((jid): jid is string => typeof jid === 'string' && !!jid);
}

/** Workspace JIDs that still exist in SQLite, for orphaned-store cleanup. */
export function listKnownWorkspaceJids(
  sqlite: LegacySqliteDatabase,
): string[] | null {
  const jids = new Set<string>();
  let found = false;
  for (const table of ['workspaces', 'registered_groups']) {
    if (!sqliteTableExists(sqlite, table)) continue;
    const rows = sqlite.prepare(`SELECT jid FROM ${table}`).all() as Array<{
      jid?: string;
    }>;
    found = true;
    for (const row of rows) {
      if (typeof row.jid === 'string' && row.jid) jids.add(row.jid);
    }
  }
  return found ? [...jids] : null;
}
