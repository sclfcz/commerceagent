#!/usr/bin/env node
/**
 * One IM instance for `dist:chaos:im`.
 *
 * Runs a real IMConnectionManager + ConnectionOwnership against the mock
 * platform started by the chaos driver. Messages are answered through
 * `manager.sendMessage`, so the outbound ownership fence is exercised too.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLATFORM = process.env.IM_PLATFORM_URL;
const CREDENTIALS = (process.env.IM_CREDENTIALS ?? '')
  .split(',')
  .filter(Boolean);
const INSTANCE_ID = process.env.DIST_INSTANCE_ID;
const LEASE_MS = Number(process.env.DIST_IM_LEASE_MS ?? 3000);
const RENEW_MS = Number(process.env.DIST_IM_RENEW_MS ?? 1000);
const REDIS_URL = process.env.DIST_REDIS_URL;
const PLATFORM_MODE =
  process.env.PLATFORM_MODE === 'buffered' ? 'buffered' : 'push';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-chaos-worker-'));
process.env.COMMERCEAGENT_DATA_DIR = dataDir;

const emit = (event, detail = {}) => {
  process.stdout.write(
    `${JSON.stringify({ event, at: Date.now(), ...detail })}\n`,
  );
};

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, PLATFORM);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
            }
          : {},
        timeout: 15_000,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            reject(
              new Error(`bad json from ${urlPath}: ${text.slice(0, 120)}`),
            );
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const { IMConnectionManager } = await import('../src/im-manager.ts');
const { ConnectionOwnership } =
  await import('../src/distributed/connection-ownership.ts');
const { createRedis } = await import('../src/distributed/redis.ts');
const db = await import('../src/db.ts');

db.initDatabase();
const now = new Date().toISOString();
const USER_ID = 'chaos-owner';
const userFor = (credential) => `${USER_ID}-${credential}`;
if (!db.getUserById(USER_ID)) {
  db.createUser({
    id: USER_ID,
    username: USER_ID,
    password_hash: 'hash',
    display_name: 'Chaos Owner',
    role: 'admin',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
}

const redis = createRedis(REDIS_URL);
const timeline = [];
const ownership = new ConnectionOwnership({
  redis,
  instanceId: INSTANCE_ID,
  leaseMs: LEASE_MS,
  renewMs: RENEW_MS,
  onEvent: (event, detail) => {
    // One JSON line per event: the driver collects these from stdout, so a
    // truncated /stats buffer can never hide the recovery stages again.
    emit('ownership_event', { name: event, detail: detail ?? null });
    timeline.push({ event, at: Date.now(), detail: detail ?? null });
  },
});
const manager = new IMConnectionManager();
manager.setConnectionOwnership(ownership);

function channelFor(credential, jid, userId) {
  let connected = false;
  let stopped = false;
  let connId = null;
  let seq = 0;
  let acked = 0;
  let loop = null;
  let streamRequest = null;
  const offsets = new Map();
  const advanceAck = (messageId, offset) => {
    if (PLATFORM_MODE !== 'buffered') return;
    if (acked >= offset) return;
    acked = offset;
    offsets.delete(messageId);
  };
  return {
    channelType: 'feishu',
    isConnected: () => connected,
    async setTyping() {},
    async sendMessage(_chatId, text) {
      // `reply:<messageId>` payloads are what the driver counts.
      const messageId = text.startsWith('reply:') ? text.slice(6) : text;
      try {
        await request('POST', '/reply', {
          credential,
          messageId,
          instance: INSTANCE_ID,
          conn: connId,
        });
        emit('reply_ok', { credential, messageId });
      } catch (error) {
        emit('reply_failed', {
          credential,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      // Only now is the reply actually out: advance the acknowledged offset.
      advanceAck(messageId, offsets.get(messageId) ?? 0);
    },
    async connect(opts) {
      stopped = false;
      if (PLATFORM_MODE === 'push') {
        // Streaming: one JSON line per message until the socket closes.
        await new Promise((resolve, reject) => {
          const url = new URL(
            `/connect?credential=${encodeURIComponent(credential)}&instance=${encodeURIComponent(INSTANCE_ID)}&mode=push`,
            PLATFORM,
          );
          const req = http.get(url, (res) => {
            let buffer = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
              buffer += chunk;
              let index = buffer.indexOf('\n');
              while (index >= 0) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                index = buffer.indexOf('\n');
                if (!line.trim()) continue;
                let message;
                try {
                  message = JSON.parse(line);
                } catch {
                  continue;
                }
                if (message.ready) {
                  connId = message.conn;
                  connected = true;
                  opts.onReady?.();
                  resolve();
                  continue;
                }
                emit('stream_line', {
                  credential,
                  id: message.id,
                  offset: message.offset,
                });
                const owned = manager.isChannelOwner(userId, 'feishu');
                emit('gate', { credential, id: message.id, owned });
                if (!owned) {
                  timeline.push({ event: 'inbound_not_owner', at: Date.now() });
                }
                try {
                  if (!opts.onMessage) emit('no_onmessage', { credential });
                  opts.onMessage?.(jid, `reply:${message.id}`, 'chaos');
                } catch {
                  /* handler failure must not kill the stream */
                }
              }
            });
            res.on('end', () => {
              connected = false;
              resolve();
            });
          });
          req.on('error', (error) => {
            connected = false;
            reject(error);
          });
          req.setTimeout(0);
          streamRequest = req;
        });
        return true;
      }
      const opened = await request(
        'GET',
        `/connect?credential=${encodeURIComponent(credential)}&instance=${encodeURIComponent(INSTANCE_ID)}&mode=${PLATFORM_MODE}`,
      );
      connId = opened.conn;
      connected = true;
      stopped = false;
      opts.onReady?.();
      loop = (async () => {
        while (!stopped) {
          try {
            const result = await request(
              'GET',
              `/poll?credential=${encodeURIComponent(credential)}&conn=${connId}&since=${seq}&ack=${acked}`,
            );
            seq = result.seq ?? seq;
            for (const message of result.messages ?? []) {
              // Buffered mode only acknowledges what this process is still
              // entitled to answer: the manager's inbound gate runs inside
              // `onMessage`, so ownership is checked immediately before it.
              // The inbound gate still runs (so drops are counted); only a
              // message this process is entitled to answer gets its offset
              // acknowledged to the platform.
              const owned = manager.isChannelOwner(userId, 'feishu');
              try {
                if (PLATFORM_MODE === 'buffered')
                  offsets.set(message.id, message.offset ?? 0);
                opts.onMessage?.(jid, `reply:${message.id}`, 'chaos');
                if (PLATFORM_MODE === 'buffered' && !owned)
                  process.stdout.write(
                    `${JSON.stringify({ event: 'offset_not_acked', message: message.id })}\n`,
                  );
              } catch (error) {
                process.stdout.write(
                  `${JSON.stringify({ event: 'handler_error', error: String(error) })}\n`,
                );
              }
            }
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      })();
      return true;
    },
    async disconnect() {
      stopped = true;
      connected = false;
      if (streamRequest) {
        streamRequest.destroy();
        streamRequest = null;
      }
      if (connId)
        await request('POST', '/disconnect', {
          credential,
          conn: connId,
          instance: INSTANCE_ID,
        }).catch(() => {});
      await loop?.catch(() => {});
      loop = null;
    },
  };
}

