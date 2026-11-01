#!/usr/bin/env node
/**
 * Dispatch comparison: poll vs MQ.
 *
 * 1. low-load dispatch latency — 8 workers, one run every 50ms (2000 runs)
 * 2. idle database pressure — 8 idle workers for 60s, `Questions` delta
 * 3. high-load throughput — 20000 queued runs
 *
 * Every measurement is repeated 3 times; the report carries the median.
 * Usage: npm run dist:bench:dispatch
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import amqp from 'amqplib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';
const AMQP_URL =
  process.env.DIST_AMQP_URL?.trim() || 'amqp://dist:dist@127.0.0.1:5672';

const WORKERS = 8;
const CONCURRENCY = 8;
const RELAYS = 2;
const LATENCY_RUNS = Number(process.env.DIST_BENCH_LATENCY_RUNS ?? 2000);
const SUBMIT_INTERVAL_MS = Number(process.env.DIST_BENCH_SUBMIT_MS ?? 50);
const IDLE_SECONDS = Number(process.env.DIST_BENCH_IDLE_SECONDS ?? 60);
const THROUGHPUT_RUNS = Number(process.env.DIST_BENCH_RUNS ?? 20_000);
const REPEATS = Math.max(1, Number(process.env.DIST_BENCH_REPEAT ?? 3) || 3);
const PHASE_TIMEOUT_MS = 10 * 60 * 1000;

const EXCHANGE = 'dist.runs';
const MAIN_QUEUE = 'dist.runs.ready';
const RETRY_QUEUES = [
  'dist.runs.retry.5s',
  'dist.runs.retry.30s',
  'dist.runs.retry.300s',
];
const DLQ = 'dist.runs.dlq';

const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');
const RELAY_ENTRY = path.join(ROOT, 'src/distributed/cli-relay.ts');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) =>
  process.stderr.write(`[bench-dispatch] ${message}\n`);

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

const children = new Set();

function spawnService(entry, env) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: ROOT,
    env: {
      ...process.env,
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_AMQP_URL: AMQP_URL,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.lastError = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    child.lastError = `${child.lastError}${chunk}`.slice(-600);
  });
  child.on('exit', () => children.delete(child));
  children.add(child);
  return child;
}

function spawnWorkers(mode, count = WORKERS) {
  return Array.from({ length: count }, (_, index) => {
    const env = {
      DIST_WORKER_ID: `bench-${mode}-w${index}`,
      DIST_DISPATCH: mode,
      DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
      DIST_CLAIM_BATCH: String(CONCURRENCY),
      DIST_LEASE_MS: '60000',
      DIST_HEARTBEAT_MS: '20000',
      DIST_REAPER_INTERVAL_MS: '60000',
      DIST_POLL_MS: '1000',
      DIST_FALLBACK_POLL_MS: '30000',
      DIST_BACKOFF_BASE_MS: '10',
      DIST_BACKOFF_MAX_MS: '100',
    };
    return spawnService(WORKER_ENTRY, env);
  });
}

function spawnRelays(count = RELAYS) {
  return Array.from({ length: count }, () =>
    spawnService(RELAY_ENTRY, {
      DIST_RELAY_BATCH_SIZE: '100',
      DIST_RELAY_POLL_MS: '100',
      DIST_RELAY_CRASH_AFTER_CONFIRM_RATE: '0',
      DIST_RELAY_DUPLICATE_RATE: '0',
    }),
  );
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

async function purgeQueues(channel) {
  for (const queue of [MAIN_QUEUE, ...RETRY_QUEUES, DLQ]) {
    try {
      await channel.purgeQueue(queue);
    } catch {
      /* queue does not exist yet */
    }
  }
}

async function resetState(pool, channel) {
  for (const table of [
    'dist_consumed_messages',
    'dist_outbox',
    'dist_task_run_events',
    'dist_task_runs',
  ])
    await pool.query(`DELETE FROM ${table}`);
  await purgeQueues(channel);
}

function runRow(index, tenant, maxAttempts = 3) {
  const payload = { sleepMs: 0 };
  return {
    payloadJson: JSON.stringify(payload),
    hash: createHash('sha256')
      .update(stableStringify(payload), 'utf8')
      .digest('hex'),
    idempotencyKey: `${tenant}-${index}`,
    tenant,
    maxAttempts,
  };
}

