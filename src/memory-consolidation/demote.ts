import type { MemoryDatabase, MemoryRow } from '../memory-pg/index.js';
import type { WorkspaceMemoryKind } from '../memory-store.js';
import {
  appendConsolidationLineage,
  bumpStoreRevision,
  loadConsolidationItem,
  type ConsolidationItemRow,
} from './lineage.js';

/**
 * Expiry demotion.
 *
 * A memory whose `expires_at` or `valid_until` has passed is no longer a usable
 * instruction: a promotion ended, a promise's window closed. It is not wrong
 * either, so it is never deleted. The nightly worker keeps the row searchable
 * but demotes it to history:
 *
 * - an expired `open_loop` becomes a `fact` (the thing it tracked is no longer
 *   open), marked in its title or content, with its expiry cleared;
 * - any other expired item (typically a temporary promotion stored as a `fact`)
 *   keeps its kind and is only marked and down-weighted;
 * - both get `demoted_at`, a capped importance, and cleared validity so the
 *   validity filter no longer hides them from search.
 *
 * `search_keys` are deliberately left untouched rather than re-derived from the
 * rewritten text: the demotion marker is bookkeeping, and a demoted item must
 * still be found by the terms it was known under while it was live. Re-deriving
 * would also write keys for the marker itself (`已过`, `过期`), which are noise
 * every expired item would match.
 *
 * Pinned items are never demoted, and readers must treat demoted items as
 * history: searchable, but never part of standing/recall context.
 */

/** Demoted items never outrank live onion-layer memories. */
export const DEMOTION_IMPORTANCE_CAP = 0.3;

/** Machine-visible marker added to the leading text field. */
export const DEMOTION_MARKER = '（已过期）';

export interface DemotionPlan {
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  importance: number;
  demotedFromKind: WorkspaceMemoryKind | null;
}

/**
 * Compute the demoted shape of an item.
 *
 * `expires_at` and `valid_until` are cleared on purpose: the demoted item is
 * meant to stay searchable, and both the search and recall queries filter on
 * them. Its previous values remain in the version row written with the change.
 */
export function planDemotion(item: ConsolidationItemRow): DemotionPlan {
  const importance = Math.min(Number(item.importance), DEMOTION_IMPORTANCE_CAP);
  const title = item.title?.trim() ? item.title : null;
  if (item.kind === 'open_loop') {
    // "标题或内容前加" — the marker goes on whichever field leads the item.
    return {
      kind: 'fact',
      title: title ? `${DEMOTION_MARKER}${title}` : null,
      content: title ? item.content : `${DEMOTION_MARKER}${item.content}`,
      importance,
      demotedFromKind: 'open_loop',
    };
  }
  return {
    kind: item.kind,
    title: item.title,
    content: item.content,
    importance,
    demotedFromKind: null,
  };
}

export interface DemoteBatchResult {
  scanned: number;
  demoted: number;
  skipped: number;
}

const EXPIRED_ITEM_PREDICATE = `
  i.store_id = $1
  AND i.status = 'active'
  AND i.demoted_at IS NULL
  AND i.pinned = false
  AND NOT EXISTS (
    SELECT 1 FROM workspace_memory_platform_items mpi WHERE mpi.item_id = i.id
  )
  AND (
    (i.expires_at IS NOT NULL AND i.expires_at::timestamptz <= $2::timestamptz)
    OR (i.valid_until IS NOT NULL AND i.valid_until::timestamptz <= $3::timestamptz)
  )
`;

/** One bounded demotion pass. Items that changed meanwhile are skipped. */
export async function demoteExpiredBatch(
  db: MemoryDatabase,
  options: {
    storeId: string;
    limit: number;
    now: Date;
  },
): Promise<DemoteBatchResult> {
  const at = options.now.toISOString();
  const candidates = await db.query<ConsolidationItemRow & MemoryRow>(
    `SELECT i.* FROM workspace_memory_items i
     WHERE ${EXPIRED_ITEM_PREDICATE}
     ORDER BY i.updated_at, i.id
     LIMIT $4`,
    [options.storeId, at, at, options.limit],
  );
  let demoted = 0;
  let skipped = 0;
  for (const candidate of candidates.rows) {
    const applied = await db.transaction(async (sql) => {
      const current = await loadConsolidationItem(
        sql,
        options.storeId,
        candidate.id,
      );
      if (
        !current ||
        current.status !== 'active' ||
        current.demoted_at ||
        current.pinned === true ||
        Number(current.revision) !== Number(candidate.revision)
      ) {
        return false;
      }
      const plan = planDemotion(current);
      const nextRevision = Number(current.revision) + 1;
      const updated = await sql.query(
        `UPDATE workspace_memory_items
         SET kind = $1, title = $2, content = $3, importance = $4,
             expires_at = NULL, valid_until = NULL, demoted_from_kind = $5,
             demoted_at = $6, revision = $7, updated_at = $8
         WHERE store_id = $9 AND id = $10 AND revision = $11
           AND status = 'active' AND pinned = false`,
        [
          plan.kind,
          plan.title,
          plan.content,
          plan.importance,
          plan.demotedFromKind,
          at,
          nextRevision,
          at,
          options.storeId,
          current.id,
          Number(current.revision),
        ],
      );
      if (updated.rowCount !== 1) return false;
      const after = await loadConsolidationItem(
        sql,
        options.storeId,
        current.id,
      );
      if (!after) return false;
      const storeRevision = await bumpStoreRevision(sql, options.storeId, at);
      await appendConsolidationLineage(sql, {
        item: after,
        previousRevision: Number(current.revision),
        storeRevision,
        changeType: 'update',
        at,
      });
      return true;
    });
    if (applied) demoted++;
    else skipped++;
  }
  return { scanned: candidates.rows.length, demoted, skipped };
}
