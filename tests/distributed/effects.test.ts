import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import {
  DurableContext,
  EffectPermanentError,
  EffectRequestMismatchError,
  LeaseLostError,
  NeedsReviewError,
  emptyDurableStats,
  type EffectProvider,
} from '../../src/distributed/durable.js';
import { HttpEffectProvider } from '../../src/distributed/http-effect-provider.js';
import type { Executor } from '../../src/distributed/executors.js';
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
  setOptions(patch: Record<string, unknown>): void;
  close(): Promise<void>;
};

async function startMock(options: Record<string, unknown> = {}) {
  const module = (await import('../../scripts/mock-effect-provider.mjs')) as {
    startMockProvider: (o?: Record<string, unknown>) => Promise<MockProvider>;
  };
  return module.startMockProvider(options);
}

describeMysql('effect protocol', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, {
      leaseMs: 5_000,
      backoffBaseMs: 20,
      backoffMaxMs: 40,
    });
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  const claimOnce = async (workerId: string) => {
    const claim = (await repository.claim(workerId, 1))[0];
    if (!claim) throw new Error('nothing to claim');
    return claim;
  };

  const contextFor = (
    claim: { runId: string; leaseToken: number },
    workerId: string,
    stats = emptyDurableStats(),
  ) =>
    new DurableContext({
      pool,
      hooks: repository,
      identity: { runId: claim.runId, workerId, leaseToken: claim.leaseToken },
      signal: new AbortController().signal,
      effectTimeoutMs: 2_000,
      stats,
    });

  const stepRow = async (runId: string, stepKey: string) => {
    const [rows] = await pool.query(
      `SELECT status, provider_ref, attempts, last_error FROM dist_run_steps
        WHERE run_id = ? AND step_key = ?`,
      [runId, stepKey],
    );
    return (rows as Array<Record<string, unknown>>)[0] ?? null;
  };

  test('lost receipt + lookup: unknown, then reconciled to committed', async () => {
    await clearRuns(pool);
    const mock = await startMock({
      honorIdempotency: true,
      lookup: true,
      dropResponseRate: 1,
    });
    const provider = new HttpEffectProvider({
      baseUrl: mock.url,
      supportsLookup: true,
    });
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('lost'),
        taskId: 'lost',
        idempotencyKey: 'lost-1',
        payload: {},
        maxAttempts: 3,
      });
      const first = await claimOnce('effect-a');
      const firstStats = emptyDurableStats();
      const ctxA = contextFor(first, 'effect-a', firstStats);
      await expect(ctxA.effect('msg-0', { v: 1 }, provider)).rejects.toThrow(
        /effect_outcome_unknown/,
      );
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('unknown');
      expect(mock.stats.deliveredMessages).toBe(1);

      // Receipts work again; the retry must reconcile instead of resending.
      mock.setOptions({ dropResponseRate: 0 });
      await repository.fail({
        runId: run.id,
        workerId: 'effect-a',
        leaseToken: first.leaseToken,
        error: 'unknown outcome',
        retryable: true,
      });
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'retry_wait',
        { label: 'run to be retryable', timeoutMs: 5_000 },
      );
      await sleep(60);
      const second = await claimOnce('effect-b');
      const secondStats = emptyDurableStats();
      const ctxB = contextFor(second, 'effect-b', secondStats);
      const result = await ctxB.effect('msg-0', { v: 1 }, provider);
      expect(result.ref).toMatch(/^msg-/);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('committed');
      expect(secondStats.reconciledCommitted).toBe(1);
      expect(mock.stats.deliveredMessages).toBe(1);
      expect(mock.stats.duplicateDeliveries).toBe(0);
      await repository.cancel(run.id);
    } finally {
      await mock.close();
    }
  });

  test('lost receipt without lookup: needs_review, no resend', async () => {
    await clearRuns(pool);
    const mock = await startMock({
      honorIdempotency: true,
      lookup: false,
      dropResponseRate: 1,
    });
    const provider = new HttpEffectProvider({
      baseUrl: mock.url,
      supportsLookup: false,
    });
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('nolookup'),
        taskId: 'nolookup',
        idempotencyKey: 'nolookup-1',
        payload: {},
        maxAttempts: 3,
      });
      const first = await claimOnce('effect-a');
      const ctxA = contextFor(first, 'effect-a');
      await expect(ctxA.effect('msg-0', { v: 1 }, provider)).rejects.toThrow(
        /effect_outcome_unknown/,
      );
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('unknown');

      mock.setOptions({ dropResponseRate: 0 });
      await repository.fail({
        runId: run.id,
        workerId: 'effect-a',
        leaseToken: first.leaseToken,
        error: 'unknown outcome',
        retryable: true,
      });
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'retry_wait',
        { label: 'run to be retryable', timeoutMs: 5_000 },
      );
      await sleep(60);
      const second = await claimOnce('effect-b');
      const ctxB = contextFor(second, 'effect-b');
      const error = await ctxB
        .effect('msg-0', { v: 1 }, provider)
        .catch((caught) => caught);
      expect(error).toBeInstanceOf(NeedsReviewError);
      expect((await repository.getRun(run.id))?.status).toBe('needs_review');
      expect(mock.stats.deliveredMessages).toBe(1);
      const [events] = await pool.query(
        `SELECT detail FROM dist_task_run_events
          WHERE run_id = ? AND event = 'needs_review'`,
        [run.id],
      );
      expect(
        (events as Array<{ detail: { stepKey: string } }>)[0].detail.stepKey,
      ).toBe('msg-0');
    } finally {
      await mock.close();
    }
  });

  test('a zombie worker cannot commit after the lease moved on', async () => {
    await clearRuns(pool);
    const { run } = await repository.submit({
      tenantId: uniqueTenant('zombie'),
      taskId: 'zombie',
      idempotencyKey: 'zombie-1',
      payload: {},
      maxAttempts: 3,
    });
    const first = await claimOnce('zombie-a');

    let releaseSend: ((ref: string) => void) | null = null;
    const slowProvider: EffectProvider = {
      name: 'slow',
      supportsLookup: true,
      send: () =>
        new Promise<{ ref: string }>((resolve) => {
          releaseSend = (ref) => resolve({ ref });
        }),
      lookup: async () => null,
    };
    const ctxA = new DurableContext({
      pool,
      hooks: repository,
      identity: {
        runId: run.id,
        workerId: 'zombie-a',
        leaseToken: first.leaseToken,
      },
      signal: new AbortController().signal,
      effectTimeoutMs: 20_000,
    });
    const hanging = ctxA.effect('msg-0', { v: 1 }, slowProvider);
    hanging.catch(() => {});
    await waitFor(
      async () => (await stepRow(run.id, 'msg-0'))?.status === 'intent',
      { label: 'intent row', timeoutMs: 5_000 },
    );

    // A's lease expires; B takes over and commits the same step.
    await repository.forceExpireLease(run.id);
    await repository.reapExpired(10);
    await waitFor(
      async () => (await repository.getRun(run.id))?.status === 'retry_wait',
      { label: 'run reaped', timeoutMs: 5_000 },
    );
    const second = await claimOnce('zombie-b');
    const providerB: EffectProvider = {
      name: 'b',
      supportsLookup: true,
      lookup: async () => ({ ref: 'ref-from-b' }),
      send: async () => ({ ref: 'ref-from-b' }),
    };
    const ctxB = contextFor(second, 'zombie-b');
    await ctxB.effect('msg-0', { v: 1 }, providerB);
    const committed = await stepRow(run.id, 'msg-0');
    expect(committed?.provider_ref).toBe('ref-from-b');

    // A finally gets its "response" and tries to write it: fence must win.
    releaseSend!('ref-from-a');
    await expect(hanging).rejects.toBeInstanceOf(LeaseLostError);
    const finalRow = await stepRow(run.id, 'msg-0');
    expect(finalRow?.provider_ref).toBe('ref-from-b');
    const [tokens] = await pool.query(
      'SELECT lease_token FROM dist_run_steps WHERE run_id = ? AND step_key = ?',
      [run.id, 'msg-0'],
    );
    expect(
      Number((tokens as Array<{ lease_token: number }>)[0].lease_token),
    ).toBe(second.leaseToken);
    await repository.cancel(run.id);
  });

  test('changing the request body for the same step is rejected', async () => {
    await clearRuns(pool);
    const mock = await startMock({ honorIdempotency: true, lookup: true });
    const provider = new HttpEffectProvider({
      baseUrl: mock.url,
      supportsLookup: true,
    });
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('mismatch'),
        taskId: 'mismatch',
        idempotencyKey: 'mismatch-1',
        payload: {},
      });
      const claim = await claimOnce('mismatch-a');
      const ctx = contextFor(claim, 'mismatch-a');
      await ctx.effect('msg-0', { v: 1 }, provider);
      await expect(
        ctx.effect('msg-0', { v: 2 }, provider),
      ).rejects.toBeInstanceOf(EffectRequestMismatchError);
      expect(mock.stats.deliveredMessages).toBe(1);
      await repository.cancel(run.id);
    } finally {
      await mock.close();
    }
  });

  test('a 4xx makes the effect failed and the run dead', async () => {
    await clearRuns(pool);
    const { run } = await repository.submit({
      tenantId: uniqueTenant('4xx'),
      taskId: '4xx',
      idempotencyKey: '4xx-1',
      payload: {},
      maxAttempts: 3,
    });
    const rejecting: EffectProvider = {
      name: 'rejecting',
      supportsLookup: false,
      send: async () => {
        throw new EffectPermanentError('rejected', 400);
      },
    };
    const executor: Executor = {
      async execute(_run, ctx) {
        await ctx.effect('msg-0', { v: 1 }, rejecting);
      },
    };
    const worker = new Worker({
      repository,
      executor,
      config: testConfig({
        workerId: 'reject-worker',
        concurrency: 1,
        heartbeatMs: 500,
        leaseMs: 5_000,
        pollMs: 20,
      }),
    });
    worker.start();
    try {
      const finished = await waitFor(
        async () => {
          const row = await repository.getRun(run.id);
          return row && ['succeeded', 'dead', 'retry_wait'].includes(row.status)
            ? row
            : null;
        },
        { label: 'run to finish', timeoutMs: 15_000 },
      );
      expect(finished.status).toBe('dead');
      expect(finished.attempt).toBe(1);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('failed');
    } finally {
      await worker.stop();
    }
  });
});
