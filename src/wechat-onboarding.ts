import QRCode from 'qrcode';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { createWeChatHttpDispatcher } from './wechat-http.js';

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_QR_BOT_TYPE = '3';
const WECHAT_ILINK_APP_ID = 'bot';
const COMMERCEAGENT_CHANNEL_VERSION = '1.0.0';

export type WeChatQrStatusValue =
  | 'wait'
  | 'scaned'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'
  | 'confirmed'
  | 'expired';

export interface WeChatQrStart {
  qrcode: string;
  qrcodeUrl: string;
}

export interface WeChatQrStatus {
  status: WeChatQrStatusValue;
  botToken?: string;
  ilinkBotId?: string;
  baseUrl?: string;
  redirectHost?: string;
  alreadyConnected?: boolean;
}

export interface WeChatQrStartOptions {
  /** Existing token for this account only. Never include another user's token. */
  localTokenList?: string[];
  /** Bypass CommerceAgent's HTTP(S) proxy for this account. */
  bypassProxy?: boolean;
}

export interface WeChatQrPollOptions {
  /** Redirected iLink API base returned by scaned_but_redirect. */
  baseUrl?: string;
  /** Number shown by the WeChat client for second-factor verification. */
  verifyCode?: string;
  /** Bypass CommerceAgent's HTTP(S) proxy for this account. */
  bypassProxy?: boolean;
}

export interface WeChatOnboardingDeps {
  /** Keep onboarding on the same undici runtime as its account-local dispatcher. */
  fetch?: typeof undiciFetch;
}

type WeChatFetchInit = RequestInit & { dispatcher: Dispatcher };

/** Encode a semver as the uint32 expected by iLink (0x00MMNNPP). */
export function encodeWeChatClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

export function weChatIlinkHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': WECHAT_ILINK_APP_ID,
    'iLink-App-ClientVersion': String(
      encodeWeChatClientVersion(COMMERCEAGENT_CHANNEL_VERSION),
    ),
  };
}

/** Accept only Tencent-owned HTTPS redirect hosts before following an IDC hop. */
export function resolveWeChatRedirectBaseUrl(
  redirectHost: string | undefined,
): string | undefined {
  if (!redirectHost) return undefined;
  const raw = redirectHost.trim().toLowerCase();
  if (!raw || raw.includes('/') || raw.includes('@') || raw.includes(':'))
    return undefined;
  if (raw !== 'qq.com' && !raw.endsWith('.qq.com')) return undefined;
  return `https://${raw}`;
}

export async function startWeChatQrOnboarding(
  options: WeChatQrStartOptions = {},
  deps: WeChatOnboardingDeps = {},
): Promise<WeChatQrStart> {
  const url = `${WECHAT_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`;
  const localTokenList = Array.from(
    new Set(
      (options.localTokenList ?? [])
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ).slice(0, 10);
  const dispatcher = createWeChatHttpDispatcher(options.bypassProxy !== false);
  try {
    const response = await (deps.fetch ?? undiciFetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...weChatIlinkHeaders(),
      },
      body: JSON.stringify({ local_token_list: localTokenList }),
      dispatcher,
    } as WeChatFetchInit);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch WeChat QR code: HTTP ${response.status}`,
      );
    }
    const body = (await response.json()) as {
      qrcode?: string;
      qrcode_img_content?: string;
    };
    if (!body.qrcode)
      throw new Error('WeChat QR response did not include qrcode');
    const qrcodeUrl = body.qrcode_img_content
      ? await QRCode.toDataURL(body.qrcode_img_content, {
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        })
      : '';
    return { qrcode: body.qrcode, qrcodeUrl };
  } finally {
    await dispatcher.close();
  }
}

export async function pollWeChatQrOnboarding(
  qrcode: string,
  options: WeChatQrPollOptions = {},
  deps: WeChatOnboardingDeps = {},
): Promise<WeChatQrStatus> {
  const baseUrl = options.baseUrl || WECHAT_API_BASE;
  const query = new URLSearchParams({ qrcode });
  if (options.verifyCode?.trim()) {
    query.set('verify_code', options.verifyCode.trim());
  }
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  const dispatcher = createWeChatHttpDispatcher(options.bypassProxy !== false);
  try {
    const response = await (deps.fetch ?? undiciFetch)(url, {
      headers: weChatIlinkHeaders(),
      signal: controller.signal,
      dispatcher,
    } as WeChatFetchInit);
    if (!response.ok) {
      throw new Error(`WeChat QR status failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as {
      status?: WeChatQrStatus['status'];
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      redirect_host?: string;
    };
    const knownStatuses = new Set<WeChatQrStatusValue>([
      'wait',
      'scaned',
      'scaned_but_redirect',
      'need_verifycode',
      'verify_code_blocked',
      'binded_redirect',
      'confirmed',
      'expired',
    ]);
    const status = knownStatuses.has(body.status as WeChatQrStatusValue)
      ? (body.status as WeChatQrStatusValue)
      : 'wait';
    return {
      status,
      botToken: body.bot_token,
      ilinkBotId: body.ilink_bot_id?.replace(/[^a-zA-Z0-9@._-]/g, ''),
      baseUrl: body.baseurl,
      redirectHost: body.redirect_host,
      alreadyConnected: status === 'binded_redirect',
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw error;
  } finally {
    clearTimeout(timer);
    await dispatcher.close();
  }
}
