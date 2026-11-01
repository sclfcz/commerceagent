#!/usr/bin/env node
/**
 * Throughput benchmark for the claim/lease path itself.
 *
 * Every run is a no-op (`sleepMs: 0`), so the numbers describe MySQL claim
 * transactions, not business latency. Each round clears the tables, inserts
 * 20k queued runs, starts N worker processes, and measures:
 *   - wall clock (spawn -> all runs terminal)
 *   - processing window (first claim -> last completion)
 *   - claim transaction latency P50/P95/P99 (measured inside each worker)
 *   - deadlock retries counted by withTransaction
 *   - duplicate `succeeded` events (must be 0)
 *
 * Usage: npm run dist:bench   (requires a running MySQL, see
 * docker-compose.distributed.yml and DIST_MYSQL_URL)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');

const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';
const RUNS_PER_ROUND = Number(process.env.DIST_BENCH_RUNS ?? 20_000);
const CONCURRENCY = 8;
const ROUND_TIMEOUT_MS = 10 * 60 * 1000;

const ROUNDS = [
  { id: 'workers-1', workers: 1, claimBatch: CONCURRENCY },
  { id: 'workers-2', workers: 2, claimBatch: CONCURRENCY },
  { id: 'workers-4', workers: 4, claimBatch: CONCURRENCY },
  { id: 'workers-8', workers: 8, claimBatch: CONCURRENCY },
  { id: 'workers-8-claim-batch-1', workers: 8, claimBatch: 1 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const notify = (message) => process.stderr.write(`[bench] ${message}\n`);

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

function percentile(sorted, quantile) {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(3));
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(3)) : null,
  };
}

function spawnWorker(round, index) {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_WORKER_ID: `bench-${round.id}-${index}`,
      DIST_LEASE_MS: '60000',
      DIST_HEARTBEAT_MS: '20000',
      DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
      DIST_CLAIM_BATCH: String(round.claimBatch),
      DIST_POLL_MS: '10',
      DIST_REAPER_INTERVAL_MS: '60000',
      DIST_BACKOFF_BASE_MS: '10',
      DIST_BACKOFF_MAX_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdoutText = '';
  child.stderrText = '';
  child.stdout.on('data', (chunk) => {
    child.stdoutText += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    child.stderrText = `${child.stderrText}${chunk}`.slice(-2000);
  });
  return child;
}

function parseWorkerStats(child) {
  const lines = child.stdoutText.split('\n').filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed?.event === 'worker_stats') return parsed;
    } catch {
      /* not the stats line */
    }
  }
  return null;
}

async function stopWorkers(workers) {
  for (const child of workers)
    if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 20_000;
  while (
    Date.now() < deadline &&
    workers.some((child) => child.exitCode === null)
  )
    await sleep(100);
  for (const child of workers)
    if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(100);
}

