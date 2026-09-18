import { describe, expect, test, vi } from 'vitest';
import { readFeishuResourceBuffer } from '../src/feishu.js';

describe('Feishu resource download budget', () => {
  test('destroys and rejects a resource stream that exceeds its hard deadline', async () => {
    vi.useFakeTimers();
    try {
      const destroy = vi.fn();
      const stream = {
        destroy,
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {});
        },
      };
      const pending = readFeishuResourceBuffer(stream, {
        timeoutMs: 25,
        resourceLabel: 'slow image',
      });
      const rejection = expect(pending).rejects.toThrow(
        'slow image timed out after 25ms',
      );

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('enforces the byte budget while reading resource chunks', async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(4);
        yield Buffer.alloc(5);
      },
    };

    await expect(
      readFeishuResourceBuffer(stream, {
        maxBytes: 8,
        resourceLabel: 'oversized image',
      }),
    ).rejects.toThrow('oversized image');
  });
});
