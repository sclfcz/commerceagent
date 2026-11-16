import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-recall-b-'));
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
const { backfillWorkspaceMemorySearchKeys } =
  await import('../src/memory-keywords-backfill.js');

const OWNER = 'recall-b-owner';
const AT = '2026-05-01T00:00:00.000Z';
const actor = { id: OWNER, role: 'admin' as const };

function register(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: AT,
    created_by: OWNER,
    is_home: false,
  } as never);
}

async function storeId(workspaceJid: string): Promise<string> {
  const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
    id: string;
  }>('SELECT id FROM workspace_memory_stores WHERE workspace_jid = $1', [
    workspaceJid,
  ]);
  return result.rows[0].id;
}

beforeAll(async () => {
  db.initDatabase();
  register('web:recall-b-crud', 'recall-b-crud');
  register('web:recall-b-contrast', 'recall-b-contrast');
  register('web:recall-b-snapshot', 'recall-b-snapshot');
  await memoryStore.initWorkspaceMemoryStore();
});

afterAll(async () => {
  await memoryStore.closeWorkspaceMemoryStore();
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('migration 002', () => {
  test('is applied on top of the baseline', async () => {
    const result = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      version: number;
    }>(
      'SELECT version FROM workspace_memory_schema_migrations ORDER BY version',
    );
    // Phases B, C and D are merged: the fresh database runs 1 → 2 → 3 → 4.
    expect(result.rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4]);
    expect(migrations.MEMORY_SCHEMA_VERSION).toBe(4);
  });

  test('adds search_keys and pinned to items and versions', async () => {
    const columns = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_name IN ('workspace_memory_items', 'workspace_memory_versions')
         AND column_name IN ('search_keys', 'pinned', 'search_vector')
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'workspace_memory_items', column_name: 'pinned' },
      { table_name: 'workspace_memory_items', column_name: 'search_keys' },
      { table_name: 'workspace_memory_items', column_name: 'search_vector' },
      { table_name: 'workspace_memory_versions', column_name: 'pinned' },
      { table_name: 'workspace_memory_versions', column_name: 'search_keys' },
    ]);

    // Keys contribute at the title weight (A) to the generated vector.
    const expression = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      expression: string;
    }>(
      `SELECT pg_get_expr(d.adbin, d.adrelid) AS expression
       FROM pg_attribute a
       JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = 'workspace_memory_items'::regclass
         AND a.attname = 'search_vector'`,
    );
    expect(expression.rows[0].expression).toContain(
      'setweight(array_to_tsvector(search_keys), \'A\'::"char")',
    );
  });
});

