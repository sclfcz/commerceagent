import crypto from 'node:crypto';

import path from 'node:path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';
import {
  createMemoryDatabase,
  resolveMemoryDatabaseConfig,
  type MemoryDatabase,
  type MemoryQueryResult,
  type MemoryRow,
  type MemorySql,
} from './memory-pg/index.js';
import {
  importLegacySqliteMemory,
  listKnownWorkspaceJids,
  listWorkspaceJids,
  type LegacySqliteDatabase,
} from './memory-pg/legacy-sqlite-import.js';
import { migrateMemoryDatabase } from './memory-pg/migrations/index.js';
import {
  deriveQueryKeywords,
  deriveSearchKeys,
  keywordsToTsQuery,
  normalizeSearchKeys,
} from './memory-keywords.js';
import { backfillWorkspaceMemorySearchKeys } from './memory-keywords-backfill.js';

/**
 * Workspace Memory v2 storage.
 *
 * Workspace Memory lives in PostgreSQL (see `src/memory-pg/index.ts`) while the
 * rest of CommerceAgent stays on SQLite. Every function in this module is
 * async because the storage engine is reached over a real connection pool, in
 * both the external-PostgreSQL and the embedded-PGlite deployment.
 *
 * Timestamps are stored as ISO-8601 UTC text in `COLLATE "C"` columns, so
 * ordering and keyset pagination are byte-wise exactly as they were under
 * SQLite's BINARY collation, and API payloads stay byte-identical.
 *
 * Cross-database operations (workspace deletion, rebuild) cannot share a
 * transaction with SQLite. Their call sites follow one rule: delete Memory
 * first (idempotent), then commit SQLite. See `deleteWorkspaceMemoryData` and
 * `resetWorkspaceMemoryData` for the failure semantics.
 */

export type WorkspaceMemoryKind = 'fact' | 'decision' | 'lesson' | 'open_loop';

export type WorkspaceMemoryStatus =
  | 'active'
  | 'proposed'
  | 'conflicted'
  | 'superseded'
  | 'deleted';

export type WorkspaceMemoryChangeType = 'create' | 'update' | 'forget';

export type WorkspaceMemorySourceType =
  | 'web_user'
  | 'agent_runtime'
  | 'scheduled_task'
  | 'migration'
  | 'agent_extraction'
  | 'system'
  | 'memory_consolidation';

/** One durable Home Workspace fact completes CommerceAgent's first-wake ritual. */
export const COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY =
  'happyclaw.owner.preferred_address';
const COMMERCEAGENT_OWNER_PROFILE_MEMORY_NAMESPACE = 'happyclaw.owner-profile';

export interface WorkspaceMemoryProvenance {
  sourceType: WorkspaceMemorySourceType;
  sourceId: string | null;
  sessionId: string | null;
  observedAt: string | null;
}

export interface WorkspaceMemoryItem {
  id: string;
  workspaceJid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonicalKey: string | null;
  /**
   * Deterministic retrieval keys (phase B). Derived from the item text at
   * write time unless the Agent/Web caller supplied an explicit list.
   */
  searchKeys: string[];
  /**
   * Core shop profile / identity preference that is always recalled. Mutated
   * through the same revision compare-and-set as every other field.
   */
  pinned: boolean;
  status: WorkspaceMemoryStatus;
  importance: number;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Set on a merged duplicate: the item that absorbed it. */
  supersededBy: string | null;
  /** The kind this item had before an expiry demotion changed it. */
  demotedFromKind: WorkspaceMemoryKind | null;
  /** When the nightly worker demoted this item as expired or out of validity. */
  demotedAt: string | null;
  provenance: WorkspaceMemoryProvenance;
}

export interface WorkspaceMemoryVersion extends Omit<
  WorkspaceMemoryItem,
  'revision' | 'updatedAt' | 'deletedAt'
> {
  revision: number;
  changeType: WorkspaceMemoryChangeType;
  createdAt: string;
  actor: {
    type: WorkspaceMemorySourceType;
    id: string;
  };
}

