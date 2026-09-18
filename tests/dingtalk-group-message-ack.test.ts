import { describe, expect, test } from 'vitest';

import { parseDingTalkGroupMessageResponse } from '../src/dingtalk.js';

describe('DingTalk persistent group message strict ACK', () => {
  test('rejects HTTP failures', () => {
    expect(() =>
      parseDingTalkGroupMessageResponse(
        503,
        JSON.stringify({ code: 'ServiceUnavailable', message: 'retry' }),
      ),
    ).toThrow('HTTP failed (503)');
  });

  test.each(['', '<html>ok</html>', '{broken'])(
    'rejects malformed 2xx response %j',
    (body) => {
      expect(() => parseDingTalkGroupMessageResponse(200, body)).toThrow();
    },
  );

  test('rejects a code/message API error on HTTP 200', () => {
    expect(() =>
      parseDingTalkGroupMessageResponse(
        200,
        JSON.stringify({ code: 'InvalidParameter', message: 'bad robot' }),
      ),
    ).toThrow('InvalidParameter');
  });

  test.each([
    { processQueryKey: 'query-1' },
    { errcode: 0, errmsg: 'ok' },
    { code: 'Success', message: 'ok' },
  ])('accepts a recognized success envelope %#', (response) => {
    expect(
      parseDingTalkGroupMessageResponse(200, JSON.stringify(response)),
    ).toEqual(response);
  });
});
