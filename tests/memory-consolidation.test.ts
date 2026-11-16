import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consolidation-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'CommerceAgent',
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const memoryStore = await import('../src/memory-store.js');
const consolidation = await import('../src/memory-consolidation/index.js');
const migrations = await import('../src/memory-pg/migrations/index.js');

/** Every workspace gets a fresh JID so tests never share a store. */
function workspace(name: string): string {
  return `web:consolidation-${name}`;
}

const NOW = new Date('2026-01-02T04:00:00.000Z');
const SETTINGS = {
  enabled: true,
  time: '03:30',
  batchSize: 50,
  maxRuntimeMs: 60_000,
};

const context = {
  actorId: 'alice',
  sourceType: 'web_user' as const,
};

async function seed(
  workspaceJid: string,
  value: {
    kind?: 'fact' | 'decision' | 'lesson' | 'open_loop';
    title?: string | null;
    content: string;
    canonicalKey?: string | null;
    importance?: number;
    expiresAt?: string | null;
    validUntil?: string | null;
    sessionId?: string | null;
  },
): Promise<memoryStore.WorkspaceMemoryItem> {
  const created = await memoryStore.createWorkspaceMemoryItem({
    workspaceJid,
    value: {
      kind: value.kind ?? 'fact',
      title: value.title ?? null,
      content: value.content,
      canonicalKey: value.canonicalKey ?? null,
      importance: value.importance,
      expiresAt: value.expiresAt ?? null,
      validUntil: value.validUntil ?? null,
    },
    context: { ...context, sessionId: value.sessionId ?? null },
  });
  return created.item;
}

async function database() {
  return await memoryStore.withWorkspaceMemoryDatabase((db) => db);
}

async function mergeOnce(
  workspaceJid: string,
  options: { limit?: number; now?: Date } = {},
) {
  const db = await database();
  const store = await memoryStore.getWorkspaceMemoryStore(workspaceJid);
  return await consolidation.mergeDuplicateBatch(db, {
    storeId: store!.id,
    workspaceJid,
    limit: options.limit ?? SETTINGS.batchSize,
    trigramAvailable: await consolidation.isTrigramSimilarityAvailable(db),
    now: options.now ?? NOW,
  });
}

async function item(
  workspaceJid: string,
  itemId: string,
): Promise<memoryStore.WorkspaceMemoryItem> {
  return (await memoryStore.getWorkspaceMemoryItem(workspaceJid, itemId)).item;
}

