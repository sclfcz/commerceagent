import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe } from 'vitest';
import type { DistributedConfig } from '../../src/distributed/config.js';
import { createPool, type Pool } from '../../src/distributed/mysql.js';
import { runMigrations } from '../../src/distributed/migrate.js';
import { RunRepository } from '../../src/distributed/run-repository.js';
import type { Redis } from 'ioredis';
import { createStrictRedis } from '../../src/distributed/redis.js';

/**
 * Integration tests run against a real MySQL 8.0+ instance. When
 * DIST_MYSQL_TEST_URL is absent every suite is skipped, so `make test` never
 * depends on a database being available.
 */
export const TEST_MYSQL_URL = process.env.DIST_MYSQL_TEST_URL?.trim() ?? '';
export const TEST_AMQP_URL = process.env.DIST_AMQP_TEST_URL?.trim() ?? '';
export const TEST_REDIS_URL = process.env.DIST_REDIS_TEST_URL?.trim() ?? '';
export const hasMysql = TEST_MYSQL_URL.length > 0;
export const hasAmqp = TEST_AMQP_URL.length > 0;
export const describeMysql = hasMysql ? describe : describe.skip;
/** Suites that need both MySQL and RabbitMQ. */
export const describeDist = hasMysql && hasAmqp ? describe : describe.skip;
export const hasRedis = TEST_REDIS_URL.length > 0;
/** Admission-control suites only need Redis. */
export const describeRedis = hasRedis ? describe : describe.skip;

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function createTestPool(connectionLimit = 16): Promise<Pool> {
  if (!hasMysql) throw new Error('DIST_MYSQL_TEST_URL is required');
  return createPool(TEST_MYSQL_URL, { connectionLimit });
}

/** Drop everything and re-apply migrations, giving the file a clean schema. */
export async function resetSchema(pool: Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS dist_run_steps');
  await pool.query('DROP TABLE IF EXISTS dist_consumed_messages');
  await pool.query('DROP TABLE IF EXISTS dist_outbox');
  await pool.query('DROP TABLE IF EXISTS dist_task_run_events');
  await pool.query('DROP TABLE IF EXISTS dist_task_runs');
  await pool.query('DROP TABLE IF EXISTS dist_schema_migrations');
  await runMigrations(pool);
}

export async function clearRuns(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM dist_consumed_messages');
  await pool.query('DELETE FROM dist_outbox');
  await pool.query('DELETE FROM dist_task_run_events');
  await pool.query('DELETE FROM dist_task_runs');
}

export async function createTestRedis(): Promise<Redis> {
  if (!hasRedis) throw new Error('DIST_REDIS_TEST_URL is required');
  const redis = createStrictRedis(TEST_REDIS_URL);
  await redis.connect();
  return redis;
}

/**
 * Delete only this subsystem's keys; never flush a shared server.
 * Pass a narrow pattern (test files run in parallel against one Redis DB).
 */
export async function clearDistKeys(
  redis: Redis,
  pattern = 'dist:*',
): Promise<void> {
  for (const current of [pattern]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== '0');
  }
}

/** Unique queue prefix so parallel files never share broker state. */
export function uniqueQueuePrefix(tag: string): string {
  return `dist-test-${tag}-${randomUUID().slice(0, 8)}`;
}

export function uniqueTenant(prefix = 'tenant'): string {
  return `${prefix}-${randomUUID()}`;
}

export function makeRepository(
  pool: Pool,
  overrides: Partial<{
    leaseMs: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    random: () => number;
  }> = {},
): RunRepository {
  return new RunRepository(pool, {
    leaseMs: overrides.leaseMs ?? 800,
    backoffBaseMs: overrides.backoffBaseMs ?? 20,
    backoffMaxMs: overrides.backoffMaxMs ?? 60,
    ...(overrides.random ? { random: overrides.random } : {}),
  });
}

export function testConfig(
  overrides: Partial<DistributedConfig> = {},
): DistributedConfig {
  return {
    mysqlUrl: TEST_MYSQL_URL || 'mysql://unused',
    workerId: `test-worker-${randomUUID()}`,
    leaseMs: 900,
    heartbeatMs: 200,
    concurrency: 1,
    claimBatch: 1,
    pollMs: 20,
    reaperIntervalMs: 100,
    backoffBaseMs: 20,
    backoffMaxMs: 60,
    dispatch: 'poll',
    amqpUrl: TEST_AMQP_URL || 'amqp://unused',
    fallbackPollMs: 30_000,
    relayBatchSize: 100,
    relayPollMs: 200,
    relayCrashAfterConfirmRate: 0,
    relayDuplicateRate: 0,
    effectTimeoutMs: 5_000,
    unknownSweepMs: 60_000,
    effectSettleMs: 2_000,
    ...overrides,
    ...(overrides.claimBatch === undefined
      ? { claimBatch: overrides.concurrency ?? 1 }
      : {}),
  };
}

export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  options: { label: string; timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${options.label}`);
    await sleep(options.intervalMs ?? 50);
  }
}

const lockFile = path.join(
  os.tmpdir(),
  `commerceagent-dist-tests-${createHash('sha256')
    .update(TEST_MYSQL_URL || 'none')
    .digest('hex')
    .slice(0, 12)}.lock`,
);

/**
 * Test files share one MySQL schema and each one drops/recreates the tables,
 * so they must not run concurrently. Vitest runs files in parallel, hence this
 * cross-process file lock; a crashed run's lock is reclaimed after 10 minutes.
 */
export async function acquireSuiteLock(
  timeoutMs = 120_000,
): Promise<() => void> {
  if (!hasMysql) return () => {};
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const descriptor = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(descriptor, String(process.pid));
      fs.closeSync(descriptor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let reclaimable = false;
      try {
        const stat = fs.statSync(lockFile);
        const raw = fs.readFileSync(lockFile, 'utf8').trim();
        const owner = Number(raw);
        // An empty file is a lock being written right now, not a stale one:
        // only a *parseable* dead pid (or a lock older than 10 minutes, in
        // case the pid was reused) may be reclaimed.
        if (Number.isSafeInteger(owner) && owner > 0) {
          let ownerAlive = true;
          try {
            process.kill(owner, 0);
          } catch (probe) {
            ownerAlive = (probe as NodeJS.ErrnoException).code !== 'ESRCH';
          }
          reclaimable = !ownerAlive;
        }
        if (!reclaimable && Date.now() - stat.mtimeMs > 600_000)
          reclaimable = true;
      } catch {
        reclaimable = true; // vanished between open and stat
      }
      if (reclaimable) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline)
        throw new Error('timed out waiting for the distributed test lock');
      await sleep(100);
    }
  }
  return () => {
    try {
      fs.rmSync(lockFile, { force: true });
    } catch {
      /* already gone */
    }
  };
}
