import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import { SleepExecutor } from '../../src/distributed/executors.js';
import { Worker } from '../../src/distributed/worker.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeMysql,
  makeRepository,
  resetSchema,
  testConfig,
  uniqueTenant,
  waitFor,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

describeMysql('retry and dead-letter behaviour', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;
  let worker: Worker;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, { backoffBaseMs: 20, backoffMaxMs: 40 });
    worker = new Worker({
      repository,
      executor: new SleepExecutor(),
      config: testConfig({
        workerId: 'retry-worker',
        concurrency: 2,
        heartbeatMs: 150,
        leaseMs: 900,
        pollMs: 20,
        backoffBaseMs: 20,
        backoffMaxMs: 40,
      }),
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await pool?.end();
    release?.();
  });

  test('two retryable failures then success: attempt 3', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'retry-until-success',
      idempotencyKey: 'retry-1',
      payload: { sleepMs: 5, failTimes: 2 },
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
    expect(finished.attempt).toBe(3);
    expect(finished.finished_at).not.toBeNull();
    expect(finished.lease_owner).toBeNull();
    expect(finished.lease_expires_at).toBeNull();
    expect(await repository.countEvents(run.id, 'failed_retry')).toBe(2);
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(1);
    expect(await repository.countEvents(run.id, 'dead')).toBe(0);

    const events = await repository.getEvents(run.id);
    expect(events.map((event) => event.event)).toEqual([
      'submitted',
      'claimed',
      'failed_retry',
      'claimed',
      'failed_retry',
      'claimed',
      'succeeded',
    ]);
  });

  test('retryable failures past max_attempts become dead', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'retry-until-dead',
      idempotencyKey: 'retry-2',
      payload: { sleepMs: 5, failTimes: 5 },
      maxAttempts: 3,
    });

    const finished = await waitFor(
      async () => {
        const row = await repository.getRun(run.id);
        return row && ['succeeded', 'dead'].includes(row.status) ? row : null;
      },
      { label: 'run to become dead', timeoutMs: 20_000 },
    );

    expect(finished.status).toBe('dead');
    expect(finished.attempt).toBe(3);
    expect(finished.error).toContain('synthetic failure');
    expect(await repository.countEvents(run.id, 'failed_retry')).toBe(2);
    expect(await repository.countEvents(run.id, 'dead')).toBe(1);
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(0);
  });

  test('a non-retryable error goes straight to dead', async () => {
    // Pause the worker so this test owns the claim deterministically.
    await worker.stop();
    try {
      await clearRuns(pool);
      const tenantId = uniqueTenant();
      const { run } = await repository.submit({
        tenantId,
        taskId: 'fatal',
        idempotencyKey: 'retry-3',
        payload: { sleepMs: 1 },
        maxAttempts: 5,
      });
      // A claim we own, then a plain (non-Retryable) failure.
      const claim = (await repository.claim('direct-worker', 1))[0];
      expect(claim.runId).toBe(run.id);
      const outcome = await repository.fail({
        runId: run.id,
        workerId: 'direct-worker',
        leaseToken: claim.leaseToken,
        error: 'unexpected crash',
        retryable: false,
      });
      expect(outcome).toMatchObject({ applied: true, status: 'dead' });
      const row = await repository.getRun(run.id);
      expect(row?.status).toBe('dead');
      expect(row?.attempt).toBe(1);
      expect(await repository.countEvents(run.id, 'dead')).toBe(1);
    } finally {
      worker.start();
    }
  });
});
