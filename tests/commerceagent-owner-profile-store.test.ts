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

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function reservedRows(raw: Database.Database, workspaceJid: string) {
  return raw
    .prepare(
      `SELECT id, content, status, revision, created_at, updated_at
       FROM workspace_memory_items
       WHERE workspace_jid = ? AND canonical_key = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(
      workspaceJid,
      memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    ) as Array<{
    id: string;
    content: string;
    status: string;
    revision: number;
    created_at: string;
    updated_at: string;
  }>;
}

beforeAll(() => {
  db.initDatabase();
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

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CommerceAgent owner preferred-address facade', () => {
  test('set is no-op aware, updates with CAS, clears, and restores without losing history', () => {
    const workspaceJid = createWorkspace('lifecycle');

    const empty = ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(empty).toMatchObject({
      workspaceJid,
      preferredAddress: null,
      revision: null,
      onboarding: { state: 'pending' },
    });

    const created = ownerProfile.setCommerceAgentOwnerPreferredAddress({
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

    const raw = rawDatabase();
    const canonicalAfterCreate = reservedRows(raw, workspaceJid);
    expect(canonicalAfterCreate).toHaveLength(1);
    const firstItemId = canonicalAfterCreate[0].id;
    const countsAfterCreate = raw
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM workspace_memory_versions WHERE item_id = ?) AS versions,
          (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE item_id = ?) AS audits,
          (SELECT COUNT(*) FROM workspace_memory_outbox WHERE item_id = ?) AS outbox`,
      )
      .get(firstItemId, firstItemId, firstItemId) as {
      versions: number;
      audits: number;
      outbox: number;
    };
    expect(countsAfterCreate).toEqual({ versions: 1, audits: 1, outbox: 1 });

    const noOp = ownerProfile.setCommerceAgentOwnerPreferredAddress({
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
      raw
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_memory_versions WHERE item_id = ?',
        )
        .get(firstItemId),
    ).toEqual({ count: 1 });

    const updated = ownerProfile.setCommerceAgentOwnerPreferredAddress({
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
    expect(reservedRows(raw, workspaceJid)).toMatchObject([
      { id: firstItemId, content: '何先生', status: 'active', revision: 2 },
    ]);
    expect(
      raw
        .prepare(
          `SELECT actor_id
           FROM workspace_memory_versions
           WHERE item_id = ? AND revision = 2`,
        )
        .get(firstItemId),
    ).toEqual({ actor_id: ACTUAL_SENDER_ID });
    expect(
      raw
        .prepare(
          `SELECT source_id, session_id
           FROM workspace_memory_provenance
           WHERE item_id = ? AND revision = 2`,
        )
        .get(firstItemId),
    ).toEqual({
      source_id: `message-from-${ACTUAL_SENDER_ID}`,
      session_id: `session-for-${ACTUAL_SENDER_ID}`,
    });

    const cleared = ownerProfile.clearCommerceAgentOwnerPreferredAddress({
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
    expect(reservedRows(raw, workspaceJid)).toMatchObject([
      { id: firstItemId, status: 'superseded', revision: 3 },
    ]);

    // Clearing the value is not an instruction to repeat first-wake.
    const postClearClaim = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

    const restored = ownerProfile.setCommerceAgentOwnerPreferredAddress({
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
    const allRows = reservedRows(raw, workspaceJid);
    expect(allRows).toHaveLength(1);
    expect(allRows[0]).toMatchObject({
      id: firstItemId,
      status: 'active',
      revision: 4,
    });
    expect(allRows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(
      raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_memory_versions
           WHERE item_id IN (
             SELECT id FROM workspace_memory_items
             WHERE workspace_jid = ? AND canonical_key = ?
           )`,
        )
        .get(
          workspaceJid,
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        ),
    ).toEqual({ count: 4 });
    raw.close();
  });

  test('stale set and clear compare-and-swap attempts preserve the winner', () => {
    const workspaceJid = createWorkspace('cas');
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '第一版',
      context: mutationContext(),
    });
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
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
      expect(operation).toThrowError(
        expect.objectContaining({ code: 'revision_conflict' }),
      );
    }
    expect(
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({ preferredAddress: '获胜版本', revision: 2 });
  });

  test('replays a retried first set without creating another revision', () => {
    const workspaceJid = createWorkspace('first-set-idempotency');
    const request = {
      workspaceJid,
      preferredAddress: '幂等称呼',
      expectedRevision: 0,
      idempotencyKey: 'owner-profile-first-set',
      context: mutationContext(),
    };
    const first = ownerProfile.setCommerceAgentOwnerPreferredAddress(request);
    const replay = ownerProfile.setCommerceAgentOwnerPreferredAddress(request);
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

    const raw = rawDatabase();
    const item = reservedRows(raw, workspaceJid)[0];
    expect(
      raw
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_memory_versions WHERE item_id = ?',
        )
        .get(item.id),
    ).toEqual({ count: 1 });
    raw.close();

    expect(() =>
      ownerProfile.setCommerceAgentOwnerPreferredAddress({
        ...request,
        preferredAddress: '复用 key 的不同请求',
      }),
    ).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }));
  });

  test('projection is read-through on both cold and already-warm callers', () => {
    const workspaceJid = createWorkspace('projection-refresh');
    const cold = ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(cold.preferredAddress).toBeNull();

    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '冷启动称呼',
      context: mutationContext(),
    });
    const firstWarm =
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(firstWarm).toMatchObject({
      preferredAddress: '冷启动称呼',
      revision: 1,
    });

    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '热会话刷新称呼',
      expectedRevision: 1,
      context: mutationContext(),
    });
    const refreshed =
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(refreshed).toMatchObject({
      preferredAddress: '热会话刷新称呼',
      revision: 2,
    });
    expect(refreshed).not.toBe(firstWarm);
  });

  test('restores a legacy deleted reserved item on the same revision lineage', () => {
    const workspaceJid = createWorkspace('legacy-deleted-restore');
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '删除前称呼',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const raw = rawDatabase();
    const item = reservedRows(raw, workspaceJid)[0];
    const deletedAt = '2026-07-28T11:00:00.000Z';
    raw
      .prepare(
        `UPDATE workspace_memory_items
       SET status = 'deleted', revision = 2, updated_at = ?, deleted_at = ?
       WHERE id = ?`,
      )
      .run(deletedAt, deletedAt, item.id);
    raw
      .prepare(
        `INSERT INTO workspace_memory_versions (
        item_id, revision, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        change_type, actor_type, actor_id, created_at
      ) VALUES (
        ?, 2, ?, 'fact', '主人称呼', '删除前称呼', ?, 'deleted',
        1, 1, NULL, NULL, NULL, 'forget', 'migration', 'legacy-delete', ?
      )`,
      )
      .run(
        item.id,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        deletedAt,
      );
    raw
      .prepare(
        `INSERT INTO workspace_memory_provenance (
        item_id, revision, source_type, source_id, session_id, observed_at,
        recorded_at
      ) VALUES (?, 2, 'migration', 'legacy-delete', NULL, NULL, ?)`,
      )
      .run(item.id, deletedAt);
    raw
      .prepare(
        `INSERT INTO workspace_memory_tombstones (
        item_id, workspace_jid, deleted_revision, reason, actor_type, actor_id,
        deleted_at
      ) VALUES (?, ?, 2, 'legacy clear', 'migration', 'legacy-delete', ?)`,
      )
      .run(item.id, workspaceJid, deletedAt);
    raw.close();

    const restored = ownerProfile.setCommerceAgentOwnerPreferredAddress({
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

    const verified = rawDatabase();
    expect(reservedRows(verified, workspaceJid)).toMatchObject([
      {
        id: item.id,
        content: '恢复后的称呼',
        status: 'active',
        revision: 3,
      },
    ]);
    expect(
      verified
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_memory_versions WHERE item_id = ?',
        )
        .get(item.id),
    ).toEqual({ count: 3 });
    expect(
      verified
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_memory_tombstones WHERE item_id = ?',
        )
        .get(item.id),
    ).toEqual({ count: 0 });
    verified.close();
  });
});

describe('CommerceAgent owner introduction onboarding state', () => {
  test('claims first wake without consuming it until a fenced acknowledgement', () => {
    const workspaceJid = createWorkspace('onboarding-lease');
    const now = '2026-07-28T12:00:00.000Z';
    const first = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

    const sameRunnerBeforeAck = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

    const contending = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

    const reclaimed = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

    expect(() =>
      ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-a',
        leaseToken: reclaimed.leaseToken!,
        now: '2026-07-28T12:01:17.000Z',
      }),
    ).toThrow('lease no longer matches');
    expect(() =>
      ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-b',
        leaseToken: first.leaseToken!,
        now: '2026-07-28T12:01:17.000Z',
      }),
    ).toThrow('lease no longer matches');

    const acknowledged = ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
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
      ownerProfile.acknowledgeCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-b',
        leaseToken: reclaimed.leaseToken!,
        now: '2026-07-28T12:01:18.000Z',
      }),
    ).toMatchObject({ acknowledged: false });

    const skipped = ownerProfile.skipCommerceAgentOwnerIntroduction({
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
      ownerProfile.claimCommerceAgentOwnerIntroduction({
        workspaceJid,
        leaseOwner: 'session-c',
        now: '2026-07-28T13:00:00.000Z',
      }),
    ).toMatchObject({
      claimed: false,
      projection: { onboarding: { state: 'skipped' } },
    });
  });

  test('runner exit releases an unacknowledged lease without consuming first wake', () => {
    const workspaceJid = createWorkspace('onboarding-release');
    const first = ownerProfile.claimCommerceAgentOwnerIntroduction({
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
    const retry = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

  test('normal database restart does not consume an unacknowledged first wake', () => {
    const workspaceJid = createWorkspace('onboarding-restart');
    const first = ownerProfile.claimCommerceAgentOwnerIntroduction({
      workspaceJid,
      leaseOwner: 'restart-runner',
      leaseMs: 60_000,
      now: '2026-07-28T12:00:00.000Z',
    });
    expect(first).toMatchObject({ firstWake: true, leaseToken: 1 });

    db.closeDatabase();
    db.initDatabase();

    const resumed = ownerProfile.claimCommerceAgentOwnerIntroduction({
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

  test('backfills first wake for pre-release v66 claimed rows without consuming it for fresh pending rows', () => {
    const historicalWorkspaceJid = createWorkspace(
      'pre-release-v66-first-wake',
    );
    const original = ownerProfile.claimCommerceAgentOwnerIntroduction({
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
      ownerProfile.getCommerceAgentOwnerProfileProjection(historicalWorkspaceJid);
    expect(historicalProjection.onboarding).toMatchObject({
      state: 'claimed',
      leaseToken: 1,
      firstWakeAt: '2026-07-28T12:00:00.000Z',
    });
    const reclaimed = ownerProfile.claimCommerceAgentOwnerIntroduction({
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
    const fresh = ownerProfile.claimCommerceAgentOwnerIntroduction({
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
  test('does not mistake an address containing a legacy sentinel phrase for the sentinel itself', () => {
    const workspaceJid = createWorkspace('legacy-sentinel-substring');
    const legitimateAddress = '小何（不愿提供英文名）';
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: legitimateAddress,
      expectedRevision: 0,
      context: mutationContext(),
    });

    const raw = rawDatabase();
    const item = reservedRows(raw, workspaceJid)[0];
    const before = {
      item: raw
        .prepare(
          `SELECT content, status, revision
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(item.id),
      versions: raw
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_memory_versions
           WHERE item_id = ?`,
        )
        .get(item.id),
    };
    raw
      .prepare(
        `DELETE FROM workspace_onboarding_states
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .run(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY);
    raw
      .prepare(
        `UPDATE router_state
         SET value = '65'
         WHERE key = 'schema_version'`,
      )
      .run();
    raw.close();

    db.closeDatabase();
    db.initDatabase();

    expect(
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: legitimateAddress,
      revision: 1,
      onboarding: { state: 'completed' },
    });
    const verified = rawDatabase();
    expect({
      item: verified
        .prepare(
          `SELECT content, status, revision
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(item.id),
      versions: verified
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_memory_versions
           WHERE item_id = ?`,
        )
        .get(item.id),
    }).toEqual(before);
    verified.close();
  });

  test('matches the exact legacy skip sentinel once and preserves skipped across later starts', () => {
    const workspaceJid = createWorkspace('legacy-exact-sentinel');
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '主人不愿提供称呼',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const legacy = rawDatabase();
    const item = reservedRows(legacy, workspaceJid)[0];
    legacy
      .prepare(
        `DELETE FROM workspace_onboarding_states
         WHERE workspace_jid = ? AND flow_key = ?`,
      )
      .run(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY);
    legacy
      .prepare(
        `UPDATE router_state
         SET value = '65'
         WHERE key = 'schema_version'`,
      )
      .run();
    legacy.close();

    db.closeDatabase();
    db.initDatabase();

    expect(
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: null,
      revision: 2,
      onboarding: { state: 'skipped' },
    });
    const migrated = rawDatabase();
    expect(reservedRows(migrated, workspaceJid)).toMatchObject([
      { id: item.id, status: 'superseded', revision: 2 },
    ]);
    const onceOnlySnapshot = {
      item: migrated
        .prepare(
          `SELECT content, canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(item.id),
      onboarding: migrated
        .prepare(
          `SELECT state, revision, skipped_at, updated_at
           FROM workspace_onboarding_states
           WHERE workspace_jid = ? AND flow_key = ?`,
        )
        .get(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY),
      artifacts: migrated
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM workspace_memory_versions WHERE item_id = ?) AS versions,
            (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE item_id = ?) AS audits,
            (SELECT COUNT(*) FROM workspace_memory_outbox WHERE item_id = ?) AS outbox`,
        )
        .get(item.id, item.id, item.id),
    };
    migrated.close();

    db.closeDatabase();
    db.initDatabase();

    expect(
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({
      preferredAddress: null,
      revision: 2,
      onboarding: { state: 'skipped' },
    });
    const restarted = rawDatabase();
    expect({
      item: restarted
        .prepare(
          `SELECT content, canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(item.id),
      onboarding: restarted
        .prepare(
          `SELECT state, revision, skipped_at, updated_at
           FROM workspace_onboarding_states
           WHERE workspace_jid = ? AND flow_key = ?`,
        )
        .get(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY),
      artifacts: restarted
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM workspace_memory_versions WHERE item_id = ?) AS versions,
            (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE item_id = ?) AS audits,
            (SELECT COUNT(*) FROM workspace_memory_outbox WHERE item_id = ?) AS outbox`,
        )
        .get(item.id, item.id, item.id),
    }).toEqual(onceOnlySnapshot);
    restarted.close();
  });
});

describe('reserved canonical-key integrity', () => {
  test('generic memory mutations fail closed for the owner-profile key', () => {
    const workspaceJid = createWorkspace('reserved-deny');
    const actor = { id: OWNER_ID, role: 'member' as const };

    expect(() =>
      memoryService.createWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        kind: 'fact',
        content: 'generic create must not own this key',
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));

    const dedicated = ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '专用接口写入',
      context: mutationContext(),
    });
    const raw = rawDatabase();
    const itemId = reservedRows(raw, workspaceJid)[0].id;
    raw.close();

    expect(() =>
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId,
        expectedRevision: dedicated.projection.revision!,
        content: 'generic update must not mutate the reserved item',
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));
    expect(() =>
      memoryService.forgetWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId,
        expectedRevision: dedicated.projection.revision!,
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));

    const ordinary = memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'fact',
      content: 'ordinary memory',
    });
    expect(() =>
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: ordinary.item.id,
        expectedRevision: 1,
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));

    const projection =
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid);
    expect(projection).toMatchObject({
      preferredAddress: '专用接口写入',
      revision: 1,
    });

    expect(
      memoryService.listWorkspaceMemory({
        actor,
        workspaceJid,
        status: 'active',
      }).items,
    ).toEqual([expect.objectContaining({ id: ordinary.item.id })]);
    expect(
      memoryService.searchWorkspaceMemory({
        actor,
        workspaceJid,
        query: '专用接口写入',
      }).hits,
    ).toEqual([]);
    expect(() =>
      memoryService.listWorkspaceMemoryVersions({
        actor,
        workspaceJid,
        itemId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });

  test('legacy duplicates are reconciled before a partial unique index is enforced', () => {
    const workspaceJid = createWorkspace('legacy-reconcile');
    const actor = { id: OWNER_ID, role: 'member' as const };
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '当前称呼',
      context: mutationContext(),
    });

    const raw = rawDatabase();
    const uniqueIndexes = raw
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'workspace_memory_items'
           AND sql LIKE 'CREATE UNIQUE INDEX%'
           AND sql LIKE '%canonical_key%'`,
      )
      .all() as Array<{ name: string }>;
    for (const index of uniqueIndexes) {
      raw.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    }

    const current = raw
      .prepare(
        `SELECT *
         FROM workspace_memory_items
         WHERE workspace_jid = ? AND canonical_key = ?`,
      )
      .get(
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      ) as Record<string, unknown>;
    const duplicateId = 'wmi_owner_profile_legacy_duplicate';
    raw
      .prepare(
        `INSERT INTO workspace_memory_items (
        id, store_id, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        revision, create_idempotency_key, create_request_hash,
        created_at, updated_at, deleted_at
      ) VALUES (
        ?, ?, ?, 'fact', '主人称呼', '旧重复称呼', ?, 'active',
        1, 1, NULL, NULL, NULL, 1, NULL, NULL, ?, ?, NULL
      )`,
      )
      .run(
        duplicateId,
        current.store_id,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );
    raw
      .prepare(
        `INSERT INTO workspace_memory_versions (
        item_id, revision, workspace_jid, kind, title, content, canonical_key,
        status, importance, confidence, valid_from, valid_until, expires_at,
        change_type, actor_type, actor_id, created_at
      ) VALUES (
        ?, 1, ?, 'fact', '主人称呼', '旧重复称呼', ?, 'active',
        1, 1, NULL, NULL, NULL, 'create', 'migration', 'legacy', ?
      )`,
      )
      .run(
        duplicateId,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        '2026-01-01T00:00:00.000Z',
      );
    raw
      .prepare(
        `INSERT INTO workspace_memory_provenance (
        item_id, revision, source_type, source_id, session_id, observed_at,
        recorded_at
      ) VALUES (?, 1, 'migration', 'legacy', NULL, NULL, ?)`,
      )
      .run(duplicateId, '2026-01-01T00:00:00.000Z');
    raw
      .prepare(
        `INSERT INTO workspace_memory_fts (
          item_id, workspace_jid, title, content, canonical_key
        ) VALUES (?, ?, '主人称呼', '旧重复称呼', ?)`,
      )
      .run(
        duplicateId,
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      );
    raw
      .prepare(
        `UPDATE router_state
       SET value = '65'
       WHERE key = 'schema_version'`,
      )
      .run();
    raw.close();

    db.closeDatabase();
    db.initDatabase();

    const verified = rawDatabase();
    const rows = reservedRows(verified, workspaceJid);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(
      verified
        .prepare(
          `SELECT canonical_key, status, revision
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(duplicateId),
    ).toMatchObject({
      canonical_key: null,
      status: 'superseded',
      revision: 2,
    });
    expect(
      verified
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_memory_versions
           WHERE item_id = ?`,
        )
        .get(duplicateId),
    ).toEqual({ count: 2 });
    expect(
      ownerProfile.getCommerceAgentOwnerProfileProjection(workspaceJid),
    ).toMatchObject({ preferredAddress: '当前称呼' });
    const invariant = verified
      .prepare(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'index'
           AND tbl_name = 'workspace_memory_items'
           AND sql LIKE 'CREATE UNIQUE INDEX%'
           AND sql LIKE '%canonical_key%'`,
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(invariant.some((index) => index.sql.includes('WHERE'))).toBe(true);

    expect(() =>
      memoryService.getWorkspaceMemory({
        actor,
        workspaceJid,
        itemId: duplicateId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));
    expect(
      memoryService
        .listWorkspaceMemory({
          actor,
          workspaceJid,
          status: 'superseded',
        })
        .items.map((item) => item.id),
    ).not.toContain(duplicateId);
    expect(
      memoryService.searchWorkspaceMemory({
        actor,
        workspaceJid,
        query: '旧重复称呼',
      }).hits,
    ).toEqual([]);
    expect(() =>
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: duplicateId,
        expectedRevision: 2,
        content: 'generic update must not revive retired owner data',
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));
    expect(() =>
      memoryService.forgetWorkspaceMemory({
        actor,
        workspaceJid,
        sourceType: 'web_user',
        itemId: duplicateId,
        expectedRevision: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'reserved_canonical_key' }));
    expect(() =>
      memoryService.listWorkspaceMemoryVersions({
        actor,
        workspaceJid,
        itemId: duplicateId,
      }),
    ).toThrowError(expect.objectContaining({ code: 'not_found' }));

    expect(() =>
      verified
        .prepare(
          `INSERT INTO workspace_memory_items (
            id, store_id, workspace_jid, kind, content, canonical_key, status,
            importance, confidence, revision, created_at, updated_at
          ) VALUES (?, ?, ?, 'fact', 'illegal duplicate', ?, 'active',
            1, 1, 1, ?, ?)`,
        )
        .run(
          'wmi_owner_profile_illegal_duplicate',
          current.store_id,
          workspaceJid,
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
          '2026-07-28T14:00:00.000Z',
          '2026-07-28T14:00:00.000Z',
        ),
    ).toThrow(/UNIQUE constraint failed/);

    const onceOnlySnapshot = {
      item: verified
        .prepare(
          `SELECT canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(duplicateId),
      onboarding: verified
        .prepare(
          `SELECT state, revision, updated_at
           FROM workspace_onboarding_states
           WHERE workspace_jid = ? AND flow_key = ?`,
        )
        .get(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY),
      artifacts: verified
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM workspace_memory_versions WHERE item_id = ?) AS versions,
            (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE item_id = ?) AS audits,
            (SELECT COUNT(*) FROM workspace_memory_outbox WHERE item_id = ?) AS outbox`,
        )
        .get(duplicateId, duplicateId, duplicateId),
    };
    verified.close();

    db.closeDatabase();
    db.initDatabase();
    const restarted = rawDatabase();
    expect({
      item: restarted
        .prepare(
          `SELECT canonical_key, status, revision, updated_at
           FROM workspace_memory_items
           WHERE id = ?`,
        )
        .get(duplicateId),
      onboarding: restarted
        .prepare(
          `SELECT state, revision, updated_at
           FROM workspace_onboarding_states
           WHERE workspace_jid = ? AND flow_key = ?`,
        )
        .get(workspaceJid, ownerProfile.COMMERCEAGENT_OWNER_INTRODUCTION_FLOW_KEY),
      artifacts: restarted
        .prepare(
          `SELECT
            (SELECT COUNT(*) FROM workspace_memory_versions WHERE item_id = ?) AS versions,
            (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE item_id = ?) AS audits,
            (SELECT COUNT(*) FROM workspace_memory_outbox WHERE item_id = ?) AS outbox`,
        )
        .get(duplicateId, duplicateId, duplicateId),
    }).toEqual(onceOnlySnapshot);
    restarted.close();
  });

  test('legacy generic idempotency replay records cannot disclose the reserved item', () => {
    const workspaceJid = createWorkspace('legacy-idempotency-replay');
    ownerProfile.setCommerceAgentOwnerPreferredAddress({
      workspaceJid,
      preferredAddress: '绝不能由 generic replay 返回',
      expectedRevision: 0,
      context: mutationContext(),
    });

    const raw = rawDatabase();
    const item = raw
      .prepare(
        `SELECT id, store_id, revision
         FROM workspace_memory_items
         WHERE workspace_jid = ? AND canonical_key = ?`,
      )
      .get(
        workspaceJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      ) as { id: string; store_id: string; revision: number };
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
    raw
      .prepare(
        `UPDATE workspace_memory_items
       SET create_idempotency_key = ?, create_request_hash = NULL
       WHERE id = ?`,
      )
      .run(createIdempotencyKey, item.id);
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
    raw
      .prepare(
        `INSERT INTO workspace_memory_mutation_requests (
        store_id, idempotency_key, operation, item_id, request_hash,
        response_json, created_at
      ) VALUES
        (?, ?, 'update', ?, ?, ?, ?),
        (?, ?, 'forget', ?, ?, ?, ?)`,
      )
      .run(
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
    raw.close();

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
      expect(operation).toThrowError(
        expect.objectContaining({ code: 'reserved_canonical_key' }),
      );
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
      expect(operation).toThrowError(
        expect.objectContaining({ code: 'reserved_canonical_key' }),
      );
    }

    const verified = rawDatabase();
    expect(reservedRows(verified, workspaceJid)).toMatchObject([
      {
        id: item.id,
        content: '绝不能由 generic replay 返回',
        status: 'active',
        revision: 1,
      },
    ]);
    expect(
      verified
        .prepare(
          'SELECT COUNT(*) AS count FROM workspace_memory_versions WHERE item_id = ?',
        )
        .get(item.id),
    ).toEqual({ count: 1 });
    verified.close();
  });
});
