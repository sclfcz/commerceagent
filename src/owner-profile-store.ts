import crypto from 'node:crypto';

import {
  COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
  WorkspaceMemoryStoreError,
  enforceCommerceAgentOwnerAddressCanonicalInvariant,
  getCommerceAgentOwnerAddressMemoryItem,
  mutateCommerceAgentOwnerAddressMemory,
  reconcileCommerceAgentOwnerAddressCanonicalKey,
  type WorkspaceMemoryMutationContext,
} from './memory-store.js';

interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

let database: SqliteDatabase | null = null;

export const COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY =
  'happyclaw.owner-introduction';

/**
 * Exact values emitted by historical cold-start prompts when the owner
 * explicitly declined a preferred address. Migration must never use substring
 * matching here: a legitimate address may itself mention one of these words.
 */
export const LEGACY_OWNER_ADDRESS_SKIP_SENTINELS = Object.freeze([
  '主人暂不设置称呼',
  '主人不愿提供称呼',
  '暂不设置称呼',
  '不愿提供称呼',
  'skip',
  'skipped',
] as const);
const LEGACY_OWNER_ADDRESS_SKIP_SENTINEL_SET = new Set<string>(
  LEGACY_OWNER_ADDRESS_SKIP_SENTINELS,
);

export type CommerceAgentOwnerIntroductionState =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'skipped';

export interface CommerceAgentOwnerProfileProjection {
  workspaceJid: string;
  preferredAddress: string | null;
  /** Monotonic revision of the single reserved Memory item, including clear. */
  revision: number | null;
  onboarding: {
    flowKey: typeof COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY;
    state: CommerceAgentOwnerIntroductionState;
    revision: number;
    leaseOwner: string | null;
    leaseToken: number | null;
    leaseExpiresAt: string | null;
    firstWakeAt: string | null;
  };
}

interface OnboardingRow {
  workspace_jid: string;
  flow_key: string;
  state: CommerceAgentOwnerIntroductionState;
  revision: number;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: string | null;
  first_wake_at: string | null;
  completed_at: string | null;
  skipped_at: string | null;
  created_at: string;
  updated_at: string;
}

export class OwnerProfileStoreError extends Error {
  constructor(
    public readonly code:
      | 'not_home_workspace'
      | 'not_owner_turn'
      | 'invalid_address'
      | 'revision_conflict'
      | 'idempotency_conflict'
      | 'lease_conflict',
    message: string,
    public readonly details?: {
      currentRevision?: number;
      storeRevision?: number;
    },
  ) {
    super(message);
    this.name = 'OwnerProfileStoreError';
  }
}

function requireDatabase(): SqliteDatabase {
  if (!database) throw new Error('Owner Profile store is not initialized');
  return database;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeAddress(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || [...normalized].length > 200) {
    throw new OwnerProfileStoreError(
      'invalid_address',
      'Preferred address must be between 1 and 200 characters',
    );
  }
  return normalized;
}

function requireHomeWorkspace(workspaceJid: string): void {
  const row = requireDatabase()
    .prepare(
      `SELECT 1 FROM workspaces
       WHERE jid = ? AND is_home = 1 AND status = 'active'
       LIMIT 1`,
    )
    .get(workspaceJid);
  if (!row) {
    throw new OwnerProfileStoreError(
      'not_home_workspace',
      'CommerceAgent Owner Profile is available only in the owner Home Workspace',
    );
  }
}

function onboardingRow(workspaceJid: string): OnboardingRow | null {
  return (
    (requireDatabase()
      .prepare(
        `SELECT * FROM workspace_onboarding_states
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .get(workspaceJid, COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY) as
      | OnboardingRow
      | undefined) ?? null
  );
}

function ensureOnboardingRow(workspaceJid: string, at: string): OnboardingRow {
  const db = requireDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO workspace_onboarding_states (
      workspace_jid, flow_key, state, revision, lease_owner, lease_token,
      lease_expires_at, completed_at, skipped_at, created_at, updated_at
    ) VALUES (?, ?, 'pending', 0, NULL, 0, NULL, NULL, NULL, ?, ?)`,
  ).run(workspaceJid, COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY, at, at);
  return onboardingRow(workspaceJid)!;
}

function translateMemoryError(error: unknown): never {
  if (!(error instanceof WorkspaceMemoryStoreError)) throw error;
  if (
    error.code === 'revision_conflict' ||
    error.code === 'idempotency_conflict'
  ) {
    throw new OwnerProfileStoreError(error.code, error.message, error.details);
  }
  throw error;
}

function requestHash(
  operation: string,
  value: Record<string, unknown>,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ operation, ...value }), 'utf8')
    .digest('hex');
}

