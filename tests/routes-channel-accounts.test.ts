import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-accounts-route-'));
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
      id: process.env.CHANNEL_TEST_USER || 'owner-a',
      username: 'test',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const channelSecrets = await import('../src/channel-account-secrets.js');
const routes = routeModule.default;
const reload = vi.fn(async () => true);
const disconnect = vi.fn(async () => undefined);
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: reload,
  disconnectChannelAccount: disconnect,
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
  delete process.env.CHANNEL_TEST_USER;
});

async function createTelegram(name: string) {
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'telegram',
      name,
      credentials: { botToken: '123456:test-secret-token' },
    }),
  });
  return { response, body: (await response.json()) as any };
}

describe('channel account routes', () => {
  test('CRUD never returns credentials or secret_ref and enforces owner ACL', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createTelegram(`Bot ${Date.now()}`);
    expect(created.response.status).toBe(201);
    expect(created.body.account).toMatchObject({
      provider: 'telegram',
      owner_user_id: 'owner-a',
      has_credentials: true,
    });
    expect(JSON.stringify(created.body)).not.toContain('test-secret-token');
    expect(created.body.account).not.toHaveProperty('secret_ref');

    const list = await routes.request('/');
    const listBody = (await list.json()) as any;
    expect(
      listBody.accounts.some((a: any) => a.id === created.body.account.id),
    ).toBe(true);
    expect(JSON.stringify(listBody)).not.toContain('test-secret-token');

    process.env.CHANNEL_TEST_USER = 'owner-b';
    const hidden = await routes.request(`/${created.body.account.id}`);
    expect(hidden.status).toBe(404);
    const forbiddenDelete = await routes.request(
      `/${created.body.account.id}`,
      {
        method: 'DELETE',
      },
    );
    expect(forbiddenDelete.status).toBe(404);

    process.env.CHANNEL_TEST_USER = 'owner-a';
    const toggled = await routes.request(`/${created.body.account.id}/toggle`, {
      method: 'POST',
    });
    expect(toggled.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(created.body.account.id);
  });

  test('publishes one stable mode-0600 encryption key in a mode-0700 directory', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    await createTelegram(`Key owner ${Date.now()}`);
    const keyPath = path.join(tmp, 'config', 'claude-provider.key');
    const firstKey = fs.readFileSync(keyPath, 'utf8');
    channelSecrets.saveChannelAccountSecret('channel-account:key-race-probe', {
      botToken: 'probe',
    });
    expect(fs.readFileSync(keyPath, 'utf8')).toBe(firstKey);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(keyPath)).mode & 0o777).toBe(0o700);
  });

  test('failed connector cleanup keeps the account disabled and reports a retryable partial success', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createTelegram(`Cleanup failure ${Date.now()}`);
    const accountId = created.body.account.id as string;
    disconnect.mockRejectedValueOnce(new Error('socket did not stop'));

    const response = await routes.request(`/${accountId}/toggle`, {
      method: 'POST',
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      persisted: true,
      retryable: true,
      account: { id: accountId, enabled: false },
    });
    expect(db.getChannelAccount(accountId)).toMatchObject({
      enabled: false,
      transport_status: 'error',
    });
  });

  test('deprecated Agent default is absent from the public account contract', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const response = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'telegram',
        name: `No Agent fallback ${Date.now()}`,
        default_agent_profile_id: 'must-be-ignored',
        credentials: { botToken: '123456:test-secret-token' },
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.account).not.toHaveProperty('default_agent_profile_id');
    expect(db.getChannelAccount(body.account.id)).toMatchObject({
      default_agent_profile_id: null,
    });
  });

  test('delete is blocked while an account-scoped group is bound', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const created = await createTelegram(`Bound ${Date.now()}`);
    const accountId = created.body.account.id as string;
    const jid = `telegram:same-chat#account:${accountId}`;
    db.setRegisteredGroup(jid, {
      name: 'Bound group',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: 'owner-a',
      channel_account_id: accountId,
      target_main_jid: 'web:owner-home',
    });
    const blocked = await routes.request(`/${accountId}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ binding_count: 1 });

    db.deleteRegisteredGroup(jid);
    const removed = await routes.request(`/${accountId}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(db.getChannelAccount(accountId)).toBeUndefined();
  });

  test('legacy account is protected while an unscoped group references it', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const account = db.createChannelAccount({
      id: `legacy-bound-${Date.now()}`,
      owner_user_id: 'owner-a',
      provider: 'feishu',
      name: `Legacy bound ${Date.now()}`,
      secret_ref: `channel-account:legacy-bound-${Date.now()}`,
      is_legacy_default: true,
    });
    db.setRegisteredGroup('feishu:legacy-bound-chat', {
      name: 'Legacy bound chat',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: 'owner-a',
      channel_account_id: account.id,
    });
    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ binding_count: 1 });
  });

  test('failed metadata update restores the previous credential file', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const first = await createTelegram(`Atomic first ${Date.now()}`);
    const second = await createTelegram(`Atomic second ${Date.now()}`);
    const firstAccount = db.getChannelAccount(first.body.account.id)!;
    const original = channelSecrets.loadChannelAccountSecret(
      firstAccount.secret_ref,
    );

    const response = await routes.request(`/${firstAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: second.body.account.name,
        credentials: { botToken: '999999:replacement-must-rollback' },
      }),
    });
    expect(response.status).toBe(409);
    expect(
      channelSecrets.loadChannelAccountSecret(firstAccount.secret_ref),
    ).toEqual(original);
  });

  test('direct POST projects a legacy default before creating a secondary account', async () => {
    process.env.CHANNEL_TEST_USER = 'legacy-direct-post';
    runtimeConfig.saveUserTelegramConfig('legacy-direct-post', {
      botToken: '123456:legacy-token',
      enabled: true,
    });
    db.setRegisteredGroup('web:legacy-direct-home', {
      name: 'Legacy home',
      folder: 'legacy-direct-home',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-direct-post',
    });
    db.setRegisteredGroup('telegram:existing-group', {
      name: 'Existing Telegram group',
      folder: 'legacy-direct-home',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-direct-post',
      target_main_jid: 'web:legacy-direct-home',
    });

    // Deliberately POST without first calling GET /channel-accounts.
    const created = await createTelegram('Second Telegram bot');
    expect(created.response.status).toBe(201);

    const accounts = db.listChannelAccountsForUser('legacy-direct-post');
    expect(accounts).toHaveLength(2);
    const legacyAccount = accounts.find((account) => account.is_legacy_default);
    expect(accounts.find((account) => account.is_default)).toMatchObject({
      is_legacy_default: true,
      provider: 'telegram',
    });
    expect(created.body.account).toMatchObject({
      is_default: false,
      is_legacy_default: false,
    });
    expect(db.getRegisteredGroup('telegram:existing-group')).toMatchObject({
      target_main_jid: 'web:legacy-direct-home',
      channel_account_id: legacyAccount?.id,
    });
  });

  test('legacy default cannot be deleted and first-class edits stay visible through the old facade', async () => {
    process.env.CHANNEL_TEST_USER = 'legacy-facade-owner';
    runtimeConfig.saveUserTelegramConfig('legacy-facade-owner', {
      botToken: '123456:legacy-before',
      proxyUrl: 'http://old-proxy.invalid',
      enabled: true,
    });
    const listed = await routes.request('/');
    const account = ((await listed.json()) as any).accounts.find(
      (item: any) => item.provider === 'telegram',
    );
    expect(account).toMatchObject({ is_legacy_default: true });

    const patched = await routes.request(`/${account.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        credentials: {
          botToken: '654321:legacy-after',
          proxyUrl: 'http://new-proxy.invalid',
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(
      runtimeConfig.getUserTelegramConfig('legacy-facade-owner'),
    ).toMatchObject({
      botToken: '654321:legacy-after',
      proxyUrl: 'http://new-proxy.invalid',
      enabled: true,
    });

    const removed = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(409);
    const relisted = await routes.request('/');
    const accounts = ((await relisted.json()) as any).accounts.filter(
      (item: any) => item.provider === 'telegram',
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(account.id);

    const toggled = await routes.request(`/${account.id}/toggle`, {
      method: 'POST',
    });
    expect(toggled.status).toBe(200);
    expect(
      runtimeConfig.getUserTelegramConfig('legacy-facade-owner'),
    ).toMatchObject({
      enabled: false,
      botToken: '654321:legacy-after',
    });
  });

  test('credential reload failure rolls back metadata, secret, and auth state', async () => {
    process.env.CHANNEL_TEST_USER = 'owner-a';
    const createResponse = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'telegram',
        name: `Rollback ${Date.now()}`,
        enabled: false,
        credentials: { botToken: '123456:known-good' },
      }),
    });
    const created = (await createResponse.json()) as any;
    const id = created.account.id as string;
    const before = db.getChannelAccount(id)!;
    const beforeSecret = channelSecrets.loadChannelAccountSecret(
      before.secret_ref,
    );
    reload.mockResolvedValueOnce(false);

    const failed = await routes.request(`/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Must not persist',
        enabled: true,
        credentials: { botToken: '999999:bad-token' },
      }),
    });
    expect(failed.status).toBe(422);
    expect(db.getChannelAccount(id)).toMatchObject({
      name: before.name,
      enabled: false,
      auth_status: 'authorized',
    });
    expect(channelSecrets.loadChannelAccountSecret(before.secret_ref)).toEqual(
      beforeSecret,
    );
  });

  test('failed promotion restores the exact previous default among three accounts', async () => {
    process.env.CHANNEL_TEST_USER = 'three-default-owner';
    const first = await createTelegram('First default');
    const second = await createTelegram('Second account');
    const third = await routes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'telegram',
        name: 'Third account',
        enabled: false,
        credentials: { botToken: '123456:third-good' },
      }),
    });
    const thirdAccount = ((await third.json()) as any).account;
    expect(db.getChannelAccount(first.body.account.id)?.is_default).toBe(true);
    expect(db.getChannelAccount(second.body.account.id)?.is_default).toBe(
      false,
    );
    reload.mockResolvedValueOnce(false);
    const failed = await routes.request(`/${thirdAccount.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        is_default: true,
        credentials: { botToken: '999999:third-bad' },
      }),
    });
    expect(failed.status).toBe(422);
    expect(db.getChannelAccount(first.body.account.id)?.is_default).toBe(true);
    expect(db.getChannelAccount(second.body.account.id)?.is_default).toBe(
      false,
    );
    expect(db.getChannelAccount(thirdAccount.id)?.is_default).toBe(false);
  });

  test('live disconnected probe downgrades stale connected transport metadata', async () => {
    process.env.CHANNEL_TEST_USER = 'live-probe-owner';
    const created = await createTelegram('Stale transport');
    db.updateChannelAccountStatus(created.body.account.id, 'connected');
    routeModule.injectChannelAccountDeps({
      reloadChannelAccount: reload,
      disconnectChannelAccount: disconnect,
      testChannelAccount: async () => ({ success: true }),
      isChannelAccountConnected: () => false,
    });
    const response = await routes.request(`/${created.body.account.id}`);
    expect((await response.json()) as any).toMatchObject({
      account: { transport_status: 'disconnected', status: 'disconnected' },
    });
    routeModule.injectChannelAccountDeps({
      reloadChannelAccount: reload,
      disconnectChannelAccount: disconnect,
      testChannelAccount: async () => ({ success: true }),
    });
  });
});
