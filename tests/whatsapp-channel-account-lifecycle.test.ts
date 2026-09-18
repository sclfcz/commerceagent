import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-account-'));

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
  logger: {
    child: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'wa-owner',
        username: 'owner',
        role: 'member',
        permissions: [],
      });
      return next();
    },
  };
});

const db = await import('../src/db.js');
const secrets = await import('../src/channel-account-secrets.js');
const { closeWhatsAppSocketSafely, getWhatsAppAuthDir } =
  await import('../src/whatsapp.js');
const { WhatsAppConfigSchema } = await import('../src/schemas.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
const states = new Map<string, any>();
const reload = vi.fn(async () => true);
const disconnect = vi.fn(async () => undefined);
const logout = vi.fn(async (_userId: string, accountId: string) => {
  states.set(accountId, { status: 'disconnected' });
});
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: reload,
  disconnectChannelAccount: disconnect,
  isChannelAccountConnected: (accountId) =>
    states.get(accountId)?.status === 'connected',
  getUserWhatsAppState: (_userId, accountId) =>
    states.get(accountId) ?? { status: 'disconnected' },
  logoutUserWhatsApp: logout,
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

async function create(name: string) {
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'whatsapp',
      name,
      credentials: { phoneNumber: '+15551234567' },
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).account;
}

