import crypto from 'node:crypto';

import {
  createWorkspaceMemoryItem,
  forgetWorkspaceMemoryItem,
  getMutableWorkspaceMemoryItem,
  getWorkspaceMemoryItem,
  getWorkspaceMemoryStore,
  listRecallableWorkspaceMemoryItems,
  listWorkspaceMemoryItems,
  listWorkspaceMemoryVersions as listVersionsFromStore,
  searchWorkspaceMemoryItems,
  updateWorkspaceMemoryItem,
  WorkspaceMemoryStoreError,
  type WorkspaceMemoryItem,
  type WorkspaceMemoryKind,
  type WorkspaceMemorySourceType,
  type WorkspaceMemoryStatus,
  type WorkspaceMemoryValue,
} from './memory-store.js';
import { getRegisteredGroup, getWorkspaceRecord } from './db.js';
import {
  listProposedWorkspaceMemoryCandidates,
  setWorkspaceMemoryCandidateState,
} from './memory-candidate-store.js';
import { canAccessGroup, canModifyGroup } from './web-context.js';
import type { UserRole } from './types.js';

const MAX_CONTENT_LENGTH = 32_768;
const MAX_TITLE_LENGTH = 500;
const MAX_CANONICAL_KEY_LENGTH = 500;
const MAX_SOURCE_ID_LENGTH = 512;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_QUERY_LENGTH = 500;
const MAX_PAGE_SIZE = 100;
const MAX_SNAPSHOT_CHARS = 64_000;

const KINDS = new Set<WorkspaceMemoryKind>([
  'fact',
  'decision',
  'lesson',
  'open_loop',
]);
const STATUSES = new Set<WorkspaceMemoryStatus>([
  'active',
  'proposed',
  'conflicted',
  'superseded',
  'deleted',
]);
const WRITABLE_STATUSES = new Set<Exclude<WorkspaceMemoryStatus, 'deleted'>>([
  'active',
  'proposed',
  'conflicted',
  'superseded',
]);
const SOURCE_TYPES = new Set<WorkspaceMemorySourceType>([
  'web_user',
  'agent_runtime',
  'scheduled_task',
  'migration',
  'agent_extraction',
  'system',
]);

export interface WorkspaceMemoryActor {
  id: string;
  role: UserRole;
}

export interface WorkspaceMemoryProvenanceInput {
  sourceId?: string | null;
  sessionId?: string | null;
  observedAt?: string | null;
}

interface WorkspaceMemoryBaseRequest {
  actor: WorkspaceMemoryActor;
  workspaceJid: string;
}

interface WorkspaceMemoryMutationRequest extends WorkspaceMemoryBaseRequest {
  sourceType: WorkspaceMemorySourceType;
  provenance?: WorkspaceMemoryProvenanceInput;
}

export class WorkspaceMemoryServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_request'
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
    this.name = 'WorkspaceMemoryServiceError';
  }
}

function invalid(message: string): never {
  throw new WorkspaceMemoryServiceError('invalid_request', message);
}

function validateBoundedOptional(
  value: string | null | undefined,
  label: string,
  max: number,
): void {
  if (value !== undefined && value !== null && value.length > max) {
    invalid(`${label} is too long`);
  }
}

function validateIso(value: string | null | undefined, label: string): void {
  if (
    value !== undefined &&
    value !== null &&
    (!value.trim() || !Number.isFinite(Date.parse(value)))
  ) {
    invalid(`${label} must be an ISO 8601 timestamp`);
  }
}

