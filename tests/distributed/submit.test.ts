import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  IdempotencyConflictError,
  RunRepository,
  payloadDigest,
} from '../../src/distributed/run-repository.js';
import type { Pool } from '../../src/distributed/mysql.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeMysql,
  makeRepository,
  resetSchema,
  uniqueTenant,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

describeMysql('submit idempotency', () => {
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

  test('the same key and payload returns the existing run', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const input = {
      tenantId,
      taskId: 'policy-check',
      idempotencyKey: 'order-1-refund',
      payload: { orderId: 'ORD-100', sleepMs: 5 },
    };
    const first = await repository.submit(input);
    const second = await repository.submit(input);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe('queued');
    expect(await repository.countEvents(first.run.id, 'submitted')).toBe(1);

    const [{ total }] = (
      await pool.query(
        'SELECT COUNT(*) AS total FROM dist_task_runs WHERE tenant_id = ?',
        [tenantId],
      )
    )[0] as Array<{ total: number }>;
    expect(Number(total)).toBe(1);
  });

  test('the same key with a different payload is a conflict', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const base = {
      tenantId,
      taskId: 'policy-check',
      idempotencyKey: 'shared-key',
    };
    await repository.submit({ ...base, payload: { amount: 108 } });
    await expect(
      repository.submit({ ...base, payload: { amount: 999 } }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    // Key order must not matter for the digest.
    expect(payloadDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(
      payloadDigest({ b: { d: 3, c: 2 }, a: 1 }),
    );
    await expect(
      repository.submit({
        ...base,
        idempotencyKey: 'other-key',
        payload: { amount: 108 },
      }),
    ).resolves.toMatchObject({ created: true });
  });

  test('20 concurrent submits with one key produce one row', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    const input = {
      tenantId,
      taskId: 'concurrent',
      idempotencyKey: 'burst-key',
      payload: { items: ['a', 'b'], nested: { beta: 2, alpha: 1 } },
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repository.submit(input)),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);

    const rows = (
      await pool.query('SELECT id FROM dist_task_runs WHERE tenant_id = ?', [
        tenantId,
      ])
    )[0] as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(await repository.countEvents(results[0].run.id, 'submitted')).toBe(
      1,
    );
  });
});
