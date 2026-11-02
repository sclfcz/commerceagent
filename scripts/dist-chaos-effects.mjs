#!/usr/bin/env node
/**
 * Chaos test for the durable-step / effect protocol.
 *
 * Three groups, 500 runs x (3 steps + 2 messages) each:
 *   naive            no step ledger; any retry re-sends both messages
 *   durable          checkpoint + effect intent/lookup protocol
 *   durable-nolookup same, but the provider cannot be queried (needs_review)
 *
 * The mock provider has HONOR_IDEMPOTENCY=false on purpose: dedupe must come
 * from our reconciliation, not from the external system.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';

const RUNS = Number(process.env.DIST_EFFECT_RUNS ?? 500);
const WORKERS = 6;
const CONCURRENCY = 8;
const LEASE_MS = 3_000;
const HEARTBEAT_MS = 1_000;
const MAX_ATTEMPTS = 5;
const KILLS = 5;
const ZOMBIE_PAUSE_MS = LEASE_MS * 2;
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;
const REPEATS = Number(process.env.DIST_EFFECT_REPEAT ?? 5);

const MOCK = {
  honorIdempotency: false,
  dropResponseRate: 0.1,
  errorRate: 0.05,
  latencyMs: 300,
};

const GROUPS = [
  { id: 'naive', mode: 'naive', lookup: true },
  { id: 'durable', mode: 'durable', lookup: true },
  { id: 'durable-nolookup', mode: 'durable', lookup: false },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) =>
  process.stderr.write(`[chaos-effects] ${message}\n`);

function median(values) {
  const present = values.filter((value) => typeof value === 'number');
  if (!present.length) return null;
  const sorted = [...present].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

const WORKER_ENTRY = path.join(ROOT, 'src/distributed/cli-worker.ts');
const children = new Set();
let sequence = 0;

function spawnWorker(tag) {
  sequence += 1;
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_WORKER_ID: `${tag}-w${sequence}`,
      DIST_DISPATCH: 'poll',
      DIST_EXECUTOR: 'effect',
      DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
      DIST_CLAIM_BATCH: '8',
      DIST_LEASE_MS: String(LEASE_MS),
      DIST_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DIST_POLL_MS: '100',
      DIST_REAPER_INTERVAL_MS: '500',
      DIST_BACKOFF_BASE_MS: '100',
      DIST_BACKOFF_MAX_MS: '400',
      DIST_EFFECT_TIMEOUT_MS: '1000',
      DIST_EFFECT_SETTLE_MS: '500',
      DIST_UNKNOWN_SWEEP_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.workerId = `${tag}-w${sequence}`;
  child.lastError = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    child.lastError = `${child.lastError}${chunk}`.slice(-600);
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

async function clearState(pool) {
  for (const table of [
    'dist_consumed_messages',
    'dist_outbox',
    'dist_run_steps',
    'dist_task_run_events',
    'dist_task_runs',
  ])
    await pool.query(`DELETE FROM ${table}`);
}

async function seed(pool, group, effectUrl) {
  const values = [];
  const params = [];
  for (let index = 0; index < RUNS; index++) {
    const payload = {
      steps: 3,
      stepSleepMs: 50 + Math.floor(Math.random() * 151),
      effectUrl,
      mode: group.mode,
      lookup: group.lookup,
    };
    values.push(
      "(UUID(), ?, 'effect-demo', ?, ?, SHA2(?, 256), 'queued', 0, ?, NOW(3), NOW(3), NOW(3))",
    );
    params.push(
      group.id,
      `${group.id}-${Date.now()}-${index}`,
      JSON.stringify(payload),
      JSON.stringify(payload),
      MAX_ATTEMPTS,
    );
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

async function waitForTerminal(pool, timeoutMs = OVERALL_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_runs
        WHERE status IN ('queued','running','retry_wait')`,
    );
    if (Number(row.total) === 0) return true;
    await sleep(200);
  }
  return false;
}

async function runGroup(pool, mock, group) {
  await clearState(pool);
  mock.reset();
  mock.setOptions({
    ...MOCK,
    lookup: group.lookup,
  });
  await seed(pool, group, mock.url);

  const workers = Array.from({ length: WORKERS }, () => spawnWorker(group.id));
  const startedAt = Date.now();
  const kills = [];
  let killCount = 0;
  let productiveKills = 0;

  const scheduleKill = (delayMs) => {
    if (killCount >= KILLS) return;
    setTimeout(async () => {
      const victims = workers.filter((child) => child.exitCode === null);
      if (victims.length) {
        const victim = victims[Math.floor(Math.random() * victims.length)];
        const [[running]] = await pool.query(
          `SELECT COUNT(*) AS total FROM dist_task_runs
            WHERE status = 'running' AND lease_owner = ?`,
          [victim.workerId],
        );
        if (Number(running.total) > 0) productiveKills += 1;
        victim.kill('SIGKILL');
        killCount += 1;
        kills.push({ workerId: victim.workerId, atMs: Date.now() - startedAt });
        notify(
          `${group.id}: killed ${victim.workerId} (${killCount}/${KILLS})`,
        );
        const position = workers.indexOf(victim);
        if (position >= 0) workers[position] = spawnWorker(group.id);
      }
      scheduleKill(2_000 + Math.random() * 2_000);
    }, delayMs);
  };
  scheduleKill(1_500);

  // One zombie: frozen while its leases expire, then resumes.
  const zombie = spawnWorker(`${group.id}-zombie`);
  workers.push(zombie);
  setTimeout(() => zombie.kill('SIGSTOP'), 2_000);
  setTimeout(() => {
    if (zombie.exitCode === null) zombie.kill('SIGCONT');
  }, 2_000 + ZOMBIE_PAUSE_MS);

  try {
    // Keep the loop alive until every scheduled kill has happened, so the
    // required 5 SIGKILLs are not silently skipped when runs finish early.
    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    for (;;) {
      const [[pending]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_runs
          WHERE status IN ('queued','running','retry_wait')`,
      );
      if (Number(pending.total) === 0 && killCount >= KILLS) break;
      if (Date.now() > deadline)
        throw new Error(`${group.id}: runs never reached a terminal state`);
      await sleep(200);
    }
    const finishedAt = Date.now();

    const [[statuses]] = await pool.query(
      `SELECT
         SUM(status = 'succeeded') AS succeeded,
         SUM(status = 'needs_review') AS needsReview,
         SUM(status = 'dead') AS dead,
         COUNT(*) AS total
       FROM dist_task_runs WHERE tenant_id = ?`,
      [group.id],
    );
    const [[events]] = await pool.query(
      `SELECT
         SUM(event = 'step_executed') AS stepsExecuted,
         SUM(event = 'step_skipped') AS stepsSkipped,
         SUM(event = 'effect_reconciled' AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.result')) = 'committed') AS reconciledCommitted,
         SUM(event = 'effect_reconciled' AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.result')) = 'not_found') AS reconciledNotFound,
         SUM(event = 'succeeded') AS succeededEvents,
         SUM(event = 'needs_review') AS needsReviewEvents
       FROM dist_task_run_events e
       JOIN dist_task_runs r ON r.id = e.run_id
       WHERE r.tenant_id = ?`,
      [group.id],
    );
    const [[duplicates]] = await pool.query(
      `SELECT COUNT(*) AS offenders FROM (
         SELECT e.run_id FROM dist_task_run_events e
           JOIN dist_task_runs r ON r.id = e.run_id
          WHERE e.event = 'succeeded' AND r.tenant_id = ?
          GROUP BY e.run_id HAVING COUNT(*) <> 1
       ) AS offenders`,
      [group.id],
    );
    const [[deferred]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events e
         JOIN dist_task_runs r ON r.id = e.run_id
        WHERE e.event = 'effect_reconcile_deferred' AND r.tenant_id = ?`,
      [group.id],
    );
    const [[notApplied]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events e
         JOIN dist_task_runs r ON r.id = e.run_id
        WHERE e.event = 'effect_not_applied' AND r.tenant_id = ?`,
      [group.id],
    );
    const [reviewRows] = await pool.query(
      `SELECT COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.detail, '$.reason')), 'unknown') AS reason,
              COUNT(*) AS total
         FROM dist_task_run_events e
         JOIN dist_task_runs r ON r.id = e.run_id
        WHERE e.event = 'needs_review' AND r.tenant_id = ?
        GROUP BY reason`,
      [group.id],
    );
    const needsReviewByReason = Object.fromEntries(
      reviewRows.map((row) => [String(row.reason), Number(row.total)]),
    );
    const [[unknown]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM dist_run_steps s JOIN dist_task_runs r ON r.id = s.run_id
        WHERE s.status = 'unknown' AND r.tenant_id = ?`,
      [group.id],
    );
    const [[staleUnknown]] = await pool.query(
      `SELECT COUNT(*) AS total
         FROM dist_run_steps s JOIN dist_task_runs r ON r.id = s.run_id
        WHERE s.status = 'unknown'
          AND s.updated_at < NOW(3) - INTERVAL 5 MINUTE
          AND r.status IN ('succeeded','dead','cancelled','needs_review')`,
    );

    const skipped = Number(events.stepsSkipped ?? 0);
    const executed = Number(events.stepsExecuted ?? 0);
    return {
      group: group.id,
      mode: group.mode,
      lookup: group.lookup,
      runs: {
        total: Number(statuses.total),
        succeeded: Number(statuses.succeeded ?? 0),
        needsReview: Number(statuses.needsReview ?? 0),
        dead: Number(statuses.dead ?? 0),
      },
      mock: { ...mock.stats },
      steps: {
        executed,
        skipped,
        checkpointSkipRatio:
          skipped + executed > 0
            ? Number((skipped / (skipped + executed)).toFixed(3))
            : null,
      },
      reconciledCommitted: Number(events.reconciledCommitted ?? 0),
      reconciledNotFound: Number(events.reconciledNotFound ?? 0),
      reconcileDeferred: Number(deferred.total),
      notAppliedRetries: Number(notApplied.total),
      needsReviewByReason,
      succeededEvents: Number(events.succeededEvents ?? 0),
      duplicateSucceededRuns: Number(duplicates.offenders),
      unknownStepsAtEnd: Number(unknown.total),
      staleUnknownSteps: Number(staleUnknown.total),
      durationMs: finishedAt - startedAt,
      kills: kills.length,
      productiveKills,
    };
  } finally {
    for (const child of workers) child.kill('SIGCONT');
    await stopAll();
  }
}

async function main() {
  const runId = `dist-chaos-effects-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
  const { startMockProvider } = await import('./mock-effect-provider.mjs');
  const mock = await startMockProvider(MOCK);

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
    await mock.close();
    await pool.end().catch(() => {});
    process.exit(exitCode);
  };

  try {
    const groups = {};
    for (const group of GROUPS) {
      const samples = [];
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        notify(`${group.id}: repeat ${repeat + 1}/${REPEATS}`);
        samples.push(await runGroup(pool, mock, group));
      }
      groups[group.id] = {
        repeats: samples.length,
        samples,
        median: {
          duplicateDeliveries: median(
            samples.map((row) => row.mock.duplicateDeliveries),
          ),
          deliveredMessages: median(
            samples.map((row) => row.mock.deliveredMessages),
          ),
          reconciledCommitted: median(
            samples.map((row) => row.reconciledCommitted),
          ),
          reconcileDeferred: median(
            samples.map((row) => row.reconcileDeferred),
          ),
          notAppliedRetries: median(
            samples.map((row) => row.notAppliedRetries),
          ),
          needsReviewByReason: Object.fromEntries(
            [
              ...new Set(
                samples.flatMap((row) =>
                  Object.keys(row.needsReviewByReason ?? {}),
                ),
              ),
            ].map((reason) => [
              reason,
              median(
                samples.map((row) => row.needsReviewByReason?.[reason] ?? 0),
              ),
            ]),
          ),
          reconciledNotFound: median(
            samples.map((row) => row.reconciledNotFound),
          ),
          stepsSkipped: median(samples.map((row) => row.steps.skipped)),
          checkpointSkipRatio: median(
            samples.map((row) => row.steps.checkpointSkipRatio),
          ),
          needsReview: median(samples.map((row) => row.runs.needsReview)),
          durationMs: median(samples.map((row) => row.durationMs)),
          succeeded: median(samples.map((row) => row.runs.succeeded)),
        },
      };
    }

    const durable = groups.durable.median;
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
        nodeVersion: process.version,
      },
      mockConfig: MOCK,
      config: {
        runs: RUNS,
        workers: WORKERS,
        concurrencyPerWorker: CONCURRENCY,
        maxAttempts: MAX_ATTEMPTS,
        stepsPerRun: 3,
        effectsPerRun: 2,
        kills: KILLS,
        zombiePauseMs: ZOMBIE_PAUSE_MS,
        repeats: REPEATS,
      },
      groups,
      comparison: {
        duplicateDeliveries: {
          naive: groups.naive.median.duplicateDeliveries,
          durable: groups.durable.median.duplicateDeliveries,
          'durable-nolookup':
            groups['durable-nolookup'].median.duplicateDeliveries,
        },
        deliveredMessages: {
          naive: groups.naive.median.deliveredMessages,
          durable: groups.durable.median.deliveredMessages,
          'durable-nolookup':
            groups['durable-nolookup'].median.deliveredMessages,
        },
      },
      assertions: {
        durableNoDuplicates: durable.duplicateDeliveries === 0,
        durableDeliveredExactlyTwoPerRun:
          durable.deliveredMessages === RUNS * 2,
        durableAllSucceeded: durable.succeeded === RUNS,
        durableOneSucceededEventPerRun: groups.durable.samples.every(
          (row) =>
            row.duplicateSucceededRuns === 0 && row.succeededEvents === RUNS,
        ),
        durableLedgerCoversRetries: (durable.stepsSkipped ?? 0) > 0,
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
