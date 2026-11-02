import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeMysql,
  makeRepository,
  resetSchema,
  sleep,
  uniqueTenant,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const LEASE_MS = 800;

describeMysql('fencing token', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, { leaseMs: LEASE_MS });
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('an expired worker cannot overwrite the takeover worker result', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'fenced',
      idempotencyKey: 'fenced-1',
      payload: { sleepMs: 1 },
      maxAttempts: 3,
    });

    const first = (await repository.claim('worker-a', 1))[0];
    expect(first.runId).toBe(run.id);

    // Let the lease expire without heartbeats, then let the reaper take it.
    await sleep(LEASE_MS + 250);
    const reaped = await repository.reapExpired(10);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].nextStatus).toBe('retry_wait');

    const takeover = (await repository.claim('worker-b', 1))[0];
    expect(takeover.runId).toBe(run.id);
    expect(takeover.attempt).toBe(2);
    expect(takeover.leaseToken).toBe(3);

    const staleAccepted = await repository.complete({
      runId: run.id,
      workerId: 'worker-a',
      leaseToken: first.leaseToken,
      result: { from: 'worker-a' },
    });
    expect(staleAccepted).toBe(false);

    const midFlight = await repository.getRun(run.id);
    expect(midFlight?.status).toBe('running');
    expect(midFlight?.lease_owner).toBe('worker-b');
    expect(midFlight?.result).toBeNull();
    expect(
      await repository.countEvents(run.id, 'stale_write_rejected'),
    ).toBeGreaterThanOrEqual(1);

    const accepted = await repository.complete({
      runId: run.id,
      workerId: 'worker-b',
      leaseToken: takeover.leaseToken,
      result: { from: 'worker-b' },
    });
    expect(accepted).toBe(true);

    const final = await repository.getRun(run.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.result).toEqual({ from: 'worker-b' });
    expect(final?.lease_owner).toBeNull();
    expect(final?.lease_expires_at).toBeNull();
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(1);

    const events = await repository.getEvents(run.id);
    const ordering = events.map((event) => event.event);
    expect(ordering).toEqual([
      'submitted',
      'claimed',
      'reaped',
      'claimed',
      'stale_write_rejected',
      'succeeded',
    ]);
    // The reaped event records the token it invalidated.
    expect(events[2].detail).toMatchObject({
      previousOwner: 'worker-a',
      previousToken: first.leaseToken,
      nextStatus: 'retry_wait',
    });
  });

  test('a stale fail is rejected and leaves the run to the new owner', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'fenced-fail',
      idempotencyKey: 'fenced-2',
      payload: { sleepMs: 1 },
      maxAttempts: 4,
    });
    const first = (await repository.claim('worker-a', 1))[0];
    await sleep(LEASE_MS + 250);
    await repository.reapExpired(10);
    const takeover = (await repository.claim('worker-b', 1))[0];

    const outcome = await repository.fail({
      runId: run.id,
      workerId: 'worker-a',
      leaseToken: first.leaseToken,
      error: 'stale failure',
      retryable: false,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.status).toBeNull();

    const row = await repository.getRun(run.id);
    expect(row?.status).toBe('running');
    expect(row?.attempt).toBe(2);
    expect(row?.lease_owner).toBe('worker-b');
    expect(
      await repository.countEvents(run.id, 'stale_write_rejected'),
    ).toBeGreaterThanOrEqual(1);
    expect(await repository.countEvents(run.id, 'dead')).toBe(0);
    expect(takeover.leaseToken).toBeGreaterThan(first.leaseToken);
  });
});
