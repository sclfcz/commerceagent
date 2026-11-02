#!/usr/bin/env node
/**
 * End-to-end check of the distributed scheduler bridge.
 *
 * Starts the *real* service (src/index.ts) against a throw-away data directory:
 *   1. latency: 200 once-script tasks, next_run 10-30s ahead, DIST_SCHEDULER=0
 *      vs =1, measuring scheduled_for -> started_at.
 *   2. crash recovery: 50 script tasks (sleep 5 + append id), kill -9 the
 *      listener, restart, then verify no duplicate side effects and that the
 *      SQLite outcome is mirrored into the dist envelope.
 *
 * Usage: npm run dist:e2e:scheduler
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MYSQL_URL =
  process.env.DIST_MYSQL_URL?.trim() || 'mysql://dist:dist@127.0.0.1:3307/dist';
const REDIS_URL =
  process.env.DIST_REDIS_URL?.trim() || 'redis://127.0.0.1:6380';
const LATENCY_RUNS = Number(process.env.DIST_E2E_LATENCY_RUNS ?? 200);
const CRASH_RUNS = Number(process.env.DIST_E2E_CRASH_RUNS ?? 50);
const SCRIPT_SLEEP_SECONDS = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) => process.stderr.write(`[e2e] ${message}\n`);

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return Number(sorted[index].toFixed(2));
}
const stats = (values) => ({
  samples: values.length,
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
  max: values.length ? Number(Math.max(...values).toFixed(2)) : null,
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function spawnService(dataDir, port, distEnabled) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      COMMERCEAGENT_DATA_DIR: dataDir,
      WEB_PORT: String(port),
      DIST_SCHEDULER: distEnabled ? '1' : '0',
      DIST_MYSQL_URL: MYSQL_URL,
      DIST_REDIS_URL: REDIS_URL,
      DIST_DISPATCH: 'poll',
      DIST_TENANT_CONCURRENCY: '0',
      DIST_POLL_MS: '100',
      DIST_CLAIM_BATCH: '200',
      DIST_LEASE_MS: '30000',
      DIST_HEARTBEAT_MS: '5000',
      CONTAINER_TIMEOUT: '120000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrTail = '';
  child.stdoutTail = '';
  child.stdout.on('data', (chunk) => {
    child.stdoutTail = `${child.stdoutTail}${chunk}`.slice(-4000);
  });
  child.stderr.on('data', (chunk) => {
    child.stderrTail = `${child.stderrTail}${chunk}`.slice(-4000);
  });
  return child;
}

async function waitForHttp(baseUrl, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.status < 500) return;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error('service_did_not_start');
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  const joined = raw.length ? raw : [response.headers.get('set-cookie') ?? ''];
  return joined
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function api(baseUrl, cookie, method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok)
    throw new Error(
      `${method} ${url} -> ${response.status} ${text.slice(0, 300)}`,
    );
  return { parsed, cookie: cookieFrom(response) };
}

async function setUp(baseUrl) {
  const setup = await api(baseUrl, '', 'POST', '/api/auth/setup', {
    username: `e2e${Date.now()}`,
    password: 'e2e-password-123',
  });
  let cookie = setup.cookie;
  if (!cookie) {
    const login = await api(baseUrl, '', 'POST', '/api/auth/login', {
      username: setup.parsed?.user?.username,
      password: 'e2e-password-123',
    });
    cookie = login.cookie;
  }
  const group = await api(baseUrl, cookie, 'POST', '/api/groups', {
    name: 'E2E host workspace',
    execution_mode: 'host',
  });
  return {
    cookie,
    jid: group.parsed.jid,
    folder: group.parsed.group?.folder ?? group.parsed.folder,
  };
}

async function createTasks(
  baseUrl,
  cookie,
  jid,
  folder,
  count,
  { delayMs, script },
) {
  const created = [];
  const now = Date.now();
  for (let index = 0; index < count; index++) {
    const nextRun = new Date(now + delayMs(index)).toISOString();
    const response = await api(baseUrl, cookie, 'POST', '/api/tasks', {
      chat_jid: jid,
      group_folder: folder,
      schedule_type: 'once',
      schedule_value: nextRun,
      prompt: '',
      execution_type: 'script',
      script_command: script(index, nextRun),
      context_mode: 'isolated',
    });
    created.push({
      id: response.parsed.task?.id ?? response.parsed.id,
      nextRun,
    });
  }
  return created;
}

function readRuns(dataDir) {
  const db = new Database(path.join(dataDir, 'db/messages.db'), {
    readonly: true,
  });
  try {
    return db.prepare('SELECT * FROM task_runs').all();
  } finally {
    db.close();
  }
}

async function waitForTerminal(dataDir, expectedRuns, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = readRuns(dataDir);
    if (
      rows.length >= expectedRuns &&
      rows.every(
        (row) => !['queued', 'running', 'retry_wait'].includes(row.status),
      )
    )
      return rows;
    await sleep(500);
  }
  return readRuns(dataDir);
}

const TERMINAL_DIST = new Set(['succeeded', 'dead', 'cancelled']);

async function latencyRound(distEnabled) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-e2e-lat-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawnService(dataDir, port, distEnabled);
  try {
    await waitForHttp(baseUrl);
    const { cookie, jid, folder } = await setUp(baseUrl);
    const created = await createTasks(
      baseUrl,
      cookie,
      jid,
      folder,
      LATENCY_RUNS,
      {
        delayMs: (index) => 10_000 + ((index * 397) % 20_000),
        script: () => 'echo ok',
      },
    );
    const rows = await waitForTerminal(dataDir, LATENCY_RUNS, 240_000);
    const latencies = rows
      .filter((row) => row.started_at)
      .map(
        (row) =>
          new Date(row.started_at).getTime() -
          new Date(row.scheduled_for).getTime(),
      )
      .filter((value) => Number.isFinite(value));
    return {
      distEnabled,
      tasks: created.length,
      runs: rows.length,
      statuses: rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
      startLatencyMs: stats(latencies),
      stderrTail: child.stderrTail.slice(-500),
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 20_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function listenerPid(port) {
  try {
    const out = execFileSync('lsof', ['-ti:' + port, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    }).trim();
    const pid = Number(out.split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function crashRound() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-e2e-crash-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const sideEffects = path.join(dataDir, 'side-effects.txt');
  fs.writeFileSync(sideEffects, '');
  let child = spawnService(dataDir, port, true);
  try {
    await waitForHttp(baseUrl);
    const { cookie, jid, folder } = await setUp(baseUrl);
    const created = await createTasks(
      baseUrl,
      cookie,
      jid,
      folder,
      CRASH_RUNS,
      {
        delayMs: (index) => 200 + index * 20,
        script: (index) =>
          `sleep ${SCRIPT_SLEEP_SECONDS}; echo task-${index} >> '${sideEffects}'`,
      },
    );

    // Wait until several runs are actually executing, then kill the listener.
    const startedDeadline = Date.now() + 60_000;
    let started = 0;
    while (Date.now() < startedDeadline) {
      const rows = readRuns(dataDir);
      started = rows.filter((row) => row.started_at).length;
      if (started >= 5) break;
      await sleep(100);
    }
    const pid = listenerPid(port);
    if (!pid) throw new Error('listener_pid_not_found');
    process.kill(pid, 'SIGKILL');
    const killedAt = Date.now();
    await sleep(2_000);

    // Orphaned script children keep running after the parent dies; count them.
    let orphanScripts = 0;
    try {
      const out = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
      orphanScripts = out
        .split('\n')
        .filter(
          (line) => line.includes(sideEffects) && !line.includes('ps -Ao'),
        ).length;
    } catch {
      orphanScripts = -1;
    }

    child = spawnService(dataDir, port, true);
    await waitForHttp(baseUrl);
    const rows = await waitForTerminal(dataDir, CRASH_RUNS, 240_000);

    // Give orphaned scripts time to finish their 5s sleep before counting.
    await sleep(SCRIPT_SLEEP_SECONDS * 1000 + 2_000);

    const lines = fs
      .readFileSync(sideEffects, 'utf8')
      .split('\n')
      .filter(Boolean);
    const counts = new Map();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    const duplicated = [...counts.entries()].filter(([, count]) => count > 1);

    const runsByTask = new Map(rows.map((row) => [row.task_id, row]));
    const notStarted = created.filter((task) => {
      const row = runsByTask.get(task.id);
      return row && !row.started_at;
    });
    const lateStartedStillQueued = notStarted.filter((task) => {
      const row = runsByTask.get(task.id);
      return row && ['queued', 'retry_wait'].includes(row.status);
    });

    const db = await mysql.createPool({
      uri: MYSQL_URL,
      connectionLimit: 4,
      timezone: 'Z',
      supportBigNumbers: true,
    });
    db.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'", () => {});
    });
    let distRows = [];
    try {
      const keys = rows.map((row) => row.id);
      // SQLite is the execution authority; the dist envelope settles a moment
      // later. Give the dispatcher time to mirror before asserting parity.
      const drainDeadline = Date.now() + 60_000;
      while (keys.length && Date.now() < drainDeadline) {
        const [[pending]] = await db.query(
          `SELECT COUNT(*) AS total FROM dist_task_runs
            WHERE idempotency_key IN (${keys.map(() => '?').join(',')})
              AND status NOT IN ('succeeded','dead','cancelled')`,
          keys,
        );
        if (Number(pending.total) === 0) break;
        await sleep(500);
      }
      if (keys.length) {
        [distRows] = await db.query(
          `SELECT idempotency_key, status, result FROM dist_task_runs
            WHERE idempotency_key IN (${keys.map(() => '?').join(',')})`,
          keys,
        );
      }
    } finally {
      await db.end().catch(() => {});
    }
    const distByKey = new Map(
      distRows.map((row) => [row.idempotency_key, row]),
    );
    const stateMismatches = [];
    for (const row of rows) {
      const dist = distByKey.get(row.id);
      if (!dist) {
        stateMismatches.push({
          runId: row.id,
          reason: 'missing_dist_row',
          sqliteStatus: row.status,
          startedAt: row.started_at,
          createdAt: row.created_at,
        });
        continue;
      }
      if (!TERMINAL_DIST.has(dist.status)) {
        stateMismatches.push({ runId: row.id, reason: `dist_${dist.status}` });
        continue;
      }
      const mirrored =
        typeof dist.result === 'string' ? JSON.parse(dist.result) : dist.result;
      if (mirrored?.mirroredStatus && mirrored.mirroredStatus !== row.status)
        stateMismatches.push({
          runId: row.id,
          reason: `sQLite=${row.status} dist=${mirrored.mirroredStatus}`,
        });
    }

    return {
      tasks: created.length,
      runs: rows.length,
      statuses: rows.reduce((acc, row) => {
        acc[row.status] = (acc[row.status] ?? 0) + 1;
        return acc;
      }, {}),
      killedAtMs: killedAt,
      startedBeforeKill: started,
      orphanScriptsAfterKill: orphanScripts,
      sideEffectLines: lines.length,
      duplicateSideEffects: duplicated.map(([id, count]) => ({ id, count })),
      notStartedRuns: notStarted.length,
      lateStartedStillQueued: lateStartedStillQueued.length,
      distRows: distRows.length,
      stateMismatches: stateMismatches.slice(0, 5),
      stateMismatchCount: stateMismatches.length,
      stderrTail: child.stderrTail.slice(-500),
      stdoutTail: child.stdoutTail.slice(-1200),
      assertions: {
        noDuplicateSideEffects: duplicated.length === 0,
        sideEffectsAtMostOncePerRun: lines.length <= rows.length,
        allRunsTerminal: rows.every(
          (row) => !['queued', 'running', 'retry_wait'].includes(row.status),
        ),
        unfinishedRunsCompleted: lateStartedStillQueued.length === 0,
        sqliteMatchesDistMirror: stateMismatches.length === 0,
      },
    };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 20_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const startedAt = Date.now();
  const runId = `dist-e2e-scheduler-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const report = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    machine: {
      cpuModel: os.cpus()[0]?.model?.trim() ?? 'unknown',
      cpuCount: os.cpus().length,
      totalMemoryGiB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
    },
    config: {
      latencyRuns: LATENCY_RUNS,
      crashRuns: CRASH_RUNS,
      scriptSleepSeconds: SCRIPT_SLEEP_SECONDS,
    },
  };
  try {
    notify('latency: DIST_SCHEDULER=0');
    if (process.env.DIST_E2E_SKIP_LATENCY !== '1') {
      report.latencyOff = await latencyRound(false);
      notify('latency: DIST_SCHEDULER=1');
      report.latencyOn = await latencyRound(true);
    }
    notify('crash recovery');
    report.crash = await crashRound();
    report.comparison =
      report.latencyOn && report.latencyOff
        ? {
            p50DeltaPct:
              report.latencyOn.startLatencyMs.p50 &&
              report.latencyOff.startLatencyMs.p50
                ? Number(
                    (
                      ((report.latencyOn.startLatencyMs.p50 -
                        report.latencyOff.startLatencyMs.p50) /
                        report.latencyOff.startLatencyMs.p50) *
                      100
                    ).toFixed(1),
                  )
                : null,
            p95DeltaPct:
              report.latencyOn.startLatencyMs.p95 &&
              report.latencyOff.startLatencyMs.p95
                ? Number(
                    (
                      ((report.latencyOn.startLatencyMs.p95 -
                        report.latencyOff.startLatencyMs.p95) /
                        report.latencyOff.startLatencyMs.p95) *
                      100
                    ).toFixed(1),
                  )
                : null,
          }
        : null;
    report.passed = Object.values(report.crash.assertions).every(Boolean);
  } catch (error) {
    report.passed = false;
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt;
  const directory = path.join(ROOT, 'benchmarks/results');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${runId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  notify(`report written to ${path.relative(ROOT, file)}`);
  process.exit(report.passed ? 0 : 1);
}

await main();
