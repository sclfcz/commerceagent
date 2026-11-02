import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import { Relay } from '../../src/distributed/relay.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeDist,
  makeRepository,
  resetSchema,
  sleep,
  TEST_AMQP_URL,
  uniqueQueuePrefix,
  uniqueTenant,
  waitFor,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

describeDist('transactional outbox', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('a failing submit leaves neither the run nor the outbox row', async () => {
    await clearRuns(pool);
    // Force the outbox insert to fail after the run row was written: the
    // transaction must roll both back. Renaming the table keeps the production
    // code free of test-only hooks and needs no elevated privileges.
    await pool.query('RENAME TABLE dist_outbox TO dist_outbox_hidden');
    const tenantId = uniqueTenant();
    let failure: unknown = null;
    try {
      await repository.submit({
        tenantId,
        taskId: 'atomic',
        idempotencyKey: 'atomic-1',
        payload: { sleepMs: 1 },
      });
    } catch (error) {
      failure = error;
    } finally {
      await pool.query('RENAME TABLE dist_outbox_hidden TO dist_outbox');
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/dist_outbox/);

    const runs = (
      await pool.query(
        'SELECT COUNT(*) AS total FROM dist_task_runs WHERE tenant_id = ?',
        [tenantId],
      )
    )[0] as Array<{ total: number }>;
    const outbox = (
      await pool.query('SELECT COUNT(*) AS total FROM dist_outbox')
    )[0] as Array<{ total: number }>;
    expect(Number(runs[0].total)).toBe(0);
    expect(Number(outbox[0].total)).toBe(0);
  });

  test('a retry_wait run is not published before its backoff elapses', async () => {
    await clearRuns(pool);
    const prefix = uniqueQueuePrefix('outbox');
    const relay = new Relay({
      pool,
      amqpUrl: TEST_AMQP_URL,
      topology: { queuePrefix: prefix },
      batchSize: 50,
      pollIntervalMs: 50,
    });
    try {
      const tenantId = uniqueTenant();
      const { run } = await repository.submit({
        tenantId,
        taskId: 'backoff',
        idempotencyKey: 'backoff-1',
        payload: { sleepMs: 1 },
        maxAttempts: 3,
      });

      // The submit row is due immediately.
      expect((await relay.tick()).published).toBe(1);

      const claim = (await repository.claim('backoff-worker', 1))[0];
      await repository.fail({
        runId: run.id,
        workerId: 'backoff-worker',
        leaseToken: claim.leaseToken,
        error: 'transient',
        retryable: true,
      });

      const pending = (
        await pool.query(
          `SELECT id, status, available_at, TIMESTAMPDIFF(MICROSECOND, NOW(3), available_at) AS wait_us
           FROM dist_outbox WHERE run_id = ? AND status = 'pending'`,
          [run.id],
        )
      )[0] as Array<{ id: number; wait_us: number }>;
      expect(pending).toHaveLength(1);
      const backoffMs = Math.round(Number(pending[0].wait_us) / 1000);
      expect(backoffMs).toBeGreaterThan(0);

      // Before the backoff expires the relay must leave the row alone.
      expect((await relay.tick()).published).toBe(0);
      expect(
        (
          (
            await pool.query('SELECT status FROM dist_outbox WHERE id = ?', [
              pending[0].id,
            ])
          )[0] as Array<{ status: string }>
        )[0].status,
      ).toBe('pending');

      await waitFor(async () => (await relay.tick()).published > 0, {
        label: 'outbox row to become due',
        timeoutMs: 10_000,
      });
      expect(
        (
          (
            await pool.query('SELECT status FROM dist_outbox WHERE id = ?', [
              pending[0].id,
            ])
          )[0] as Array<{ status: string }>
        )[0].status,
      ).toBe('published');
    } finally {
      await relay.stop();
      await sleep(10);
    }
  });
});
