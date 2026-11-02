import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  RateLimitTimeoutError,
  TokenBucket,
} from '../../src/distributed/rate-limiter.js';
import { clearDistKeys, createTestRedis, describeRedis } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describeRedis('token bucket', () => {
  let redis: Redis;
  let limiter: TokenBucket;
  const namespace = `test-rate-${randomUUID().slice(0, 8)}`;
  const key = `dist:rate:${namespace}:model`;
  const keys = `dist:rate:${namespace}*`;

  beforeAll(async () => {
    redis = await createTestRedis();
    await clearDistKeys(redis, keys);
    limiter = new TokenBucket({ redis, failMode: 'open' });
  });

  afterAll(async () => {
    await clearDistKeys(redis, keys).catch(() => {});
    await redis?.quit().catch(() => {});
  });

  test('burst 5: exactly five immediate tokens, the sixth is rejected', async () => {
    await clearDistKeys(redis, keys);
    for (let index = 0; index < 5; index++)
      expect(
        (await limiter.tryAcquire(key, 10, 5)).allowed,
        `token ${index + 1}`,
      ).toBe(true);
    const rejected = await limiter.tryAcquire(key, 10, 5);
    expect(rejected.allowed).toBe(false);
    // 1 token at 10/s => ~100ms; the Redis clock makes this exact to the ms.
    expect(rejected.retryAfterMs).toBeGreaterThan(0);
    expect(rejected.retryAfterMs).toBeLessThanOrEqual(101);
  });

  test('refill uses real elapsed time (100/s for 60ms, ±1 token)', async () => {
    await clearDistKeys(redis, keys);
    for (let index = 0; index < 5; index++)
      await limiter.tryAcquire(key, 100, 5);
    await sleep(60);
    let allowed = 0;
    for (let index = 0; index < 7; index++)
      if ((await limiter.tryAcquire(key, 100, 5)).allowed) allowed += 1;
    // 60ms at 100/s = 6 tokens, capped at burst 5; ±1 for scheduling jitter.
    expect(allowed).toBeGreaterThanOrEqual(4);
    expect(allowed).toBeLessThanOrEqual(5);

    // A shorter pause refills partially.
    await sleep(30);
    let partial = 0;
    for (let index = 0; index < 6; index++)
      if ((await limiter.tryAcquire(key, 100, 5)).allowed) partial += 1;
    expect(partial).toBeGreaterThanOrEqual(2);
    expect(partial).toBeLessThanOrEqual(4);
  });

  test('refill never exceeds burst', async () => {
    await clearDistKeys(redis, keys);
    await limiter.tryAcquire(key, 10, 5);
    await sleep(700);
    let allowed = 0;
    for (let index = 0; index < 7; index++)
      if ((await limiter.tryAcquire(key, 10, 5)).allowed) allowed += 1;
    expect(allowed).toBeLessThanOrEqual(5);
    expect(allowed).toBeGreaterThanOrEqual(4);
  });

  test('acquireBlocking waits for a token and succeeds within the budget', async () => {
    await clearDistKeys(redis, keys);
    for (let index = 0; index < 5; index++) await limiter.tryAcquire(key, 5, 5);
    const startedAt = Date.now();
    const result = await limiter.acquireBlocking(key, 5, 5, 5_000);
    expect(result.allowed).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('acquireBlocking throws when the wait budget is too small', async () => {
    await clearDistKeys(redis, keys);
    await limiter.tryAcquire(key, 0.001, 1);
    await expect(
      limiter.acquireBlocking(key, 0.001, 1, 100),
    ).rejects.toBeInstanceOf(RateLimitTimeoutError);
  });

  test('each key is an independent bucket', async () => {
    await clearDistKeys(redis, keys);
    expect(
      (await limiter.tryAcquire(`dist:rate:${namespace}:a`, 1, 1)).allowed,
    ).toBe(true);
    expect(
      (await limiter.tryAcquire(`dist:rate:${namespace}:a`, 1, 1)).allowed,
    ).toBe(false);
    expect(
      (await limiter.tryAcquire(`dist:rate:${namespace}:b`, 1, 1)).allowed,
    ).toBe(true);
  });
});
