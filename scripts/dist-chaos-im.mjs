#!/usr/bin/env node
/**
 * Chaos test for IM connection ownership (`DIST_IM_OWNERSHIP=1`).
 *
 * Scenarios (each isolated: fresh platform state, fresh workers):
 *   push-3            push platform, 3 instances, SIGKILL x5 / SIGSTOP / SIGTERM,
 *                     plus a 10s Redis outage (docker stop commerceagent-dist-redis).
 *   buffered-3        offset-acknowledged platform (Telegram getUpdates model).
 *   push-2-freeze     A frozen -> B takes over -> A resumes -> B killed -> A
 *                     takes over again (the rebuilder path).
 *
 * The platform is worst-case: one credential may have any number of live
 * connections and every message goes to all of them. Only the lease prevents
 * double replies.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const REDIS_URL =
  process.env.DIST_REDIS_URL?.trim() || 'redis://127.0.0.1:6380';
const CREDENTIALS = Number(process.env.IM_CHAOS_CREDENTIALS ?? 20);
const DURATION_MS = Number(process.env.IM_CHAOS_DURATION_MS ?? 45_000);
const RATE_PER_SEC = Number(process.env.IM_CHAOS_RATE_PER_SEC ?? 20);
// The platform pushes RATE_PER_SEC messages per credential; the old
// 100 ms knob is kept as a fallback for one-off experiments.
const PUSH_INTERVAL_MS = Math.max(
  10,
  Number(process.env.IM_CHAOS_PUSH_MS ?? Math.round(1000 / RATE_PER_SEC)),
);
const LEASE_MS = Number(process.env.DIST_IM_LEASE_MS ?? 3_000);
const RENEW_MS = Number(process.env.DIST_IM_RENEW_MS ?? 1_000);
const KILLS = Number(process.env.IM_CHAOS_KILLS ?? 5);
const REDIS_CONTAINER =
  process.env.IM_CHAOS_REDIS_CONTAINER ?? 'commerceagent-dist-redis';
const REDIS_OUTAGE_MS = Number(process.env.IM_CHAOS_REDIS_OUTAGE_MS ?? 10_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const notify = (message) => process.stderr.write(`[chaos-im] ${message}\n`);
const nowIso = () => new Date().toISOString();
const fsSync = fs;

function percentile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return Number(
    sorted[
      Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)
    ].toFixed(0),
  );
}

function startPlatform(mode) {
  const state = {
    mode,
    streams: new Map(),
    connections: new Map(),
    replies: new Map(),
    connectEvents: [],
    stats: new Map(),
    connSeq: 0,
    published: [],
  };
  const streamFor = (credential) => {
    let stream = state.streams.get(credential);
    if (!stream) {
      stream = { seq: 0, messages: [] };
      state.streams.set(credential, stream);
    }
    return stream;
  };
  state.streamFor = streamFor;
  state.onlineCount = (credential, at = Date.now()) => {
    let count = 0;
    for (const conn of state.connections.values()) {
      if (conn.credential !== credential || conn.closed) continue;
      count += 1;
    }
    return count;
  };
  state.onlineCredentials = (at = Date.now()) => {
    let total = 0;
    for (let index = 0; index < CREDENTIALS; index += 1)
      if (state.onlineCount(`cred-${index}`, at) > 0) total += 1;
    return total;
  };

  const json = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };
  const readBody = (req) =>
    new Promise((resolve) => {
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const credential = url.searchParams.get('credential');
    if (url.pathname === '/connect') {
      const instance = url.searchParams.get('instance');
      const conn = `c${++state.connSeq}`;
      const stream = streamFor(credential);
      const record = {
        credential,
        instance,
        conn,
        // A fresh socket starts at the head: real platforms do not replay old
        // messages to a new connection.
        baseSeq: stream.seq,
        baseOffset: mode === 'buffered' ? stream.seq : 0,
        lastPollAt: Date.now(),
        inFlight: 0,
        closed: false,
        openedAt: Date.now(),
      };
      // The raw socket is the only honest "is this process still connected"
      // signal: a frozen process keeps it open, a killed one closes it.
      record.socket = req.socket;
      req.socket.once('close', () => {
        record.closed = true;
      });
      state.connections.set(conn, record);
      state.connectEvents.push({ credential, instance, conn, at: Date.now() });
      return json(res, 200, { conn });
    }
    if (url.pathname === '/poll') {
      const connId = url.searchParams.get('conn');
      const requestedSince = Number(url.searchParams.get('since') ?? 0);
      const ack = Number(url.searchParams.get('ack') ?? 0);
      const conn = state.connections.get(connId);
      if (!conn) return json(res, 404, { error: 'unknown_conn' });
      const stream = streamFor(credential);
      if (mode === 'buffered' && ack > 0) {
        // Acknowledge = delete: the next owner never sees replayed messages.
        const keep = stream.messages.filter((message) => message.seq > ack);
        stream.messages.length = 0;
        stream.messages.push(...keep);
      }
      const since =
        mode === 'buffered'
          ? Math.max(requestedSince, conn.baseOffset)
          : Math.max(requestedSince, conn.baseSeq);
      conn.lastPollAt = Date.now();
      conn.inFlight += 1;
      let finished = false;
      const finish = (body) => {
        if (finished) return;
        finished = true;
        conn.inFlight = Math.max(0, conn.inFlight - 1);
        json(res, 200, body);
      };
      const deadline = Date.now() + 600;
      const timer = setInterval(() => {
        const pending = stream.messages.filter(
          (message) => message.seq > since,
        );
        if (pending.length || Date.now() > deadline) {
          clearInterval(timer);
          finish({
            seq: stream.seq,
            messages: pending.map((message) => ({
              id: message.id,
              offset: message.seq,
            })),
          });
        }
      }, 25);
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
      const conn = state.connections.get(body.conn);
      if (conn) conn.closed = true;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/reply') {
      const body = await readBody(req);
      const list = state.replies.get(body.messageId) ?? [];
      list.push({ at: Date.now(), instance: body.instance, conn: body.conn });
      state.replies.set(body.messageId, list);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/stats') {
      const body = await readBody(req);
      state.stats.set(body.instance, { ...body, at: Date.now() });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/publish') {
      const body = await readBody(req);
      const stream = streamFor(body.credential);
      stream.seq += 1;
      stream.messages.push({ id: body.id, seq: stream.seq });
      state.published.push({
        id: body.id,
        credential: body.credential,
        seq: stream.seq,
        phase: body.phase,
        at: Date.now(),
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/state') {
      const online = {};
      for (let index = 0; index < CREDENTIALS; index += 1)
        online[`cred-${index}`] = state.onlineCount(`cred-${index}`);
      return json(res, 200, { online, connections: state.connections.size });
    }
    return json(res, 404, {});
  });
  return { state, server };
}

async function runScenario(options) {
  const { label, mode, instances, kills, redisOutage, freezeChain } = options;
  const intervalMs = Math.max(
    10,
    Math.round(
      1000 / Number(process.env.IM_CHAOS_RATE_PER_SEC ?? RATE_PER_SEC),
    ),
  );
  const { state, server } = startPlatform(mode);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const platformUrl = `http://127.0.0.1:${server.address().port}`;
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1 });
  const workers = new Map();
  let instanceSeq = 0;
  let phase = 'steady';
  const startedAt = Date.now();

  function startWorker() {
    const instanceId = `${label}-${process.pid}-${++instanceSeq}`;
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
          PLATFORM_MODE: mode,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const worker = {
      instanceId,
      child,
      pid: child.pid,
      readyAt: null,
      stderr: '',
    };
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (!line.trim()) continue;
        try {
          if (JSON.parse(line).event === 'ready') worker.readyAt = Date.now();
        } catch {
          /* plain log line */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      worker.stderr = `${worker.stderr}${chunk}`.slice(-1500);
    });
    workers.set(instanceId, worker);
    return worker;
  }

  const live = () =>
    [...workers.values()].filter(
      (worker) =>
        worker.child.exitCode === null && worker.child.signalCode === null,
    );

  const waitForReady = async (count, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (live().filter((worker) => worker.readyAt).length >= count) return;
      await sleep(100);
    }
    for (const worker of workers.values())
      notify(`${worker.instanceId}: ${worker.stderr}`);
    throw new Error(`workers_not_ready:${label}`);
  };

  const ownersByInstance = async () => {
    const keys = await redis.keys('dist:im:owner:*').catch(() => []);
    const counts = new Map();
    const values = keys.length ? await redis.mget(...keys).catch(() => []) : [];
    for (const value of values) {
      if (!value) continue;
      const instance = value.slice(0, value.lastIndexOf(':'));
      counts.set(instance, (counts.get(instance) ?? 0) + 1);
    }
    return counts;
  };

  /** The instance that actually holds the most leases, or a hard failure. */
  const topOwner = async (what) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const counts = await ownersByInstance();
      const liveIds = new Set(live().map((worker) => worker.instanceId));
      const best = [...counts.entries()]
        .filter(([instance, count]) => liveIds.has(instance) && count > 0)
        .sort((a, b) => b[1] - a[1])[0];
      if (best) return { worker: workers.get(best[0]), count: best[1] };
      await sleep(200);
    }
    throw new Error(`${what}:no_lease_holder_after_10s`);
  };

  const failover = { SIGKILL: [], SIGTERM: [], takeover: [] };
  const noteFailover = async (bucket, credential, fromAt, fromInstance) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const event = state.connectEvents.find(
        (candidate) =>
          candidate.at >= fromAt &&
          candidate.credential === credential &&
          candidate.instance !== fromInstance,
      );
      if (event) {
        bucket.push(event.at - fromAt);
        return;
      }
      await sleep(20);
    }
    bucket.push(null);
  };
  const ownedCredentials = (instanceId) =>
    [...state.connections.values()]
      .filter((conn) => !conn.closed && conn.instance === instanceId)
      .map((conn) => conn.credential);

  // ── publishing + sampling ───────────────────────────────────
  let publishing = false;
  const publisher = (async () => {
    // Publish only once the workers are connected: messages pushed while the
    // fleet is still booting are genuinely (and uninterestingly) lost.
    const startDeadline = Date.now() + 120_000;
    while (Date.now() < startDeadline) {
      if (state.onlineCredentials() > 0) break;
      await sleep(100);
    }
    publishing = true;
    const deadline = Date.now() + DURATION_MS;
    let seq = 0;
    while (Date.now() < deadline) {
      seq += 1;
      state.phase = phase;
      for (let index = 0; index < CREDENTIALS; index += 1) {
        const credential = `cred-${index}`;
        const stream = state.streamFor(credential);
        stream.seq += 1;
        stream.messages.push({ id: `${credential}:${seq}`, seq: stream.seq });
        state.published.push({
          id: `${credential}:${seq}`,
          credential,
          seq: stream.seq,
          phase,
          at: Date.now(),
        });
      }
      await sleep(intervalMs);
    }
    publishing = false;
    collecting = false;
  })();

  const overlap = {
    totalMs: 0,
    note: 'totalMs sums all credentials (20 credentials add up)',
    byPhase: {},
    overlapMsByCredential: {},
    maxCredentialMs: 0,
  };
  const sampling = (async () => {
    while (!publishing) await sleep(20);
    while (publishing) {
      const at = Date.now();
      const current = state.phase;
      for (let index = 0; index < CREDENTIALS; index += 1) {
        if (state.onlineCount(`cred-${index}`, at) >= 2) {
          const credential = `cred-${index}`;
          overlap.totalMs += intervalMs;
          overlap.byPhase[current] =
            (overlap.byPhase[current] ?? 0) + intervalMs;
          overlap.overlapMsByCredential[credential] =
            (overlap.overlapMsByCredential[credential] ?? 0) + intervalMs;
        }
      }
      await sleep(intervalMs);
    }
  })();

  const injections = [];
  let collecting = true;
  const redisOutageResult = { skipped: true };
  const scenarioAssertions = {};

  const driver = (async () => {
    for (let index = 0; index < instances; index += 1) startWorker();
    await waitForReady(instances);
    await sleep(4_000);

    if (options.probe) {
      // Steady load only: no kills, no outages, no freezes.
      await sleep(DURATION_MS + 2_000);
      phase = 'steady';
    } else if (freezeChain) {
      // 1. freeze the owner (its TCP connection stays open on the platform)
      const a = await topOwner('freeze');
      phase = 'zombie';
      const frozenAt = Date.now();
      injections.push({
        kind: 'SIGSTOP',
        instance: a.worker.instanceId,
        at: frozenAt,
        credentials: a.count,
        holdMs: LEASE_MS * 2,
      });
      a.worker.child.kill('SIGSTOP');
      const aCredentials = ownedCredentials(a.worker.instanceId);
      const aInstance = a.worker.instanceId;
      // 2. B must take over after the lease expires
      await sleep(LEASE_MS * 2);
      const tookOver = state.connectEvents.some(
        (event) => event.at > frozenAt && event.instance !== aInstance,
      );
      scenarioAssertions.takeoverWhileFrozen = tookOver;
      // 3. let it back: it must self-fence, drop queued inbound and rejoin standby
      a.worker.child.kill('SIGCONT');
      injections[injections.length - 1].resumedAt = Date.now();
      await sleep(4_000);
      // 4. kill B: A must rebuild a transport and take over again
      const b = (await topOwner('after-resume')).worker;
      phase = 'after_SIGTERM';
      const killBAt = Date.now();
      injections.push({ kind: 'SIGKILL', instance: b.instanceId, at: killBAt });
      const bCredentials = ownedCredentials(b.instanceId);
      b.child.kill('SIGKILL');
      if (bCredentials.length)
        await noteFailover(
          failover.takeover,
          bCredentials[0],
          killBAt,
          b.instanceId,
        );
      await sleep(LEASE_MS * 2 + 3_000);
      phase = 'steady';
    } else {
      for (let index = 0; index < kills; index += 1) {
        const target = await topOwner('sigkill');
        phase = 'after_SIGKILL';
        const at = Date.now();
        const owned = ownedCredentials(target.worker.instanceId);
        injections.push({
          kind: 'SIGKILL',
          instance: target.worker.instanceId,
          at,
          credentials: owned.length,
        });
        target.worker.child.kill('SIGKILL');
        if (owned.length)
          void noteFailover(
            failover.SIGKILL,
            owned[0],
            at,
            target.worker.instanceId,
          );
        startWorker();
        await sleep(6_000);
        phase = 'steady';
      }

      // Zombie: SIGSTOP for 2x lease, messages keep flowing.
      const zombie = await topOwner('sigstop');
      phase = 'zombie';
      const frozenAt = Date.now();
      injections.push({
        kind: 'SIGSTOP',
        instance: zombie.worker.instanceId,
        at: frozenAt,
        credentials: zombie.count,
        holdMs: LEASE_MS * 2,
      });
      zombie.worker.child.kill('SIGSTOP');
      await sleep(LEASE_MS * 2);
      zombie.worker.child.kill('SIGCONT');
      injections[injections.length - 1].resumedAt = Date.now();
      await sleep(4_000);
      phase = 'steady';

      // Graceful SIGTERM: release must hand over immediately.
      const graceful = await topOwner('sigterm');
      phase = 'after_SIGTERM';
      const termAt = Date.now();
      const termOwned = ownedCredentials(graceful.worker.instanceId);
      injections.push({
        kind: 'SIGTERM',
        instance: graceful.worker.instanceId,
        at: termAt,
        credentials: termOwned.length,
      });
      graceful.worker.child.kill('SIGTERM');
      if (termOwned.length)
        void noteFailover(
          failover.SIGTERM,
          termOwned[0],
          termAt,
          graceful.worker.instanceId,
        );
      startWorker();
      await sleep(6_000);
      phase = 'steady';

      if (redisOutage) {
        phase = 'redis_outage';
        const stopAt = Date.now();
        let allDownAt = null;
        let stopError = null;
        try {
          execFileSync('docker', ['stop', REDIS_CONTAINER], {
            stdio: 'ignore',
          });
        } catch (error) {
          stopError = error instanceof Error ? error.message : String(error);
        }
        const downDeadline = stopAt + LEASE_MS * 3;
        while (Date.now() < downDeadline) {
          if (state.onlineCredentials() === 0) {
            allDownAt = Date.now();
            break;
          }
          await sleep(50);
        }
        const repliesAtStop = [...state.replies.values()].reduce(
          (sum, list) => sum + list.length,
          0,
        );
        let onlineDuringOutage = 0;
        const outageEnd = Date.now() + REDIS_OUTAGE_MS;
        while (Date.now() < outageEnd) {
          onlineDuringOutage = Math.max(
            onlineDuringOutage,
            state.onlineCredentials(),
          );
          await sleep(100);
        }
        const repliesAfterStop = [...state.replies.values()].reduce(
          (sum, list) => sum + list.length,
          0,
        );
        execFileSync('docker', ['start', REDIS_CONTAINER], { stdio: 'ignore' });
        const startAt = Date.now();
        let healthyAt = null;
        const healthyDeadline = Date.now() + 60_000;
        while (Date.now() < healthyDeadline) {
          try {
            await redis.ping();
            healthyAt = Date.now();
            break;
          } catch {
            await sleep(100);
          }
        }
        let firstOwnerAt = null;
        const ownerDeadline = Date.now() + LEASE_MS + RENEW_MS + 30_000;
        while (Date.now() < ownerDeadline) {
          const reconnect = state.connectEvents.find(
            (event) => event.at >= startAt,
          );
          if (reconnect) {
            firstOwnerAt = reconnect.at;
            break;
          }
          await sleep(50);
        }
        Object.assign(redisOutageResult, {
          skipped: false,
          stopError,
          stoppedAt: stopAt,
          allDisconnectedAt: allDownAt,
          disconnectLatencyMs: allDownAt ? allDownAt - stopAt : null,
          resumedAt: startAt,
          healthyAt,
          firstOwnerReconnectAt: firstOwnerAt,
          recoveryMs:
            firstOwnerAt && healthyAt ? firstOwnerAt - healthyAt : null,
          repliesDuringOutage: repliesAfterStop - repliesAtStop,
          maxOnlineDuringOutage: onlineDuringOutage,
          container: REDIS_CONTAINER,
          outageMs: REDIS_OUTAGE_MS,
        });
        await sleep(5_000);
        phase = 'steady';
      }
    }
  })();

  await publisher;
  collecting = false;
  // Let the backlog drain before counting losses: a message published in the
  // last second is not "lost" just because its reply is still in flight.
  {
    const drainDeadline = Date.now() + 30_000;
    let previous = -1;
    while (Date.now() < drainDeadline) {
      const repliesNow = [...state.replies.values()].reduce(
        (sum, list) => sum + list.length,
        0,
      );
      if (repliesNow === previous) break;
      previous = repliesNow;
      await sleep(1_500);
    }
  }
  await sampling;
  await driver.catch((error) => {
    scenarioAssertions.driverError =
      error instanceof Error ? error.message : String(error);
  });
  await sleep(2_500);

  for (const worker of live()) worker.child.kill('SIGTERM');
  await sleep(1_200);
  for (const worker of workers.values())
    if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
  await redis.quit().catch(() => {});
  server.close();

  // ── results ─────────────────────────────────────────────────
  const replied = new Set(state.replies.keys());
  const lost = state.published.filter((message) => !replied.has(message.id));
  const lostByPhase = {};
  for (const message of lost) {
    const bucket = lostByPhase[message.phase] ?? { count: 0, published: 0 };
    bucket.count += 1;
    lostByPhase[message.phase] = bucket;
  }
  for (const message of state.published) {
    const bucket = lostByPhase[message.phase] ?? { count: 0, published: 0 };
    bucket.published += 1;
    lostByPhase[message.phase] = bucket;
  }
  for (const bucket of Object.values(lostByPhase))
    bucket.ratio = Number(
      (bucket.count / Math.max(1, bucket.published)).toFixed(4),
    );

  overlap.maxCredentialMs = Math.max(
    0,
    ...Object.values(overlap.overlapMsByCredential),
  );
  const duplicates = [];
  for (const [messageId, list] of state.replies)
    if (list.length > 1)
      duplicates.push({
        messageId,
        count: list.length,
        by: list.map((entry) => `${entry.instance}/${entry.conn}`),
      });

  let inboundDropped = 0;
  let outboundRefused = 0;
  const workerStats = {};
  for (const entry of state.stats.values()) {
    inboundDropped = Math.max(
      inboundDropped,
      Number(entry.inboundDroppedNotOwner ?? 0),
    );
    outboundRefused = Math.max(
      outboundRefused,
      Number(entry.outboundRefusedNotOwner ?? 0),
    );
    workerStats[entry.instance] = {
      inboundDroppedNotOwner: entry.inboundDroppedNotOwner,
      outboundRefusedNotOwner: entry.outboundRefusedNotOwner,
      standby: entry.standby,
    };
  }

  const stats = (values) => {
    const valid = values.filter((value) => Number.isFinite(value));
    return {
      samples: valid.length,
      missing: values.length - valid.length,
      p50: percentile(valid, 0.5),
      p95: percentile(valid, 0.95),
      max: valid.length ? Math.max(...valid) : null,
    };
  };

  const result = {
    label,
    mode,
    instances,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    injections,
    counters: {
      messagesPublished: state.published.length,
      repliesTotal: [...state.replies.values()].reduce(
        (sum, list) => sum + list.length,
        0,
      ),
      duplicateReplies: duplicates.length,
      lostReplies: lost.length,
      inboundDroppedNotOwner: inboundDropped,
      outboundRefusedNotOwner: outboundRefused,
    },
    duplicates: duplicates.slice(0, 10),
    lostByPhase,
    overlap,
    failover: {
      SIGKILL: stats(failover.SIGKILL),
      SIGTERM: stats(failover.SIGTERM),
      takeoverAfterResume: stats(failover.takeover),
    },
    redisOutage: redisOutageResult,
    workerStats,
  };

  scenarioAssertions.noDuplicateReplies = duplicates.length === 0;
  scenarioAssertions.overlapMeasured = typeof overlap.totalMs === 'number';
  if (!freezeChain) {
    scenarioAssertions.sigkillSamples =
      result.failover.SIGKILL.samples >= kills;
    scenarioAssertions.sigtermImmediate =
      result.failover.SIGTERM.p95 !== null &&
      result.failover.SIGTERM.p95 < RENEW_MS + 500;
    scenarioAssertions.zombieOverlap = (overlap.byPhase.zombie ?? 0) > 0;
    scenarioAssertions.zombieInboundDropped = inboundDropped > 0;
  }
  if (freezeChain) {
    scenarioAssertions.takeoverAfterResume =
      result.failover.takeoverAfterResume.samples >= 1;
  }
  if (redisOutage) {
    scenarioAssertions.ownersDisconnectedWithinLease =
      redisOutageResult.disconnectLatencyMs !== null &&
      redisOutageResult.disconnectLatencyMs <= LEASE_MS + 500;
    scenarioAssertions.noRepliesDuringOutage =
      redisOutageResult.repliesDuringOutage === 0;
    scenarioAssertions.onlineZeroDuringOutage =
      redisOutageResult.maxOnlineDuringOutage === 0;
    scenarioAssertions.recoveredWithinWindow =
      redisOutageResult.recoveryMs !== null &&
      redisOutageResult.recoveryMs <= LEASE_MS + RENEW_MS + 3_000;
  }
  result.assertions = scenarioAssertions;
  return result;
}

