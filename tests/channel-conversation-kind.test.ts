import { describe, expect, test } from 'vitest';
import {
  conversationBindingPolicyError,
  resolveChannelConversationKind,
} from '../src/channel-conversation-kind.js';

describe('resolveChannelConversationKind', () => {
  test.each([
    ['qq:c2c:user', 'direct'],
    ['qq:group:team', 'group'],
    ['dingtalk:c2c:user', 'direct'],
    ['dingtalk:cid-group', 'group'],
    ['discord:dm:123', 'direct'],
    ['discord:456', 'group'],
    ['whatsapp:123@s.whatsapp.net', 'direct'],
    ['whatsapp:123@g.us', 'group'],
    ['wechat:wxid_user', 'direct'],
    ['telegram:123#account:bot-a#thread:1', 'direct'],
    ['telegram:-100123#account:bot-a', 'group'],
  ])('classifies %s as %s', (jid, expected) => {
    expect(resolveChannelConversationKind(jid)).toBe(expected);
  });

  test('uses Feishu metadata because its opaque JID does not encode chat type', () => {
    expect(
      resolveChannelConversationKind('feishu:oc_same', { chat_mode: 'p2p' }),
    ).toBe('direct');
    expect(
      resolveChannelConversationKind('feishu:oc_same', {
        feishu_chat_mode: 'group',
      }),
    ).toBe('group');
    expect(resolveChannelConversationKind('feishu:oc_same')).toBe('unknown');
  });

  test('fails closed for malformed and unsupported JIDs', () => {
    expect(resolveChannelConversationKind('telegram:not-a-number')).toBe(
      'unknown',
    );
    expect(resolveChannelConversationKind('web:main')).toBe('unknown');
  });
});

describe('conversationBindingPolicyError', () => {
  test('only allows group -> workspace and direct -> session', () => {
    expect(conversationBindingPolicyError('group', 'workspace')).toBeNull();
    expect(conversationBindingPolicyError('direct', 'session')).toBeNull();
    expect(conversationBindingPolicyError('direct', 'workspace')).toMatch(
      /only accept group chats/,
    );
    expect(conversationBindingPolicyError('group', 'session')).toMatch(
      /only accept direct chats/,
    );
  });

  test('rejects unknown chats for both target types', () => {
    expect(conversationBindingPolicyError('unknown', 'workspace')).toMatch(
      /Unable to determine/,
    );
    expect(conversationBindingPolicyError('unknown', 'session')).toMatch(
      /Unable to determine/,
    );
  });
});
