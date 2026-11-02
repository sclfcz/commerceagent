#!/usr/bin/env node
/**
 * One-command demo of the distributed run subsystem.
 *
 *   npm run dist:demo            # compose up, run, keep the stack
 *   npm run dist:demo -- --down  # also `docker compose down`
 *
 * Timeline: compose healthy -> migrate -> 3 workers + 2 relays -> 300 runs ->
 * kill -9 one worker, restart RabbitMQ -> drain -> summary table.
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMPOSE_FILE = 'docker-compose.distributed.yml';
const TASKS = Number(process.env.DIST_DEMO_TASKS ?? 300);
const REDIS_PORT = process.env.DIST_REDIS_HOST_PORT ?? '6380';
const MYSQL_URL = `mysql://dist:dist@127.0.0.1:${process.env.DIST_MYSQL_HOST_PORT ?? 3307}/dist`;
const AMQP_URL = `amqp://dist:dist@127.0.0.1:${process.env.DIST_AMQP_HOST_PORT ?? 5672}`;
const REDIS_URL = `redis://127.0.0.1:${REDIS_PORT}`;
const DOWN = process.argv.includes('--down');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (message) => process.stdout.write(`${message}\n`);
const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: ROOT, timeout: 180_000, ...options },
      (error, stdout, stderr) =>
        error
          ? reject(
              new Error(
                `${command} ${args.join(' ')}: ${stderr || error.message}`,
              ),
            )
          : resolve(stdout),
    );
  });

const children = [];
function startProcess(name, script, env) {
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.name = name;
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  children.push(child);
  return child;
}

async function stopChildren() {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
  }
  await sleep(1_500);
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
}

async function waitHealthy(services, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(services);
  while (Date.now() < deadline && pending.size) {
    for (const container of [...pending]) {
      try {
        const status = await new Promise((resolve, reject) =>
          execFile(
            'docker',
            ['inspect', '-f', '{{.State.Health.Status}}', container],
            (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
          ),
        );
        if (status === 'healthy') pending.delete(container);
      } catch {
        /* container not up yet */
      }
    }
    if (pending.size) await sleep(1_000);
  }
  if (pending.size) throw new Error(`not healthy: ${[...pending].join(', ')}`);
}

