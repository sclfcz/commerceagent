import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-provider-schema-'));

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
      id: 'provider-schema-owner',
      username: 'owner',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: async () => true,
  disconnectChannelAccount: async () => undefined,
  testChannelAccount: async () => ({ success: true }),
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

async function create(provider: string, credentials: Record<string, string>) {
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider,
      name: `${provider}-${crypto.randomUUID()}`,
      enabled: false,
      credentials,
    }),
  });
  return {
    response,
    body: (await response.json()) as Record<string, any>,
  };
}

describe('provider-specific channel credential contract', () => {
  test.each([
    ['feishu', { appId: 'cli-a', appSecret: 'secret-a' }, 'credentials'],
    [
      'telegram',
      { botToken: '123456:token', proxyUrl: 'http://proxy' },
      'bot_token',
    ],
    ['qq', { appId: 'qq-a', appSecret: 'secret-q' }, 'credentials'],
    ['wechat', { bypassProxy: 'true' }, 'qr_session'],
    [
      'dingtalk',
      { clientId: 'ding-a', clientSecret: 'secret-d', streamingMode: 'card' },
      'credentials',
    ],
    [
      'discord',
      { botToken: 'discord-token', streamingMode: 'edit' },
      'bot_token',
    ],
    ['whatsapp', { phoneNumber: '+15551234567' }, 'qr_session'],
  ])(
    'accepts the typed %s shape without serializing secrets',
    async (provider, credentials, authMode) => {
      const { response, body } = await create(provider, credentials);
      expect(response.status).toBe(201);
      expect(body.account).toMatchObject({ provider, auth_mode: authMode });
      expect(body.account).not.toHaveProperty('secret_ref');
      const sensitiveKeys = [
        'appSecret',
        'clientSecret',
        'botToken',
        'ownerOpenId',
      ];
      for (const [key, value] of Object.entries(credentials)) {
        if (sensitiveKeys.includes(key)) {
          expect(JSON.stringify(body)).not.toContain(value);
        }
      }

      const fetched = await routes.request(`/${body.account.id}`);
      const fetchedBody = await fetched.json();
      expect(JSON.stringify(fetchedBody)).not.toContain('secret-');
      expect(JSON.stringify(fetchedBody)).not.toContain('123456:token');
      expect(JSON.stringify(fetchedBody)).not.toContain('discord-token');
    },
  );

  test.each([
    ['feishu', { appId: 'a', appSecret: 'b', botToken: 'must-not-pass' }],
    ['telegram', { botToken: 'a', appSecret: 'must-not-pass' }],
    ['qq', { appId: 'a', appSecret: 'b', proxyUrl: 'must-not-pass' }],
    ['wechat', { botToken: 'QR-output-is-not-user-input' }],
    ['whatsapp', { accountId: 'auth-dir-must-use-immutable-db-id' }],
  ])(
    'rejects unknown %s fields instead of silently persisting them',
    async (provider, credentials) => {
      const { response, body } = await create(provider, credentials);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/Unsupported credential fields/);
    },
  );

  test.each([
    ['feishu', { appId: 'missing-secret' }],
    ['telegram', {}],
    ['qq', { appSecret: 'missing-id' }],
    ['dingtalk', { clientId: 'missing-secret' }],
    ['discord', {}],
  ])(
    'rejects missing required %s credentials',
    async (provider, credentials) => {
      const { response, body } = await create(provider, credentials);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/Missing credential fields/);
    },
  );

  test.each([
    [
      'dingtalk',
      { clientId: 'a', clientSecret: 'b', streamingMode: 'free-text' },
    ],
    ['discord', { botToken: 'a', streamingMode: 'free-text' }],
    ['wechat', { bypassProxy: 'sometimes' }],
  ])(
    'rejects invalid enum-like option for %s',
    async (provider, credentials) => {
      const { response, body } = await create(provider, credentials);
      expect(response.status).toBe(400);
      expect(body.error).toMatch(/must be/);
    },
  );

  test('QR providers are draft accounts until protocol authorization finishes', async () => {
    const wechat = await create('wechat', {});
    const whatsapp = await create('whatsapp', {});
    expect(wechat.body.account).toMatchObject({
      auth_mode: 'qr_session',
      auth_status: 'draft',
      transport_status: 'disconnected',
      has_credentials: false,
    });
    expect(whatsapp.body.account).toMatchObject({
      auth_mode: 'qr_session',
      auth_status: 'draft',
      transport_status: 'disconnected',
      has_credentials: false,
    });
  });
});
