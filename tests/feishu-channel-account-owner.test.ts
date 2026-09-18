import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-account-owner-'));
vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'feishu-owner-user',
    username: 'feishu-owner-user',
    password_hash: 'test',
    display_name: 'Feishu owner',
    role: 'member',
    status: 'active',
    permissions: [],
    created_at: now,
    updated_at: now,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function account(id: string) {
  return db.createChannelAccount({
    id,
    owner_user_id: 'feishu-owner-user',
    provider: 'feishu',
    name: id,
    secret_ref: `channel-account:${id}`,
    auth_mode: 'credentials',
    auth_status: 'authorized',
  });
}

function group(jid: string, accountId: string, allowlist: string[]) {
  db.setRegisteredGroup(jid, {
    name: jid,
    folder: `folder-${accountId}`,
    added_at: new Date().toISOString(),
    created_by: 'feishu-owner-user',
    channel_account_id: accountId,
    sender_allowlist: allowlist,
    target_main_jid: `web:folder-${accountId}`,
  });
}

function fakeFeishuChannel() {
  let options: IMChannelConnectOpts | null = null;
  let connected = false;
  const channel: IMChannel = {
    channelType: 'feishu',
    async connect(value) {
      options = value;
      connected = true;
      return true;
    },
    async disconnect() {
      connected = false;
    },
    async sendMessage() {},
    async setTyping() {},
    isConnected: () => connected,
  };
  return { channel, getOptions: () => options! };
}

describe('Feishu owner discovery is per channel account', () => {
  test('allowlist backfill updates only groups owned by the discovered account', () => {
    const first = account(`feishu-a-${Date.now()}`);
    const second = account(`feishu-b-${Date.now()}`);
    const firstJid = `feishu:shared#account:${first.id}`;
    const secondJid = `feishu:shared#account:${second.id}`;
    const quarantinedJid = `feishu:quarantined#account:${first.id}`;
    group(firstJid, first.id, []);
    group(secondJid, second.id, []);
    group(quarantinedJid, first.id, []);
    db.setRegisteredGroup(quarantinedJid, {
      ...db.getRegisteredGroup(quarantinedJid)!,
      owner_claim_source: 'transfer_reset',
    });

    expect(
      db.backfillEmptyAllowlistsForChannelAccount(
        'feishu-owner-user',
        first.id,
        'ou_owner_for_first_bot',
      ),
    ).toEqual([firstJid]);
    expect(db.getRegisteredGroup(firstJid)?.sender_allowlist).toEqual([
      'ou_owner_for_first_bot',
    ]);
    expect(db.getRegisteredGroup(firstJid)?.owner_im_id).toBe(
      'ou_owner_for_first_bot',
    );
    expect(db.getRegisteredGroup(firstJid)?.owner_claim_source).toBe(
      'auto_feishu',
    );
    expect(db.getRegisteredGroup(secondJid)?.sender_allowlist).toEqual([]);
    expect(db.getRegisteredGroup(secondJid)?.owner_im_id).toBeUndefined();
    expect(db.getRegisteredGroup(quarantinedJid)).toMatchObject({
      owner_claim_source: 'transfer_reset',
      sender_allowlist: [],
    });
    expect(db.getRegisteredGroup(quarantinedJid)?.owner_im_id).toBeUndefined();
  });

  test('the connection manager does not share owner callbacks between accounts', async () => {
    account('feishu-account-a');
    account('feishu-account-b');
    const manager = new IMConnectionManager();
    const first = fakeFeishuChannel();
    const second = fakeFeishuChannel();
    const firstOwner = vi.fn();
    const secondOwner = vi.fn();
    await manager.connectChannel(
      'feishu-owner-user',
      'feishu',
      first.channel,
      { onReady: vi.fn(), onNewChat: vi.fn(), onP2pSender: firstOwner },
      'feishu-account-a',
    );
    await manager.connectChannel(
      'feishu-owner-user',
      'feishu',
      second.channel,
      { onReady: vi.fn(), onNewChat: vi.fn(), onP2pSender: secondOwner },
      'feishu-account-b',
    );

    first.getOptions().onP2pSender?.('ou_first');
    expect(firstOwner).toHaveBeenCalledWith('ou_first');
    expect(secondOwner).not.toHaveBeenCalled();
    second.getOptions().onP2pSender?.('ou_second');
    expect(secondOwner).toHaveBeenCalledWith('ou_second');
    expect(firstOwner).toHaveBeenCalledTimes(1);
    await manager.disconnectAll();
  });

  test('first-class reload persists discovery to that account secret and account-scoped backfill', () => {
    const source = fs.readFileSync(
      new URL('../src/index.ts', import.meta.url),
      'utf8',
    );
    const start = source.indexOf('async function reloadChannelAccountById');
    const end = source.indexOf(
      'function syncLegacyConfigToDefaultChannelAccount',
      start,
    );
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const reload = source.slice(start, end);
    expect(reload).toContain('onP2pSender: (senderOpenId: string) =>');
    expect(reload).toContain(
      'saveChannelAccountSecret(account.secret_ref, secret)',
    );
    expect(reload).toContain(
      'const ownerOpenId = secret.ownerOpenId ?? senderOpenId',
    );
    expect(reload).toMatch(
      /isSenderAllowedInGroup:\s*\(jid: string, sender\?: string\) =>\s*isSenderAllowedInGroup\(\s*jid,\s*sender,\s*\(\) => secret\.ownerOpenId \|\| undefined,\s*\)/,
    );
    expect(reload).toMatch(
      /backfillEmptyAllowlistsForChannelAccount\(\s*account\.owner_user_id,\s*account\.id,\s*ownerOpenId,\s*\)/,
    );
    expect(reload).not.toContain('saveUserFeishuConfig');
  });
});
