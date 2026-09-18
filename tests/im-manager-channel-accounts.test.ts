import { describe, expect, test, vi } from 'vitest';
import { IMConnectionManager } from '../src/im-manager.js';
import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';

function fakeChannel(
  type: string,
  fail = false,
  connectImpl?: () => Promise<boolean>,
  disconnectImpl?: () => Promise<void>,
) {
  let connected = false;
  let opts: IMChannelConnectOpts | null = null;
  const connect = vi.fn(async (value: IMChannelConnectOpts) => {
    opts = value;
    if (fail) throw new Error('isolated failure');
    const result = connectImpl ? await connectImpl() : true;
    connected = result;
    return result;
  });
  const disconnect = vi.fn(async () => {
    if (disconnectImpl) await disconnectImpl();
    connected = false;
  });
  const channel: IMChannel = {
    channelType: type,
    connect,
    disconnect,
    async sendMessage() {},
    async setTyping() {},
    isConnected: () => connected,
  };
  return { channel, connect, disconnect, getOpts: () => opts };
}

const callbacks = (onNewChat = vi.fn()): IMChannelConnectOpts => ({
  onReady: vi.fn(),
  onNewChat,
});

describe('IM manager account lifecycle', () => {
  test('shutdown pause and startup recovery both defer durable inbound before policy callbacks', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeChannel('feishu');
    await manager.connectChannel(
      'defer-owner',
      'feishu',
      feishu.channel,
      callbacks(),
      'defer-account',
    );
    const opts = feishu.getOpts()!;
    expect(opts.shouldDeferInbound?.()).toBe(false);

    manager.pauseInbound();
    expect(opts.shouldDeferInbound?.()).toBe(true);
    manager.resumeInbound();
    expect(opts.shouldDeferInbound?.()).toBe(false);

    manager.deferInbound();
    expect(opts.shouldDeferInbound?.()).toBe(true);
    manager.resumeDeferredInbound();
    expect(opts.shouldDeferInbound?.()).toBe(false);
    await manager.disconnectAll();
  });

  test('manual Feishu discovery syncs every connected bot including a legacy connector', async () => {
    const manager = new IMConnectionManager();
    const legacy = fakeChannel('feishu');
    const secondary = fakeChannel('feishu');
    let releaseLegacy!: () => void;
    const legacyGate = new Promise<void>((resolve) => {
      releaseLegacy = resolve;
    });
    const legacySync = vi.fn(() => legacyGate);
    const secondarySync = vi.fn().mockResolvedValue(undefined);
    legacy.channel.syncGroups = legacySync;
    secondary.channel.syncGroups = secondarySync;

    await manager.connectChannel(
      'sync-owner',
      'feishu',
      legacy.channel,
      callbacks(),
    );
    await manager.connectChannel(
      'sync-owner',
      'feishu',
      secondary.channel,
      callbacks(),
      'secondary-account',
    );

    const firstSync = manager.syncAllFeishuGroups('sync-owner');
    const duplicateSync = manager.syncAllFeishuGroups('sync-owner');
    await vi.waitFor(() => expect(legacySync).toHaveBeenCalledTimes(1));
    releaseLegacy();
    await expect(Promise.all([firstSync, duplicateSync])).resolves.toEqual([
      2, 2,
    ]);
    expect(legacySync).toHaveBeenCalledTimes(1);
    expect(secondarySync).toHaveBeenCalledTimes(1);
    await manager.disconnectAll();
  });

  test('Feishu and DingTalk wrappers forward their public credential identities', async () => {
    const manager = new IMConnectionManager();
    const connect = vi.spyOn(manager, 'connectChannel').mockResolvedValue(true);

    await manager.connectUserFeishu(
      'feishu-owner',
      { appId: 'feishu-app-id', appSecret: 'feishu-secret' },
      vi.fn(),
      { accountId: 'feishu-account', scopeIncomingJids: true },
    );
    expect(connect.mock.calls[0]?.[1]).toBe('feishu');
    expect(connect.mock.calls[0]?.[4]).toBe('feishu-account');
    expect(connect.mock.calls[0]?.[6]).toBe('feishu-app-id');

    await manager.connectUserDingTalk(
      'dingtalk-owner',
      { clientId: 'dingtalk-client-id', clientSecret: 'dingtalk-secret' },
      vi.fn(),
      { accountId: 'dingtalk-account', scopeIncomingJids: true },
    );
    expect(connect.mock.calls[1]?.[1]).toBe('dingtalk');
    expect(connect.mock.calls[1]?.[4]).toBe('dingtalk-account');
    expect(connect.mock.calls[1]?.[6]).toBe('dingtalk-client-id');
  });

  test.each([
    ['feishu', 'shared-feishu-app'],
    ['dingtalk', 'shared-dingtalk-client'],
  ])(
    'concurrent %s connectors cannot claim the same credential',
    async (provider, credential) => {
      const manager = new IMConnectionManager();
      let finishFirst!: (connected: boolean) => void;
      const firstGate = new Promise<boolean>((resolve) => {
        finishFirst = resolve;
      });
      const first = fakeChannel(provider, false, () => firstGate);
      const second = fakeChannel(provider);

      const firstConnect = manager.connectChannel(
        'first-owner',
        provider,
        first.channel,
        callbacks(),
        'first-account',
        true,
        credential,
      );
      await vi.waitFor(() => expect(first.connect).toHaveBeenCalledTimes(1));

      await expect(
        manager.connectChannel(
          'second-owner',
          provider,
          second.channel,
          callbacks(),
          'second-account',
          true,
          credential,
        ),
      ).rejects.toThrow('already connected by another channel account');
      expect(second.connect).not.toHaveBeenCalled();

      finishFirst(true);
      await expect(firstConnect).resolves.toBe(true);
      await manager.disconnectChannelAccount(
        'first-owner',
        provider,
        'first-account',
      );
      await expect(
        manager.connectChannel(
          'second-owner',
          provider,
          second.channel,
          callbacks(),
          'second-account',
          true,
          credential,
        ),
      ).resolves.toBe(true);
      await manager.disconnectAll();
    },
  );

  test.each([
    ['feishu', true, undefined],
    ['dingtalk', false, async () => false],
  ])(
    '%s connection failure releases its credential claim',
    async (provider, throws, connectImpl) => {
      const manager = new IMConnectionManager();
      const broken = fakeChannel(provider, throws, connectImpl);
      const retry = fakeChannel(provider);
      const attempt = manager.connectChannel(
        'broken-owner',
        provider,
        broken.channel,
        callbacks(),
        'broken-account',
        true,
        'reusable-credential',
      );
      if (throws) {
        await expect(attempt).rejects.toThrow('isolated failure');
      } else {
        await expect(attempt).resolves.toBe(false);
      }
      expect(broken.disconnect).toHaveBeenCalledTimes(1);
      await expect(
        manager.connectChannel(
          'retry-owner',
          provider,
          retry.channel,
          callbacks(),
          'retry-account',
          true,
          'reusable-credential',
        ),
      ).resolves.toBe(true);
      await manager.disconnectAll();
    },
  );

  test('legacy Feishu disconnect releases the appId for a projected default account', async () => {
    const manager = new IMConnectionManager();
    const legacy = fakeChannel('feishu');
    const projectedDefault = fakeChannel('feishu');
    await manager.connectChannel(
      'legacy-owner',
      'feishu',
      legacy.channel,
      callbacks(),
      undefined,
      false,
      'legacy-feishu-app',
    );
    await expect(
      manager.connectChannel(
        'legacy-owner',
        'feishu',
        projectedDefault.channel,
        callbacks(),
        'projected-default',
        false,
        'legacy-feishu-app',
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectUserFeishu('legacy-owner');
    await expect(
      manager.connectChannel(
        'legacy-owner',
        'feishu',
        projectedDefault.channel,
        callbacks(),
        'projected-default',
        false,
        'legacy-feishu-app',
      ),
    ).resolves.toBe(true);
    await manager.disconnectAll();
  });

  test('disconnectAll releases claims before the manager is reused', async () => {
    const manager = new IMConnectionManager();
    await manager.connectChannel(
      'first-owner',
      'dingtalk',
      fakeChannel('dingtalk').channel,
      callbacks(),
      'first-account',
      true,
      'reconnectable-client',
    );
    await manager.disconnectAll();
    await expect(
      manager.connectChannel(
        'second-owner',
        'dingtalk',
        fakeChannel('dingtalk').channel,
        callbacks(),
        'second-account',
        true,
        'reconnectable-client',
      ),
    ).resolves.toBe(true);
    await manager.disconnectAll();
  });

  test('disconnectAll keeps failed connectors and claims tracked until a successful retry', async () => {
    const manager = new IMConnectionManager();
    let disconnectAttempts = 0;
    const flaky = fakeChannel('dingtalk', false, undefined, async () => {
      disconnectAttempts += 1;
      if (disconnectAttempts === 1) throw new Error('temporary stop failure');
    });
    await manager.connectChannel(
      'first-owner',
      'dingtalk',
      flaky.channel,
      callbacks(),
      'first-account',
      true,
      'retryable-client',
    );

    await manager.disconnectAll();
    await expect(
      manager.connectChannel(
        'second-owner',
        'dingtalk',
        fakeChannel('dingtalk').channel,
        callbacks(),
        'second-account',
        true,
        'retryable-client',
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectAll();
    await expect(
      manager.connectChannel(
        'second-owner',
        'dingtalk',
        fakeChannel('dingtalk').channel,
        callbacks(),
        'second-account',
        true,
        'retryable-client',
      ),
    ).resolves.toBe(true);
    await manager.disconnectAll();
  });

  test('failed initial cleanup stays tracked and blocks duplicate credential reuse', async () => {
    const manager = new IMConnectionManager();
    let disconnectAttempts = 0;
    const ghostRisk = fakeChannel(
      'qq',
      false,
      async () => false,
      async () => {
        disconnectAttempts += 1;
        if (disconnectAttempts === 1) throw new Error('cleanup failed');
      },
    );
    await expect(
      manager.connectChannel(
        'first-owner',
        'qq',
        ghostRisk.channel,
        callbacks(),
        'first-account',
        true,
        'same-app-id',
      ),
    ).resolves.toBe(false);
    await expect(
      manager.connectChannel(
        'second-owner',
        'qq',
        fakeChannel('qq').channel,
        callbacks(),
        'second-account',
        true,
        'same-app-id',
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectAll();
    await expect(
      manager.connectChannel(
        'second-owner',
        'qq',
        fakeChannel('qq').channel,
        callbacks(),
        'second-account',
        true,
        'same-app-id',
      ),
    ).resolves.toBe(true);
    await manager.disconnectAll();
  });

  test('one provider credential cannot own two live account connectors', async () => {
    const manager = new IMConnectionManager();
    const first = fakeChannel('discord');
    const second = fakeChannel('discord');
    await manager.connectChannel(
      'user-a',
      'discord',
      first.channel,
      callbacks(),
      'bot-a',
      true,
      'same-token',
    );
    await expect(
      manager.connectChannel(
        'user-b',
        'discord',
        second.channel,
        callbacks(),
        'bot-b',
        true,
        'same-token',
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectChannelAccount('user-a', 'discord', 'bot-a');
    await expect(
      manager.connectChannel(
        'user-b',
        'discord',
        second.channel,
        callbacks(),
        'bot-b',
        true,
        'same-token',
      ),
    ).resolves.toBe(true);
    await manager.disconnectAll();
  });

  test('same provider supports concurrent accounts and scopes inbound JIDs', async () => {
    const manager = new IMConnectionManager();
    const first = fakeChannel('telegram');
    const second = fakeChannel('telegram');
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    await manager.connectChannel(
      'user-a',
      'telegram',
      first.channel,
      callbacks(onFirst),
      'bot-a',
    );
    await manager.connectChannel(
      'user-a',
      'telegram',
      second.channel,
      callbacks(onSecond),
      'bot-b',
    );

    first.getOpts()!.onNewChat('telegram:shared', 'Shared');
    second.getOpts()!.onNewChat('telegram:shared', 'Shared');
    expect(onFirst).toHaveBeenCalledWith(
      'telegram:shared#account:bot-a',
      'Shared',
    );
    expect(onSecond).toHaveBeenCalledWith(
      'telegram:shared#account:bot-b',
      'Shared',
    );
    expect(manager.getConnectedChannelAccountIds('user-a', 'telegram')).toEqual(
      ['bot-a', 'bot-b'],
    );

    await manager.disconnectChannelAccount('user-a', 'telegram', 'bot-a');
    expect(
      manager.isChannelAccountConnected('user-a', 'telegram', 'bot-a'),
    ).toBe(false);
    expect(
      manager.isChannelAccountConnected('user-a', 'telegram', 'bot-b'),
    ).toBe(true);
    await manager.disconnectAll();
  });

  test('pauseInbound rejects account-scoped callbacks while keeping the transport connected', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeChannel('feishu');
    const onNewChat = vi.fn();
    const onMessage = vi.fn();
    const onAgentMessage = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('ok');
    const resolveEffectiveChatJid = vi.fn().mockReturnValue({
      effectiveJid: 'web:workspace#agent:session',
      agentId: 'session',
    });

    await manager.connectChannel(
      'pause-owner',
      'feishu',
      feishu.channel,
      {
        onReady: vi.fn(),
        onNewChat,
        onMessage,
        onAgentMessage,
        onCommand,
        isChatAuthorized: () => true,
        resolveEffectiveChatJid,
      },
      'bot-a',
    );
    const wrapped = feishu.getOpts()!;
    manager.pauseInbound();

    wrapped.onNewChat('feishu:chat', 'Chat');
    wrapped.onMessage?.('feishu:chat', 'hello', 'sender');
    wrapped.onAgentMessage?.('feishu:chat', 'session');
    await expect(
      wrapped.onCommand?.('feishu:chat', '/status', 'sender'),
    ).resolves.toBeNull();
    expect(wrapped.isChatAuthorized?.('feishu:chat')).toBe(false);
    expect(() => wrapped.resolveEffectiveChatJid?.('feishu:chat')).toThrow(
      'Channel binding resolver rejected route',
    );
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onAgentMessage).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(feishu.channel.isConnected()).toBe(true);

    manager.resumeInbound();
    wrapped.onMessage?.('feishu:chat', 'after resume', 'sender');
    expect(onMessage).toHaveBeenCalledWith(
      'feishu:chat#account:bot-a',
      'after resume',
      'sender',
    );
    await manager.disconnectAll();
  });

  test('one account connection failure does not disconnect another account', async () => {
    const manager = new IMConnectionManager();
    const healthy = fakeChannel('feishu');
    const broken = fakeChannel('feishu', true);
    await manager.connectChannel(
      'user-b',
      'feishu',
      healthy.channel,
      callbacks(),
      'healthy',
    );
    await expect(
      manager.connectChannel(
        'user-b',
        'feishu',
        broken.channel,
        callbacks(),
        'broken',
      ),
    ).rejects.toThrow('isolated failure');
    expect(
      manager.isChannelAccountConnected('user-b', 'feishu', 'healthy'),
    ).toBe(true);
    await manager.disconnectAll();
  });

  test('projected legacy default keeps the old canonical JID', async () => {
    const manager = new IMConnectionManager();
    const legacy = fakeChannel('feishu');
    const onNewChat = vi.fn();
    await manager.connectChannel(
      'legacy-owner',
      'feishu',
      legacy.channel,
      callbacks(onNewChat),
      'projected-default',
      false,
    );
    legacy.getOpts()!.onNewChat('feishu:existing-chat', 'Existing');
    expect(onNewChat).toHaveBeenCalledWith('feishu:existing-chat', 'Existing');
    await manager.disconnectAll();
  });

  test('configured binding resolver rejects null for scoped and legacy connectors', async () => {
    const manager = new IMConnectionManager();
    const scoped = fakeChannel('discord');
    const legacy = fakeChannel('feishu');
    const rejecting = {
      ...callbacks(),
      resolveEffectiveChatJid: () => null,
    };
    await manager.connectChannel(
      'route-owner',
      'discord',
      scoped.channel,
      rejecting,
      'bot-a',
    );
    await manager.connectChannel(
      'route-owner',
      'feishu',
      legacy.channel,
      rejecting,
    );

    expect(() =>
      scoped.getOpts()!.resolveEffectiveChatJid!('discord:source'),
    ).toThrow(
      'Channel binding resolver rejected route for discord:source#account:bot-a',
    );
    expect(() =>
      legacy.getOpts()!.resolveEffectiveChatJid!('feishu:source'),
    ).toThrow('Channel binding resolver rejected route for feishu:source');
    await manager.disconnectAll();
  });

  test('scopes explicit source routes without replacing connector-native fallbacks', async () => {
    const manager = new IMConnectionManager();
    const channel = fakeChannel('feishu');
    const resolver = vi
      .fn()
      .mockReturnValueOnce({
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
        sourceJid: 'feishu:chat#thread:topic-1#root:message-1',
      })
      .mockReturnValueOnce({
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
      });
    await manager.connectChannel(
      'route-owner',
      'feishu',
      channel.channel,
      { ...callbacks(), resolveEffectiveChatJid: resolver },
      'bot-a',
    );

    const scopedResolver = channel.getOpts()!.resolveEffectiveChatJid!;
    expect(scopedResolver('feishu:chat')).toEqual({
      effectiveJid: 'web:workspace#agent:session',
      agentId: 'session',
      sourceJid: 'feishu:chat#account:bot-a#thread:topic-1#root:message-1',
    });
    expect(resolver).toHaveBeenNthCalledWith(
      1,
      'feishu:chat#account:bot-a',
      undefined,
    );

    const fallbackRoute = scopedResolver('feishu:chat');
    expect(fallbackRoute).toEqual({
      effectiveJid: 'web:workspace#agent:session',
      agentId: 'session',
    });
    expect(fallbackRoute).not.toHaveProperty('sourceJid');

    await manager.disconnectAll();
  });
});
