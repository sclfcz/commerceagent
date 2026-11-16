import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-integration-'));
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
const memoryPg = await import('../src/memory-pg/index.js');
const migrations = await import('../src/memory-pg/migrations/index.js');
const memoryStore = await import('../src/memory-store.js');
const memoryService = await import('../src/memory-service.js');
const candidateStore = await import('../src/memory-candidate-store.js');
const consolidation = await import('../src/memory-consolidation/index.js');
const { deriveSearchKeys } = await import('../src/memory-keywords.js');

const OWNER = 'integration-owner';
const actor = { id: OWNER, role: 'admin' as const };
const context = { actorId: OWNER, sourceType: 'web_user' as const };

function register(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: '2026-05-01T00:00:00.000Z',
    created_by: OWNER,
    is_home: false,
  } as never);
}

const WORKSPACES = [
  ['web:gaps-a', 'gaps-a'],
  ['web:gaps-a2', 'gaps-a2'],
  ['web:gaps-b', 'gaps-b'],
  ['web:gaps-b2', 'gaps-b2'],
  ['web:gaps-c', 'gaps-c'],
] as const;

beforeAll(async () => {
  db.initDatabase();
  for (const [jid, folder] of WORKSPACES) register(jid, folder);
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;

function inHours(hours: number): string {
  return new Date(Date.now() + hours * HOUR).toISOString();
}

async function create(
  workspaceJid: string,
  value: {
    kind?: 'fact' | 'decision' | 'lesson' | 'open_loop';
    title?: string | null;
    content: string;
    importance?: number;
    searchKeys?: string[];
    pinned?: boolean;
    status?: 'active' | 'proposed';
    expiresAt?: string | null;
  },
): Promise<memoryStore.WorkspaceMemoryItem> {
  const created = await memoryStore.createWorkspaceMemoryItem({
    workspaceJid,
    value: {
      kind: value.kind ?? 'fact',
      title: value.title ?? null,
      content: value.content,
      importance: value.importance,
      searchKeys: value.searchKeys,
      pinned: value.pinned,
      status: value.status,
      expiresAt: value.expiresAt ?? null,
    },
    context,
  });
  return created.item;
}

async function item(
  workspaceJid: string,
  itemId: string,
): Promise<memoryStore.WorkspaceMemoryItem> {
  return (await memoryStore.getWorkspaceMemoryItem(workspaceJid, itemId)).item;
}

async function storeId(workspaceJid: string): Promise<string> {
  return (await memoryStore.getWorkspaceMemoryStore(workspaceJid))!.id;
}

async function mergeOnce(workspaceJid: string, now: Date) {
  const database = await memoryStore.withWorkspaceMemoryDatabase(
    (conn) => conn,
  );
  return await consolidation.mergeDuplicateBatch(database, {
    storeId: await storeId(workspaceJid),
    workspaceJid,
    limit: 50,
    trigramAvailable:
      await consolidation.isTrigramSimilarityAvailable(database),
    now,
  });
}

async function demoteOnce(workspaceJid: string, now: Date) {
  const database = await memoryStore.withWorkspaceMemoryDatabase(
    (conn) => conn,
  );
  return await consolidation.demoteExpiredBatch(database, {
    storeId: await storeId(workspaceJid),
    limit: 50,
    now,
  });
}

describe('migrations 1 → 2 → 3 → 4 on a fresh database', () => {
  test('the final provenance vocabulary keeps every phase’s values', async () => {
    const database = await memoryPg.createMemoryDatabase({
      kind: 'pglite',
      url: null,
      dataDir: path.join(root, 'fresh-pglite'),
    });
    try {
      const result = await migrations.migrateMemoryDatabase(database);
      expect(result.applied).toEqual([1, 2, 3, 4]);
      expect(result.version).toBe(4);

      const recorded = await database.query<{ version: number | string }>(
        'SELECT version FROM workspace_memory_schema_migrations ORDER BY version',
      );
      expect(recorded.rows.map((row) => Number(row.version))).toEqual([
        1, 2, 3, 4,
      ]);

      // 003 rebuilds the baseline CHECK with its own vocabulary and 004 widens
      // it again from whatever it finds, so the final definition must contain
      // every value any phase ever added.
      const constraints = await database.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         WHERE c.conrelid = 'workspace_memory_provenance'::regclass
           AND c.contype = 'c'
           AND pg_get_constraintdef(c.oid) LIKE '%source_type%'`,
      );
      expect(constraints.rows).toHaveLength(1);
      const definition = constraints.rows[0].definition;
      for (const value of [
        'web_user',
        'agent_runtime',
        'scheduled_task',
        'migration',
        'agent_extraction',
        'system',
        'memory_consolidation',
      ]) {
        expect(definition).toContain(`'${value}'`);
      }

      // Re-running is a no-op, so the migrations stay idempotent after merge.
      await expect(migrations.migrateMemoryDatabase(database)).resolves.toEqual(
        { applied: [], version: 4 },
      );
    } finally {
      await database.close();
    }
  });
});

describe('fix A: demoted memories are history, not standing context', () => {
  const workspaceJid = 'web:gaps-a';
  let pinnedId = '';
  let loopId = '';
  let promotionId = '';

  beforeAll(async () => {
    pinnedId = (
      await create(workspaceJid, {
        content: '本店主营收女装',
        searchKeys: ['女装'],
        pinned: true,
        importance: 0.9,
      })
    ).id;
    loopId = (
      await create(workspaceJid, {
        kind: 'open_loop',
        title: '春季上新素材',
        content: '春季上新素材还没定稿，需要设计确认',
        expiresAt: inHours(1),
      })
    ).id;
    promotionId = (
      await create(workspaceJid, {
        content: '双十一大促满减活动持续到本周末',
        expiresAt: inHours(1),
      })
    ).id;

    const demoted = await demoteOnce(
      workspaceJid,
      new Date(Date.now() + 2 * HOUR),
    );
    expect(demoted.demoted).toBe(2);
  });

  test('demoted items leave profile and proactive without a query', async () => {
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      limit: 12,
      maxChars: 8000,
    });
    const segments = snapshot.retrievalTrace.segments!;
    expect(segments.profile.itemIds).toContain(pinnedId);
    for (const segment of Object.values(segments)) {
      expect(segment.itemIds).not.toContain(loopId);
      expect(segment.itemIds).not.toContain(promotionId);
    }
    expect(snapshot.renderedText).not.toContain('（已过期）');
  });

  test('search still finds demoted items, and only in `relevant`', async () => {
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      query: '春季上新素材的进度怎么样',
      limit: 12,
      maxChars: 8000,
    });
    const segments = snapshot.retrievalTrace.segments!;
    expect(segments.relevant.itemIds).toContain(loopId);
    expect(segments.profile.itemIds).not.toContain(loopId);
    expect(segments.proactive.itemIds).not.toContain(loopId);
    expect(segments.relevant.itemIds).not.toContain(pinnedId);
    // The demoted item keeps its history marker, which lives on its title.
    expect((await item(workspaceJid, loopId)).title).toContain('（已过期）');

    const search = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: '双十一满减',
      limit: 10,
    });
    expect(search.hits.map((hit) => hit.item.id)).toContain(promotionId);
  });
});

describe('fix A: proposed and superseded items never enter recall', () => {
  const workspaceJid = 'web:gaps-a2';
  let proposedId = '';
  let keeperId = '';
  let supersededId = '';

  beforeAll(async () => {
    const candidate = await candidateStore.createWorkspaceMemoryCandidate({
      workspaceJid,
      sessionKey: `${workspaceJid}#session`,
      runId: 'run-gaps-a2',
      kind: 'fact',
      title: '会员积分兑换规则',
      content: '会员积分每满一百可以兑换十元券',
      confidence: 0.9,
      importance: 0.7,
      ttlDays: 14,
    });
    proposedId = candidate.item.id;

    const keeper = await create(workspaceJid, {
      content: '满三百减五十的优惠券可以叠加使用',
      importance: 0.9,
      searchKeys: ['优惠券', '叠加'],
    });
    keeperId = keeper.id;
    const duplicate = await create(workspaceJid, {
      content: '满三百减五十的优惠券可以叠加使用',
      importance: 0.3,
      searchKeys: ['优惠券'],
    });
    supersededId = duplicate.id;

    const merged = await mergeOnce(workspaceJid, new Date());
    expect(merged.merged).toBe(1);
  });

  test('the query-side keyword path only returns active items', async () => {
    const search = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: '会员积分兑换 优惠券叠加规则',
      limit: 20,
    });
    const ids = search.hits.map((hit) => hit.item.id);
    expect(ids).toContain(keeperId);
    expect(ids).not.toContain(proposedId);
    expect(ids).not.toContain(supersededId);
  });

  test('the snapshot cannot include them through its search hits either', async () => {
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      query: '会员积分兑换 优惠券叠加规则',
      limit: 12,
      maxChars: 8000,
    });
    const ids = snapshot.items.map((entry) => entry.id);
    expect(ids).toContain(keeperId);
    expect(ids).not.toContain(proposedId);
    expect(ids).not.toContain(supersededId);
  });
});

