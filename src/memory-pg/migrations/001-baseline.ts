/**
 * Workspace Memory PostgreSQL baseline (migration 001).
 *
 * Column types intentionally mirror the retired SQLite schema:
 *
 * - identifiers, enums and timestamps are TEXT. Timestamps are ISO-8601 UTC
 *   strings and every such column is declared `COLLATE "C"` so equality and
 *   ordering are byte-wise, exactly like SQLite's BINARY collation. That keeps
 *   keyset pagination (`updated_at < ?`) identical across both engines and
 *   keeps the JSON payload of every Memory API byte-identical after the move.
 * - `importance`/`confidence` are DOUBLE PRECISION (SQLite REAL).
 * - counters are INTEGER (SQLite INTEGER).
 *
 * Full-text search replaces the FTS5 trigram table with a generated tsvector
 * using the `simple` configuration. The weights reproduce the retired bm25
 * column weights: title 3, canonical_key 2, content 1 (see also the search
 * query, which passes `'{0.3333,0,0.6667,1}'` to ts_rank in {D,C,B,A} order).
 * Substring recall (the old LIKE fallback, and what Chinese queries rely on)
 * is served by ILIKE, optionally accelerated by pg_trgm, which is installed by
 * the store bootstrap rather than here because extensions may be unavailable
 * to a restricted external PostgreSQL role.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS workspace_memory_stores (
  id TEXT PRIMARY KEY,
  workspace_jid TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT COLLATE "C" NOT NULL,
  updated_at TEXT COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_memory_items (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL
    REFERENCES workspace_memory_stores(id) ON DELETE CASCADE,
  workspace_jid TEXT NOT NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('fact', 'decision', 'lesson', 'open_loop')),
  title TEXT,
  content TEXT NOT NULL,
  canonical_key TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('active', 'proposed', 'conflicted', 'superseded', 'deleted')),
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5
    CHECK (importance >= 0 AND importance <= 1),
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1
    CHECK (confidence >= 0 AND confidence <= 1),
  valid_from TEXT COLLATE "C",
  valid_until TEXT COLLATE "C",
  expires_at TEXT COLLATE "C",
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  create_idempotency_key TEXT,
  create_request_hash TEXT,
  created_at TEXT COLLATE "C" NOT NULL,
  updated_at TEXT COLLATE "C" NOT NULL,
  deleted_at TEXT COLLATE "C",
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(canonical_key, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'D')
  ) STORED,
  UNIQUE (store_id, create_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_store_status_updated
  ON workspace_memory_items(store_id, status, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_workspace_kind
  ON workspace_memory_items(workspace_jid, kind, status);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_validity
  ON workspace_memory_items(store_id, valid_from, valid_until, expires_at);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_canonical_key
  ON workspace_memory_items(store_id, canonical_key);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_search
  ON workspace_memory_items USING gin (search_vector);

CREATE TABLE IF NOT EXISTS workspace_memory_versions (
  item_id TEXT NOT NULL
    REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  workspace_jid TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  canonical_key TEXT,
  status TEXT NOT NULL,
  importance DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  valid_from TEXT COLLATE "C",
  valid_until TEXT COLLATE "C",
  expires_at TEXT COLLATE "C",
  change_type TEXT NOT NULL CHECK (change_type IN ('create', 'update', 'forget')),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (item_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_versions_workspace_created
  ON workspace_memory_versions(workspace_jid, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_memory_platform_items (
  item_id TEXT PRIMARY KEY
    REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  created_at TEXT COLLATE "C" NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_platform_namespace
  ON workspace_memory_platform_items(namespace, item_id);

CREATE TABLE IF NOT EXISTS workspace_memory_provenance (
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('web_user', 'agent_runtime', 'scheduled_task', 'migration')),
  source_id TEXT,
  session_id TEXT,
  observed_at TEXT COLLATE "C",
  recorded_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (item_id, revision),
  FOREIGN KEY (item_id, revision)
    REFERENCES workspace_memory_versions(item_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_memory_tombstones (
  item_id TEXT PRIMARY KEY
    REFERENCES workspace_memory_items(id) ON DELETE CASCADE,
  workspace_jid TEXT NOT NULL,
  deleted_revision INTEGER NOT NULL,
  reason TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  deleted_at TEXT COLLATE "C" NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_memory_mutation_requests (
  store_id TEXT NOT NULL
    REFERENCES workspace_memory_stores(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('update', 'forget')),
  item_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (store_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS workspace_memory_outbox (
  id TEXT PRIMARY KEY,
  workspace_jid TEXT NOT NULL,
  store_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at TEXT COLLATE "C",
  error TEXT,
  created_at TEXT COLLATE "C" NOT NULL,
  updated_at TEXT COLLATE "C" NOT NULL,
  delivered_at TEXT COLLATE "C"
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_outbox_pending
  ON workspace_memory_outbox(status, available_at, created_at);

CREATE TABLE IF NOT EXISTS workspace_memory_audit_events (
  id TEXT PRIMARY KEY,
  workspace_jid TEXT NOT NULL,
  store_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  item_revision INTEGER NOT NULL,
  store_revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source_id TEXT,
  session_id TEXT,
  created_at TEXT COLLATE "C" NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_audit_workspace_created
  ON workspace_memory_audit_events(workspace_jid, created_at DESC);
`;
