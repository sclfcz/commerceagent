import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-ownership-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { ConnectionOwnership, ownershipCredentialKey } =
  await import('../src/distributed/connection-ownership.js');
const { createTestRedis, describeRedis, hasRedis } =
  await import('./distributed/helpers.js');

import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';
import type { Redis } from 'ioredis';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeChannel(type = 'feishu') {
  let connected = false;
  let opts: IMChannelConnectOpts | null = null;
  const connect = vi.fn(async (value: IMChannelConnectOpts) => {
    opts = value;
    connected = true;
    return true;
  });
  const disconnect = vi.fn(async () => {
    connected = false;
  });
  const sendMessage = vi.fn(async () => {});
  const channel: IMChannel = {
    channelType: type,
    connect,
    disconnect,
    sendMessage,
    async setTyping() {},
    isConnected: () => connected,
  };
  return { channel, connect, disconnect, sendMessage, opts: () => opts };
}

const callbacks = (): IMChannelConnectOpts => ({
  onReady: vi.fn(),
  onNewChat: vi.fn(),
  onMessage: vi.fn(),
});

const CHAT_JID = 'feishu:ownership-chat';
const USER_ID = 'ownership-user';
const CREDENTIAL = 'app-id:secret';

describeRedis('IM connection ownership integration', () => {
  let redis: Redis;
  const managers: InstanceType<typeof IMConnectionManager>[] = [];

  const makeOwnership = (instanceId: string) =>
    new ConnectionOwnership({
      redis,
      instanceId,
      leaseMs: 600,
      renewMs: 150,
    });

  beforeAll(async () => {
    redis = await createTestRedis();
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: USER_ID,
      username: USER_ID,
      password_hash: 'hash',
      display_name: 'Owner',
      role: 'admin',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    } as never);
    db.setRegisteredGroup(CHAT_JID, {
      name: 'ownership chat',
      folder: 'ownership-chat',
      added_at: now,
      executionMode: 'host',
      created_by: USER_ID,
    } as never);
  });

  afterAll(async () => {
    for (const manager of managers)
      await manager.disconnectAll().catch(() => {});
    await redis?.quit().catch(() => {});
  });

  beforeEach(async () => {
    for (const manager of managers.splice(0))
      await manager.disconnectAll().catch(() => {});
  });

  const newManager = (ownership: ConnectionOwnership | null) => {
    const manager = new IMConnectionManager();
    if (ownership) manager.setConnectionOwnership(ownership);
    managers.push(manager);
    return manager;
  };

  test('only the lease holder connects; the other instance is standby', async () => {
    const a = newManager(makeOwnership(`a-${randomUUID()}`));
    const b = newManager(makeOwnership(`b-${randomUUID()}`));
    const chA = fakeChannel();
    const chB = fakeChannel();

    expect(
      await a.connectChannel(
        USER_ID,
        'feishu',
        chA.channel,
        callbacks(),
        'acct',
        true,
        CREDENTIAL,
      ),
    ).toBe(true);
    expect(
      await b.connectChannel(
        USER_ID,
        'feishu',
        chB.channel,
        callbacks(),
        'acct',
        true,
        CREDENTIAL,
      ),
    ).toBe(false);

    expect(chA.connect).toHaveBeenCalledTimes(1);
    expect(chB.connect).not.toHaveBeenCalled();
    expect(b.getStandbyAccounts()).toHaveLength(1);
  });

  test('a normal disconnect hands over within one renew cycle', async () => {
    const a = newManager(makeOwnership(`a-${randomUUID()}`));
    const b = newManager(makeOwnership(`b-${randomUUID()}`));
    const chA = fakeChannel();
    const chB = fakeChannel();

    await a.connectChannel(
      USER_ID,
      'feishu',
      chA.channel,
      callbacks(),
      'acct',
      true,
      CREDENTIAL,
    );
    await b.connectChannel(
      USER_ID,
      'feishu',
      chB.channel,
      callbacks(),
      'acct',
      true,
      CREDENTIAL,
    );
    expect(chB.connect).not.toHaveBeenCalled();

    await a.disconnectChannelAccount(USER_ID, 'feishu', 'acct');

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !chB.connect.mock.calls.length)
      await sleep(50);
    expect(chB.connect).toHaveBeenCalledTimes(1);
    expect(b.getStandbyAccounts()).toHaveLength(0);
  });

  test('a non-owner drops inbound and refuses outbound', async () => {
    const a = newManager(makeOwnership(`a-${randomUUID()}`));
    const chA = fakeChannel();
    // `scopeConnectOpts` wraps every callback, so assertions target the
    // original spies rather than the scoped wrappers.
    const handlers = callbacks();
    // No account scope: account-scoped inbound additionally requires a real
    // channel-account row, which is not what this test is about.
    await a.connectChannel(
      USER_ID,
      'feishu',
      chA.channel,
      handlers,
      null,
      true,
      CREDENTIAL,
    );
    const opts = chA.opts()!;

    // Healthy owner: inbound flows and outbound is allowed.
    opts.onMessage!(CHAT_JID, 'hello', 'user');
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    await a.sendMessage(CHAT_JID, 'reply');
    expect(chA.sendMessage).toHaveBeenCalledTimes(1);

    // Freeze the lease: stop renewing and let it expire.
    const lease = (
      a as unknown as { ownershipLeases: Map<string, { stop(): void }> }
    ).ownershipLeases;
    for (const entry of lease.values()) entry.stop();
    await sleep(900);

    opts.onMessage!(CHAT_JID, 'late', 'user');
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    expect(
      a.getConnectionOwnershipStats().inboundDroppedNotOwner,
    ).toBeGreaterThanOrEqual(1);

    await expect(a.sendMessage(CHAT_JID, 'stale reply')).rejects.toThrow(
      /ownership was lost/i,
    );
    expect(chA.sendMessage).toHaveBeenCalledTimes(1);
    expect(a.getConnectionOwnershipStats().outboundRefusedNotOwner).toBe(1);
  });

  test('with the switch off both instances connect (legacy behaviour)', async () => {
    const a = newManager(null);
    const b = newManager(null);
    const chA = fakeChannel();
    const chB = fakeChannel();
    expect(
      await a.connectChannel(
        USER_ID,
        'feishu',
        chA.channel,
        callbacks(),
        'acct-a',
        true,
        CREDENTIAL,
      ),
    ).toBe(true);
    expect(
      await b.connectChannel(
        USER_ID,
        'feishu',
        chB.channel,
        callbacks(),
        'acct-b',
        true,
        CREDENTIAL,
      ),
    ).toBe(true);
    expect(chA.connect).toHaveBeenCalledTimes(1);
    expect(chB.connect).toHaveBeenCalledTimes(1);
  });
  test('a frozen owner rejoins standby and returns with a fresh transport', async () => {
    let mono = 1_000;
    const ownershipA = new ConnectionOwnership({
      redis,
      instanceId: `a-${randomUUID()}`,
      leaseMs: 600,
      renewMs: 150,
      monotonicNow: () => mono,
    });
    const a = newManager(ownershipA);
    const b = newManager(makeOwnership(`b-${randomUUID()}`));
    const rebuilt: ReturnType<typeof fakeChannel>[] = [];
    a.setChannelRebuilder(async () => {
      const fresh = fakeChannel();
      rebuilt.push(fresh);
      return fresh.channel;
    });
    const first = fakeChannel();
    const chB = fakeChannel();

    await a.connectChannel(
      USER_ID,
      'feishu',
      first.channel,
      callbacks(),
      'acct',
      true,
      CREDENTIAL,
    );
    await b.connectChannel(
      USER_ID,
      'feishu',
      chB.channel,
      callbacks(),
      'acct',
      true,
      CREDENTIAL,
    );
    expect(chB.connect).not.toHaveBeenCalled();

    // Freeze A: the monotonic clock jumps past the lease while no timer runs.
    mono += 10_000;
    first.opts()!.onMessage!(CHAT_JID, 'queued while frozen', 'user');
    // The Redis TTL then expires and B takes over.
    const takeover = Date.now() + 5_000;
    while (Date.now() < takeover && !chB.connect.mock.calls.length)
      await sleep(50);
    expect(chB.connect).toHaveBeenCalledTimes(1);

    // B leaves: A must rejoin the standby and rebuild a *new* transport.
    await b.disconnectChannelAccount(USER_ID, 'feishu', 'acct');
    const rejoined = Date.now() + 5_000;
    while (
      Date.now() < rejoined &&
      !(rebuilt.length && rebuilt[0].connect.mock.calls.length)
    )
      await sleep(50);
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(rebuilt[0].connect).toHaveBeenCalledTimes(1);
    expect(rebuilt[0].channel).not.toBe(first.channel);
  });

  test('a rebuilder returning null stops the standby retries', async () => {
    let mono = 1_000;
    const ownership = new ConnectionOwnership({
      redis,
      instanceId: `a-${randomUUID()}`,
      leaseMs: 600,
      renewMs: 150,
      monotonicNow: () => mono,
    });
    const manager = newManager(ownership);
    manager.setChannelRebuilder(async () => null);
    const first = fakeChannel();
    await manager.connectChannel(
      USER_ID,
      'feishu',
      first.channel,
      callbacks(),
      'acct',
      true,
      CREDENTIAL,
    );
    mono += 10_000;
    first.opts()!.onMessage!(CHAT_JID, 'frozen', 'user');
    await sleep(400);
    expect(manager.getStandbyAccounts()).toHaveLength(0);
    await sleep(500);
    expect(first.connect).toHaveBeenCalledTimes(1);
  });
});
