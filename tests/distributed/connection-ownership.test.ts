import { afterAll, beforeAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  ConnectionOwnership,
  ownershipCredentialKey,
} from '../../src/distributed/connection-ownership.js';
import { createTestRedis, describeRedis } from './helpers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeRedis('IM connection ownership', () => {
  let redis: Awaited<ReturnType<typeof createTestRedis>>;

  beforeAll(async () => {
    redis = await createTestRedis();
  });

  afterAll(async () => {
    await redis?.quit().catch(() => {});
  });

  const key = () => `${ownershipCredentialKey('feishu', randomUUID())}`;

  test('two instances racing for one credential: exactly one wins', async () => {
    const credentialKey = key();
    const a = new ConnectionOwnership({
      redis,
      instanceId: 'A',
      leaseMs: 2_000,
      renewMs: 300,
    });
    const b = new ConnectionOwnership({
      redis,
      instanceId: 'B',
      leaseMs: 2_000,
      renewMs: 300,
    });
    const [leaseA, leaseB] = await Promise.all([
      a.acquire(credentialKey, () => {}),
      b.acquire(credentialKey, () => {}),
    ]);
    const winners = [leaseA, leaseB].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.isCurrent()).toBe(true);
    await winners[0]!.release();
    await a.releaseAll();
    await b.releaseAll();
  });

  test('after the owner stops renewing, a new owner gets a higher token', async () => {
    const credentialKey = key();
    const a = new ConnectionOwnership({
      redis,
      instanceId: 'A',
      leaseMs: 300,
      renewMs: 100,
    });
    const b = new ConnectionOwnership({
      redis,
      instanceId: 'B',
      leaseMs: 300,
      renewMs: 100,
    });
    const first = await a.acquire(credentialKey, () => {});
    expect(first).not.toBeNull();
    // Simulate a wedged owner: no more renewals from here on.
    first!.stop();
    await sleep(500);
    const second = await b.acquire(credentialKey, () => {});
    expect(second).not.toBeNull();
    expect(second!.token).toBeGreaterThan(first!.token);
    await a.releaseAll();
    await b.releaseAll();
  });

  test('a stale token can neither renew nor release the new owner', async () => {
    const credentialKey = key();
    const a = new ConnectionOwnership({
      redis,
      instanceId: 'A',
      leaseMs: 300,
      renewMs: 100,
    });
    const b = new ConnectionOwnership({
      redis,
      instanceId: 'B',
      leaseMs: 2_000,
      renewMs: 300,
    });
    const first = await a.acquire(credentialKey, () => {});
    first!.stop();
    await sleep(500);
    const second = await b.acquire(credentialKey, () => {});
    expect(second).not.toBeNull();

    expect(await first!.renew()).toBe(false);
    await first!.release();
    // B still owns the key: the stale DEL was fenced out.
    expect(await second!.renew()).toBe(true);
    await b.releaseAll();
    await a.releaseAll();
  });

  test('a frozen process self-fences on the monotonic clock', async () => {
    const credentialKey = key();
    let monotonic = 1_000;
    let lost = 0;
    const ownership = new ConnectionOwnership({
      redis,
      instanceId: 'frozen',
      leaseMs: 1_000,
      renewMs: 300,
      monotonicNow: () => monotonic,
    });
    const lease = await ownership.acquire(credentialKey, () => {
      lost += 1;
    });
    expect(lease).not.toBeNull();
    expect(lease!.isCurrent()).toBe(true);

    // The process is stopped for longer than the lease: wall-clock timers do
    // not run, but the monotonic clock keeps advancing.
    monotonic += 5_000;
    expect(lease!.isCurrent()).toBe(false);
    expect(lost).toBe(1);
    // Idempotent: a second observation must not fire the callback again.
    expect(lease!.isCurrent()).toBe(false);
    expect(lost).toBe(1);
    await ownership.releaseAll();
  });
});