function validateValue(
  value: Partial<WorkspaceMemoryValue>,
  requireCreateFields: boolean,
): void {
  if (requireCreateFields && !value.kind) invalid('kind is required');
  if (value.kind !== undefined && !KINDS.has(value.kind)) {
    invalid('Invalid memory kind');
  }
  if (requireCreateFields && !value.content?.trim()) {
    invalid('content is required');
  }
  if (
    value.content !== undefined &&
    (!value.content.trim() || value.content.length > MAX_CONTENT_LENGTH)
  ) {
    invalid(`content must be between 1 and ${MAX_CONTENT_LENGTH} characters`);
  }
  validateBoundedOptional(value.title, 'title', MAX_TITLE_LENGTH);
  validateBoundedOptional(
    value.canonicalKey,
    'canonicalKey',
    MAX_CANONICAL_KEY_LENGTH,
  );
  if (
    value.status !== undefined &&
    !WRITABLE_STATUSES.has(
      value.status as Exclude<WorkspaceMemoryStatus, 'deleted'>,
    )
  ) {
    invalid('Invalid writable memory status');
  }
  for (const [label, number] of [
    ['importance', value.importance],
    ['confidence', value.confidence],
  ] as const) {
    if (
      number !== undefined &&
      (!Number.isFinite(number) || number < 0 || number > 1)
    ) {
      invalid(`${label} must be between 0 and 1`);
    }
  }
  validateIso(value.validFrom, 'validFrom');
  validateIso(value.validUntil, 'validUntil');
  validateIso(value.expiresAt, 'expiresAt');
  if (
    value.validFrom &&
    value.validUntil &&
    Date.parse(value.validFrom) >= Date.parse(value.validUntil)
  ) {
    invalid('validFrom must be earlier than validUntil');
  }
}

function validateMutationContext(input: WorkspaceMemoryMutationRequest): void {
  if (!SOURCE_TYPES.has(input.sourceType)) invalid('Invalid sourceType');
  validateBoundedOptional(
    input.provenance?.sourceId,
    'provenance.sourceId',
    MAX_SOURCE_ID_LENGTH,
  );
  validateBoundedOptional(
    input.provenance?.sessionId,
    'provenance.sessionId',
    MAX_SOURCE_ID_LENGTH,
  );
  validateIso(input.provenance?.observedAt, 'provenance.observedAt');
}

function authorizeWorkspace(
  input: WorkspaceMemoryBaseRequest,
  operation: 'read' | 'write',
): void {
  const workspace = getWorkspaceRecord(input.workspaceJid);
  const group = getRegisteredGroup(input.workspaceJid);
  if (!workspace || workspace.status !== 'active' || !group) {
    throw new WorkspaceMemoryServiceError(
      'not_found',
      'Workspace memory not found',
    );
  }
  const groupWithJid = { ...group, jid: input.workspaceJid };
  const permitted =
    operation === 'write'
      ? canModifyGroup(input.actor, groupWithJid)
      : canAccessGroup(input.actor, groupWithJid);
  if (!permitted) {
    // Deliberately hide existence. Admin follows the same owner-only policy.
    throw new WorkspaceMemoryServiceError(
      'not_found',
      'Workspace memory not found',
    );
  }
}

function translateStoreError(error: unknown): never {
  if (!(error instanceof WorkspaceMemoryStoreError)) throw error;
  if (error.code === 'revision_conflict') {
    throw new WorkspaceMemoryServiceError(
      'revision_conflict',
      error.message,
      error.details,
    );
  }
  if (error.code === 'idempotency_conflict') {
    throw new WorkspaceMemoryServiceError(
      'idempotency_conflict',
      error.message,
      error.details,
    );
  }
  if (error.code === 'reserved_canonical_key') {
    throw new WorkspaceMemoryServiceError(
      'reserved_canonical_key',
      error.message,
      error.details,
    );
  }
  throw new WorkspaceMemoryServiceError(
    'not_found',
    'Workspace memory not found',
  );
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    invalid(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined, label: string): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    invalid(`Invalid ${label} cursor`);
  }
}

function mutationContext(input: WorkspaceMemoryMutationRequest) {
  validateMutationContext(input);
  return {
    actorId: input.actor.id,
    sourceType: input.sourceType,
    sourceId: input.provenance?.sourceId ?? null,
    sessionId: input.provenance?.sessionId ?? null,
    observedAt: input.provenance?.observedAt ?? null,
  };
}

function requestHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

