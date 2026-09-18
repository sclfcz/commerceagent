import { describe, expect, test } from 'vitest';

import {
  redactLogMessage,
  sanitizeLogObject,
  serializeErrorForLog,
} from '../src/logger.js';

describe('serializeErrorForLog', () => {
  test('keeps Feishu diagnostics without serializing Axios request secrets', () => {
    const authorization = 'Bearer tenant-token-that-must-not-leak';
    const cookie = 'session=secret-cookie-value';
    const error = Object.assign(
      new Error('Request failed with status code 500'),
      {
        name: 'AxiosError',
        code: 'ERR_BAD_RESPONSE',
        config: {
          headers: {
            Authorization: authorization,
            Cookie: cookie,
          },
          data: '{"sensitive":"request body"}',
        },
        request: {
          _header: `POST /open-apis/im/v1/messages HTTP/1.1\r\nAuthorization: ${authorization}\r\nCookie: ${cookie}`,
        },
        response: {
          status: 500,
          headers: {
            'x-tt-logid': '20260728210207BF1A58D78E23EFE6794B',
            'set-cookie': cookie,
          },
          data: {
            code: 2200,
            msg: 'Internal Error',
            error: {
              log_id: '20260728210207BF1A58D78E23EFE6794B',
              request_dump: authorization,
            },
          },
          request: {
            _header: `Authorization: ${authorization}`,
          },
        },
      },
    );

    const serialized = serializeErrorForLog(error);
    const output = JSON.stringify(serialized);

    expect(serialized).toMatchObject({
      name: 'AxiosError',
      message: 'Request failed with status code 500',
      code: 'ERR_BAD_RESPONSE',
      status: 500,
      feishuCode: 2200,
      feishuMessage: 'Internal Error',
      feishuLogId: '20260728210207BF1A58D78E23EFE6794B',
    });
    expect(output).not.toContain('tenant-token-that-must-not-leak');
    expect(output).not.toContain('secret-cookie-value');
    expect(output).not.toContain('Authorization');
    expect(output).not.toContain('_header');
    expect(output).not.toContain('request body');
    expect(output).not.toContain('request_dump');
  });

  test('redacts credentials embedded in error and provider messages', () => {
    const serialized = serializeErrorForLog({
      name: 'AxiosError',
      message:
        'authorization=Bearer abcdefghijklmnop cookie=session-secret sk-abcdefghijklmnop',
      response: {
        status: 401,
        data: {
          code: 99991663,
          msg: 'token: tenant-secret-value',
          error: { log_id: 'safe-log-id' },
        },
      },
    });
    const output = JSON.stringify(serialized);

    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('session-secret');
    expect(output).not.toContain('tenant-secret-value');
    expect(serialized).toMatchObject({
      status: 401,
      feishuCode: 99991663,
      feishuLogId: 'safe-log-id',
    });
  });

  test('handles primitive and hostile thrown values without throwing', () => {
    const hostile = Object.defineProperty({}, 'message', {
      get() {
        throw new Error('getter failure');
      },
    });

    expect(serializeErrorForLog('Bearer abcdefghijklmnop')).toEqual({
      message: 'Bearer [REDACTED]',
    });
    expect(serializeErrorForLog(hostile)).toEqual({
      message: 'Unknown error',
    });
  });
});

describe('sanitizeLogObject', () => {
  test('sanitizes arbitrary nested error fields, causes and raw headers', () => {
    const secret = 'tenant-token-that-must-not-leak';
    const nestedError = Object.assign(new Error(`Bearer ${secret}`), {
      request: {
        _header: `Authorization: Bearer ${secret}`,
      },
    });
    const circular: Record<string, unknown> = {
      sendErr: nestedError,
      context: {
        headers: { AUTHORIZATION: `Bearer ${secret}` },
        cause: [{ access_token: secret }],
      },
    };
    circular.self = circular;

    const output = JSON.stringify(sanitizeLogObject(circular));

    expect(output).toContain('[REDACTED]');
    expect(output).toContain('[Circular]');
    expect(output).not.toContain(secret);
    expect(output).not.toContain('_header');
  });
});

describe('redactLogMessage', () => {
  test('redacts Authorization schemes, credential assignments and URL passwords', () => {
    const output = redactLogMessage(
      'Bearer abcdefghijklmnop api_key=secret-value https://user:password@example.com/path',
    );

    expect(output).toContain('Bearer [REDACTED]');
    expect(output).toContain('api_key=[REDACTED]');
    expect(output).toContain('https://user:[REDACTED]@example.com/path');
    expect(output).not.toContain('abcdefghijklmnop');
    expect(output).not.toContain('secret-value');
    expect(output).not.toContain('password@example.com');
  });
});
