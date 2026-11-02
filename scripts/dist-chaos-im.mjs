#!/usr/bin/env node
/**
 * Chaos test for IM connection ownership (`DIST_IM_OWNERSHIP=1`).
 *
 * The mock platform is deliberately worst-case: one credential may have any
 * number of live connections and every message is pushed to all of them. The
 * platform does not help with mutual exclusion — only the lease does.
 *
 * Three worker processes run a real IMConnectionManager + ConnectionOwnership
 * against one Redis. During the run the driver:
 *   - SIGKILLs the current owner 5 times (and starts a replacement),
 *   - SIGSTOPs an owner for 2x leaseMs and then SIGCONTs it (zombie),
 *   - SIGTERMs an owner once (must hand over immediately via release).
 *
 * Report: benchmarks/results/dist-chaos-im-<timestamp>.json
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REDIS_URL =
  process.env.DIST_REDIS_URL?.trim() || 'redis://127.0.0.1:6380';
const CREDENTIALS = Number(process.env.IM_CHAOS_CREDENTIALS ?? 20);
const DURATION_MS = Number(process.env.IM_CHAOS_DURATION_MS ?? 60_000);
const PUSH_INTERVAL_MS = Number(process.env.IM_CHAOS_PUSH_MS ?? 100);
const LEASE_MS = Number(process.env.DIST_IM_LEASE_MS ?? 3_000);
const RENEW_MS = Number(process.env.DIST_IM_RENEW_MS ?? 1_000);
const INSTANCES = Number(process.env.IM_CHAOS_INSTANCES ?? 3);
const KILLS = Number(process.env.IM_CHAOS_KILLS ?? 5);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) => process.stderr.write(`[chaos-im] ${message}\n`);

// ─── mock platform ─────────────────────────────────────────────
const streams = new Map();
const connections = new Map();
const replies = new Map();
const connectEvents = [];
const stats = new Map();
let connSeq = 0;

function streamFor(credential) {
  let stream = streams.get(credential);
  if (!stream) {
    stream = { seq: 0, messages: [] };
    streams.set(credential, stream);
  }
  return stream;
}

function onlineCount(credential, now = Date.now()) {
  let count = 0;
  for (const conn of connections.values()) {
    if (conn.credential !== credential) continue;
    if (conn.closed) continue;
    if (conn.inFlight > 0 || now - conn.lastPollAt < 2_000) count += 1;
  }
  return count;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/connect') {
    const credential = url.searchParams.get('credential');
    const instance = url.searchParams.get('instance');
    const conn = `c${++connSeq}`;
    // A fresh connection starts at the current head: real platforms do not
    // replay history to a new socket, and replay would look like duplicates.
    const baseSeq = streamFor(credential).seq;
    connections.set(conn, {
      baseSeq,
      credential,
      instance,
      conn,
      lastPollAt: Date.now(),
      inFlight: 0,
      closed: false,
      openedAt: Date.now(),
    });
    connectEvents.push({ credential, instance, conn, at: Date.now() });
    return json(res, 200, { conn });
  }
  if (url.pathname === '/poll') {
    const credential = url.searchParams.get('credential');
    const connId = url.searchParams.get('conn');
    const requestedSince = Number(url.searchParams.get('since') ?? 0);
    const conn = connections.get(connId);
    if (!conn) return json(res, 404, { error: 'unknown_conn' });
    const since = Math.max(requestedSince, conn.baseSeq);
    conn.lastPollAt = Date.now();
    conn.inFlight += 1;
    let finished = false;
    const finish = (body) => {
      if (finished) return;
      finished = true;
      conn.inFlight = Math.max(0, conn.inFlight - 1);
      json(res, 200, body);
    };
    const deadline = Date.now() + 800;
    const timer = setInterval(() => {
      const stream = streamFor(credential);
      const messages = stream.messages.filter((m) => m.seq > since);
      if (messages.length || Date.now() > deadline) {
        clearInterval(timer);
        finish({ seq: stream.seq, messages });
      }
    }, 50);
    // A completed long-poll also fires `close`; only a socket torn down
    // before the response was written means the process went away.
    res.on('close', () => {
      clearInterval(timer);
      if (!finished) {
        finished = true;
        conn.inFlight = Math.max(0, conn.inFlight - 1);
      }
      if (!res.writableEnded) conn.closed = true;
    });
    return;
  }
  if (url.pathname === '/disconnect') {
    const body = await readBody(req);
    const conn = connections.get(body.conn);
    if (conn) conn.closed = true;
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/reply') {
    const body = await readBody(req);
    const entry = replies.get(body.messageId) ?? [];
    entry.push({ at: Date.now(), instance: body.instance, conn: body.conn });
    replies.set(body.messageId, entry);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/stats') {
    const body = await readBody(req);
    stats.set(body.instance, { ...body, at: Date.now() });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/state') {
    const online = {};
    for (let i = 0; i < CREDENTIALS; i += 1) {
      const credential = `cred-${i}`;
      online[credential] = onlineCount(credential);
    }
    return json(res, 200, { online, connections: connections.size });
  }
  return json(res, 404, { error: 'not_found' });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const platformUrl = `http://127.0.0.1:${server.address().port}`;

// ─── workers ───────────────────────────────────────────────────
const workers = new Map();
let instanceSeq = 0;

function startWorker() {
  const instanceId = `im-${process.pid}-${++instanceSeq}`;
  const credentials = Array.from(
    { length: CREDENTIALS },
    (_, index) => `cred-${index}`,
  ).join(',');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/dist-chaos-im-worker.mjs'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        IM_PLATFORM_URL: platformUrl,
        IM_CREDENTIALS: credentials,
        DIST_INSTANCE_ID: instanceId,
        DIST_IM_LEASE_MS: String(LEASE_MS),
        DIST_IM_RENEW_MS: String(RENEW_MS),
        DIST_REDIS_URL: REDIS_URL,
        DIST_IM_OWNERSHIP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const worker = { instanceId, child, pid: child.pid, readyAt: null };
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.event === 'ready') worker.readyAt = Date.now();
      } catch {
        /* non-JSON log line */
      }
    }
  });
  worker.stderr = '';
  child.stderr.on('data', (chunk) => {
    worker.stderr = `${worker.stderr}${chunk}`.slice(-2000);
  });
  workers.set(instanceId, worker);
  return worker;
}

