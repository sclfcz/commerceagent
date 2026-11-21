import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { WorkspaceMemoryMutationContext } from '../src/memory-store.js';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'commerceagent-owner-profile-store-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const memoryService = await import('../src/memory-service.js');
const memoryStore = await import('../src/memory-store.js');
const ownerProfile = await import('../src/owner-profile-store.js');

const OWNER_ID = 'owner-profile-qa-owner';
const ACTUAL_SENDER_ID = 'owner-profile-qa-actual-sender';

function createWorkspace(label: string): string {
  const jid = `web:owner-profile-${label}`;
  db.setRegisteredGroup(jid, {
    name: `Owner profile ${label}`,
    folder: `owner-profile-${label}`,
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    is_home: true,
  });
  return jid;
}

function mutationContext(actorId = OWNER_ID): WorkspaceMemoryMutationContext {
  return {
    actorId,
    sourceType: 'web_user',
    sourceId: `message-from-${actorId}`,
    sessionId: `session-for-${actorId}`,
    observedAt: '2026-07-28T10:00:00.000Z',
  };
}

function rawDatabase(): Database.Database {
  return new Database(path.join(storeDir, 'messages.db'));
}

async function memoryRows<T extends Record<string, unknown>>(
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<T>(
    sql,
    params,
  );
  return result.rows;
}

async function memoryRun(sql: string, ...params: unknown[]): Promise<void> {
  await memoryStore.queryWorkspaceMemoryStoreDatabase(sql, params);
}

/** Read a row from the SQLite control-plane tables (not Workspace Memory). */
function sqliteRow<T>(sql: string, ...params: unknown[]): T | undefined {
  const raw = rawDatabase();
  try {
    return raw.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    raw.close();
  }
}

function ownerOnboardingRow(workspaceJid: string) {
  return sqliteRow<{
    state: string;
    revision: number;
    skipped_at: string | null;
    updated_at: string;
  }>(
    `SELECT state, revision, skipped_at, updated_at
     FROM workspace_onboarding_states
     WHERE workspace_jid = ? AND flow_key = ?`,
    workspaceJid,
    ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
  );
}

/**
 * Simulate a process restart: the PostgreSQL store is closed and reopened on
 * the same embedded data directory, which is what a real restart does.
 */
