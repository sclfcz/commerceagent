import type { ConsolidationRunSummary } from '../../src/memory-consolidation/index.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  describeMemoryPg,
  openMemoryPgScope,
  type MemoryPgScope,
} from './helpers.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-real-pg-'));

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

const memoryStore = await import('../../src/memory-store.js');
const consolidation = await import('../../src/memory-consolidation/index.js');

const CONTEXT = {
  actorId: 'concurrency-owner',
  sourceType: 'web_user' as const,
  sourceId: 'concurrency-test',
  sessionId: null,
};

function jid(tag: string): string {
  return `web:real-pg-${tag}-${randomUUID().slice(0, 8)}`;
}

async function createStoreItem(workspaceJid: string, content: string) {
  return await memoryStore.createWorkspaceMemoryItem({
    workspaceJid,
    value: { kind: 'fact', content },
    context: CONTEXT,
  });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: unknown })?.code as string | undefined;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** No raw 23505 or constraint text may leak out of a raced mutation. */
function expectNoRawViolation(error: unknown): void {
  expect(errorCode(error)).not.toBe('23505');
  expect(errorText(error)).not.toMatch(
    /duplicate key|unique constraint|deadlock detected/i,
  );
}

/** Unwrap after asserting every outcome succeeded; failures rethrow here. */
function unwrap<T>(outcomes: Outcome<T>[]): T[] {
  return outcomes.map((outcome) => {
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  });
}

/** A version chain has no gap: consecutive revisions starting at 1. */
function expectConsecutiveRevisions(revisions: number[]): void {
  const sorted = [...revisions].sort((a, b) => a - b);
  expect(sorted).toEqual(
    Array.from({ length: sorted.length }, (_, index) => index + 1),
  );
}

async function allStatuses(workspaceJid: string) {
  const results = await Promise.all(
    (['active', 'superseded'] as const).map((status) =>
      memoryStore.listWorkspaceMemoryItems({
        workspaceJid,
        status,
        limit: 100,
      }),
    ),
  );
  return { items: results.flatMap((result) => result.items) };
}

/**
 * True concurrent idempotency, revision compare-and-set and multi-instance
 * lease behaviour are properties of a pooled external PostgreSQL: PGlite
 * serves one serialized connection, so tests/memory-pg-idempotency-race.test.ts
 * can only simulate the losing side of the race. These tests run the real
 * races against a throwaway database on the test server.
 */