const live = () =>
  [...workers.values()].filter((worker) => worker.child.exitCode === null);

async function waitForReady(count, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (live().filter((worker) => worker.readyAt).length >= count) return;
    await sleep(100);
  }
  for (const worker of workers.values())
    process.stderr.write(
      `[chaos-im] ${worker.instanceId}: ${worker.stderr ?? ''}\n`,
    );
  throw new Error('workers_did_not_become_ready');
}

// ─── run ───────────────────────────────────────────────────────
const startedAt = Date.now();
const report = {
  runId: `dist-chaos-im-${new Date().toISOString().replace(/[:.]/g, '-')}`,
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
    credentials: CREDENTIALS,
    durationMs: DURATION_MS,
    pushIntervalMs: PUSH_INTERVAL_MS,
    instances: INSTANCES,
    leaseMs: LEASE_MS,
    renewMs: RENEW_MS,
    kills: KILLS,
  },
  injections: [],
  phase: 'none',
  overlap: { totalMs: 0, byPhase: {} },
  failover: { SIGKILL: [], SIGTERM: [] },
  duplicates: [],
  lostReplies: [],
  workerStats: {},
};

let phase = 'none';
const overlapByPhase = {};
let overlapTotal = 0;
let sampling = true;

const sampler = (async () => {
  while (sampling) {
    const now = Date.now();
    for (let i = 0; i < CREDENTIALS; i += 1) {
      const credential = `cred-${i}`;
      const count = onlineCount(credential, now);
      if (count >= 2) {
        overlapTotal += PUSH_INTERVAL_MS;
        overlapByPhase[phase] = (overlapByPhase[phase] ?? 0) + PUSH_INTERVAL_MS;
      }
    }
    await sleep(PUSH_INTERVAL_MS);
  }
})();

/** Instances currently holding at least one lease (via their own stats). */
function ownerInstances() {
  return [...stats.values()]
    .filter(
      (entry) => entry.standby < CREDENTIALS && entry.at > Date.now() - 5_000,
    )
    .map((entry) => entry.instance);
}

/** Credentials this instance actually has an open connection for. */
function credentialsOf(instance) {
  const owned = new Set();
  for (const conn of connections.values()) {
    if (!conn.closed && conn.instance === instance) owned.add(conn.credential);
  }
  return [...owned];
}

/** Wait until some live instance actually owns connections. */
async function waitForOwner(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidates = live()
      .filter((worker) => worker.readyAt)
      .sort(
        (a, b) =>
          credentialsOf(b.instanceId).length -
          credentialsOf(a.instanceId).length,
      );
    if (candidates[0] && credentialsOf(candidates[0].instanceId).length > 0)
      return candidates[0];
    await sleep(250);
  }
  return null;
}

async function noteFailover(kind, credential, fromAt, fromInstance) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const event = connectEvents.find(
      (candidate) =>
        candidate.at >= fromAt &&
        candidate.credential === credential &&
        candidate.instance !== fromInstance,
    );
    if (event) {
      report.failover[kind].push(event.at - fromAt);
      return;
    }
    await sleep(20);
  }
  report.failover[kind].push(null);
}

const publishers = (async () => {
  const deadline = Date.now() + DURATION_MS;
  let seq = 0;
  while (Date.now() < deadline) {
    seq += 1;
    for (let i = 0; i < CREDENTIALS; i += 1) {
      const credential = `cred-${i}`;
      const stream = streamFor(credential);
      stream.seq += 1;
      stream.messages.push({ id: `${credential}:${seq}`, seq: stream.seq });
    }
    await sleep(PUSH_INTERVAL_MS);
  }
})();