export function bindOwnerProfileDatabase(db: SqliteDatabase | null): void {
  database = db;
}

export function createOwnerProfileSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_onboarding_states (
      workspace_jid TEXT NOT NULL,
      flow_key TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('pending', 'claimed', 'completed', 'skipped')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
      lease_expires_at TEXT,
      first_wake_at TEXT,
      completed_at TEXT,
      skipped_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_jid, flow_key),
      FOREIGN KEY (workspace_jid) REFERENCES workspaces(jid) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_onboarding_claims
      ON workspace_onboarding_states(state, lease_expires_at);

    CREATE TRIGGER IF NOT EXISTS trg_owner_onboarding_after_home_insert
    AFTER INSERT ON workspaces
    WHEN NEW.is_home = 1
    BEGIN
      INSERT OR IGNORE INTO workspace_onboarding_states (
        workspace_jid, flow_key, state, revision, lease_owner, lease_token,
        lease_expires_at, completed_at, skipped_at, created_at, updated_at
      ) VALUES (
        NEW.jid, 'happyclaw.owner-introduction', 'pending', 0, NULL, 0,
        NULL, NULL, NULL, NEW.created_at, NEW.updated_at
      );
    END;

    INSERT OR IGNORE INTO workspace_onboarding_states (
      workspace_jid, flow_key, state, revision, lease_owner, lease_token,
      lease_expires_at, completed_at, skipped_at, created_at, updated_at
    )
    SELECT
      jid, 'happyclaw.owner-introduction', 'pending', 0, NULL, 0,
      NULL, NULL, NULL, created_at, updated_at
    FROM workspaces
    WHERE is_home = 1;
  `);
  const columns = db
    .prepare(`PRAGMA table_info(workspace_onboarding_states)`)
    .all() as Array<{ name: string }>;
  const addedFirstWakeAt = !columns.some(
    (column) => column.name === 'first_wake_at',
  );
  if (addedFirstWakeAt) {
    db.exec(
      `ALTER TABLE workspace_onboarding_states ADD COLUMN first_wake_at TEXT`,
    );
    // Pre-release v66 databases may already have acquired an onboarding lease
    // before first_wake_at existed. Backfill only while adding the column:
    // under the two-phase protocol a normal restart may legitimately observe
    // lease_token > 0 with first_wake_at still NULL until the runner ACKs
    // healthy Assistant progress.
    db.exec(`
      UPDATE workspace_onboarding_states
      SET first_wake_at = COALESCE(updated_at, created_at)
      WHERE first_wake_at IS NULL AND lease_token > 0;
    `);
  }
}

export function getCommerceAgentOwnerProfileProjection(
  workspaceJid: string,
): CommerceAgentOwnerProfileProjection {
  requireHomeWorkspace(workspaceJid);
  const { item } = getCommerceAgentOwnerAddressMemoryItem(workspaceJid);
  const onboarding = onboardingRow(workspaceJid);
  return {
    workspaceJid,
    preferredAddress:
      item?.status === 'active' ? item.content.trim() || null : null,
    revision: item?.revision ?? null,
    onboarding: {
      flowKey: COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
      state: onboarding?.state ?? 'pending',
      revision: Number(onboarding?.revision ?? 0),
      leaseOwner: onboarding?.lease_owner ?? null,
      leaseToken: onboarding ? Number(onboarding.lease_token) : null,
      leaseExpiresAt: onboarding?.lease_expires_at ?? null,
      firstWakeAt: onboarding?.first_wake_at ?? null,
    },
  };
}

function completeIntroduction(workspaceJid: string, at: string): void {
  const row = ensureOnboardingRow(workspaceJid, at);
  if (row.state === 'completed') return;
  requireDatabase()
    .prepare(
      `UPDATE workspace_onboarding_states
       SET state = 'completed', revision = revision + 1,
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = ?, skipped_at = NULL, updated_at = ?
       WHERE workspace_jid = ? AND flow_key = ?`,
    )
    .run(at, at, workspaceJid, COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY);
}

export function setCommerceAgentOwnerPreferredAddress(input: {
  workspaceJid: string;
  preferredAddress: string;
  expectedRevision?: number;
  idempotencyKey?: string | null;
  context: WorkspaceMemoryMutationContext;
}): {
  projection: CommerceAgentOwnerProfileProjection;
  replayed: boolean;
  changed: boolean;
} {
  requireHomeWorkspace(input.workspaceJid);
  const preferredAddress = normalizeAddress(input.preferredAddress);
  const db = requireDatabase();
  try {
    return db.transaction(() => {
      const mutation = mutateCommerceAgentOwnerAddressMemory({
        workspaceJid: input.workspaceJid,
        preferredAddress,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        requestHash: requestHash('set', {
          preferredAddress,
          expectedRevision: input.expectedRevision ?? null,
        }),
        context: input.context,
      });
      completeIntroduction(input.workspaceJid, nowIso());
      return {
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
        replayed: mutation.replayed,
        changed: mutation.changed,
      };
    })();
  } catch (error) {
    translateMemoryError(error);
  }
}

export function clearCommerceAgentOwnerPreferredAddress(input: {
  workspaceJid: string;
  expectedRevision: number;
  idempotencyKey?: string | null;
  context: WorkspaceMemoryMutationContext;
}): {
  projection: CommerceAgentOwnerProfileProjection;
  replayed: boolean;
  changed: boolean;
} {
  requireHomeWorkspace(input.workspaceJid);
  const db = requireDatabase();
  try {
    return db.transaction(() => {
      const mutation = mutateCommerceAgentOwnerAddressMemory({
        workspaceJid: input.workspaceJid,
        clear: true,
        expectedRevision: input.expectedRevision,
        idempotencyKey: input.idempotencyKey,
        requestHash: requestHash('clear', {
          expectedRevision: input.expectedRevision,
        }),
        context: input.context,
      });
      // Clearing a value is not consent to restart first-wake onboarding.
      const row = ensureOnboardingRow(input.workspaceJid, nowIso());
      if (row.state === 'pending' || row.state === 'claimed') {
        completeIntroduction(input.workspaceJid, nowIso());
      }
      return {
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
        replayed: mutation.replayed,
        changed: mutation.changed,
      };
    })();
  } catch (error) {
    translateMemoryError(error);
  }
}

export function claimCommerceAgentOwnerIntroduction(input: {
  workspaceJid: string;
  leaseOwner: string;
  leaseMs?: number;
  now?: string;
}): {
  claimed: boolean;
  leaseAcquired: boolean;
  firstWake: boolean;
  /** @deprecated Use firstWake. Kept as a compatibility alias. */
  newlyClaimed: boolean;
  leaseToken: number | null;
  leaseExpiresAt: string | null;
  projection: CommerceAgentOwnerProfileProjection;
} {
  requireHomeWorkspace(input.workspaceJid);
  const leaseOwner = input.leaseOwner.trim();
  if (!leaseOwner) {
    throw new OwnerProfileStoreError(
      'lease_conflict',
      'Onboarding lease owner is required',
    );
  }
  const at = input.now ?? nowIso();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) {
    throw new OwnerProfileStoreError(
      'lease_conflict',
      'Onboarding lease timestamp is invalid',
    );
  }
  const leaseMs = Math.min(
    Math.max(input.leaseMs ?? 30 * 60_000, 30_000),
    3_600_000,
  );
  const expiresAt = new Date(atMs + leaseMs).toISOString();
  const db = requireDatabase();
  return db.transaction(() => {
    const profile = getCommerceAgentOwnerAddressMemoryItem(input.workspaceJid);
    if (profile.item?.status === 'active') {
      completeIntroduction(input.workspaceJid, at);
      return {
        claimed: false,
        leaseAcquired: false,
        firstWake: false,
        newlyClaimed: false,
        leaseToken: null,
        leaseExpiresAt: null,
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      };
    }
    const row = ensureOnboardingRow(input.workspaceJid, at);
    if (row.state === 'completed' || row.state === 'skipped') {
      return {
        claimed: false,
        leaseAcquired: false,
        firstWake: false,
        newlyClaimed: false,
        leaseToken: null,
        leaseExpiresAt: null,
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      };
    }
    const leaseIsCurrent =
      row.state === 'claimed' &&
      !!row.lease_expires_at &&
      Date.parse(row.lease_expires_at) > atMs;
    if (leaseIsCurrent && row.lease_owner !== leaseOwner) {
      return {
        claimed: false,
        leaseAcquired: false,
        firstWake: false,
        newlyClaimed: false,
        leaseToken: Number(row.lease_token),
        leaseExpiresAt: row.lease_expires_at,
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      };
    }
    if (leaseIsCurrent && row.lease_owner === leaseOwner) {
      db.prepare(
        `UPDATE workspace_onboarding_states
         SET lease_expires_at = ?, updated_at = ?
         WHERE workspace_jid = ? AND flow_key = ?
           AND state = 'claimed' AND lease_owner = ?`,
      ).run(
        expiresAt,
        at,
        input.workspaceJid,
        COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
        leaseOwner,
      );
      return {
        claimed: true,
        leaseAcquired: false,
        firstWake: row.first_wake_at === null,
        newlyClaimed: row.first_wake_at === null,
        leaseToken: Number(row.lease_token),
        leaseExpiresAt: expiresAt,
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      };
    }
    const firstWake = row.first_wake_at === null;
    const acquisition = db
      .prepare(
        `UPDATE workspace_onboarding_states
       SET state = 'claimed', revision = revision + 1, lease_owner = ?,
           lease_token = lease_token + 1, lease_expires_at = ?,
           updated_at = ?
       WHERE workspace_jid = ? AND flow_key = ?
         AND (
           state = 'pending'
           OR (
             state = 'claimed'
             AND (lease_expires_at IS NULL OR julianday(lease_expires_at) <= julianday(?))
           )
         )`,
      )
      .run(
        leaseOwner,
        expiresAt,
        at,
        input.workspaceJid,
        COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
        at,
      );
    const claimed = onboardingRow(input.workspaceJid)!;
    const leaseAcquired =
      acquisition.changes === 1 &&
      claimed.state === 'claimed' &&
      claimed.lease_owner === leaseOwner;
    const isFirstWake = leaseAcquired && firstWake;
    return {
      claimed:
        claimed.state === 'claimed' && claimed.lease_owner === leaseOwner,
      leaseAcquired,
      firstWake: isFirstWake,
      newlyClaimed: isFirstWake,
      leaseToken: Number(claimed.lease_token),
      leaseExpiresAt: claimed.lease_expires_at,
      projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
    };
  })();
}

/**
 * Commit the one-shot first-wake marker only after the runner has observed
 * healthy top-level Assistant progress for the claiming turn. Both fences are
 * required so a stale/overlapping runner cannot acknowledge another lease.
 */
export function acknowledgeCommerceAgentOwnerIntroduction(input: {
  workspaceJid: string;
  leaseOwner: string;
  leaseToken: number;
  now?: string;
}): {
  acknowledged: boolean;
  projection: CommerceAgentOwnerProfileProjection;
} {
  requireHomeWorkspace(input.workspaceJid);
  const leaseOwner = input.leaseOwner.trim();
  if (
    !leaseOwner ||
    !Number.isInteger(input.leaseToken) ||
    input.leaseToken < 1
  ) {
    throw new OwnerProfileStoreError(
      'lease_conflict',
      'Owner introduction acknowledgement lease is invalid',
    );
  }
  const at = input.now ?? nowIso();
  if (!Number.isFinite(Date.parse(at))) {
    throw new OwnerProfileStoreError(
      'lease_conflict',
      'Owner introduction acknowledgement timestamp is invalid',
    );
  }
  const db = requireDatabase();
  return db.transaction(() => {
    const row = ensureOnboardingRow(input.workspaceJid, at);
    if (
      row.state !== 'claimed' ||
      row.lease_owner !== leaseOwner ||
      Number(row.lease_token) !== input.leaseToken
    ) {
      throw new OwnerProfileStoreError(
        'lease_conflict',
        'Owner introduction acknowledgement lease no longer matches',
      );
    }
    if (row.first_wake_at !== null) {
      return {
        acknowledged: false,
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      };
    }
    const result = db
      .prepare(
        `UPDATE workspace_onboarding_states
         SET first_wake_at = ?, revision = revision + 1, updated_at = ?
         WHERE workspace_jid = ? AND flow_key = ?
           AND state = 'claimed' AND lease_owner = ? AND lease_token = ?
           AND first_wake_at IS NULL`,
      )
      .run(
        at,
        at,
        input.workspaceJid,
        COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
        leaseOwner,
        input.leaseToken,
      );
    if (result.changes !== 1) {
      throw new OwnerProfileStoreError(
        'lease_conflict',
        'Owner introduction acknowledgement lease no longer matches',
      );
    }
    return {
      acknowledged: true,
      projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
    };
  })();
}

/**
 * Release an uncompleted runner lease on process exit. The first-wake marker is
 * intentionally retained only when it was separately acknowledged.
 */
export function releaseCommerceAgentOwnerIntroductionLease(
  leaseOwner: string,
  now: string = nowIso(),
): number {
  const normalized = leaseOwner.trim();
  if (!normalized) return 0;
  const result = requireDatabase()
    .prepare(
      `UPDATE workspace_onboarding_states
       SET state = 'pending', revision = revision + 1,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE state = 'claimed' AND lease_owner = ?`,
    )
    .run(now, normalized);
  return result.changes;
}

export function skipCommerceAgentOwnerIntroduction(input: {
  workspaceJid: string;
  expectedOnboardingRevision?: number;
  context: WorkspaceMemoryMutationContext;
}): {
  projection: CommerceAgentOwnerProfileProjection;
  changed: boolean;
} {
  requireHomeWorkspace(input.workspaceJid);
  const db = requireDatabase();
  return db.transaction(() => {
    const at = nowIso();
    const profile = getCommerceAgentOwnerAddressMemoryItem(input.workspaceJid);
    if (profile.item?.status === 'active') {
      completeIntroduction(input.workspaceJid, at);
      return {
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
        changed: false,
      };
    }
    const row = ensureOnboardingRow(input.workspaceJid, at);
    if (row.state === 'skipped') {
      return {
        projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
        changed: false,
      };
    }
    if (
      input.expectedOnboardingRevision !== undefined &&
      input.expectedOnboardingRevision !== row.revision
    ) {
      throw new OwnerProfileStoreError(
        'revision_conflict',
        'CommerceAgent onboarding revision conflict',
        { currentRevision: row.revision },
      );
    }
    db.prepare(
      `UPDATE workspace_onboarding_states
       SET state = 'skipped', revision = revision + 1,
           lease_owner = NULL, lease_expires_at = NULL,
           completed_at = NULL, skipped_at = ?, updated_at = ?
       WHERE workspace_jid = ? AND flow_key = ?`,
    ).run(at, at, input.workspaceJid, COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY);
    return {
      projection: getCommerceAgentOwnerProfileProjection(input.workspaceJid),
      changed: true,
    };
  })();
}

function legacyAddressMeansSkip(content: string): boolean {
  const value = content.trim().toLowerCase();
  return LEGACY_OWNER_ADDRESS_SKIP_SENTINEL_SET.has(value);
}

/**
 * v66 migration coordinator. Reconcile duplicates first, infer onboarding from
 * the surviving reserved-memory lineage, then install the unique index.
 */
export function reconcileLegacyOwnerProfileMemory(): {
  workspaces: number;
  retiredItems: number;
} {
  const db = requireDatabase();
  return db.transaction(() => {
    const reconciled = reconcileCommerceAgentOwnerAddressCanonicalKey();
    const homes = db
      .prepare(`SELECT jid FROM workspaces WHERE is_home = 1`)
      .all() as Array<{ jid: string }>;
    for (const home of homes) {
      const at = nowIso();
      const { item } = getCommerceAgentOwnerAddressMemoryItem(home.jid);
      const onboarding = ensureOnboardingRow(home.jid, at);
      // A prior explicit outcome is authoritative. In particular, a normal
      // restart must never reinterpret an already-skipped row as completed.
      if (onboarding.state === 'completed' || onboarding.state === 'skipped') {
        continue;
      }
      if (!item) continue;
      if (item.status === 'active' && legacyAddressMeansSkip(item.content)) {
        mutateCommerceAgentOwnerAddressMemory({
          workspaceJid: home.jid,
          clear: true,
          expectedRevision: item.revision,
          context: {
            actorId: 'schema-v66-owner-profile-reconciliation',
            sourceType: 'migration',
            sourceId: COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
            observedAt: at,
          },
        });
        db.prepare(
          `UPDATE workspace_onboarding_states
           SET state = 'skipped', revision = revision + 1,
               lease_owner = NULL, lease_expires_at = NULL,
               skipped_at = ?, updated_at = ?
           WHERE workspace_jid = ? AND flow_key = ?`,
        ).run(at, at, home.jid, COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY);
      } else {
        completeIntroduction(home.jid, at);
      }
    }
    enforceCommerceAgentOwnerAddressCanonicalInvariant();
    return reconciled;
  })();
}
