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
  uniqueTenant,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

describeMysql('session time zone', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;
  let tzControl = false;

  beforeAll(async () => {
    pool = await createTestPool(4);
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool);
    // Simulate a server whose default zone is not UTC. Requires
    // SYSTEM_VARIABLES_ADMIN; when unavailable the test skips instead of
    // silently asserting the happy path.
    try {
      await pool.query("SET GLOBAL time_zone = '+08:00'");
      tzControl = true;
    } catch {
      tzControl = false;
    }
  });

  afterAll(async () => {
    if (tzControl) await pool.query("SET GLOBAL time_zone = 'SYSTEM'");
    await pool?.end();
    release?.();
  });

  test('stored timestamps stay UTC when the server default is +08:00', async ({
    skip,
  }) => {
    if (!tzControl) skip();
    let shiftedPool: Pool | undefined;
    try {
      // New connections inherit the +08:00 global default; createPool pins the
      // session back to UTC on every connection.
      shiftedPool = await createTestPool(2);
      const shiftedRepository = makeRepository(shiftedPool);

      const globalRows = (
        await shiftedPool.query('SELECT @@global.time_zone AS tz')
      )[0] as Array<{ tz: string }>;
      const sessionRows = (
        await shiftedPool.query('SELECT @@session.time_zone AS tz')
      )[0] as Array<{ tz: string }>;
      expect(globalRows[0].tz).toBe('+08:00');
      expect(sessionRows[0].tz).toBe('+00:00');

      await clearRuns(shiftedPool);
      const { run } = await shiftedRepository.submit({
        tenantId: uniqueTenant('tz'),
        taskId: 'timezone',
        idempotencyKey: 'tz-1',
        payload: { sleepMs: 1 },
      });
      await shiftedRepository.claim('tz-worker', 1);

      const row = await shiftedRepository.getRun(run.id);
      const now = Date.now();
      expect(Math.abs(row!.created_at.getTime() - now)).toBeLessThan(5_000);
      expect(Math.abs(row!.started_at!.getTime() - now)).toBeLessThan(5_000);
      expect(row!.lease_expires_at!.getTime()).toBeGreaterThan(now);
      expect(row!.lease_expires_at!.getTime()).toBeLessThan(
        now + 60 * 60 * 1000,
      );
    } finally {
      await shiftedPool?.end();
    }
  });
});
