import { describe, expect, test } from 'vitest';
import {
  channelAddressKey,
  extractProviderTarget,
  parseChannelAddress,
  scopeChannelJid,
  toProviderJid,
} from '../src/channel-address.js';

describe('account-scoped channel address', () => {
  test('legacy JIDs remain parseable', () => {
    expect(parseChannelAddress('telegram:-10001')).toMatchObject({
      provider: 'telegram',
      externalChatId: '-10001',
      channelAccountId: null,
      legacy: true,
    });
    expect(toProviderJid('telegram:-10001')).toBe('telegram:-10001');
  });

  test('account scope preserves Feishu thread routing', () => {
    const scoped = scopeChannelJid(
      'feishu:oc_same#thread:omt_1#root:om_1',
      'bot-a',
    );
    expect(scoped).toBe('feishu:oc_same#account:bot-a#thread:omt_1#root:om_1');
    expect(parseChannelAddress(scoped)).toMatchObject({
      channelAccountId: 'bot-a',
      externalChatId: 'oc_same',
      threadId: 'omt_1',
      rootMessageId: 'om_1',
    });
    expect(extractProviderTarget(scoped)).toBe(
      'oc_same#thread:omt_1#root:om_1',
    );
  });

  test('same external chat is isolated by account and thread', () => {
    expect(
      channelAddressKey({
        provider: 'feishu',
        channelAccountId: 'bot-a',
        externalChatId: 'same',
        threadId: 't1',
      }),
    ).not.toBe(
      channelAddressKey({
        provider: 'feishu',
        channelAccountId: 'bot-b',
        externalChatId: 'same',
        threadId: 't1',
      }),
    );
  });

  test('account IDs are safely encoded', () => {
    const scoped = scopeChannelJid('telegram:42', 'bot/北京');
    expect(parseChannelAddress(scoped)?.channelAccountId).toBe('bot/北京');
    expect(extractProviderTarget(scoped)).toBe('42');
  });
});