describe('WhatsApp channel-account lifecycle', () => {
  test('migrates a legacy auth directory once without overwriting the destination', async () => {
    const { migrateLegacyWhatsAppAuthDir } = await import('../src/whatsapp.js');
    const source = getWhatsAppAuthDir(tmp, 'wa-owner', 'default');
    const destination = getWhatsAppAuthDir(tmp, 'wa-owner', 'immutable-id');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'creds.json'), 'legacy');
    expect(
      migrateLegacyWhatsAppAuthDir(tmp, 'wa-owner', 'default', 'immutable-id'),
    ).toBe(true);
    expect(fs.readFileSync(path.join(destination, 'creds.json'), 'utf8')).toBe(
      'legacy',
    );

    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'creds.json'), 'must-not-overwrite');
    expect(
      migrateLegacyWhatsAppAuthDir(tmp, 'wa-owner', 'default', 'immutable-id'),
    ).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'creds.json'), 'utf8')).toBe(
      'legacy',
    );
  });

  test('rejects unsafe legacy auth path segments without touching external directories', async () => {
    const { migrateLegacyWhatsAppAuthDir } = await import('../src/whatsapp.js');
    const groups = path.join(tmp, 'groups');
    fs.mkdirSync(groups, { recursive: true });
    const sentinel = path.join(groups, 'must-stay.txt');
    fs.writeFileSync(sentinel, 'safe');

    for (const unsafe of [
      '../../../../groups',
      '..\\..\\groups',
      '/tmp/absolute-auth',
      '.',
      '..',
    ]) {
      expect(
        migrateLegacyWhatsAppAuthDir(
          tmp,
          'wa-owner',
          unsafe,
          'immutable-safe-id',
        ),
      ).toBe(false);
      expect(() => getWhatsAppAuthDir(tmp, 'wa-owner', unsafe)).toThrow(
        'Invalid WhatsApp auth path segment',
      );
    }
    expect(
      migrateLegacyWhatsAppAuthDir(
        tmp,
        '../unsafe-user',
        'default',
        'immutable-safe-id',
      ),
    ).toBe(false);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('safe');
    expect(fs.existsSync(path.join(tmp, 'config', 'groups'))).toBe(false);
  });

  test('WhatsApp config accepts default/empty ids but rejects traversal ids', () => {
    expect(
      WhatsAppConfigSchema.safeParse({ accountId: 'safe_account-1' }).success,
    ).toBe(true);
    expect(WhatsAppConfigSchema.safeParse({ accountId: '' }).success).toBe(
      true,
    );
    for (const accountId of [
      '../../../../groups',
      '..\\groups',
      '/tmp/auth',
      '.',
      '..',
    ]) {
      expect(WhatsAppConfigSchema.safeParse({ accountId }).success).toBe(false);
    }
  });
  test('hard logout removes only the immutable account auth directory', async () => {
    const manager = new IMConnectionManager();
    const firstDir = getWhatsAppAuthDir(tmp, 'wa-owner', 'auth-account-a');
    const secondDir = getWhatsAppAuthDir(tmp, 'wa-owner', 'auth-account-b');
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(firstDir, 'creds.json'), 'first');
    fs.writeFileSync(path.join(secondDir, 'creds.json'), 'second');

    await manager.logoutUserWhatsApp('wa-owner', 'auth-account-a');
    expect(fs.existsSync(firstDir)).toBe(false);
    expect(fs.existsSync(secondDir)).toBe(true);
  });

  test('starting a Baileys socket is not treated as protocol authorization or connected', async () => {
    const account = await create('Awaiting QR');
    const response = await routes.request(`/${account.id}/onboarding`, {
      method: 'POST',
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(reload).toHaveBeenCalledWith(account.id);
    expect(body.account).toMatchObject({
      auth_status: 'awaiting_scan',
      transport_status: 'connecting',
      has_credentials: false,
    });
    expect(body.onboarding).toMatchObject({
      status: 'disconnected',
      auth_status: 'awaiting_scan',
      transport_status: 'connecting',
    });
    expect(body.account.transport_status).not.toBe('connected');
  });

  test('repeated onboarding reuses an active account QR session', async () => {
    const account = await create('Reuse active QR');
    reload.mockClear();
    states.set(account.id, { status: 'connecting' });

    const connecting = await routes.request(`/${account.id}/onboarding`, {
      method: 'POST',
    });
    expect(connecting.status).toBe(200);
    expect(reload).not.toHaveBeenCalled();

    states.set(account.id, {
      status: 'qr',
      qrDataUrl: 'data:image/png;base64,reused',
    });
    const qr = await routes.request(`/${account.id}/onboarding`, {
      method: 'POST',
    });
    expect(qr.status).toBe(200);
    expect(reload).not.toHaveBeenCalled();
    expect((await qr.json()) as any).toMatchObject({
      onboarding: {
        status: 'qr',
        qrDataUrl: 'data:image/png;base64,reused',
      },
    });
  });

  test('closing a CONNECTING Baileys socket contains its rejected close promise', async () => {
    const end = vi.fn();
    const close = vi.fn(async () => {
      throw new Error(
        'WebSocket was closed before the connection was established',
      );
    });

    await expect(
      closeWhatsAppSocketSafely({
        end,
        ws: { isConnecting: true, close },
      } as any),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(end).not.toHaveBeenCalled();
  });

  test('QR and connection state are isolated by immutable channel account id', async () => {
    const first = await create('WhatsApp first');
    const second = await create('WhatsApp second');
    await routes.request(`/${first.id}/onboarding`, { method: 'POST' });
    await routes.request(`/${second.id}/onboarding`, { method: 'POST' });
    states.set(first.id, {
      status: 'qr',
      qrDataUrl: 'data:image/png;base64,first-account',
    });
    states.set(second.id, {
      status: 'connected',
      meJid: 'second@s.whatsapp.net',
      meName: 'Second account',
    });

    const firstStatus = await routes.request(`/${first.id}/onboarding/status`);
    const secondStatus = await routes.request(
      `/${second.id}/onboarding/status`,
    );
    expect((await firstStatus.json()) as any).toMatchObject({
      account: {
        id: first.id,
        auth_status: 'awaiting_scan',
        transport_status: 'connecting',
      },
      onboarding: {
        status: 'qr',
        qrDataUrl: 'data:image/png;base64,first-account',
      },
    });
    expect((await secondStatus.json()) as any).toMatchObject({
      account: {
        id: second.id,
        auth_status: 'authorized',
        transport_status: 'connected',
      },
      onboarding: {
        status: 'connected',
        meJid: 'second@s.whatsapp.net',
        meName: 'Second account',
      },
    });

    const firstDir = getWhatsAppAuthDir(tmp, 'wa-owner', first.id);
    const secondDir = getWhatsAppAuthDir(tmp, 'wa-owner', second.id);
    expect(firstDir).not.toBe(secondDir);
    expect(firstDir).toContain(first.id);
    expect(secondDir).toContain(second.id);
  });

  test('logout is account-scoped, wipes authorization metadata, and keeps the sibling account', async () => {
    const first = await create('Logout first');
    const second = await create('Keep second');
    await routes.request(`/${first.id}/onboarding`, { method: 'POST' });
    await routes.request(`/${second.id}/onboarding`, { method: 'POST' });
    states.set(first.id, { status: 'connected' });
    states.set(second.id, { status: 'connected' });
    await routes.request(`/${first.id}/onboarding/status`);
    await routes.request(`/${second.id}/onboarding/status`);
    const firstRef = db.getChannelAccount(first.id)!.secret_ref;
    const secondRef = db.getChannelAccount(second.id)!.secret_ref;

    const response = await routes.request(`/${first.id}/logout`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(logout).toHaveBeenCalledWith('wa-owner', first.id);
    expect(logout).not.toHaveBeenCalledWith('wa-owner', second.id);
    expect((await response.json()) as any).toMatchObject({
      account: {
        id: first.id,
        enabled: false,
        auth_status: 'revoked',
        transport_status: 'disconnected',
        has_credentials: false,
      },
    });
    expect(secrets.loadChannelAccountSecret(firstRef)).toBeNull();
    expect(secrets.loadChannelAccountSecret(secondRef)).not.toBeNull();
    expect(db.getChannelAccount(second.id)).toMatchObject({
      auth_status: 'authorized',
      transport_status: 'connected',
    });
  });
});
