import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-onboarding-'));
const qr = vi.hoisted(() => ({
  next: 0,
  states: new Map<string, Record<string, unknown> | Error>(),
  pollOptions: [] as Array<Record<string, unknown> | undefined>,
}));

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
      id: 'wechat-owner',
      username: 'owner',
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/wechat-onboarding.js', () => ({
  startWeChatQrOnboarding: vi.fn(async () => {
    qr.next += 1;
    return {
      qrcode: `qr-${qr.next}`,
      qrcodeUrl: `data:image/png;base64,qr-${qr.next}`,
    };
  }),
  pollWeChatQrOnboarding: vi.fn(
    async (code: string, options?: Record<string, unknown>) => {
      qr.pollOptions.push(options);
      const state = qr.states.get(code);
      if (state instanceof Error) throw state;
      return state ?? { status: 'wait' };
    },
  ),
  resolveWeChatRedirectBaseUrl: vi.fn((host?: string) => {
    if (!host?.endsWith('.qq.com')) return undefined;
    return `https://${host}`;
  }),
}));

const db = await import('../src/db.js');
const secrets = await import('../src/channel-account-secrets.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
const reload = vi.fn(async () => true);
const disconnect = vi.fn(async () => undefined);
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: reload,
  disconnectChannelAccount: disconnect,
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

async function createWeChat(name: string) {
  const response = await routes.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'wechat', name, credentials: {} }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as any).account;
}