export interface WorkspaceMemoryStore {
  id: string;
  workspaceJid: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMemoryMutationContext {
  actorId: string;
  sourceType: WorkspaceMemorySourceType;
  sourceId?: string | null;
  sessionId?: string | null;
  observedAt?: string | null;
}

export interface WorkspaceMemoryValue {
  kind: WorkspaceMemoryKind;
  title?: string | null;
  content: string;
  canonicalKey?: string | null;
  /** Explicit keys; empty/omitted means "derive from the item text". */
  searchKeys?: string[] | null;
  pinned?: boolean;
  status?: Exclude<WorkspaceMemoryStatus, 'deleted'>;
  importance?: number;
  confidence?: number;
  validFrom?: string | null;
  validUntil?: string | null;
  expiresAt?: string | null;
}

interface MemoryItemRow extends MemoryRow {
  id: string;
  workspace_jid: string;
  kind: WorkspaceMemoryKind;
  title: string | null;
  content: string;
  canonical_key: string | null;
  search_keys: string[] | null;
  pinned: boolean | null;
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
  superseded_by: string | null;
  demoted_from_kind: WorkspaceMemoryKind | null;
  demoted_at: string | null;
  source_type: WorkspaceMemorySourceType | null;
  source_id: string | null;
  session_id: string | null;
  observed_at: string | null;
}

interface MemoryVersionRow extends MemoryItemRow {
  change_type: WorkspaceMemoryChangeType;
  actor_type: WorkspaceMemorySourceType;
  actor_id: string;
}

interface MemoryStoreRow extends MemoryRow {
  id: string;
  workspace_jid: string;
  revision: number | string;
  created_at: string;
  updated_at: string;
}

export class WorkspaceMemoryStoreError extends Error {
  constructor(
    public readonly code:
      | 'store_not_found'
      | 'item_not_found'
      | 'revision_conflict'
      | 'idempotency_conflict'
      | 'reserved_canonical_key',
    message: string,
    public readonly details?: {
      currentRevision?: number;
      storeRevision?: number;
    },
  ) {
    super(message);
    this.name = 'WorkspaceMemoryStoreError';
  }
}

/**
 * Optional SQLite-side inputs. They exist only to bootstrap PostgreSQL once:
 * the legacy data import and the reserved-key reconciliation that used to run
 * inside `initDatabase()`.
 */
export interface WorkspaceMemoryBootstrapOptions {
  /** True when the SQLite database was below schema v66 before this start. */
  legacyOwnerProfileReconcilePending?: boolean;
  /**
   * Owner Profile inference for pre-v66 databases. Runs once, after the legacy
   * import and before the reserved-key invariant, exactly where the SQLite
   * migration used to run it.
   */
  reconcileLegacyOwnerProfile?: () => Promise<unknown>;
}

let sqliteBinding: LegacySqliteDatabase | null = null;
let bootstrapOptions: WorkspaceMemoryBootstrapOptions = {};
let database: MemoryDatabase | null = null;
let readyPromise: Promise<MemoryDatabase> | null = null;

export function bindWorkspaceMemoryDatabase(
  db: LegacySqliteDatabase | null,
  options: WorkspaceMemoryBootstrapOptions = {},
): void {
  sqliteBinding = db;
  bootstrapOptions = options;
}

/**
 * Open, migrate, import and reconcile the PostgreSQL store ahead of first use.
 * Boot calls this right after `initDatabase()` so a broken Memory database
 * fails the process start instead of the first user request.
 */
export async function initWorkspaceMemoryStore(): Promise<void> {
  await ready();
}

export async function closeWorkspaceMemoryStore(): Promise<void> {
  const open = database;
  database = null;
  readyPromise = null;
  if (open) await open.close();
}

async function ready(): Promise<MemoryDatabase> {
  if (database) return database;
  if (!readyPromise) {
    readyPromise = (async () => {
      const open = await openMemoryDatabase();
      database = open;
      try {
        await runBootstrapReconciliation(open);
      } catch (error) {
        database = null;
        throw error;
      }
      return open;
    })().catch((error: unknown) => {
      readyPromise = null;
      throw error;
    });
  }
  return await readyPromise;
}

async function openMemoryDatabase(): Promise<MemoryDatabase> {
  // Embedded PostgreSQL persists next to the other runtime state; STORE_DIR is
  // `<DATA_DIR>/db`, and tests point it at a temporary directory.
  const config = resolveMemoryDatabaseConfig({
    dataDir: path.dirname(STORE_DIR),
  });
  const open = await createMemoryDatabase(config);
  try {
    await migrateMemoryDatabase(open);
    await enableTrigramSearch(open);
    return open;
  } catch (error) {
    await open.close().catch(() => undefined);
    throw error;
  }
}

async function runBootstrapReconciliation(open: MemoryDatabase): Promise<void> {
  if (sqliteBinding) {
    const outcome = await importLegacySqliteMemory({
      db: open,
      sqlite: sqliteBinding,
    });
    if (outcome.imported) {
      logger.info(
        { counts: outcome.counts },
        'Imported legacy SQLite Workspace Memory into PostgreSQL',
      );
    } else if (outcome.reason === 'postgres_not_empty') {
      logger.warn(
        { counts: outcome.counts, backend: open.backend },
        'Workspace Memory PostgreSQL store already has data; legacy SQLite memory was not imported',
      );
    }
    await purgeOrphanedWorkspaceMemory(open, sqliteBinding);
    await provisionWorkspaceMemoryStores(open, sqliteBinding);
  }
  // Rows written before phase B (including imported legacy rows) have no
  // retrieval keys; derive them once so keyword recall covers the whole store.
  const backfilled = await backfillWorkspaceMemorySearchKeys(open);
  if (backfilled > 0) {
    logger.info(
      { items: backfilled },
      'Backfilled Workspace Memory retrieval keys',
    );
  }
  await reconcileReservedKeyDuplicates(open);
  await enforceReservedKeyInvariant(open);
  if (
    bootstrapOptions.legacyOwnerProfileReconcilePending &&
    bootstrapOptions.reconcileLegacyOwnerProfile
  ) {
    await bootstrapOptions.reconcileLegacyOwnerProfile();
  }
  logger.info(
    { backend: open.backend, location: open.location },
    'Workspace Memory PostgreSQL store ready',
  );
}

/**
 * Delete every Memory store whose workspace no longer exists in SQLite. This
 * mirrors the ghost-workspace cleanup `reconcileCanonicalRuntimeProjections`
 * performs on SQLite and covers a crash between the two stores: Memory is
 * always deleted before the workspace row, so an orphan here can only be the
 * residue of an interrupted delete.
 */
async function purgeOrphanedWorkspaceMemory(
  open: MemoryDatabase,
  sqlite: LegacySqliteDatabase,
): Promise<void> {
  const known = listKnownWorkspaceJids(sqlite);
  if (!known) return;
  const knownJids = new Set(known);
  const stores = await open.query<{ workspace_jid: string }>(
    'SELECT workspace_jid FROM workspace_memory_stores',
  );
  const orphans = stores.rows
    .map((row) => row.workspace_jid)
    .filter((jid) => !knownJids.has(jid));
  for (const jid of orphans) {
    await deleteWorkspaceMemoryDataWithin(open, jid);
  }
  if (orphans.length > 0) {
    logger.info(
      { workspaces: orphans.length },
      'Purged Workspace Memory stores for deleted workspaces',
    );
  }
}

/**
 * The retired SQLite schema provisioned one empty store per workspace from a
 * trigger. Provisioning now happens here for workspaces that already exist, and
 * on first use (`requireStoreWithin`) for workspaces created afterwards.
 */
async function provisionWorkspaceMemoryStores(
  open: MemoryDatabase,
  sqlite: LegacySqliteDatabase,
): Promise<void> {
  const jids = listWorkspaceJids(sqlite);
  if (!jids) return;
  for (const jid of jids) {
    await open.query(
      `INSERT INTO workspace_memory_stores (
         id, workspace_jid, revision, created_at, updated_at
       ) VALUES ($1, $2, 0, $3, $4)
       ON CONFLICT (workspace_jid) DO NOTHING`,
      [newId('wms'), jid, nowIso(), nowIso()],
    );
  }
}

/**
 * pg_trgm is optional: an external PostgreSQL role may not be allowed to
 * create extensions. Without it ILIKE still returns correct results, just with
 * a sequential scan, so the failure is logged and startup continues.
 */
async function enableTrigramSearch(open: MemoryDatabase): Promise<void> {
  try {
    await open.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await open.exec(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_title_trgm
         ON workspace_memory_items USING gin (title gin_trgm_ops)`,
    );
    await open.exec(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_content_trgm
         ON workspace_memory_items USING gin (content gin_trgm_ops)`,
    );
    await open.exec(
      `CREATE INDEX IF NOT EXISTS idx_workspace_memory_items_canonical_trgm
         ON workspace_memory_items USING gin (canonical_key gin_trgm_ops)`,
    );
  } catch (error) {
    logger.warn(
      { err: error, backend: open.backend },
      'pg_trgm is unavailable; Workspace Memory substring search falls back to sequential scans',
    );
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Explicit keys win; otherwise the deterministic host algorithm derives them
 * from the item text. An explicitly empty list means "derive again", which is
 * what the Web UI clears to.
 */
function resolveSearchKeys(input: {
  searchKeys?: readonly unknown[] | null;
  title?: string | null;
  canonicalKey?: string | null;
  content?: string | null;
}): string[] {
  const provided = normalizeSearchKeys(input.searchKeys);
  if (provided.length > 0) return provided;
  return deriveSearchKeys({
    title: input.title,
    canonicalKey: input.canonicalKey,
    content: input.content,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Recover from an idempotency race instead of failing the request.
 *
 * The idempotency checks read-then-insert: two concurrent mutations that carry
 * the same key can both see no prior row, and the loser then violates a unique
 * constraint (SQLSTATE 23505) on `workspace_memory_items.create_idempotency_key`
 * or on the `workspace_memory_mutation_requests` primary key. On external
 * PostgreSQL the pool runs at READ COMMITTED, so the winner commits before the
 * loser's error surfaces and the failed transaction has already rolled back.
 * Replaying the same transaction once therefore takes the replay branch (same
 * request hash → `replayed: true`) or reports `idempotency_conflict` (different
 * hash) against the committed row, instead of returning a 500.
 *
 * The same race reaches the revision compare-and-set of `update` / `forget` /
 * the reserved Owner Profile path with a different symptom: both transactions
 * read the same current revision, the winner commits, and the loser's CAS
 * update matches zero rows and reports `revision_conflict` — even though the
 * committed row it lost to is its own logical request. A single retry takes the
 * replay branch (the failed CAS waited on the winner's row lock, so by the time
 * it fails the winner's mutation request row is committed and visible). A
 * genuine revision conflict — lost to a *different* request, or no winner at
 * all — fails the retry the same way and still surfaces as `revision_conflict`.
 *
 * Embedded PGlite serializes every statement on one connection, so neither race
 * can happen there and the retries never trigger; it is exported so tests can
 * exercise the recovery branches that a single connection cannot produce.
 */
export async function withIdempotencyRaceRecovery<T>(
  idempotencyKey: string | null | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      !normalizeNullable(idempotencyKey) ||
      (!isUniqueViolation(error) && !isRevisionConflict(error))
    ) {
      throw error;
    }
    return await work();
  }
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof WorkspaceMemoryStoreError &&
    error.code === 'revision_conflict'
  );
}

function isReservedCanonicalKey(value: string | null | undefined): boolean {
  return (
    normalizeNullable(value) ===
    COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY
  );
}

function rejectReservedCanonicalKey(value: string | null | undefined): void {
  if (!isReservedCanonicalKey(value)) return;
  throw new WorkspaceMemoryStoreError(
    'reserved_canonical_key',
    'This canonical key is owned by the CommerceAgent Owner Profile service',
  );
}

function mapItem(row: MemoryItemRow): WorkspaceMemoryItem {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    kind: row.kind,
    title: row.title,
    content: row.content,
    canonicalKey: row.canonical_key,
    searchKeys: normalizeSearchKeys(row.search_keys ?? []),
    pinned: row.pinned === true,
    status: row.status,
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    expiresAt: row.expires_at,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    supersededBy: row.superseded_by ?? null,
    demotedFromKind: row.demoted_from_kind ?? null,
    demotedAt: row.demoted_at ?? null,
    provenance: {
      sourceType: row.source_type ?? 'migration',
      sourceId: row.source_id,
      sessionId: row.session_id,
      observedAt: row.observed_at,
    },
  };
}

function mapVersion(row: MemoryVersionRow): WorkspaceMemoryVersion {
  const item = mapItem(row);
  return {
    id: item.id,
    workspaceJid: item.workspaceJid,
    kind: item.kind,
    title: item.title,
    content: item.content,
    canonicalKey: item.canonicalKey,
    searchKeys: item.searchKeys,
    pinned: item.pinned,
    status: item.status,
    importance: item.importance,
    confidence: item.confidence,
    validFrom: item.validFrom,
    validUntil: item.validUntil,
    expiresAt: item.expiresAt,
    revision: item.revision,
    changeType: row.change_type,
    createdAt: row.created_at,
    supersededBy: item.supersededBy,
    demotedFromKind: item.demotedFromKind,
    demotedAt: item.demotedAt,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
    },
    provenance: item.provenance,
  };
}

function mapStore(row: MemoryStoreRow): WorkspaceMemoryStore {
  return {
    id: row.id,
    workspaceJid: row.workspace_jid,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const STORE_SELECT = `
  SELECT id, workspace_jid, revision, created_at, updated_at
  FROM workspace_memory_stores
`;

async function storeRow(
  sql: MemorySql,
  workspaceJid: string,
): Promise<MemoryStoreRow | null> {
  const result = await sql.query<MemoryStoreRow>(
    `${STORE_SELECT} WHERE workspace_jid = $1`,
    [workspaceJid],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve the store for a workspace, creating it on first use.
 *
 * The retired SQLite schema provisioned a store row from a trigger on
 * `workspaces`; SQLite cannot write across databases, so provisioning moved
 * here. Callers have already validated that the workspace exists (the Memory
 * service and the Owner Profile facade both read the SQLite workspace first).
 */
async function requireStoreWithin(
  sql: MemorySql,
  workspaceJid: string,
): Promise<WorkspaceMemoryStore> {
  const existing = await storeRow(sql, workspaceJid);
  if (existing) return mapStore(existing);
  const at = nowIso();
  await sql.query(
    `INSERT INTO workspace_memory_stores (
       id, workspace_jid, revision, created_at, updated_at
     ) VALUES ($1, $2, 0, $3, $4)
     ON CONFLICT (workspace_jid) DO NOTHING`,
    [newId('wms'), workspaceJid, at, at],
  );
  const created = await storeRow(sql, workspaceJid);
  if (!created) {
    throw new WorkspaceMemoryStoreError(
      'store_not_found',
      'Workspace memory store not found',
    );
  }
  return mapStore(created);
}

const ITEM_SELECT = `
  SELECT i.*,
    p.source_type, p.source_id, p.session_id, p.observed_at
  FROM workspace_memory_items i
  LEFT JOIN workspace_memory_provenance p
    ON p.item_id = i.id AND p.revision = i.revision
`;

async function itemRow(
  sql: MemorySql,
  storeId: string,
  itemId: string,
): Promise<MemoryItemRow | null> {
  const result = await sql.query<MemoryItemRow>(
    `${ITEM_SELECT} WHERE i.store_id = $1 AND i.id = $2`,
    [storeId, itemId],
  );
  return result.rows[0] ?? null;
}

async function requireItemWithin(
  sql: MemorySql,
  store: WorkspaceMemoryStore,
  itemId: string,
): Promise<WorkspaceMemoryItem> {
  const row = await itemRow(sql, store.id, itemId);
  if (!row) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  return mapItem(row);
}

/**
 * Duplicate reconciliation clears the losing row's current canonical key so a
 * cross-status unique index can be installed. Its immutable versions still
 * mark the row as platform-owned; generic APIs must continue treating it as a
 * reserved item rather than exposing the retired preferred address.
 */
async function isReservedMemoryItem(
  sql: MemorySql,
  item: WorkspaceMemoryItem,
): Promise<boolean> {
  if (isReservedCanonicalKey(item.canonicalKey)) return true;
  const result = await sql.query(
    `SELECT 1
     FROM workspace_memory_platform_items
     WHERE item_id = $1
     UNION ALL
     SELECT 1
     FROM workspace_memory_versions
     WHERE item_id = $2 AND canonical_key = $3
     LIMIT 1`,
    [item.id, item.id, COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY],
  );
  return result.rows.length > 0;
}

async function markPlatformMemoryItem(
  sql: MemorySql,
  itemId: string,
  at: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_memory_platform_items (
       item_id, namespace, created_at
     ) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO NOTHING`,
    [itemId, COMMERCEAGENT_OWNER_PROFILE_MEMORY_NAMESPACE, at],
  );
}

async function rejectReservedMemoryItem(
  sql: MemorySql,
  item: WorkspaceMemoryItem,
): Promise<void> {
  if (!(await isReservedMemoryItem(sql, item))) return;
  throw new WorkspaceMemoryStoreError(
    'reserved_canonical_key',
    'This memory item is owned by the CommerceAgent Owner Profile service',
  );
}

async function appendVersion(
  sql: MemorySql,
  item: WorkspaceMemoryItem,
  changeType: WorkspaceMemoryChangeType,
  context: WorkspaceMemoryMutationContext,
  at: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_memory_versions (
      item_id, revision, workspace_jid, kind, title, content, canonical_key,
      search_keys, status, importance, confidence, valid_from, valid_until,
      expires_at, pinned, superseded_by, demoted_from_kind, demoted_at,
      change_type, actor_type, actor_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
    [
      item.id,
      item.revision,
      item.workspaceJid,
      item.kind,
      item.title,
      item.content,
      item.canonicalKey,
      item.searchKeys,
      item.status,
      item.importance,
      item.confidence,
      item.validFrom,
      item.validUntil,
      item.expiresAt,
      item.pinned,
      item.supersededBy,
      item.demotedFromKind,
      item.demotedAt,
      changeType,
      context.sourceType,
      context.actorId,
      at,
    ],
  );
  await sql.query(
    `INSERT INTO workspace_memory_provenance (
      item_id, revision, source_type, source_id, session_id, observed_at,
      recorded_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      item.id,
      item.revision,
      context.sourceType,
      normalizeNullable(context.sourceId),
      normalizeNullable(context.sessionId),
      context.observedAt ?? null,
      at,
    ],
  );
}

async function appendAuditAndOutbox(
  sql: MemorySql,
  store: WorkspaceMemoryStore,
  item: WorkspaceMemoryItem,
  action: WorkspaceMemoryChangeType,
  context: WorkspaceMemoryMutationContext,
  at: string,
): Promise<void> {
  await sql.query(
    `INSERT INTO workspace_memory_audit_events (
      id, workspace_jid, store_id, item_id, item_revision, store_revision,
      action, actor_type, actor_id, source_id, session_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      newId('wma'),
      store.workspaceJid,
      store.id,
      item.id,
      item.revision,
      store.revision,
      action,
      context.sourceType,
      context.actorId,
      normalizeNullable(context.sourceId),
      normalizeNullable(context.sessionId),
      at,
    ],
  );
  await sql.query(
    `INSERT INTO workspace_memory_outbox (
      id, workspace_jid, store_id, item_id, item_revision, event_type,
      payload_json, status, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)`,
    [
      newId('wmo'),
      store.workspaceJid,
      store.id,
      item.id,
      item.revision,
      action === 'forget' ? 'memory.forgotten' : `memory.${action}d`,
      JSON.stringify({
        workspaceJid: store.workspaceJid,
        storeRevision: store.revision,
        itemId: item.id,
        itemRevision: item.revision,
        status: item.status,
      }),
      at,
      at,
    ],
  );
}

async function bumpStore(
  sql: MemorySql,
  storeId: string,
  at: string,
): Promise<WorkspaceMemoryStore> {
  const result = await sql.query<MemoryStoreRow>(
    `UPDATE workspace_memory_stores
     SET revision = revision + 1, updated_at = $1
     WHERE id = $2
     RETURNING id, workspace_jid, revision, created_at, updated_at`,
    [at, storeId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new WorkspaceMemoryStoreError(
      'store_not_found',
      'Workspace memory store not found',
    );
  }
  return mapStore(row);
}

/**
 * Reconcile old generic-memory writes before installing the reserved-key
 * uniqueness invariant. The most recently updated row wins deterministically;
 * status is deliberately not preferred because a newer clear/forget must not
 * be undone by an older active duplicate. Every duplicate is detached from
 * the reserved key with full version/audit/outbox history.
 */
async function reconcileReservedKeyDuplicates(
  open: MemoryDatabase,
): Promise<{ workspaces: number; retiredItems: number }> {
  return await open.transaction(async (sql) => {
    const duplicateStores = await sql.query<{ store_id: string }>(
      `SELECT store_id
       FROM workspace_memory_items
       WHERE canonical_key = $1
       GROUP BY store_id
       HAVING COUNT(*) > 1`,
      [COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY],
    );
    let retiredItems = 0;
    for (const duplicate of duplicateStores.rows) {
      const rows = await sql.query<MemoryItemRow>(
        `${ITEM_SELECT}
         WHERE i.store_id = $1 AND i.canonical_key = $2
         ORDER BY i.updated_at DESC, i.revision DESC, i.id DESC`,
        [
          duplicate.store_id,
          COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        ],
      );
      const storeResult = await sql.query<MemoryStoreRow>(
        `${STORE_SELECT} WHERE id = $1`,
        [duplicate.store_id],
      );
      const storeRowValue = storeResult.rows[0];
      if (!storeRowValue) continue;
      let store = mapStore(storeRowValue);
      for (const loser of rows.rows.slice(1)) {
        const at = nowIso();
        await markPlatformMemoryItem(sql, loser.id, loser.created_at || at);
        const result = await sql.query(
          `UPDATE workspace_memory_items
           SET canonical_key = NULL,
               status = CASE
                 WHEN status = 'deleted' THEN 'deleted'
                 ELSE 'superseded'
               END,
               revision = revision + 1,
               updated_at = $1
           WHERE store_id = $2 AND id = $3 AND revision = $4
             AND canonical_key = $5`,
          [
            at,
            store.id,
            loser.id,
            loser.revision,
            COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
          ],
        );
        if (result.rowCount !== 1) continue;
        store = await bumpStore(sql, store.id, at);
        const versionItem = await requireItemWithin(sql, store, loser.id);
        const context: WorkspaceMemoryMutationContext = {
          actorId: 'schema-v66-owner-profile-reconciliation',
          sourceType: 'migration',
          sourceId: 'happyclaw.owner.preferred_address',
          observedAt: at,
        };
        await appendVersion(sql, versionItem, 'update', context, at);
        const item = await requireItemWithin(sql, store, loser.id);
        if (item.status === 'deleted') {
          await sql.query(
            `UPDATE workspace_memory_tombstones
             SET deleted_revision = $1 WHERE item_id = $2`,
            [item.revision, item.id],
          );
        }
        await appendAuditAndOutbox(sql, store, item, 'update', context, at);
        retiredItems++;
      }
    }
    return { workspaces: duplicateStores.rows.length, retiredItems };
  });
}

async function enforceReservedKeyInvariant(
  open: MemoryDatabase,
): Promise<void> {
  await open.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_memory_owner_address_unique
      ON workspace_memory_items(store_id, canonical_key)
      WHERE canonical_key = 'happyclaw.owner.preferred_address';
  `);
}

export async function reconcileCommerceAgentOwnerAddressCanonicalKey(): Promise<{
  workspaces: number;
  retiredItems: number;
}> {
  const open = await ready();
  return await reconcileReservedKeyDuplicates(open);
}

/**
 * Must be called only after reconciliation. Keeping this outside the baseline
 * migration is essential: an imported legacy database may contain duplicates
 * and would otherwise fail before the bootstrap can repair them.
 */
export async function enforceCommerceAgentOwnerAddressCanonicalInvariant(): Promise<void> {
  const open = await ready();
  await enforceReservedKeyInvariant(open);
}

async function deleteWorkspaceMemoryDataWithin(
  open: MemoryDatabase,
  workspaceJid: string,
): Promise<void> {
  await open.transaction((sql) =>
    deleteWorkspaceMemoryDataIn(sql, workspaceJid),
  );
}

/**
 * The delete itself, on a caller-provided connection so `resetWorkspaceMemoryData`
 * can run it inside the same transaction that recreates the store. Nested
 * `transaction()` calls would deadlock the single embedded connection.
 */
async function deleteWorkspaceMemoryDataIn(
  sql: MemorySql,
  workspaceJid: string,
): Promise<void> {
  const store = await storeRow(sql, workspaceJid);
  if (!store) return;
  await sql.query(
    'DELETE FROM workspace_memory_audit_events WHERE workspace_jid = $1',
    [workspaceJid],
  );
  await sql.query(
    'DELETE FROM workspace_memory_outbox WHERE workspace_jid = $1',
    [workspaceJid],
  );
  await sql.query(
    'DELETE FROM workspace_memory_mutation_requests WHERE store_id = $1',
    [store.id],
  );
  await sql.query(
    'DELETE FROM workspace_memory_tombstones WHERE workspace_jid = $1',
    [workspaceJid],
  );
  await sql.query(
    `DELETE FROM workspace_memory_provenance
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = $1
     )`,
    [store.id],
  );
  await sql.query(
    `DELETE FROM workspace_memory_versions
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = $1
     )`,
    [store.id],
  );
  await sql.query(
    `DELETE FROM workspace_memory_platform_items
     WHERE item_id IN (
       SELECT id FROM workspace_memory_items WHERE store_id = $1
     )`,
    [store.id],
  );
  await sql.query('DELETE FROM workspace_memory_items WHERE store_id = $1', [
    store.id,
  ]);
  await sql.query('DELETE FROM workspace_memory_stores WHERE id = $1', [
    store.id,
  ]);
}

/**
 * Remove every memory artifact for a deleted workspace explicitly.
 *
 * This must run *before* the SQLite transaction that deletes the workspace
 * itself. There is no cross-database transaction, so the order is chosen so
 * that a crash leaves Memory already empty (idempotent, re-runnable) while the
 * workspace row still exists — never the reverse, where a workspace could
 * reappear with another owner's memory or memory could survive a deletion.
 *
 * Deletion is idempotent: calling it twice, or for a workspace that never had
 * memory, is a no-op.
 */
export async function deleteWorkspaceMemoryData(
  workspaceJid: string,
): Promise<void> {
  const open = await ready();
  await deleteWorkspaceMemoryDataWithin(open, workspaceJid);
}

/**
 * Replace a retained workspace's complete Memory lineage with a new empty
 * store. Workspace rebuild keeps the workspace row itself, so deleting the old
 * store without recreating it would leave Memory APIs in a permanent
 * store_not_found state.
 *
 * Ordering with SQLite: this runs first and commits on its own; the caller then
 * resets `workspace_onboarding_states` in SQLite. A failure between the two
 * leaves an empty Memory store with the previous onboarding row, which the
 * retry repairs by running this same idempotent reset again.
 */
export async function resetWorkspaceMemoryData(
  workspaceJid: string,
): Promise<WorkspaceMemoryStore> {
  const open = await ready();
  if (sqliteBinding) {
    const workspace = sqliteBinding
      .prepare('SELECT 1 FROM workspaces WHERE jid = ?')
      .get(workspaceJid);
    if (!workspace) {
      throw new WorkspaceMemoryStoreError(
        'store_not_found',
        'Workspace memory store not found',
      );
    }
  }
  return await open.transaction(async (sql) => {
    await deleteWorkspaceMemoryDataIn(sql, workspaceJid);
    const at = nowIso();
    await sql.query(
      `INSERT INTO workspace_memory_stores (
        id, workspace_jid, revision, created_at, updated_at
      ) VALUES ($1, $2, 0, $3, $4)`,
      [newId('wms'), workspaceJid, at, at],
    );
    return await requireStoreWithin(sql, workspaceJid);
  });
}

export async function getWorkspaceMemoryStore(
  workspaceJid: string,
): Promise<WorkspaceMemoryStore | null> {
  const open = await ready();
  const row = await storeRow(open, workspaceJid);
  return row ? mapStore(row) : null;
}

export async function hasRecallableWorkspaceMemoryCanonicalKey(
  workspaceJid: string,
  canonicalKey: string,
  now: string = nowIso(),
): Promise<boolean> {
  const open = await ready();
  const store = await storeRow(open, workspaceJid);
  if (!store) return false;
  const result = await open.query(
    `SELECT 1
     FROM workspace_memory_items
     WHERE store_id = $1
       AND canonical_key = $2
       AND status = 'active'
       AND demoted_at IS NULL
       AND (valid_from IS NULL OR valid_from::timestamptz <= $3::timestamptz)
       AND (valid_until IS NULL OR valid_until::timestamptz > $4::timestamptz)
       AND (expires_at IS NULL OR expires_at::timestamptz > $5::timestamptz)
     LIMIT 1`,
    [store.id, canonicalKey, now, now, now],
  );
  return result.rows.length > 0;
}

export async function getWorkspaceMemoryItem(
  workspaceJid: string,
  itemId: string,
): Promise<{ store: WorkspaceMemoryStore; item: WorkspaceMemoryItem }> {
  const open = await ready();
  const store = await requireStoreWithin(open, workspaceJid);
  const item = await requireItemWithin(open, store, itemId);
  if (await isReservedMemoryItem(open, item)) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  return { store, item };
}

/** Mutation preflight that preserves the explicit reserved-key rejection code. */
export async function getMutableWorkspaceMemoryItem(
  workspaceJid: string,
  itemId: string,
): Promise<{ store: WorkspaceMemoryStore; item: WorkspaceMemoryItem }> {
  const open = await ready();
  const store = await requireStoreWithin(open, workspaceJid);
  const item = await requireItemWithin(open, store, itemId);
  await rejectReservedMemoryItem(open, item);
  return { store, item };
}

export interface ReservedWorkspaceMemoryMutationResult {
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
  changed: boolean;
}

interface MutationReplayRow extends MemoryRow {
  operation: string;
  item_id: string;
  request_hash: string;
  response_json: string;
}

async function reservedRequestReplay(
  sql: MemorySql,
  store: WorkspaceMemoryStore,
  input: {
    itemId: string;
    idempotencyKey?: string | null;
    requestHash?: string | null;
  },
): Promise<ReservedWorkspaceMemoryMutationResult | null> {
  const idempotencyKey = normalizeNullable(input.idempotencyKey);
  if (!idempotencyKey) return null;
  const result = await sql.query<MutationReplayRow>(
    `SELECT operation, item_id, request_hash, response_json
     FROM workspace_memory_mutation_requests
     WHERE store_id = $1 AND idempotency_key = $2`,
    [store.id, idempotencyKey],
  );
  const replay = result.rows[0];
  if (!replay) return null;
  if (
    replay.operation !== 'update' ||
    replay.item_id !== input.itemId ||
    !input.requestHash ||
    replay.request_hash !== input.requestHash
  ) {
    throw new WorkspaceMemoryStoreError(
      'idempotency_conflict',
      'Idempotency key was already used for a different request',
      { storeRevision: store.revision },
    );
  }
  const response = JSON.parse(replay.response_json) as {
    store: WorkspaceMemoryStore;
    item: WorkspaceMemoryItem;
    changed?: boolean;
  };
  return {
    store: response.store,
    item: response.item,
    replayed: true,
    changed: response.changed ?? true,
  };
}

/**
 * Read the platform-owned Owner Profile item without exposing it through the
 * generic Workspace Memory service.
 */
export async function getCommerceAgentOwnerAddressMemoryItem(
  workspaceJid: string,
): Promise<{
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem | null;
}> {
  const open = await ready();
  const store = await requireStoreWithin(open, workspaceJid);
  const result = await open.query<MemoryItemRow>(
    `${ITEM_SELECT}
     WHERE i.store_id = $1
       AND i.canonical_key = $2
     ORDER BY
       CASE WHEN i.status = 'active' THEN 0 ELSE 1 END,
       i.updated_at DESC,
       i.id DESC
     LIMIT 1`,
    [store.id, COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY],
  );
  const row = result.rows[0];
  return { store, item: row ? mapItem(row) : null };
}

/**
 * The sole mutation primitive for the reserved preferred-address item.
 *
 * Clearing keeps the same item and monotonic revision by changing its status
 * to `superseded`; restoring changes it back to `active`. This lets callers
 * use one CAS lineage across set → update → clear → restore.
 */
export async function mutateCommerceAgentOwnerAddressMemory(input: {
  workspaceJid: string;
  preferredAddress?: string;
  clear?: boolean;
  expectedRevision?: number;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): Promise<ReservedWorkspaceMemoryMutationResult> {
  const open = await ready();
  const run = () =>
    open.transaction(async (sql) => {
      const initialStore = await requireStoreWithin(sql, input.workspaceJid);
      const currentRow = await sql.query<MemoryItemRow>(
        `${ITEM_SELECT}
       WHERE i.store_id = $1 AND i.canonical_key = $2
       ORDER BY
         CASE WHEN i.status = 'active' THEN 0 ELSE 1 END,
         i.updated_at DESC,
         i.id DESC
       LIMIT 1`,
        [initialStore.id, COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY],
      );
      const current = currentRow.rows[0] ? mapItem(currentRow.rows[0]) : null;
      const idempotencyKey = normalizeNullable(input.idempotencyKey);
      const preferredAddress = normalizeNullable(input.preferredAddress);
      if (!input.clear && !preferredAddress) {
        throw new Error('Preferred address must not be empty');
      }

      if (!current) {
        if (input.clear) {
          throw new WorkspaceMemoryStoreError(
            'revision_conflict',
            'CommerceAgent Owner Profile revision conflict',
            { currentRevision: 0, storeRevision: initialStore.revision },
          );
        }
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== 0
        ) {
          throw new WorkspaceMemoryStoreError(
            'revision_conflict',
            'CommerceAgent Owner Profile revision conflict',
            { currentRevision: 0, storeRevision: initialStore.revision },
          );
        }
        if (idempotencyKey) {
          const existing = await sql.query<{
            id: string;
            create_request_hash: string | null;
          }>(
            `SELECT id, create_request_hash
           FROM workspace_memory_items
           WHERE store_id = $1 AND create_idempotency_key = $2`,
            [initialStore.id, idempotencyKey],
          );
          const row = existing.rows[0];
          if (row) {
            if (
              row.create_request_hash &&
              input.requestHash &&
              row.create_request_hash !== input.requestHash
            ) {
              throw new WorkspaceMemoryStoreError(
                'idempotency_conflict',
                'Idempotency key was already used for a different request',
                { storeRevision: initialStore.revision },
              );
            }
            return {
              store: await requireStoreWithin(sql, input.workspaceJid),
              item: await requireItemWithin(sql, initialStore, row.id),
              replayed: true,
              changed: true,
            };
          }
        }

        const at = nowIso();
        const store = await bumpStore(sql, initialStore.id, at);
        const itemId = newId('wmi');
        await sql.query(
          `INSERT INTO workspace_memory_items (
          id, store_id, workspace_jid, kind, title, content, canonical_key,
          status, importance, confidence, valid_from, valid_until, expires_at,
          revision, create_idempotency_key, create_request_hash,
          created_at, updated_at, deleted_at
        ) VALUES ($1, $2, $3, 'fact', $4, $5, $6, 'active', 1, 1,
          NULL, NULL, NULL, 1, $7, $8, $9, $10, NULL)`,
          [
            itemId,
            store.id,
            store.workspaceJid,
            '主人称呼',
            preferredAddress,
            COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
            idempotencyKey,
            normalizeNullable(input.requestHash),
            at,
            at,
          ],
        );
        await markPlatformMemoryItem(sql, itemId, at);
        const versionItem = await requireItemWithin(sql, store, itemId);
        await appendVersion(sql, versionItem, 'create', input.context, at);
        const item = await requireItemWithin(sql, store, itemId);
        await appendAuditAndOutbox(
          sql,
          store,
          item,
          'create',
          input.context,
          at,
        );
        return { store, item, replayed: false, changed: true };
      }

      if (idempotencyKey) {
        const createReplay = await sql.query<{
          create_request_hash: string | null;
        }>(
          `SELECT create_request_hash
         FROM workspace_memory_items
         WHERE store_id = $1 AND id = $2 AND create_idempotency_key = $3`,
          [initialStore.id, current.id, idempotencyKey],
        );
        const row = createReplay.rows[0];
        if (row) {
          if (
            row.create_request_hash &&
            input.requestHash &&
            row.create_request_hash !== input.requestHash
          ) {
            throw new WorkspaceMemoryStoreError(
              'idempotency_conflict',
              'Idempotency key was already used for a different request',
              { storeRevision: initialStore.revision },
            );
          }
          return {
            store: initialStore,
            item: current,
            replayed: true,
            changed: true,
          };
        }
      }

      const replay = await reservedRequestReplay(sql, initialStore, {
        itemId: current.id,
        idempotencyKey,
        requestHash: input.requestHash,
      });
      if (replay) return replay;

      if (
        input.expectedRevision === undefined ||
        input.expectedRevision !== current.revision
      ) {
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'CommerceAgent Owner Profile revision conflict',
          {
            currentRevision: current.revision,
            storeRevision: initialStore.revision,
          },
        );
      }

      const nextStatus: WorkspaceMemoryStatus = input.clear
        ? 'superseded'
        : 'active';
      const nextContent = input.clear ? current.content : preferredAddress!;
      if (current.status === nextStatus && current.content === nextContent) {
        if (idempotencyKey && input.requestHash) {
          await sql.query(
            `INSERT INTO workspace_memory_mutation_requests (
            store_id, idempotency_key, operation, item_id, request_hash,
            response_json, created_at
          ) VALUES ($1, $2, 'update', $3, $4, $5, $6)`,
            [
              initialStore.id,
              idempotencyKey,
              current.id,
              input.requestHash,
              JSON.stringify({
                store: initialStore,
                item: current,
                changed: false,
              }),
              nowIso(),
            ],
          );
        }
        return {
          store: initialStore,
          item: current,
          replayed: false,
          changed: false,
        };
      }

      const at = nowIso();
      const nextRevision = current.revision + 1;
      const result = await sql.query(
        `UPDATE workspace_memory_items
       SET content = $1, status = $2, revision = $3, updated_at = $4,
           deleted_at = NULL
       WHERE store_id = $5 AND id = $6 AND revision = $7
         AND canonical_key = $8`,
        [
          nextContent,
          nextStatus,
          nextRevision,
          at,
          initialStore.id,
          current.id,
          input.expectedRevision,
          COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        ],
      );
      if (result.rowCount !== 1) {
        const latest = await requireItemWithin(sql, initialStore, current.id);
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'CommerceAgent Owner Profile revision conflict',
          {
            currentRevision: latest.revision,
            storeRevision: (await requireStoreWithin(sql, input.workspaceJid))
              .revision,
          },
        );
      }
      const store = await bumpStore(sql, initialStore.id, at);
      if (current.status === 'deleted') {
        await sql.query(
          'DELETE FROM workspace_memory_tombstones WHERE item_id = $1',
          [current.id],
        );
      }
      const versionItem = await requireItemWithin(sql, store, current.id);
      await appendVersion(sql, versionItem, 'update', input.context, at);
      const item = await requireItemWithin(sql, store, current.id);
      await appendAuditAndOutbox(sql, store, item, 'update', input.context, at);
      if (idempotencyKey && input.requestHash) {
        await sql.query(
          `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES ($1, $2, 'update', $3, $4, $5, $6)`,
          [
            store.id,
            idempotencyKey,
            item.id,
            input.requestHash,
            JSON.stringify({ store, item, changed: true }),
            at,
          ],
        );
      }
      return { store, item, replayed: false, changed: true };
    });
  return await withIdempotencyRaceRecovery(input.idempotencyKey, run);
}

export async function createWorkspaceMemoryItem(input: {
  workspaceJid: string;
  value: WorkspaceMemoryValue;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): Promise<{
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
}> {
  rejectReservedCanonicalKey(input.value.canonicalKey);
  const open = await ready();
  const run = () =>
    open.transaction(async (sql) => {
      const initialStore = await requireStoreWithin(sql, input.workspaceJid);
      const idempotencyKey = normalizeNullable(input.idempotencyKey);
      if (idempotencyKey) {
        const existing = await sql.query<{
          id: string;
          create_request_hash: string | null;
        }>(
          `SELECT id, create_request_hash
         FROM workspace_memory_items
         WHERE store_id = $1 AND create_idempotency_key = $2`,
          [initialStore.id, idempotencyKey],
        );
        const row = existing.rows[0];
        if (row) {
          const existingItem = await requireItemWithin(
            sql,
            initialStore,
            row.id,
          );
          await rejectReservedMemoryItem(sql, existingItem);
          if (
            row.create_request_hash &&
            input.requestHash &&
            row.create_request_hash !== input.requestHash
          ) {
            throw new WorkspaceMemoryStoreError(
              'idempotency_conflict',
              'Idempotency key was already used for a different request',
              { storeRevision: initialStore.revision },
            );
          }
          return {
            store: await requireStoreWithin(sql, input.workspaceJid),
            item: existingItem,
            replayed: true,
          };
        }
      }

      const at = nowIso();
      const store = await bumpStore(sql, initialStore.id, at);
      const itemId = newId('wmi');
      const searchKeys = resolveSearchKeys({
        searchKeys: input.value.searchKeys,
        title: input.value.title,
        canonicalKey: input.value.canonicalKey,
        content: input.value.content,
      });
      await sql.query(
        `INSERT INTO workspace_memory_items (
        id, store_id, workspace_jid, kind, title, content, canonical_key,
        search_keys, pinned,
        status, importance, confidence, valid_from, valid_until, expires_at,
        revision, create_idempotency_key, create_request_hash,
        created_at, updated_at, deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, 1, $16, $17, $18, $19, NULL)`,
        [
          itemId,
          store.id,
          store.workspaceJid,
          input.value.kind,
          normalizeNullable(input.value.title),
          input.value.content.trim(),
          normalizeNullable(input.value.canonicalKey),
          searchKeys,
          input.value.pinned === true,
          input.value.status ?? 'active',
          input.value.importance ?? 0.5,
          input.value.confidence ?? 1,
          input.value.validFrom ?? null,
          input.value.validUntil ?? null,
          input.value.expiresAt ?? null,
          idempotencyKey,
          normalizeNullable(input.requestHash),
          at,
          at,
        ],
      );
      const versionItem = await requireItemWithin(sql, store, itemId);
      await appendVersion(sql, versionItem, 'create', input.context, at);
      const item = await requireItemWithin(sql, store, itemId);
      await appendAuditAndOutbox(sql, store, item, 'create', input.context, at);
      return { store, item, replayed: false };
    });
  return await withIdempotencyRaceRecovery(input.idempotencyKey, run);
}

export async function updateWorkspaceMemoryItem(input: {
  workspaceJid: string;
  itemId: string;
  expectedRevision: number;
  patch: Partial<WorkspaceMemoryValue>;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): Promise<{
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
}> {
  const open = await ready();
  const run = () =>
    open.transaction(async (sql) => {
      const initialStore = await requireStoreWithin(sql, input.workspaceJid);
      const current = await requireItemWithin(sql, initialStore, input.itemId);
      await rejectReservedMemoryItem(sql, current);
      rejectReservedCanonicalKey(input.patch.canonicalKey);
      const idempotencyKey = normalizeNullable(input.idempotencyKey);
      if (idempotencyKey) {
        const replay = await sql.query<MutationReplayRow>(
          `SELECT operation, item_id, request_hash, response_json
         FROM workspace_memory_mutation_requests
         WHERE store_id = $1 AND idempotency_key = $2`,
          [initialStore.id, idempotencyKey],
        );
        const row = replay.rows[0];
        if (row) {
          if (
            row.operation !== 'update' ||
            row.item_id !== input.itemId ||
            !input.requestHash ||
            row.request_hash !== input.requestHash
          ) {
            throw new WorkspaceMemoryStoreError(
              'idempotency_conflict',
              'Idempotency key was already used for a different request',
              { storeRevision: initialStore.revision },
            );
          }
          const response = JSON.parse(row.response_json) as {
            store: WorkspaceMemoryStore;
            item: WorkspaceMemoryItem;
          };
          return { ...response, replayed: true };
        }
      }
      if (
        current.revision !== input.expectedRevision ||
        current.status === 'deleted'
      ) {
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'Workspace memory item revision conflict',
          {
            currentRevision: current.revision,
            storeRevision: initialStore.revision,
          },
        );
      }

      const at = nowIso();
      const nextRevision = current.revision + 1;
      const next: WorkspaceMemoryValue = {
        kind: input.patch.kind ?? current.kind,
        title:
          input.patch.title === undefined ? current.title : input.patch.title,
        content: input.patch.content ?? current.content,
        canonicalKey:
          input.patch.canonicalKey === undefined
            ? current.canonicalKey
            : input.patch.canonicalKey,
        searchKeys:
          input.patch.searchKeys === undefined
            ? undefined
            : input.patch.searchKeys,
        pinned: input.patch.pinned ?? current.pinned,
        status: input.patch.status ?? current.status,
        importance: input.patch.importance ?? current.importance,
        confidence: input.patch.confidence ?? current.confidence,
        validFrom:
          input.patch.validFrom === undefined
            ? current.validFrom
            : input.patch.validFrom,
        validUntil:
          input.patch.validUntil === undefined
            ? current.validUntil
            : input.patch.validUntil,
        expiresAt:
          input.patch.expiresAt === undefined
            ? current.expiresAt
            : input.patch.expiresAt,
      };
      // Keys describe the text, so an edit to title/content/canonical key
      // re-derives them unless the caller sent an explicit, non-empty list.
      const textChanged =
        next.title !== current.title ||
        next.content.trim() !== current.content ||
        next.canonicalKey !== current.canonicalKey;
      const explicitKeys =
        input.patch.searchKeys === undefined
          ? null
          : normalizeSearchKeys(input.patch.searchKeys);
      let nextSearchKeys = current.searchKeys;
      if (explicitKeys && explicitKeys.length > 0)
        nextSearchKeys = explicitKeys;
      else if (explicitKeys || textChanged || current.searchKeys.length === 0) {
        nextSearchKeys = resolveSearchKeys({
          title: next.title,
          canonicalKey: next.canonicalKey,
          content: next.content,
        });
      }
      const result = await sql.query(
        `UPDATE workspace_memory_items SET
        kind = $1, title = $2, content = $3, canonical_key = $4, status = $5,
        importance = $6, confidence = $7, valid_from = $8, valid_until = $9,
        expires_at = $10, revision = $11, updated_at = $12,
        search_keys = $16, pinned = $17
       WHERE store_id = $13 AND id = $14 AND revision = $15
         AND status <> 'deleted'`,
        [
          next.kind,
          normalizeNullable(next.title),
          next.content.trim(),
          normalizeNullable(next.canonicalKey),
          next.status ?? 'active',
          next.importance ?? 0.5,
          next.confidence ?? 1,
          next.validFrom ?? null,
          next.validUntil ?? null,
          next.expiresAt ?? null,
          nextRevision,
          at,
          initialStore.id,
          current.id,
          input.expectedRevision,
          nextSearchKeys,
          next.pinned === true,
        ],
      );
      if (result.rowCount !== 1) {
        const latest = await requireItemWithin(sql, initialStore, current.id);
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'Workspace memory item revision conflict',
          {
            currentRevision: latest.revision,
            storeRevision: (await requireStoreWithin(sql, input.workspaceJid))
              .revision,
          },
        );
      }
      const store = await bumpStore(sql, initialStore.id, at);
      const versionItem = await requireItemWithin(sql, store, current.id);
      await appendVersion(sql, versionItem, 'update', input.context, at);
      const item = await requireItemWithin(sql, store, current.id);
      await appendAuditAndOutbox(sql, store, item, 'update', input.context, at);
      if (idempotencyKey && input.requestHash) {
        await sql.query(
          `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES ($1, $2, 'update', $3, $4, $5, $6)`,
          [
            store.id,
            idempotencyKey,
            item.id,
            input.requestHash,
            JSON.stringify({ store, item }),
            at,
          ],
        );
      }
      return { store, item, replayed: false };
    });
  return await withIdempotencyRaceRecovery(input.idempotencyKey, run);
}

export async function forgetWorkspaceMemoryItem(input: {
  workspaceJid: string;
  itemId: string;
  expectedRevision: number;
  reason?: string | null;
  context: WorkspaceMemoryMutationContext;
  idempotencyKey?: string | null;
  requestHash?: string | null;
}): Promise<{
  store: WorkspaceMemoryStore;
  item: WorkspaceMemoryItem;
  replayed: boolean;
}> {
  const open = await ready();
  const run = () =>
    open.transaction(async (sql) => {
      const initialStore = await requireStoreWithin(sql, input.workspaceJid);
      const current = await requireItemWithin(sql, initialStore, input.itemId);
      await rejectReservedMemoryItem(sql, current);
      const idempotencyKey = normalizeNullable(input.idempotencyKey);
      if (idempotencyKey) {
        const replay = await sql.query<MutationReplayRow>(
          `SELECT operation, item_id, request_hash, response_json
         FROM workspace_memory_mutation_requests
         WHERE store_id = $1 AND idempotency_key = $2`,
          [initialStore.id, idempotencyKey],
        );
        const row = replay.rows[0];
        if (row) {
          if (
            row.operation !== 'forget' ||
            row.item_id !== input.itemId ||
            !input.requestHash ||
            row.request_hash !== input.requestHash
          ) {
            throw new WorkspaceMemoryStoreError(
              'idempotency_conflict',
              'Idempotency key was already used for a different request',
              { storeRevision: initialStore.revision },
            );
          }
          const response = JSON.parse(row.response_json) as {
            store: WorkspaceMemoryStore;
            item: WorkspaceMemoryItem;
          };
          return { ...response, replayed: true };
        }
      }
      if (
        current.revision !== input.expectedRevision ||
        current.status === 'deleted'
      ) {
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'Workspace memory item revision conflict',
          {
            currentRevision: current.revision,
            storeRevision: initialStore.revision,
          },
        );
      }
      const at = nowIso();
      const nextRevision = current.revision + 1;
      const result = await sql.query(
        `UPDATE workspace_memory_items
       SET status = 'deleted', revision = $1, updated_at = $2, deleted_at = $3
       WHERE store_id = $4 AND id = $5 AND revision = $6
         AND status <> 'deleted'`,
        [
          nextRevision,
          at,
          at,
          initialStore.id,
          current.id,
          input.expectedRevision,
        ],
      );
      if (result.rowCount !== 1) {
        const latest = await requireItemWithin(sql, initialStore, current.id);
        throw new WorkspaceMemoryStoreError(
          'revision_conflict',
          'Workspace memory item revision conflict',
          {
            currentRevision: latest.revision,
            storeRevision: (await requireStoreWithin(sql, input.workspaceJid))
              .revision,
          },
        );
      }
      const store = await bumpStore(sql, initialStore.id, at);
      const versionItem = await requireItemWithin(sql, store, current.id);
      await appendVersion(sql, versionItem, 'forget', input.context, at);
      const item = await requireItemWithin(sql, store, current.id);
      await sql.query(
        `INSERT INTO workspace_memory_tombstones (
        item_id, workspace_jid, deleted_revision, reason, actor_type, actor_id,
        deleted_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          item.id,
          item.workspaceJid,
          item.revision,
          normalizeNullable(input.reason),
          input.context.sourceType,
          input.context.actorId,
          at,
        ],
      );
      await appendAuditAndOutbox(sql, store, item, 'forget', input.context, at);
      if (idempotencyKey && input.requestHash) {
        await sql.query(
          `INSERT INTO workspace_memory_mutation_requests (
          store_id, idempotency_key, operation, item_id, request_hash,
          response_json, created_at
        ) VALUES ($1, $2, 'forget', $3, $4, $5, $6)`,
          [
            store.id,
            idempotencyKey,
            item.id,
            input.requestHash,
            JSON.stringify({ store, item }),
            at,
          ],
        );
      }
      return { store, item, replayed: false };
    });
  return await withIdempotencyRaceRecovery(input.idempotencyKey, run);
}

export async function listWorkspaceMemoryItems(input: {
  workspaceJid: string;
  status?: WorkspaceMemoryStatus;
  kind?: WorkspaceMemoryKind;
  limit: number;
  before?: { updatedAt: string; id: string } | null;
}): Promise<{ store: WorkspaceMemoryStore; items: WorkspaceMemoryItem[] }> {
  const open = await ready();
  const store = await requireStoreWithin(open, input.workspaceJid);
  const clauses = [
    'i.store_id = $1',
    'i.status = $2',
    '(i.canonical_key IS NULL OR i.canonical_key <> $3)',
    `NOT EXISTS (
      SELECT 1 FROM workspace_memory_platform_items mpi
      WHERE mpi.item_id = i.id
    )`,
  ];
  const params: unknown[] = [
    store.id,
    input.status ?? 'active',
    COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
  ];
  if (input.kind) {
    params.push(input.kind);
    clauses.push(`i.kind = $${params.length}`);
  }
  if (input.before) {
    params.push(input.before.updatedAt);
    const updatedAtParam = params.length;
    params.push(input.before.updatedAt);
    const equalityParam = params.length;
    params.push(input.before.id);
    const idParam = params.length;
    clauses.push(
      `(i.updated_at < $${updatedAtParam} OR (i.updated_at = $${equalityParam} AND i.id < $${idParam}))`,
    );
  }
  params.push(input.limit);
  const rows = await open.query<MemoryItemRow>(
    `${ITEM_SELECT}
     WHERE ${clauses.join(' AND ')}
     ORDER BY i.updated_at DESC, i.id DESC
     LIMIT $${params.length}`,
    params,
  );
  return { store, items: rows.rows.map(mapItem) };
}

export async function listRecallableWorkspaceMemoryItems(input: {
  workspaceJid: string;
  kind?: WorkspaceMemoryKind;
  limit: number;
  now?: string;
}): Promise<{ store: WorkspaceMemoryStore; items: WorkspaceMemoryItem[] }> {
  const open = await ready();
  const store = await requireStoreWithin(open, input.workspaceJid);
  const now = input.now ?? nowIso();
  const params: unknown[] = [
    store.id,
    COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    now,
    now,
    now,
  ];
  let kindClause = '';
  if (input.kind) {
    params.push(input.kind);
    kindClause = `AND i.kind = $${params.length}`;
  }
  params.push(input.limit);
  const rows = await open.query<MemoryItemRow>(
    `${ITEM_SELECT}
     WHERE i.store_id = $1
       AND i.status = 'active'
       AND i.demoted_at IS NULL
       AND (i.canonical_key IS NULL OR i.canonical_key <> $2)
       AND NOT EXISTS (
         SELECT 1 FROM workspace_memory_platform_items mpi
         WHERE mpi.item_id = i.id
       )
       AND (i.valid_from IS NULL OR i.valid_from::timestamptz <= $3::timestamptz)
       AND (i.valid_until IS NULL OR i.valid_until::timestamptz > $4::timestamptz)
       AND (i.expires_at IS NULL OR i.expires_at::timestamptz > $5::timestamptz)
       ${kindClause}
     ORDER BY i.importance DESC, i.updated_at DESC, i.id DESC
     LIMIT $${params.length}`,
    params,
  );
  return { store, items: rows.rows.map(mapItem) };
}

function escapeLikePattern(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

/**
 * The retired FTS5 trigram index matched substrings; tsvector with `simple`
 * does not segment Chinese, so ILIKE stays as the recall floor for every
 * query, exactly as it did as the short-query fallback. ts_rank only decides
 * ordering among the rows that both arms matched.
 */
function buildSnippet(content: string, query: string): string {
  if (!query) return content.slice(0, 240);
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, 240);
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + query.length + 40);
  return [
    start > 0 ? '…' : '',
    content.slice(start, index),
    '‹',
    content.slice(index, index + query.length),
    '›',
    content.slice(index + query.length, end),
    end < content.length ? '…' : '',
  ].join('');
}

export async function searchWorkspaceMemoryItems(input: {
  workspaceJid: string;
  query: string;
  kind?: WorkspaceMemoryKind;
  limit: number;
  now?: string;
}): Promise<{
  store: WorkspaceMemoryStore;
  hits: Array<{
    item: WorkspaceMemoryItem;
    rank: number;
    searchKeyHits: number;
    snippet: string;
  }>;
}> {
  const open = await ready();
  const store = await requireStoreWithin(open, input.workspaceJid);
  const now = input.now ?? nowIso();
  const query = input.query.trim();
  const pattern = `%${escapeLikePattern(query)}%`;
  // A whole Chinese question is one `simple` lexeme and never equals a stored
  // key, so the same deterministic algorithm extracts query keywords and each
  // of them is matched against `search_keys` in both containment directions.
  const keywords = deriveQueryKeywords(query);
  const keywordTsQuery = keywordsToTsQuery(keywords);
  const keywordPatterns = keywords.map((key) => `%${escapeLikePattern(key)}%`);
  const params: unknown[] = [
    store.id,
    COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    now,
    now,
    now,
  ];
  let kindClause = '';
  if (input.kind) {
    params.push(input.kind);
    kindClause = `AND i.kind = $${params.length}`;
  }
  params.push(query);
  const tsQueryParam = params.length;
  params.push(pattern);
  const patternParam = params.length;
  params.push(keywords);
  const keywordsParam = params.length;
  params.push(keywordPatterns);
  const keywordPatternsParam = params.length;
  params.push(keywordTsQuery);
  const keywordTsQueryParam = params.length;
  params.push(input.limit);
  const limitParam = params.length;
  const keyHitExpression = `(
    SELECT count(*)
    FROM unnest(i.search_keys) AS sk
    CROSS JOIN unnest($${keywordsParam}::text[]) AS kw
    WHERE sk <> '' AND kw <> '' AND (strpos(sk, kw) > 0 OR strpos(kw, sk) > 0)
  )`;
  const rows = await open.query<
    MemoryItemRow & {
      search_rank: number | string;
      search_key_hits: number | string;
    }
  >(
    `SELECT i.*, p.source_type, p.source_id, p.session_id, p.observed_at,
       ts_rank('{0.3333,0,0.6667,1}'::float4[], i.search_vector,
         plainto_tsquery('simple', $${tsQueryParam})) AS search_rank,
       ${keyHitExpression} AS search_key_hits
     FROM workspace_memory_items i
     LEFT JOIN workspace_memory_provenance p
       ON p.item_id = i.id AND p.revision = i.revision
     WHERE i.store_id = $1
       AND i.status = 'active'
       AND (i.canonical_key IS NULL OR i.canonical_key <> $2)
       AND NOT EXISTS (
         SELECT 1 FROM workspace_memory_platform_items mpi
         WHERE mpi.item_id = i.id
       )
       AND (i.valid_from IS NULL OR i.valid_from::timestamptz <= $3::timestamptz)
       AND (i.valid_until IS NULL OR i.valid_until::timestamptz > $4::timestamptz)
       AND (i.expires_at IS NULL OR i.expires_at::timestamptz > $5::timestamptz)
       ${kindClause}
       AND (
         i.search_vector @@ plainto_tsquery('simple', $${tsQueryParam})
         OR (
           $${keywordTsQueryParam}::text <> ''
           AND i.search_vector @@ to_tsquery('simple', $${keywordTsQueryParam})
         )
         OR i.title ILIKE $${patternParam}
         OR i.content ILIKE $${patternParam}
         OR i.canonical_key ILIKE $${patternParam}
         OR EXISTS (
           SELECT 1
           FROM unnest(i.search_keys) AS sk
           WHERE sk <> ''
             AND (
               sk ILIKE ANY ($${keywordPatternsParam}::text[])
               OR EXISTS (
                 SELECT 1
                 FROM unnest($${keywordsParam}::text[]) AS kw
                 WHERE kw <> '' AND strpos(kw, sk) > 0
               )
             )
         )
       )
     ORDER BY search_key_hits DESC, search_rank DESC, i.importance DESC,
       i.updated_at DESC
     LIMIT $${limitParam}`,
    params,
  );
  return {
    store,
    hits: rows.rows.map((row) => {
      const searchRank = Number(row.search_rank);
      const searchKeyHits = Number(row.search_key_hits);
      return {
        item: mapItem(row),
        // Keyword agreement is a stronger signal than raw ts_rank alone, and
        // both stay in the same 0–1 range used by decayed recall scoring.
        rank: Math.min(1, searchRank + 0.3 * Math.min(searchKeyHits, 3)),
        searchKeyHits,
        snippet: buildSnippet(row.content, query),
      };
    }),
  };
}

export async function listWorkspaceMemoryVersions(input: {
  workspaceJid: string;
  itemId: string;
  limit: number;
  beforeRevision?: number | null;
}): Promise<{
  store: WorkspaceMemoryStore;
  itemId: string;
  versions: WorkspaceMemoryVersion[];
}> {
  const open = await ready();
  const store = await requireStoreWithin(open, input.workspaceJid);
  const item = await requireItemWithin(open, store, input.itemId);
  if (await isReservedMemoryItem(open, item)) {
    throw new WorkspaceMemoryStoreError(
      'item_not_found',
      'Workspace memory item not found',
    );
  }
  const clauses = ['v.item_id = $1'];
  const params: unknown[] = [input.itemId];
  if (input.beforeRevision) {
    params.push(input.beforeRevision);
    clauses.push(`v.revision < $${params.length}`);
  }
  params.push(input.limit);
  const rows = await open.query<MemoryVersionRow>(
    `SELECT
      v.item_id AS id, v.workspace_jid, v.kind, v.title, v.content,
      v.canonical_key, v.search_keys, v.pinned,
      v.status, v.importance, v.confidence, v.valid_from,
      v.valid_until, v.expires_at, v.revision, v.created_at,
      v.superseded_by, v.demoted_from_kind, v.demoted_at,
      v.created_at AS updated_at, NULL AS deleted_at, v.change_type,
      v.actor_type, v.actor_id,
      p.source_type, p.source_id, p.session_id, p.observed_at
     FROM workspace_memory_versions v
     LEFT JOIN workspace_memory_provenance p
       ON p.item_id = v.item_id AND p.revision = v.revision
     WHERE ${clauses.join(' AND ')}
     ORDER BY v.revision DESC
     LIMIT $${params.length}`,
    params,
  );
  return {
    store,
    itemId: input.itemId,
    versions: rows.rows.map(mapVersion),
  };
}

/**
 * Shared handle to the Memory database for feature modules that own auxiliary
 * tables next to the canonical items (extraction cursors and candidate
 * annotations in `src/memory-candidate-store.ts`, the nightly consolidation
 * worker, which applies each duplicate group in its own transaction).
 *
 * It deliberately exposes the same `MemoryDatabase` the store itself uses so
 * there is exactly one connection (embedded PGlite allows only one) and the
 * migration/bootstrap state is shared. Feature modules must not open their own
 * database, and must not start a `transaction()` while already inside one of
 * the store's transactions (PGlite would deadlock on its single connection).
 * Everything else in this module keeps the handle private, so callers describe
 * intent instead of writing arbitrary SQL; treat this as internal plumbing,
 * not a public API.
 */
export async function withWorkspaceMemoryDatabase<T>(
  work: (db: MemoryDatabase) => Promise<T>,
): Promise<T> {
  return await work(await ready());
}

/**
 * Diagnostics only: raw read access to the Memory database, used by tests that
 * assert on stored lineage (versions, audit, outbox). Never call this from
 * product code — go through the typed store functions instead.
 */
export async function queryWorkspaceMemoryStoreDatabase<
  T extends MemoryRow = MemoryRow,
>(sql: string, params: readonly unknown[] = []): Promise<MemoryQueryResult<T>> {
  const open = await ready();
  return await open.query<T>(sql, params);
}
