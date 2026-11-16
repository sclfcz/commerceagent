import type {
  MemoryDatabase,
  MemoryRow,
  MemorySql,
} from '../memory-pg/index.js';
import type { WorkspaceMemoryKind } from '../memory-store.js';
import {
  MEMORY_CONSOLIDATION_SOURCE_TYPE,
  appendConsolidationLineage,
  bumpStoreRevision,
  loadConsolidationItem,
} from './lineage.js';

/**
 * Deterministic duplicate detection and merge.
 *
 * Only facts the database can decide on its own take part: equality of
 * `canonical_key`, equality of the normalized content, or a high trigram
 * similarity paired with the same title. No model is called, so the same input
 * always produces the same merge — which is the property that makes an
 * unattended nightly rewrite acceptable.
 */

/** Two contents are "the same text" at or above this pg_trgm similarity. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

export type DuplicateReason =
  | 'canonical_key'
  | 'normalized_content'
  | 'similarity';

/** Lower-cased, whitespace-free, punctuation-free content. */
const NORMALIZED_CONTENT_SQL = (alias: string) =>
  `regexp_replace(lower(${alias}.content), ` +
  `'[[:space:][:punct:]，。！？；：、“”‘’（）《》【】…—·「」『』〈〉～￥]', '', 'g')`;

const CANDIDATE_FILTER = `
  i.store_id = $1
  AND i.status = 'active'
  AND i.demoted_at IS NULL
  AND i.superseded_by IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM workspace_memory_platform_items mpi WHERE mpi.item_id = i.id
  )
`;

export interface PlannedDuplicate {
  id: string;
  revision: number;
  importance: number;
  updatedAt: string;
}

export interface DuplicateGroup {
  storeId: string;
  workspaceJid: string;
  kind: WorkspaceMemoryKind;
  reason: DuplicateReason;
  /** The item that survives: highest importance, then most recently updated. */
  keeper: PlannedDuplicate;
  /** Items absorbed into the keeper, all marked `superseded`. */
  duplicates: PlannedDuplicate[];
}

interface PairRow extends MemoryRow {
  left_id: string;
  left_revision: number | string;
  left_importance: number | string;
  left_updated_at: string;
  right_id: string;
  right_revision: number | string;
  right_importance: number | string;
  right_updated_at: string;
  kind: WorkspaceMemoryKind;
  same_canonical_key: boolean;
  same_normalized_content: boolean;
  same_title: boolean;
  content_similarity?: number | string | null;
}

function planned(row: PairRow, side: 'left' | 'right'): PlannedDuplicate {
  return {
    id: row[`${side}_id`],
    revision: Number(row[`${side}_revision`]),
    importance: Number(row[`${side}_importance`]),
    updatedAt: row[`${side}_updated_at`],
  };
}

function reasonOf(row: PairRow, threshold: number): DuplicateReason | null {
  if (row.same_canonical_key) return 'canonical_key';
  if (row.same_normalized_content) return 'normalized_content';
  if (
    row.content_similarity !== undefined &&
    row.content_similarity !== null &&
    Number(row.content_similarity) >= threshold &&
    row.same_title
  ) {
    return 'similarity';
  }
  return null;
}

const REASON_RANK: Record<DuplicateReason, number> = {
  canonical_key: 3,
  normalized_content: 2,
  similarity: 1,
};

/**
 * Compare every candidate against every other candidate of the same kind.
 *
 * The pairwise join is bounded by the batch limit (a few hundred items), and
 * the index on (store_id, kind, status) narrows it to one workspace before the
 * join, so a nightly pass stays cheap even for a long-lived workspace.
 */
async function findDuplicatePairs(
  sql: MemorySql,
  options: {
    storeId: string;
    limit: number;
    trigramAvailable: boolean;
  },
): Promise<PairRow[]> {
  const similarityColumn = options.trigramAvailable
    ? `similarity(a.content, b.content) AS content_similarity`
    : `NULL AS content_similarity`;
  const similarityCondition = options.trigramAvailable
    ? `OR (content_similarity >= $3 AND same_title)`
    : '';
  const params: unknown[] = [options.storeId, options.limit];
  if (options.trigramAvailable) params.push(DEFAULT_SIMILARITY_THRESHOLD);
  const result = await sql.query<PairRow>(
    `WITH candidates AS (
       SELECT i.id, i.revision, i.kind, i.title, i.content, i.canonical_key,
              i.importance, i.updated_at
       FROM workspace_memory_items i
       WHERE ${CANDIDATE_FILTER}
       ORDER BY i.id
       LIMIT $2
     ),
     pairs AS (
       SELECT
         a.id AS left_id, a.revision AS left_revision,
         a.importance AS left_importance, a.updated_at AS left_updated_at,
         b.id AS right_id, b.revision AS right_revision,
         b.importance AS right_importance, b.updated_at AS right_updated_at,
         a.kind AS kind,
         (a.canonical_key IS NOT NULL
           AND a.canonical_key = b.canonical_key) AS same_canonical_key,
         (${NORMALIZED_CONTENT_SQL('a')}
           = ${NORMALIZED_CONTENT_SQL('b')}) AS same_normalized_content,
         (btrim(lower(coalesce(a.title, '')))
           = btrim(lower(coalesce(b.title, '')))) AS same_title,
         ${similarityColumn}
       FROM candidates a
       JOIN candidates b ON b.kind = a.kind AND b.id > a.id
     )
     SELECT * FROM pairs
     WHERE same_canonical_key OR same_normalized_content ${similarityCondition}`,
    params,
  );
  return result.rows;
}