async function seedRuns(pool, count) {
  const values = [];
  const params = [];
  for (let index = 0; index < count; index++) {
    const payload = JSON.stringify({ sleepMs: 0 });
    const hash = createHash('sha256')
      .update(stableStringify({ sleepMs: 0 }), 'utf8')
      .digest('hex');
    values.push(
      "(UUID(), ?, ?, ?, ?, ?, 'queued', 0, 3, NOW(3), NOW(3), NOW(3))",
    );
    params.push('bench', 'noop', `bench-${index}`, payload, hash);
    if (values.length === 500) {
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

async function runRound(pool, round) {
  await pool.query('DELETE FROM dist_task_run_events');
  await pool.query('DELETE FROM dist_task_runs');
  await seedRuns(pool, RUNS_PER_ROUND);
  notify(
    `${round.id}: seeded ${RUNS_PER_ROUND} runs, starting ${round.workers} worker(s)`,
  );

  const workers = Array.from({ length: round.workers }, (_, index) =>
    spawnWorker(round, index),
  );
  const startedAt = Date.now();
  let pending = null;
  const deadline = Date.now() + ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_runs
        WHERE status IN ('queued','running','retry_wait')`,
    );
    pending = Number(rows[0].total);
    if (pending === 0) break;
    await sleep(200);
  }
  if (pending !== 0) {
    await stopWorkers(workers);
    throw new Error(`${round.id}: ${pending} runs never became terminal`);
  }
  const finishedAt = Date.now();
  await stopWorkers(workers);

  const stats = workers.map(parseWorkerStats);
  const missingStats = stats.filter((entry) => !entry).length;
  const claimSamples = stats.flatMap(
    (entry) => entry?.claimLatencyMsSamples ?? [],
  );

  const [[counts]] = await pool.query(
    `SELECT
       SUM(status = 'succeeded') AS succeeded,
       SUM(status = 'dead') AS dead
     FROM dist_task_runs`,
  );
  const [[duplicates]] = await pool.query(
    `SELECT COUNT(*) AS offenders FROM (
       SELECT run_id FROM dist_task_run_events
        WHERE event = 'succeeded'
        GROUP BY run_id HAVING COUNT(*) <> 1
     ) AS offenders`,
  );
  const [[window]] = await pool.query(
    `SELECT
       (SELECT MIN(created_at) FROM dist_task_run_events WHERE event = 'claimed') AS firstClaim,
       (SELECT MAX(created_at) FROM dist_task_run_events WHERE event = 'succeeded') AS lastFinish`,
  );
  const processingMs =
    window.firstClaim && window.lastFinish
      ? new Date(window.lastFinish).getTime() -
        new Date(window.firstClaim).getTime()
      : null;
  const succeeded = Number(counts.succeeded ?? 0);

  return {
    id: round.id,
    workers: round.workers,
    concurrencyPerWorker: CONCURRENCY,
    claimBatch: round.claimBatch,
    wallClockMs: finishedAt - startedAt,
    processingMs,
    throughputRunsPerSecond:
      processingMs && processingMs > 0
        ? Number((succeeded / (processingMs / 1000)).toFixed(2))
        : null,
    runs: {
      total: RUNS_PER_ROUND,
      succeeded,
      dead: Number(counts.dead ?? 0),
    },
    duplicateSucceededRuns: Number(duplicates.offenders),
    claims: {
      batches: stats.reduce(
        (sum, entry) => sum + (entry?.claimBatches ?? 0),
        0,
      ),
      runs: stats.reduce((sum, entry) => sum + (entry?.claimedRuns ?? 0), 0),
      latencyMs: summarize(claimSamples),
    },
    deadlockRetries: stats.reduce(
      (sum, entry) => sum + (entry?.deadlockRetries ?? 0),
      0,
    ),
    workersReportingStats: stats.length - missingStats,
    workerErrors: workers
      .map((child) => child.stderrText.trim())
      .filter(Boolean)
      .slice(0, 3),
  };
}

async function main() {
  const runId = `dist-bench-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = Date.now();
  const pool = await mysql.createPool({
    uri: MYSQL_URL,
    waitForConnections: true,
    connectionLimit: 16,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  // Same session time zone as the workers, otherwise NOW(3) written here is
  // local time while the workers compare against UTC.
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'", () => {});
  });

  const finish = async (report, exitCode) => {
    const directory = path.join(ROOT, 'benchmarks/results');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${runId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    notify(`report written to ${path.relative(ROOT, file)}`);
    await pool.end().catch(() => {});
    process.exit(exitCode);
  };

  try {
    const [[version]] = await pool.query(
      'SELECT VERSION() AS version, @@version_comment AS comment',
    );
    const machine = {
      cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      nodeVersion: process.version,
    };
    const rounds = [];
    for (const round of ROUNDS) {
      const result = await runRound(pool, round);
      rounds.push(result);
      notify(
        `${round.id}: ${result.throughputRunsPerSecond ?? 'n/a'} run/s, ` +
          `p95 claim ${result.claims.latencyMs.p95 ?? 'n/a'} ms, ` +
          `duplicates ${result.duplicateSucceededRuns}`,
      );
    }

    const batch8 = rounds.find((round) => round.id === 'workers-8');
    const batch1 = rounds.find(
      (round) => round.id === 'workers-8-claim-batch-1',
    );
    const deltaPct = (left, right) =>
      left && right
        ? Number((((left - right) / right) * 100).toFixed(1))
        : null;

    const report = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      runsPerRound: RUNS_PER_ROUND,
      machine,
      mysql: {
        host: new URL(MYSQL_URL).host,
        version: version.version,
        versionComment: version.comment,
      },
      rounds,
      comparison: {
        claimBatch8Vs1: {
          throughputDeltaPct: deltaPct(
            batch8?.throughputRunsPerSecond,
            batch1?.throughputRunsPerSecond,
          ),
          claimP95DeltaPct: deltaPct(
            batch8?.claims.latencyMs.p95,
            batch1?.claims.latencyMs.p95,
          ),
        },
      },
      assertions: {
        everyRoundSucceeded: rounds.every(
          (round) => round.runs.succeeded === RUNS_PER_ROUND,
        ),
        noDuplicateSucceededEvents: rounds.every(
          (round) => round.duplicateSucceededRuns === 0,
        ),
        everyWorkerReportedStats: rounds.every(
          (round) => round.workersReportingStats === round.workers,
        ),
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
    process.exit(130);
  });
}

await main();
