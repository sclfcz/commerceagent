import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import { SleepExecutor } from '../../src/distributed/executors.js';
import { Reaper } from '../../src/distributed/reaper.js';
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

describeMysql('cancellation', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;
  let worker: Worker;
  let reaper: Reaper;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool);
    const config = testConfig({
      workerId: 'cancel-worker',
      concurrency: 1,
      heartbeatMs: 150,
      leaseMs: 900,
      pollMs: 20,
    });
    worker = new Worker({
      repository,
      executor: new SleepExecutor(),
      config,
    });
    reaper = new Reaper(repository, { intervalMs: 100 });
    worker.start();
    reaper.start();
  });

  afterAll(async () => {
    await reaper?.stop();
    await worker?.stop();
    await pool?.end();
    release?.();
  });

  test('cancelling a running run aborts it within one heartbeat period', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'long-running',
      idempotencyKey: 'cancel-1',
      payload: { sleepMs: 15_000 },
      maxAttempts: 3,
    });

    await waitFor(async () => worker.inFlight === 1, {
      label: 'worker to start the run',
      timeoutMs: 10_000,
    });
    expect((await repository.getRun(run.id))?.status).toBe('running');

    const cancelledAt = Date.now();
    expect(await repository.cancel(run.id)).toBe(true);

    // The worker notices through its heartbeat (150ms) and aborts the executor.
    await waitFor(async () => worker.inFlight === 0, {
      label: 'worker to abort the cancelled run',
      timeoutMs: 5_000,
      intervalMs: 25,
    });
    const abortLatencyMs = Date.now() - cancelledAt;
    expect(abortLatencyMs).toBeLessThan(1_500);

    const row = await repository.getRun(run.id);
    expect(row?.status).toBe('cancelled');
    expect(row?.lease_owner).toBeNull();
    expect(row?.lease_expires_at).toBeNull();
    expect(await repository.countEvents(run.id, 'cancelled')).toBe(1);
    // A cancelled run must never be reported as finished by the worker.
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(0);
    expect(await repository.countEvents(run.id, 'dead')).toBe(0);
    expect(await repository.countEvents(run.id, 'failed_retry')).toBe(0);

    // The reaper must not resurrect a cancelled run.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await repository.getRun(run.id))?.status).toBe('cancelled');
  });

  test('cancelling a queued run prevents it from being claimed', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'queued-cancel',
      idempotencyKey: 'cancel-2',
      payload: { sleepMs: 1 },
    });
    expect(await repository.cancel(run.id)).toBe(true);
    expect((await repository.getRun(run.id))?.status).toBe('cancelled');
    expect(await repository.claim('another-worker', 10)).toHaveLength(0);
    // Terminal states are not cancellable again.
    expect(await repository.cancel(run.id)).toBe(false);
    expect(
      await repository.cancel('00000000-0000-0000-0000-000000000000'),
    ).toBe(false);
  });
});
