import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

describe('conversation history transcript migration', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    mocks.getMessagesPage.mockReset();
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSessionsDir(sessionId: string, lines: object[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-history-test-'));
    tmpDirs.push(dir);
    const projects = path.join(dir, 'projects', '-workspace-group');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, `${sessionId}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n'),
    );
    return dir;
  }

  test('prefers structured transcript migration over persisted chat messages', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'user-1',
        content: '旧的聊天记录',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);
    const sessionsDir = makeSessionsDir('sess-1', [
      { type: 'user', message: { role: 'user', content: '修复登录跳转' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: '/workspace/group/src/router.ts' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: 'export const routes = []',
            },
          ],
        },
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(),
      {
        intro: '恢复上下文',
        transcript: { sessionsDir, sessionId: 'sess-1' },
      },
    );

    expect(result).not.toBeNull();
    expect(result!.source).toBe('transcript');
    expect(result!.messageIds).toEqual([]);
    expect(result!.context).toContain('<session_migration>');
    expect(result!.context).toContain('修复登录跳转');
    expect(result!.context).toContain(
      'Read(file_path="/workspace/group/src/router.ts")',
    );
    expect(result!.context).not.toContain('旧的聊天记录');
    // transcript 就绪时不应该再去读 DB。
    expect(mocks.getMessagesPage).not.toHaveBeenCalled();
  });

  test('falls back to chat messages when the transcript is missing', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'user-1',
        content: '持久化的要求',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(),
      {
        intro: '恢复上下文',
        transcript: {
          sessionsDir: path.join(os.tmpdir(), 'does-not-exist-dir'),
        },
      },
    );

    expect(result).not.toBeNull();
    expect(result!.source).toBe('messages');
    expect(result!.context).toContain('持久化的要求');
  });

  test('falls back with a length budget instead of a fixed message count', () => {
    // 100 条短消息：旧实现只取 30 条，新实现按预算尽量多取。
    mocks.getMessagesPage.mockReturnValue(
      Array.from({ length: 100 }, (_, i) => ({
        id: `m-${i}`,
        content: `消息 ${i}`,
        sender_name: 'Alice',
        is_from_me: false,
      })),
    );

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(),
      {
        intro: '恢复上下文',
        messageFetchLimit: 200,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.count).toBeGreaterThan(30);
    expect(result!.context).toContain('消息 99');
  });

  test('keeps the fallback context within the configured budget', () => {
    mocks.getMessagesPage.mockReturnValue(
      Array.from({ length: 200 }, (_, i) => ({
        id: `m-${i}`,
        content: `消息 ${i} `.repeat(200),
        sender_name: 'Alice',
        is_from_me: false,
      })),
    );

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(),
      {
        intro: '恢复上下文',
        maxChars: 8000,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.context.length).toBeLessThanOrEqual(8000);
  });
});
