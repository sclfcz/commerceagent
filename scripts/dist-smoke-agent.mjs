#!/usr/bin/env node
/**
 * Manual smoke: run ONE isolated *agent* task through the distributed bridge.
 *
 * ⚠️ This spends real model calls. It is intentionally NOT part of CI and is
 * not run by any benchmark. Run it yourself:
 *
 *   DIST_SCHEDULER=1 DIST_MYSQL_URL=... DIST_REDIS_URL=... npm run dist:smoke:agent
 *
 * It starts the real service against a temporary data directory, creates one
 * `once` agent task in an isolated session, waits for the run to reach a
 * terminal state and prints the SQLite + dist outcome.
 */
import { spawn } from 'node:child_process';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port: free } = server.address();
    server.close(() => resolve(free));
  });
});
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-smoke-agent-'));
const baseUrl = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: ROOT,
  env: {
    ...process.env,
    COMMERCEAGENT_DATA_DIR: dataDir,
    WEB_PORT: String(port),
    DIST_SCHEDULER: '1',
    DIST_MYSQL_URL: MYSQL_URL,
    DIST_DISPATCH: 'poll',
    DIST_TENANT_CONCURRENCY: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-1000);
});

const api = async (method, url, body, cookie = '') => {
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
    throw new Error(`${url} -> ${response.status} ${text.slice(0, 200)}`);
  const cookies = (
    response.headers.getSetCookie?.() ?? [
      response.headers.get('set-cookie') ?? '',
    ]
  )
    .map((value) => value.split(';')[0])
    .filter(Boolean)
    .join('; ');
  return { parsed, cookie: cookies };
};

try {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/status`);
      if (response.status < 500) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  const username = `smoke${Date.now()}`;
  const setup = await api('POST', '/api/auth/setup', {
    username,
    password: 'smoke-password-123',
  });
  const cookie = setup.cookie;
  const group = await api(
    'POST',
    '/api/groups',
    {
      name: 'Smoke workspace',
      execution_mode: 'host',
    },
    cookie,
  );
  const task = await api(
    'POST',
    '/api/tasks',
    {
      chat_jid: group.parsed.jid,
      schedule_type: 'once',
      schedule_value: new Date(Date.now() + 1_000).toISOString(),
      prompt: '请用一句话回答：1+1 等于几？',
      execution_type: 'agent',
      context_mode: 'isolated',
    },
    cookie,
  );

  const deadline = Date.now() + 300_000;
  let run = null;
  const db = new Database(path.join(dataDir, 'db/messages.db'), {
    readonly: true,
  });
  try {
    while (Date.now() < deadline) {
      run = db.prepare('SELECT * FROM task_runs LIMIT 1').get() ?? null;
      if (run && !['queued', 'running', 'retry_wait'].includes(run.status))
        break;
      await sleep(1_000);
    }
  } finally {
    db.close();
  }

  const dist = await mysql.createPool({
    uri: MYSQL_URL,
    connectionLimit: 2,
    timezone: 'Z',
    supportBigNumbers: true,
  });
  let distRow = null;
  try {
    if (run) {
      const [rows] = await dist.query(
        'SELECT status, result FROM dist_task_runs WHERE idempotency_key = ?',
        [run.id],
      );
      distRow = rows[0] ?? null;
    }
  } finally {
    await dist.end().catch(() => {});
  }

  process.stdout.write(
    JSON.stringify(
      {
        event: 'dist_smoke_agent',
        taskId: task.parsed?.task?.id ?? null,
        sqlite: run
          ? { status: run.status, attempt: run.attempt, error: run.error }
          : null,
        dist: distRow
          ? {
              status: distRow.status,
              mirroredStatus:
                typeof distRow.result === 'string'
                  ? JSON.parse(distRow.result)?.mirroredStatus
                  : distRow.result?.mirroredStatus,
            }
          : null,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 15_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