describe('fix B: retrieval keys through merge and demotion', () => {
  test('a merge folds the absorbed item’s keys into the keeper', async () => {
    const workspaceJid = 'web:gaps-b';
    const keeper = await create(workspaceJid, {
      content: '客单价在八百元左右',
      importance: 0.9,
      searchKeys: ['女装', '客单价'],
    });
    const duplicate = await create(workspaceJid, {
      content: '客单价在八百元左右',
      importance: 0.3,
      searchKeys: ['客单价', '春季上新', '新品'],
    });

    const merged = await mergeOnce(workspaceJid, new Date());
    expect(merged.merged).toBe(1);

    const kept = await item(workspaceJid, keeper.id);
    // The keeper's own keys come first, the absorbed item only adds new ones.
    expect(kept.searchKeys).toEqual(['女装', '客单价', '春季上新', '新品']);

    // Both sides of the merge leave a complete version chain behind.
    const keeperVersions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid,
      itemId: keeper.id,
      limit: 10,
    });
    expect(keeperVersions.versions[0]).toMatchObject({
      revision: 2,
      changeType: 'update',
      searchKeys: ['女装', '客单价', '春季上新', '新品'],
      pinned: false,
      supersededBy: null,
      demotedAt: null,
    });
    const duplicateVersions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid,
      itemId: duplicate.id,
      limit: 10,
    });
    expect(duplicateVersions.versions[0]).toMatchObject({
      revision: 2,
      changeType: 'update',
      status: 'superseded',
      supersededBy: keeper.id,
      searchKeys: ['客单价', '春季上新', '新品'],
    });
  });

  test('the combined key list is capped at twelve', async () => {
    const workspaceJid = 'web:gaps-b';
    const keeperKeys = Array.from({ length: 8 }, (_, i) => `key${i + 1}`);
    const duplicateKeys = Array.from({ length: 8 }, (_, i) => `dup${i + 1}`);
    const keeper = await create(workspaceJid, {
      content: '同一版本的库存同步规则',
      importance: 0.9,
      searchKeys: keeperKeys,
    });
    await create(workspaceJid, {
      content: '同一版本的库存同步规则',
      importance: 0.2,
      searchKeys: duplicateKeys,
    });

    const merged = await mergeOnce(workspaceJid, new Date());
    expect(merged.merged).toBe(1);

    const kept = await item(workspaceJid, keeper.id);
    expect(kept.searchKeys).toHaveLength(12);
    expect(kept.searchKeys.slice(0, 8)).toEqual(keeperKeys);
    expect(kept.searchKeys.slice(8)).toEqual(['dup1', 'dup2', 'dup3', 'dup4']);
  });

  test('demotion keeps the keys and the version records them', async () => {
    const workspaceJid = 'web:gaps-b2';
    const created = await create(workspaceJid, {
      kind: 'open_loop',
      title: '春季促销',
      content: '满减活动到三月底结束',
      expiresAt: inHours(1),
      searchKeys: ['春季促销', '满减活动'],
    });

    const demoted = await demoteOnce(
      workspaceJid,
      new Date(Date.now() + 2 * HOUR),
    );
    expect(demoted.demoted).toBe(1);

    const kept = await item(workspaceJid, created.id);
    expect(kept).toMatchObject({
      kind: 'fact',
      demotedFromKind: 'open_loop',
      pinned: false,
      supersededBy: null,
    });
    expect(kept.demotedAt).not.toBeNull();
    // Demotion rewrites the text but not the terms the item is known by.
    expect(kept.searchKeys).toEqual(['春季促销', '满减活动']);
    expect(kept.title).toBe('（已过期）春季促销');

    const versions = await memoryStore.listWorkspaceMemoryVersions({
      workspaceJid,
      itemId: created.id,
      limit: 10,
    });
    expect(versions.versions[0]).toMatchObject({
      revision: 2,
      changeType: 'update',
      searchKeys: ['春季促销', '满减活动'],
      demotedFromKind: 'open_loop',
      demotedAt: kept.demotedAt,
      pinned: false,
      supersededBy: null,
    });
    // The create revision stays untouched.
    expect(versions.versions[1]).toMatchObject({
      revision: 1,
      changeType: 'create',
      searchKeys: ['春季促销', '满减活动'],
      demotedAt: null,
    });
  });
});

