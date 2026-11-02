import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { TokenBucket } from '../../src/distributed/rate-limiter.js';
import { TenantSlots } from '../../src/distributed/tenant-slots.js';
import { createStrictRedis } from '../../src/distributed/redis.js';
import { describeRedis } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

// A port nothing listens on: every command must fail fast.
const UNREACHABLE = 'redis://127.0.0.1:6399';

describeRedis('admission fail mode', () => {
  let dead: Redis;
  const events: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    dead = createStrictRedis(UNREACHABLE);
  });

  afterAll(async () => {
    await dead?.disconnect();
  });

  test('open: a dead Redis admits and logs admission_degraded', async () => {
    events.length = 0;
    const slots = new TenantSlots({
      redis: dead,
      leaseMs: 5_000,
      limit: 3,
      failMode: 'open',
      logger: (event) => events.push(event),
    });
    expect(await slots.acquire('tenant-open', 'run-1', 1)).toBe(true);
    expect(await slots.renew('tenant-open', 'run-1', 1)).toBe(true);
    expect(events.some((event) => event.event === 'admission_degraded')).toBe(
      true,
    );
    expect(events[0]).toMatchObject({
      event: 'admission_degraded',
      component: 'tenant-slots',
      failMode: 'open',
    });
  });

  test('closed: a dead Redis rejects execution', async () => {
    events.length = 0;
    const slots = new TenantSlots({
      redis: dead,
      leaseMs: 5_000,
      limit: 3,
      failMode: 'closed',
      logger: (event) => events.push(event),
    });
    expect(await slots.acquire('tenant-closed', 'run-2', 1)).toBe(false);
    expect(await slots.renew('tenant-closed', 'run-2', 1)).toBe(false);
    expect(events.some((event) => event.event === 'admission_degraded')).toBe(
      true,
    );
  });

  test('the token bucket degrades the same way', async () => {
    events.length = 0;
    const openBucket = new TokenBucket({
      redis: dead,
      failMode: 'open',
      logger: (event) => events.push(event),
    });
    const allowed = await openBucket.tryAcquire('dist:rate:x:y', 10, 5);
    expect(allowed.allowed).toBe(true);

    events.length = 0;
    const closedBucket = new TokenBucket({
      redis: dead,
      failMode: 'closed',
      logger: (event) => events.push(event),
    });
    const denied = await closedBucket.tryAcquire('dist:rate:x:y', 10, 5);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(
      events.filter((event) => event.component === 'rate-limiter').length,
    ).toBeGreaterThan(0);
  });
});
