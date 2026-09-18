import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { IMChannel } from '../src/im-channel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'im-owner-fallback-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
  DATA_DIR: tmp,
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('IM sibling routing tenant boundary', () => {
  test('never borrows a same-folder connector owned by another user', async () => {
    const now = new Date().toISOString();
    for (const id of ['owner-a', 'owner-b']) {
      db.createUser({
        id,
        username: id,
        password_hash: 'test',
        display_name: id,
        role: 'member',
        status: 'active',
        permissions: [],
        created_at: now,
        updated_at: now,
      });
    }
    db.setRegisteredGroup('telegram:target', {
      name: 'Target',
      folder: 'colliding-folder',
      added_at: now,
      created_by: 'owner-a',
    });
    db.setRegisteredGroup('telegram:sibling', {
      name: 'Sibling',
      folder: 'colliding-folder',
      added_at: now,
      created_by: 'owner-b',
    });

    const foreignChannel: IMChannel = {
      channelType: 'telegram',
      connect: async () => true,
      disconnect: async () => undefined,
      sendMessage: async () => undefined,
      setTyping: async () => undefined,
      isConnected: () => true,
    };
    const manager = new IMConnectionManager();
    const internals = manager as unknown as {
      connections: Map<
        string,
        { channels: Map<string, IMChannel>; connectedAt: Date }
      >;
      findChannelForJid: (
        jid: string,
        channelType: string,
      ) => IMChannel | undefined;
    };
    internals.connections.set('owner-b', {
      channels: new Map([['telegram', foreignChannel]]),
      connectedAt: new Date(),
    });

    expect(
      internals.findChannelForJid('telegram:target', 'telegram'),
    ).toBeUndefined();
  });

  test('live connectors reject inbound and outbound traffic after account or user disable', async () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'inbound-owner',
      username: 'inbound-owner',
      password_hash: 'test',
      display_name: 'Inbound owner',
      role: 'member',
      status: 'active',
      permissions: [],
      created_at: now,
      updated_at: now,
    });
    db.createChannelAccount({
      id: 'inbound-account',
      owner_user_id: 'inbound-owner',
      provider: 'telegram',
      name: 'Inbound account',
      secret_ref: 'test-secret-ref',
      enabled: true,
      auth_status: 'authorized',
    });

    let capturedOpts:
      | import('../src/im-channel.js').IMChannelConnectOpts
      | null = null;
    const sendMessage = vi.fn(async () => undefined);
    const channel: IMChannel = {
      channelType: 'telegram',
      connect: async (opts) => {
        capturedOpts = opts;
        return true;
      },
      disconnect: async () => undefined,
      sendMessage,
      setTyping: async () => undefined,
      isConnected: () => true,
    };
    const onNewChat = vi.fn();
    const onCommand = vi.fn(async () => 'ok');
    const manager = new IMConnectionManager();
    await manager.connectChannel(
      'inbound-owner',
      'telegram',
      channel,
      {
        onReady: vi.fn(),
        onNewChat,
        isChatAuthorized: () => true,
        onCommand,
        resolveEffectiveChatJid: (jid) => ({
          effectiveJid: jid,
          agentId: null,
        }),
      },
      'inbound-account',
      true,
      'inbound-credential',
    );
    const opts = capturedOpts!;

    db.updateChannelAccount('inbound-account', 'inbound-owner', {
      enabled: false,
    });
    expect(opts.isChatAuthorized!('telegram:chat')).toBe(false);
    opts.onNewChat('telegram:chat', 'Blocked');
    expect(onNewChat).not.toHaveBeenCalled();
    await expect(
      opts.onCommand!('telegram:chat', '/status'),
    ).resolves.toBeNull();
    expect(onCommand).not.toHaveBeenCalled();
    expect(() => opts.resolveEffectiveChatJid!('telegram:chat')).toThrow(
      'Channel binding resolver rejected route',
    );
    db.setRegisteredGroup('telegram:chat#account:inbound-account', {
      name: 'Inbound chat',
      folder: 'inbound-folder',
      added_at: now,
      created_by: 'inbound-owner',
      channel_account_id: 'inbound-account',
    });
    await expect(
      manager.sendMessage(
        'telegram:chat#account:inbound-account',
        'must not send',
      ),
    ).rejects.toThrow('No IM channel available');
    expect(sendMessage).not.toHaveBeenCalled();

    db.updateChannelAccount('inbound-account', 'inbound-owner', {
      enabled: true,
    });
    db.updateUserFields('inbound-owner', { status: 'disabled' });
    expect(opts.isChatAuthorized!('telegram:chat')).toBe(false);
    await expect(
      manager.sendMessage(
        'telegram:chat#account:inbound-account',
        'still must not send',
      ),
    ).rejects.toThrow('No IM channel available');
    expect(manager.getConnectedChannelTypes('inbound-owner')).toEqual([]);
    expect(
      manager.isChannelAccountConnected(
        'inbound-owner',
        'telegram',
        'inbound-account',
      ),
    ).toBe(false);

    await manager.disconnectAll();
  });

  test('never falls back to a different Bot bound to the same workspace', async () => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'multi-bot-owner',
      username: 'multi-bot-owner',
      password_hash: 'test',
      display_name: 'Multi Bot owner',
      role: 'member',
      status: 'active',
      permissions: [],
      created_at: now,
      updated_at: now,
    });
    for (const id of ['account-a', 'account-b']) {
      db.createChannelAccount({
        id,
        owner_user_id: 'multi-bot-owner',
        provider: 'telegram',
        name: id,
        secret_ref: `secret-${id}`,
        enabled: true,
        auth_status: 'authorized',
      });
    }
    db.setRegisteredGroup('telegram:chat-a#account:account-a', {
      name: 'Chat A',
      folder: 'shared-workspace',
      added_at: now,
      created_by: 'multi-bot-owner',
      channel_account_id: 'account-a',
    });
    db.setRegisteredGroup('telegram:chat-b#account:account-b', {
      name: 'Chat B',
      folder: 'shared-workspace',
      added_at: now,
      created_by: 'multi-bot-owner',
      channel_account_id: 'account-b',
    });

    const sendFromB = vi.fn(async () => undefined);
    const channelB: IMChannel = {
      channelType: 'telegram',
      connect: async () => true,
      disconnect: async () => undefined,
      sendMessage: sendFromB,
      setTyping: async () => undefined,
      isConnected: () => true,
    };
    const manager = new IMConnectionManager();
    await manager.connectChannel(
      'multi-bot-owner',
      'telegram',
      channelB,
      { onReady: vi.fn(), onNewChat: vi.fn() },
      'account-b',
    );

    await expect(
      manager.sendMessage(
        'telegram:chat-a#account:account-a',
        'must not cross Bot accounts',
      ),
    ).rejects.toThrow('No IM channel available');
    expect(sendFromB).not.toHaveBeenCalled();

    await manager.disconnectAll();
  });
});