async function restartDatabase(): Promise<void> {
  await memoryStore.closeWorkspaceMemoryStore();
  db.closeDatabase();
  db.initDatabase();
  await memoryStore.initWorkspaceMemoryStore();
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function reservedRows(workspaceJid: string) {
  return await memoryRows<{
    id: string;
    content: string;
    status: string;
    revision: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT id, content, status, revision, created_at, updated_at
     FROM workspace_memory_items
     WHERE workspace_jid = $1 AND canonical_key = $2
     ORDER BY created_at ASC, id ASC`,
    workspaceJid,
    memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
  );
}

async function itemArtifacts(itemId: string) {
  const rows = await memoryRows<{
    versions: number;
    audits: number;
    outbox: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM workspace_memory_versions WHERE item_id = $1) AS versions,
       (SELECT COUNT(*)::int FROM workspace_memory_audit_events WHERE item_id = $1) AS audits,
       (SELECT COUNT(*)::int FROM workspace_memory_outbox WHERE item_id = $1) AS outbox`,
    itemId,
  );
  return rows[0];
}

beforeAll(async () => {
  db.initDatabase();
  await memoryStore.initWorkspaceMemoryStore();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER_ID,
    username: OWNER_ID,
    password_hash: 'hash',
    display_name: 'Profile owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CommerceAgent owner preferred-address facade', () => {
  test('set is no-op aware, updates with CAS, clears, and restores without losing history', async () => {
    const workspaceJid = createWorkspace('lifecycle');

    const empty =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(empty).toMatchObject({
      workspaceJid,
      preferredAddress: null,
      revision: null,
      onboarding: { state: 'pending' },
    });

    const created = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '小何',
      expectedRevision: 0,
      context: mutationContext(),
    });
    expect(created).toMatchObject({
      changed: true,
      replayed: false,
      projection: {
        preferredAddress: '小何',
        revision: 1,
        onboarding: { state: 'completed' },
      },
    });

    const canonicalAfterCreate = await reservedRows(workspaceJid);
    expect(canonicalAfterCreate).toHaveLength(1);
    const firstItemId = canonicalAfterCreate[0].id;
    expect(await itemArtifacts(firstItemId)).toEqual({
      versions: 1,
      audits: 1,
      outbox: 1,
    });

    const noOp = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '  小何  ',
      expectedRevision: 1,
      context: mutationContext(),
    });
    expect(noOp).toMatchObject({
      changed: false,
      replayed: false,
      projection: { preferredAddress: '小何', revision: 1 },
    });
    expect(
      await memoryRows(
        'SELECT COUNT(*)::int AS count FROM workspace_memory_versions WHERE item_id = $1',
        firstItemId,
      ),
    ).toEqual([{ count: 1 }]);

    const updated = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '何先生',
      expectedRevision: 1,
      context: mutationContext(ACTUAL_SENDER_ID),
    });
    expect(updated).toMatchObject({
      changed: true,
      replayed: false,
      projection: { preferredAddress: '何先生', revision: 2 },
    });
    expect(await reservedRows(workspaceJid)).toMatchObject([
      { id: firstItemId, content: '何先生', status: 'active', revision: 2 },
    ]);
    expect(
      await memoryRows(
        `SELECT actor_id
         FROM workspace_memory_versions
         WHERE item_id = $1 AND revision = 2`,
        firstItemId,
      ),
    ).toEqual([{ actor_id: ACTUAL_SENDER_ID }]);
    expect(
      await memoryRows(
        `SELECT source_id, session_id
         FROM workspace_memory_provenance
         WHERE item_id = $1 AND revision = 2`,
        firstItemId,
      ),
    ).toEqual([
      {
        source_id: `message-from-${ACTUAL_SENDER_ID}`,
        session_id: `session-for-${ACTUAL_SENDER_ID}`,
      },
    ]);

    const cleared = await ownerProfile.clearCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      expectedRevision: 2,
      context: mutationContext(),
    });
    expect(cleared).toMatchObject({
      changed: true,
      replayed: false,
      projection: {
        preferredAddress: null,
        revision: 3,
        onboarding: { state: 'completed' },
      },
    });
    expect(await reservedRows(workspaceJid)).toMatchObject([
      { id: firstItemId, status: 'superseded', revision: 3 },
    ]);

    // Clearing the value is not an instruction to repeat first-wake.
    const postClearClaim =
      await ownerProfile.claimCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'new-session-after-clear',
      });
    expect(postClearClaim).toMatchObject({
      claimed: false,
      projection: {
        preferredAddress: null,
        onboarding: { state: 'completed' },
      },
    });

    const restored = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '老何',
      expectedRevision: 3,
      context: mutationContext(),
    });
    expect(restored).toMatchObject({
      changed: true,
      replayed: false,
      projection: {
        preferredAddress: '老何',
        revision: 4,
        onboarding: { state: 'completed' },
      },
    });
    const allRows = await reservedRows(workspaceJid);
    expect(allRows).toHaveLength(1);
    expect(allRows[0]).toMatchObject({
      id: firstItemId,
      status: 'active',
      revision: 4,
    });
    expect(allRows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(
      await memoryRows(
        `SELECT COUNT(*)::int AS count
         FROM workspace_memory_versions
         WHERE item_id IN (
           SELECT id FROM workspace_memory_items
           WHERE workspace_jid = $1 AND canonical_key = $2
         )`,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      ),
    ).toEqual([{ count: 4 }]);
  });

  test('stale set and clear compare-and-swap attempts preserve the winner', async () => {
    const workspaceJid = createWorkspace('cas');
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '第一版',
      context: mutationContext(),
    });
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '获胜版本',
      expectedRevision: 1,
      context: mutationContext(),
    });

    for (const operation of [
      () =>
        ownerProfile.setCommerceAgentOwnerPreferredAddress({
          workspaceJid,
          preferredAddress: '丢失版本',
          expectedRevision: 1,
          context: mutationContext(),
        }),
      () =>
        ownerProfile.clearCommerceAgentOwnerPreferredAddress({
          workspaceJid,
          expectedRevision: 1,
          context: mutationContext(),
        }),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: 'revision_conflict',
      });
    }
    expect(
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({ preferredAddress: '获胜版本', revision: 2 });
  });

  test('replays a retried first set without creating another revision', async () => {
    const workspaceJid = createWorkspace('first-set-idempotency');
    const request = {
      workspaceJid,
      preferredAddress: '幂等称呼',
      expectedRevision: 0,
      idempotencyKey: 'owner-profile-first-set',
      context: mutationContext(),
    };
    const first =
      await ownerProfile.setCommerceAgentOwnerPreferredAddress(request);
    const replay =
      await ownerProfile.setCommerceAgentOwnerPreferredAddress(request);
    expect(first).toMatchObject({
      changed: true,
      replayed: false,
      projection: { preferredAddress: '幂等称呼', revision: 1 },
    });
    expect(replay).toMatchObject({
      changed: true,
      replayed: true,
      projection: { preferredAddress: '幂等称呼', revision: 1 },
    });

    const item = (await reservedRows(workspaceJid))[0];
    expect(
      await memoryRows(
        'SELECT COUNT(*)::int AS count FROM workspace_memory_versions WHERE item_id = $1',
        item.id,
      ),
    ).toEqual([{ count: 1 }]);

    await expect(
      ownerProfile.setCommerceAgentOwnerPreferredAddress({
        ...request,
        preferredAddress: '复用 key 的不同请求',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('projection is read-through on both cold and already-warm callers', async () => {
    const workspaceJid = createWorkspace('projection-refresh');
    const cold =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(cold.preferredAddress).toBeNull();

    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '冷启动称呼',
      context: mutationContext(),
    });
    const firstWarm =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(firstWarm).toMatchObject({
      preferredAddress: '冷启动称呼',
      revision: 1,
    });

    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '热会话刷新称呼',
      expectedRevision: 1,
      context: mutationContext(),
    });
    const refreshed =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(refreshed).toMatchObject({
      preferredAddress: '热会话刷新称呼',
      revision: 2,
    });
    expect(refreshed).not.toBe(firstWarm);
  });

  test('restores a legacy deleted reserved item on the same revision lineage', async () => {
    const workspaceJid = createWorkspace('legacy-deleted-restore');
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '删除前称呼',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const item = (await reservedRows(workspaceJid))[0];
    const deletedAt = '2026-07-28T11:00:00.000Z';
    await memoryRun(
      `UPDATE workspace_memory_items
       SET status = 'deleted', revision = 2, updated_at = $1, deleted_at = $1
       WHERE id = $2`,
      deletedAt,
      item.id,
    );
    await memoryRun(
      `INSERT INTO workspace_memory_versions (
        item_id, revision, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        change_type, actor_type, actor_id, created_at
      ) VALUES (
        $1, 2, $2, 'fact', '主人称呼', '删除前称呼', $3, 'deleted',
        1, 1, NULL, NULL, NULL, 'forget', 'migration', 'legacy-delete', $4
      )`,
      item.id,
      workspaceJid,
      memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      deletedAt,
    );
    await memoryRun(
      `INSERT INTO workspace_memory_provenance (
        item_id, revision, source_type, source_id, session_id, observed_at,
        recorded_at
      ) VALUES ($1, 2, 'migration', 'legacy-delete', NULL, NULL, $2)`,
      item.id,
      deletedAt,
    );
    await memoryRun(
      `INSERT INTO workspace_memory_tombstones (
        item_id, workspace_jid, deleted_revision, reason, actor_type, actor_id,
        deleted_at
      ) VALUES ($1, $2, 2, 'legacy clear', 'migration', 'legacy-delete', $3)`,
      item.id,
      workspaceJid,
      deletedAt,
    );

    const restored = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '恢复后的称呼',
      expectedRevision: 2,
      context: mutationContext(),
    });
    expect(restored).toMatchObject({
      changed: true,
      projection: {
        preferredAddress: '恢复后的称呼',
        revision: 3,
      },
    });

    expect(await reservedRows(workspaceJid)).toMatchObject([
      {
        id: item.id,
        content: '恢复后的称呼',
        status: 'active',
        revision: 3,
      },
    ]);
    expect(
      await memoryRows(
        'SELECT COUNT(*)::int AS count FROM workspace_memory_versions WHERE item_id = $1',
        item.id,
      ),
    ).toEqual([{ count: 3 }]);
    expect(
      await memoryRows(
        'SELECT COUNT(*)::int AS count FROM workspace_memory_tombstones WHERE item_id = $1',
        item.id,
      ),
    ).toEqual([{ count: 0 }]);
  });
});

