#!/usr/bin/env node
/**
 * Chaos test for per-tenant admission slots.
 *
 * 3 tenants x 200 runs, 6 workers with 8 slots each (48 > 3 x 5 tenant slots,
 * so the tenants are always contended), 5 worker SIGKILLs.
 *
 * Correctness is asserted on MySQL + Redis:
 *   - a tenant never observes more than DIST_TENANT_CONCURRENCY live slots,
 *   - every run succeeds exactly once (nothing lost, nothing duplicated),
 *   - slots held by a killed worker are reclaimed within one lease.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';
const REDIS_URL =
  process.env.DIST_REDIS_URL?.trim() || 'redis://127.0.0.1:6379';

const TENANTS = ['tenant-a', 'tenant-b', 'tenant-c'];
const RUNS_PER_TENANT = Number(process.env.DIST_CHAOS_RUNS ?? 200);
const WORKER_COUNT = 6;
const WORKER_CONCURRENCY = 8;
const TENANT_CONCURRENCY = 5;
const LEASE_MS = 3_000;
const HEARTBEAT_MS = 1_000;
const WORKER_KILLS = 5;
const SAMPLE_INTERVAL_MS = 100;
// Sampling (50ms) + reaper interval (500ms) mean a slot can be observed as
// stale slightly after the nominal lease deadline.
const RECOVERY_TOLERANCE_MS = 500;
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

const USAGE_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
return redis.call('ZCARD', key)
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) => process.stderr.write(`[chaos-tenant] ${message}\n`);

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

const metrics = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
  };
};

function stableStringify(value) {
  if (value === null || typeof value !== 'object')
    return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');
const children = new Set();
let sequence = 0;

function spawnWorker() {
  sequence += 1;
  const workerId = `chaos-tenant-w${sequence}`;
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_REDIS_URL: REDIS_URL,
      DIST_WORKER_ID: workerId,
      DIST_DISPATCH: 'poll',
      DIST_WORKER_CONCURRENCY: String(WORKER_CONCURRENCY),
      DIST_CLAIM_BATCH: String(WORKER_CONCURRENCY),
      DIST_TENANT_CONCURRENCY: String(TENANT_CONCURRENCY),
      DIST_ADMISSION_FAIL_MODE: 'open',
      DIST_LEASE_MS: String(LEASE_MS),
      DIST_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DIST_POLL_MS: '100',
      DIST_REAPER_INTERVAL_MS: '500',
      DIST_BACKOFF_BASE_MS: '100',
      DIST_BACKOFF_MAX_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.workerId = workerId;
  child.lastError = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    child.lastError = `${child.lastError}${chunk}`.slice(-800);
  });
  child.on('exit', () => children.delete(child));
  children.add(child);
  return child;
}

async function stopAll() {
  for (const child of [...children])
    if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && [...children].length) await sleep(100);
  for (const child of [...children])
    if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
}

async function main() {
  const startedAt = Date.now();
  const runId = `dist-chaos-tenant-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const pool = await mysql.createPool({
    uri: MYSQL_URL,
    waitForConnections: true,
    connectionLimit: 8,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'", () => {});
  });
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });

  const finish = async (report, exitCode) => {
    const directory = path.join(ROOT, 'benchmarks/results');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${runId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    notify(`report written to ${path.relative(ROOT, file)}`);
    await stopAll();
    await redis.quit().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(exitCode);
  };

  try {
    for (const table of [
      'dist_consumed_messages',
      'dist_outbox',
      'dist_task_run_events',
      'dist_task_runs',
    ])
      await pool.query(`DELETE FROM ${table}`);
    for (const tenant of TENANTS) await redis.del(`dist:slots:${tenant}`);

    // Seed runs per tenant.
    for (const tenant of TENANTS) {
      const values = [];
      const params = [];
      for (let index = 0; index < RUNS_PER_TENANT; index++) {
        const payload = JSON.stringify({
          sleepMs: 100 + Math.floor(Math.random() * 401),
        });
        const hash = createHash('sha256')
          .update(stableStringify(JSON.parse(payload)), 'utf8')
          .digest('hex');
        values.push(
          "(UUID(), ?, 'chaos-tenant', ?, ?, ?, 'queued', 0, 3, NOW(3), NOW(3), NOW(3))",
        );
        params.push(tenant, `${tenant}-${index}`, payload, hash);
        if (values.length === 100) {
          await pool.query(
            `INSERT INTO dist_task_runs
               (id, tenant_id, task_id, idempotency_key, payload, payload_hash,
                status, attempt, max_attempts, available_at, created_at, updated_at)
             VALUES ${values.join(',')}`,
            params,
          );
          values.length = 0;
          params.length = 0;
        }
      }
      if (values.length)
        await pool.query(
          `INSERT INTO dist_task_runs
             (id, tenant_id, task_id, idempotency_key, payload, payload_hash,
              status, attempt, max_attempts, available_at, created_at, updated_at)
           VALUES ${values.join(',')}`,
          params,
        );
    }
    notify(`seeded ${TENANTS.length * RUNS_PER_TENANT} runs`);

    const workers = Array.from({ length: WORKER_COUNT }, () => spawnWorker());

    // Side sampler: live slot count per tenant, mirroring the acquire cleanup.
    const observedMax = Object.fromEntries(TENANTS.map((t) => [t, 0]));
    const overLimitSamples = [];
    const sampler = setInterval(() => {
      void (async () => {
        for (const tenant of TENANTS) {
          try {
            const count = Number(
              await redis.eval(
                USAGE_LUA,
                1,
                `dist:slots:${tenant}`,
                String(Date.now()),
              ),
            );
            observedMax[tenant] = Math.max(observedMax[tenant], count);
            if (count > TENANT_CONCURRENCY)
              overLimitSamples.push({
                tenant,
                count,
                at: Date.now() - startedAt,
              });
          } catch {
            /* sampler is best effort */
          }
        }
      })();
    }, SAMPLE_INTERVAL_MS);

    const kills = [];

    /** Poll until every slot the victim held is gone or renewed by a new owner. */
    const monitorSlotRecovery = async (kill) => {
      const deadline = kill.at + LEASE_MS + 5_000;
      while (Date.now() < deadline) {
        const stillStale = await Promise.all(
          kill.slotsHeld.map(async ({ tenantId, runId: slotRunId }) => {
            const score = await redis.zscore(
              `dist:slots:${tenantId}`,
              slotRunId,
            );
            // Gone (expired + cleaned) means the capacity is free again.
            if (score === null) return false;
            // Or the run was re-claimed after the kill: the slot now belongs to
            // a live worker, so the dead one no longer blocks the tenant.
            const [[reclaimed]] = await pool.query(
              `SELECT COUNT(*) AS total FROM dist_task_run_events
                WHERE run_id = ? AND event = 'claimed' AND id > ?`,
              [slotRunId, kill.maxClaimIdByRun[slotRunId] ?? 0],
            );
            return Number(reclaimed.total) === 0;
          }),
        );
        if (!stillStale.some(Boolean)) {
          kill.recoveredAt = Date.now();
          return;
        }
        await sleep(50);
      }
      kill.recoveredAt = null;
    };

    const killWorker = async (victim) => {
      const [rows] = await pool.query(
        `SELECT id, tenant_id FROM dist_task_runs
          WHERE status = 'running' AND lease_owner = ?`,
        [victim.workerId],
      );
      const slotsHeld = [];
      for (const row of rows) {
        const score = await redis.zscore(
          `dist:slots:${row.tenant_id}`,
          String(row.id),
        );
        if (score !== null)
          slotsHeld.push({ tenantId: row.tenant_id, runId: String(row.id) });
      }
      const [claimRows] = await pool.query(
        `SELECT run_id, MAX(id) AS max_id FROM dist_task_run_events
          WHERE event = 'claimed' AND run_id IN (
            SELECT id FROM dist_task_runs WHERE lease_owner = ?
          )
          GROUP BY run_id`,
        [victim.workerId],
      );
      const maxClaimIdByRun = Object.fromEntries(
        claimRows.map((row) => [String(row.run_id), Number(row.max_id)]),
      );
      const killedAt = Date.now();
      victim.kill('SIGKILL');
      notify(
        `killed ${victim.workerId} holding ${slotsHeld.length} slot(s) across ${rows.length} run(s)`,
      );
      const kill = {
        workerId: victim.workerId,
        at: killedAt,
        slotsHeld,
        maxClaimIdByRun,
        recoveredAt: undefined,
      };
      kills.push(kill);
      if (slotsHeld.length) void monitorSlotRecovery(kill);
      const position = workers.indexOf(victim);
      if (position >= 0) workers[position] = spawnWorker();
    };

    let killCount = 0;
    const scheduleKill = (delayMs) => {
      if (killCount >= WORKER_KILLS) return;
      setTimeout(() => {
        const victims = workers.filter((child) => child.exitCode === null);
        if (victims.length) {
          killCount += 1;
          void killWorker(victims[Math.floor(Math.random() * victims.length)]);
        }
        scheduleKill(3_000 + Math.random() * 2_000);
      }, delayMs);
    };
    scheduleKill(2_500);

    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    let pending = null;
    while (Date.now() < deadline) {
      const [[row]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_runs
          WHERE status IN ('queued','running','retry_wait')`,
      );
      pending = Number(row.total);
      if (pending === 0 && killCount >= WORKER_KILLS) break;
      await sleep(200);
    }
    if (pending !== 0) {
      notify(`timed out with ${pending} runs pending`);
      await finish(
        {
          runId,
          passed: false,
          reason: 'timeout',
          pending,
          kills: kills.length,
          durationMs: Date.now() - startedAt,
        },
        1,
      );
      return;
    }
    clearInterval(sampler);
    await stopAll();

    // Slot recovery was measured in-flight by monitorSlotRecovery().
    const recoverySamples = kills
      .filter((kill) => kill.slotsHeld.length)
      .map((kill) =>
        kill.recoveredAt
          ? Number((kill.recoveredAt - kill.at).toFixed(0))
          : null,
      );
    const recovered = recoverySamples.filter((value) => value !== null);

    const [statusRows] = await pool.query(
      `SELECT status, COUNT(*) AS total FROM dist_task_runs GROUP BY status`,
    );
    const statusCounts = Object.fromEntries(
      statusRows.map((row) => [row.status, Number(row.total)]),
    );
    const [[succeededEvents]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events WHERE event = 'succeeded'`,
    );
    const [[duplicateSucceeded]] = await pool.query(
      `SELECT COUNT(*) AS offenders FROM (
         SELECT run_id FROM dist_task_run_events WHERE event = 'succeeded'
          GROUP BY run_id HAVING COUNT(*) <> 1
       ) AS offenders`,
    );
    const [[staleSucceeded]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events e
         JOIN dist_task_runs r ON r.id = e.run_id
        WHERE e.event = 'succeeded' AND e.lease_token < r.lease_token`,
    );
    const [[claims]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events WHERE event = 'claimed'`,
    );
    const [dispatchRows] = await pool.query(
      `SELECT TIMESTAMPDIFF(MICROSECOND, r.created_at, MIN(e.created_at)) / 1000 AS ms
         FROM dist_task_runs r
         JOIN dist_task_run_events e ON e.run_id = r.id AND e.event = 'claimed'
        GROUP BY r.id`,
    );
    const finalUsage = {};
    for (const tenant of TENANTS)
      finalUsage[tenant] = Number(
        await redis.eval(
          USAGE_LUA,
          1,
          `dist:slots:${tenant}`,
          String(Date.now()),
        ),
      );

    const totalRuns = TENANTS.length * RUNS_PER_TENANT;
    const report = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      config: {
        tenants: TENANTS,
        runsPerTenant: RUNS_PER_TENANT,
        tenantConcurrency: TENANT_CONCURRENCY,
        workers: WORKER_COUNT,
        concurrencyPerWorker: WORKER_CONCURRENCY,
        totalWorkerSlots: WORKER_COUNT * WORKER_CONCURRENCY,
        leaseMs: LEASE_MS,
        heartbeatMs: HEARTBEAT_MS,
        workerKills: WORKER_KILLS,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
      },
      runs: {
        total: totalRuns,
        succeeded: statusCounts.succeeded ?? 0,
        dead: statusCounts.dead ?? 0,
        pending,
        claimedEvents: Number(claims.total),
      },
      slots: {
        maxObservedPerTenant: observedMax,
        overLimitSamples,
        finalUsage,
      },
      slotRecovery: {
        samples: recoverySamples,
        recoveredWithinLease:
          recovered.length ===
            kills.filter((kill) => kill.slotsHeld.length).length &&
          recovered.every((value) => value <= LEASE_MS + RECOVERY_TOLERANCE_MS),
        ms: metrics(recovered),
        leaseMs: LEASE_MS,
        toleranceMs: RECOVERY_TOLERANCE_MS,
      },
      kills: kills.map((kill) => ({
        workerId: kill.workerId,
        slotsHeld: kill.slotsHeld.length,
        atMs: kill.at - startedAt,
      })),
      dispatchLatencyMs: metrics(dispatchRows.map((row) => Number(row.ms))),
      assertions: {
        neverExceededTenantLimit: overLimitSamples.length === 0,
        allRunsSucceeded: (statusCounts.succeeded ?? 0) === totalRuns,
        exactlyOneSucceededEventPerRun:
          Number(duplicateSucceeded.offenders) === 0 &&
          Number(succeededEvents.total) === (statusCounts.succeeded ?? 0),
        noSucceededWithStaleToken: Number(staleSucceeded.total) === 0,
        workerKillsExecuted: kills.length === WORKER_KILLS,
        killedWorkersHeldSlots: kills.some((kill) => kill.slotsHeld.length > 0),
        slotsRecoveredWithinLease:
          recovered.length ===
            kills.filter((kill) => kill.slotsHeld.length).length &&
          recovered.every((value) => value <= LEASE_MS + RECOVERY_TOLERANCE_MS),
      },
    };
    report.passed = Object.values(report.assertions).every(Boolean);
    await finish(report, report.passed ? 0 : 1);
  } catch (error) {
    await finish(
      {
        runId,
        passed: false,
        reason: 'exception',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      },
      1,
    );
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    notify(`received ${signal}`);
    void stopAll().finally(() => process.exit(130));
  });
}

await main();
