/**
 * Post-session extraction (migration 003, phase C).
 *
 * Adds the three pieces the extraction pipeline needs without touching the
 * baseline tables beyond one enum widening:
 *
 * - `workspace_memory_extraction_cursors` remembers, per Workspace and
 *   session, which message the last successful extraction consumed. It lives
 *   in the Memory database (not SQLite) because it is Memory bookkeeping. It is
 *   keyed by `workspace_jid` rather than by store id: a Workspace rebuild
 *   replaces the store and clears its messages, and a retained cursor then
 *   simply points before the first surviving message, which is harmless.
 * - `workspace_memory_candidates` carries the extraction-only payload that a
 *   `proposed` item does not have room for: the lesson applicability condition
 *   (`applies_when`), the model's retrieval keywords, the evidence message IDs,
 *   and the confirmation state/expiry deadline. Candidates are ordinary
 *   `workspace_memory_items` rows with `status = 'proposed'`; this side table
 *   only annotates them, so the existing revision/version/audit machinery keeps
 *   applying unchanged.
 * - The provenance `source_type` CHECK gains `agent_extraction` (automatic
 *   extraction) and `system` (host maintenance such as 14-day candidate
 *   expiry). Both are host-derived only; clients cannot submit a source type.
 *
 * Phase B owns 002 and phase D owns 004, so this file never edits 001 or the
 * other phases' migrations.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS workspace_memory_extraction_cursors (
  workspace_jid TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  last_message_timestamp TEXT COLLATE "C",
  last_message_id TEXT,
  last_extracted_at TEXT COLLATE "C",
  last_attempt_at TEXT COLLATE "C",
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  created_at TEXT COLLATE "C" NOT NULL,
  updated_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_jid, session_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_extraction_cursors_extracted
  ON workspace_memory_extraction_cursors(workspace_jid, last_extracted_at);

CREATE TABLE IF NOT EXISTS workspace_memory_candidates (
  item_id TEXT PRIMARY KEY
    REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
  workspace_jid TEXT NOT NULL,
  store_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT NOT NULL,
  applies_when TEXT,
  search_keys_json TEXT,
  evidence_message_ids_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'confirmed', 'rejected', 'expired')),
  model TEXT,
  created_at TEXT COLLATE "C" NOT NULL,
  expires_at TEXT COLLATE "C" NOT NULL,
  decided_at TEXT COLLATE "C",
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_candidates_pending
  ON workspace_memory_candidates(workspace_jid, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_candidates_session
  ON workspace_memory_candidates(store_id, session_key, created_at DESC);

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- The baseline declared this CHECK inline, so PostgreSQL chose its name.
  -- Look it up instead of assuming one, then replace it with an explicit name
  -- so a later phase can widen it the same way.
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'workspace_memory_provenance'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%source_type%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE workspace_memory_provenance DROP CONSTRAINT %I',
      constraint_name
    );
  END IF;
END $$;

ALTER TABLE workspace_memory_provenance
  ADD CONSTRAINT workspace_memory_provenance_source_type_check
  CHECK (source_type IN (
    'web_user',
    'agent_runtime',
    'scheduled_task',
    'migration',
    'agent_extraction',
    'system'
  ));
`;