async function countCandidates(
  sql: MemorySql,
  storeId: string,
  limit: number,
): Promise<number> {
  const result = await sql.query<{ total: number | string }>(
    `SELECT count(*) AS total FROM (
       SELECT 1 FROM workspace_memory_items i
       WHERE ${CANDIDATE_FILTER}
       ORDER BY i.id
       LIMIT $2
     ) candidates`,
    [storeId, limit],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/** Pick the survivor of a group, deterministically. */
function pickKeeper(candidates: PlannedDuplicate[]): PlannedDuplicate {
  return [...candidates].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.id < b.id ? -1 : 1;
  })[0];
}

/**
 * Plan the duplicate groups for one workspace.
 *
 * Pairs are joined transitively: if A matches B by canonical key and B matches C
 * by similarity, all three form one group and one keeper absorbs both. Every
 * group stays inside a single kind because pairs only compare equal kinds.
 */
export async function planDuplicateGroups(
  sql: MemorySql,
  options: {
    storeId: string;
    workspaceJid: string;
    limit: number;
    trigramAvailable: boolean;
  },
): Promise<{ scanned: number; groups: DuplicateGroup[] }> {
  const scanned = await countCandidates(sql, options.storeId, options.limit);
  if (scanned < 2) return { scanned, groups: [] };

  const pairs = await findDuplicatePairs(sql, options);
  const parent = new Map<string, string>();
  const items = new Map<string, PlannedDuplicate>();
  const kinds = new Map<string, WorkspaceMemoryKind>();
  const groupReason = new Map<string, DuplicateReason>();

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps repeated lookups on a large group cheap.
    let node = id;
    while (parent.get(node) !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const row of pairs) {
    const reason = reasonOf(row, DEFAULT_SIMILARITY_THRESHOLD);
    if (!reason) continue;
    const left = planned(row, 'left');
    const right = planned(row, 'right');
    for (const item of [left, right]) {
      if (!parent.has(item.id)) parent.set(item.id, item.id);
      items.set(item.id, item);
      kinds.set(item.id, row.kind);
    }
    union(left.id, right.id);
    for (const id of [left.id, right.id]) {
      const previous = groupReason.get(find(id));
      if (!previous || REASON_RANK[reason] > REASON_RANK[previous]) {
        groupReason.set(find(id), reason);
      }
    }
  }

  const buckets = new Map<string, PlannedDuplicate[]>();
  for (const id of items.keys()) {
    const root = find(id);
    const bucket = buckets.get(root) ?? [];
    bucket.push(items.get(id)!);
    buckets.set(root, bucket);
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, members] of buckets) {
    if (members.length < 2) continue;
    const keeper = pickKeeper(members);
    groups.push({
      storeId: options.storeId,
      workspaceJid: options.workspaceJid,
      kind: kinds.get(keeper.id)!,
      reason: groupReason.get(root) ?? 'similarity',
      keeper,
      duplicates: members.filter((member) => member.id !== keeper.id),
    });
  }
  // Apply the largest, oldest groups first so a partial run still makes visible
  // progress and the order is stable across identical databases.
  groups.sort((a, b) => {
    if (b.duplicates.length !== a.duplicates.length) {
      return b.duplicates.length - a.duplicates.length;
    }
    return a.keeper.id < b.keeper.id ? -1 : 1;
  });
  return { scanned, groups };
}

/** Raised when any row in a group moved since it was planned. */
class MergeGroupConflict extends Error {}

export interface MergeGroupResult {
  applied: boolean;
  /** Present when `applied` is false: the group is deferred to the next run. */
  reason?: 'revision_conflict' | 'not_active';
  keeperId: string;
  mergedIds: string[];
}

/**
 * Apply one merge group in a single transaction.
 *
 * Every update is a compare-and-set against the revision captured while
 * planning. A conflict rolls the whole group back and reports it as skipped,
 * rather than overwriting a concurrent edit or applying half a merge. The
 * group is retried by a later pass once it is stable again.
 */
