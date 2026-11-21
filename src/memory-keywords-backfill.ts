/**
 * One-shot backfill of `search_keys` for rows written before migration 002.
 *
 * Keys are derived metadata, not user content: recomputing them does not bump
 * an item revision or append a version row (a version cone only records
 * mutations). Explicit keys that a user or Agent supplies later are recorded in
 * the version history like any other field.
 */

import { deriveSearchKeys } from './memory-keywords.js';
import type {
  MemoryDatabase,
  MemoryRow,
  MemorySql,
} from './memory-pg/index.js';

interface BackfillRow extends MemoryRow {
  id: string;
  title: string | null;
  canonical_key: string | null;
  content: string;
}

const BACKFILL_BATCH_SIZE = 100;

async function backfillBatch(
  sql: MemorySql,
  rows: readonly BackfillRow[],
): Promise<number> {
  let updated = 0;
  for (const row of rows) {
    const keys = deriveSearchKeys({
      title: row.title,
      canonicalKey: row.canonical_key,
      content: row.content,
    });
    if (keys.length === 0) continue;
    const result = await sql.query(
      `UPDATE workspace_memory_items
       SET search_keys = $1::text[]
       WHERE id = $2 AND cardinality(search_keys) = 0`,
      [keys, row.id],
    );
    updated += result.rowCount;
  }
  return updated;
}

/**
 * Returns how many rows gained keys. Safe to re-run: rows that already have
 * keys are left untouched, so an explicit user-edited key list survives.
 */
export async function backfillWorkspaceMemorySearchKeys(
  db: MemoryDatabase,
): Promise<number> {
  const pending = await db.query<BackfillRow>(
    `SELECT id, title, canonical_key, content
     FROM workspace_memory_items
     WHERE cardinality(search_keys) = 0
     ORDER BY id`,
  );
  if (pending.rows.length === 0) return 0;
  let updated = 0;
  for (
    let index = 0;
    index < pending.rows.length;
    index += BACKFILL_BATCH_SIZE
  ) {
    const batch = pending.rows.slice(index, index + BACKFILL_BATCH_SIZE);
    updated += await db.transaction((sql) => backfillBatch(sql, batch));
  }
  return updated;
}
