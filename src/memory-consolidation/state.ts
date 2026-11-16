import type {
  MemoryDatabase,
  MemoryRow,
  MemorySql,
} from '../memory-pg/index.js';

/**
 * Per-workspace consolidation bookkeeping.
 *
 * One row per workspace answers "when did this workspace last consolidate, with
 * what result" — the counters the monitor shows — and carries the lease that
 * makes a second service instance skip a workspace another instance is already
 * working on.
 *
 * The lease is a row rather than a PostgreSQL advisory lock because the
 * embedded PGlite backend has a single connection: an advisory lock taken on a
 * pooled connection would have to be released on that same connection, which
 * neither backend exposes. A row with an expiry is portable across both and is
 * just compare-and-set.
 */

export type ConsolidationRunStatus = 'success' | 'partial' | 'error';

export interface ConsolidationState {
  workspaceJid: string;
  lastRunAt: string | null;
  lastStatus: ConsolidationRunStatus | null;
  processed: number;
  merged: number;
  demoted: number;
  skippedGroups: number;
  lastError: string | null;
  durationMs: number | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
}

interface ConsolidationStateRow extends MemoryRow {
  workspace_jid: string;
  last_run_at: string | null;
  last_status: ConsolidationRunStatus | null;
  last_processed: number | string;
  last_merged: number | string;
  last_demoted: number | string;
  last_skipped_groups: number | string;
  last_error: string | null;
  last_duration_ms: number | string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
}

function mapState(row: ConsolidationStateRow): ConsolidationState {
  return {
    workspaceJid: row.workspace_jid,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    processed: Number(row.last_processed),
    merged: Number(row.last_merged),
    demoted: Number(row.last_demoted),
    skippedGroups: Number(row.last_skipped_groups),
    lastError: row.last_error,
    durationMs:
      row.last_duration_ms === null ? null : Number(row.last_duration_ms),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
  };
}

export async function listConsolidationStates(
  sql: MemorySql,
): Promise<ConsolidationState[]> {
  const rows = await sql.query<ConsolidationStateRow>(
    `SELECT * FROM workspace_memory_consolidation_state
     ORDER BY workspace_jid`,
  );
  return rows.rows.map(mapState);
}

async function ensureStateRow(
  sql: MemorySql,
  workspaceJid: string,
  at: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_memory_consolidation_state (
       workspace_jid, updated_at
     ) VALUES ($1, $2)
     ON CONFLICT (workspace_jid) DO NOTHING`,
    [workspaceJid, at],
  );
}

/**
 * Take the workspace lease, or report that another instance holds it.
 *
 * Expiry is compared as text: every timestamp this module writes is an
 * ISO-8601 UTC string with milliseconds, and the column is `COLLATE "C"`, so
 * byte order is time order. An expired lease is taken over, which is what lets
 * a crashed run be retried without operator intervention.
 */
export async function acquireConsolidationLease(
  db: MemoryDatabase,
  input: {
    workspaceJid: string;
    owner: string;
    now: Date;
    ttlMs: number;
  },
): Promise<boolean> {
  const at = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
  await ensureStateRow(db, input.workspaceJid, at);
  const result = await db.query(
    `UPDATE workspace_memory_consolidation_state
     SET lease_owner = $1, lease_expires_at = $2, updated_at = $3
     WHERE workspace_jid = $4
       AND (lease_owner IS NULL
            OR lease_expires_at IS NULL
            OR lease_expires_at <= $5)`,
    [input.owner, expiresAt, at, input.workspaceJid, at],
  );
  return result.rowCount === 1;
}

export async function releaseConsolidationLease(
  sql: MemorySql,
  input: { workspaceJid: string; owner: string; now: Date },
): Promise<void> {
  await sql.query(
    `UPDATE workspace_memory_consolidation_state
     SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
     WHERE workspace_jid = $2 AND lease_owner = $3`,
    [input.now.toISOString(), input.workspaceJid, input.owner],
  );
}

export interface ConsolidationRunRecord {
  workspaceJid: string;
  finishedAt: Date;
  status: ConsolidationRunStatus;
  processed: number;
  merged: number;
  demoted: number;
  skippedGroups: number;
  error: string | null;
  durationMs: number;
}

export async function recordConsolidationRun(
  sql: MemorySql,
  record: ConsolidationRunRecord,
): Promise<void> {
  const at = record.finishedAt.toISOString();
  await sql.query(
    `INSERT INTO workspace_memory_consolidation_state (
       workspace_jid, last_run_at, last_status, last_processed, last_merged,
       last_demoted, last_skipped_groups, last_error, last_duration_ms,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2)
     ON CONFLICT (workspace_jid) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       last_status = EXCLUDED.last_status,
       last_processed = EXCLUDED.last_processed,
       last_merged = EXCLUDED.last_merged,
       last_demoted = EXCLUDED.last_demoted,
       last_skipped_groups = EXCLUDED.last_skipped_groups,
       last_error = EXCLUDED.last_error,
       last_duration_ms = EXCLUDED.last_duration_ms,
       updated_at = EXCLUDED.updated_at`,
    [
      record.workspaceJid,
      at,
      record.status,
      record.processed,
      record.merged,
      record.demoted,
      record.skippedGroups,
      record.error,
      record.durationMs,
    ],
  );
}