export async function applyMergeGroup(
  db: MemoryDatabase,
  group: DuplicateGroup,
  at: string,
): Promise<MergeGroupResult> {
  const { storeId, keeper } = group;
  try {
    return await db.transaction(async (sql) => {
      const keeperRow = await loadConsolidationItem(sql, storeId, keeper.id);
      if (!keeperRow || keeperRow.status !== 'active' || keeperRow.demoted_at) {
        return {
          applied: false,
          reason: 'not_active',
          keeperId: keeper.id,
          mergedIds: [],
        };
      }
      const highestImportance = Math.max(
        keeper.importance,
        ...group.duplicates.map((duplicate) => duplicate.importance),
      );
      const keeperRevision = keeper.revision + 1;
      const updatedKeeper = await sql.query(
        `UPDATE workspace_memory_items
         SET importance = $1, revision = $2, updated_at = $3
         WHERE store_id = $4 AND id = $5 AND revision = $6
           AND status = 'active' AND demoted_at IS NULL`,
        [
          highestImportance,
          keeperRevision,
          at,
          storeId,
          keeper.id,
          keeper.revision,
        ],
      );
      if (updatedKeeper.rowCount !== 1) throw new MergeGroupConflict();

      const mergedIds: string[] = [];
      for (const duplicate of group.duplicates) {
        const duplicateRevision = duplicate.revision + 1;
        const superseded = await sql.query(
          `UPDATE workspace_memory_items
           SET status = 'superseded', superseded_by = $1, revision = $2,
               updated_at = $3
           WHERE store_id = $4 AND id = $5 AND revision = $6
             AND status = 'active'`,
          [
            keeper.id,
            duplicateRevision,
            at,
            storeId,
            duplicate.id,
            duplicate.revision,
          ],
        );
        if (superseded.rowCount !== 1) throw new MergeGroupConflict();
        mergedIds.push(duplicate.id);
      }

      const keeperAfter = await loadConsolidationItem(sql, storeId, keeper.id);
      if (!keeperAfter) throw new MergeGroupConflict();
      const keeperStoreRevision = await bumpStoreRevision(sql, storeId, at);
      await appendConsolidationLineage(sql, {
        item: keeperAfter,
        previousRevision: keeper.revision,
        storeRevision: keeperStoreRevision,
        changeType: 'update',
        at,
      });

      // The keeper's own provenance row keeps its original source; the merged
      // items' references are archived under this revision.
      for (const duplicate of group.duplicates) {
        const duplicateAfter = await loadConsolidationItem(
          sql,
          storeId,
          duplicate.id,
        );
        if (!duplicateAfter) throw new MergeGroupConflict();
        const duplicateRevision = duplicate.revision + 1;
        await sql.query(
          `INSERT INTO workspace_memory_merge_sources (
             item_id, revision, merged_item_id, merged_revision, source_type,
             source_id, session_id, observed_at, merged_at
           )
           SELECT $1, $2, $3, $4, coalesce(p.source_type, $5),
                  p.source_id, p.session_id, p.observed_at, $6
           FROM (SELECT $3::text AS merged_item_id) merged
           LEFT JOIN workspace_memory_provenance p
             ON p.item_id = merged.merged_item_id AND p.revision = $7`,
          [
            keeper.id,
            keeperRevision,
            duplicate.id,
            duplicateRevision,
            MEMORY_CONSOLIDATION_SOURCE_TYPE,
            at,
            duplicate.revision,
          ],
        );
        const duplicateStoreRevision = await bumpStoreRevision(
          sql,
          storeId,
          at,
        );
        await appendConsolidationLineage(sql, {
          item: duplicateAfter,
          previousRevision: duplicate.revision,
          storeRevision: duplicateStoreRevision,
          changeType: 'update',
          at,
        });
      }

      return {
        applied: true,
        keeperId: keeper.id,
        mergedIds,
      } satisfies MergeGroupResult;
    });
  } catch (error) {
    if (error instanceof MergeGroupConflict) {
      return {
        applied: false,
        reason: 'revision_conflict',
        keeperId: keeper.id,
        mergedIds: [],
      };
    }
    throw error;
  }
}

export interface MergeBatchResult {
  scanned: number;
  merged: number;
  skippedGroups: number;
}

/** One bounded dedupe pass. The worker repeats it until it stops merging. */
export async function mergeDuplicateBatch(
  db: MemoryDatabase,
  options: {
    storeId: string;
    workspaceJid: string;
    limit: number;
    trigramAvailable: boolean;
    now: Date;
  },
): Promise<MergeBatchResult> {
  const { scanned, groups } = await planDuplicateGroups(db, options);
  let merged = 0;
  let skippedGroups = 0;
  for (const group of groups) {
    const result = await applyMergeGroup(db, group, options.now.toISOString());
    if (result.applied) merged += result.mergedIds.length;
    else skippedGroups++;
  }
  return { scanned, merged, skippedGroups };
}

/**
 * pg_trgm is optional (an external PostgreSQL role may not be allowed to create
 * extensions). Without it the trigram arm is dropped and only the exact arms —
 * canonical key and normalized content — still merge.
 */
export async function isTrigramSimilarityAvailable(
  sql: MemorySql,
): Promise<boolean> {
  try {
    const result = await sql.query<{ fn: string | null }>(
      `SELECT to_regprocedure('similarity(text,text)')::text AS fn`,
    );
    return Boolean(result.rows[0]?.fn);
  } catch {
    return false;
  }
}
