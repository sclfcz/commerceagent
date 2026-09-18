import type { Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({ logger: log }));

const {
  classifyWeChatConnectionError,
  createWeChatConnection,
  jitteredWeChatRetryDelay,
} = await import('../src/wechat.js');

function connectTimeoutError() {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    }),
  });
}

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    signal?.addEventListener('abort', rejectAbort, { once: true });
  });
}

describe('WeChat connection lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('classifies nested undici errors and jitters retry delays', () => {
    expect(classifyWeChatConnectionError(connectTimeoutError())).toBe(
      'connect_timeout',
    );
    expect(jitteredWeChatRetryDelay(3000, () => 0)).toBe(2400);
    expect(jitteredWeChatRetryDelay(3000, () => 0.5)).toBe(3000);
    expect(jitteredWeChatRetryDelay(3000, () => 1)).toBe(3600);
  });

  test('publishes reconnecting, recovers, and aborts cleanly on shutdown', async () => {
    const states: Array<Record<string, unknown>> = [];
    const close = vi.fn(async () => undefined);
    const dispatcher = { close } as unknown as Dispatcher;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectTimeoutError())
      .mockResolvedValueOnce(
        Response.json({ get_updates_buf: 'cursor-1', msgs: [] }),
      )
      .mockImplementationOnce(
        (_url: string, init?: { signal?: AbortSignal | null }) =>
          waitUntilAborted(init?.signal),
      );
    const connection = createWeChatConnection(
      {
        botToken: 'secret-token',
        ilinkBotId: 'bot-identity@example',
        logContext: { accountId: 'wechat-a', userId: 'owner-a' },
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => dispatcher,
        random: () => 0.5,
        now: () => Date.now(),
      },
    );

    await connection.connect({
      onNewChat: vi.fn(),
      onConnectionStateChange: (state) => states.push(state),
    });
    expect(connection.isRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)).toMatchObject({
      status: 'reconnecting',
      errorCode: 'connect_timeout',
      consecutiveFailures: 1,
      nextRetryMs: 3000,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'wechat-a',
        userId: 'owner-a',
        errorCode: 'connect_timeout',
      }),
      'WeChat poll connection unavailable; retry scheduled',
    );

    await vi.advanceTimersByTimeAsync(3000);
    expect(states.at(-1)).toMatchObject({ status: 'connected' });
    expect(connection.isConnected()).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'wechat-a',
        recoveredFailures: 1,
      }),
      'WeChat poll connection recovered',
    );

    await connection.disconnect();
    expect(connection.isRunning()).toBe(false);
    expect(connection.isConnected()).toBe(false);
    expect(states.at(-1)).toMatchObject({ status: 'disconnected' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('treats errcode -14 as expired and releases the HTTP dispatcher', async () => {
    const states: Array<Record<string, unknown>> = [];
    const close = vi.fn(async () => undefined);
    const connection = createWeChatConnection(
      { botToken: 'secret-token', ilinkBotId: 'expired-bot@example' },
      {
        fetch: vi.fn(async () =>
          Response.json({ errcode: -14 }),
        ) as typeof fetch,
        createDispatcher: () => ({ close }) as unknown as Dispatcher,
      },
    );

    await connection.connect({
      onNewChat: vi.fn(),
      onConnectionStateChange: (state) => states.push(state),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(states.at(-1)).toEqual({
      status: 'expired',
      error: '微信授权已过期，请重新扫码连接',
    });
    expect(connection.isRunning()).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