// A lost lease must rejoin with a *fresh* transport, exactly like production.
manager.setChannelRebuilder(async (userId, channelKey) => {
  const credential = channelKey.split('\u0000')[0] ?? '';
  const owner = userId.slice('chaos-owner-'.length);
  return channelFor(owner, `feishu:${owner}`, userId);
});

for (const credential of CREDENTIALS) {
  const jid = `feishu:${credential}`;
  // One user per credential: the manager keys channels by
  // (userId, channelKey), so a shared user would collapse every credential
  // onto one 'feishu' entry and orphan the earlier connectors.
  const userId = userFor(credential);
  if (!db.getUserById(userId)) {
    db.createUser({
      id: userId,
      username: userId,
      password_hash: 'hash',
      display_name: `Chaos ${credential}`,
      role: 'admin',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
  }
  db.setRegisteredGroup(jid, {
    name: `chaos ${credential}`,
    folder: `chaos-${credential}`,
    added_at: now,
    executionMode: 'host',
    created_by: userId,
  });
  void manager
    .connectChannel(
      userId,
      'feishu',
      channelFor(credential, jid, userId),
      {
        onReady: () => {},
        onNewChat: () => {},
        onMessage: (chatJid, text) =>
          void manager.sendMessage(chatJid, text).catch(() => {}),
      },
      null,
      true,
      credential,
    )
    .catch(() => {});
}

process.stdout.write(
  `${JSON.stringify({ event: 'ready', instanceId: INSTANCE_ID, pid: process.pid, credentials: CREDENTIALS.length })}\n`,
);

// Counters the driver aggregates into the report.
const statsTimer = setInterval(() => {
  void request('POST', '/stats', {
    instance: INSTANCE_ID,
    timeline: timeline.slice(-200),
    ...manager.getConnectionOwnershipStats(),
    standby: manager.getStandbyAccounts().length,
  }).catch(() => {});
}, 1_000);
statsTimer.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await manager.disconnectAll().catch(() => {});
  await ownership.releaseAll().catch(() => {});
  await redis.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
