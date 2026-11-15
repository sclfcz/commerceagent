import type { MemoryDatabase } from '../index.js';
import { sql as baselineSql } from './001-baseline.js';

export interface MemoryMigration {
  version: number;
  name: string;
  sql: string;
}

export const MEMORY_MIGRATIONS: readonly MemoryMigration[] = [
  { version: 1, name: 'baseline', sql: baselineSql },
];

export const MEMORY_SCHEMA_VERSION = Math.max(
  ...MEMORY_MIGRATIONS.map((migration) => migration.version),
);

/**
 * Version numbers in this list are allocated once and never reused:
 *
 * - 001 baseline — the Workspace Memory v2 storage move to PostgreSQL.
 * - 002 reserved — phase B: write-time retrieval keywords, pinned profile
 *   segment, three-way budgeted recall.
 * - 003 reserved — phase C: post-session extraction of proposed candidates.
 * - 004 reserved — phase D: nightly dedupe/merge worker and open-loop expiry.
 *
 * Each phase adds exactly one file here and never edits 001, so the three
 * phases can be developed in parallel without touching the same migration.
 */
export function describeReservedMigrationVersions(): Record<number, string> {
  return {
    2: 'phase B — retrieval keywords, pinned profile, budgeted recall',
    3: 'phase C — post-session proposed memory extraction',
    4: 'phase D — nightly dedupe/merge and open-loop expiry',
  };
}

/**
 * Apply every pending migration in ascending order. The bookkeeping table is
 * created first; each migration and its record commit in one transaction, so a
 * crash mid-way leaves the database at the last fully applied version.
 *
 * When the database records a version this build does not know about, the
 * caller is running against a newer schema than the code supports. That is
 * refused instead of being silently downgraded (mirrors the SQLite schema
 * version guard in `src/db.ts`).
 */
export async function migrateMemoryDatabase(
  db: MemoryDatabase,
  migrations: readonly MemoryMigration[] = MEMORY_MIGRATIONS,
): Promise<{ applied: number[]; version: number }> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_memory_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT COLLATE "C" NOT NULL
    );
  `);
  const recorded = await db.query<{ version: number | string }>(
    'SELECT version FROM workspace_memory_schema_migrations ORDER BY version',
  );
  const appliedVersions = recorded.rows.map((row) => Number(row.version));
  const current = appliedVersions.at(-1) ?? 0;
  const known = Math.max(...migrations.map((migration) => migration.version));
  if (current > known) {
    throw new Error(
      `Workspace Memory PostgreSQL schema version ${current} is newer than supported ${known}; refusing downgrade`,
    );
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (appliedVersions.includes(migration.version)) continue;
    await db.transaction(async (sql) => {
      await sql.exec(migration.sql);
      await sql.query(
        `INSERT INTO workspace_memory_schema_migrations (version, name, applied_at)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
    applied.push(migration.version);
  }
  return {
    applied,
    version: applied.at(-1) ?? current,
  };
}
