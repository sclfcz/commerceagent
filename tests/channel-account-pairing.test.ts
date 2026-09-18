import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-pairing-'));

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
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'pair-owner',
      username: 'owner',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const pairing = await import('../src/telegram-pairing.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
const removeImGroupRecord = vi.fn(async (jid: string) => {
  db.deleteRegisteredGroup(jid);
  db.deleteChatHistory(jid);
});
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: async () => true,
  disconnectChannelAccount: async () => undefined,
  removeImGroupRecord,
});

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

type PairingProvider =
  | 'telegram'
  | 'qq'
  | 'wechat'
  | 'dingtalk'
  | 'discord'
  | 'whatsapp';

function credentialsFor(provider: PairingProvider, name: string) {
  switch (provider) {
    case 'telegram':
      return { botToken: `123456:${name}` };
    case 'qq':
      return { appId: `${name}-id`, appSecret: `${name}-secret` };
    case 'dingtalk':
      return {
        clientId: `${name}-client-id`,
        clientSecret: `${name}-client-secret`,
      };
    case 'discord':
      return { botToken: `${name}-bot-token` };
    case 'wechat':
    case 'whatsapp':
      return {};
  }
}

async function create(provider: PairingProvider, name: string) {
  const credentials = credentialsFor(provider, name);
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, name, enabled: false, credentials }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).account;
}

function register(jid: string, accountId: string, name: string) {
  db.setRegisteredGroup(jid, {
    name,
    folder: `folder-${accountId}`,
    added_at: new Date().toISOString(),
    created_by: 'pair-owner',
    channel_account_id: accountId,
    target_main_jid: `web:folder-${accountId}`,
  });
}

describe('account-scoped channel pairing', () => {
  test('codes are independent between accounts, rotate per account, and are single-use', () => {
    const first = pairing.generatePairingCode('pair-owner', 'bot-a');
    const second = pairing.generatePairingCode('pair-owner', 'bot-b');
    expect(first.code).not.toBe(second.code);

    const replacement = pairing.generatePairingCode('pair-owner', 'bot-a');
    expect(pairing.verifyPairingCode(first.code)).toBeNull();
    expect(pairing.verifyPairingCode(second.code)).toEqual({
      userId: 'pair-owner',
      accountId: 'bot-b',
    });
    expect(pairing.verifyPairingCode(second.code)).toBeNull();
    expect(pairing.verifyPairingCode(replacement.code.toLowerCase())).toEqual({
      userId: 'pair-owner',
      accountId: 'bot-a',
    });
    expect(pairing.verifyPairingCode(replacement.code)).toBeNull();
  });

  test.each([
    'telegram',
    'qq',
    'wechat',
    'dingtalk',
    'discord',
    'whatsapp',
  ] as const)(
    '%s pairing API returns an account-bound code',
    async (provider) => {
      const first = await create(provider, `${provider}-first`);
      const second = await create(provider, `${provider}-second`);
      const firstResponse = await routes.request(`/${first.id}/pairing-code`, {
        method: 'POST',
      });
      const secondResponse = await routes.request(
        `/${second.id}/pairing-code`,
        {
          method: 'POST',
        },
      );
      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      const firstCode = ((await firstResponse.json()) as any).code;
      const secondCode = ((await secondResponse.json()) as any).code;
      expect(pairing.verifyPairingCode(firstCode)).toEqual({
        userId: 'pair-owner',
        accountId: first.id,
      });
      expect(pairing.verifyPairingCode(secondCode)).toEqual({
        userId: 'pair-owner',
        accountId: second.id,
      });
    },
  );

  test('list and unpair never cross account boundaries', async () => {
    const first = await create('telegram', 'list-first');
    const second = await create('telegram', 'list-second');
    const firstJid = `telegram:same-external#account:${first.id}`;
    const secondJid = `telegram:same-external#account:${second.id}`;
    register(firstJid, first.id, 'First bot chat');
    register(secondJid, second.id, 'Second bot chat');

    const firstList = await routes.request(`/${first.id}/paired-chats`);
    const secondList = await routes.request(`/${second.id}/paired-chats`);
    expect((await firstList.json()) as any).toMatchObject({
      chats: [{ jid: firstJid, name: 'First bot chat' }],
    });
    expect((await secondList.json()) as any).toMatchObject({
      chats: [{ jid: secondJid, name: 'Second bot chat' }],
    });

    const crossAccount = await routes.request(
      `/${first.id}/paired-chats/${encodeURIComponent(secondJid)}`,
      { method: 'DELETE' },
    );
    expect(crossAccount.status).toBe(403);
    expect(db.getRegisteredGroup(secondJid)).toBeDefined();

    const removed = await routes.request(
      `/${first.id}/paired-chats/${encodeURIComponent(firstJid)}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(200);
    expect(removeImGroupRecord).toHaveBeenCalledWith(
      firstJid,
      expect.stringContaining(`channel account ${first.id}`),
    );
    expect(db.getRegisteredGroup(firstJid)).toBeUndefined();
    expect(db.getRegisteredGroup(secondJid)).toBeDefined();
  });

  test('paired-chat removal delegates cache and database cleanup to the lifecycle service', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/routes/channel-accounts.ts'),
      'utf8',
    );
    const endpoint = source.slice(
      source.indexOf("routes.delete('/:id/paired-chats/:jid'"),
      source.indexOf("routes.post('/:id/disconnect'"),
    );
    expect(endpoint).toContain('deps.removeImGroupRecord');
    expect(endpoint).not.toContain('deleteRegisteredGroup(');
    expect(endpoint).not.toContain('deleteChatHistory(');
  });

  test('Feishu keeps its owner/group authorization and rejects pairing endpoints', async () => {
    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'feishu',
        name: 'Feishu owner authorization',
        enabled: false,
        credentials: { appId: 'feishu-id', appSecret: 'feishu-secret' },
      }),
    });
    const account = ((await response.json()) as any).account;
    const pairingResponse = await routes.request(
      `/${account.id}/pairing-code`,
      {
        method: 'POST',
      },
    );
    expect(pairingResponse.status).toBe(409);
  });
});
