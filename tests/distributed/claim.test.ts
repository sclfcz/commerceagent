import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import type {
  ClaimedRun,
  RunRepository,
} from '../../src/distributed/run-repository.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeMysql,
  makeRepository,
  resetSchema,
  uniqueTenant,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const RUNS = 200;
const WORKERS = 8;
const BATCH = 5;

describeMysql('claim with SKIP LOCKED', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool(24);
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('8 workers claim 200 runs, each run is claimed exactly once', async () => {
    await clearRuns(pool);
    const tenantId = uniqueTenant();
    for (let index = 0; index < RUNS; index++)
      await repository.submit({
        tenantId,
        taskId: 'claim-probe',
        idempotencyKey: `run-${index}`,
        payload: { index },
      });

    const claimed: ClaimedRun[] = [];
    for (;;) {
      const batches = await Promise.all(
        Array.from({ length: WORKERS }, (_, worker) =>
          repository.claim(`${tenantId}-w${worker}`, BATCH),
        ),
      );
      const batch = batches.flat();
      if (!batch.length) break;
      claimed.push(...batch);
    }

    expect(claimed).toHaveLength(RUNS);
    expect(new Set(claimed.map((run) => run.runId)).size).toBe(RUNS);
    expect(claimed.every((run) => run.attempt === 1)).toBe(true);
    expect(claimed.every((run) => run.leaseToken === 1)).toBe(true);

    const duplicates = (
      await pool.query(
        `SELECT run_id, COUNT(*) AS total FROM dist_task_run_events
        WHERE event = 'claimed' AND run_id IN (
          SELECT id FROM dist_task_runs WHERE tenant_id = ?
        )
        GROUP BY run_id HAVING COUNT(*) <> 1`,
        [tenantId],
      )
    )[0] as Array<{ run_id: string; total: number }>;
    expect(duplicates).toHaveLength(0);

    const statuses = (
      await pool.query(
        `SELECT status, COUNT(*) AS total FROM dist_task_runs
        WHERE tenant_id = ? GROUP BY status`,
        [tenantId],
      )
    )[0] as Array<{ status: string; total: number }>;
    expect(statuses).toEqual([{ status: 'running', total: RUNS }]);

    const slack = (await repository.claim('idle-worker', BATCH)).length;
    expect(slack).toBe(0);
  });
});
