import { describe, expect, test } from 'vitest';
import {
  buildNativeThreadRouteJid,
  resolveNativeThreadContext,
  summarizeNativeThreadTitle,
} from '../src/channel-native-context.js';

describe('provider-native context routing', () => {
  test('normalizes canonical Telegram topic metadata', () => {
    expect(
      resolveNativeThreadContext({
        provider: 'telegram',
        nativeContextType: 'thread',
        contextId: '42',
        messageId: '100',
        text: 'Topic title\nmore detail',
      }),
    ).toEqual({
      contextId: '42',
      rootMessageId: '42',
      title: 'Topic title',
    });
  });

  test('continues to accept legacy Feishu thread fields', () => {
    expect(
      resolveNativeThreadContext({
        threadId: 'thread-a',
        rootId: 'root-a',
        text: '飞书话题',
      }),
    ).toEqual({
      contextId: 'thread-a',
      rootMessageId: 'root-a',
      title: '飞书话题',
    });
  });

  test('thread route preserves provider and account scope', () => {
    expect(
      buildNativeThreadRouteJid('telegram:-1001#account:bot-a', '42', '42'),
    ).toBe('telegram:-1001#account:bot-a#thread:42#root:42');
  });

  test('title summarization is bounded and single-line', () => {
    const title = summarizeNativeThreadTitle(`  first   line  \nsecond`);
    expect(title).toBe('first line');
    expect(summarizeNativeThreadTitle('x'.repeat(100))).toHaveLength(48);
  });
});
