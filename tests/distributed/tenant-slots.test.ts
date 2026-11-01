import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { TenantSlots } from '../../src/distributed/tenant-slots.js';
import { randomUUID } from 'node:crypto';
import { clearDistKeys, createTestRedis, describeRedis } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describeRedis('tenant slots', () => {
  let redis: Redis;
  let nowMs: number;
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
    await clearDistKeys(redis).catch(() => {});
    await redis?.quit().catch(() => {});
  });

  const fresh = (limit: number, leaseMs = 5_000) => {
    nowMs = 1_000_000;
    return new TenantSlots({
      redis,
      leaseMs,
      limit,
      failMode: 'open',
      now: () => nowMs,
    });
  };

  test('a limit of 3 admits exactly 3 of 10 concurrent runs', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(3);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        slots.acquire(tenant, `run-${index}`),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await slots.usage(tenant)).toBe(3);
  });

  test('an expired slot is reclaimed by the next acquire (no leak)', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(3);
    for (const runId of ['a', 'b', 'c'])
      expect(await slots.acquire(tenant, runId)).toBe(true);
    expect(await slots.acquire(tenant, 'd')).toBe(false);
    expect(await slots.usage(tenant)).toBe(3);

    // Simulate the worker that owns "a" dying: its score is in the past.
    await slots.expireNow(tenant, 'a');
    expect(await slots.acquire(tenant, 'd')).toBe(true);
    expect(await slots.usage(tenant)).toBe(3);
  });

  test('acquiring the same run twice is idempotent', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2);
    expect(await slots.acquire(tenant, 'run-x')).toBe(true);
    nowMs += 1_000;
    expect(await slots.acquire(tenant, 'run-x')).toBe(true);
    expect(await slots.usage(tenant)).toBe(1);
    // The re-acquire refreshed the score instead of adding a member.
    const members = await redis.zrange(`dist:slots:${tenant}`, 0, -1);
    expect(members).toEqual(['run-x']);
    expect(await slots.acquire(tenant, 'run-y')).toBe(true);
    expect(await slots.acquire(tenant, 'run-z')).toBe(false);
  });

  test('renew extends a known slot and rejects expired or unknown runs', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2, 5_000);
    expect(await slots.acquire(tenant, 'run-renew')).toBe(true);
    nowMs += 3_000;
    expect(await slots.renew(tenant, 'run-renew')).toBe(true);
    const score = await redis.zscore(`dist:slots:${tenant}`, 'run-renew');
    expect(Number(score)).toBe(nowMs + 5_000);

    // Unknown member.
    expect(await slots.renew(tenant, 'run-missing')).toBe(false);

    // Expired member: renew must not resurrect it, and it is removed.
    nowMs += 6_000;
    expect(await slots.renew(tenant, 'run-renew')).toBe(false);
    expect(await redis.zscore(`dist:slots:${tenant}`, 'run-renew')).toBeNull();
  });

  test('release frees capacity immediately', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(1);
    expect(await slots.acquire(tenant, 'only')).toBe(true);
    expect(await slots.acquire(tenant, 'next')).toBe(false);
    await slots.release(tenant, 'only');
    expect(await slots.usage(tenant)).toBe(0);
    expect(await slots.acquire(tenant, 'next')).toBe(true);
  });

  test('limit 0 disables admission control entirely', async () => {
    await clearDistKeys(redis, keys);
    const disabled = new TenantSlots({
      redis,
      leaseMs: 5_000,
      limit: 0,
      failMode: 'closed',
      now: () => 1_000_000,
    });
    expect(disabled.enabled).toBe(false);
    for (let index = 0; index < 5; index++)
      expect(await disabled.acquire(tenant, `unbounded-${index}`)).toBe(true);
    expect(await disabled.usage(tenant)).toBe(0);
  });

  test('the key carries a TTL so idle tenants do not leak keys', async () => {
    await clearDistKeys(redis, keys);
    slots = fresh(2, 1_000);
    await slots.acquire(tenant, 'ttl');
    const ttl = await redis.pttl(`dist:slots:${tenant}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10_000);
  });
});
