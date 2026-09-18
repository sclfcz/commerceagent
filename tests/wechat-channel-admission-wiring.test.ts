import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { IMChannelConnectOpts } from '../src/im-channel.js';
import type { WeChatConnectOpts } from '../src/wechat.js';

const capture = vi.hoisted(() => ({
  connectOpts: null as WeChatConnectOpts | null,
}));

vi.mock('../src/wechat.js', () => ({
  createWeChatConnection: () => ({
    async connect(opts: WeChatConnectOpts) {
      capture.connectOpts = opts;
    },
    async disconnect() {},
    async sendMessage() {},
    async sendImage() {},
    async sendFile() {},
    async sendTyping() {},
    isRunning: () => true,
    isConnected: () => true,
    getUpdatesBuf: () => '',
  }),
}));

const { createWeChatChannel } = await import('../src/im-channel.js');
const { IMConnectionManager } = await import('../src/im-manager.js');

describe('WeChat admission and lifecycle wiring', () => {
  beforeEach(() => {
    capture.connectOpts = null;
  });

  test('adapter forwards authorization, pairing, and connection state callbacks', async () => {
    const isChatAuthorized = vi.fn(() => true);
    const onPairAttempt = vi.fn(async () => true);
    const onConnectionStateChange = vi.fn();
    const opts: IMChannelConnectOpts = {
      onReady: vi.fn(),
      onNewChat: vi.fn(),
      isChatAuthorized,
      onPairAttempt,
      onWeChatConnectionStateChange: onConnectionStateChange,
    };
    const channel = createWeChatChannel({
      botToken: 'token',
      ilinkBotId: 'bot',
    });

    await expect(channel.connect(opts)).resolves.toBe(true);

    expect(capture.connectOpts?.isChatAuthorized).toBe(isChatAuthorized);
    expect(capture.connectOpts?.onPairAttempt).toBe(onPairAttempt);
    expect(capture.connectOpts?.onConnectionStateChange).toBe(
      onConnectionStateChange,
    );
  });

  test('manager account-scopes WeChat admission callbacks and forwards expiry', async () => {
    const manager = new IMConnectionManager();
    const isChatAuthorized = vi.fn(() => true);
    const onPairAttempt = vi.fn(async () => true);
    const onConnectionStateChange = vi.fn();

    await manager.connectUserWeChat(
      'owner',
      { botToken: 'token', ilinkBotId: 'bot' },
      vi.fn(),
      {
        accountId: 'wechat-account',
        scopeIncomingJids: true,
        isChatAuthorized,
        onPairAttempt,
        onConnectionStateChange,
      },
    );

    expect(capture.connectOpts?.isChatAuthorized?.('wechat:contact')).toBe(
      true,
    );
    expect(isChatAuthorized).toHaveBeenCalledWith(
      'wechat:contact#account:wechat-account',
    );
    await capture.connectOpts?.onPairAttempt?.(
      'wechat:contact',
      'Contact',
      'PAIR-CODE',
    );
    expect(onPairAttempt).toHaveBeenCalledWith(
      'wechat:contact#account:wechat-account',
      'Contact',
      'PAIR-CODE',
    );

    capture.connectOpts?.onConnectionStateChange?.({
      status: 'expired',
      error: 'errcode -14',
    });
    expect(onConnectionStateChange).toHaveBeenCalledWith({
      status: 'expired',
      error: 'errcode -14',
    });
    await manager.disconnectAll();
  });

  test('one iLink bot identity cannot be polled by two accounts', async () => {
    const manager = new IMConnectionManager();
    await expect(
      manager.connectUserWeChat(
        'owner-a',
        { botToken: 'token-a', ilinkBotId: 'same-ilink-bot' },
        vi.fn(),
        { accountId: 'wechat-account-a' },
      ),
    ).resolves.toBe(true);

    await expect(
      manager.connectUserWeChat(
        'owner-b',
        { botToken: 'token-b', ilinkBotId: 'same-ilink-bot' },
        vi.fn(),
        { accountId: 'wechat-account-b' },
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectAll();
  });
});
