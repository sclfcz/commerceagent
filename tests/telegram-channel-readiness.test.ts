import { beforeEach, describe, expect, test, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  getMeError: null as Error | null,
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => {
        if (controls.getMeError) throw controls.getMeError;
        return { id: 1, username: 'ready_bot' };
      }),
    };
    on() {
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        controls.stop = resolve;
      });
    }
    stop() {
      controls.stop?.();
      controls.stop = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createTelegramChannel } = await import('../src/im-channel.js');

const options = {
  onReady: vi.fn(),
  onNewChat: vi.fn(),
};

describe('Telegram transport readiness', () => {
  beforeEach(() => {
    controls.getMeError = null;
    controls.stop = null;
    options.onReady.mockClear();
  });

  test('returns false and remains disconnected when token validation fails', async () => {
    controls.getMeError = new Error('401 Unauthorized');
    const channel = createTelegramChannel({ botToken: 'invalid' });
    expect(await channel.connect(options)).toBe(false);
    expect(channel.isConnected()).toBe(false);
    expect(options.onReady).not.toHaveBeenCalled();
  });

  test('returns connected only after grammY onStart fires', async () => {
    const channel = createTelegramChannel({ botToken: 'valid' });
    expect(await channel.connect(options)).toBe(true);
    expect(channel.isConnected()).toBe(true);
    expect(options.onReady).toHaveBeenCalledOnce();
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });
});
