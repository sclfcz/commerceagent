import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Redis } from 'ioredis';
import {
  RateLimitTimeoutError,
  TokenBucket,
} from '../../src/distributed/rate-limiter.js';
import { clearDistKeys, createTestRedis, describeRedis } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describeRedis('token bucket', () => {
  let redis: Redis;
  let nowMs: number;
  const namespace = `test-rate-${randomUUID().slice(0, 8)}`;
  const key = `dist:rate:${namespace}:model`;
  const keys = `dist:rate:${namespace}*`;

  beforeAll(async () => {
    redis = await createTestRedis();
    await clearDistKeys(redis, keys);
  });

  afterAll(async () => {
    await clearDistKeys(redis).catch(() => {});
    await redis?.quit().catch(() => {});
  });

  const bucket = (advanceOnSleep = false) =>
    new TokenBucket({
      redis,
      failMode: 'open',
      now: () => nowMs,
      ...(advanceOnSleep
        ? {
            sleep: async (ms: number) => {
              nowMs += ms;
            },
          }
        : {}),
    });

  test('burst 5 at 10/s: five immediate, sixth rejected, refill after 500ms', async () => {
    await clearDistKeys(redis, keys);
    nowMs = 2_000_000;
    const limiter = bucket();
    for (let index = 0; index < 5; index++)
      expect(
        (await limiter.tryAcquire(key, 10, 5)).allowed,
        `token ${index + 1}`,
      ).toBe(true);

    const rejected = await limiter.tryAcquire(key, 10, 5);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterMs).toBe(100); // 1 token at 10/s

    // 500ms at 10/s = exactly 5 tokens.
    nowMs += 500;
    const refilled = [];
    for (let index = 0; index < 6; index++)
      refilled.push((await limiter.tryAcquire(key, 10, 5)).allowed);
    expect(refilled).toEqual([true, true, true, true, true, false]);
  });

  test('refill never exceeds burst', async () => {
    await clearDistKeys(redis, keys);
    nowMs = 3_000_000;
    const limiter = bucket();
    await limiter.tryAcquire(key, 10, 5);
    nowMs += 60_000; // a minute of idle time
    for (let index = 0; index < 5; index++)
      expect((await limiter.tryAcquire(key, 10, 5)).allowed).toBe(true);
    expect((await limiter.tryAcquire(key, 10, 5)).allowed).toBe(false);
  });

  test('acquireBlocking waits for a token and succeeds within the budget', async () => {
    await clearDistKeys(redis, keys);
    nowMs = 4_000_000;
    const limiter = bucket(true);
    // Drain the bucket, then block until the next token arrives.
    for (let index = 0; index < 5; index++) await limiter.tryAcquire(key, 2, 5);
    const startedAt = nowMs;
    const result = await limiter.acquireBlocking(key, 2, 5, 5_000);
    expect(result.allowed).toBe(true);
    expect(nowMs - startedAt).toBeLessThanOrEqual(5_000);
  });

  test('acquireBlocking throws when the wait budget is too small', async () => {
    await clearDistKeys(redis, keys);
    nowMs = 5_000_000;
    const limiter = bucket(true);
    // 1 token per 1000s: after draining, the next token is ~1000s away.
    await limiter.tryAcquire(key, 0.001, 1);
    await expect(
      limiter.acquireBlocking(key, 0.001, 1, 100),
    ).rejects.toBeInstanceOf(RateLimitTimeoutError);
  });

  test('each key is an independent bucket', async () => {
    await clearDistKeys(redis, keys);
    nowMs = 6_000_000;
    const limiter = bucket();
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