/** Insert one run, plus its outbox row when the mode needs a wake-up. */
async function submitOne(pool, mode, { tenant, index }) {
  const row = runRow(index, tenant);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO dist_task_runs
         (id, tenant_id, task_id, idempotency_key, payload, payload_hash,
          status, attempt, max_attempts, available_at, created_at, updated_at)
       VALUES (UUID(), ?, 'noop', ?, ?, ?, 'queued', 0, ?, NOW(3), NOW(3), NOW(3))`,
      [
        row.tenant,
        row.idempotencyKey,
        row.payloadJson,
        row.hash,
        row.maxAttempts,
      ],
    );
    if (mode === 'mq')
      await connection.query(
        `INSERT INTO dist_outbox
           (run_id, event_type, payload, status, publish_attempts, available_at, created_at)
         SELECT id, 'run.ready', JSON_OBJECT('runId', id, 'tenantId', tenant_id),
                'pending', 0, available_at, NOW(3)
           FROM dist_task_runs WHERE idempotency_key = ? AND tenant_id = ?`,
        [row.idempotencyKey, row.tenant],
      );
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

/** Bulk insert N queued runs (+ outbox rows in mq mode). */
async function seedBulk(pool, mode, count, tenant) {
  const values = [];
  const params = [];
  for (let index = 0; index < count; index++) {
    const row = runRow(index, tenant);
    values.push(
      "(UUID(), ?, 'noop', ?, ?, ?, 'queued', 0, ?, NOW(3), NOW(3), NOW(3))",
    );
    params.push(
      row.tenant,
      row.idempotencyKey,
      row.payloadJson,
      row.hash,
      row.maxAttempts,
    );
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
  if (mode === 'mq')
    await pool.query(
      `INSERT INTO dist_outbox
         (run_id, event_type, payload, status, publish_attempts, available_at, created_at)
       SELECT id, 'run.ready',
              JSON_OBJECT('runId', id, 'tenantId', tenant_id),
              'pending', 0, available_at, NOW(3)
         FROM dist_task_runs WHERE tenant_id = ?`,
      [tenant],
    );
}

async function waitForTerminal(pool, timeoutMs = PHASE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [[pending]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_runs
        WHERE status IN ('queued','running','retry_wait')`,
    );
    const [[outbox]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_outbox WHERE status = 'pending'`,
    );
    if (Number(pending.total) === 0 && Number(outbox.total) === 0) return true;
    await sleep(200);
  }
  return false;
}

async function dispatchLatency(pool) {
  const [rows] = await pool.query(
    `SELECT TIMESTAMPDIFF(MICROSECOND, r.created_at, MIN(e.created_at)) / 1000 AS ms
       FROM dist_task_runs r
       JOIN dist_task_run_events e ON e.run_id = r.id AND e.event = 'claimed'
      GROUP BY r.id`,
  );
  return summarize(rows.map((row) => Number(row.ms)));
}

async function questions(pool) {
  const [[row]] = await pool.query(`SHOW GLOBAL STATUS LIKE 'Questions'`);
  return Number(row.Value);
}

async function runMode(pool, channel, mode) {
  const phase = { mode };

  // ── 1. low-load dispatch latency ──────────────────────────────────────────
  await resetState(pool, channel);
  {
    const tenant = `bench-latency-${mode}-${Date.now()}`;
    const workers = spawnWorkers(mode);
    const relays = mode === 'mq' ? spawnRelays(1) : [];
    try {
      const startedAt = Date.now();
      for (let index = 0; index < LATENCY_RUNS; index++) {
        await submitOne(pool, mode, { tenant, index });
        const nextTick = startedAt + (index + 1) * SUBMIT_INTERVAL_MS;
        const waitMs = nextTick - Date.now();
        if (waitMs > 0) await sleep(waitMs);
      }
      if (!(await waitForTerminal(pool)))
        throw new Error(`${mode}: latency phase did not drain`);
      phase.dispatchLatency = await dispatchLatency(pool);
    } finally {
      for (const child of [...workers, ...relays]) child.kill('SIGTERM');
      await stopAll();
    }
  }

  // ── 2. idle database pressure ─────────────────────────────────────────────
  await resetState(pool, channel);
  {
    const workers = spawnWorkers(mode);
    const relays = mode === 'mq' ? spawnRelays(1) : [];
    try {
      await sleep(3_000); // let connections settle
      const before = await questions(pool);
      await sleep(IDLE_SECONDS * 1000);
      const after = await questions(pool);
      phase.idleDbQuestions = {
        windowSeconds: IDLE_SECONDS,
        delta: after - before,
        perSecond: Number(((after - before) / IDLE_SECONDS).toFixed(2)),
      };
    } finally {
      for (const child of [...workers, ...relays]) child.kill('SIGTERM');
      await stopAll();
    }
  }

  // ── 3. high-load throughput ───────────────────────────────────────────────
  await resetState(pool, channel);
  {
    const tenant = `bench-throughput-${mode}-${Date.now()}`;
    await seedBulk(pool, mode, THROUGHPUT_RUNS, tenant);
    const workers = spawnWorkers(mode);
    const relays = mode === 'mq' ? spawnRelays(RELAYS) : [];
    try {
      const startedAt = Date.now();
      if (!(await waitForTerminal(pool)))
        throw new Error(`${mode}: throughput phase did not drain`);
      const finishedAt = Date.now();
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
      const [[succeeded]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_runs WHERE status = 'succeeded'`,
      );
      phase.throughput = {
        runs: THROUGHPUT_RUNS,
        succeeded: Number(succeeded.total),
        wallClockMs: finishedAt - startedAt,
        processingMs,
        runsPerSecond:
          processingMs && processingMs > 0
            ? Number(
                (Number(succeeded.total) / (processingMs / 1000)).toFixed(2),
              )
            : null,
      };
    } finally {
      for (const child of [...workers, ...relays]) child.kill('SIGTERM');
      await stopAll();
    }
  }
  return phase;
}

