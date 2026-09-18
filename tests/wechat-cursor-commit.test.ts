import { describe, expect, test, vi } from 'vitest';
import { processWeChatUpdateBatch } from '../src/wechat.js';

describe('WeChat durable cursor commit ordering', () => {
  test('persists and advances the cursor only after every message completes', async () => {
    const events: string[] = [];
    const cursor = await processWeChatUpdateBatch({
      messages: ['one', 'two'],
      nextCursor: 'cursor-2',
      currentCursor: 'cursor-1',
      processMessage: async (message) => {
        events.push(`message:${message}`);
      },
      persistCursor: async (next) => {
        events.push(`cursor:${next}`);
      },
    });

    expect(events).toEqual(['message:one', 'message:two', 'cursor:cursor-2']);
    expect(cursor).toBe('cursor-2');
  });

  test('a crash-like partial batch leaves the old cursor for restart replay', async () => {
    const persistCursor = vi.fn();
    await expect(
      processWeChatUpdateBatch({
        messages: ['one', 'two'],
        nextCursor: 'cursor-2',
        currentCursor: 'cursor-1',
        processMessage: async (message) => {
          if (message === 'two') throw new Error('process crashed');
        },
        persistCursor,
      }),
    ).rejects.toThrow('process crashed');
    expect(persistCursor).not.toHaveBeenCalled();

    const replayed: string[] = [];
    await expect(
      processWeChatUpdateBatch({
        messages: ['one', 'two'],
        nextCursor: 'cursor-2',
        currentCursor: 'cursor-1',
        processMessage: async (message) => {
          replayed.push(message);
        },
        persistCursor,
      }),
    ).resolves.toBe('cursor-2');
    expect(replayed).toEqual(['one', 'two']);
    expect(persistCursor).toHaveBeenCalledWith('cursor-2');
  });
});
