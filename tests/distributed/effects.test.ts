import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import {
  DurableContext,
  EffectPermanentError,
  EffectRequestMismatchError,
  LeaseLostError,
  NeedsReviewError,
  RetryableEffectError,
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

/** Expire the lease and reap, retrying in case a concurrent reaper won the row. */
async function reapUntilRetryWait(repository: RunRepository, runId: string) {
  await repository.forceExpireLease(runId);
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await repository.getRun(runId);
    if (row?.status === 'retry_wait') return;
    await repository.reapExpired(10);
    await sleep(50);
  }
  throw new Error(`run ${runId} was not reaped`);
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
      `SELECT status, provider_ref, attempts, last_error, send_started_at
         FROM dist_run_steps WHERE run_id = ? AND step_key = ?`,
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
    await reapUntilRetryWait(repository, run.id);
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

  test('reconciliation waits out the provider tail latency instead of resending', async () => {
    await clearRuns(pool);
    // Deterministic stand-in for "the provider is still working": the first
    // send never settles, and lookup only finds the message once we mark it
    // delivered.
    let delivered = false;
    let lookups = 0;
    let sends = 0;
    const provider: EffectProvider = {
      name: 'slow',
      supportsLookup: true,
      send: (_request, _key, signal) => {
        sends += 1;
        // Never succeeds, but honours the abort so the "killed" worker stops.
        return new Promise<{ ref: string }>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      },
      lookup: async () => {
        lookups += 1;
        return delivered ? { ref: 'msg-1' } : null;
      },
    };
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('race'),
        taskId: 'race',
        idempotencyKey: 'race-1',
        payload: {},
        maxAttempts: 3,
      });
      const first = await claimOnce('race-a');
      const abort = new AbortController();
      const ctxA = new DurableContext({
        pool,
        hooks: repository,
        identity: {
          runId: run.id,
          workerId: 'race-a',
          leaseToken: first.leaseToken,
        },
        signal: abort.signal,
        effectTimeoutMs: 500,
        effectSettleMs: 1_000,
      });
      const sending = ctxA.effect('msg-0', { v: 1 }, provider);
      await waitFor(
        async () => {
          const row = await stepRow(run.id, 'msg-0');
          return row?.send_started_at ? row : null;
        },
        { label: 'send to start', timeoutMs: 5_000 },
      );
      abort.abort();
      await expect(sending).rejects.toBeInstanceOf(LeaseLostError);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('intent');
      expect(sends).toBe(1);

      await reapUntilRetryWait(repository, run.id);
      const second = await claimOnce('race-b');
      const statsB = emptyDurableStats();
      const ctxB = contextFor(second, 'race-b', statsB);
      // Still inside the settle window and the message is not visible yet.
      const deferred = await ctxB
        .effect('msg-0', { v: 1 }, provider)
        .catch((error) => error);
      expect(deferred).toBeInstanceOf(RetryableEffectError);
      expect(statsB.reconcileDeferred).toBe(1);
      expect(statsB.reconciledNotFound).toBe(1);
      expect(lookups).toBe(1);
      expect(sends).toBe(1); // no second request while deferring
      const minDelayMs = (deferred as RetryableEffectError).minDelayMs;
      expect(minDelayMs).toBeGreaterThan(0);

      await repository.fail({
        runId: run.id,
        workerId: 'race-b',
        leaseToken: second.leaseToken,
        error: 'deferred',
        retryable: true,
        minDelayMs,
      });
      // The provider finishes processing during the window.
      delivered = true;
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'retry_wait',
        { label: 'run retry_wait', timeoutMs: 5_000 },
      );
      await sleep(minDelayMs + 100);
      const third = await claimOnce('race-c');
      const statsC = emptyDurableStats();
      const ctxC = contextFor(third, 'race-c', statsC);
      const result = await ctxC.effect('msg-0', { v: 1 }, provider);
      expect(result.ref).toBe('msg-1');
      expect(statsC.reconciledCommitted).toBe(1);
      expect(sends).toBe(1);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('committed');
      await repository.cancel(run.id);
    } finally {
      /* no server to close */
    }
  });

  test('503 without lookup is retried directly, not parked for review', async () => {
    await clearRuns(pool);
    const mock = await startMock({
      honorIdempotency: true,
      lookup: false,
      errorRate: 1,
    });
    const provider = new HttpEffectProvider({
      baseUrl: mock.url,
      supportsLookup: false,
    });
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('503'),
        taskId: '503',
        idempotencyKey: '503-1',
        payload: {},
        maxAttempts: 3,
      });
      const first = await claimOnce('notapplied-a');
      const statsA = emptyDurableStats();
      const ctxA = contextFor(first, 'notapplied-a', statsA);
      await expect(
        ctxA.effect('msg-0', { v: 1 }, provider),
      ).rejects.toBeInstanceOf(RetryableEffectError);
      expect(statsA.notAppliedRetries).toBe(1);
      const row = await stepRow(run.id, 'msg-0');
      expect(row?.status).toBe('intent');
      expect(row?.send_started_at).toBeNull();
      expect(Number(row?.attempts)).toBe(1);

      mock.setOptions({ errorRate: 0 });
      await repository.fail({
        runId: run.id,
        workerId: 'notapplied-a',
        leaseToken: first.leaseToken,
        error: 'not applied',
        retryable: true,
      });
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'retry_wait',
        { label: 'run retry_wait', timeoutMs: 5_000 },
      );
      await sleep(60);
      const second = await claimOnce('notapplied-b');
      const ctxB = contextFor(second, 'notapplied-b');
      await ctxB.effect('msg-0', { v: 1 }, provider);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('committed');
      expect((await repository.getRun(run.id))?.status).not.toBe(
        'needs_review',
      );
      expect(mock.stats.deliveredMessages).toBe(1);
      await repository.cancel(run.id);
    } finally {
      await mock.close();
    }
  });

  test('an intent without send_started_at is sent without any lookup', async () => {
    await clearRuns(pool);
    const mock = await startMock({ honorIdempotency: true, lookup: true });
    let lookups = 0;
    const provider: EffectProvider = {
      name: 'counting',
      supportsLookup: true,
      lookup: async () => {
        lookups += 1;
        return null;
      },
      send: async () => {
        const response = await fetch(`${mock.url}/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${runIdRef}:msg-0`,
          },
          body: '{}',
        });
        const body = (await response.json()) as { message_id: string };
        return { ref: body.message_id };
      },
    };
    let runIdRef = '';
    try {
      const { run } = await repository.submit({
        tenantId: uniqueTenant('nosend'),
        taskId: 'nosend',
        idempotencyKey: 'nosend-1',
        payload: {},
      });
      runIdRef = run.id;
      const claim = await claimOnce('nosend-a');
      // The previous worker wrote the intent and died before sending.
      await pool.query(
        `INSERT INTO dist_run_steps
           (run_id, step_key, kind, status, lease_token, idempotency_key,
            request_hash, attempts, created_at, updated_at)
         VALUES (?, 'msg-0', 'effect', 'intent', 1, ?, SHA2('{"v":1}', 256), 0, NOW(3), NOW(3))`,
        [run.id, `${run.id}:msg-0`],
      );
      const ctx = contextFor(claim, 'nosend-a');
      await ctx.effect('msg-0', { v: 1 }, provider);
      expect(lookups).toBe(0);
      expect((await stepRow(run.id, 'msg-0'))?.status).toBe('committed');
      expect(mock.stats.deliveredMessages).toBe(1);
      await repository.cancel(run.id);
    } finally {
      await mock.close();
    }
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
