import { Agent, EnvHttpProxyAgent, type Dispatcher } from 'undici';

export function configuredWeChatHttpProxy(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  );
}

export function isWeChatConnectTimeout(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const code = String(value.code ?? '');
    const message = String(value.message ?? '').toLowerCase();
    if (
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'ETIMEDOUT' ||
      message.includes('connect timeout')
    ) {
      return true;
    }
    current = value.cause;
  }
  return false;
}

/**
 * Build an account-local dispatcher without changing process-wide proxy state.
 * "Direct" still respects OS-level routing such as Clash TUN and VPNs.
 */
export function createWeChatHttpDispatcher(bypassProxy: boolean): Dispatcher {
  if (bypassProxy) return new Agent();
  if (!configuredWeChatHttpProxy()) {
    throw new Error(
      '微信账号已配置为使用 HTTP(S) 代理，但 CommerceAgent 启动环境中未设置 HTTPS_PROXY 或 HTTP_PROXY',
    );
  }
  return new EnvHttpProxyAgent({ noProxy: '' });
}