describe('account-bound WeChat QR onboarding', () => {
  test('reuses an active QR and submits a verification code to the same session', async () => {
    const account = await createWeChat('Verify QR');
    const beforeStart = qr.next;
    const first = await routes.request(`/${account.id}/onboarding`, {
      method: 'POST',
    });
    const second = await routes.request(`/${account.id}/onboarding`, {
      method: 'POST',
    });
    expect(qr.next).toBe(beforeStart + 1);
    expect((await first.json()) as any).toMatchObject({
      onboarding: { qrcodeUrl: `data:image/png;base64,qr-${qr.next}` },
    });
    expect((await second.json()) as any).toMatchObject({
      onboarding: { qrcodeUrl: `data:image/png;base64,qr-${qr.next}` },
    });

    const code = `qr-${qr.next}`;
    qr.states.set(code, { status: 'need_verifycode' });
    const challenge = await routes.request(`/${account.id}/onboarding/status`);
    expect((await challenge.json()) as any).toMatchObject({
      onboarding: { status: 'need_verifycode', needsVerifyCode: true },
    });

    const verified = await routes.request(`/${account.id}/onboarding/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verifyCode: '2468' }),
    });
    expect(verified.status).toBe(200);
    qr.states.set(code, {
      status: 'confirmed',
      botToken: 'verified-token',
      ilinkBotId: 'verified-bot',
    });
    const confirmed = await routes.request(`/${account.id}/onboarding/status`);
    expect((await confirmed.json()) as any).toMatchObject({
      account: { auth_status: 'authorized', has_credentials: true },
    });
    expect(qr.pollOptions.at(-1)).toMatchObject({ verifyCode: '2468' });
  });

  test('keeps QR and confirmation state isolated per account', async () => {
    const first = await createWeChat('WeChat first');
    const second = await createWeChat('WeChat second');
    const beforeStart = qr.next;

    const firstStart = await routes.request(`/${first.id}/onboarding`, {
      method: 'POST',
    });
    const secondStart = await routes.request(`/${second.id}/onboarding`, {
      method: 'POST',
    });
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);
    const firstStartBody = (await firstStart.json()) as any;
    const secondStartBody = (await secondStart.json()) as any;
    expect(firstStartBody.onboarding).toMatchObject({
      auth_status: 'awaiting_scan',
      qrcodeUrl: `data:image/png;base64,qr-${beforeStart + 1}`,
    });
    expect(secondStartBody.onboarding).toMatchObject({
      auth_status: 'awaiting_scan',
      qrcodeUrl: `data:image/png;base64,qr-${beforeStart + 2}`,
    });

    qr.states.set(`qr-${beforeStart + 1}`, {
      status: 'confirmed',
      botToken: 'wechat-token-first',
      ilinkBotId: 'wechat-bot-first',
      baseUrl: 'https://wechat-first.invalid',
    });
    qr.states.set(`qr-${beforeStart + 2}`, { status: 'wait' });

    const confirmed = await routes.request(`/${first.id}/onboarding/status`);
    const waiting = await routes.request(`/${second.id}/onboarding/status`);
    const confirmedBody = (await confirmed.json()) as any;
    const waitingBody = (await waiting.json()) as any;
    expect(confirmedBody.account).toMatchObject({
      id: first.id,
      auth_status: 'authorized',
      has_credentials: true,
    });
    expect(waitingBody.account).toMatchObject({
      id: second.id,
      auth_status: 'awaiting_scan',
      has_credentials: false,
    });
    expect(JSON.stringify(confirmedBody)).not.toContain('wechat-token-first');
    expect(JSON.stringify(confirmedBody)).not.toContain('wechat-bot-first');

    expect(
      secrets.loadChannelAccountSecret(
        db.getChannelAccount(first.id)!.secret_ref,
      ),
    ).toMatchObject({
      botToken: 'wechat-token-first',
      ilinkBotId: 'wechat-bot-first',
      baseUrl: 'https://wechat-first.invalid',
    });
    expect(
      secrets.loadChannelAccountSecret(
        db.getChannelAccount(second.id)!.secret_ref,
      ),
    ).not.toHaveProperty('botToken');
    expect(reload).toHaveBeenCalledWith(first.id);
    expect(reload).not.toHaveBeenCalledWith(second.id);
  });

  test('logout revokes only the selected account and removes its QR credentials', async () => {
    const first = await createWeChat('Logout selected');
    const second = await createWeChat('Logout untouched');
    await routes.request(`/${first.id}/onboarding`, { method: 'POST' });
    await routes.request(`/${second.id}/onboarding`, { method: 'POST' });

    qr.states.set(`qr-${qr.next - 1}`, {
      status: 'confirmed',
      botToken: 'logout-me',
      ilinkBotId: 'logout-bot',
    });
    await routes.request(`/${first.id}/onboarding/status`);
    const firstRef = db.getChannelAccount(first.id)!.secret_ref;
    const secondRef = db.getChannelAccount(second.id)!.secret_ref;

    const response = await routes.request(`/${first.id}/logout`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
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
    expect(disconnect).toHaveBeenCalledWith(first.id);

    const untouched = await routes.request(`/${second.id}/onboarding/status`);
    expect((await untouched.json()) as any).toMatchObject({
      account: { id: second.id, auth_status: 'awaiting_scan' },
    });
  });

  test('disabling cancels a pending QR and prevents a later confirmation', async () => {
    const account = await createWeChat('Disable pending');
    await routes.request(`/${account.id}/onboarding`, { method: 'POST' });
    const code = `qr-${qr.next}`;
    const disabled = await routes.request(`/${account.id}/toggle`, {
      method: 'POST',
    });
    expect((await disabled.json()) as any).toMatchObject({
      account: { enabled: false, auth_status: 'draft' },
    });
    qr.states.set(code, {
      status: 'confirmed',
      botToken: 'must-not-save',
      ilinkBotId: 'must-not-save',
    });
    const status = await routes.request(`/${account.id}/onboarding/status`);
    expect((await status.json()) as any).toMatchObject({
      account: { enabled: false, auth_status: 'draft', has_credentials: false },
    });
    expect(
      secrets.loadChannelAccountSecret(
        db.getChannelAccount(account.id)!.secret_ref,
      ),
    ).not.toHaveProperty('botToken');
  });

  test('keeps a pending QR retryable after a transient polling error', async () => {
    const account = await createWeChat('Retry pending');
    await routes.request(`/${account.id}/onboarding`, { method: 'POST' });
    const code = `qr-${qr.next}`;
    qr.states.set(code, new Error('temporary upstream failure'));
    expect(
      (await routes.request(`/${account.id}/onboarding/status`)).status,
    ).toBe(502);
    expect(db.getChannelAccount(account.id)).toMatchObject({
      auth_status: 'awaiting_scan',
    });
    qr.states.set(code, {
      status: 'confirmed',
      botToken: 'retry-token',
      ilinkBotId: 'retry-bot',
    });
    const retried = await routes.request(`/${account.id}/onboarding/status`);
    expect((await retried.json()) as any).toMatchObject({
      account: { auth_status: 'authorized', has_credentials: true },
    });
  });
});
