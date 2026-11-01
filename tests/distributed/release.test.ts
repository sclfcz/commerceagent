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

describeMysql('graceful release', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, { leaseMs: 700 });
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('stop() returns in-flight runs without consuming an attempt', async () => {
    await clearRuns(pool);
    const worker = new Worker({
      repository,
      executor: new SleepExecutor(),
      config: testConfig({
        workerId: 'stopping-worker',
        concurrency: 1,
        heartbeatMs: 200,
        leaseMs: 700,
        pollMs: 20,
      }),
    });
    worker.start();
    try {
      const tenantId = uniqueTenant();
      const { run } = await repository.submit({
        tenantId,
        taskId: 'long-run',
        idempotencyKey: 'release-1',
        payload: { sleepMs: 30_000 },
        maxAttempts: 3,
      });
      await waitFor(async () => worker.inFlight === 1, {
        label: 'worker to start the run',
        timeoutMs: 10_000,
      });
      const beforeStop = await repository.getRun(run.id);
      expect(beforeStop?.status).toBe('running');
      expect(beforeStop?.attempt).toBe(1);

      // stop() waits up to leaseMs (700ms), then releases before aborting.
      await worker.stop();
      expect(worker.inFlight).toBe(0);

      const afterStop = await repository.getRun(run.id);
      expect(afterStop?.status).toBe('queued');
      expect(afterStop?.attempt).toBe(0);
      expect(afterStop?.lease_owner).toBeNull();
      expect(afterStop?.lease_expires_at).toBeNull();
      expect(await repository.countEvents(run.id, 'released')).toBe(1);
      // A graceful stop is not a lost lease: no fencing violation is recorded.
      expect(await repository.countEvents(run.id, 'stale_write_rejected')).toBe(
        0,
      );
      expect(await repository.countEvents(run.id, 'succeeded')).toBe(0);

      const events = await repository.getEvents(run.id);
      expect(events.map((event) => event.event)).toEqual([
        'submitted',
        'claimed',
        'released',
      ]);

      // Another worker picks it up immediately, with the attempt budget intact.
      const takenOver = await repository.claim('other-worker', 1);
      expect(takenOver).toHaveLength(1);
      expect(takenOver[0].runId).toBe(run.id);
      expect(takenOver[0].attempt).toBe(1);
      expect(takenOver[0].leaseToken).toBe(beforeStop!.lease_token + 2);

      // Leave nothing running for the next test file.
      expect(await repository.cancel(run.id)).toBe(true);
    } finally {
      await worker.stop();
    }
  });
});