async function main() {
  const startedAt = Date.now();
  say('▶ compose up (mysql 8.4 / rabbitmq 4 / redis 7)');
  await run('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
    env: { ...process.env, DIST_REDIS_HOST_PORT: REDIS_PORT },
  });
  await waitHealthy([
    'commerceagent-dist-mysql',
    'commerceagent-dist-rabbit',
    'commerceagent-dist-redis',
  ]);
  say('  all services healthy');

  const pool = await mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 10,
    timezone: 'Z',
  });
  pool.on('connection', (connection) =>
    connection.query("SET time_zone = '+00:00'", () => {}),
  );
  say('▶ migrate');
  const { runMigrations } = await import('../src/distributed/migrate.ts');
  await runMigrations(pool);
  await pool.query('DELETE FROM dist_run_steps');
  await pool.query('DELETE FROM dist_consumed_messages');
  await pool.query('DELETE FROM dist_outbox');
  await pool.query('DELETE FROM dist_task_run_events');
  await pool.query('DELETE FROM dist_task_runs');

  const commonEnv = {
    DIST_MYSQL_URL: MYSQL_URL,
    DIST_AMQP_URL: AMQP_URL,
    DIST_REDIS_URL: REDIS_URL,
    DIST_EXECUTOR: 'sleep',
    DIST_DISPATCH: 'mq',
    DIST_LEASE_MS: '5000',
    DIST_HEARTBEAT_MS: '1500',
    DIST_POLL_MS: '200',
    DIST_FALLBACK_POLL_MS: '3000',
    DIST_WORKER_CONCURRENCY: '8',
  };
  say('▶ start 3 workers + 2 relays');
  const workerByDuty = new Map();
  const workers = [0, 1, 2].map((index) => {
    const duty = `demo-worker-${index}`;
    const child = startProcess(
      `worker-${index}`,
      'src/distributed/cli-worker.ts',
      {
        ...commonEnv,
        DIST_WORKER_ID: duty,
      },
    );
    workerByDuty.set(duty, { child, index, name: `worker-${index}` });
    return child;
  });
  const relays = [0, 1].map(() =>
    startProcess('relay', 'src/distributed/cli-relay.ts', commonEnv),
  );
  await sleep(2_500);

  say(`▶ submit ${TASKS} runs`);
  const { RunRepository } =
    await import('../src/distributed/run-repository.ts');
  const repository = new RunRepository(pool, {
    leaseMs: 5_000,
    backoffBaseMs: 200,
    backoffMaxMs: 5_000,
  });
  const submittedAt = Date.now();
  const keys = [];
  for (let index = 0; index < TASKS; index += 1) {
    const key = `demo-${startedAt}-${index}`;
    keys.push(key);
    await repository.submit({
      tenantId: `demo-tenant-${index % 5}`,
      taskId: `demo-task-${index}`,
      idempotencyKey: key,
      maxAttempts: 5,
      payload: { sleepMs: 1_000 + Math.floor(Math.random() * 2_000) },
    });
  }
  say(`  submitted in ${Date.now() - submittedAt} ms`);

  // Wait until the fleet is busy, then kill the worker that holds the most
  // running runs — killing an idle worker would demo nothing.
  say('▶ inject: kill -9 a busy worker, restart RabbitMQ mid-backlog');
  const runningDeadline = Date.now() + 30_000;
  let victimDuty = null;
  let heldRunIds = [];
  while (Date.now() < runningDeadline) {
    const [owners] = await pool.query(
      `SELECT lease_owner AS owner, COUNT(*) AS n FROM dist_task_runs
        WHERE status = 'running' AND lease_owner IS NOT NULL
        GROUP BY lease_owner ORDER BY n DESC LIMIT 1`,
    );
    const candidate = owners[0];
    if (
      candidate &&
      workerByDuty.has(candidate.owner) &&
      Number(candidate.n) >= 2
    ) {
      victimDuty = candidate.owner;
      const [held] = await pool.query(
        "SELECT id FROM dist_task_runs WHERE status = 'running' AND lease_owner = ?",
        [victimDuty],
      );
      heldRunIds = held.map((row) => row.id);
      break;
    }
    await sleep(250);
  }
  const victimEntry = victimDuty
    ? workerByDuty.get(victimDuty)
    : { child: workers[0], index: 0, name: 'worker-0' };
  const killedAt = Date.now();
  victimEntry.child.kill('SIGKILL');
  workers[victimEntry.index] = startProcess(
    victimEntry.name,
    'src/distributed/cli-worker.ts',
    { ...commonEnv, DIST_WORKER_ID: `${victimEntry.name}-restarted` },
  );
  say(
    `  killed ${victimDuty ?? 'worker-0'} (${heldRunIds.length} running runs)`,
  );

  // Restart RabbitMQ while there is still real backlog (< 50% completed).
  const halfDeadline = Date.now() + 60_000;
  while (Date.now() < halfDeadline) {
    const [[done]] = await pool.query(
      "SELECT COALESCE(SUM(status = 'succeeded'), 0) AS done FROM dist_task_runs",
    );
    if (Number(done.done) < TASKS / 2) break;
    await sleep(100);
  }
  const rabbitRestartAt = Date.now();
  await run('docker', ['restart', 'commerceagent-dist-rabbit']);
  const rabbitReadyAt = Date.now();

  const deadline = Date.now() + 90_000;
  let pending = TASKS;
  while (Date.now() < deadline) {
    const [[row]] = await pool.query(
      "SELECT COUNT(*) AS total FROM dist_task_runs WHERE status IN ('queued','retry_wait','running')",
    );
    pending = Number(row.total);
    if (pending === 0) break;
    await sleep(500);
  }
  const drainedAt = Date.now();

  const [[totals]] = await pool.query(
    `SELECT
       SUM(status = 'succeeded') AS succeeded,
       SUM(status = 'dead') AS dead,
       SUM(status = 'needs_review') AS needsReview,
       COUNT(*) AS total
     FROM dist_task_runs`,
  );
  const [[dups]] = await pool.query(
    `SELECT COUNT(*) AS runs FROM (
       SELECT run_id FROM dist_task_run_events
        WHERE event = 'completed' GROUP BY run_id HAVING COUNT(*) > 1
     ) t`,
  );
  const [[reaped]] = await pool.query(
    "SELECT COUNT(*) AS total FROM dist_task_run_events WHERE event = 'reaped'",
  );
  const [[latency]] = await pool.query(
    `SELECT
       MAX(TIMESTAMPDIFF(MICROSECOND, created_at, claimed_at)) / 1000 AS p95
     FROM (
       SELECT r.created_at, MIN(e.created_at) AS claimed_at
         FROM dist_task_runs r
         JOIN dist_task_run_events e ON e.run_id = r.id AND e.event = 'claimed'
        GROUP BY r.id, r.created_at
     ) t`,
  );
  const [[afterMq]] = await pool.query(
    `SELECT COUNT(*) AS total FROM dist_task_run_events
      WHERE event = 'claimed' AND created_at >= FROM_UNIXTIME(?)`,
    [rabbitRestartAt / 1000],
  );

  // How long did the killed worker's runs take to be claimed by someone else?
  let recoveryP50 = null;
  let recoveryMax = null;
  if (heldRunIds.length) {
    const [rows] = await pool.query(
      `SELECT e.run_id, MIN(e.created_at) AS at
         FROM dist_task_run_events e
        WHERE e.event = 'claimed' AND e.created_at >= FROM_UNIXTIME(?)
          AND e.run_id IN (${heldRunIds.map(() => '?').join(',')})
        GROUP BY e.run_id`,
      [killedAt / 1000, ...heldRunIds],
    );
    const delays = rows
      .map((row) => new Date(row.at).getTime() - killedAt)
      .filter((value) => Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    if (delays.length) {
      recoveryP50 = delays[Math.floor(delays.length / 2)];
      recoveryMax = delays[delays.length - 1];
    }
  }

  const checks = {
    allSucceeded: Number(totals.succeeded) === TASKS,
    noDuplicates: Number(dups.runs) === 0,
    reapedAfterKill: Number(reaped.total) > 0,
    claimsAfterMqRestart: Number(afterMq.total) > 0,
  };
  const ok = Object.values(checks).every(Boolean);
  say('');
  say('┌────────────────────────────┬──────────────────────────────┐');
  say('│ 指标                       │ 值                           │');
  say('├────────────────────────────┼──────────────────────────────┤');
  const row = (label, value) =>
    say(`│ ${label.padEnd(26)} │ ${String(value).padEnd(28)} │`);
  row('runs submitted', TASKS);
  row('succeeded', Number(totals.succeeded));
  row('dead', Number(totals.dead));
  row('needs_review', Number(totals.needsReview));
  row('duplicate completions', Number(dups.runs));
  row('reaped (lease recovery)', Number(reaped.total));
  row('queue wait max', `${Number(latency.p95 ?? 0).toFixed(0)} ms`);
  row('killed worker', victimDuty ?? 'worker-0');
  row('runs it held', heldRunIds.length);
  row('their recovery p50', recoveryP50 === null ? 'n/a' : `${recoveryP50} ms`);
  row('their recovery max', recoveryMax === null ? 'n/a' : `${recoveryMax} ms`);
  row(
    'mq restart ready',
    `${((rabbitReadyAt - rabbitRestartAt) / 1000).toFixed(1)}s`,
  );
  row('claims after mq restart', Number(afterMq.total));
  row('drain time', `${((drainedAt - submittedAt) / 1000).toFixed(1)}s`);
  say('└────────────────────────────┴──────────────────────────────┘');
  for (const [name, value] of Object.entries(checks))
    say(`  ${value ? '✓' : '✗'} ${name}`);
  say(ok ? '✅ demo passed' : '❌ demo failed');
  say(`total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  await stopChildren();
  await pool.end().catch(() => {});
  if (DOWN) {
    say('▶ compose down');
    await run('docker', ['compose', '-f', COMPOSE_FILE, 'down'], {
      env: process.env,
    });
  }
  process.exit(ok ? 0 : 1);
}

await main().catch(async (error) => {
  process.stderr.write(
    `demo failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  await stopChildren();
  process.exit(1);
});