describe('search keys and pinned through the service', () => {
  test('explicit keys are normalized, derived keys fill in, versions record both', async () => {
    const explicit = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      kind: 'fact',
      title: '客服口径',
      content: '退款需要在 7 天内提交',
      searchKeys: [' Refund ', 'refund', '售后'],
      pinned: true,
    });
    expect(explicit.item.searchKeys).toEqual(['refund', '售后']);
    expect(explicit.item.pinned).toBe(true);

    const derived = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      kind: 'lesson',
      title: '退款政策',
      content: '客户退款需在7天内提交申请',
    });
    expect(derived.item.searchKeys.length).toBeGreaterThan(0);
    expect(derived.item.searchKeys).toContain('退款政策');
    expect(derived.item.pinned).toBe(false);

    const versions = await memoryService.listWorkspaceMemoryVersions({
      actor,
      workspaceJid: 'web:recall-b-crud',
      itemId: explicit.item.id,
    });
    expect(versions.versions[0]).toMatchObject({
      revision: 1,
      changeType: 'create',
      searchKeys: ['refund', '售后'],
      pinned: true,
    });
  });

  test('pinned and keys updates go through revision CAS and append versions', async () => {
    const created = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      kind: 'fact',
      title: '店铺画像',
      content: '主营女装',
    });

    // A stale revision must not be able to flip the pinned flag.
    await expect(
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid: 'web:recall-b-crud',
        sourceType: 'web_user',
        itemId: created.item.id,
        expectedRevision: created.item.revision + 1,
        pinned: true,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });

    const pinned = await memoryService.updateWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      itemId: created.item.id,
      expectedRevision: created.item.revision,
      pinned: true,
      searchKeys: ['店铺画像', '女装'],
    });
    expect(pinned.item.pinned).toBe(true);
    expect(pinned.item.searchKeys).toEqual(['店铺画像', '女装']);
    expect(pinned.item.revision).toBe(created.item.revision + 1);

    await expect(
      memoryService.updateWorkspaceMemory({
        actor,
        workspaceJid: 'web:recall-b-crud',
        sourceType: 'web_user',
        itemId: created.item.id,
        expectedRevision: created.item.revision,
        pinned: false,
      }),
    ).rejects.toMatchObject({ code: 'revision_conflict' });

    const versions = await memoryService.listWorkspaceMemoryVersions({
      actor,
      workspaceJid: 'web:recall-b-crud',
      itemId: created.item.id,
    });
    expect(
      versions.versions.map((version) => ({
        revision: version.revision,
        pinned: version.pinned,
        searchKeys: version.searchKeys,
      })),
    ).toEqual([
      // Versions are listed newest first.
      { revision: 2, pinned: true, searchKeys: ['店铺画像', '女装'] },
      { revision: 1, pinned: false, searchKeys: expect.any(Array) },
    ]);
  });

  test('derived keys follow text edits unless the user supplied their own', async () => {
    const created = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      kind: 'fact',
      title: '发货时效',
      content: '48 小时内发出',
    });
    expect(created.item.searchKeys).toContain('发货时效');

    const edited = await memoryService.updateWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      itemId: created.item.id,
      expectedRevision: created.item.revision,
      title: '退货时效',
    });
    expect(edited.item.searchKeys).toContain('退货时效');
    expect(edited.item.searchKeys).not.toContain('发货时效');

    const manual = await memoryService.updateWorkspaceMemory({
      actor,
      workspaceJid: 'web:recall-b-crud',
      sourceType: 'web_user',
      itemId: created.item.id,
      expectedRevision: edited.item.revision,
      content: '7 天内可退',
    });
    // Once the host derives keys again they follow the new text.
    expect(manual.item.searchKeys).toContain('天内可退');
  });
});

describe('long Chinese question recall', () => {
  const workspaceJid = 'web:recall-b-contrast';
  const question = '请问客户要退款的话我们的流程是什么';
  let itemId = '';

  beforeAll(async () => {
    const created = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'lesson',
      title: '退款政策',
      content: '客户退款需在7天内提交申请，超时不处理',
    });
    itemId = created.item.id;
    // No explicit keys: the host derives them from the short title/content.
    expect(created.item.searchKeys.length).toBeGreaterThan(0);
    expect(created.item.searchKeys.join(',')).not.toContain(question);
  });

  test('the pre-keyword arms alone recall nothing', async () => {
    // The arms that existed before phase B: whole-sentence tsquery + ILIKE on
    // title/content/canonical_key. A single `simple` lexeme cannot match.
    const legacy = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      n: number | string;
    }>(
      `SELECT count(*) AS n
       FROM workspace_memory_items
       WHERE store_id = $1
         AND status = 'active'
         AND (
           search_vector @@ plainto_tsquery('simple', $2)
           OR title ILIKE '%' || $2 || '%'
           OR content ILIKE '%' || $2 || '%'
           OR canonical_key ILIKE '%' || $2 || '%'
         )`,
      [await storeId(workspaceJid), question],
    );
    expect(Number(legacy.rows[0].n)).toBe(0);

    // The same question read as a whole also misses the stored key.
    const wholeKey = await memoryStore.queryWorkspaceMemoryStoreDatabase<{
      n: number | string;
    }>(
      `SELECT count(*) AS n
       FROM workspace_memory_items
       WHERE store_id = $1 AND $2 = ANY (search_keys)`,
      [await storeId(workspaceJid), question],
    );
    expect(Number(wholeKey.rows[0].n)).toBe(0);
  });

  test('keyword extraction makes the same question find the item', async () => {
    const result = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: question,
      limit: 10,
    });
    const hit = result.hits.find((entry) => entry.item.id === itemId);
    expect(hit).toBeDefined();
    expect(hit!.searchKeyHits).toBeGreaterThan(0);
    expect(hit!.rank).toBeGreaterThan(0);
  });

  test('a short query keyword still matches a longer stored key', async () => {
    const result = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: '退款',
      limit: 10,
    });
    expect(result.hits.map((entry) => entry.item.id)).toContain(itemId);
  });
});

