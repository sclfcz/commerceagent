import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-delete-cleanup-'));
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
      id: 'delete-owner',
      username: 'owner',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/wechat-onboarding.js', () => ({
  startWeChatQrOnboarding: vi.fn(async () => ({
    qrcode: 'delete-pending-qr',
    qrcodeUrl: 'data:image/png;base64,delete-pending-qr',
  })),
  pollWeChatQrOnboarding: vi.fn(async () => ({ status: 'wait' })),
}));

const db = await import('../src/db.js');
const secrets = await import('../src/channel-account-secrets.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
const disconnect = vi.fn(async () => undefined);
const logoutWhatsApp = vi.fn(async () => undefined);
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: async () => true,
  disconnectChannelAccount: disconnect,
  logoutUserWhatsApp: logoutWhatsApp,
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

async function create(
  provider: 'telegram' | 'wechat' | 'whatsapp',
  name: string,
) {
  const credentials =
    provider === 'telegram' ? { botToken: `123456:${name}` } : {};
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, name, enabled: false, credentials }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).account;
}

describe('channel-account deletion cleanup', () => {
  test('bindings block deletion before any protocol artifact is touched', async () => {
    const account = await create('whatsapp', 'Bound WhatsApp');
    const ref = db.getChannelAccount(account.id)!.secret_ref;
    const jid = `whatsapp:group@g.us#account:${account.id}`;
    db.setRegisteredGroup(jid, {
      name: 'Bound WhatsApp group',
      folder: 'bound-folder',
      added_at: new Date().toISOString(),
      created_by: 'delete-owner',
      channel_account_id: account.id,
      target_main_jid: 'web:bound-folder',
    });

    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ binding_count: 1 });
    expect(db.getChannelAccount(account.id)).toBeDefined();
    expect(secrets.loadChannelAccountSecret(ref)).not.toBeNull();
    expect(logoutWhatsApp).not.toHaveBeenCalledWith('delete-owner', account.id);
    expect(disconnect).not.toHaveBeenCalledWith(account.id);
  });

  test('unbound WhatsApp deletion logs out the exact account and removes metadata and secret', async () => {
    const account = await create('whatsapp', 'Unbound WhatsApp');
    const ref = db.getChannelAccount(account.id)!.secret_ref;
    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(logoutWhatsApp).toHaveBeenCalledWith('delete-owner', account.id);
    expect(db.getChannelAccount(account.id)).toBeUndefined();
    expect(secrets.loadChannelAccountSecret(ref)).toBeNull();
  });

  test('unbound WeChat deletion clears pending onboarding and secret state', async () => {
    const account = await create('wechat', 'Pending WeChat');
    const ref = db.getChannelAccount(account.id)!.secret_ref;
    await routes.request(`/${account.id}/onboarding`, { method: 'POST' });
    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(account.id);
    expect(db.getChannelAccount(account.id)).toBeUndefined();
    expect(secrets.loadChannelAccountSecret(ref)).toBeNull();
    expect(
      (await routes.request(`/${account.id}/onboarding/status`)).status,
    ).toBe(404);
  });

  test('credential provider deletion disconnects before removing the secret', async () => {
    const account = await create('telegram', 'Delete Telegram');
    const ref = db.getChannelAccount(account.id)!.secret_ref;
    const response = await routes.request(`/${account.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);
    expect(disconnect).toHaveBeenCalledWith(account.id);
    expect(secrets.loadChannelAccountSecret(ref)).toBeNull();
    expect(db.getChannelAccount(account.id)).toBeUndefined();
  });
});
