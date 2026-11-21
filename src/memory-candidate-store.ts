/**
 * Candidate and extraction-cursor storage for Workspace Memory v2 (phase C).
 *
 * A candidate is a normal `workspace_memory_items` row with
 * `status = 'proposed'`, so revisions, versions, audit and outbox keep working
 * through the canonical store. `workspace_memory_candidates` only annotates it
 * with extraction-only data (lesson applicability, model retrieval keywords,
 * evidence message IDs, expiry deadline, decision state).
 *
 * Everything here talks to the same Memory database the store owns; opening a
 * second connection would break embedded PGlite, which allows one.
 */

import { logger } from './logger.js';
import type { MemoryRow } from './memory-pg/index.js';
import {
  COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
  createWorkspaceMemoryItem,
  getWorkspaceMemoryStore,
  getWorkspaceMemoryItem,
  listWorkspaceMemoryItems,
  updateWorkspaceMemoryItem,
  withWorkspaceMemoryDatabase,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryKind,
  type WorkspaceMemoryMutationContext,
  type WorkspaceMemorySourceType,
} from './memory-store.js';

export type WorkspaceMemoryCandidateState =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'expired';

export interface WorkspaceMemoryCandidateMetadata {
  itemId: string;
  workspaceJid: string;
  sessionKey: string;
  sessionId: string | null;
  runId: string;
  appliesWhen: string | null;
  searchKeys: string[];
  evidenceMessageIds: string[];
  state: WorkspaceMemoryCandidateState;
  model: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface WorkspaceMemoryCandidate {
  item: WorkspaceMemoryItem;
  candidate: WorkspaceMemoryCandidateMetadata;
}

export interface WorkspaceMemoryExtractionCursor {
  workspaceJid: string;
  sessionKey: string;
  sessionId: string | null;
  lastMessageTimestamp: string | null;
  lastMessageId: string | null;
  lastExtractedAt: string | null;
  lastAttemptAt: string | null;
  attemptCount: number;
  lastError: string | null;
}

interface CandidateRow extends MemoryRow {
  item_id: string;
  workspace_jid: string;
  session_key: string;
  session_id: string | null;
  run_id: string;
  applies_when: string | null;
  search_keys_json: string | null;
  evidence_message_ids_json: string;
  state: WorkspaceMemoryCandidateState;
  model: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

interface ExtractionCursorRow extends MemoryRow {
  workspace_jid: string;
  session_key: string;
  session_id: string | null;
  last_message_timestamp: string | null;
  last_message_id: string | null;
  last_extracted_at: string | null;
  last_attempt_at: string | null;
  attempt_count: number | string;
  last_error: string | null;
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function mapCandidate(row: CandidateRow): WorkspaceMemoryCandidateMetadata {
  return {
    itemId: row.item_id,
    workspaceJid: row.workspace_jid,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    runId: row.run_id,
    appliesWhen: row.applies_when,
    searchKeys: parseJsonArray(row.search_keys_json),
    evidenceMessageIds: parseJsonArray(row.evidence_message_ids_json),
    state: row.state,
    model: row.model,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

const CANDIDATE_SELECT = `
  SELECT item_id, workspace_jid, session_key, session_id, run_id, applies_when,
    search_keys_json, evidence_message_ids_json, state, model, created_at,
    expires_at, decided_at, decided_by
  FROM workspace_memory_candidates
`;

function mapCursor(row: ExtractionCursorRow): WorkspaceMemoryExtractionCursor {
  return {
    workspaceJid: row.workspace_jid,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    lastMessageTimestamp: row.last_message_timestamp,
    lastMessageId: row.last_message_id,
    lastExtractedAt: row.last_extracted_at,
    lastAttemptAt: row.last_attempt_at,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
  };
}

export async function getWorkspaceMemoryExtractionCursor(
  workspaceJid: string,
  sessionKey: string,
): Promise<WorkspaceMemoryExtractionCursor | null> {
  return await withWorkspaceMemoryDatabase(async (db) => {
    const result = await db.query<ExtractionCursorRow>(
      `SELECT workspace_jid, session_key, session_id, last_message_timestamp,
         last_message_id, last_extracted_at, last_attempt_at, attempt_count,
         last_error
       FROM workspace_memory_extraction_cursors
       WHERE workspace_jid = $1 AND session_key = $2`,
      [workspaceJid, sessionKey],
    );
    const row = result.rows[0];
    return row ? mapCursor(row) : null;
  });
}

/**
 * Record that an extraction attempt started (and, when `error` is set, that it
 * failed). The message cursor is intentionally untouched on failure so the
 * same window is retried once the backoff elapses.
 */
export async function recordWorkspaceMemoryExtractionAttempt(input: {
  workspaceJid: string;
  sessionKey: string;
  sessionId?: string | null;
  at: string;
  error?: string | null;
  attemptCount: number;
}): Promise<void> {
  await withWorkspaceMemoryDatabase(async (db) => {
    await db.query(
      `INSERT INTO workspace_memory_extraction_cursors (
         workspace_jid, session_key, session_id, attempt_count, last_attempt_at,
         last_error, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $5, $5)
       ON CONFLICT (workspace_jid, session_key) DO UPDATE SET
         session_id = COALESCE(EXCLUDED.session_id,
           workspace_memory_extraction_cursors.session_id),
         attempt_count = EXCLUDED.attempt_count,
         last_attempt_at = EXCLUDED.last_attempt_at,
         last_error = EXCLUDED.last_error,
         updated_at = EXCLUDED.updated_at`,
      [
        input.workspaceJid,
        input.sessionKey,
        input.sessionId ?? null,
        input.attemptCount,
        input.at,
        input.error ?? null,
      ],
    );
  });
}

/**
 * Move the extraction cursor forward. Called only after a completed model
 * round-trip: a schema-invalid response still advances (the window was read and
 * rejected on purpose, and retrying the same window forever would burn a model
 * call every tick), while a transport failure does not.
 */
export async function advanceWorkspaceMemoryExtractionCursor(input: {
  workspaceJid: string;
  sessionKey: string;
  sessionId?: string | null;
  lastMessageTimestamp: string;
  lastMessageId: string;
  at: string;
}): Promise<void> {
  await withWorkspaceMemoryDatabase(async (db) => {
    await db.query(
      `INSERT INTO workspace_memory_extraction_cursors (
         workspace_jid, session_key, session_id, last_message_timestamp,
         last_message_id, last_extracted_at, last_attempt_at, attempt_count,
         last_error, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6, 0, NULL, $6, $6)
       ON CONFLICT (workspace_jid, session_key) DO UPDATE SET
         session_id = COALESCE(EXCLUDED.session_id,
           workspace_memory_extraction_cursors.session_id),
         last_message_timestamp = EXCLUDED.last_message_timestamp,
         last_message_id = EXCLUDED.last_message_id,
         last_extracted_at = EXCLUDED.last_extracted_at,
         last_attempt_at = EXCLUDED.last_attempt_at,
         attempt_count = 0,
         last_error = NULL,
         updated_at = EXCLUDED.updated_at`,
      [
        input.workspaceJid,
        input.sessionKey,
        input.sessionId ?? null,
        input.lastMessageTimestamp,
        input.lastMessageId,
        input.at,
      ],
    );
  });
}

export async function createWorkspaceMemoryCandidate(input: {
  workspaceJid: string;
  sessionKey: string;
  sessionId?: string | null;
  runId: string;
  kind: WorkspaceMemoryKind;
  title?: string | null;
  content: string;
  canonicalKey?: string | null;
  confidence: number;
  importance: number;
  appliesWhen?: string | null;
  searchKeys?: readonly string[];
  evidenceMessageIds?: readonly string[];
  model?: string | null;
  ttlDays: number;
  /**
   * Who asked for the candidate: automatic extraction (`agent_extraction`), or
   * a model-initiated proposal from an interactive/scheduled runner turn
   * (`agent_runtime` / `scheduled_task`). Host-derived only.
   */
  sourceType?: WorkspaceMemorySourceType;
  actorId?: string;
  idempotencyKey?: string | null;
  requestHash?: string | null;
  now?: string;
}): Promise<{
  item: WorkspaceMemoryItem;
  candidate: WorkspaceMemoryCandidateMetadata;
  replayed: boolean;
}> {
  const now = input.now ?? new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(now) + input.ttlDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const context: WorkspaceMemoryMutationContext = {
    actorId: input.actorId ?? 'memory-extraction',
    sourceType: input.sourceType ?? 'agent_extraction',
    sourceId: input.runId,
    sessionId: input.sessionId ?? null,
    observedAt: now,
  };
  const created = await createWorkspaceMemoryItem({
    workspaceJid: input.workspaceJid,
    value: {
      kind: input.kind,
      title: input.title ?? null,
      content: input.content,
      canonicalKey: input.canonicalKey ?? null,
      // Extraction-proposed keys become the item's keys; when it proposed none
      // the store derives them from the text, exactly like a hand-written item.
      searchKeys: input.searchKeys ? [...input.searchKeys] : undefined,
      status: 'proposed',
      importance: input.importance,
      confidence: input.confidence,
    },
    context,
    idempotencyKey: input.idempotencyKey ?? null,
    requestHash: input.requestHash ?? null,
  });
  if (!created.replayed) {
    await withWorkspaceMemoryDatabase(async (db) => {
      await db.query(
        `INSERT INTO workspace_memory_candidates (
           item_id, workspace_jid, store_id, session_key, session_id, run_id,
           applies_when, search_keys_json, evidence_message_ids_json, state,
           model, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11, $12)
         ON CONFLICT (item_id) DO NOTHING`,
        [
          created.item.id,
          input.workspaceJid,
          created.store.id,
          input.sessionKey,
          input.sessionId ?? null,
          input.runId,
          input.appliesWhen ?? null,
          JSON.stringify(input.searchKeys ?? []),
          JSON.stringify(input.evidenceMessageIds ?? []),
          input.model ?? null,
          now,
          expiresAt,
        ],
      );
    });
  }
  const candidate = await getWorkspaceMemoryCandidateMetadata(
    input.workspaceJid,
    created.item.id,
  );
  return {
    item: created.item,
    candidate:
      candidate ?? buildFallbackCandidate(created.item, input, now, expiresAt),
    replayed: created.replayed,
  };
}

function buildFallbackCandidate(
  item: WorkspaceMemoryItem,
  input: {
    sessionKey: string;
    sessionId?: string | null;
    runId: string;
    appliesWhen?: string | null;
    searchKeys?: readonly string[];
    evidenceMessageIds?: readonly string[];
    model?: string | null;
    workspaceJid: string;
  },
  now: string,
  expiresAt: string,
): WorkspaceMemoryCandidateMetadata {
  return {
    itemId: item.id,
    workspaceJid: input.workspaceJid,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId ?? null,
    runId: input.runId,
    appliesWhen: input.appliesWhen ?? null,
    searchKeys: [...(input.searchKeys ?? [])],
    evidenceMessageIds: [...(input.evidenceMessageIds ?? [])],
    state: 'pending',
    model: input.model ?? null,
    createdAt: now,
    expiresAt,
    decidedAt: null,
    decidedBy: null,
  };
}

export async function getWorkspaceMemoryCandidateMetadata(
  workspaceJid: string,
  itemId: string,
): Promise<WorkspaceMemoryCandidateMetadata | null> {
  return await withWorkspaceMemoryDatabase(async (db) => {
    const result = await db.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE workspace_jid = $1 AND item_id = $2`,
      [workspaceJid, itemId],
    );
    const row = result.rows[0];
    return row ? mapCandidate(row) : null;
  });
}

/** Proposed items of one Workspace, newest first, with candidate annotations. */
export async function listProposedWorkspaceMemoryCandidates(input: {
  workspaceJid: string;
  limit?: number;
}): Promise<WorkspaceMemoryCandidate[]> {
  const listed = await listWorkspaceMemoryItems({
    workspaceJid: input.workspaceJid,
    status: 'proposed',
    limit: Math.min(Math.max(input.limit ?? 50, 1), 100),
  });
  if (listed.items.length === 0) return [];
  const metadata = await withWorkspaceMemoryDatabase(async (db) => {
    const result = await db.query<CandidateRow>(
      `${CANDIDATE_SELECT} WHERE workspace_jid = $1 AND item_id = ANY($2::text[])`,
      [input.workspaceJid, listed.items.map((item) => item.id)],
    );
    return new Map(result.rows.map((row) => [row.item_id, mapCandidate(row)]));
  });
  const now = Date.now();
  return listed.items.map((item) => ({
    item,
    candidate:
      metadata.get(item.id) ??
      // A proposed item written outside the extraction pipeline (for example
      // via a future manual "propose" surface) still has a usable deadline.
      buildFallbackCandidate(
        item,
        {
          workspaceJid: input.workspaceJid,
          sessionKey: 'unknown',
          runId: 'unknown',
        },
        item.createdAt,
        new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString(),
      ),
  }));
}

export async function setWorkspaceMemoryCandidateState(input: {
  workspaceJid: string;
  itemId: string;
  state: WorkspaceMemoryCandidateState;
  decidedBy?: string | null;
  at: string;
}): Promise<void> {
  const store = await getWorkspaceMemoryStore(input.workspaceJid);
  if (!store) return;
  await withWorkspaceMemoryDatabase(async (db) => {
    await db.query(
      `INSERT INTO workspace_memory_candidates (
         item_id, workspace_jid, store_id, session_key, run_id, state,
         created_at, expires_at, decided_at, decided_by
       ) VALUES ($1, $2, $3, 'unknown', 'unknown', $4, $5, $5, $5, $6)
       ON CONFLICT (item_id) DO UPDATE SET
         state = EXCLUDED.state,
         decided_at = EXCLUDED.decided_at,
         decided_by = EXCLUDED.decided_by`,
      [
        input.itemId,
        input.workspaceJid,
        store.id,
        input.state,
        input.at,
        input.decidedBy ?? null,
      ],
    );
  });
}

/**
 * Dedupe snapshot: everything in the Workspace that is not forgotten and could
 * be re-proposed. Proposed rows are included so a repeated extraction run does
 * not queue the same candidate over and over before a human decides.
 */
export async function listWorkspaceMemoryForCandidateDedupe(
  workspaceJid: string,
  limit = 500,
): Promise<
  Array<{
    id: string;
    status: string;
    kind: string;
    title: string | null;
    content: string;
    canonicalKey: string | null;
  }>
> {
  return await withWorkspaceMemoryDatabase(async (db) => {
    const result = await db.query<{
      id: string;
      status: string;
      kind: string;
      title: string | null;
      content: string;
      canonical_key: string | null;
    }>(
      `SELECT i.id, i.status, i.kind, i.title, i.content, i.canonical_key
       FROM workspace_memory_items i
       JOIN workspace_memory_stores s ON s.id = i.store_id
       WHERE s.workspace_jid = $1
         AND i.status IN ('active', 'proposed', 'conflicted')
         AND (i.canonical_key IS NULL OR i.canonical_key <> $2)
       ORDER BY i.updated_at DESC, i.id DESC
       LIMIT $3`,
      [
        workspaceJid,
        COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        limit,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      status: row.status,
      kind: row.kind,
      title: row.title,
      content: row.content,
      canonicalKey: row.canonical_key,
    }));
  });
}

/**
 * Lazily expire candidates that nobody confirmed within the TTL.
 *
 * Expiry is a status change on the item (`proposed` → `superseded`) so it lands
 * in the version history like every other transition, and the candidate row is
 * marked `expired`. An item that was confirmed or rejected between the SELECT
 * and the UPDATE simply fails the CAS and is left alone; the candidate row is
 * then aligned with the item's real state instead of being marked expired.
 */
export async function expireStaleWorkspaceMemoryCandidates(
  input: {
    now?: string;
    limit?: number;
  } = {},
): Promise<{ expired: number; skipped: number }> {
  const now = input.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
  const stale = await withWorkspaceMemoryDatabase(async (db) => {
    const result = await db.query<{ item_id: string; workspace_jid: string }>(
      `SELECT c.item_id, c.workspace_jid
       FROM workspace_memory_candidates c
       JOIN workspace_memory_items i ON i.id = c.item_id
       WHERE c.state = 'pending'
         AND c.expires_at < $1
         AND i.status = 'proposed'
       ORDER BY c.expires_at ASC
       LIMIT $2`,
      [now, limit],
    );
    return result.rows;
  });
  let expired = 0;
  let skipped = 0;
  for (const row of stale) {
    try {
      const current = await getWorkspaceMemoryItem(
        row.workspace_jid,
        row.item_id,
      );
      if (current.item.status !== 'proposed') {
        skipped += 1;
        continue;
      }
      await updateWorkspaceMemoryItem({
        workspaceJid: row.workspace_jid,
        itemId: current.item.id,
        expectedRevision: current.item.revision,
        patch: { status: 'superseded' },
        context: {
          actorId: 'memory-candidate-expiry',
          sourceType: 'system',
          sourceId: null,
          sessionId: null,
          observedAt: now,
        },
      });
      await setWorkspaceMemoryCandidateState({
        workspaceJid: row.workspace_jid,
        itemId: current.item.id,
        state: 'expired',
        at: now,
        decidedBy: 'memory-candidate-expiry',
      });
      expired += 1;
    } catch (error) {
      // A revision conflict means a human decided in the meantime, which is the
      // desired outcome; anything else is logged and retried next sweep.
      skipped += 1;
      logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
          itemId: row.item_id,
        },
        'Workspace Memory candidate expiry skipped an item',
      );
    }
  }
  return { expired, skipped };
}
