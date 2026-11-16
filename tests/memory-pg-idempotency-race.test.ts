import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pg-idempotency-'));
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
const memoryStore = await import('../src/memory-store.js');

const JID = 'web:idempotency-workspace';
const AT = '2026-05-01T00:00:00.000Z';
const context = {
  actorId: 'idempotency-owner',
  sourceType: 'web_user' as const,
  sourceId: 'idempotency-source',
  sessionId: 'idempotency-session',
};

/** Run a single DDL statement on the Memory database. */
async function memoryExec(sql: string): Promise<void> {
  await memoryStore.queryWorkspaceMemoryStoreDatabase(sql);
}

/**
 * Fail the next INSERT into `table` with a real PostgreSQL unique violation
 * (SQLSTATE 23505) exactly once.
 *
 * PGlite serves one serialized connection, so two transactions can never race
 * here. A sequence guard reproduces the part that matters: the loser of the
 * race sees 23505 after its transaction rolled back and must retry instead of
 * returning 500. `nextval` is not rolled back, so only the first insert fails.
 */
async function failNextInsertOnce(table: string, name: string): Promise<void> {
  await memoryExec(`CREATE SEQUENCE ${name}_seq`);
  await memoryExec(`
    CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF nextval('${name}_seq') = 1 THEN
        RAISE EXCEPTION 'simulated idempotency race'
          USING ERRCODE = '23505';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await memoryExec(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table}
     FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
}

async function insertAttempts(name: string): Promise<number> {
  const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
    last_value: number;
    is_called: boolean;
  }>(`SELECT last_value, is_called FROM ${name}_seq`);
  const row = result.rows[0];
  return row.is_called ? Number(row.last_value) : 0;
}

async function removeInsertFailure(table: string, name: string): Promise<void> {
  await memoryExec(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
  await memoryExec(`DROP FUNCTION IF EXISTS ${name}()`);
  await memoryExec(`DROP SEQUENCE IF EXISTS ${name}_seq`);
}

beforeAll(async () => {
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Idempotency workspace',
    folder: 'idempotency-workspace',
    added_at: AT,
    created_by: 'idempotency-owner',
    is_home: false,
  } as never);
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('idempotency replay under concurrency', () => {
  test('a repeated create replays the committed row instead of inserting twice', async () => {
    const first = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'fact', content: '幂等创建只应写入一次' },
      context,
      idempotencyKey: 'create-key-1',
      requestHash: 'hash-create-1',
    });
    expect(first.replayed).toBe(false);

    const replay = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'fact', content: '幂等创建只应写入一次' },
      context,
      idempotencyKey: 'create-key-1',
      requestHash: 'hash-create-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.item.id).toBe(first.item.id);

    // The same key with a different payload is a conflict, not a second item.
    await expect(
      memoryStore.createWorkspaceMemoryItem({
        workspaceJid: JID,
        value: { kind: 'fact', content: '另一个请求体' },
        context,
        idempotencyKey: 'create-key-1',
        requestHash: 'hash-create-1-different',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const items = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid: JID,
      limit: 50,
    });
    expect(
      items.items.filter((item) => item.content === '幂等创建只应写入一次'),
    ).toHaveLength(1);
  });

  test('a repeated update replays the first response and keeps one revision', async () => {
    const created = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'decision', content: '原始内容' },
      context,
    });

    const update = await memoryStore.updateWorkspaceMemoryItem({
      workspaceJid: JID,
      itemId: created.item.id,
      expectedRevision: created.item.revision,
      patch: { content: '更新后的内容' },
      context,
      idempotencyKey: 'update-key-1',
      requestHash: 'hash-update-1',
    });

    const replay = await memoryStore.updateWorkspaceMemoryItem({
      workspaceJid: JID,
      itemId: created.item.id,
      // A retry may arrive with a stale expectedRevision; the idempotency
      // record must win over the CAS check.
      expectedRevision: created.item.revision,
      patch: { content: '更新后的内容' },
      context,
      idempotencyKey: 'update-key-1',
      requestHash: 'hash-update-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.item.revision).toBe(update.item.revision);

    await expect(
      memoryStore.updateWorkspaceMemoryItem({
        workspaceJid: JID,
        itemId: created.item.id,
        expectedRevision: update.item.revision,
        patch: { content: '不同请求体' },
        context,
        idempotencyKey: 'update-key-1',
        requestHash: 'hash-update-1-different',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('a repeated forget replays instead of double-deleting', async () => {
    const created = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'lesson', content: '即将被忘记' },
      context,
    });

    const forget = await memoryStore.forgetWorkspaceMemoryItem({
      workspaceJid: JID,
      itemId: created.item.id,
      expectedRevision: created.item.revision,
      context,
      idempotencyKey: 'forget-key-1',
      requestHash: 'hash-forget-1',
    });
    const replay = await memoryStore.forgetWorkspaceMemoryItem({
      workspaceJid: JID,
      itemId: created.item.id,
      expectedRevision: created.item.revision,
      context,
      idempotencyKey: 'forget-key-1',
      requestHash: 'hash-forget-1',
    });

    expect(replay.replayed).toBe(true);
    expect(replay.item.revision).toBe(forget.item.revision);
    await expect(
      memoryStore.forgetWorkspaceMemoryItem({
        workspaceJid: JID,
        itemId: created.item.id,
        expectedRevision: created.item.revision,
        context,
        idempotencyKey: 'forget-key-1',
        requestHash: 'hash-forget-1-different',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  test('the Owner Profile reserved mutation replays on a repeated set', async () => {
    const first = await memoryStore.mutateCommerceAgentOwnerAddressMemory({
      workspaceJid: JID,
      preferredAddress: '老板',
      context,
      idempotencyKey: 'owner-key-1',
      requestHash: 'hash-owner-1',
    });
    expect(first.replayed).toBe(false);

    const replay = await memoryStore.mutateCommerceAgentOwnerAddressMemory({
      workspaceJid: JID,
      preferredAddress: '老板',
      context,
      idempotencyKey: 'owner-key-1',
      requestHash: 'hash-owner-1',
    });
    expect(replay.replayed).toBe(true);
    expect(replay.item.id).toBe(first.item.id);
  });

  test('a create that loses the race retries instead of failing with 23505', async () => {
    await failNextInsertOnce('workspace_memory_items', 'race_create_guard');
    try {
      const result = await memoryStore.createWorkspaceMemoryItem({
        workspaceJid: JID,
        value: { kind: 'fact', content: '竞态失败后重试仍然成功' },
        context,
        idempotencyKey: 'create-key-race',
        requestHash: 'hash-create-race',
      });
      expect(result.replayed).toBe(false);
      // Two insert attempts: the injected failure, then the successful retry.
      await expect(insertAttempts('race_create_guard')).resolves.toBe(2);
    } finally {
      await removeInsertFailure('workspace_memory_items', 'race_create_guard');
    }

    const stored = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid: JID,
      query: '竞态失败后重试仍然成功',
      limit: 10,
    });
    expect(stored.hits.map((hit) => hit.item.content)).toEqual([
      '竞态失败后重试仍然成功',
    ]);
  });

  test('an update that loses the race retries instead of failing with 23505', async () => {
    const created = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: { kind: 'fact', content: '竞态更新之前' },
      context,
    });
    await failNextInsertOnce(
      'workspace_memory_mutation_requests',
      'race_update_guard',
    );
    try {
      const updated = await memoryStore.updateWorkspaceMemoryItem({
        workspaceJid: JID,
        itemId: created.item.id,
        expectedRevision: created.item.revision,
        patch: { content: '竞态更新之后' },
        context,
        idempotencyKey: 'update-key-race',
        requestHash: 'hash-update-race',
      });
      expect(updated.replayed).toBe(false);
      expect(updated.item.content).toBe('竞态更新之后');
      // The failed attempt rolled back, so exactly one revision was added.
      expect(updated.item.revision).toBe(created.item.revision + 1);
      await expect(insertAttempts('race_update_guard')).resolves.toBe(2);
    } finally {
      await removeInsertFailure(
        'workspace_memory_mutation_requests',
        'race_update_guard',
      );
    }
  });
});

describe('withIdempotencyRaceRecovery', () => {
  function uniqueViolation(): Error {
    return Object.assign(
      new Error('duplicate key value violates unique constraint'),
      {
        code: '23505',
      },
    );
  }

  test('retries once after a unique violation', async () => {
    let calls = 0;
    const value = await memoryStore.withIdempotencyRaceRecovery(
      'key',
      async () => {
        calls += 1;
        if (calls === 1) throw uniqueViolation();
        return 'recovered';
      },
    );
    expect(value).toBe('recovered');
    expect(calls).toBe(2);
  });

  test('does not retry without an idempotency key', async () => {
    let calls = 0;
    await expect(
      memoryStore.withIdempotencyRaceRecovery(null, async () => {
        calls += 1;
        throw uniqueViolation();
      }),
    ).rejects.toMatchObject({ code: '23505' });
    expect(calls).toBe(1);
  });

  test('does not retry unrelated database errors', async () => {
    let calls = 0;
    const failure = Object.assign(new Error('foreign key violation'), {
      code: '23503',
    });
    await expect(
      memoryStore.withIdempotencyRaceRecovery('key', async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});
