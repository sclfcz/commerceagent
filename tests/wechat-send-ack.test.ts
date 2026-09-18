import { describe, expect, test } from 'vitest';

import {
  assertWeChatApiSuccess,
  parseWeChatApiResponse,
} from '../src/wechat.js';

describe('WeChat strict outbound acknowledgement', () => {
  test.each([
    ['sendMessage', { errcode: 40013, errmsg: 'invalid appid' }, 'errcode'],
    ['sendImage', { ret: -14, errmsg: 'session expired' }, 'ret'],
    [
      'sendFile',
      { base_resp: { ret: 5, errmsg: 'upload rejected' } },
      'base_resp.ret',
    ],
  ])('%s rejects API-level failures', (operation, response, codeName) => {
    expect(() => assertWeChatApiSuccess(response, operation)).toThrow(
      `${operation} failed: ${codeName}=`,
    );
  });

  test('accepts omitted and explicit zero success codes', () => {
    expect(() => assertWeChatApiSuccess({}, 'sendMessage')).not.toThrow();
    expect(() =>
      assertWeChatApiSuccess({ ret: 0, errcode: '0', code: 0 }, 'sendMessage'),
    ).not.toThrow();
  });

  test('HTTP failure is rejected before a JSON body can look successful', async () => {
    const response = new Response(JSON.stringify({ ret: 0 }), {
      status: 502,
      statusText: 'Bad Gateway',
    });
    await expect(
      parseWeChatApiResponse(response, 'ilink/bot/sendmessage'),
    ).rejects.toThrow('HTTP 502');
  });
});
