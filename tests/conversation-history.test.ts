import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMessagesPage: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getMessagesPage: mocks.getMessagesPage,
}));

const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');

describe('conversation history recovery context', () => {
  beforeEach(() => {
    mocks.getMessagesPage.mockReset();
  });

  test('returns stable message IDs and tags every recovered turn', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'assistant-1',
        content: '收到',
        sender_name: 'CommerceAgent',
        is_from_me: true,
      },
      {
        id: 'user-1',
        content: '原始任务',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main#agent:agent-1',
      new Set(),
      { intro: '恢复上下文' },
    );

    expect(result?.messageIds).toEqual(['user-1', 'assistant-1']);
    expect(result?.context).toContain(
      '<history_message id="user-1" role="user" sender="Alice">原始任务</history_message>',
    );
    expect(result?.context).toContain(
      '<history_message id="assistant-1" role="assistant" sender="CommerceAgent">收到</history_message>',
    );
  });

  test('excludes the pending turn from both context and known IDs', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'pending-1',
        content: '当前消息',
        sender_name: 'Alice',
        is_from_me: false,
      },
      {
        id: 'history-1',
        content: '历史消息',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(['pending-1']),
      { intro: '恢复上下文' },
    );

    expect(result?.messageIds).toEqual(['history-1']);
    expect(result?.context).not.toContain('id="pending-1"');
  });
});
