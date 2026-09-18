import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { IMChannel } from '../src/im-channel.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-account-route-'));
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

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function connectedTelegram(sent: string[]): IMChannel {
  let connected = false;
  return {
    channelType: 'telegram',
    async connect() {
      connected = true;
      return true;
    },
    async disconnect() {
      connected = false;
    },
    async sendMessage(chatId, text) {
      sent.push(`${chatId}:${text}`);
    },
    async setTyping() {},
    isConnected: () => connected,
  };
}

test('switching the UI default never reroutes an unscoped legacy JID', async () => {
  const now = new Date().toISOString();
  db.createUser({
    id: 'legacy-user',
    username: 'legacy-user',
    password_hash: 'test',
    display_name: 'Legacy user',
    role: 'member',
    status: 'active',
    permissions: [],
    created_at: now,
    updated_at: now,
  });
  const legacy = db.createChannelAccount({
    id: 'legacy-bot',
    owner_user_id: 'legacy-user',
    provider: 'telegram',
    name: 'Legacy bot',
    secret_ref: 'channel-account:legacy-bot',
    is_default: true,
    is_legacy_default: true,
  });
  const replacement = db.createChannelAccount({
    id: 'new-default-bot',
    owner_user_id: 'legacy-user',
    provider: 'telegram',
    name: 'New default bot',
    secret_ref: 'channel-account:new-default-bot',
  });
  db.setRegisteredGroup('telegram:historic-chat', {
    name: 'Historic chat',
    folder: 'legacy-home',
    added_at: '2026-07-14T00:00:00.000Z',
    created_by: 'legacy-user',
    channel_account_id: legacy.id,
  });
  db.updateChannelAccount(replacement.id, 'legacy-user', { is_default: true });

  const legacySent: string[] = [];
  const replacementSent: string[] = [];
  const manager = new IMConnectionManager();
  const opts = { onReady() {}, onNewChat() {} };
  await manager.connectChannel(
    'legacy-user',
    'telegram',
    connectedTelegram(legacySent),
    opts,
    legacy.id,
  );
  await manager.connectChannel(
    'legacy-user',
    'telegram',
    connectedTelegram(replacementSent),
    opts,
    replacement.id,
  );

  await manager.sendMessage('telegram:historic-chat', 'hello');
  expect(legacySent).toEqual(['historic-chat:hello']);
  expect(replacementSent).toEqual([]);
  await manager.disconnectAll();
});