describe('fix C: confirming a candidate makes it retrievable', () => {
  const workspaceJid = 'web:gaps-c';

  async function proposed(input: {
    title: string;
    content: string;
    searchKeys?: string[];
  }): Promise<memoryStore.WorkspaceMemoryItem> {
    const created = await candidateStore.createWorkspaceMemoryCandidate({
      workspaceJid,
      sessionKey: `${workspaceJid}#session`,
      runId: `run-${input.title}`,
      kind: 'fact',
      title: input.title,
      content: input.content,
      confidence: 0.9,
      importance: 0.6,
      searchKeys: input.searchKeys,
      ttlDays: 14,
    });
    return created.item;
  }

  async function clearSearchKeys(itemId: string): Promise<void> {
    // Simulates a candidate written before phase B, when items had no keys.
    await memoryStore.withWorkspaceMemoryDatabase(async (database) => {
      await database.query(
        `UPDATE workspace_memory_items SET search_keys = '{}' WHERE id = $1`,
        [itemId],
      );
    });
  }

  test('extraction-proposed keys become the item’s keys', async () => {
    const created = await proposed({
      title: '定制包装要求',
      content: '所有订单使用定制包装盒',
      searchKeys: ['定制包装', '包装盒'],
    });
    expect(created.searchKeys).toEqual(['定制包装', '包装盒']);
  });

  test('confirm derives keys for a candidate that has none', async () => {
    const created = await proposed({
      title: '退款政策',
      content: '客户退款需在7天内提交申请',
    });
    await clearSearchKeys(created.id);

    const confirmed = await memoryService.confirmWorkspaceMemoryCandidate({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      itemId: created.id,
      expectedRevision: 1,
    });

    expect(confirmed.item.status).toBe('active');
    expect(confirmed.item.searchKeys).toEqual(
      deriveSearchKeys({
        title: created.title,
        content: created.content,
      }),
    );
    expect(confirmed.item.searchKeys.length).toBeGreaterThan(0);

    const search = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: '请问客户要退款的话流程是什么',
      limit: 10,
    });
    expect(search.hits.map((hit) => hit.item.id)).toContain(created.id);
  });

  test('edit-then-confirm derives keys from the edited text', async () => {
    const created = await proposed({
      title: '发货时效',
      content: '48 小时内发出',
    });
    await clearSearchKeys(created.id);
    const edited = {
      title: '退货时效',
      content: '退货需在15天内寄回并保持吊牌完整',
    };

    const confirmed = await memoryService.confirmWorkspaceMemoryCandidate({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      itemId: created.id,
      expectedRevision: 1,
      ...edited,
    });

    expect(confirmed.item.searchKeys).toEqual(deriveSearchKeys(edited));
    expect(confirmed.item.searchKeys.length).toBeGreaterThan(0);

    const versions = await memoryService.listWorkspaceMemoryVersions({
      actor,
      workspaceJid,
      itemId: created.id,
    });
    expect(versions.versions[0].searchKeys).toEqual(deriveSearchKeys(edited));
  });
});
