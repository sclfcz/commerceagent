import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { TenantSlots } from '../../src/distributed/tenant-slots.js';
import { clearDistKeys, createTestRedis, describeRedis } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describeRedis('tenant slots', () => {
  let redis: Redis;
  let slots: TenantSlots;
  // Unique namespace: test files share one Redis DB and run in parallel.
  const namespace = `test-slots-${randomUUID().slice(0, 8)}`;
  const tenant = `${namespace}-tenant`;
  const keys = `dist:slots:${namespace}*`;

  beforeAll(async () => {
    redis = await createTestRedis();
    await clearDistKeys(redis, keys);
  });

  afterAll(async () => {
    await clearDistKeys(redis, keys).catch(() => {});
    await redis?.quit().catch(() => {});
  });

  const fresh = (limit: number, leaseMs = 5_000, clockOffsetMs = 0) =>
    new TenantSlots({
      redis,
      leaseMs,
      limit,
      failMode: 'open',
      // Deliberately skewed client clock: slot math must ignore it.
      now: () => Date.now() + clockOffsetMs,
    });

  const serverNow = async () => {
    const [seconds, micros] = await redis.time();
    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  };

  test('a limit of 3 admits exactly 3 of 10 concurrent runs', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        slots.acquire(tenant, `run-${index}`, 1),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await slots.usage(tenant)).toBe(3);
  });

  test('an expired slot is reclaimed by the next acquire (no leak)', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(3);
    for (const runId of ['a', 'b', 'c'])
      expect(await slots.acquire(tenant, runId, 1)).toBe(true);
    expect(await slots.acquire(tenant, 'd', 1)).toBe(false);
    expect(await slots.usage(tenant)).toBe(3);

    // Simulate the owner dying: its score is moved into the past.
    await slots.expireSlot(tenant, 'a', 1);
    expect(await slots.acquire(tenant, 'd', 1)).toBe(true);
    expect(await slots.usage(tenant)).toBe(3);
  });

  test('acquiring the same run + token twice is idempotent', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2);
    expect(await slots.acquire(tenant, 'run-x', 1)).toBe(true);
    expect(await slots.acquire(tenant, 'run-x', 1)).toBe(true);
    expect(await slots.usage(tenant)).toBe(1);
    expect(await redis.zrange(`dist:slots:${tenant}`, 0, -1)).toEqual([
      'run-x:1',
    ]);
    expect(await slots.acquire(tenant, 'run-y', 1)).toBe(true);
    expect(await slots.acquire(tenant, 'run-z', 1)).toBe(false);

    const score = Number(await redis.zscore(`dist:slots:${tenant}`, 'run-x:1'));
    const now = await serverNow();
    expect(score).toBeGreaterThan(now);
    expect(score).toBeLessThanOrEqual(now + 5_100);
  });

  test('a newer lease token replaces the old generation instead of double-counting', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(1);
    expect(await slots.acquire(tenant, 'run-gen', 1)).toBe(true);
    // The old owner was fenced out; the same run comes back with token 3.
    expect(await slots.acquire(tenant, 'run-gen', 3)).toBe(true);
    expect(await slots.usage(tenant)).toBe(1);
    expect(await redis.zrange(`dist:slots:${tenant}`, 0, -1)).toEqual([
      'run-gen:3',
    ]);
  });

  test('release only removes its own generation', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2);
    expect(await slots.acquire(tenant, 'run-rel', 1)).toBe(true);
    expect(await slots.acquire(tenant, 'run-rel', 2)).toBe(true); // new owner
    // The stale worker's release must not free the new owner's slot.
    await slots.release(tenant, 'run-rel', 1);
    expect(await slots.usage(tenant)).toBe(1);
    expect(await redis.zrange(`dist:slots:${tenant}`, 0, -1)).toEqual([
      'run-rel:2',
    ]);
    // The current owner's release does free it.
    await slots.release(tenant, 'run-rel', 2);
    expect(await slots.usage(tenant)).toBe(0);
  });

  test('renew extends a live slot and refuses expired or unknown generations', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2, 5_000);
    expect(await slots.acquire(tenant, 'run-renew', 1)).toBe(true);
    expect(await slots.renew(tenant, 'run-renew', 1)).toBe(true);
    const score = Number(
      await redis.zscore(`dist:slots:${tenant}`, 'run-renew:1'),
    );
    expect(score).toBeGreaterThan(await serverNow());

    expect(await slots.renew(tenant, 'run-missing', 1)).toBe(false);
    expect(await slots.renew(tenant, 'run-renew', 2)).toBe(false);

    await slots.expireSlot(tenant, 'run-renew', 1);
    expect(await slots.renew(tenant, 'run-renew', 1)).toBe(false);
    expect(
      await redis.zscore(`dist:slots:${tenant}`, 'run-renew:1'),
    ).toBeNull();
  });

  test('release frees capacity immediately', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(1);
    expect(await slots.acquire(tenant, 'only', 1)).toBe(true);
    expect(await slots.acquire(tenant, 'next', 1)).toBe(false);
    await slots.release(tenant, 'only', 1);
    expect(await slots.usage(tenant)).toBe(0);
    expect(await slots.acquire(tenant, 'next', 1)).toBe(true);
  });

  test('snapshot reports live usage and drops idle tenants', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(3);
    const other = `${namespace}-other`;
    await slots.acquire(tenant, 'snap-a', 1);
    await slots.acquire(other, 'snap-b', 1);
    const snapshot = await slots.snapshot();
    expect(snapshot.get(tenant)).toBe(1);
    expect(snapshot.get(other)).toBe(1);

    await slots.expireSlot(tenant, 'snap-a', 1);
    const afterExpiry = await slots.snapshot();
    expect(afterExpiry.get(tenant)).toBeUndefined();
    expect(afterExpiry.get(other)).toBe(1);
  });

  test('clock skew between workers does not change admission', async () => {
    await clearDistKeys(redis, keys);
    const ahead = fresh(3, 5_000, 5_000);
    const behind = fresh(3, 5_000, -5_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? ahead : behind).acquire(tenant, `skew-${index}`, 1),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await ahead.usage(tenant)).toBe(3);
  });

  test('limit 0 disables admission control entirely', async () => {
    await clearDistKeys(redis, keys);
    const disabled = fresh(0);
    expect(disabled.enabled).toBe(false);
    for (let index = 0; index < 5; index++)
      expect(await disabled.acquire(tenant, `unbounded-${index}`, 1)).toBe(
        true,
      );
    expect(await disabled.usage(tenant)).toBe(0);
  });

  test('the key carries a TTL so idle tenants do not leak keys', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2, 1_000);
    await slots.acquire(tenant, 'ttl', 1);
    const ttl = await redis.pttl(`dist:slots:${tenant}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});
