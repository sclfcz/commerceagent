/**
 * Workspace Memory PostgreSQL migration 004 (phase D).
 *
 * Nightly consolidation needs a few columns the baseline did not have, and both
 * this migration and phase B's must stay idempotent because either branch may
 * run first:
 *
 * - `pinned` marks a standing-profile memory. A pinned item is never demoted by
 *   the nightly worker. Phase B adds the same column with the same
 *   `IF NOT EXISTS` guard, so applying both in either order is a no-op.
 * - `superseded_by` records, on a merged duplicate, which item absorbed it.
 * - `demoted_from_kind` / `demoted_at` record an expiry demotion: the original
 *   kind when the kind changed (open_loop → fact) and the instant it happened.
 *
 * The four columns exist on `workspace_memory_versions` as well, so the version
 * chain can explain every consolidated state instead of only the live row.
 *
 * `workspace_memory_merge_sources` keeps the provenance references of every
 * merged item under the keeper's merge revision. Provenance is one row per
 * (item, revision), so the keeper's own reference cannot also carry the
 * losers'; this table is where "merge both sides' sources" is recorded without
 * rewriting immutable history.
 *
 * `workspace_memory_consolidation_state` holds one row per workspace: the last
 * run's counters plus the lease that keeps two service instances from
 * consolidating the same workspace at once.
 */
export const sql = `
ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS demoted_from_kind text;
ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS demoted_at text COLLATE "C";

ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS superseded_by text;
ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS demoted_from_kind text;
ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS demoted_at text COLLATE "C";

-- The nightly worker acts as its own actor. The vocabulary is rebuilt from what
-- the constraint already allows plus memory_consolidation, so a phase that
-- extends the same list in an earlier migration keeps its values after this one
-- runs. Everything else about provenance keeps its original vocabulary.
DO $$
DECLARE
  current_definition text;
  allowed_values text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO current_definition
  FROM pg_constraint c
  WHERE c.conrelid = 'workspace_memory_provenance'::regclass
    AND c.conname = 'workspace_memory_provenance_source_type_check';

  IF current_definition IS NOT NULL
    AND position('memory_consolidation' IN current_definition) > 0 THEN
    RETURN;
  END IF;

  SELECT string_agg(quote_literal(value), ', ' ORDER BY value)
    INTO allowed_values
  FROM (
    SELECT unnest(ARRAY[
      'web_user', 'agent_runtime', 'scheduled_task', 'migration',
      'memory_consolidation'
    ]) AS value
    UNION
    SELECT DISTINCT t.vals[1]
    FROM regexp_matches(
      coalesce(current_definition, ''), '''([^'']+)''', 'g'
    ) AS t(vals)
  ) vocabulary;

  EXECUTE 'ALTER TABLE workspace_memory_provenance '
    'DROP CONSTRAINT IF EXISTS workspace_memory_provenance_source_type_check';
  EXECUTE format(
    'ALTER TABLE workspace_memory_provenance '
    'ADD CONSTRAINT workspace_memory_provenance_source_type_check '
    'CHECK (source_type IN (%s))',
    allowed_values
  );
END $$;

CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_active_expiry
  ON workspace_memory_items(store_id, expires_at)
  WHERE status = 'active' AND demoted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_active_valid_until
  ON workspace_memory_items(store_id, valid_until)
  WHERE status = 'active' AND demoted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_superseded_by
  ON workspace_memory_items(store_id, superseded_by)
  WHERE superseded_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_memory_merge_sources (
  item_id TEXT NOT NULL
    REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  merged_item_id TEXT NOT NULL,
  merged_revision INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  session_id TEXT,
  observed_at TEXT COLLATE "C",
  merged_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (item_id, revision, merged_item_id),
  FOREIGN KEY (item_id, revision)
    REFERENCES workspace_memory_versions(item_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_merge_sources_merged
  ON workspace_memory_merge_sources(merged_item_id);

CREATE TABLE IF NOT EXISTS workspace_memory_consolidation_state (
  workspace_jid TEXT PRIMARY KEY,
  last_run_at TEXT COLLATE "C",
  last_status TEXT
    CHECK (last_status IN ('success', 'partial', 'error')),
  last_processed INTEGER NOT NULL DEFAULT 0,
  last_merged INTEGER NOT NULL DEFAULT 0,
  last_demoted INTEGER NOT NULL DEFAULT 0,
  last_skipped_groups INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_duration_ms INTEGER,
  lease_owner TEXT,
  lease_expires_at TEXT COLLATE "C",
  updated_at TEXT COLLATE "C" NOT NULL
);
`;
