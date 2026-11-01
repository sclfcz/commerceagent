#!/usr/bin/env node
/**
 * Fairness benchmark: does a tenant-flooding workload delay a small tenant?
 *
 * BIG submits 5000 runs, SMALL submits 200, both sleepMs=50. The same run is
 * measured twice: baseline (DIST_TENANT_CONCURRENCY=0, no isolation) and
 * isolated (=10). 3 repeats each, medians reported.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
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

const BIG_TENANT = 'tenant-big';
const SMALL_TENANT = 'tenant-small';
const BIG_RUNS = Number(process.env.DIST_FAIR_BIG ?? 5_000);
const SMALL_RUNS = Number(process.env.DIST_FAIR_SMALL ?? 200);
const SLEEP_MS = 50;
const TENANT_CONCURRENCY = 10;
const WORKERS = 8;
const CONCURRENCY = 8;
const REPEATS = Math.max(1, Number(process.env.DIST_FAIR_REPEAT ?? 3) || 3);
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;

const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');
const children = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) =>
  process.stderr.write(`[bench-fairness] ${message}\n`);

function percentile(sorted, quantile) {
  if (!sorted.length) return null;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
  };
}

function median(values) {
  const present = values.filter((value) => typeof value === 'number');
  if (!present.length) return null;
  const sorted = [...present].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

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

function spawnWorkers(tenantConcurrency) {
  return Array.from({ length: WORKERS }, (_, index) => {
    const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env,
        DIST_MYSQL_URL: MYSQL_URL,
        DIST_REDIS_URL: REDIS_URL,
        DIST_WORKER_ID: `fair-${tenantConcurrency}-w${index}`,
        DIST_DISPATCH: 'poll',
        DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
        DIST_CLAIM_BATCH: String(CONCURRENCY),
        DIST_TENANT_CONCURRENCY: String(tenantConcurrency),
        DIST_ADMISSION_FAIL_MODE: 'open',
        DIST_LEASE_MS: '30000',
        DIST_HEARTBEAT_MS: '5000',
        DIST_POLL_MS: '50',
        DIST_REAPER_INTERVAL_MS: '60000',
        DIST_BACKOFF_BASE_MS: '10',
        DIST_BACKOFF_MAX_MS: '50',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.lastError = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      child.lastError = `${child.lastError}${chunk}`.slice(-500);
    });
    child.on('exit', () => children.delete(child));
    children.add(child);
    return child;
  });
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

async function seed(pool, tenant, count) {
  const values = [];
  const params = [];
  const payload = JSON.stringify({ sleepMs: SLEEP_MS });
  const hash = createHash('sha256')
    .update(stableStringify(JSON.parse(payload)), 'utf8')
    .digest('hex');
  for (let index = 0; index < count; index++) {
    values.push(
      "(UUID(), ?, 'fair', ?, ?, ?, 'queued', 0, 3, NOW(3), NOW(3), NOW(3))",
    );
    params.push(tenant, `${tenant}-${Date.now()}-${index}`, payload, hash);
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

async function waitForTerminal(pool, timeoutMs = PHASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_runs
        WHERE status IN ('queued','running','retry_wait')`,
    );
    if (Number(row.total) === 0) return true;
    await sleep(100);
  }
  return false;
}

async function measure(pool, tenant, mode, tenantConcurrency) {
  for (const table of [
    'dist_consumed_messages',
    'dist_outbox',
    'dist_task_run_events',
    'dist_task_runs',
  ])
    await pool.query(`DELETE FROM ${table}`);

  // BIG first: SMALL arrives behind a large backlog on purpose.
  await seed(pool, BIG_TENANT, BIG_RUNS);
  await seed(pool, SMALL_TENANT, SMALL_RUNS);
  const workers = spawnWorkers(tenantConcurrency);
  const startedAt = Date.now();
  try {
    if (!(await waitForTerminal(pool)))
      throw new Error(`${mode}: runs never drained`);
    const finishedAt = Date.now();
    const [rows] = await pool.query(
      `SELECT
         TIMESTAMPDIFF(MICROSECOND, created_at, finished_at) / 1000 AS completion_ms,
         TIMESTAMPDIFF(MICROSECOND, created_at, started_at) / 1000 AS queue_ms
       FROM dist_task_runs
       WHERE tenant_id = ? AND status = 'succeeded'`,
      [tenant],
    );
    const completion = rows.map((row) => Number(row.completion_ms));
    const queue = rows.map((row) => Number(row.queue_ms));
    const [[span]] = await pool.query(
      `SELECT
         TIMESTAMPDIFF(MICROSECOND, MIN(created_at), MAX(finished_at)) / 1000 AS span_ms
       FROM dist_task_runs WHERE tenant_id = ?`,
      [tenant],
    );
    const [[big]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_runs
        WHERE tenant_id = ? AND status = 'succeeded'`,
      [BIG_TENANT],
    );
    return {
      mode,
      tenantConcurrency,
      workers: WORKERS,
      runs: { small: completion.length, big: Number(big.total) },
      smallCompletionMs: summarize(completion),
      smallQueueMs: summarize(queue),
      smallSpanMs: Number(span.span_ms),
      wallClockMs: finishedAt - startedAt,
    };
  } finally {
    for (const child of workers) child.kill('SIGTERM');
    await stopAll();
  }
}

async function redisVersion(redis) {
  try {
    const info = await redis.info('server');
    const match = /redis_version:([^\r\n]+)/.exec(info);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function main() {
  const runId = `dist-bench-fairness-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = Date.now();
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
    const [[version]] = await pool.query(
      'SELECT VERSION() AS version, @@version_comment AS comment',
    );
    const version_redis = await redisVersion(redis);
    const samples = { baseline: [], isolated: [] };
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      notify(`repeat ${repeat + 1}/${REPEATS}: baseline`);
      samples.baseline.push(await measure(pool, SMALL_TENANT, 'baseline', 0));
      notify(`repeat ${repeat + 1}/${REPEATS}: isolated`);
      samples.isolated.push(
        await measure(pool, SMALL_TENANT, 'isolated', TENANT_CONCURRENCY),
      );
    }

    const summarizeMode = (rows) => ({
      repeats: rows.length,
      smallCompletionMs: {
        p50: median(rows.map((row) => row.smallCompletionMs.p50)),
        p95: median(rows.map((row) => row.smallCompletionMs.p95)),
        p99: median(rows.map((row) => row.smallCompletionMs.p99)),
      },
      smallQueueMs: {
        p50: median(rows.map((row) => row.smallQueueMs.p50)),
        p95: median(rows.map((row) => row.smallQueueMs.p95)),
        p99: median(rows.map((row) => row.smallQueueMs.p99)),
      },
      smallSpanMs: median(rows.map((row) => row.smallSpanMs)),
      wallClockMs: median(rows.map((row) => row.wallClockMs)),
      succeededPerRepeat: rows.map((row) => row.runs.small),
    });
    const baseline = summarizeMode(samples.baseline);
    const isolated = summarizeMode(samples.isolated);
    const deltaPct = (left, right) =>
      typeof left === 'number' && typeof right === 'number' && right !== 0
        ? Number((((left - right) / right) * 100).toFixed(1))
        : null;

    const report = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      machine: {
        cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        nodeVersion: process.version,
      },
      mysql: {
        host: new URL(MYSQL_URL).host,
        version: version.version,
        versionComment: version.comment,
      },
      redis: { host: new URL(REDIS_URL).host, version: version_redis },
      config: {
        bigTenant: BIG_TENANT,
        bigRuns: BIG_RUNS,
        smallTenant: SMALL_TENANT,
        smallRuns: SMALL_RUNS,
        sleepMs: SLEEP_MS,
        workers: WORKERS,
        concurrencyPerWorker: CONCURRENCY,
        tenantConcurrency: TENANT_CONCURRENCY,
        repeats: REPEATS,
      },
      baseline,
      isolated,
      comparison: {
        smallCompletionP50DeltaPct: deltaPct(
          isolated.smallCompletionMs.p50,
          baseline.smallCompletionMs.p50,
        ),
        smallCompletionP95DeltaPct: deltaPct(
          isolated.smallCompletionMs.p95,
          baseline.smallCompletionMs.p95,
        ),
        smallQueueP95DeltaPct: deltaPct(
          isolated.smallQueueMs.p95,
          baseline.smallQueueMs.p95,
        ),
        smallSpanDeltaPct: deltaPct(isolated.smallSpanMs, baseline.smallSpanMs),
        note: 'negative = isolated is faster for the SMALL tenant.',
      },
      samples,
      assertions: {
        everyRepeatSucceeded: samples.baseline
          .concat(samples.isolated)
          .every((row) => row.runs.small === SMALL_RUNS),
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