async function brokerVersion() {
  try {
    const response = await fetch('http://127.0.0.1:15672/api/overview', {
      headers: {
        Authorization: `Basic ${Buffer.from('dist:dist').toString('base64')}`,
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = await response.json();
      if (body.rabbitmq_version)
        return { version: body.rabbitmq_version, source: 'management-api' };
    }
  } catch {
    /* fall through */
  }
  return { version: null, source: 'unavailable' };
}

async function main() {
  const runId = `dist-bench-dispatch-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const startedAt = Date.now();
  const pool = await mysql.createPool({
    uri: MYSQL_URL,
    waitForConnections: true,
    connectionLimit: 16,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'", () => {});
  });
  const admin = await amqp.connect(AMQP_URL);
  const channel = await admin.createChannel();

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
    await channel.close().catch(() => {});
    await admin.close().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(exitCode);
  };

  try {
    const [[version]] = await pool.query(
      'SELECT VERSION() AS version, @@version_comment AS comment',
    );
    const samples = { poll: [], mq: [] };
    for (let repeat = 0; repeat < REPEATS; repeat++) {
      for (const mode of ['poll', 'mq']) {
        notify(`repeat ${repeat + 1}/${REPEATS}: ${mode}`);
        samples[mode].push(await runMode(pool, channel, mode));
      }
    }

    const collect = (mode, pick) =>
      samples[mode]
        .map(pick)
        .filter((value) => value !== null && value !== undefined);
    const summaryFor = (mode) => {
      const latencies = samples[mode].map((phase) => phase.dispatchLatency);
      return {
        repeats: samples[mode].length,
        dispatchLatencyMs: {
          p50: median(latencies.map((entry) => entry.p50)),
          p95: median(latencies.map((entry) => entry.p95)),
          p99: median(latencies.map((entry) => entry.p99)),
          samplesPerRepeat: latencies.map((entry) => entry.samples),
        },
        idleDbQuestionsPerSecond: median(
          collect(mode, (phase) => phase.idleDbQuestions?.perSecond),
        ),
        idleDbQuestionsPerRepeat: collect(
          mode,
          (phase) => phase.idleDbQuestions?.delta,
        ),
        throughputRunsPerSecond: median(
          collect(mode, (phase) => phase.throughput?.runsPerSecond),
        ),
        throughputWallClockMs: median(
          collect(mode, (phase) => phase.throughput?.wallClockMs),
        ),
        succeededPerRepeat: collect(
          mode,
          (phase) => phase.throughput?.succeeded,
        ),
      };
    };
    const poll = summaryFor('poll');
    const mq = summaryFor('mq');
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
      rabbitmq: {
        host: new URL(AMQP_URL).host,
        ...(await brokerVersion()),
      },
      config: {
        workers: WORKERS,
        concurrencyPerWorker: CONCURRENCY,
        relaysInMqMode: RELAYS,
        latencyRuns: LATENCY_RUNS,
        submitIntervalMs: SUBMIT_INTERVAL_MS,
        idleSeconds: IDLE_SECONDS,
        throughputRuns: THROUGHPUT_RUNS,
        repeats: REPEATS,
        pollMs: 1000,
        fallbackPollMs: 30_000,
      },
      lowLoadDispatch: {
        poll,
        mq,
        comparison: {
          p50DeltaPct: deltaPct(
            mq.dispatchLatencyMs.p50,
            poll.dispatchLatencyMs.p50,
          ),
          p95DeltaPct: deltaPct(
            mq.dispatchLatencyMs.p95,
            poll.dispatchLatencyMs.p95,
          ),
          p99DeltaPct: deltaPct(
            mq.dispatchLatencyMs.p99,
            poll.dispatchLatencyMs.p99,
          ),
          note: 'mq is the improvement over poll; latency is submitted -> first claimed and includes queue backlog.',
        },
      },
      idleDbPressure: {
        poll,
        mq,
        comparison: {
          questionsPerSecondDeltaPct: deltaPct(
            mq.idleDbQuestionsPerSecond,
            poll.idleDbQuestionsPerSecond,
          ),
          note: 'mq includes the relay polling dist_outbox; poll includes worker claim polls.',
        },
      },
      highLoadThroughput: {
        poll,
        mq,
        comparison: {
          runsPerSecondDeltaPct: deltaPct(
            mq.throughputRunsPerSecond,
            poll.throughputRunsPerSecond,
          ),
        },
      },
      samples,
      assertions: {
        everyPhaseDrained: samples.poll
          .concat(samples.mq)
          .every(
            (phase) =>
              phase.throughput?.succeeded === THROUGHPUT_RUNS &&
              (phase.dispatchLatency?.samples ?? 0) === LATENCY_RUNS,
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
    void stopAll().finally(() => process.exit(130));
  });
}

await main();
