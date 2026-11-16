import crypto from 'node:crypto';

import type { MemoryRow, MemorySql } from '../memory-pg/index.js';
import type {
  WorkspaceMemoryChangeType,
  WorkspaceMemoryKind,
  WorkspaceMemoryStatus,
} from '../memory-store.js';

/**
 * Shared write helpers for the nightly consolidation worker.
 *
 * The worker changes items outside the user-facing mutation primitives
 * (`updateWorkspaceMemoryItem` and friends) because it has no CAS revision from
 * a caller: it plans against a snapshot and applies with compare-and-set,
 * skipping anything that moved in between. What it must not change is the
 * lineage contract — every consolidated state is an ordinary item revision with
 * a version row, provenance, an audit event and an outbox event, so reading the
 * history explains it exactly like a human edit does.
 */

/** Actor recorded on every version and audit row the worker writes. */
export const MEMORY_CONSOLIDATION_ACTOR_ID = 'memory-consolidation-worker';

/** Provenance/actor vocabulary used for the worker itself. */
export const MEMORY_CONSOLIDATION_SOURCE_TYPE = 'memory_consolidation' as const;

export interface ConsolidationItemRow extends MemoryRow {
  id: string;
  store_id: string;
  workspace_jid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonical_key: string | null;
  status: WorkspaceMemoryStatus;
  importance: number | string;
  confidence: number | string;
  valid_from: string | null;
  valid_until: string | null;
  expires_at: string | null;
  revision: number | string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  pinned: boolean | null;
  superseded_by: string | null;
  demoted_from_kind: WorkspaceMemoryKind | null;
  demoted_at: string | null;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export async function loadConsolidationItem(
  sql: MemorySql,
  storeId: string,
  itemId: string,
): Promise<ConsolidationItemRow | null> {
  const result = await sql.query<ConsolidationItemRow>(
    `SELECT * FROM workspace_memory_items WHERE store_id = $1 AND id = $2`,
    [storeId, itemId],
  );
  return result.rows[0] ?? null;
}

export async function bumpStoreRevision(
  sql: MemorySql,
  storeId: string,
  at: string,
): Promise<number> {
  const result = await sql.query<{ revision: number | string }>(
    `UPDATE workspace_memory_stores
     SET revision = revision + 1, updated_at = $1
     WHERE id = $2
     RETURNING revision`,
    [at, storeId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Workspace memory store not found');
  return Number(row.revision);
}

export interface ConsolidationLineageInput {
  item: ConsolidationItemRow;
  /**
   * The revision the item had before this write. Its provenance row is what the
   * new revision inherits: consolidation never invents a source, it carries the
   * original one forward (and keeps the loser's references in the merge table).
   */
  previousRevision: number;
  storeRevision: number;
  changeType: WorkspaceMemoryChangeType;
  at: string;
}

/**
 * Write the version row for an already-updated item, then its provenance,
 * audit event and outbox event. Must run inside the same transaction as the
 * item UPDATE, on that transaction's connection.
 */
export async function appendConsolidationLineage(
  sql: MemorySql,
  input: ConsolidationLineageInput,
): Promise<void> {
  const { item } = input;
  await sql.query(
    `INSERT INTO workspace_memory_versions (
      item_id, revision, workspace_jid, kind, title, content, canonical_key,
      status, importance, confidence, valid_from, valid_until, expires_at,
      pinned, superseded_by, demoted_from_kind, demoted_at,
      change_type, actor_type, actor_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      item.id,
      Number(item.revision),
      item.workspace_jid,
      item.kind,
      item.title,
      item.content,
      item.canonical_key,
      item.status,
      Number(item.importance),
      Number(item.confidence),
      item.valid_from,
      item.valid_until,
      item.expires_at,
      item.pinned === true,
      item.superseded_by,
      item.demoted_from_kind,
      item.demoted_at,
      input.changeType,
      MEMORY_CONSOLIDATION_SOURCE_TYPE,
      MEMORY_CONSOLIDATION_ACTOR_ID,
      input.at,
    ],
  );

  const inherited = await sql.query(
    `INSERT INTO workspace_memory_provenance (
       item_id, revision, source_type, source_id, session_id, observed_at,
       recorded_at
     )
     SELECT item_id, $3, source_type, source_id, session_id, observed_at, $4
     FROM workspace_memory_provenance
     WHERE item_id = $1 AND revision = $2`,
    [item.id, input.previousRevision, Number(item.revision), input.at],
  );
  if (inherited.rowCount === 0) {
    // A legacy row can lack provenance entirely; attribute the consolidation
    // itself rather than leaving the revision undocumented.
    await sql.query(
      `INSERT INTO workspace_memory_provenance (
         item_id, revision, source_type, source_id, session_id, observed_at,
         recorded_at
       ) VALUES ($1, $2, $3, NULL, NULL, $4, $5)`,
      [
        item.id,
        Number(item.revision),
        MEMORY_CONSOLIDATION_SOURCE_TYPE,
        input.at,
        input.at,
      ],
    );
  }

  await sql.query(
    `INSERT INTO workspace_memory_audit_events (
      id, workspace_jid, store_id, item_id, item_revision, store_revision,
      action, actor_type, actor_id, source_id, session_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10)`,
    [
      newId('wma'),
      item.workspace_jid,
      item.store_id,
      item.id,
      Number(item.revision),
      input.storeRevision,
      input.changeType,
      MEMORY_CONSOLIDATION_SOURCE_TYPE,
      MEMORY_CONSOLIDATION_ACTOR_ID,
      input.at,
    ],
  );
  await sql.query(
    `INSERT INTO workspace_memory_outbox (
      id, workspace_jid, store_id, item_id, item_revision, event_type,
      payload_json, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
    [
      newId('wmo'),
      item.workspace_jid,
      item.store_id,
      item.id,
      Number(item.revision),
      `memory.${input.changeType}d`,
      JSON.stringify({
        workspaceJid: item.workspace_jid,
        storeRevision: input.storeRevision,
        itemId: item.id,
        itemRevision: Number(item.revision),
        status: item.status,
      }),
      input.at,
      input.at,
    ],
  );
}
