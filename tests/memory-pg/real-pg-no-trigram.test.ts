import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  createLimitedMemoryPgRole,
  describeMemoryPg,
  openMemoryPgScope,
  type LimitedMemoryPgRole,
  type MemoryPgScope,
} from './helpers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-limited-pg-'));
vi.mock('../../src/config.js', () => ({
  ASSISTANT_NAME: 'CommerceAgent',
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'store'),
  GROUPS_DIR: path.join(root, 'groups'),
  TIMEZONE: 'UTC',
}));
vi.mock('../../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const { logger } = await import('../../src/logger.js');
const memoryStore = await import('../../src/memory-store.js');
const consolidation = await import('../../src/memory-consolidation/index.js');
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const context = { actorId: 'limited-owner', sourceType: 'web_user' as const };

/** Boot with schema CREATE, but without database CREATE (pg_trgm is trusted). */
describeMemoryPg('Workspace Memory without pg_trgm rights', () => {
  let scope: MemoryPgScope | undefined;
  let role: LimitedMemoryPgRole | undefined;

  beforeAll(async () => {
    scope = await openMemoryPgScope();
    role = await createLimitedMemoryPgRole(scope.databaseName);
    vi.stubEnv('MEMORY_DATABASE_URL', role.url);
    await memoryStore.initWorkspaceMemoryStore();
  });
  afterAll(async () => {
    try {
      await memoryStore.closeWorkspaceMemoryStore();
      await role?.drop();
    } finally {
      await scope?.close();
      vi.unstubAllEnvs();
    }
  });

  test('real role cannot install the extension but migrations and startup succeed', async () => {
    await memoryStore.withWorkspaceMemoryDatabase(async (db) => {
      expect(db.backend).toBe('postgres');
      const privileges = await db.query<{
        db_create: boolean;
        schema_create: boolean;
      }>(
        `SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS db_create,
                has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create`,
      );
      expect(privileges.rows[0]).toEqual({
        db_create: false,
        schema_create: true,
      });
      await expect(db.exec('CREATE EXTENSION pg_trgm')).rejects.toMatchObject({
        code: '42501',
      });
      const extension = await db.query(
        `SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`,
      );
      expect(extension.rows).toHaveLength(0);
      expect(await consolidation.isTrigramSimilarityAvailable(db)).toBe(false);
      const recorded = await db.query<{ version: number }>(
        'SELECT version FROM workspace_memory_schema_migrations ORDER BY version',
      );
      expect(recorded.rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ backend: 'postgres' }),
      'pg_trgm is unavailable; Workspace Memory substring search falls back to sequential scans',
    );
  });

  test('ILIKE finds an intra-word substring that FTS and explicit search keys cannot match', async () => {
    const workspaceJid = `web:limited-search-${randomUUID()}`;
    const created = await memoryStore.createWorkspaceMemoryItem({
      workspaceJid,
      value: {
        kind: 'fact',
        title: '退款政策',
        content: '客户凭 SKUZXCVBN42 退款，七天内提交申请。',
        searchKeys: ['refund-policy'],
      },
      context,
    });
    // xcvbn is inside a single FTS lexeme and is absent from search_keys.
    for (const query of ['xcvbn', '七天内提交', '退款政策']) {
      const result = await memoryStore.searchWorkspaceMemoryItems({
        workspaceJid,
        query,
        limit: 5,
      });
      expect(result.hits.map((hit) => hit.item.id)).toContain(created.item.id);
    }
    const miss = await memoryStore.searchWorkspaceMemoryItems({
      workspaceJid,
      query: 'unrelated-query',
      limit: 5,
    });
    expect(miss.hits).toHaveLength(0);
  });

  test('nightly worker merges both exact arms, skips similar-only text, and explains degradation', async () => {
    const workspaceJid = `web:limited-dedupe-${randomUUID()}`;
    const contents = [
      { content: '默认使用顺丰配送。' },
      { content: '默认 使用顺丰配送' },
      { content: 'warehouse alpha', canonicalKey: 'warehouse' },
      { content: 'warehouse beta', canonicalKey: 'warehouse' },
      {
        title: 'Support policy',
        content:
          'Customer refunds require the receipt and the original packaging within seven calendar days',
      },
      {
        title: 'Support policy',
        content:
          'Customer refunds require the receipt and the original packaging within seven calendar day',
      },
    ];
    for (const value of contents) {
      await memoryStore.createWorkspaceMemoryItem({
        workspaceJid,
        value: { kind: 'fact', ...value },
        context,
      });
    }
    const settings = {
      enabled: true,
      time: '03:30',
      batchSize: 50,
      maxRuntimeMs: 60_000,
    };
    const run = (clock: () => Date) =>
      memoryStore.withWorkspaceMemoryDatabase((db) =>
        consolidation.runMemoryConsolidationOnDatabase(db, {
          reason: 'manual',
          settings,
          workspaceJids: [workspaceJid],
          clock,
        }),
      );
    const now = new Date();
    const summary = await run(() => now);
    expect(summary.workspaces[0].status).toBe('success');
    expect(summary.merged).toBe(2);
    expect(logger.info).toHaveBeenCalledWith(
      'Workspace Memory consolidation runs without pg_trgm; similar-text duplicate groups are skipped and only exact duplicate arms are merged',
    );
    const active = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid,
      status: 'active',
      limit: 100,
    });
    const superseded = await memoryStore.listWorkspaceMemoryItems({
      workspaceJid,
      status: 'superseded',
      limit: 100,
    });
    expect(active.items).toHaveLength(4);
    expect(superseded.items).toHaveLength(2);
    expect(
      active.items.filter((item) => item.title === 'Support policy'),
    ).toHaveLength(2);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    expect((await run(() => tomorrow)).merged).toBe(0);
  });
});