describeMemoryPg('Workspace Memory on real PostgreSQL', () => {
  let scope: MemoryPgScope;

  beforeAll(async () => {
    scope = await openMemoryPgScope();
    // The store singleton opens its own pool on the throwaway database and
    // runs the full startup path (migrations, pg_trgm, bootstrap).
    process.env.MEMORY_DATABASE_URL = scope.url;
    await memoryStore.initWorkspaceMemoryStore();
  });

  afterAll(async () => {
    delete process.env.MEMORY_DATABASE_URL;
    await memoryStore.closeWorkspaceMemoryStore();
    await scope?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('concurrent create with one idempotency key', () => {
    test('same hash: one created, the rest replay, no raw 23505', async () => {
      const workspaceJid = jid('create');
      const key = `create-race-${randomUUID()}`;
      const hash = `hash-${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          settle(
            memoryStore.createWorkspaceMemoryItem({
              workspaceJid,
              value: { kind: 'fact', content: '退款需在七天内统一处理' },
              context: CONTEXT,
              idempotencyKey: key,
              requestHash: hash,
            }),
          ),
        ),
      );

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const values = unwrap(outcomes);
      const itemIds = new Set(values.map((value) => value.item.id));
      expect(itemIds.size).toBe(1);
      expect(values.filter((value) => !value.replayed)).toHaveLength(1);

      const listed = await memoryStore.listWorkspaceMemoryItems({
        workspaceJid,
        limit: 100,
      });
      expect(listed.items).toHaveLength(1);
    });

    test('a different hash on the same key is idempotency_conflict', async () => {
      const workspaceJid = jid('create-conflict');
      const key = `create-conflict-${randomUUID()}`;
      const hash = `hash-${randomUUID()}`;

      const first = await memoryStore.createWorkspaceMemoryItem({
        workspaceJid,
        value: { kind: 'fact', content: '首次创建' },
        context: CONTEXT,
        idempotencyKey: key,
        requestHash: hash,
      });
      expect(first.replayed).toBe(false);

      const conflict = await settle(
        memoryStore.createWorkspaceMemoryItem({
          workspaceJid,
          value: { kind: 'fact', content: '不同请求' },
          context: CONTEXT,
          idempotencyKey: key,
          requestHash: `different-${randomUUID()}`,
        }),
      );
      expect(conflict.ok).toBe(false);
      if (conflict.ok) throw new Error('different hash unexpectedly succeeded');
      expect(errorCode(conflict.error)).toBe('idempotency_conflict');

      // Raced concurrently, the different-hash request must conflict too —
      // never a 500 or an unhandled 23505.
      const raced = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          settle(
            memoryStore.createWorkspaceMemoryItem({
              workspaceJid,
              value: {
                kind: 'fact',
                content:
                  index === 7 ? '竞争的不同请求' : '退款需在七天内统一处理',
              },
              context: CONTEXT,
              idempotencyKey: key,
              requestHash: index === 7 ? `alt-${randomUUID()}` : hash,
            }),
          ),
        ),
      );
      for (const outcome of raced) {
        if (outcome.ok) {
          expect(outcome.value.item.id).toBe(first.item.id);
        } else {
          expect(errorCode(outcome.error)).toBe('idempotency_conflict');
          expectNoRawViolation(outcome.error);
        }
      }
    });
  });

  describe('concurrent update with one idempotency key', () => {
    test('same hash: one applied, the rest replay, version chain intact', async () => {
      const workspaceJid = jid('update');
      const created = await createStoreItem(workspaceJid, '原始事实');
      const key = `update-race-${randomUUID()}`;
      const hash = `hash-${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          settle(
            memoryStore.updateWorkspaceMemoryItem({
              workspaceJid,
              itemId: created.item.id,
              expectedRevision: 1,
              patch: { content: '并发更新后的内容' },
              context: CONTEXT,
              idempotencyKey: key,
              requestHash: hash,
            }),
          ),
        ),
      );

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const values = unwrap(outcomes);
      const itemIds = new Set(values.map((value) => value.item.id));
      expect(itemIds.size).toBe(1);
      expect(values.filter((value) => !value.replayed)).toHaveLength(1);

      const latest = await memoryStore.getWorkspaceMemoryItem(
        workspaceJid,
        created.item.id,
      );
      expect(latest.item.revision).toBe(2);
      expect(latest.item.content).toBe('并发更新后的内容');

      const versions = await memoryStore.listWorkspaceMemoryVersions({
        workspaceJid,
        itemId: created.item.id,
        limit: 50,
      });
      // No gap in the version chain: exactly one create and one update.
      expectConsecutiveRevisions(
        versions.versions.map((version) => version.revision),
      );
      expect(versions.versions).toHaveLength(2);
    });

    test('different requests, same expectedRevision: one wins, rest conflict', async () => {
      const workspaceJid = jid('update-cas');
      const created = await createStoreItem(workspaceJid, 'CAS 基准');

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          settle(
            memoryStore.updateWorkspaceMemoryItem({
              workspaceJid,
              itemId: created.item.id,
              expectedRevision: 1,
              patch: { content: `竞争更新 ${index}` },
              context: CONTEXT,
              idempotencyKey: `cas-${index}-${randomUUID()}`,
              requestHash: `hash-${index}`,
            }),
          ),
        ),
      );

      const winners = outcomes.filter((outcome) => outcome.ok);
      const losers = outcomes.filter((outcome) => !outcome.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(19);
      for (const loser of losers) {
        expect(errorCode(loser.error)).toBe('revision_conflict');
        expectNoRawViolation(loser.error);
      }

      const versions = await memoryStore.listWorkspaceMemoryVersions({
        workspaceJid,
        itemId: created.item.id,
        limit: 50,
      });
      expectConsecutiveRevisions(
        versions.versions.map((version) => version.revision),
      );
      expect(versions.versions).toHaveLength(2);
    });
  });

  describe('concurrent forget with one idempotency key', () => {
    test('same hash: one deleted, the rest replay', async () => {
      const workspaceJid = jid('forget');
      const created = await createStoreItem(workspaceJid, '待删除事实');
      const key = `forget-race-${randomUUID()}`;
      const hash = `hash-${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          settle(
            memoryStore.forgetWorkspaceMemoryItem({
              workspaceJid,
              itemId: created.item.id,
              expectedRevision: 1,
              context: CONTEXT,
              idempotencyKey: key,
              requestHash: hash,
            }),
          ),
        ),
      );

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const values = unwrap(outcomes);
      expect(values.filter((value) => !value.replayed)).toHaveLength(1);

      const latest = await memoryStore.getWorkspaceMemoryItem(
        workspaceJid,
        created.item.id,
      );
      expect(latest.item.status).toBe('deleted');
      expect(latest.item.revision).toBe(2);

      const versions = await memoryStore.listWorkspaceMemoryVersions({
        workspaceJid,
        itemId: created.item.id,
        limit: 50,
      });
      expectConsecutiveRevisions(
        versions.versions.map((version) => version.revision),
      );
      expect(versions.versions).toHaveLength(2);
    });
  });

  describe('concurrent Owner Profile writes', () => {
    test('same hash: one created, the rest replay', async () => {
      const workspaceJid = jid('owner');
      const key = `owner-race-${randomUUID()}`;
      const hash = `hash-${randomUUID()}`;

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          settle(
            memoryStore.mutateCommerceAgentOwnerAddressMemory({
              workspaceJid,
              preferredAddress: '老板',
              context: CONTEXT,
              idempotencyKey: key,
              requestHash: hash,
            }),
          ),
        ),
      );

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      const values = unwrap(outcomes);
      const itemIds = new Set(values.map((value) => value.item.id));
      expect(itemIds.size).toBe(1);
      expect(
        values.filter((value) => !value.replayed && value.changed),
      ).toHaveLength(1);
      for (const outcome of outcomes) {
        // The reserved path must never surface a raw unique violation.
        expectNoRawViolation(outcome.ok ? null : outcome.error);
      }
    });
  });

  test.each([
    'create',
    'update',
    'forget',
    'owner-create',
    'owner-update',
    'owner-clear',
  ] as const)(
    '%s: competing hashes on a fresh key choose one logical winner',
    async (operation) => {
      const workspaceJid = jid(`mixed-${operation}`);
      const ownerOperation = operation.startsWith('owner-');
      const seed =
        operation === 'create' || operation === 'owner-create'
          ? null
          : ownerOperation
            ? await memoryStore.mutateCommerceAgentOwnerAddressMemory({
                workspaceJid,
                preferredAddress: 'old owner',
                context: CONTEXT,
              })
            : await createStoreItem(workspaceJid, 'old item');
      const key = `mixed-${randomUUID()}`;
      const mutate = (hash: string) => {
        const common = {
          workspaceJid,
          context: CONTEXT,
          idempotencyKey: key,
          requestHash: hash,
        };
        if (operation === 'create') {
          return memoryStore.createWorkspaceMemoryItem({
            ...common,
            value: { kind: 'fact', content: hash },
          });
        }
        if (ownerOperation) {
          return memoryStore.mutateCommerceAgentOwnerAddressMemory({
            ...common,
            preferredAddress: hash,
            expectedRevision: seed?.item.revision ?? 0,
            clear: operation === 'owner-clear',
          });
        }
        const revision = {
          itemId: seed!.item.id,
          expectedRevision: seed!.item.revision,
        };
        return operation === 'forget'
          ? memoryStore.forgetWorkspaceMemoryItem({
              ...common,
              ...revision,
              reason: hash,
            })
          : memoryStore.updateWorkspaceMemoryItem({
              ...common,
              ...revision,
              patch: { content: hash },
            });
      };
      // Twenty requests per hash, interleaved on a previously unused key.
      const outcomes = await Promise.all(
        Array.from({ length: 40 }, (_, index) => {
          const hash = index % 2 === 0 ? 'hash-a' : 'hash-b';
          return settle(mutate(hash)).then((outcome) => ({ hash, outcome }));
        }),
      );
      const winners = outcomes.filter(
        ({ outcome }) => outcome.ok && !outcome.value.replayed,
      );
      expect(winners).toHaveLength(1);
      const winningHash = winners[0].hash;
      const successful = outcomes
        .filter(({ hash }) => hash === winningHash)
        .map(({ outcome }) => outcome);
      expect(successful.every((outcome) => outcome.ok)).toBe(true);
      const values = unwrap(successful);
      expect(values.filter((value) => !value.replayed)).toHaveLength(1);
      const { replayed: ignored, ...first } = values[0];
      for (const { replayed, ...value } of values) expect(value).toEqual(first);
      const losing = outcomes.filter(({ hash }) => hash !== winningHash);
      expect(losing).toHaveLength(20);
      for (const { outcome } of losing) {
        if (outcome.ok)
          throw new Error('different hash unexpectedly succeeded');
        expect(errorCode(outcome.error)).toBe('idempotency_conflict');
        expectNoRawViolation(outcome.error);
      }
    },
  );

  describe('nightly consolidation across instances', () => {
    test('a held lease blocks the second instance; takeover after expiry', async () => {
      const workspaceJid = jid('lease');
      // Three items with the same normalized content: one keeper absorbs the
      // other two (deterministic exact-arm merge).
      for (const content of ['相同内容', '相同内容 ', '  相同内容']) {
        await createStoreItem(workspaceJid, content);
      }

      // Frozen clocks: the first run happens on day 1, the takeover run on
      // day 2, so the "last run predates the latest scheduled instant" rule
      // is deterministic instead of depending on the wall clock.
      const day1 = new Date('2026-01-02T04:00:00.000Z');
      const day2 = new Date('2026-01-03T04:00:00.000Z');
      const settings = {
        enabled: true,
        time: '03:30',
        batchSize: 50,
        maxRuntimeMs: 60_000,
      };

      // A worker mid-run holds the lease (acquired directly, exactly what
      // runMemoryConsolidationOnDatabase does internally).
      await memoryStore.withWorkspaceMemoryDatabase(async (db) => {
        const acquired = await consolidation.acquireConsolidationLease(db, {
          workspaceJid,
          owner: 'worker-a',
          now: day1,
          ttlMs: settings.maxRuntimeMs + 60_000,
        });
        expect(acquired).toBe(true);
      });

      // A second instance, its own pool, sees the lease and skips.
      const second = await scope.connect();
      try {
        const skipped = await consolidation.runMemoryConsolidationOnDatabase(
          second,
          {
            reason: 'scheduled',
            settings,
            workspaceJids: [workspaceJid],
            clock: () => day1,
            owner: 'worker-b',
          },
        );
        expect(skipped.workspaces).toHaveLength(1);
        expect(skipped.workspaces[0].leaseHeld).toBe(true);
        expect(skipped.workspaces[0].merged).toBe(0);
        expect(skipped.workspaces[0].demoted).toBe(0);

        // The holder finishes and releases; a later run consolidates for
        // real, and the result matches a single-instance run: two items
        // merged into the keeper, all three still present as versions.
        await memoryStore.withWorkspaceMemoryDatabase(async (db) => {
          await consolidation.releaseConsolidationLease(db, {
            workspaceJid,
            owner: 'worker-a',
            now: day1,
          });
        });
        const consolidated =
          await consolidation.runMemoryConsolidationOnDatabase(second, {
            reason: 'scheduled',
            settings,
            workspaceJids: [workspaceJid],
            clock: () => day1,
            owner: 'worker-b',
          });
        expect(consolidated.workspaces).toHaveLength(1);
        expect(consolidated.workspaces[0].leaseHeld).toBeUndefined();
        expect(consolidated.workspaces[0].status).toBe('success');
        expect(consolidated.workspaces[0].merged).toBe(2);

        const listed = await allStatuses(workspaceJid);
        expect(
          listed.items.filter((item) => item.status === 'active'),
        ).toHaveLength(1);
        expect(
          listed.items.filter((item) => item.status === 'superseded'),
        ).toHaveLength(2);
        for (const item of listed.items) {
          const versions = await memoryStore.listWorkspaceMemoryVersions({
            workspaceJid,
            itemId: item.id,
            limit: 50,
          });
          expect(versions.versions.length).toBeGreaterThanOrEqual(1);
        }

        // A crashed instance's expired lease is taken over by the next one.
        await second.query(
          `UPDATE workspace_memory_consolidation_state
           SET lease_owner = 'crashed-worker',
               lease_expires_at = '2026-01-02T00:00:00.000Z'
           WHERE workspace_jid = $1`,
          [workspaceJid],
        );
        const takeover = await consolidation.runMemoryConsolidationOnDatabase(
          second,
          {
            reason: 'scheduled',
            settings,
            workspaceJids: [workspaceJid],
            clock: () => day2,
            owner: 'worker-c',
          },
        );
        expect(takeover.workspaces).toHaveLength(1);
        expect(takeover.workspaces[0].leaseHeld).toBeUndefined();
        expect(takeover.workspaces[0].status).toBe('success');
        // Nothing left to merge on the second day: the store is stable.
        expect(takeover.workspaces[0].merged).toBe(0);
      } finally {
        await second.close();
      }
    });

    test('two instances raced over one workspace merge each item once', async () => {
      const workspaceJid = jid('lease-race');
      for (const content of ['重复事实', '重复事实 ']) {
        await createStoreItem(workspaceJid, content);
      }
      const settings = {
        enabled: true,
        time: '03:30',
        batchSize: 50,
        maxRuntimeMs: 60_000,
      };

      // Both instances start together on a workspace that has never
      // consolidated; each uses its own connection pool.
      const second = await scope.connect();
      try {
        const summaries = await Promise.all([
          memoryStore.withWorkspaceMemoryDatabase((db) =>
            consolidation.runMemoryConsolidationOnDatabase(db, {
              reason: 'scheduled',
              settings,
              workspaceJids: [workspaceJid],
              owner: 'worker-a',
            }),
          ),
          consolidation.runMemoryConsolidationOnDatabase(second, {
            reason: 'scheduled',
            settings,
            workspaceJids: [workspaceJid],
            owner: 'worker-b',
          }),
        ]);

        const runs = summaries.flatMap((summary) => summary.workspaces);
        // No run failed and no run was partial.
        for (const run of runs) {
          expect(run.status).toBe('success');
        }
        // Exactly one instance performed actual work; the other either saw
        // the lease held or arrived after the winner recorded its run.
        const executed = runs.filter(
          (run) => run.leaseHeld === undefined && run.merged + run.demoted > 0,
        );
        expect(executed).toHaveLength(1);
        // The duplicate pair was merged exactly once in total.
        expect(summaries.reduce((total, s) => total + s.merged, 0)).toBe(1);

        const listed = await allStatuses(workspaceJid);
        expect(
          listed.items.filter((item) => item.status === 'active'),
        ).toHaveLength(1);
        expect(
          listed.items.filter((item) => item.status === 'superseded'),
        ).toHaveLength(1);
        // Every merged item's version chain stays complete.
        for (const item of listed.items) {
          const versions = await memoryStore.listWorkspaceMemoryVersions({
            workspaceJid,
            itemId: item.id,
            limit: 50,
          });
          expectConsecutiveRevisions(versions.versions.map((v) => v.revision));
        }
      } finally {
        await second.close();
      }
    });
  });

  test('two independent worker handles match single-worker merge and demotion results', async () => {
    const concurrentJid = jid('worker-pair');
    const singleJid = jid('worker-single');
    for (const workspaceJid of [concurrentJid, singleJid]) {
      await createStoreItem(workspaceJid, 'same duplicate fact');
      await createStoreItem(workspaceJid, 'same duplicate fact');
      await memoryStore.createWorkspaceMemoryItem({
        workspaceJid,
        value: {
          kind: 'open_loop',
          content: 'expired followup',
          expiresAt: '2026-01-01T00:00:00.000Z',
        },
        context: CONTEXT,
      });
    }
    const first = await scope.connect();
    const second = await scope.connect();
    const settings = {
      enabled: true,
      time: '03:30',
      batchSize: 50,
      maxRuntimeMs: 60_000,
    };
    const clock = () => new Date('2026-01-02T04:00:00.000Z');
    const standalone = await consolidation.runMemoryConsolidationOnDatabase(
      first,
      {
        reason: 'scheduled',
        settings,
        clock,
        workspaceJids: [singleJid],
      },
    );
    let arrivals = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed: Promise<ConsolidationRunSummary>[] = [];
    const workers = [first, second].map((database, index) => {
      let resolve!: (result: ConsolidationRunSummary) => void;
      let reject!: (error: unknown) => void;
      completed.push(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      return consolidation.startMemoryConsolidationWorker({
        clock,
        settings: () => settings,
        pollMs: 60_000,
        run: async (input) => {
          arrivals += 1;
          if (arrivals === 2) release();
          await together;
          try {
            const result = await consolidation.runMemoryConsolidationOnDatabase(
              database,
              {
                ...input!,
                workspaceJids: [concurrentJid],
                owner: `handle-${index}`,
              },
            );
            resolve(result);
            return result;
          } catch (error) {
            reject(error);
            throw error;
          }
        },
      });
    });
    try {
      const summaries = await Promise.all(completed);
      const actualRuns = summaries
        .flatMap((summary) => summary.workspaces)
        .filter((run) => !run.leaseHeld);
      expect(actualRuns).toHaveLength(1);
      expect(actualRuns[0].status).toBe('success');
      expect(summaries.reduce((sum, result) => sum + result.merged, 0)).toBe(
        standalone.merged,
      );
      expect(summaries.reduce((sum, result) => sum + result.demoted, 0)).toBe(
        standalone.demoted,
      );
      expect(standalone.merged).toBe(1);
      expect(standalone.demoted).toBe(1);
      const state = async (workspaceJid: string) => {
        const listed = await allStatuses(workspaceJid);
        return listed.items
          .map((item) => ({
            content: item.content,
            kind: item.kind,
            status: item.status,
            revision: item.revision,
            importance: item.importance,
            searchKeys: item.searchKeys,
            demotedAt: item.demotedAt,
            superseded: Boolean(item.supersededBy),
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      };
      expect(await state(concurrentJid)).toEqual(await state(singleJid));
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
  });

  test('a contender with a stale due snapshot does not execute after the winner releases', async () => {
    const workspaceJid = jid('stale-due');
    await createStoreItem(workspaceJid, 'stable memory');
    const second = await scope.connect();
    let ready!: () => void;
    const snapshotRead = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release!: () => void;
    const winnerFinished = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;
    const delayed = {
      ...second,
      query: async (...args: Parameters<typeof second.query>) => {
        const result = await second.query(...args);
        if (
          !intercepted &&
          args[0].includes('SELECT * FROM workspace_memory_consolidation_state')
        ) {
          intercepted = true;
          ready();
          await winnerFinished;
        }
        return result;
      },
    } as typeof second;
    const settings = {
      enabled: true,
      time: '03:30',
      batchSize: 50,
      maxRuntimeMs: 60_000,
    };
    const clock = () => new Date('2026-01-02T04:00:00.000Z');
    const contender = consolidation.runMemoryConsolidationOnDatabase(delayed, {
      reason: 'scheduled',
      settings,
      clock,
      workspaceJids: [workspaceJid],
      owner: 'late-worker',
    });
    try {
      await snapshotRead;
      const winner = await memoryStore.withWorkspaceMemoryDatabase((db) =>
        consolidation.runMemoryConsolidationOnDatabase(db, {
          reason: 'scheduled',
          settings,
          clock,
          workspaceJids: [workspaceJid],
          owner: 'early-worker',
        }),
      );
      expect(winner.workspaces).toHaveLength(1);
    } finally {
      release();
    }
    const result = await contender;
    expect(result.workspaces).toHaveLength(0);
  });

  describe('pool saturation', () => {
    test('more concurrent transactions than pool max (10) complete without deadlock', async () => {
      const workspaceJid = jid('pool');

      // 40 concurrent creates through one pool of at most 10 clients: the
      // pool queues the transactions instead of deadlocking or timing out.
      const created = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          memoryStore.createWorkspaceMemoryItem({
            workspaceJid,
            value: { kind: 'fact', content: `池压测事实 ${index}` },
            context: CONTEXT,
            idempotencyKey: `pool-${index}-${randomUUID()}`,
            requestHash: `hash-${index}`,
          }),
        ),
      );
      expect(created).toHaveLength(40);

      const searched = await Promise.all(
        created.map((item) =>
          memoryStore.searchWorkspaceMemoryItems({
            workspaceJid,
            query: item.item.content,
            limit: 5,
          }),
        ),
      );
      for (const result of searched) {
        expect(result.hits.length).toBeGreaterThanOrEqual(1);
      }

      const listed = await memoryStore.listWorkspaceMemoryItems({
        workspaceJid,
        limit: 100,
      });
      expect(listed.items).toHaveLength(40);
    });
  });
});