export async function listWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    status?: WorkspaceMemoryStatus;
    kind?: WorkspaceMemoryKind;
    limit?: number;
    cursor?: string;
  },
) {
  authorizeWorkspace(input, 'read');
  if (input.status && !STATUSES.has(input.status)) invalid('Invalid status');
  if (input.kind && !KINDS.has(input.kind)) invalid('Invalid kind');
  const limit = clampLimit(input.limit, 50);
  const before = decodeCursor<{ updatedAt: string; id: string }>(
    input.cursor,
    'list',
  );
  if (
    before &&
    (typeof before.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(before.updatedAt)) ||
      typeof before.id !== 'string')
  ) {
    invalid('Invalid list cursor');
  }
  try {
    const result = await listWorkspaceMemoryItems({
      workspaceJid: input.workspaceJid,
      status: input.status,
      kind: input.kind,
      limit: limit + 1,
      before,
    });
    const hasMore = result.items.length > limit;
    const items = result.items.slice(0, limit);
    const last = items.at(-1);
    return {
      storeRevision: result.store.revision,
      items,
      nextCursor:
        hasMore && last
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export async function searchWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    query: string;
    kind?: WorkspaceMemoryKind;
    limit?: number;
  },
) {
  authorizeWorkspace(input, 'read');
  const query = input.query?.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) {
    invalid(`query must be between 1 and ${MAX_QUERY_LENGTH} characters`);
  }
  if (input.kind && !KINDS.has(input.kind)) invalid('Invalid kind');
  try {
    const result = await searchWorkspaceMemoryItems({
      workspaceJid: input.workspaceJid,
      query,
      kind: input.kind,
      limit: clampLimit(input.limit, 20),
    });
    return {
      storeRevision: result.store.revision,
      hits: result.hits,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export async function getWorkspaceMemory(
  input: WorkspaceMemoryBaseRequest & {
    itemId: string;
  },
) {
  authorizeWorkspace(input, 'read');
  try {
    const result = await getWorkspaceMemoryItem(
      input.workspaceJid,
      input.itemId,
    );
    return {
      storeRevision: result.store.revision,
      item: result.item,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export async function createWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest &
    WorkspaceMemoryValue & {
      idempotencyKey?: string | null;
    },
) {
  authorizeWorkspace(input, 'write');
  validateValue(input, true);
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const value: WorkspaceMemoryValue = {
    kind: input.kind,
    title: input.title,
    content: input.content,
    canonicalKey: input.canonicalKey,
    status: input.status,
    importance: input.importance,
    confidence: input.confidence,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    expiresAt: input.expiresAt,
  };
  try {
    const result = await createWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      value,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(value),
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

type WorkspaceMemoryPatch = Partial<WorkspaceMemoryValue>;

export async function updateWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest &
    WorkspaceMemoryPatch & {
      itemId: string;
      expectedRevision: number;
      idempotencyKey?: string | null;
    },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const patch: WorkspaceMemoryPatch = {};
  for (const key of [
    'kind',
    'title',
    'content',
    'canonicalKey',
    'status',
    'importance',
    'confidence',
    'validFrom',
    'validUntil',
    'expiresAt',
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      (patch as Record<string, unknown>)[key] = input[key];
    }
  }
  if (Object.keys(patch).length === 0) invalid('No memory fields to update');
  validateValue(patch, false);
  try {
    const current = (
      await getMutableWorkspaceMemoryItem(input.workspaceJid, input.itemId)
    ).item;
    validateValue(
      {
        validFrom:
          patch.validFrom === undefined ? current.validFrom : patch.validFrom,
        validUntil:
          patch.validUntil === undefined
            ? current.validUntil
            : patch.validUntil,
      },
      false,
    );
  } catch (error) {
    translateStoreError(error);
  }
  try {
    const result = await updateWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      patch,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        patch,
      }),
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export async function forgetWorkspaceMemory(
  input: WorkspaceMemoryMutationRequest & {
    itemId: string;
    expectedRevision: number;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(input.reason, 'reason', 1000);
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  try {
    const result = await forgetWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      reason: input.reason,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        reason: input.reason ?? null,
      }),
    });
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

/**
 * Pending extraction candidates with their extraction-only annotations.
 *
 * This is the "待确认" view: proposed items are deliberately excluded from
 * every active list, search and Runtime snapshot, so they need their own read
 * path that also surfaces `appliesWhen` and the evidence message IDs a human
 * needs in order to judge a suggestion.
 */
export async function listWorkspaceMemoryCandidates(
  input: WorkspaceMemoryBaseRequest & { limit?: number },
) {
  authorizeWorkspace(input, 'read');
  const limit = clampLimit(input.limit, 50);
  const candidates = await listProposedWorkspaceMemoryCandidates({
    workspaceJid: input.workspaceJid,
    limit,
  });
  return {
    storeRevision:
      (await getWorkspaceMemoryStore(input.workspaceJid))?.revision ?? 0,
    candidates,
  };
}

function assertProposed(
  item: WorkspaceMemoryItem,
  action: 'confirm' | 'reject',
): void {
  if (item.status !== 'proposed') {
    invalid(`Only proposed memory candidates can be ${action}ed`);
  }
}

/**
 * Confirm a proposed candidate: it becomes an active memory in the same CAS
 * transaction that edits it, so the confirmation is a normal revision with full
 * version/audit history. The candidate row records who decided and when; its
 * `agent_extraction` provenance stays on the create revision.
 */
export async function confirmWorkspaceMemoryCandidate(
  input: WorkspaceMemoryMutationRequest & {
    itemId: string;
    expectedRevision: number;
    kind?: WorkspaceMemoryKind;
    title?: string | null;
    content?: string;
    canonicalKey?: string | null;
    importance?: number;
    confidence?: number;
    idempotencyKey?: string | null;
  },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const patch: WorkspaceMemoryPatch = { status: 'active' };
  for (const key of [
    'kind',
    'title',
    'content',
    'canonicalKey',
    'importance',
    'confidence',
  ] as const) {
    if (input[key] !== undefined) {
      (patch as Record<string, unknown>)[key] = input[key];
    }
  }
  validateValue(patch, false);
  try {
    const current = (
      await getMutableWorkspaceMemoryItem(input.workspaceJid, input.itemId)
    ).item;
    assertProposed(current, 'confirm');
    const result = await updateWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      patch,
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        patch,
        action: 'confirm',
      }),
    });
    if (!result.replayed) {
      await setWorkspaceMemoryCandidateState({
        workspaceJid: input.workspaceJid,
        itemId: result.item.id,
        state: 'confirmed',
        decidedBy: input.actor.id,
        at: result.item.updatedAt,
      });
    }
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

/**
 * Reject a proposed candidate. Rejection is a forget: the item is soft-deleted
 * with a tombstone whose reason is the fixed marker `rejected`, so audit and
 * version history keep the suggestion that was turned down without resurrecting
 * it in the active list.
 */
export async function rejectWorkspaceMemoryCandidate(
  input: WorkspaceMemoryMutationRequest & {
    itemId: string;
    expectedRevision: number;
    idempotencyKey?: string | null;
  },
) {
  authorizeWorkspace(input, 'write');
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) {
    invalid('expectedRevision must be a positive integer');
  }
  validateBoundedOptional(
    input.idempotencyKey,
    'idempotencyKey',
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  try {
    const current = (
      await getMutableWorkspaceMemoryItem(input.workspaceJid, input.itemId)
    ).item;
    assertProposed(current, 'reject');
    const result = await forgetWorkspaceMemoryItem({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      expectedRevision: input.expectedRevision,
      reason: 'rejected',
      context: mutationContext(input),
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash({
        itemId: input.itemId,
        expectedRevision: input.expectedRevision,
        action: 'reject',
      }),
    });
    if (!result.replayed) {
      await setWorkspaceMemoryCandidateState({
        workspaceJid: input.workspaceJid,
        itemId: result.item.id,
        state: 'rejected',
        decidedBy: input.actor.id,
        at: result.item.updatedAt,
      });
    }
    return {
      storeRevision: result.store.revision,
      item: result.item,
      replayed: result.replayed,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

export async function listWorkspaceMemoryVersions(
  input: WorkspaceMemoryBaseRequest & {
    itemId: string;
    limit?: number;
    cursor?: string;
  },
) {
  authorizeWorkspace(input, 'read');
  const limit = clampLimit(input.limit, 50);
  const decoded = decodeCursor<{ revision: number }>(input.cursor, 'version');
  if (
    decoded &&
    (!Number.isInteger(decoded.revision) || decoded.revision < 1)
  ) {
    invalid('Invalid version cursor');
  }
  try {
    const result = await listVersionsFromStore({
      workspaceJid: input.workspaceJid,
      itemId: input.itemId,
      limit: limit + 1,
      beforeRevision: decoded?.revision,
    });
    const hasMore = result.versions.length > limit;
    const versions = result.versions.slice(0, limit);
    const last = versions.at(-1);
    return {
      storeRevision: result.store.revision,
      itemId: result.itemId,
      versions,
      nextCursor:
        hasMore && last ? encodeCursor({ revision: last.revision }) : null,
    };
  } catch (error) {
    translateStoreError(error);
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function getWorkspaceMemorySnapshot(
  input: WorkspaceMemoryBaseRequest & {
    query?: string | null;
    kind?: WorkspaceMemoryKind;
    limit?: number;
    maxChars?: number;
  },
) {
  const limit = clampLimit(input.limit, 12);
  const maxChars = Math.max(
    256,
    Math.min(MAX_SNAPSHOT_CHARS, Math.trunc(input.maxChars ?? 12_000)),
  );
  let storeRevision: number;
  let items: WorkspaceMemoryItem[];
  if (input.query?.trim()) {
    const searched = await searchWorkspaceMemory({
      ...input,
      query: input.query,
      kind: input.kind,
      limit,
    });
    storeRevision = searched.storeRevision;
    items = searched.hits.map((hit) => hit.item);
    if (items.length < limit) {
      // A turn prompt is not a search query. In particular, an exact FTS
      // phrase for a long natural-language/Chinese prompt often returns zero
      // even though the Workspace has important standing context. Preserve
      // relevance hits first, then fill the remaining budget with the most
      // important currently-valid memories.
      try {
        const recalled = await listRecallableWorkspaceMemoryItems({
          workspaceJid: input.workspaceJid,
          kind: input.kind,
          limit,
        });
        storeRevision = recalled.store.revision;
        const seen = new Set(items.map((item) => item.id));
        for (const item of recalled.items) {
          if (items.length >= limit) break;
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          items.push(item);
        }
      } catch (error) {
        translateStoreError(error);
      }
    }
  } else {
    authorizeWorkspace(input, 'read');
    try {
      const recalled = await listRecallableWorkspaceMemoryItems({
        workspaceJid: input.workspaceJid,
        kind: input.kind,
        limit,
      });
      storeRevision = recalled.store.revision;
      items = recalled.items;
    } catch (error) {
      translateStoreError(error);
    }
  }

  const lines = [
    `<workspace_memory workspace="${xmlEscape(input.workspaceJid)}" revision="${storeRevision}">`,
  ];
  const included: WorkspaceMemoryItem[] = [];
  let size = lines[0].length;
  for (const item of items) {
    const line = `<memory id="${xmlEscape(item.id)}" revision="${item.revision}" kind="${item.kind}">${xmlEscape(item.content)}</memory>`;
    if (size + line.length + '</workspace_memory>'.length > maxChars) break;
    lines.push(line);
    included.push(item);
    size += line.length;
  }
  lines.push('</workspace_memory>');
  const generatedAt = new Date().toISOString();
  return {
    workspaceJid: input.workspaceJid,
    storeRevision,
    items: included,
    renderedText: included.length > 0 ? lines.join('\n') : '',
    retrievalTrace: {
      query: input.query?.trim() || null,
      itemRevisions: included.map((item) => ({
        id: item.id,
        revision: item.revision,
      })),
      generatedAt,
    },
  };
}