describe('CommerceAgent owner introduction onboarding state', () => {
  test('claims first wake without consuming it until a fenced acknowledgement', async () => {
    const workspaceJid = createWorkspace('onboarding-lease');
    const now = '2026-07-28T12:00:00.000Z';
    const first = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'session-a',
      leaseMs: 60_000,
      now,
    });
    expect(first).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: true,
      newlyClaimed: true,
      leaseToken: expect.any(Number),
      leaseExpiresAt: '2026-07-28T12:01:00.000Z',
      projection: { onboarding: { state: 'claimed' } },
    });

    const sameRunnerBeforeAck =
      await ownerProfile.claimCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-a',
        leaseMs: 60_000,
        now: '2026-07-28T12:00:15.000Z',
      });
    expect(sameRunnerBeforeAck).toMatchObject({
      claimed: true,
      leaseAcquired: false,
      firstWake: true,
      leaseToken: first.leaseToken,
    });

    const contending = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'session-b',
      leaseMs: 60_000,
      now: '2026-07-28T12:00:30.000Z',
    });
    expect(contending).toMatchObject({
      claimed: false,
      leaseAcquired: false,
      firstWake: false,
      newlyClaimed: false,
      leaseToken: first.leaseToken,
      leaseExpiresAt: sameRunnerBeforeAck.leaseExpiresAt,
      projection: { onboarding: { state: 'claimed' } },
    });

    const reclaimed = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'session-b',
      leaseMs: 60_000,
      now: '2026-07-28T12:01:16.000Z',
    });
    expect(reclaimed).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: true,
      newlyClaimed: true,
      leaseToken: expect.any(Number),
      projection: { onboarding: { state: 'claimed' } },
    });
    expect(reclaimed.leaseToken).toBeGreaterThan(first.leaseToken!);

    await expect(
      ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-a',
        leaseToken: reclaimed.leaseToken!,
        now: '2026-07-28T12:01:17.000Z',
      }),
    ).rejects.toThrow('lease no longer matches');
    await expect(
      ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-b',
        leaseToken: first.leaseToken!,
        now: '2026-07-28T12:01:17.000Z',
      }),
    ).rejects.toThrow('lease no longer matches');

    const acknowledged =
      await ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-b',
        leaseToken: reclaimed.leaseToken!,
        now: '2026-07-28T12:01:17.000Z',
      });
    expect(acknowledged).toMatchObject({
      acknowledged: true,
      projection: {
        onboarding: {
          state: 'claimed',
          firstWakeAt: '2026-07-28T12:01:17.000Z',
        },
      },
    });
    expect(
      await ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-b',
        leaseToken: reclaimed.leaseToken!,
        now: '2026-07-28T12:01:18.000Z',
      }),
    ).toMatchObject({ acknowledged: false });

    const skipped = await ownerProfile.skipCommerceAgentOwnerIntroduction({
      workspaceJid,
      expectedOnboardingRevision: acknowledged.projection.onboarding.revision,
      context: mutationContext(),
    });
    expect(skipped).toMatchObject({
      changed: true,
      projection: {
        preferredAddress: null,
        onboarding: { state: 'skipped', leaseExpiresAt: null },
      },
    });
    expect(
      await ownerProfile.claimCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-c',
        now: '2026-07-28T13:00:00.000Z',
      }),
    ).toMatchObject({
      claimed: false,
      projection: { onboarding: { state: 'skipped' } },
    });
  });

  test('runner exit releases an unacknowledged lease without consuming first wake', async () => {
    const workspaceJid = createWorkspace('onboarding-release');
    const first = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'failed-runner',
      now: '2026-07-28T12:00:00.000Z',
    });
    expect(first).toMatchObject({ firstWake: true, leaseAcquired: true });

    expect(
      ownerProfile.releaseCommerceAgentOwnerIntroductionLease(
        'failed-runner',
        '2026-07-28T12:00:01.000Z',
      ),
    ).toBe(1);
    const retry = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'retry-runner',
      now: '2026-07-28T12:00:02.000Z',
    });
    expect(retry).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: true,
      projection: {
        onboarding: {
          leaseOwner: 'retry-runner',
          firstWakeAt: null,
        },
      },
    });
  });

  test('normal database restart does not consume an unacknowledged first wake', async () => {
    const workspaceJid = createWorkspace('onboarding-restart');
    const first = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'restart-runner',
      leaseMs: 60_000,
      now: '2026-07-28T12:00:00.000Z',
    });
    expect(first).toMatchObject({ firstWake: true, leaseToken: 1 });

    await restartDatabase();

    const resumed = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'restart-runner',
      leaseMs: 60_000,
      now: '2026-07-28T12:00:30.000Z',
    });
    expect(resumed).toMatchObject({
      claimed: true,
      leaseAcquired: false,
      firstWake: true,
      leaseToken: first.leaseToken,
      projection: { onboarding: { firstWakeAt: null } },
    });
  });

  test('backfills first wake for pre-release v66 claimed rows without consuming it for fresh pending rows', async () => {
    const historicalWorkspaceJid = createWorkspace(
      'pre-release-v66-first-wake',
    );
    const original = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid: historicalWorkspaceJid,
      leaseOwner: 'historical-session',
      leaseMs: 60_000,
      now: '2026-07-28T12:00:00.000Z',
    });
    expect(original).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: true,
      leaseToken: 1,
    });

    db.closeDatabase();
    const legacy = rawDatabase();
    expect(
      legacy
        .prepare(`SELECT value FROM router_state WHERE key = 'schema_version'`)
        .get(),
    ).toEqual({ value: String(db.CURRENT_SCHEMA_VERSION) });
    legacy
      .prepare(
        `UPDATE workspace_onboarding_states
         SET state = 'claimed', revision = 1,
             lease_owner = 'historical-session', lease_token = 1,
             lease_expires_at = '2026-07-28T12:01:00.000Z',
             updated_at = '2026-07-28T12:00:00.000Z'
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .run(
        historicalWorkspaceJid,
        ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
      );
    legacy.exec(
      'ALTER TABLE workspace_onboarding_states DROP COLUMN first_wake_at',
    );
    expect(
      (
        legacy
          .prepare('PRAGMA table_info(workspace_onboarding_states)')
          .all() as Array<{ name: string }> | undefined
      )?.some((column) => column.name === 'first_wake_at'),
    ).toBe(false);
    legacy.close();

    db.initDatabase();

    const historicalProjection =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(
        historicalWorkspaceJid,
      );
    expect(historicalProjection.onboarding).toMatchObject({
      state: 'claimed',
      leaseToken: 1,
      firstWakeAt: '2026-07-28T12:00:00.000Z',
    });
    const reclaimed = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid: historicalWorkspaceJid,
      leaseOwner: 'reclaimed-session',
      leaseMs: 60_000,
      now: '2026-07-28T12:02:00.000Z',
    });
    expect(reclaimed).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: false,
      newlyClaimed: false,
      leaseToken: 2,
    });

    const freshWorkspaceJid = createWorkspace('fresh-v66-first-wake');
    const fresh = await ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid: freshWorkspaceJid,
      leaseOwner: 'fresh-session',
      leaseMs: 60_000,
      now: '2026-07-28T12:02:00.000Z',
    });
    expect(fresh).toMatchObject({
      claimed: true,
      leaseAcquired: true,
      firstWake: true,
      newlyClaimed: true,
      leaseToken: 1,
    });
  });
});

describe('v66 owner-profile migration boundary', () => {
  test('does not mistake an address containing a legacy sentinel phrase for the sentinel itself', async () => {
    const workspaceJid = createWorkspace('legacy-sentinel-substring');
    const legitimateAddress = '小何（不愿提供英文名）';
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: legitimateAddress,
      expectedRevision: 0,
      context: mutationContext(),
    });

    const item = (await reservedRows(workspaceJid))[0];
    const before = {
      item: (
        await memoryRows(
          `SELECT content, status, revision
           FROM workspace_memory_items
           WHERE id = $1`,
          item.id,
        )
      )[0],
      versions: (
        await memoryRows(
          `SELECT COUNT(*)::int AS count
           FROM workspace_memory_versions
           WHERE item_id = $1`,
          item.id,
        )
      )[0],
    };
    const raw = rawDatabase();
    raw
      .prepare(
        `DELETE FROM workspace_onboarding_states
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .run(
        workspaceJid,
        ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
      );
    raw
      .prepare(
        `UPDATE router_state
         SET value = '65'
         WHERE key = 'schema_version'`,
      )
      .run();
    raw.close();

    await restartDatabase();

    expect(
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: legitimateAddress,
      revision: 1,
      onboarding: { state: 'completed' },
    });
    expect({
      item: (
        await memoryRows(
          `SELECT content, status, revision
           FROM workspace_memory_items
           WHERE id = $1`,
          item.id,
        )
      )[0],
      versions: (
        await memoryRows(
          `SELECT COUNT(*)::int AS count
           FROM workspace_memory_versions
           WHERE item_id = $1`,
          item.id,
        )
      )[0],
    }).toEqual(before);
  });

  test('matches the exact legacy skip sentinel once and preserves skipped across later starts', async () => {
    const workspaceJid = createWorkspace('legacy-exact-sentinel');
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '主人不愿提供称呼',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const item = (await reservedRows(workspaceJid))[0];
    const raw = rawDatabase();
    raw
      .prepare(
        `DELETE FROM workspace_onboarding_states
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .run(
        workspaceJid,
        ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY,
      );
    raw
      .prepare(
        `UPDATE router_state
         SET value = '65'
         WHERE key = 'schema_version'`,
      )
      .run();
    raw.close();

    await restartDatabase();

    expect(
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: null,
      revision: 2,
      onboarding: { state: 'skipped' },
    });
    expect(await reservedRows(workspaceJid)).toMatchObject([
      { id: item.id, status: 'superseded', revision: 2 },
    ]);
    const onceOnlySnapshot = {
      item: (
        await memoryRows(
          `SELECT content, canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = $1`,
          item.id,
        )
      )[0],
      onboarding: ownerOnboardingRow(workspaceJid),
      artifacts: await itemArtifacts(item.id),
    };

    await restartDatabase();

    expect(
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: null,
      revision: 2,
      onboarding: { state: 'skipped' },
    });
    expect({
      item: (
        await memoryRows(
          `SELECT content, canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = $1`,
          item.id,
        )
      )[0],
      onboarding: ownerOnboardingRow(workspaceJid),
      artifacts: await itemArtifacts(item.id),
    }).toEqual(onceOnlySnapshot);
  });
});

describe('reserved canonical-key integrity', () => {
  test('generic memory mutations fail closed for the owner-profile key', async () => {
    const workspaceJid = createWorkspace('reserved-deny');
    const actor = { id: OWNER_ID, role: 'member' as const };

    await expect(
      memoryService.createWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        kind: 'fact',
        content: 'generic create must not own this key',
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });

    const dedicated = await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '专用接口写入',
      context: mutationContext(),
    });
    const itemId = (await reservedRows(workspaceJid))[0].id;

    await expect(
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId,
        expectedRevision: dedicated.projection.revision!,
        content: 'generic update must not mutate the reserved item',
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });
    await expect(
      memoryService.forgetWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId,
        expectedRevision: dedicated.projection.revision!,
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });

    const ordinary = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'fact',
      content: 'ordinary memory',
    });
    await expect(
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: ordinary.item.id,
        expectedRevision: 1,
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });

    const projection =
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(projection).toMatchObject({
      preferredAddress: '专用接口写入',
      revision: 1,
    });

    expect(
      (
        await memoryService.listWorkspaceMemory({
          actor,
          workspaceJid,
          status: 'active',
        })
      ).items,
    ).toEqual([expect.objectContaining({ id: ordinary.item.id })]);
    expect(
      (
        await memoryService.searchWorkspaceMemory({
          actor,
          workspaceJid,
          query: '专用接口写入',
        })
      ).hits,
    ).toEqual([]);
    await expect(
      memoryService.listWorkspaceMemoryVersions({
        actor,
        workspaceJid,
        itemId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('legacy duplicates are reconciled before a partial unique index is enforced', async () => {
    const workspaceJid = createWorkspace('legacy-reconcile');
    const actor = { id: OWNER_ID, role: 'member' as const };
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '当前称呼',
      context: mutationContext(),
    });

    // Simulate a pre-v66 database: no reserved-key invariant existed yet.
    await memoryRun(
      'DROP INDEX IF EXISTS idx_workspace_memory_owner_address_unique',
    );

    const current = (
      await memoryRows<Record<string, unknown>>(
        `SELECT *
         FROM workspace_memory_items
         WHERE workspace_jid = $1 AND canonical_key = $2`,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      )
    )[0];
    const duplicateId = 'wmi_owner_profile_legacy_duplicate';
    await memoryRun(
      `INSERT INTO workspace_memory_items (
        id, store_id, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        revision, create_idempotency_key, create_request_hash,
        created_at, updated_at, deleted_at
      ) VALUES (
        $1, $2, $3, 'fact', '主人称呼', '旧重复称呼', $4, 'active',
        1, 1, NULL, NULL, NULL, 1, NULL, NULL, $5, $5, NULL
      )`,
      duplicateId,
      current.store_id,
      workspaceJid,
      memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      '2026-01-01T00:00:00.000Z',
    );
    await memoryRun(
      `INSERT INTO workspace_memory_versions (
        item_id, revision, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        change_type, actor_type, actor_id, created_at
      ) VALUES (
        $1, 1, $2, 'fact', '主人称呼', '旧重复称呼', $3, 'active',
        1, 1, NULL, NULL, NULL, 'create', 'migration', 'legacy', $4
      )`,
      duplicateId,
      workspaceJid,
      memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      '2026-01-01T00:00:00.000Z',
    );
    await memoryRun(
      `INSERT INTO workspace_memory_provenance (
        item_id, revision, source_type, source_id, session_id, observed_at,
        recorded_at
      ) VALUES ($1, 1, 'migration', 'legacy', NULL, NULL, $2)`,
      duplicateId,
      '2026-01-01T00:00:00.000Z',
    );
    const raw = rawDatabase();
    raw
      .prepare(
        `UPDATE router_state
       SET value = '65'
       WHERE key = 'schema_version'`,
      )
      .run();
    raw.close();

    await restartDatabase();

    const rows = await reservedRows(workspaceJid);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(
      (
        await memoryRows(
          `SELECT canonical_key, status, revision
           FROM workspace_memory_items
           WHERE id = $1`,
          duplicateId,
        )
      )[0],
    ).toMatchObject({
      canonical_key: null,
      status: 'superseded',
      revision: 2,
    });
    expect(
      await memoryRows(
        `SELECT COUNT(*)::int AS count
         FROM workspace_memory_versions
         WHERE item_id = $1`,
        duplicateId,
      ),
    ).toEqual([{ count: 2 }]);
    expect(
      await ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({ preferredAddress: '当前称呼' });
    const invariant = await memoryRows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = 'workspace_memory_items'
         AND indexname = 'idx_workspace_memory_owner_address_unique'`,
    );
    expect(invariant).toHaveLength(1);
    expect(invariant[0].indexdef).toContain('WHERE');

    await expect(
      memoryService.getWorkspaceMemory({
        actor,
        workspaceJid,
        itemId: duplicateId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (
        await memoryService.listWorkspaceMemory({
          actor,
          workspaceJid,
          status: 'superseded',
        })
      ).items.map((item) => item.id),
    ).not.toContain(duplicateId);
    expect(
      (
        await memoryService.searchWorkspaceMemory({
          actor,
          workspaceJid,
          query: '旧重复称呼',
        })
      ).hits,
    ).toEqual([]);
    await expect(
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: duplicateId,
        expectedRevision: 2,
        content: 'generic update must not revive retired owner data',
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });
    await expect(
      memoryService.forgetWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: duplicateId,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'reserved_canonical_key' });
    await expect(
      memoryService.listWorkspaceMemoryVersions({
        actor,
        workspaceJid,
        itemId: duplicateId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await expect(
      memoryRun(
        `INSERT INTO workspace_memory_items (
          id, store_id, workspace_jid, kind, content, canonical_key, status,
          importance, confidence, revision, created_at, updated_at
        ) VALUES ($1, $2, $3, 'fact', 'illegal duplicate', $4, 'active',
          1, 1, 1, $5, $5)`,
        'wmi_owner_profile_illegal_duplicate',
        current.store_id,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        '2026-07-28T14:00:00.000Z',
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint/);

    const onceOnlySnapshot = {
      item: (
        await memoryRows(
          `SELECT canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = $1`,
          duplicateId,
        )
      )[0],
      onboarding: ownerOnboardingRow(workspaceJid),
      artifacts: await itemArtifacts(duplicateId),
    };

    await restartDatabase();

    expect({
      item: (
        await memoryRows(
          `SELECT canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = $1`,
          duplicateId,
        )
      )[0],
      onboarding: ownerOnboardingRow(workspaceJid),
      artifacts: await itemArtifacts(duplicateId),
    }).toEqual(onceOnlySnapshot);
  });

  test('legacy generic idempotency replay records cannot disclose the reserved item', async () => {
    const workspaceJid = createWorkspace('legacy-idempotency-replay');
    await ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '绝不能由 generic replay 返回',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const item = (
      await memoryRows<{ id: string; store_id: string; revision: number }>(
        `SELECT id, store_id, revision
         FROM workspace_memory_items
         WHERE workspace_jid = $1 AND canonical_key = $2`,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      )
    )[0];
    const createIdempotencyKey = 'legacy-generic-create-replay';
    const updateIdempotencyKey = 'legacy-generic-update-replay';
    const forgetIdempotencyKey = 'legacy-generic-forget-replay';
    const updatePatch = { content: 'generic replay update' };
    const updateHash = requestHash({
      itemId: item.id,
      expectedRevision: item.revision,
      patch: updatePatch,
    });
    const forgetHash = requestHash({
      itemId: item.id,
      expectedRevision: item.revision,
      reason: null,
    });
    await memoryRun(
      `UPDATE workspace_memory_items
       SET create_idempotency_key = $1, create_request_hash = NULL
       WHERE id = $2`,
      createIdempotencyKey,
      item.id,
    );
    const leakedReplay = JSON.stringify({
      store: { id: item.store_id, workspaceJid, revision: 1 },
      item: {
        id: item.id,
        workspaceJid,
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        content: '绝不能由 generic replay 返回',
        revision: item.revision,
      },
    });
    await memoryRun(
      `INSERT INTO workspace_memory_mutation_requests (
        store_id, idempotency_key, operation, item_id, request_hash,
        response_json, created_at
      ) VALUES
        ($1, $2, 'update', $3, $4, $5, $6),
        ($7, $8, 'forget', $9, $10, $11, $12)`,
      item.store_id,
      updateIdempotencyKey,
      item.id,
      updateHash,
      leakedReplay,
      '2026-07-28T15:00:00.000Z',
      item.store_id,
      forgetIdempotencyKey,
      item.id,
      forgetHash,
      leakedReplay,
      '2026-07-28T15:00:00.000Z',
    );

    const storeOperations = [
      () =>
        memoryStore.createWorkspaceMemoryItem({
          workspaceJid,
          value: {
            kind: 'fact',
            content: 'ordinary generic create replay',
          },
          context: mutationContext(),
          idempotencyKey: createIdempotencyKey,
          requestHash: 'any-create-hash',
        }),
      () =>
        memoryStore.updateWorkspaceMemoryItem({
          workspaceJid,
          itemId: item.id,
          expectedRevision: item.revision,
          patch: updatePatch,
          context: mutationContext(),
          idempotencyKey: updateIdempotencyKey,
          requestHash: updateHash,
        }),
      () =>
        memoryStore.forgetWorkspaceMemoryItem({
          workspaceJid,
          itemId: item.id,
          expectedRevision: item.revision,
          context: mutationContext(),
          idempotencyKey: forgetIdempotencyKey,
          requestHash: forgetHash,
        }),
    ];
    for (const operation of storeOperations) {
      await expect(operation()).rejects.toMatchObject({
        code: 'reserved_canonical_key',
      });
    }

    const actor = { id: OWNER_ID, role: 'member' as const };
    const serviceOperations = [
      () =>
        memoryService.createWorkspaceMemory({
          actor,
          workspaceJid,
          sourceType: 'web_user',
          kind: 'fact',
          content: 'ordinary generic create replay',
          idempotencyKey: createIdempotencyKey,
        }),
      () =>
        memoryService.updateWorkspaceMemory({
          actor,
          workspaceJid,
          sourceType: 'web_user',
          itemId: item.id,
          expectedRevision: item.revision,
          content: updatePatch.content,
          idempotencyKey: updateIdempotencyKey,
        }),
      () =>
        memoryService.forgetWorkspaceMemory({
          actor,
          workspaceJid,
          sourceType: 'web_user',
          itemId: item.id,
          expectedRevision: item.revision,
          idempotencyKey: forgetIdempotencyKey,
        }),
    ];
    for (const operation of serviceOperations) {
      await expect(operation()).rejects.toMatchObject({
        code: 'reserved_canonical_key',
      });
    }

    expect(await reservedRows(workspaceJid)).toMatchObject([
      {
        id: item.id,
        content: '绝不能由 generic replay 返回',
        status: 'active',
        revision: 1,
      },
    ]);
    expect(
      await memoryRows(
        'SELECT COUNT(*)::int AS count FROM workspace_memory_versions WHERE item_id = $1',
        item.id,
      ),
    ).toEqual([{ count: 1 }]);
  });
});
