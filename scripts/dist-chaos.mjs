#!/usr/bin/env node
/**
 * Chaos test for the distributed claim/lease implementation.
 *
 * Spawns real worker processes, SIGKILLs them mid-run (and parks one with
 * SIGSTOP to simulate a zombie), then verifies over SQL that every run still
 * reaches a terminal state exactly once, that stale workers were fenced off,
 * and how long lease expiry detection and crash recovery took.
 *
 * Usage: npm run dist:chaos   (requires a running MySQL, see
 * docker-compose.distributed.yml and DIST_MYSQL_URL)
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';
const TOTAL_RUNS = Number(process.env.DIST_CHAOS_RUNS ?? 500);
const KILL_COUNT = Number(process.env.DIST_CHAOS_KILLS ?? 10);
const LEASE_MS = 5_000;
const HEARTBEAT_MS = 1_500;
const CONCURRENCY = 4;
const WORKER_COUNT = 6;
const MAX_ATTEMPTS = 3;
const ZOMBIE_PAUSE_MS = LEASE_MS * 2;
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const ZOMBIE_CLAIM_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notify(message) {
  process.stderr.write(`[chaos] ${message}\n`);
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

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(2));
}

const metrics = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Number(Math.max(...values).toFixed(2)) : null,
});

const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');

const children = new Set();
let workerSequence = 0;

function spawnWorker({ workerId, stopped = false } = {}) {
  workerSequence += 1;
  const id = workerId ?? `chaos-${workerSequence}`;
  // `--import tsx` keeps the worker in the spawned process itself. Wrapping the
  // tsx CLI instead makes it re-spawn node, so SIGKILL would only kill the
  // wrapper and leave an orphaned worker still holding leases.
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_WORKER_ID: id,
      DIST_LEASE_MS: String(LEASE_MS),
      DIST_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
      DIST_CLAIM_BATCH: String(CONCURRENCY),
      DIST_POLL_MS: '200',
      DIST_REAPER_INTERVAL_MS: '1000',
      DIST_BACKOFF_BASE_MS: '200',
      DIST_BACKOFF_MAX_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.workerId = id;
  child.stopped = stopped;
  child.lastError = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    child.lastError = `${child.lastError}${chunk}`.slice(-1000);
  });
  child.on('exit', () => children.delete(child));
  children.add(child);
  return child;
}

async function stopAllWorkers() {
  const alive = [...children];
  for (const child of alive) {
    if (child.exitCode === null && !child.killed) child.kill('SIGCONT');
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && [...children].length) await sleep(200);
  for (const child of [...children]) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await sleep(300);
}

async function main() {
  const startedAt = Date.now();
  const runId = `dist-chaos-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const pool = await mysql.createPool({
    uri: MYSQL_URL,
    waitForConnections: true,
    connectionLimit: 8,
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
    await stopAllWorkers();
    await pool.end().catch(() => {});
    process.exit(exitCode);
  };

  try {
    await pool.query('DELETE FROM dist_task_run_events');
    await pool.query('DELETE FROM dist_task_runs');

    const payloads = [];
    for (let index = 0; index < TOTAL_RUNS; index++) {
      const payload = { sleepMs: 100 + Math.floor(Math.random() * 901) };
      if (Math.random() < 0.1) payload.failTimes = 1;
      payloads.push(payload);
    }
    for (let offset = 0; offset < payloads.length; offset += 50) {
      const batch = payloads.slice(offset, offset + 50);
      const values = [];
      const params = [];
      for (let index = 0; index < batch.length; index++) {
        const payloadJson = JSON.stringify(batch[index]);
        const hash = createHash('sha256')
          .update(stableStringify(batch[index]), 'utf8')
          .digest('hex');
        values.push(
          "(UUID(), ?, ?, ?, ?, ?, 'queued', 0, ?, NOW(3), NOW(3), NOW(3))",
        );
        params.push(
          'chaos',
          'chaos-sleep',
          `chaos-${offset + index}`,
          payloadJson,
          hash,
          MAX_ATTEMPTS,
        );
      }
      await pool.query(
        `INSERT INTO dist_task_runs
           (id, tenant_id, task_id, idempotency_key, payload, payload_hash,
            status, attempt, max_attempts, available_at, created_at, updated_at)
         VALUES ${values.join(',')}`,
        params,
      );
    }
    notify(`submitted ${TOTAL_RUNS} runs`);

    const workers = Array.from({ length: WORKER_COUNT }, () => spawnWorker());
    // Zombie: keeps its leases while frozen, then wakes up with stale tokens.
    const zombie = spawnWorker({ workerId: 'chaos-zombie', stopped: true });
    const zombieClaimed = async () => {
      const [rows] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_run_events
          WHERE event = 'claimed' AND worker_id = 'chaos-zombie'`,
      );
      return Number(rows[0].total);
    };
    const claimDeadline = Date.now() + ZOMBIE_CLAIM_TIMEOUT_MS;
    while (Date.now() < claimDeadline) {
      if ((await zombieClaimed()) >= 1) break;
      await sleep(100);
    }
    const zombieClaimsBeforePause = await zombieClaimed();
    if (zombieClaimsBeforePause < 1)
      notify('zombie never claimed a run before the pause');
    zombie.kill('SIGSTOP');
    notify(`zombie paused for ${ZOMBIE_PAUSE_MS}ms`);
    setTimeout(() => {
      if (zombie.exitCode === null) {
        zombie.kill('SIGCONT');
        zombie.stopped = false;
        notify('zombie resumed');
      }
    }, ZOMBIE_PAUSE_MS);

    const kills = [];
    const killWorker = async (victim) => {
      const [rows] = await pool.query(
        `SELECT id FROM dist_task_runs WHERE status = 'running' AND lease_owner = ?`,
        [victim.workerId],
      );
      const at = Date.now();
      victim.kill('SIGKILL');
      kills.push({
        workerId: victim.workerId,
        at,
        runIds: rows.map((row) => String(row.id)),
      });
      notify(
        `killed ${victim.workerId} (${kills.length}/${KILL_COUNT})` +
          ` with ${rows.length} in-flight run(s)`,
      );
      const exitTimer = setTimeout(() => {
        if (victim.exitCode === null && victim.signalCode === null)
          notify(`${victim.workerId} did not exit 3s after SIGKILL`);
      }, 3_000);
      victim.once('exit', () => clearTimeout(exitTimer));
      const replacement = spawnWorker();
      const position = workers.indexOf(victim);
      if (position >= 0) workers[position] = replacement;
      else workers.push(replacement);
    };

    const scheduleKill = (delayMs) => {
      if (kills.length >= KILL_COUNT) return;
      setTimeout(() => {
        const victims = [...workers].filter(
          (child) => child.exitCode === null && !child.stopped,
        );
        if (!victims.length) {
          scheduleKill(1_000);
          return;
        }
        const victim = victims[Math.floor(Math.random() * victims.length)];
        void killWorker(victim).finally(() =>
          scheduleKill(3_000 + Math.random() * 3_000),
        );
      }, delayMs);
    };
    scheduleKill(1_500);

    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    let pending = null;
    while (Date.now() < deadline) {
      const [rows] = await pool.query(
        `SELECT status, COUNT(*) AS total FROM dist_task_runs GROUP BY status`,
      );
      const counts = Object.fromEntries(
        rows.map((row) => [row.status, Number(row.total)]),
      );
      pending =
        (counts.queued ?? 0) + (counts.running ?? 0) + (counts.retry_wait ?? 0);
      if (pending === 0 && kills.length >= KILL_COUNT) break;
      await sleep(500);
    }
    if (pending !== 0) {
      notify(`timed out with ${pending} pending runs`);
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
    // Wait out any kill that is still scheduled so the metric windows close.
    const killDeadline = Date.now() + 60_000;
    while (kills.length < KILL_COUNT && Date.now() < killDeadline)
      await sleep(200);

    await stopAllWorkers();

    const [statusRows] = await pool.query(
      `SELECT status, COUNT(*) AS total FROM dist_task_runs GROUP BY status`,
    );
    const statusCounts = Object.fromEntries(
      statusRows.map((row) => [row.status, Number(row.total)]),
    );
    const [eventRows] = await pool.query(
      `SELECT event, COUNT(*) AS total FROM dist_task_run_events GROUP BY event`,
    );
    const eventCounts = Object.fromEntries(
      eventRows.map((row) => [row.event, Number(row.total)]),
    );
    const [[duplicateSucceeded]] = await pool.query(
      `SELECT COUNT(*) AS offenders FROM (
         SELECT run_id FROM dist_task_run_events
          WHERE event = 'succeeded'
          GROUP BY run_id HAVING COUNT(*) <> 1
       ) AS offenders`,
    );
    const [[deadWithoutBudget]] = await pool.query(
      `SELECT COUNT(*) AS offenders FROM dist_task_runs
        WHERE status = 'dead' AND attempt < max_attempts`,
    );
    const [[zombieStaleWrites]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events
        WHERE event = 'stale_write_rejected'
          AND worker_id = 'chaos-zombie'
          AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.operation')) IN ('complete','fail')`,
    );
    const [[zombieStaleSuccess]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events e
         JOIN dist_task_runs r ON r.id = e.run_id
        WHERE e.event = 'succeeded'
          AND e.worker_id = 'chaos-zombie'
          AND e.lease_token < r.lease_token`,
    );

    const [queueLatencyRows] = await pool.query(
      `SELECT TIMESTAMPDIFF(MICROSECOND, created_at, started_at) / 1000 AS ms
         FROM dist_task_runs WHERE started_at IS NOT NULL`,
    );
    // Reap + claim history, used for the two recovery metrics below.
    const [reapedRows] = await pool.query(
      `SELECT created_at, detail FROM dist_task_run_events WHERE event = 'reaped'`,
    );
    const [claimRows] = await pool.query(
      `SELECT id, run_id, worker_id, created_at
         FROM dist_task_run_events WHERE event = 'claimed' ORDER BY id`,
    );

    const leaseExpiryDetection = [];
    for (const row of reapedRows) {
      const previous = row.detail?.previousLeaseExpiresAt;
      if (!previous) continue;
      const detectedAt = new Date(row.created_at).getTime();
      const expiredAt = Date.parse(previous);
      if (!Number.isFinite(expiredAt)) continue;
      leaseExpiryDetection.push(detectedAt - expiredAt);
    }

    const claimsByRun = new Map();
    for (const row of claimRows) {
      const list = claimsByRun.get(row.run_id) ?? [];
      list.push({
        workerId: row.worker_id,
        at: new Date(row.created_at).getTime(),
      });
      claimsByRun.set(row.run_id, list);
    }
    const crashRecovery = [];
    let productiveKills = 0;
    for (const kill of kills) {
      let productive = false;
      for (const runIdValue of kill.runIds) {
        const next = (claimsByRun.get(runIdValue) ?? []).find(
          (claim) => claim.at >= kill.at && claim.workerId !== kill.workerId,
        );
        if (!next) continue;
        productive = true;
        crashRecovery.push(next.at - kill.at);
      }
      if (productive) productiveKills += 1;
    }

    const durationMs = Date.now() - startedAt;
    const succeeded = statusCounts.succeeded ?? 0;
    const dead = statusCounts.dead ?? 0;
    const report = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs,
      throughputRunsPerSecond: Number(
        (succeeded / (durationMs / 1000)).toFixed(2),
      ),
      runs: {
        total: TOTAL_RUNS,
        succeeded,
        dead,
        cancelled: statusCounts.cancelled ?? 0,
        running: statusCounts.running ?? 0,
        retryWait: statusCounts.retry_wait ?? 0,
        queued: statusCounts.queued ?? 0,
      },
      events: {
        succeeded: eventCounts.succeeded ?? 0,
        reaped: eventCounts.reaped ?? 0,
        staleWriteRejected: eventCounts.stale_write_rejected ?? 0,
        failedRetry: eventCounts.failed_retry ?? 0,
        dead: eventCounts.dead ?? 0,
        released: eventCounts.released ?? 0,
        heartbeatLost: eventCounts.heartbeat_lost ?? 0,
      },
      queueLatencyMs: metrics(queueLatencyRows.map((row) => Number(row.ms))),
      leaseExpiryDetectionMs: metrics(leaseExpiryDetection),
      crashRecoveryMs: metrics(crashRecovery),
      definitions: {
        queueLatencyMs:
          'created_at -> started_at; includes backlog wait, not a pure scheduler delay.',
        leaseExpiryDetectionMs:
          'reaped.created_at - reaped.detail.previousLeaseExpiresAt; upper bound ~reaperIntervalMs.',
        crashRecoveryMs:
          'SIGKILL timestamp -> first claim of that run by a different worker; upper bound ~leaseMs + reaperInterval.',
      },
      assertions: {
        tenKillsExecuted: kills.length === KILL_COUNT,
        allRunsTerminal: pending === 0,
        exactlyOneSucceededEventPerRun:
          Number(duplicateSucceeded.offenders) === 0 &&
          (eventCounts.succeeded ?? 0) === succeeded,
        deadRunsExplained: Number(deadWithoutBudget.offenders) === 0,
        zombieStaleWriteObserved: Number(zombieStaleWrites.total) > 0,
        zombieNoStaleSucceeded: Number(zombieStaleSuccess.total) === 0,
      },
      environment: {
        mysqlUrlHost: new URL(MYSQL_URL).host,
        leaseMs: LEASE_MS,
        heartbeatMs: HEARTBEAT_MS,
        concurrencyPerWorker: CONCURRENCY,
        maxAttempts: MAX_ATTEMPTS,
        initialWorkers: WORKER_COUNT,
        kills: kills.length,
        productiveKills,
        zombiePauseMs: ZOMBIE_PAUSE_MS,
        zombieClaimsBeforePause,
        zombieStaleWrites: Number(zombieStaleWrites.total),
      },
    };
    if (dead > 0)
      report.deadRunsNote =
        'Dead runs exhausted max_attempts after being killed repeatedly; ' +
        'max_attempts was deliberately left at 3 instead of hiding it.';
    if (productiveKills < kills.length)
      report.killPlanNote =
        `${kills.length - productiveKills} kill(s) hit workers whose runs had ` +
        'already drained, so they produced no crash-recovery sample.';
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
    notify(`received ${signal}, stopping workers`);
    void stopAllWorkers().finally(() => process.exit(130));
  });
}

await main();
