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

describeMysql('heartbeat', () => {
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

  test('a live lease is extended', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'heartbeat-live',
      idempotencyKey: 'hb-1',
      payload: {},
    });
    const claim = (await repository.claim('worker-hb', 1))[0];
    const before = await repository.getRun(run.id);
    await sleep(50);
    expect(
      await repository.heartbeat({
        runId: run.id,
        workerId: 'worker-hb',
        leaseToken: claim.leaseToken,
      }),
    ).toBe(true);
    const after = await repository.getRun(run.id);
    expect(after!.lease_expires_at!.getTime()).toBeGreaterThan(
      before!.lease_expires_at!.getTime(),
    );
    expect(after!.status).toBe('running');
    expect(await repository.countEvents(run.id, 'stale_write_rejected')).toBe(
      0,
    );
  });

  test('an expired lease is not resurrected and the heartbeat returns false', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'heartbeat-dead',
      idempotencyKey: 'hb-2',
      payload: {},
    });
    const claim = (await repository.claim('worker-hb', 1))[0];
    await sleep(LEASE_MS + 300);

    const expired = await repository.getRun(run.id);
    expect(expired?.status).toBe('running');

    const applied = await repository.heartbeat({
      runId: run.id,
      workerId: 'worker-hb',
      leaseToken: claim.leaseToken,
    });
    expect(applied).toBe(false);

    const after = await repository.getRun(run.id);
    expect(after!.lease_expires_at!.toISOString()).toBe(
      expired!.lease_expires_at!.toISOString(),
    );
    expect(
      await repository.countEvents(run.id, 'stale_write_rejected'),
    ).toBeGreaterThanOrEqual(1);
  });

  test('a heartbeat from another owner is rejected', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const { run } = await repository.submit({
      tenantId,
      taskId: 'heartbeat-other-owner',
      idempotencyKey: 'hb-3',
      payload: {},
    });
    const claim = (await repository.claim('worker-hb', 1))[0];
    expect(
      await repository.heartbeat({
        runId: run.id,
        workerId: 'worker-hb',
        leaseToken: claim.leaseToken,
      }),
    ).toBe(true);
    expect(
      await repository.heartbeat({
        runId: run.id,
        workerId: 'worker-impostor',
        leaseToken: claim.leaseToken,
      }),
    ).toBe(false);
    expect(
      await repository.heartbeat({
        runId: run.id,
        workerId: 'worker-hb',
        leaseToken: claim.leaseToken + 1,
      }),
    ).toBe(false);
  });
});
