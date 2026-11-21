/**
 * Workspace Memory retrieval keywords + pinned profile (migration 002).
 *
 * `search_keys` holds up to 12 deterministic retrieval keys per item. The host
 * derives them from title/canonical_key/content unless the Agent or the Web UI
 * supplies an explicit list (`src/memory-keywords.ts`).
 *
 * The generated `search_vector` is rebuilt so the keys participate in
 * full-text search with the same weight as the title (A). `array_to_tsvector`
 * is used instead of `array_to_string(...) → to_tsvector(...)` because
 * `array_to_string` is not immutable and PostgreSQL rejects it in a generated
 * column. Keys are stored normalized (lowercase) so no dictionary is needed.
 *
 * `pinned` marks core shop-profile / identity preferences that must be
 * recalled on every turn; it is a normal column guarded by the item revision
 * compare-and-set, and every version row records it.
 */
export const sql = `
ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS search_keys TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE workspace_memory_items
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE workspace_memory_items DROP COLUMN IF EXISTS search_vector;

ALTER TABLE workspace_memory_items
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(canonical_key, '')), 'B') ||
    setweight(array_to_tsvector(search_keys), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_search
  ON workspace_memory_items USING gin (search_vector);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_pinned
  ON workspace_memory_items(store_id, importance DESC, updated_at DESC)
  WHERE pinned;

ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS search_keys TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE workspace_memory_versions
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
`;
