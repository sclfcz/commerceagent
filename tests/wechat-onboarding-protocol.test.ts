import { describe, expect, test, vi } from 'vitest';
import type { fetch as undiciFetch } from 'undici';
import {
  encodeWeChatClientVersion,
  pollWeChatQrOnboarding,
  resolveWeChatRedirectBaseUrl,
  startWeChatQrOnboarding,
} from '../src/wechat-onboarding.js';

describe('WeChat iLink onboarding protocol', () => {
  test('uses Tencent iLink identity headers and account-local token list', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({ qrcode: 'qr-id', qrcode_img_content: 'weixin://qr' }),
    );
    const started = await startWeChatQrOnboarding(
      { localTokenList: [' token-a ', 'token-a', 'token-b'] },
      { fetch: fetchMock as unknown as typeof undiciFetch },
    );

    expect(started.qrcode).toBe('qr-id');
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(encodeWeChatClientVersion('1.0.0')),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      local_token_list: ['token-a', 'token-b'],
    });
  });

  test.each([
    'scaned_but_redirect',
    'need_verifycode',
    'verify_code_blocked',
    'binded_redirect',
  ] as const)(
    'preserves QR state %s for the route state machine',
    async (status) => {
      const fetchMock = vi.fn(async () =>
        Response.json({ status, redirect_host: 'ilinkai.weixin.qq.com' }),
      );
      await expect(
        pollWeChatQrOnboarding(
          'qr-id',
          { verifyCode: '1234' },
          { fetch: fetchMock as unknown as typeof undiciFetch },
        ),
      ).resolves.toMatchObject({
        status,
        ...(status === 'binded_redirect' ? { alreadyConnected: true } : {}),
      });
      expect(String(fetchMock.mock.calls[0][0])).toContain('verify_code=1234');
    },
  );

  test('allows only Tencent HTTPS IDC redirect hosts', () => {
    expect(resolveWeChatRedirectBaseUrl('ilinkai.weixin.qq.com')).toBe(
      'https://ilinkai.weixin.qq.com',
    );
    expect(resolveWeChatRedirectBaseUrl('evil.example')).toBeUndefined();
    expect(
      resolveWeChatRedirectBaseUrl('ilinkai.weixin.qq.com@evil.example'),
    ).toBeUndefined();
  });
});