describe('three-way snapshot', () => {
  const workspaceJid = 'web:recall-b-snapshot';
  let profileId = '';
  let factId = '';
  let dueLoopId = '';
  let farLoopId = '';
  let datedLoopId = '';

  beforeAll(async () => {
    const profile = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'fact',
      title: '店铺画像',
      content: '本店主营轻奢女装，客单价 800 元',
      pinned: true,
      importance: 0.9,
    });
    profileId = profile.item.id;

    const fact = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'fact',
      content: '仓库位于杭州',
      importance: 0.6,
    });
    factId = fact.item.id;

    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const dueLoop = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'open_loop',
      content: '春季上新素材还没定稿',
      expiresAt: soon,
    });
    dueLoopId = dueLoop.item.id;

    const farLoop = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'open_loop',
      content: '双十一复盘报告',
      expiresAt: later,
    });
    farLoopId = farLoop.item.id;

    const datedLoop = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'open_loop',
      content: '会员日折扣已经生效',
      validFrom: yesterday,
      expiresAt: later,
    });
    datedLoopId = datedLoop.item.id;
  });

  test('labels the three segments and puts each item in exactly one', async () => {
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      limit: 12,
      maxChars: 8000,
    });

    expect(snapshot.renderedText).toContain('<profile>');
    expect(snapshot.renderedText).toContain('<relevant>');
    expect(snapshot.renderedText).toContain('<proactive>');
    expect(snapshot.renderedText.indexOf('<profile>')).toBeLessThan(
      snapshot.renderedText.indexOf('<relevant>'),
    );
    expect(snapshot.renderedText.indexOf('<relevant>')).toBeLessThan(
      snapshot.renderedText.indexOf('<proactive>'),
    );
    expect(snapshot.renderedText).toContain('pinned="true"');

    const segments = snapshot.retrievalTrace.segments!;
    expect(segments.profile.itemIds).toEqual([profileId]);
    expect(segments.relevant.itemIds).toContain(factId);
    expect(segments.relevant.itemIds).not.toContain(profileId);
    expect(segments.relevant.itemIds).not.toContain(dueLoopId);
    expect(segments.proactive.itemIds).toContain(dueLoopId);
    expect(segments.proactive.itemIds).toContain(datedLoopId);
    // An open loop whose only date is 10 days away is not proactive.
    expect(segments.proactive.itemIds).not.toContain(farLoopId);

    const ids = snapshot.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(snapshot.retrievalTrace.itemRevisions).toEqual(
      snapshot.items.map((item) => ({ id: item.id, revision: item.revision })),
    );
  });

  test('a tiny budget truncates the segments instead of overflowing', async () => {
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      limit: 12,
      maxChars: 256,
    });
    expect(snapshot.renderedText.length).toBeLessThanOrEqual(256);
    const segments = snapshot.retrievalTrace.segments!;
    const truncated = Object.values(segments).reduce(
      (total, segment) => total + segment.truncated,
      0,
    );
    expect(truncated).toBeGreaterThan(0);
    // Nothing is written past the requested budget, and the profile reports
    // what it had to leave out.
    for (const segment of Object.values(segments)) {
      expect(segment.usedChars).toBeLessThanOrEqual(segment.budgetChars);
    }
    expect(segments.profile.truncated).toBeGreaterThanOrEqual(0);
  });

  test('pinned items are recalled without a query and without decay', async () => {
    const stale = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'fact',
      content: '本店不卖男装',
      pinned: true,
      importance: 0.3,
      provenance: {
        observedAt: new Date(
          Date.now() - 365 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    });
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      limit: 12,
      maxChars: 8000,
    });
    // A year-old pinned item still beats a fresh unpinned one.
    expect(snapshot.retrievalTrace.segments!.profile.itemIds).toContain(
      stale.item.id,
    );
  });

  test('query keywords are reported in the trace', async () => {
    const lesson = await memoryService.createWorkspaceMemory({
      actor,
      workspaceJid,
      sourceType: 'web_user',
      kind: 'lesson',
      content: '上新素材需要提前两周准备',
    });
    const snapshot = await memoryService.getWorkspaceMemorySnapshot({
      actor,
      workspaceJid,
      query: '请问春季上新素材的进度怎么样',
      limit: 12,
      maxChars: 8000,
    });
    expect(snapshot.retrievalTrace.queryKeywords).toContain('上新');
    // A plain match is delivered under `relevant`; the due open loop keeps its
    // own `proactive` label even though it also matches the question.
    expect(snapshot.retrievalTrace.segments!.relevant.itemIds).toContain(
      lesson.item.id,
    );
    expect(snapshot.retrievalTrace.segments!.proactive.itemIds).toContain(
      dueLoopId,
    );
  });
});

