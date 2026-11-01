#!/usr/bin/env node
/**
 * Chaos test for the MQ dispatch path (Phase 2).
 *
 * 500 runs, 6 MQ-mode workers, 2 relays, with:
 *   - 5 worker SIGKILLs, 3 relay SIGKILLs (each replaced immediately),
 *   - relay fault injection: 5% crash between confirm and commit, 10% duplicate
 *     publish,
 *   - one RabbitMQ restart,
 *   - one purge of the main queue.
 *
 * Correctness is asserted on MySQL (the authority), not on the broker:
 * every run succeeds exactly once, the outbox drains, and the DLQ is empty.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const RABBIT_CONTAINER =
  process.env.DIST_RABBIT_CONTAINER?.trim() || 'commerceagent-dist-rabbit';

const TOTAL_RUNS = Number(process.env.DIST_CHAOS_RUNS ?? 500);
const WORKER_COUNT = 6;
const RELAY_COUNT = 2;
const CONCURRENCY = 4;
const LEASE_MS = 5_000;
const HEARTBEAT_MS = 1_500;
// Shortened so a purged wake-up is recovered quickly; the production default
// is 30s (see DIST_FALLBACK_POLL_MS).
const FALLBACK_POLL_MS = 5_000;
const WORKER_KILLS = 5;
const RELAY_KILLS = 3;
const CRASH_AFTER_CONFIRM_RATE = 0.05;
const DUPLICATE_RATE = 0.1;
const OVERALL_TIMEOUT_MS = 10 * 60 * 1000;

const EXCHANGE = 'dist.runs';
const QUEUE_PREFIX = 'dist.runs';
const MAIN_QUEUE = `${QUEUE_PREFIX}.ready`;
const RETRY_QUEUES = [
  `${QUEUE_PREFIX}.retry.5s`,
  `${QUEUE_PREFIX}.retry.30s`,
  `${QUEUE_PREFIX}.retry.300s`,
];
const DLQ = `${QUEUE_PREFIX}.dlq`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) => process.stderr.write(`[chaos-mq] ${message}\n`);

function percentile(sorted, quantile) {
  if (!sorted.length) return null;
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
    p99: percentile(sorted, 0.99),
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
const RELAY_ENTRY = path.join(ROOT, 'src/distributed/cli-relay.ts');

const children = new Set();
let workerSequence = 0;
let relaySequence = 0;

function spawnService(entry, env, kind) {
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
  child.kind = kind;
  child.lastError = '';
  child.stdout.on('data', () => {});
  child.stderr.on('data', (chunk) => {
    child.lastError = `${child.lastError}${chunk}`.slice(-800);
  });
  child.on('exit', () => children.delete(child));
  children.add(child);
  return child;
}

function spawnWorker() {
  workerSequence += 1;
  return spawnService(
    WORKER_ENTRY,
    {
      DIST_WORKER_ID: `chaos-mq-w${workerSequence}`,
      DIST_DISPATCH: 'mq',
      DIST_WORKER_CONCURRENCY: String(CONCURRENCY),
      DIST_CLAIM_BATCH: String(CONCURRENCY),
      DIST_LEASE_MS: String(LEASE_MS),
      DIST_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DIST_FALLBACK_POLL_MS: String(FALLBACK_POLL_MS),
      DIST_REAPER_INTERVAL_MS: '1000',
      DIST_POLL_MS: '200',
      DIST_BACKOFF_BASE_MS: '200',
      DIST_BACKOFF_MAX_MS: '2000',
    },
    'worker',
  );
}

function spawnRelay() {
  relaySequence += 1;
  return spawnService(
    RELAY_ENTRY,
    {
      DIST_RELAY_BATCH_SIZE: '50',
      DIST_RELAY_POLL_MS: '100',
      DIST_RELAY_CRASH_AFTER_CONFIRM_RATE: String(CRASH_AFTER_CONFIRM_RATE),
      DIST_RELAY_DUPLICATE_RATE: String(DUPLICATE_RATE),
    },
    'relay',
  );
}

async function stopAll() {
  for (const child of [...children]) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && [...children].length) await sleep(100);
  for (const child of [...children]) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await sleep(300);
}

async function purgeQueues(channel) {
  for (const queue of [MAIN_QUEUE, ...RETRY_QUEUES, DLQ]) {
    try {
      await channel.purgeQueue(queue);
    } catch {
      /* queue may not exist yet */
    }
  }
}

