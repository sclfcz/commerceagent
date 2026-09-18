import type { ChannelAccount } from './types.js';
import type { ChannelAccountSecret } from './channel-account-secrets.js';
import { testFeishuCredentials } from './feishu-connectivity.js';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import {
  configuredWeChatHttpProxy,
  createWeChatHttpDispatcher,
  isWeChatConnectTimeout,
} from './wechat-http.js';

export interface ChannelAccountCredentialTestResult {
  success: boolean;
  unsupported?: boolean;
  error?: string;
}

export async function testChannelAccountCredentials(
  account: ChannelAccount,
  secret: ChannelAccountSecret,
): Promise<ChannelAccountCredentialTestResult> {
  if (account.provider === 'feishu') {
    const result = await testFeishuCredentials(
      secret.appId || '',
      secret.appSecret || '',
    );
    return result.ok
      ? { success: true }
      : {
          success: false,
          error: result.errorMessage || 'Credential test failed',
        };
  }
  if (account.provider === 'telegram') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const dispatcher = secret.proxyUrl
      ? new ProxyAgent(secret.proxyUrl)
      : undefined;
    try {
      const response = await undiciFetch(
        `https://api.telegram.org/bot${encodeURIComponent(secret.botToken || '')}/getMe`,
        { signal: controller.signal, dispatcher },
      );
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
      };
      return body.ok
        ? { success: true }
        : {
            success: false,
            error: body.description || `Telegram HTTP ${response.status}`,
          };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
      await dispatcher?.close();
    }
  }

  if (account.provider === 'qq') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            appId: secret.appId || '',
            clientSecret: secret.appSecret || '',
          }),
          signal: controller.signal,
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        access_token?: string;
        message?: string;
      };
      return body.access_token
        ? { success: true }
        : {
            success: false,
            error: body.message || `QQ HTTP ${response.status}`,
          };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (account.provider === 'wechat') {
    const bypassProxy = secret.bypassProxy !== 'false';
    const configuredProxy = configuredWeChatHttpProxy();
    if (!bypassProxy && !configuredProxy) {
      return {
        success: false,
        error:
          '当前账号要求使用 HTTP(S) 代理，但 CommerceAgent 启动环境中没有配置 HTTPS_PROXY 或 HTTP_PROXY',
      };
    }

    const dispatcher = createWeChatHttpDispatcher(bypassProxy);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // The iLink root intentionally returns 404. Any HTTP response proves
      // DNS, TCP and TLS are working without consuming the long-poll cursor.
      const response = await undiciFetch(
        secret.baseUrl || 'https://ilinkai.weixin.qq.com',
        { signal: controller.signal, dispatcher },
      );
      return {
        success: response.status > 0,
        ...(response.status > 0
          ? {}
          : { error: '微信服务没有返回有效 HTTP 响应' }),
      };
    } catch (error) {
      return {
        success: false,
        error: isWeChatConnectTimeout(error)
          ? '连接微信服务超时，请检查 Clash TUN、VPN 或代理规则'
          : `无法访问微信服务：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      clearTimeout(timer);
      await dispatcher.close();
    }
  }

  if (account.provider === 'dingtalk') {
    try {
      const { DWClient } = await import('dingtalk-stream');
      const client = new DWClient({
        clientId: secret.clientId || '',
        clientSecret: secret.clientSecret || '',
      });
      try {
        const token = await client.getAccessToken();
        return token
          ? { success: true }
          : { success: false, error: 'Failed to obtain DingTalk access token' };
      } finally {
        client.disconnect?.();
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (account.provider === 'discord') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { authorization: `Bot ${secret.botToken || ''}` },
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        message?: string;
      };
      return response.ok && body.id
        ? { success: true }
        : {
            success: false,
            error: body.message || `Discord HTTP ${response.status}`,
          };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    success: false,
    unsupported: true,
    error: '该渠道暂不支持独立凭证测试，请保存后查看连接状态',
  };
}