describe('retrieval key backfill', () => {
  test('fills legacy rows once and never overwrites explicit keys', async () => {
    const dataDir = path.join(root, 'backfill-pglite');
    const database = await memoryPg.createMemoryDatabase({
      kind: 'pglite',
      url: null,
      dataDir,
    });
    try {
      await migrations.migrateMemoryDatabase(database);
      const at = '2026-05-01T00:00:00.000Z';
      await database.query(
        `INSERT INTO workspace_memory_stores (id, workspace_jid, revision, created_at, updated_at)
         VALUES ($1, $2, 0, $3, $3)`,
        ['wms_backfill', 'web:backfill', at],
      );
      await database.query(
        `INSERT INTO workspace_memory_items (
           id, store_id, workspace_jid, kind, title, content, status,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 'fact', $4, $5, 'active', $6, $6)`,
        [
          'wmi_legacy',
          'wms_backfill',
          'web:backfill',
          '退款政策',
          '客户退款需在7天内提交申请',
          at,
        ],
      );
      await database.query(
        `INSERT INTO workspace_memory_items (
           id, store_id, workspace_jid, kind, title, content, status,
           search_keys, created_at, updated_at
         ) VALUES ($1, $2, $3, 'fact', $4, $5, 'active', $6::text[], $7, $7)`,
        [
          'wmi_explicit',
          'wms_backfill',
          'web:backfill',
          '发货时效',
          '48 小时内发出',
          ['自定义关键词'],
          at,
        ],
      );

      await expect(backfillWorkspaceMemorySearchKeys(database)).resolves.toBe(
        1,
      );

      const rows = await database.query<{
        id: string;
        search_keys: string[];
      }>('SELECT id, search_keys FROM workspace_memory_items ORDER BY id');
      const byId = new Map(rows.rows.map((row) => [row.id, row.search_keys]));
      expect(byId.get('wmi_legacy')).toContain('退款政策');
      expect(byId.get('wmi_explicit')).toEqual(['自定义关键词']);

      // Re-running is a no-op: derived metadata never churns.
      await expect(backfillWorkspaceMemorySearchKeys(database)).resolves.toBe(
        0,
      );
    } finally {
      await database.close();
    }
  });
});