async function main() {
  const startedAt = Date.now();
  const scenarios = [];
  const probeResults = [];
  const report = {
    runId: `dist-chaos-im-${nowIso().replace(/[:.]/g, '-')}`,
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
      leaseMs: LEASE_MS,
      renewMs: RENEW_MS,
      kills: KILLS,
      redisContainer: REDIS_CONTAINER,
      redisOutageMs: REDIS_OUTAGE_MS,
      ratePerSec: RATE_PER_SEC,
    },
  };
  let effectiveRate = RATE_PER_SEC;
  try {
    if (process.env.IM_CHAOS_PROBE === '1') {
      const ladder = [10, 20, 40, 80];
      let best = 0;
      for (const rate of ladder) {
        process.env.IM_CHAOS_RATE_PER_SEC = String(rate);
        notify(`capacity probe: ${rate} msg/s per credential, steady`);
        const result = await runScenario({
          label: `probe-${rate}`,
          mode: 'push',
          instances: 3,
          kills: 0,
          redisOutage: false,
          freezeChain: false,
          probe: true,
        });
        const lossRatio =
          result.counters.lostReplies /
          Math.max(1, result.counters.messagesPublished);
        probeResults.push({
          ratePerSec: rate,
          published: result.counters.messagesPublished,
          lost: result.counters.lostReplies,
          lossRatio: Number(lossRatio.toFixed(4)),
          duplicates: result.counters.duplicateReplies,
        });
        if (lossRatio < 0.01) best = rate;
        else break;
      }
      effectiveRate = Math.max(1, Math.floor(best / 2));
      report.capacityProbe = {
        ladder,
        results: probeResults,
        steadyRate: best,
        usedRate: effectiveRate,
      };
      notify(
        `capacity: steady <1% at ${best} msg/s -> chaos runs at ${effectiveRate} msg/s`,
      );
    }
    notify('scenario: push / 3 instances (kill/stop/term + redis outage)');
    scenarios.push(
      await runScenario({
        label: 'push-3',
        mode: 'push',
        instances: 3,
        kills: KILLS,
        redisOutage: true,
        freezeChain: false,
      }),
    );
    notify('scenario: buffered / 3 instances');
    scenarios.push(
      await runScenario({
        label: 'buffered-3',
        mode: 'buffered',
        instances: 3,
        kills: KILLS,
        redisOutage: false,
        freezeChain: false,
      }),
    );
    notify('scenario: push / 2 instances freeze-handover');
    scenarios.push(
      await runScenario({
        label: 'push-2-freeze',
        mode: 'push',
        instances: 2,
        kills: 0,
        redisOutage: false,
        freezeChain: true,
      }),
    );
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.scenarios = scenarios;
  report.passed =
    scenarios.length === 3 &&
    scenarios.every((scenario) =>
      Object.values(scenario.assertions).every((value) => value !== false),
    );
  report.finishedAt = nowIso();
  report.durationMs = Date.now() - startedAt;

  const directory = path.join(ROOT, 'benchmarks/results');
  fsSync.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${report.runId}.json`);
  fsSync.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  notify(`report written to ${path.relative(ROOT, file)}`);
  process.exit(report.passed ? 0 : 1);
}

await main();
