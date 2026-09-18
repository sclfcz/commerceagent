import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import {
  mergeChannelAccount,
  useChannelAccountsStore,
  type ChannelAccount,
} from '../web/src/stores/channel-accounts';
import {
  buildChannelAccountFilterOptions,
  buildChannelAccountPayload,
  CHANNEL_PROVIDER_OPTIONS,
  channelAccountKey,
  mergeWhatsAppOnboardingState,
  providerDefinition,
  supportsChannelConnectionTest,
  validateChannelAccountForm,
} from '../web/src/utils/channel-accounts';
import {
  buildMcpSecretClear,
  buildMcpSecretReplacement,
} from '../web/src/utils/mcp-secrets';

const account = (overrides: Partial<ChannelAccount> = {}): ChannelAccount => ({
  id: 'account-1',
  owner_user_id: 'user-1',
  provider: 'feishu',
  name: '客服 Bot',
  enabled: true,
  is_default: false,
  status: 'connected',
  default_workspace_jid: null,
  last_error: null,
  connected_at: '2026-07-14T00:00:00.000Z',
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  has_credentials: true,
  ...overrides,
});

describe('channel account frontend behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChannelAccountsStore.setState({
      accounts: [],
      loading: false,
      error: null,
    });
  });

  test('posts the complete create payload and stores the returned account', async () => {
    vi.mocked(api.post).mockResolvedValue({ account: account() });
    const input = {
      provider: 'feishu' as const,
      name: '客服 Bot',
      enabled: true,
      is_default: true,
      default_workspace_jid: null,
      credentials: { appId: 'cli_x', appSecret: 'secret' },
    };

    await useChannelAccountsStore.getState().createAccount(input);

    expect(api.post).toHaveBeenCalledWith('/api/channel-accounts', input);
    expect(useChannelAccountsStore.getState().accounts).toEqual([account()]);
  });

  test('making one account default clears the previous default in local state', () => {
    const previous = account({ id: 'old', is_default: true });
    const next = account({ id: 'new', is_default: true, name: '新 Bot' });

    expect(mergeChannelAccount([previous], next)).toEqual([
      expect.objectContaining({ id: 'new', is_default: true }),
      expect.objectContaining({ id: 'old', is_default: false }),
    ]);
  });

  test('editing metadata preserves credentials unless replacement is explicit', () => {
    const base = {
      provider: 'telegram' as const,
      name: ' 通知 Bot ',
      enabled: true,
      isDefault: false,
      defaultWorkspaceJid: 'web:workspace',
      credentials: { botToken: ' must-not-send ' },
      replaceCredentials: false,
    };

    expect(buildChannelAccountPayload(base, 'edit')).toEqual({
      name: '通知 Bot',
      enabled: true,
      is_default: false,
      default_workspace_jid: 'web:workspace',
    });
    expect(
      buildChannelAccountPayload({ ...base, replaceCredentials: true }, 'edit'),
    ).toMatchObject({ credentials: { botToken: 'must-not-send' } });
  });

  test('exposes connection tests when a provider has a non-destructive probe', () => {
    expect(supportsChannelConnectionTest('feishu')).toBe(true);
    expect(supportsChannelConnectionTest('telegram')).toBe(true);
    expect(supportsChannelConnectionTest('qq')).toBe(true);
    expect(supportsChannelConnectionTest('wechat')).toBe(true);
    expect(supportsChannelConnectionTest('dingtalk')).toBe(true);
    expect(supportsChannelConnectionTest('discord')).toBe(true);
    expect(supportsChannelConnectionTest('whatsapp')).toBe(false);
  });

  test('models WeChat and WhatsApp as QR sessions without editable protocol output', () => {
    const wechat = providerDefinition('wechat');
    const whatsapp = providerDefinition('whatsapp');

    expect(wechat.authMode).toBe('qr_session');
    expect(wechat.credentials).toEqual([]);
    expect(whatsapp.authMode).toBe('qr_session');
    expect(whatsapp.credentials).toEqual([]);
    expect(JSON.stringify([wechat, whatsapp])).not.toMatch(
      /botToken|ilinkBotId|baseUrl|accountId|phoneNumber/,
    );
  });

  test('gives every channel an actionable protocol-specific setup guide', () => {
    expect(CHANNEL_PROVIDER_OPTIONS).toHaveLength(7);
    for (const provider of CHANNEL_PROVIDER_OPTIONS) {
      expect(provider.setupGuide.title.length).toBeGreaterThan(0);
      expect(provider.setupGuide.steps.length).toBeGreaterThanOrEqual(3);
      expect(provider.setupGuide.nextStep.length).toBeGreaterThan(0);
    }

    expect(providerDefinition('feishu').setupGuide.action?.url).toBe(
      'https://open.feishu.cn/app',
    );
    expect(providerDefinition('telegram').setupGuide.action?.url).toBe(
      'https://t.me/BotFather',
    );
    expect(providerDefinition('qq').setupGuide.action?.url).toBe(
      'https://q.qq.com/qqbot/openclaw/index.html',
    );
    expect(providerDefinition('dingtalk').setupGuide.action?.url).toBe(
      'https://open-dev.dingtalk.com/fe/app',
    );
    expect(providerDefinition('discord').setupGuide.action?.url).toBe(
      'https://discord.com/developers/applications',
    );
    expect(providerDefinition('wechat').setupGuide.action).toBeUndefined();
    expect(providerDefinition('whatsapp').setupGuide.action).toBeUndefined();
  });

  test('explains credential meaning instead of relying on ambiguous field names', () => {
    const fields = CHANNEL_PROVIDER_OPTIONS.flatMap(
      (provider) => provider.credentials,
    );
    expect(
      fields.filter((field) => field.required).every((field) => field.help),
    ).toBe(true);
    expect(providerDefinition('qq').credentials[0].help).toContain(
      '不是 QQ 号',
    );
    expect(providerDefinition('discord').credentials[0].help).toContain(
      '不是 Client Secret',
    );
  });

  test('keeps Feishu owner discovery backend-only', () => {
    const feishu = providerDefinition('feishu');
    expect(feishu.credentials.map((field) => field.key)).toEqual([
      'appId',
      'appSecret',
    ]);
    expect(JSON.stringify(feishu)).not.toContain('ownerOpenId');
  });

  test('downgrades every WhatsApp socket state without retaining false online or stale QR', () => {
    const connected = {
      auth_mode: 'qr_session' as const,
      auth_status: 'authorized' as const,
      transport_status: 'connected' as const,
      status: 'connected' as const,
      qrDataUrl: 'data:image/png;base64,stale',
    };

    expect(
      mergeWhatsAppOnboardingState(connected, { status: 'disconnected' }),
    ).toMatchObject({
      auth_status: 'authorized',
      transport_status: 'disconnected',
      qrDataUrl: undefined,
    });
    expect(
      mergeWhatsAppOnboardingState(connected, { status: 'logged_out' }),
    ).toMatchObject({
      auth_status: 'revoked',
      transport_status: 'disconnected',
      qrDataUrl: undefined,
    });
    expect(
      mergeWhatsAppOnboardingState(connected, {
        status: 'error',
        error: 'socket closed',
      }),
    ).toMatchObject({
      auth_status: 'authorized',
      transport_status: 'error',
      error: 'socket closed',
      qrDataUrl: undefined,
    });
    expect(
      mergeWhatsAppOnboardingState(connected, {
        status: 'qr',
        qrDataUrl: 'data:image/png;base64,new',
      }),
    ).toMatchObject({
      auth_status: 'awaiting_scan',
      transport_status: 'disconnected',
      qrDataUrl: 'data:image/png;base64,new',
    });
  });

  test('allows creating a QR draft without credentials and retains protocol options', () => {
    const values = {
      provider: 'wechat' as const,
      name: ' 我的微信 ',
      enabled: true,
      isDefault: false,
      defaultWorkspaceJid: 'none',
      credentials: { bypassProxy: 'true' },
      replaceCredentials: true,
    };

    expect(validateChannelAccountForm(values, 'create')).toBeNull();
    expect(buildChannelAccountPayload(values, 'create')).toEqual({
      provider: 'wechat',
      name: '我的微信',
      enabled: true,
      is_default: false,
      default_workspace_jid: null,
      credentials: { bypassProxy: 'true' },
    });
  });

  test('calls account-scoped QR onboarding endpoints and merges returned state', async () => {
    const next = account({
      provider: 'whatsapp',
      auth_mode: 'qr_session',
      auth_status: 'awaiting_scan',
      transport_status: 'disconnected',
      status: 'disconnected',
      has_credentials: false,
    });
    const result = {
      account: next,
      onboarding: {
        auth_mode: 'qr_session' as const,
        auth_status: 'awaiting_scan' as const,
        transport_status: 'disconnected' as const,
        status: 'qr' as const,
        qrDataUrl: 'data:image/png;base64,test',
      },
    };
    vi.mocked(api.post).mockResolvedValue(result);

    await useChannelAccountsStore.getState().beginOnboarding('account-1');

    expect(api.post).toHaveBeenCalledWith(
      '/api/channel-accounts/account-1/onboarding',
      {},
    );
    expect(useChannelAccountsStore.getState().accounts).toEqual([next]);
  });

  test('applies an account-scoped reconnect event without touching siblings', () => {
    const target = account({
      id: 'wechat-a',
      provider: 'wechat',
      transport_status: 'connected',
    });
    const sibling = account({ id: 'wechat-b', provider: 'wechat' });
    useChannelAccountsStore.setState({ accounts: [target, sibling] });

    useChannelAccountsStore.getState().applyStatusEvent({
      accountId: 'wechat-a',
      transportStatus: 'reconnecting',
      lastError: '连接微信服务超时，CommerceAgent 正在自动重试',
    });

    expect(useChannelAccountsStore.getState().accounts).toEqual([
      expect.objectContaining({
        id: 'wechat-a',
        status: 'reconnecting',
        transport_status: 'reconnecting',
        last_error: '连接微信服务超时，CommerceAgent 正在自动重试',
      }),
      sibling,
    ]);
  });

  test('keeps account-scoped channel choices distinct and preserves legacy default', () => {
    const channels = [
      { channel_account_id: 'bot-a', channel_account_name: '客服 Bot' },
      { channel_account_id: 'bot-b', channel_account_name: '通知 Bot' },
      { channel_account_id: null, channel_account_name: null },
    ];
    expect(buildChannelAccountFilterOptions(channels)).toEqual([
      { id: 'bot-a', name: '客服 Bot' },
      { id: 'bot-b', name: '通知 Bot' },
      { id: 'legacy-default', name: '默认账号（旧版）' },
    ]);
    expect(channelAccountKey(channels[2])).toBe('legacy-default');
  });

  test('MCP secret edits distinguish retain, replace, and explicit clear', () => {
    expect(buildMcpSecretReplacement('env', null)).toEqual({});
    expect(
      buildMcpSecretReplacement('env', [
        { key: ' API_KEY ', value: 'new-value' },
      ]),
    ).toEqual({ env: { API_KEY: 'new-value' } });
    expect(buildMcpSecretClear('env')).toEqual({ env: null });
    expect(buildMcpSecretClear('headers')).toEqual({ headers: null });
  });
});