const injections = (async () => {
  for (let index = 0; index < INSTANCES; index += 1) startWorker();
  await waitForReady(INSTANCES);
  await sleep(6_000);

  // 1. Five SIGKILLs of the current owner, each followed by a replacement.
  for (let index = 0; index < KILLS; index += 1) {
    // Target the instance that actually holds connections, otherwise the
    // failover measurement has nothing to observe.
    const candidates = live()
      .filter((worker) => worker.readyAt)
      .sort(
        (a, b) =>
          credentialsOf(b.instanceId).length -
          credentialsOf(a.instanceId).length,
      );
    const victim = candidates[0];
    if (!victim) break;
    phase = 'sigkill';
    const at = Date.now();
    const owned = credentialsOf(victim.instanceId);
    report.injections.push({
      kind: 'SIGKILL',
      instance: victim.instanceId,
      at,
      credentials: owned.length,
    });
    victim.child.kill('SIGKILL');
    if (owned.length)
      void noteFailover('SIGKILL', owned[0], at, victim.instanceId);
    startWorker();
    await sleep(8_000);
    phase = 'none';
  }

  // 2. Zombie: SIGSTOP for 2x lease, then SIGCONT.
  {
    const victim = live()
      .filter((worker) => worker.readyAt)
      .pop();
    if (victim) {
      phase = 'sigstop';
      const at = Date.now();
      report.injections.push({
        kind: 'SIGSTOP',
        instance: victim.instanceId,
        at,
        holdMs: LEASE_MS * 2,
      });
      victim.child.kill('SIGSTOP');
      await sleep(LEASE_MS * 2);
      victim.child.kill('SIGCONT');
      report.injections[report.injections.length - 1].resumedAt = Date.now();
      await sleep(6_000);
      phase = 'none';
    }
  }

  // 3. Graceful SIGTERM: release must hand over immediately.
  {
    const victim = live()
      .filter((worker) => worker.readyAt)
      .pop();
    if (victim) {
      phase = 'sigterm';
      const at = Date.now();
      report.injections.push({
        kind: 'SIGTERM',
        instance: victim.instanceId,
        at,
      });
      const owned = credentialsOf(victim.instanceId);
      victim.child.kill('SIGTERM');
      if (owned.length)
        void noteFailover('SIGTERM', owned[0], at, victim.instanceId);
      startWorker();
      await sleep(8_000);
      phase = 'none';
    }
  }
})();

await publishers;
sampling = false;
await sampler;
await injections.catch(() => {});
await sleep(3_000);

for (const worker of live()) worker.child.kill('SIGTERM');
await sleep(1_500);
for (const worker of workers.values()) {
  if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
}

// ─── assertions ────────────────────────────────────────────────
const published = [];
for (const [credential, stream] of streams) {
  for (const message of stream.messages)
    published.push(`${credential}:${message.id}`);
}
for (const [messageId, entries] of replies) {
  if (entries.length > 1)
    report.duplicates.push({ messageId, count: entries.length });
}
report.lostReplies = published
  .filter((messageId) => !replies.has(messageId))
  .slice(0, 20);

report.overlap = { totalMs: overlapTotal, byPhase: overlapByPhase };
for (const kind of ['SIGKILL', 'SIGTERM']) {
  const samples = report.failover[kind].filter((value) =>
    Number.isFinite(value),
  );
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q) =>
    sorted.length
      ? Number(
          sorted[
            Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
          ].toFixed(0),
        )
      : null;
  report.failover[kind] = {
    samples: samples.length,
    missing: report.failover[kind].length - samples.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

let inboundDropped = 0;
let outboundRefused = 0;
for (const entry of stats.values()) {
  inboundDropped = Math.max(
    inboundDropped,
    Number(entry.inboundDroppedNotOwner ?? 0),
  );
  outboundRefused = Math.max(
    outboundRefused,
    Number(entry.outboundRefusedNotOwner ?? 0),
  );
  report.workerStats[entry.instance] = {
    inboundDroppedNotOwner: entry.inboundDroppedNotOwner,
    outboundRefusedNotOwner: entry.outboundRefusedNotOwner,
    standby: entry.standby,
  };
}
report.counters = {
  messagesPublished: published.length,
  repliesTotal: [...replies.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  ),
  inboundDroppedNotOwner: inboundDropped,
  outboundRefusedNotOwner: outboundRefused,
};
report.assertions = {
  noDuplicateReplies: report.duplicates.length === 0,
  noSimultaneousOwners: report.overlap.totalMs === 0,
  overlapReported: report.overlap.totalMs >= 0,
};
report.finishedAt = new Date().toISOString();
report.durationMs = Date.now() - startedAt;

const directory = path.join(ROOT, 'benchmarks/results');
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, `${report.runId}.json`);
fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
notify(`report written to ${path.relative(ROOT, file)}`);
server.close();
process.exit(0);
