import { describe, expect, test, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import {
  ChannelRouteRejectedError,
  evaluateChannelAdmission,
  matchesChannelAccountAuthorization,
  matchesChannelPairTarget,
  parseChannelPairingCode,
  resolveAdmittedChannelRoute,
} from '../src/channel-admission.js';
import { isUnsupportedDiscordGroupDm } from '../src/discord.js';
import { assertWhatsAppSocketConnected } from '../src/whatsapp.js';

describe('channel admission', () => {
  test('parses only a complete /pair command', () => {
    expect(parseChannelPairingCode('/pair abc123')).toBe('abc123');
    expect(parseChannelPairingCode(' /PAIR ABC123 ')).toBe('ABC123');
    expect(parseChannelPairingCode('/pair')).toBeNull();
    expect(parseChannelPairingCode('/pair one extra')).toBeNull();
    expect(parseChannelPairingCode('hello /pair abc123')).toBeNull();
  });

  test('denies an unpaired chat without calling registration', async () => {
    const onPairAttempt = vi.fn();
    await expect(
      evaluateChannelAdmission({
        jid: 'discord:dm:user#account:bot',
        chatName: 'User',
        text: 'hello',
        isChatAuthorized: () => false,
        onPairAttempt,
      }),
    ).resolves.toEqual({ kind: 'deny' });
    expect(onPairAttempt).not.toHaveBeenCalled();
  });

  test('consumes pairing before normal authorization', async () => {
    const onPairAttempt = vi.fn(async () => true);
    await expect(
      evaluateChannelAdmission({
        jid: 'whatsapp:1@s.whatsapp.net#account:bot',
        chatName: 'User',
        text: '/pair a1b2c3',
        isChatAuthorized: () => false,
        onPairAttempt,
      }),
    ).resolves.toEqual({ kind: 'paired' });
    expect(onPairAttempt).toHaveBeenCalledWith(
      'whatsapp:1@s.whatsapp.net#account:bot',
      'User',
      'a1b2c3',
    );
  });

  test('keeps legacy channels open only when no authorization callback exists', async () => {
    await expect(
      evaluateChannelAdmission({
        jid: 'legacy:chat',
        chatName: 'Legacy',
        text: 'hello',
      }),
    ).resolves.toEqual({ kind: 'allow' });
  });

  test('configured route resolver is authoritative and fails closed', () => {
    expect(resolveAdmittedChannelRoute('discord:source')).toEqual({
      targetJid: 'discord:source',
      routing: null,
    });
    expect(
      resolveAdmittedChannelRoute('discord:source', () => null),
    ).toBeNull();
    expect(
      resolveAdmittedChannelRoute('discord:source', () => ({
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
      })),
    ).toEqual({
      targetJid: 'web:workspace#agent:session',
      routing: {
        effectiveJid: 'web:workspace#agent:session',
        agentId: 'session',
      },
    });
  });

  // Regression (2026-08-04): im-manager wraps a channel's resolveEffectiveChatJid
  // per-account and throws ChannelRouteRejectedError instead of returning null
  // for an unbound/unauthorized chat. Every channel calls this function
  // directly with that wrapped resolver and branches on `!resolvedRoute` —
  // if the throw isn't translated to null here, it escapes past that branch
  // entirely and falls into whatever generic outer catch happens to wrap the
  // caller (misleading "intake failed" logs, and in Feishu's P2P bootstrap
  // path, skipped registration side effects — see feishu.ts commit fc828b4).
  test('translates a wrapped resolver rejection into the same null contract as a direct null return', () => {
    expect(
      resolveAdmittedChannelRoute('discord:source', () => {
        throw new ChannelRouteRejectedError('discord:source');
      }),
    ).toBeNull();
  });

  test('does not swallow errors unrelated to route rejection', () => {
    expect(() =>
      resolveAdmittedChannelRoute('discord:source', () => {
        throw new Error('database unavailable');
      }),
    ).toThrow('database unavailable');
  });

  test('passes native context metadata to an authoritative resolver', () => {
    const resolver = vi.fn(() => ({
      effectiveJid: 'web:workspace',
      agentId: null,
    }));
    const context = { nativeContextType: 'thread', contextId: '42' };
    expect(
      resolveAdmittedChannelRoute(
        'telegram:group#thread:42',
        resolver,
        context,
      ),
    ).toMatchObject({ targetJid: 'web:workspace' });
    expect(resolver).toHaveBeenCalledWith('telegram:group#thread:42', context);
  });

  test('rejects stale ownership rows and isolates two bots sharing one external chat id', () => {
    const base = {
      groupOwnerUserId: 'user-a',
      groupAccountId: 'bot-a',
      userId: 'user-a',
      expectedAccountOwnerUserId: 'user-a',
      allowLegacyUnscoped: false,
    };
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(true);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-b',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        groupAccountId: 'stale-bot',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelAccountAuthorization({
        ...base,
        scopedAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
        expectedAccountOwnerUserId: 'user-b',
      }),
    ).toBe(false);
  });

  test('pairing cannot overwrite another account binding', () => {
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-a',
        existingGroupAccountId: 'bot-a',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(true);
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-b',
        existingGroupAccountId: 'bot-b',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
    expect(
      matchesChannelPairTarget({
        scopedAccountId: 'bot-a',
        existingGroupAccountId: 'stale-bot',
        expectedAccountId: 'bot-a',
      }),
    ).toBe(false);
  });
});

describe('provider safety contracts', () => {
  test('Discord ignores GroupDM but accepts regular DM and guild channels', () => {
    expect(isUnsupportedDiscordGroupDm(ChannelType.GroupDM)).toBe(true);
    expect(isUnsupportedDiscordGroupDm(ChannelType.DM)).toBe(false);
    expect(isUnsupportedDiscordGroupDm(ChannelType.GuildText)).toBe(false);
  });

  test('WhatsApp outbound requires an actually connected socket', () => {
    expect(() =>
      assertWhatsAppSocketConnected(null, { status: 'disconnected' }),
    ).toThrow('WhatsApp socket is not connected');
    expect(() =>
      assertWhatsAppSocketConnected({} as never, { status: 'connecting' }),
    ).toThrow('WhatsApp socket is not connected');
    expect(() =>
      assertWhatsAppSocketConnected({} as never, { status: 'connected' }),
    ).not.toThrow();
  });
});