beforeAll(async () => {
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  delete process.env.MEMORY_DATABASE_URL;
  await memoryStore.closeWorkspaceMemoryStore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migration 004', () => {
  test('is idempotent and adds the pinned column', async () => {
    const db = await database();
    const sql = migrations.MEMORY_MIGRATIONS.find(
      (migration) => migration.version === 4,
    )!.sql;
    // The migration runner already applied it; running the SQL again must not
    // fail, which is what lets phase B's migration add the same column.
    await db.exec(sql);
    await db.exec(sql);
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'workspace_memory_items'
         AND column_name IN ('pinned', 'superseded_by', 'demoted_from_kind',
                             'demoted_at')
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'demoted_at',
      'demoted_from_kind',
      'pinned',
      'superseded_by',
    ]);
    const applied = await db.query<{ version: number }>(
      'SELECT version FROM workspace_memory_schema_migrations ORDER BY version',
    );
    expect(applied.rows.map((row) => Number(row.version))).toContain(4);
  });

  test('keeps provenance source types an earlier migration added', async () => {
    const db = await database();
    // Simulate a phase that extended the same check constraint in a migration
    // numbered before this one; 004 must add its own value without dropping it.
    await db.exec(`
      ALTER TABLE workspace_memory_provenance
        DROP CONSTRAINT IF EXISTS workspace_memory_provenance_source_type_check;
      ALTER TABLE workspace_memory_provenance
        ADD CONSTRAINT workspace_memory_provenance_source_type_check
        CHECK (source_type IN (
          'web_user', 'agent_runtime', 'scheduled_task', 'migration',
          'memory_extraction'
        ));
    `);
    const sql = migrations.MEMORY_MIGRATIONS.find(
      (migration) => migration.version === 4,
    )!.sql;
    await db.exec(sql);

    const definition = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       WHERE c.conrelid = 'workspace_memory_provenance'::regclass
         AND c.conname = 'workspace_memory_provenance_source_type_check'`,
    );
    expect(definition.rows[0].def).toContain('memory_extraction');
    expect(definition.rows[0].def).toContain('memory_consolidation');
    expect(definition.rows[0].def).toContain('web_user');
  });
});

describe('duplicate detection', () => {
  test('merges on canonical key and keeps the most important item', async () => {
    const ws = workspace('canonical');
    const low = await seed(ws, {
      content: '默认承运商是中通',
      canonicalKey: 'shop.carrier',
      importance: 0.4,
      sessionId: 'session-low',
    });
    const high = await seed(ws, {
      content: '默认承运商为顺丰',
      canonicalKey: 'shop.carrier',
      importance: 0.9,
      sessionId: 'session-high',
    });

    const result = await mergeOnce(ws);
    expect(result).toMatchObject({ scanned: 2, merged: 1, skippedGroups: 0 });

    const keeper = await item(ws, high.id);
    expect(keeper).toMatchObject({
      status: 'active',
      importance: 0.9,
      revision: 2,
      supersededBy: null,
    });
    const absorbed = await item(ws, low.id);
    expect(absorbed).toMatchObject({
      status: 'superseded',
      supersededBy: high.id,
      revision: 2,
    });

    const versions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid: ws,
      itemId: high.id,
      limit: 10,
    });
    expect(versions.versions.map((version) => version.changeType)).toEqual([
      'update',
      'create',
    ]);
    expect(versions.versions[0].actor).toEqual({
      type: 'memory_consolidation',
      id: 'memory-consolidation-worker',
    });

    const absorbedVersions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid: ws,
      itemId: low.id,
      limit: 10,
    });
    expect(absorbedVersions.versions[0]).toMatchObject({
      status: 'superseded',
      supersededBy: high.id,
      changeType: 'update',
    });

    // The merged sources survive: the loser's provenance is archived under the
    // keeper's merge revision, and the loser's own provenance still points at
    // the session that observed it.
    const db = await database();
    const sources = await db.query<{
      merged_item_id: string;
      source_type: string;
      session_id: string | null;
    }>(
      `SELECT merged_item_id, source_type, session_id
       FROM workspace_memory_merge_sources WHERE item_id = $1`,
      [high.id],
    );
    expect(sources.rows).toEqual([
      {
        merged_item_id: low.id,
        source_type: 'web_user',
        session_id: 'session-low',
      },
    ]);
    const loserProvenance = await db.query<{
      source_type: string;
      session_id: string | null;
    }>(
      `SELECT p.source_type, p.session_id
       FROM workspace_memory_provenance p
       WHERE p.item_id = $1 AND p.revision = 2`,
      [low.id],
    );
    expect(loserProvenance.rows[0]).toEqual({
      source_type: 'web_user',
      session_id: 'session-low',
    });
  });

  test('merges on normalized content regardless of case, spacing and punctuation', async () => {
    const ws = workspace('normalized');
    const first = await seed(ws, { content: '  Refund  Window: 7 days!! ' });
    const second = await seed(ws, { content: 'refund window 7 days' });

    const result = await mergeOnce(ws);
    expect(result.merged).toBe(1);
    const both = [await item(ws, first.id), await item(ws, second.id)];
    expect(both.filter((entry) => entry.status === 'active')).toHaveLength(1);
    const absorbed = both.find((entry) => entry.status === 'superseded')!;
    expect(absorbed.supersededBy).toBe(
      absorbed.id === first.id ? second.id : first.id,
    );
  });

  test('merges on trigram similarity only when titles match, and never below the threshold', async () => {
    const similarWorkspace = workspace('similar');
    const a = await seed(similarWorkspace, {
      title: '退款跟进',
      content: '退款到账后三日内发送确认邮件并同步客服群',
    });
    const b = await seed(similarWorkspace, {
      title: '退款跟进',
      content: '退款到账后三日内发送确认邮件并同步客服群里',
    });
    const result = await mergeOnce(similarWorkspace);
    expect(result.merged).toBe(1);
    const both = [
      await item(similarWorkspace, a.id),
      await item(similarWorkspace, b.id),
    ];
    expect(both.filter((entry) => entry.status === 'superseded')).toHaveLength(
      1,
    );

    // Same title, but the contents stay below the 0.85 threshold: no merge.
    const belowThreshold = workspace('below-threshold');
    await seed(belowThreshold, {
      title: '发货偏好',
      content: '店铺默认使用顺丰快递发货，偏远地区加收运费',
    });
    await seed(belowThreshold, {
      title: '发货偏好',
      content: '店铺默认使用顺丰快递发货，偏远地区加收10元运费',
    });
    expect((await mergeOnce(belowThreshold)).merged).toBe(0);

    // Same title, unrelated content: the similarity arm must not fire.
    const unrelated = workspace('dissimilar');
    await seed(unrelated, {
      title: '发货偏好',
      content: '端午活动满减门槛是199元',
    });
    await seed(unrelated, { title: '发货偏好', content: '退货地址在杭州仓' });
    expect((await mergeOnce(unrelated)).merged).toBe(0);

    // Similar enough content but different titles: no merge.
    const titled = workspace('titled');
    await seed(titled, {
      title: '退款跟进',
      content: '退款到账后三日内发送确认邮件并同步客服群',
    });
    await seed(titled, {
      title: '通知规范',
      content: '退款到账后三日内发送确认邮件并同步客服群里',
    });
    expect((await mergeOnce(titled)).merged).toBe(0);
  });

  test('skips a group whose rows changed after planning instead of overwriting it', async () => {
    const ws = workspace('cas');
    const keeper = await seed(ws, {
      content: '库存同步间隔是15分钟',
      canonicalKey: 'shop.stock.sync',
      importance: 0.9,
    });
    const absorbed = await seed(ws, {
      content: '库存同步间隔15分钟',
      canonicalKey: 'shop.stock.sync',
      importance: 0.2,
    });

    const db = await database();
    const store = await memoryStore.getWorkspaceMemoryStore(ws);
    const plan = await consolidation.planDuplicateGroups(db, {
      storeId: store!.id,
      workspaceJid: ws,
      limit: 50,
      trigramAvailable: true,
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].keeper.id).toBe(keeper.id);

    // A user edits the loser between planning and applying.
    await memoryStore.updateWorkspaceMemoryItem({
      workspaceJid: ws,
      itemId: absorbed.id,
      expectedRevision: 1,
      patch: { content: '库存同步间隔改成30分钟' },
      context,
    });

    const applied = await consolidation.applyMergeGroup(
      db,
      plan.groups[0],
      NOW.toISOString(),
    );
    expect(applied).toMatchObject({
      applied: false,
      reason: 'revision_conflict',
    });
    expect((await item(ws, absorbed.id)).status).toBe('active');
    expect((await item(ws, keeper.id)).revision).toBe(1);

    // The next pass sees the new content and retries the group cleanly.
    const retried = await mergeOnce(ws);
    expect(retried.merged).toBe(1);
    expect((await item(ws, absorbed.id)).status).toBe('superseded');
  });

  test('honours the per-batch item cap and converges over several batches', async () => {
    const ws = workspace('batch');
    for (const content of [
      '打包使用双层纸箱',
      '打包使用双层纸箱',
      '打包使用双层纸箱',
    ]) {
      await seed(ws, { content });
    }
    const first = await mergeOnce(ws, { limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.merged).toBe(1);
    const second = await mergeOnce(ws, { limit: 2 });
    expect(second.merged).toBe(1);
    const third = await mergeOnce(ws, { limit: 2 });
    expect(third.merged).toBe(0);

    const active = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid: ws,
      status: 'active',
      limit: 50,
    });
    expect(active.items).toHaveLength(1);
  });
});

describe('expiry demotion', () => {
  test('demotes an expired open_loop into a historical fact', async () => {
    const ws = workspace('open-loop');
    const openLoop = await seed(ws, {
      kind: 'open_loop',
      title: '跟进退款',
      content: '客户 3 天内未收到退款，需要跟进',
      importance: 0.8,
      expiresAt: '2025-12-01T00:00:00.000Z',
    });

    const db = await database();
    const store = await memoryStore.getWorkspaceMemoryStore(ws);
    const result = await consolidation.demoteExpiredBatch(db, {
      storeId: store!.id,
      limit: 50,
      now: NOW,
    });
    expect(result).toEqual({ scanned: 1, demoted: 1, skipped: 0 });

    const demoted = await item(ws, openLoop.id);
    expect(demoted).toMatchObject({
      kind: 'fact',
      title: '（已过期）跟进退款',
      content: '客户 3 天内未收到退款，需要跟进',
      importance: consolidation.DEMOTION_IMPORTANCE_CAP,
      expiresAt: null,
      validUntil: null,
      demotedFromKind: 'open_loop',
      demotedAt: NOW.toISOString(),
      revision: 2,
      status: 'active',
    });

    const versions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid: ws,
      itemId: openLoop.id,
      limit: 10,
    });
    expect(versions.versions).toHaveLength(2);
    expect(versions.versions[0]).toMatchObject({
      kind: 'fact',
      demotedFromKind: 'open_loop',
      demotedAt: NOW.toISOString(),
      actor: { type: 'memory_consolidation' },
    });
    // The pre-demotion values stay in the version chain.
    expect(versions.versions[1]).toMatchObject({
      kind: 'open_loop',
      title: '跟进退款',
      expiresAt: '2025-12-01T00:00:00.000Z',
    });
  });

  test('demotes an expired promotion fact without changing its kind', async () => {
    const ws = workspace('promotion');
    const promo = await seed(ws, {
      content: '双十二满199减30，12月12日当天有效',
      importance: 0.9,
      expiresAt: '2025-12-13T00:00:00.000Z',
    });

    const db = await database();
    const store = await memoryStore.getWorkspaceMemoryStore(ws);
    await consolidation.demoteExpiredBatch(db, {
      storeId: store!.id,
      limit: 50,
      now: NOW,
    });

    const demoted = await item(ws, promo.id);
    expect(demoted).toMatchObject({
      kind: 'fact',
      content: '双十二满199减30，12月12日当天有效',
      importance: consolidation.DEMOTION_IMPORTANCE_CAP,
      expiresAt: null,
      demotedFromKind: null,
      demotedAt: NOW.toISOString(),
    });
  });

  test('never demotes a pinned item', async () => {
    const ws = workspace('pinned');
    const pinned = await seed(ws, {
      content: '店铺永久承诺：假一赔十',
      canonicalKey: 'shop.promise',
      expiresAt: '2025-12-01T00:00:00.000Z',
    });
    await memoryStore.queryWorkspaceMemoryStoreDatabase(
      'UPDATE workspace_memory_items SET pinned = true WHERE id = $1',
      [pinned.id],
    );

    const db = await database();
    const store = await memoryStore.getWorkspaceMemoryStore(ws);
    const result = await consolidation.demoteExpiredBatch(db, {
      storeId: store!.id,
      limit: 50,
      now: NOW,
    });
    expect(result.demoted).toBe(0);
    expect(await item(ws, pinned.id)).toMatchObject({
      pinned: true,
      demotedAt: null,
      expiresAt: '2025-12-01T00:00:00.000Z',
      revision: 1,
    });
  });

  test('demoted items stay searchable but leave recall', async () => {
    const ws = workspace('searchable');
    const promo = await seed(ws, {
      content: '双十二满199减30，12月12日当天有效',
      canonicalKey: 'shop.promo.1212',
      expiresAt: '2025-12-13T00:00:00.000Z',
    });
    // Still expired, but the worker has not run: the read-time validity filter
    // alone must already hide it from search and recall.
    const stillExpired = await seed(ws, {
      content: '双十一满99减10',
      canonicalKey: 'shop.promo.1111',
      expiresAt: '2025-11-12T00:00:00.000Z',
    });

    const before = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid: ws,
      query: '双十',
      limit: 10,
      now: NOW.toISOString(),
    });
    expect(before.hits).toHaveLength(0);
    expect(
      await memoryStore.hasRecallableWorkspaceMemoryCanonicalKey(
        ws,
        'shop.promo.1212',
        NOW.toISOString(),
      ),
    ).toBe(false);

    const db = await database();
    const store = await memoryStore.getWorkspaceMemoryStore(ws);
    await consolidation.demoteExpiredBatch(db, {
      storeId: store!.id,
      limit: 50,
      now: NOW,
    });

    const after = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid: ws,
      query: '双十二',
      limit: 10,
      now: NOW.toISOString(),
    });
    expect(after.hits.map((hit) => hit.item.id)).toEqual([promo.id]);
    expect(after.hits[0].item.demotedAt).toBe(NOW.toISOString());

    // Demoted items are history: searchable, never standing context.
    expect(
      await memoryStore.hasRecallableWorkspaceMemoryCanonicalKey(
        ws,
        'shop.promo.1212',
        NOW.toISOString(),
      ),
    ).toBe(false);
    const recall = await memoryStore.listRecallableWorkspaceMemoryItems({
      workspaceJid: ws,
      limit: 50,
      now: NOW.toISOString(),
    });
    expect(recall.items.map((entry) => entry.id)).not.toContain(promo.id);
    expect(recall.items.map((entry) => entry.id)).not.toContain(
      stillExpired.id,
    );
  });
});

describe('worker', () => {
  test('runs each workspace at most once per scheduled day and catches up a missed run', async () => {
    const ws = workspace('schedule');
    await seed(ws, {
      content: '临时促销：元旦满100减20',
      expiresAt: '2025-12-31T00:00:00.000Z',
    });

    // The last recorded run was yesterday at 03:00 — before the run time, so a
    // restart at 04:00 must make it up.
    await memoryStore.queryWorkspaceMemoryStoreDatabase(
      `INSERT INTO workspace_memory_consolidation_state (
         workspace_jid, last_run_at, last_status, last_processed, last_merged,
         last_demoted, last_skipped_groups, updated_at
       ) VALUES ($1, $2, 'success', 0, 0, 0, 0, $2)
       ON CONFLICT (workspace_jid) DO UPDATE SET last_run_at = $2`,
      [ws, '2026-01-01T03:00:00.000Z'],
    );

    const first = await consolidation.runMemoryConsolidation({
      reason: 'startup',
      settings: SETTINGS,
      workspaceJids: [ws],
      clock: () => NOW,
    });
    expect(first.workspaces).toHaveLength(1);
    expect(first.workspaces[0]).toMatchObject({
      status: 'success',
      demoted: 1,
    });

    await seed(ws, {
      content: '临时促销：春节满200减40',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    // Same day: already covered, so nothing runs.
    const second = await consolidation.runMemoryConsolidation({
      reason: 'scheduled',
      settings: SETTINGS,
      workspaceJids: [ws],
      clock: () => new Date('2026-01-02T05:00:00.000Z'),
    });
    expect(second.workspaces).toHaveLength(0);

    // Next day's scheduled instant: due again.
    const third = await consolidation.runMemoryConsolidation({
      reason: 'scheduled',
      settings: SETTINGS,
      workspaceJids: [ws],
      clock: () => new Date('2026-01-03T03:31:00.000Z'),
    });
    expect(third.workspaces[0]).toMatchObject({
      status: 'success',
      demoted: 1,
    });

    const states = await memoryStore.withWorkspaceMemoryDatabase((db) =>
      consolidation.listConsolidationStates(db),
    );
    const state = states.find((entry) => entry.workspaceJid === ws);
    expect(state).toMatchObject({
      lastStatus: 'success',
      demoted: 1,
      merged: 0,
      lastError: null,
      leaseOwner: null,
    });
  });

  test('a held lease prevents a second instance from consolidating', async () => {
    const ws = workspace('lease');
    await seed(ws, {
      content: '临时促销：情人节满150减25',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    const db = await database();
    expect(
      await consolidation.acquireConsolidationLease(db, {
        workspaceJid: ws,
        owner: 'other-instance',
        now: NOW,
        ttlMs: 300_000,
      }),
    ).toBe(true);

    const summary = await consolidation.runMemoryConsolidation({
      reason: 'scheduled',
      settings: SETTINGS,
      workspaceJids: [ws],
      clock: () => NOW,
    });
    expect(summary.workspaces).toEqual([
      expect.objectContaining({
        workspaceJid: ws,
        leaseHeld: true,
        demoted: 0,
      }),
    ]);

    const items = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid: ws,
      status: 'active',
      limit: 10,
    });
    expect(items.items[0].demotedAt).toBeNull();

    // A stale lease (expired) is taken over, so a crashed run recovers.
    const recovered = await consolidation.runMemoryConsolidation({
      reason: 'manual',
      settings: SETTINGS,
      workspaceJids: [ws],
      clock: () => new Date('2026-01-02T05:00:00.000Z'),
    });
    expect(recovered.workspaces[0]).toMatchObject({ demoted: 1 });
    const states = await memoryStore.withWorkspaceMemoryDatabase((db) =>
      consolidation.listConsolidationStates(db),
    );
    expect(
      states.find((entry) => entry.workspaceJid === ws)?.leaseOwner,
    ).toBeNull();
  });

  test('the startup check runs once and is idempotent on a second start', async () => {
    const ws = workspace('startup');
    await seed(ws, {
      content: '临时促销：开学季满88减10',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const run = vi.fn(
      async (
        input: Parameters<typeof consolidation.runMemoryConsolidation>[0],
      ) =>
        await consolidation.runMemoryConsolidation({
          ...input,
          settings: SETTINGS,
          workspaceJids: [ws],
        }),
    );
    const clock = () => NOW;
    const first = consolidation.startMemoryConsolidationWorker({
      clock,
      settings: () => SETTINGS,
      run,
      pollMs: 3_600_000,
    });
    // Let the immediate startup check finish.
    await first.stop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]?.reason).toBe('startup');

    const states = await memoryStore.withWorkspaceMemoryDatabase((db) =>
      consolidation.listConsolidationStates(db),
    );
    expect(states.find((entry) => entry.workspaceJid === ws)?.demoted).toBe(1);

    // Starting again the same day finds nothing due.
    const second = consolidation.startMemoryConsolidationWorker({
      clock,
      settings: () => SETTINGS,
      pollMs: 3_600_000,
    });
    await second.stop();
    const items = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid: ws,
      status: 'active',
      limit: 10,
    });
    expect(items.items[0].revision).toBe(2);
  });

  test('disabled settings skip every workspace', async () => {
    const ws = workspace('disabled');
    await seed(ws, {
      content: '临时促销：清明满100减15',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const summary = await consolidation.runMemoryConsolidation({
      reason: 'manual',
      settings: { ...SETTINGS, enabled: false },
      workspaceJids: [ws],
      clock: () => NOW,
    });
    expect(summary.disabled).toBe(true);
    expect(summary.workspaces).toHaveLength(0);
    const items = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid: ws,
      status: 'active',
      limit: 10,
    });
    expect(items.items[0].demotedAt).toBeNull();
  });
});

describe('schedule helpers', () => {
  test('resolves the most recent and next local occurrence', () => {
    expect(
      consolidation
        .lastDueInstant(new Date('2026-01-02T04:00:00Z'), '03:30', 'UTC')
        .toISOString(),
    ).toBe('2026-01-02T03:30:00.000Z');
    expect(
      consolidation
        .lastDueInstant(new Date('2026-01-02T02:00:00Z'), '03:30', 'UTC')
        .toISOString(),
    ).toBe('2026-01-01T03:30:00.000Z');
    expect(
      consolidation
        .nextDueInstant(new Date('2026-01-02T04:00:00Z'), '03:30', 'UTC')
        .toISOString(),
    ).toBe('2026-01-03T03:30:00.000Z');
    // The bound time zone is honoured rather than the host's.
    expect(
      consolidation
        .lastDueInstant(
          new Date('2026-01-02T00:00:00Z'),
          '03:30',
          'Asia/Shanghai',
        )
        .toISOString(),
    ).toBe('2026-01-01T19:30:00.000Z');
  });

  test('treats a workspace with no recorded run as due', () => {
    expect(
      consolidation.isConsolidationDue(undefined, NOW, '03:30', 'UTC'),
    ).toBe(true);
    expect(
      consolidation.isConsolidationDue(
        { lastRunAt: '2026-01-02T03:30:00.000Z' },
        NOW,
        '03:30',
        'UTC',
      ),
    ).toBe(false);
  });
});