async function restartBroker() {
  const attempts = [
    ['docker', ['restart', RABBIT_CONTAINER]],
    ['brew', ['services', 'restart', 'rabbitmq']],
  ];
  for (const [command, args] of attempts) {
    const label = `${command} ${args.join(' ')}`;
    const startedAt = Date.now();
    try {
      await new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 120_000 }, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      notify(`${label} failed: ${error.message?.slice(0, 120)}`);
      continue;
    }
    // Wait until a new connection can be opened again.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const connection = await amqp.connect(AMQP_URL);
        await connection.close();
        return {
          method: label,
          ok: true,
          commandMs: Date.now() - startedAt,
          readyAt: Date.now(),
        };
      } catch {
        await sleep(250);
      }
    }
    return { method: label, ok: false, commandMs: Date.now() - startedAt };
  }
  return { method: null, ok: false, commandMs: null };
}

async function main() {
  const startedAt = Date.now();
  const runId = `dist-chaos-mq-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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
  let adminConnection = await amqp.connect(AMQP_URL);
  let adminChannel = await adminConnection.createChannel();

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
    await adminChannel.close().catch(() => {});
    await adminConnection.close().catch(() => {});
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
    await purgeQueues(adminChannel);

    // Seed runs and their outbox rows the way the repository would.
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
          "(UUID(), ?, ?, ?, ?, ?, 'queued', 0, 3, NOW(3), NOW(3), NOW(3))",
        );
        params.push(
          'chaos-mq',
          'chaos-mq',
          `chaos-mq-${offset + index}`,
          payloadJson,
          hash,
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
    await pool.query(
      `INSERT INTO dist_outbox
         (run_id, event_type, payload, status, publish_attempts, available_at, created_at)
       SELECT id, 'run.ready',
              JSON_OBJECT('runId', id, 'tenantId', tenant_id),
              'pending', 0, available_at, NOW(3)
         FROM dist_task_runs WHERE tenant_id = 'chaos-mq'`,
    );
    notify(`seeded ${TOTAL_RUNS} runs + outbox rows`);

    const workers = Array.from({ length: WORKER_COUNT }, () => spawnWorker());
    const relays = Array.from({ length: RELAY_COUNT }, () => spawnRelay());

    const injections = {
      workerKills: 0,
      relayKills: 0,
      relayRestarts: 0,
      purgeAt: null,
      purgeError: null,
      restart: null,
    };
    // Relays die from SIGKILL *and* from the crash-after-confirm injection; a
    // production deployment has a supervisor, so restart them here too or the
    // outbox would never drain again.
    const superviseRelays = setInterval(() => {
      for (let index = 0; index < relays.length; index++) {
        if (relays[index].exitCode !== null) {
          relays[index] = spawnRelay();
          injections.relayRestarts += 1;
          notify(
            `restarted a relay (supervisor, #${injections.relayRestarts})`,
          );
        }
      }
    }, 500);
    const scheduleWorkerKill = (delayMs) => {
      if (injections.workerKills >= WORKER_KILLS) return;
      setTimeout(() => {
        const victims = workers.filter((child) => child.exitCode === null);
        if (victims.length) {
          const victim = victims[Math.floor(Math.random() * victims.length)];
          victim.kill('SIGKILL');
          injections.workerKills += 1;
          notify(`killed ${victim.kind} #${injections.workerKills}`);
          const replacement = spawnWorker();
          const position = workers.indexOf(victim);
          if (position >= 0) workers[position] = replacement;
        }
        scheduleWorkerKill(3_000 + Math.random() * 3_000);
      }, delayMs);
    };
    const scheduleRelayKill = (delayMs) => {
      if (injections.relayKills >= RELAY_KILLS) return;
      setTimeout(() => {
        const victims = relays.filter((child) => child.exitCode === null);
        if (victims.length) {
          const victim = victims[Math.floor(Math.random() * victims.length)];
          victim.kill('SIGKILL');
          injections.relayKills += 1;
          notify(`killed relay #${injections.relayKills}`);
          const replacement = spawnRelay();
          const position = relays.indexOf(victim);
          if (position >= 0) relays[position] = replacement;
        }
        scheduleRelayKill(5_000 + Math.random() * 3_000);
      }, delayMs);
    };

    scheduleWorkerKill(3_000);
    scheduleRelayKill(4_000);

    setTimeout(() => {
      void (async () => {
        try {
          await adminChannel.purgeQueue(MAIN_QUEUE);
          injections.purgeAt = Date.now();
          notify('purged the main queue');
        } catch (error) {
          injections.purgeError = error.message?.slice(0, 200) ?? 'unknown';
          notify(`purge failed: ${error.message?.slice(0, 120)}`);
        }
      })();
    }, 3_000);

    let restartPromise = null;
    setTimeout(() => {
      restartPromise = (async () => {
        notify('restarting RabbitMQ');
        injections.restart = await restartBroker();
        // The restart killed our admin channel; reopen it for the final checks.
        try {
          await adminChannel.close();
        } catch {
          /* already closed by the restart */
        }
        try {
          await adminConnection.close();
        } catch {
          /* already closed by the restart */
        }
        adminConnection = await amqp.connect(AMQP_URL);
        adminChannel = await adminConnection.createChannel();
        notify(
          `broker restart via ${injections.restart.method ?? 'unknown'} ` +
            `(${injections.restart.ok ? 'ok' : 'failed'})`,
        );
      })();
    }, 7_000);

    const deadline = Date.now() + OVERALL_TIMEOUT_MS;
    let pending = null;
    let outboxPending = null;
    while (Date.now() < deadline) {
      const [[runs]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_task_runs
          WHERE status IN ('queued','running','retry_wait')`,
      );
      const [[outbox]] = await pool.query(
        `SELECT COUNT(*) AS total FROM dist_outbox WHERE status = 'pending'`,
      );
      pending = Number(runs.total);
      outboxPending = Number(outbox.total);
      if (
        pending === 0 &&
        outboxPending === 0 &&
        injections.workerKills >= WORKER_KILLS &&
        injections.relayKills >= RELAY_KILLS &&
        injections.restart !== null
      )
        break;
      await sleep(300);
    }
    if (pending !== 0 || outboxPending !== 0) {
      notify(
        `timed out with ${pending} runs / ${outboxPending} outbox rows pending`,
      );
      await finish(
        {
          runId,
          passed: false,
          reason: 'timeout',
          pending,
          outboxPending,
          injections,
          durationMs: Date.now() - startedAt,
        },
        1,
      );
      return;
    }
    clearInterval(superviseRelays);
    if (restartPromise) await restartPromise;
    await stopAll();

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
    const [[outboxLeft]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_outbox WHERE status = 'pending'`,
    );
    const [consumedRows] = await pool.query(
      `SELECT outcome, COUNT(*) AS total FROM dist_consumed_messages GROUP BY outcome`,
    );
    const consumed = Object.fromEntries(
      consumedRows.map((row) => [row.outcome, Number(row.total)]),
    );
    const [dispatchRows] = await pool.query(
      `SELECT TIMESTAMPDIFF(MICROSECOND, r.created_at, MIN(e.created_at)) / 1000 AS ms
         FROM dist_task_runs r
         JOIN dist_task_run_events e ON e.run_id = r.id AND e.event = 'claimed'
        GROUP BY r.id`,
    );
    const [[published]] = await pool.query(
      `SELECT COUNT(*) AS total, MIN(published_at) AS firstAt, MAX(published_at) AS lastAt
         FROM dist_outbox WHERE status = 'published'`,
    );
    const [[reaped]] = await pool.query(
      `SELECT COUNT(*) AS total FROM dist_task_run_events WHERE event = 'reaped'`,
    );

    let dlqMessages = 0;
    try {
      const info = await adminChannel.checkQueue(DLQ);
      dlqMessages = info.messageCount;
    } catch {
      dlqMessages = 0;
    }

    let restartRecoveryMs = null;
    if (injections.restart?.readyAt) {
      const [[nextClaim]] = await pool.query(
        `SELECT MIN(created_at) AS at FROM dist_task_run_events
          WHERE event = 'claimed' AND created_at >= FROM_UNIXTIME(?)`,
        [injections.restart.readyAt / 1000],
      );
      if (nextClaim.at)
        restartRecoveryMs =
          new Date(nextClaim.at).getTime() - injections.restart.readyAt;
    }

    const publishWindowMs =
      published.firstAt && published.lastAt
        ? new Date(published.lastAt).getTime() -
          new Date(published.firstAt).getTime()
        : 0;
    const duplicateDeliveries =
      (consumed.duplicate ?? 0) + (consumed.skipped ?? 0);

    const report = {
      runId,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      runs: {
        total: TOTAL_RUNS,
        succeeded: statusCounts.succeeded ?? 0,
        dead: statusCounts.dead ?? 0,
        cancelled: statusCounts.cancelled ?? 0,
        pending,
      },
      outbox: {
        pending: Number(outboxLeft.total),
        published: Number(published.total),
        publishWindowMs,
        throughputMessagesPerSecond:
          publishWindowMs > 0
            ? Number(
                (Number(published.total) / (publishWindowMs / 1000)).toFixed(2),
              )
            : null,
      },
      dispatchLatencyMs: metrics(dispatchRows.map((row) => Number(row.ms))),
      deliveries: {
        claimed: consumed.claimed ?? 0,
        duplicate: consumed.duplicate ?? 0,
        skipped: consumed.skipped ?? 0,
        duplicatePlusSkipped: duplicateDeliveries,
      },
      reapedRuns: Number(reaped.total),
      deadLetterQueue: { messages: dlqMessages },
      brokerRestart: {
        method: injections.restart?.method ?? null,
        ok: injections.restart?.ok ?? false,
        commandMs: injections.restart?.commandMs ?? null,
        readyAfterMs: injections.restart?.readyAt
          ? injections.restart.readyAt - startedAt
          : null,
        firstClaimAfterRestartMs: restartRecoveryMs,
      },
      injections: {
        workerKills: injections.workerKills,
        relayKills: injections.relayKills,
        relayRestarts: injections.relayRestarts,
        mainQueuePurgedAtMs: injections.purgeAt
          ? injections.purgeAt - startedAt
          : null,
        crashAfterConfirmRate: CRASH_AFTER_CONFIRM_RATE,
        duplicateRate: DUPLICATE_RATE,
      },
      assertions: {
        allRunsSucceeded: (statusCounts.succeeded ?? 0) === TOTAL_RUNS,
        exactlyOneSucceededEventPerRun:
          Number(duplicateSucceeded.offenders) === 0 &&
          Number(succeededEvents.total) === (statusCounts.succeeded ?? 0),
        outboxDrained: Number(outboxLeft.total) === 0,
        dlqEmpty: dlqMessages === 0,
        duplicateOrSkippedObserved: duplicateDeliveries > 0,
        workerKillsExecuted: injections.workerKills === WORKER_KILLS,
        relayKillsExecuted: injections.relayKills === RELAY_KILLS,
        brokerRestarted: injections.restart?.ok === true,
      },
    };
    if (report.runs.dead > 0)
      report.deadRunsNote =
        'Dead runs exhausted max_attempts after repeated worker kills; ' +
        'max_attempts is kept at 3 on purpose.';
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
