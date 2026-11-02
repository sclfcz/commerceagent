import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import {
  DurableContext,
  emptyDurableStats,
} from '../../src/distributed/durable.js';
import {
  RetryableError,
  type Executor,
} from '../../src/distributed/executors.js';
import { HttpEffectProvider } from '../../src/distributed/http-effect-provider.js';
import { Worker } from '../../src/distributed/worker.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeMysql,
  makeRepository,
  resetSchema,
  sleep,
  testConfig,
  uniqueTenant,
  waitFor,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

type MockProvider = {
  url: string;
  stats: { deliveredMessages: number; duplicateDeliveries: number };
  close(): Promise<void>;
};

async function startMock(options: Record<string, unknown> = {}) {
  const module = (await import('../../scripts/mock-effect-provider.mjs')) as {
    startMockProvider: (o?: Record<string, unknown>) => Promise<MockProvider>;
  };
  return module.startMockProvider({ honorIdempotency: true, ...options });
}

describeMysql('durable steps', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;
  let mock: MockProvider;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, { leaseMs: 5_000 });
    mock = await startMock();
  });

  afterAll(async () => {
    await mock?.close();
    await pool?.end();
    release?.();
  });

  test('a retry replays committed steps from the checkpoint', async () => {
    await clearRuns(pool);
    const calls = { steps: [0, 0, 0, 0] };
    const provider = new HttpEffectProvider({
      baseUrl: mock.url,
      supportsLookup: true,
    });

    const executor: Executor = {
      async execute(run, ctx) {
        for (let index = 0; index < 4; index++) {
          await ctx.step(`step-${index}`, async () => {
            calls.steps[index] += 1;
            await sleep(5);
            // The 4th step fails on the first attempt only.
            if (index === 3 && run.attempt === 1)
              throw new RetryableError('flaky step');
            return { index };
          });
          if (index < 2) {
            await ctx.effect(`msg-${index}`, { index }, provider);
          }
        }
      },
    };

    const worker = new Worker({
      repository,
      executor,
      config: testConfig({
        workerId: 'durable-worker',
        concurrency: 1,
        heartbeatMs: 500,
        leaseMs: 5_000,
        pollMs: 20,
        backoffBaseMs: 20,
        backoffMaxMs: 40,
      }),
    });
    worker.start();
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('durable'),
        taskId: 'durable',
        idempotencyKey: 'durable-1',
        payload: {},
        maxAttempts: 3,
      });
      const finished = await waitFor(
        async () => {
          const row = await repository.getRun(run.id);
          return row && ['succeeded', 'dead'].includes(row.status) ? row : null;
        },
        { label: 'run to finish', timeoutMs: 20_000 },
      );
      expect(finished.status).toBe('succeeded');
      expect(finished.attempt).toBe(2);

      // Retried steps never ran again; the flaky step ran twice.
      expect(calls.steps).toEqual([1, 1, 1, 2]);

      const [steps] = await pool.query(
        `SELECT step_key, kind, status FROM dist_run_steps
          WHERE run_id = ? ORDER BY step_key`,
        [run.id],
      );
      expect(steps).toHaveLength(6);
      expect(
        (steps as Array<{ status: string }>).every(
          (row) => row.status === 'committed',
        ),
      ).toBe(true);
      expect(mock.stats.deliveredMessages).toBe(2);
      expect(mock.stats.duplicateDeliveries).toBe(0);

      const [skipped] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_run_events
          WHERE run_id = ? AND event = 'step_skipped'`,
        [run.id],
      );
      expect(Number((skipped as Array<{ total: number }>)[0].total)).toBe(5);
      expect(worker.stats().durable.stepsSkippedFromCheckpoint).toBe(5);
    } finally {
      await worker.stop();
    }
  });

  test('a committed step returns its output without calling fn again', async () => {
    await clearRuns(pool);
    const { run } = await repository.submit({
      tenantId: uniqueTenant('step'),
      taskId: 'step',
      idempotencyKey: 'step-1',
      payload: {},
    });
    const claim = (await repository.claim('step-worker', 1))[0];
    const stats = emptyDurableStats();
    const ctx = new DurableContext({
      pool,
      hooks: repository,
      identity: {
        runId: run.id,
        workerId: 'step-worker',
        leaseToken: claim.leaseToken,
      },
      signal: new AbortController().signal,
      stats,
    });
    let calls = 0;
    expect(await ctx.step('calc', async () => ++calls)).toBe(1);
    expect(await ctx.step('calc', async () => ++calls)).toBe(1);
    expect(calls).toBe(1);
    expect(stats.stepsExecuted).toBe(1);
    expect(stats.stepsSkippedFromCheckpoint).toBe(1);
    await repository.cancel(run.id);
  });
});
