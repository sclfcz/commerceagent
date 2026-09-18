/**
 * WeChat iLink Bot API Connection Factory
 *
 * Implements WeChat Bot connection using iLink Bot API protocol:
 * - Long-polling message reception (getupdates)
 * - Message sending with context_token (sendmessage)
 * - Typing indicator (getconfig + sendtyping)
 * - CDN image download + AES decryption
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Base URL: https://ilinkai.weixin.qq.com
 * CDN URL:  https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from 'crypto';
import fs from 'fs';
import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { downloadAndDecryptMedia, uploadMediaBuffer } from './wechat-crypto.js';
import {
  markdownToPlainText,
  splitTextChunks,
  createDedupCache,
} from './im-utils.js';
import { weChatIlinkHeaders } from './wechat-onboarding.js';
import { resolveAdmittedChannelRoute } from './channel-admission.js';
import { createWeChatHttpDispatcher } from './wechat-http.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const MSG_SPLIT_LIMIT = 2000; // WeChat has stricter text limits than other channels

const LONGPOLL_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;

const RECONNECT_MIN_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;
const REPEATED_ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB for inline base64

const CHANNEL_VERSION = '1.0.0';

// iLink message types
// const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;

// iLink message item types
const MESSAGE_ITEM_TYPE_TEXT = 1;
const MESSAGE_ITEM_TYPE_IMAGE = 2;
// const MESSAGE_ITEM_TYPE_VOICE = 3;
const MESSAGE_ITEM_TYPE_FILE = 4;
// const MESSAGE_ITEM_TYPE_VIDEO = 5;

// iLink message state
// const MESSAGE_STATE_NEW = 0;
// const MESSAGE_STATE_GENERATING = 1;
const MESSAGE_STATE_FINISH = 2;

// errcode for session expired
const ERRCODE_SESSION_EXPIRED = -14;

// ─── Types ──────────────────────────────────────────────────────

export interface WeChatConnectionConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  /** Bypass CommerceAgent's HTTP(S) proxy. System TUN/VPN routing still applies. */
  bypassProxy?: boolean;
  logContext?: {
    accountId?: string;
    userId?: string;
  };
}

export type WeChatConnectionErrorCode =
  | 'connect_timeout'
  | 'request_timeout'
  | 'connection_reset'
  | 'tls_error'
  | 'api_error'
  | 'network_error'
  | 'unknown';

export interface WeChatConnectionState {
  status:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'expired'
    | 'disconnected';
  error?: string;
  errorCode?: WeChatConnectionErrorCode;
  consecutiveFailures?: number;
  nextRetryMs?: number;
  lastConnectedAt?: string;
}

export interface WeChatConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  normalizeIncomingJid?: (jid: string) => string;
  /** No inbound message may register or download media before this passes. */
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** Publish authorization/transport loss (notably iLink errcode -14). */
  onConnectionStateChange?: (state: WeChatConnectionState) => void;
  /** Persist a fully processed getUpdates cursor before the next poll. */
  onUpdatesBuf?: (cursor: string) => void | Promise<void>;
}

export interface WeChatConnection {
  connect(opts: WeChatConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  /** The polling worker exists, even if the upstream transport is reconnecting. */
  isRunning(): boolean;
  /** The last getUpdates call completed successfully. */
  isConnected(): boolean;
  getUpdatesBuf(): string;
}

export interface WeChatConnectionDeps {
  fetch?: typeof undiciFetch;
  createDispatcher?: (bypassProxy: boolean) => Dispatcher;
  random?: () => number;
  now?: () => number;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

type WeChatApiEnvelope = {
  ret?: unknown;
  errcode?: unknown;
  error_code?: unknown;
  errno?: unknown;
  code?: unknown;
  errmsg?: unknown;
  error_msg?: unknown;
  message?: unknown;
  base_resp?: { ret?: unknown; errcode?: unknown; errmsg?: unknown };
};

function nonZeroApiCode(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

/** Reject transport-success responses that encode a WeChat API failure. */
export function assertWeChatApiSuccess(
  response: WeChatApiEnvelope,
  operation: string,
): void {
  const codes: Array<[string, unknown]> = [
    ['ret', response.ret],
    ['errcode', response.errcode],
    ['error_code', response.error_code],
    ['errno', response.errno],
    ['code', response.code],
    ['base_resp.ret', response.base_resp?.ret],
    ['base_resp.errcode', response.base_resp?.errcode],
  ];
  const failure = codes.find(([, value]) => nonZeroApiCode(value));
  if (!failure) return;
  const message =
    response.errmsg ??
    response.error_msg ??
    response.message ??
    response.base_resp?.errmsg ??
    '';
  throw new Error(
    `${operation} failed: ${failure[0]}=${String(failure[1])}${message ? ` message=${String(message)}` : ''}`,
  );
}

export async function parseWeChatApiResponse<T>(
  response: Response,
  endpoint: string,
): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `WeChat API ${endpoint} HTTP ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `WeChat API ${endpoint} invalid JSON: ${text.slice(0, 200)}`,
    );
  }
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

/**
 * Process one long-poll batch before acknowledging its cursor. If processing
 * or persistence fails, the caller keeps the previous cursor so the batch is
 * replayed after retry/restart instead of being acknowledged early.
 */
export async function processWeChatUpdateBatch<T>(input: {
  messages?: T[];
  nextCursor?: string;
  currentCursor: string;
  processMessage: (message: T) => Promise<void>;
  persistCursor?: (cursor: string) => void | Promise<void>;
}): Promise<string> {
  for (const message of input.messages ?? []) {
    await input.processMessage(message);
  }
  if (!input.nextCursor || input.nextCursor === input.currentCursor) {
    return input.currentCursor;
  }
  await input.persistCursor?.(input.nextCursor);
  return input.nextCursor;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Generate random X-WECHAT-UIN header value.
 * A random uint32 converted to string, then base64-encoded.
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

/**
 * Extract text content from message item_list.
 * Includes voice-to-text transcription and fallback labels for non-text items.
 */
function extractTextContent(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === MESSAGE_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
      // Image placeholder — actual image is handled separately via CDN download
      // Only add placeholder if no CDN media to download
      if (!item.image_item?.media?.encrypt_query_param) {
        parts.push('(image)');
      }
    } else if (item.type === 3 /* VOICE */) {
      // Voice: prefer speech-to-text transcription
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text);
      } else {
        parts.push('(voice)');
      }
    } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
      // Only add placeholder if no CDN media to download
      // (processFileItem will generate a [文件: ...] prefix for downloadable files)
      if (!item.file_item?.media?.encrypt_query_param) {
        parts.push(`(file: ${item.file_item?.file_name ?? 'unknown'})`);
      }
    } else if (item.type === 5 /* VIDEO */) {
      parts.push('(video)');
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a unique dedup key from a WeixinMessage.
 */
function dedupKey(msg: WeixinMessage): string {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  // Fallback: combination of sender + timestamp + client_id
  return `fallback:${msg.from_user_id}:${msg.create_time_ms}:${msg.client_id}`;
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const chain: Array<Record<string, unknown>> = [];
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    chain.push(current as Record<string, unknown>);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function classifyWeChatConnectionError(
  error: unknown,
): WeChatConnectionErrorCode {
  const chain = errorChain(error);
  const codes = chain.map((item) => String(item.code ?? '')).filter(Boolean);
  const message = chain
    .map((item) => String(item.message ?? ''))
    .join(' ')
    .toLowerCase();

  if (
    codes.includes('UND_ERR_CONNECT_TIMEOUT') ||
    codes.includes('ETIMEDOUT') ||
    message.includes('connect timeout')
  ) {
    return 'connect_timeout';
  }
  if (
    codes.includes('WECHAT_REQUEST_TIMEOUT') ||
    (message.includes('wechat api') && message.includes('timed out'))
  ) {
    return 'request_timeout';
  }
  if (
    codes.some((code) =>
      ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code),
    ) ||
    message.includes('socket disconnected') ||
    message.includes('connection reset')
  ) {
    return 'connection_reset';
  }
  if (
    codes.some((code) => code.startsWith('ERR_TLS')) ||
    message.includes('tls') ||
    message.includes('certificate')
  ) {
    return 'tls_error';
  }
  if (
    codes.includes('WECHAT_API_ERROR') ||
    message.includes('wechat getupdates error')
  ) {
    return 'api_error';
  }
  if (error instanceof TypeError && message.includes('fetch failed')) {
    return 'network_error';
  }
  return 'unknown';
}

export function weChatConnectionErrorMessage(
  code: WeChatConnectionErrorCode,
): string {
  switch (code) {
    case 'connect_timeout':
      return '连接微信服务超时，CommerceAgent 正在自动重试';
    case 'request_timeout':
      return '微信长轮询暂时无响应，CommerceAgent 正在自动重试';
    case 'connection_reset':
      return '微信连接在 TLS 建立前被中断，CommerceAgent 正在自动重试';
    case 'tls_error':
      return '微信服务 TLS 连接失败，CommerceAgent 正在自动重试';
    case 'api_error':
      return '微信服务返回异常，CommerceAgent 正在自动重试';
    case 'network_error':
      return '暂时无法访问微信服务，CommerceAgent 正在自动重试';
    default:
      return '微信连接暂时异常，CommerceAgent 正在自动重试';
  }
}

export function jitteredWeChatRetryDelay(
  baseDelayMs: number,
  random: () => number = Math.random,
): number {
  // Full synchronization between multiple accounts makes outages noisier.
  // Keep the configured exponential curve while spreading retries by ±20%.
  const factor = 0.8 + Math.max(0, Math.min(1, random())) * 0.4;
  return Math.max(1, Math.round(baseDelayMs * factor));
}

function maskedBotId(ilinkBotId: string): string {
  if (ilinkBotId.length <= 8) return '***';
  return `${ilinkBotId.slice(0, 4)}…${ilinkBotId.slice(-7)}`;
}

// ─── Factory Function ───────────────────────────────────────────

export function createWeChatConnection(
  config: WeChatConnectionConfig,
  deps: WeChatConnectionDeps = {},
): WeChatConnection {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;
  const bypassProxy = config.bypassProxy !== false;
  const fetchImpl = deps.fetch ?? undiciFetch;
  const createDispatcher = deps.createDispatcher ?? createWeChatHttpDispatcher;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const logContext = {
    accountId: config.logContext?.accountId,
    userId: config.logContext?.userId,
    botId: maskedBotId(config.ilinkBotId),
  };

  // Generate UIN once per connection instance (no need to regenerate per request)
  const wechatUin = randomWechatUin();

  // Polling state
  let currentGetUpdatesBuf = config.getUpdatesBuf || '';
  let longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
  let stopping = false;
  let running = false;
  let connected = false;
  let dispatcher: Dispatcher | null = null;
  let pollPromise: Promise<void> | null = null;
  let activePollController: AbortController | null = null;
  let cancelSleep: (() => void) | null = null;
  let activeOpts: WeChatConnectOpts | null = null;
  let connectionState: WeChatConnectionState = { status: 'disconnected' };
  let consecutiveFailures = 0;
  let consecutivePollTimeouts = 0;
  let failureStartedAt = 0;
  let lastConnectedAt: string | undefined;
  let lastLoggedErrorCode: WeChatConnectionErrorCode | null = null;
  let lastRepeatedErrorLogAt = 0;

  // context_token cache: from_user_id -> latest context_token
  const contextTokenCache = new Map<string, string>();

  // Known JIDs — skip redundant storeChatMetadata/onNewChat for repeat messages
  const knownJids = new Set<string>();

  // Avoid turning an unauthorized sender into a reply-amplification source.
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  // Message deduplication: key -> timestamp
  // LRU deduplication cache（共享 helper）
  const dedup = createDedupCache({ ttlMs: 30 * 60 * 1000, max: 1000 });

  // ─── Deduplication ────────────────────────────────────────

  // ─── HTTP Helpers ─────────────────────────────────────────

  function ensureDispatcher(): Dispatcher {
    dispatcher ??= createDispatcher(bypassProxy);
    return dispatcher;
  }

  function publishState(state: WeChatConnectionState): void {
    connectionState = state;
    activeOpts?.onConnectionStateChange?.(state);
  }

  function buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${config.botToken}`,
      'X-WECHAT-UIN': wechatUin,
      ...weChatIlinkHeaders(),
    };
  }

  function baseInfo(): Record<string, string> {
    return {
      channel_version: CHANNEL_VERSION,
      bot_agent: `CommerceAgent/${CHANNEL_VERSION}`,
    };
  }

  /**
   * Make an HTTPS POST request to the iLink API using fetch.
   */
  async function apiPost<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
    trackAsPollRequest = false,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const url = new URL(endpoint, baseUrl);
    const headers = buildHeaders();

    const controller = new AbortController();
    if (trackAsPollRequest) activePollController = controller;
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const res = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
        },
        body: bodyStr,
        signal: controller.signal,
        dispatcher: ensureDispatcher(),
      });

      return await parseWeChatApiResponse<T>(res, endpoint);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw Object.assign(
          new Error(`WeChat API ${endpoint} timed out`, { cause: err }),
          { code: 'WECHAT_REQUEST_TIMEOUT' },
        );
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      if (trackAsPollRequest && activePollController === controller) {
        activePollController = null;
      }
    }
  }

  // ─── API Methods ──────────────────────────────────────────

  async function getUpdates(): Promise<GetUpdatesResponse> {
    const httpTimeout = longpollTimeoutMs + LONGPOLL_EXTRA_TIMEOUT_MS;
    return apiPost<GetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: currentGetUpdatesBuf,
        base_info: baseInfo(),
      },
      httpTimeout,
      true,
    );
  }

  async function sendMessageApi(
    toUserId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const clientId = String(crypto.randomBytes(4).readUInt32BE(0));

    const resp = await apiPost<{
      ret?: number;
      errcode?: number;
      errmsg?: string;
    }>('ilink/bot/sendmessage', {
      msg: {
        to_user_id: toUserId,
        context_token: contextToken,
        item_list: [
          {
            type: MESSAGE_ITEM_TYPE_TEXT,
            text_item: { text },
          },
        ],
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        client_id: clientId,
      },
      base_info: baseInfo(),
    });

    assertWeChatApiSuccess(resp, 'sendMessage');
  }

  async function getTypingTicket(
    ilinkUserId: string,
    contextToken: string,
  ): Promise<string | null> {
    try {
      const res = await apiPost<{ typing_ticket?: string }>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: baseInfo(),
        },
      );
      return res.typing_ticket || null;
    } catch (err) {
      logger.debug({ err }, 'WeChat getconfig failed');
      return null;
    }
  }

  async function sendTypingApi(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    try {
      await apiPost('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: baseInfo(),
      });
    } catch (err) {
      logger.debug({ err, status }, 'WeChat sendtyping failed');
    }
  }

  // ─── CDN Media Download ────────────────────────────────────

  /**
   * Download, decrypt, and save a CDN media item (image, file, etc.).
   * `resolveFileName` receives the decrypted buffer so callers can inspect
   * content (e.g. MIME-detect for images) before choosing a name.
   */
  async function downloadCdnMediaItem(
    media: CDNMedia | undefined,
    groupFolder: string | undefined,
    label: string,
    resolveFileName: (buffer: Buffer) => string,
  ): Promise<{ buffer: Buffer; savedPath?: string } | null> {
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug(`WeChat ${label} missing media or aes_key, skipping`);
      return null;
    }

    const buffer = await downloadAndDecryptMedia(
      media.encrypt_query_param,
      media.aes_key,
      cdnBaseUrl,
      ensureDispatcher(),
    );

    if (!buffer || buffer.length === 0) {
      logger.warn(`WeChat ${label} download returned empty buffer`);
      return null;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      logger.warn(
        { size: buffer.length },
        `WeChat ${label} exceeds max file size, skipping`,
      );
      return null;
    }

    let savedPath: string | undefined;
    if (groupFolder) {
      try {
        const fileName = resolveFileName(buffer);
        savedPath =
          (await saveDownloadedFile(groupFolder, 'wechat', fileName, buffer)) ??
          undefined;
      } catch (err) {
        logger.warn({ err }, `Failed to save WeChat ${label} to disk`);
      }
    }

    return { buffer, savedPath };
  }

  async function processImageItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }> {
    try {
      const result = await downloadCdnMediaItem(
        item.image_item?.media,
        groupFolder,
        'image',
        (buffer) => {
          const mimeType = detectImageMimeType(buffer);
          const extMap: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
          };
          return `wechat_img_${msgIdentifier}${extMap[mimeType] ?? '.jpg'}`;
        },
      );
      if (!result) return {};

      const textPrefix = result.savedPath
        ? `[图片: ${result.savedPath}]`
        : undefined;

      let attachmentEntry:
        | { type: string; data: string; mimeType: string }
        | undefined;
      if (result.buffer.length <= IMAGE_MAX_BASE64_SIZE) {
        const mimeType = detectImageMimeType(result.buffer);
        attachmentEntry = {
          type: 'image',
          data: result.buffer.toString('base64'),
          mimeType,
        };
      }

      return { attachmentEntry, textPrefix };
    } catch (err) {
      logger.warn({ err }, 'WeChat image download/decrypt failed, skipping');
      return {};
    }
  }

  async function processFileItem(
    item: MessageItem,
    groupFolder: string | undefined,
  ): Promise<string | null> {
    const fileName = item.file_item?.file_name || 'unknown_file';
    try {
      const result = await downloadCdnMediaItem(
        item.file_item?.media,
        groupFolder,
        'file',
        () => fileName,
      );
      if (result?.savedPath) return `[文件: ${result.savedPath}]`;
      // CDN media unavailable, fall back to name-only label
      return `[文件: ${fileName}]`;
    } catch (err) {
      logger.warn({ err, fileName }, 'WeChat file download/decrypt failed');
      return `[文件: ${fileName}]`;
    }
  }

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WeixinMessage,
    opts: WeChatConnectOpts,
  ): Promise<void> {
    try {
      // Skip bot's own messages
      if (msg.message_type === MESSAGE_TYPE_BOT) return;

      const fromUserId = msg.from_user_id;
      if (!fromUserId) return;

      // Dedup
      const key = dedupKey(msg);
      if (dedup.isDuplicate(key)) return;
      dedup.markSeen(key);

      // Skip stale messages — if no timestamp available, skip as well (can't verify freshness)
      if (opts.ignoreMessagesBefore) {
        if (
          !msg.create_time_ms ||
          msg.create_time_ms < opts.ignoreMessagesBefore
        )
          return;
      }

      const jid =
        opts.normalizeIncomingJid?.(`wechat:${fromUserId}`) ??
        `wechat:${fromUserId}`;
      const senderName = fromUserId.split('@')[0] || 'WeChat用户';
      const chatName = senderName;

      // Extract text content
      let content = msg.item_list ? extractTextContent(msg.item_list) : '';

      // Pairing and admission must run before registration, workspace lookup,
      // file downloads, or message persistence. QR authorization authenticates
      // the bot account; it does not authorize every person who can message it.
      const pairMatch = content.match(/^\/pair\s+(\S+)/i);
      if (pairMatch && opts.onPairAttempt) {
        try {
          const success = await opts.onPairAttempt(jid, chatName, pairMatch[1]);
          if (msg.context_token) {
            await sendMessageApi(
              fromUserId,
              msg.context_token,
              success
                ? '配对成功，此微信会话已连接。'
                : '配对码无效或已过期，请在网页设置中重新生成。',
            );
          }
        } catch (err) {
          logger.error({ err, jid }, 'WeChat pair attempt failed');
          if (msg.context_token) {
            await sendMessageApi(
              fromUserId,
              msg.context_token,
              '配对失败，请稍后重试。',
            );
          }
        }
        return;
      }

      if (!(opts.isChatAuthorized?.(jid) ?? false)) {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (msg.context_token && now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendMessageApi(
            fromUserId,
            msg.context_token,
            '此微信会话尚未配对。请在网页设置中生成配对码，然后发送 /pair <配对码>。',
          );
        }
        logger.debug({ jid }, 'Unauthorized WeChat chat, message ignored');
        return;
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        jid,
        opts.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { jid },
          'WeChat message dropped: binding resolver rejected route',
        );
        return;
      }
      const { targetJid, routing: agentRouting } = resolvedRoute;

      // Cache a reply token only after authorization, preventing arbitrary
      // senders from growing the long-lived per-connection cache.
      if (msg.context_token) {
        contextTokenCache.set(fromUserId, msg.context_token);
      }

      // ── Register the authorized base chat ──
      const nowIso = new Date().toISOString();
      if (!knownJids.has(jid)) {
        knownJids.add(jid);
        storeChatMetadata(jid, nowIso);
        updateChatName(jid, chatName);
        opts.onNewChat(jid, chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody, fromUserId);
          if (reply) {
            const ct = contextTokenCache.get(fromUserId);
            if (ct) {
              await sendMessageApi(fromUserId, ct, markdownToPlainText(reply));
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'WeChat slash command failed');
          const ct = contextTokenCache.get(fromUserId);
          if (ct) {
            await sendMessageApi(fromUserId, ct, '命令执行失败，请稍后重试');
          }
          return;
        }
      }

      // Handle image attachments
      let attachmentsJson: string | undefined;
      const groupFolder = opts.resolveGroupFolder?.(jid);
      if (msg.item_list) {
        const imageAttachments: {
          type: string;
          data: string;
          mimeType: string;
        }[] = [];
        const textPrefixes: string[] = [];

        // Note: textPrefixes order depends on CDN response time, not message item order
        // Download images and files in parallel (independent CDN requests)
        const msgId =
          msg.message_id !== undefined
            ? String(msg.message_id)
            : String(msg.seq ?? Date.now());

        const mediaPromises: Promise<void>[] = [];

        for (const item of msg.item_list) {
          if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
            mediaPromises.push(
              processImageItem(item, msgId.slice(-8), groupFolder).then((r) => {
                if (r.attachmentEntry) imageAttachments.push(r.attachmentEntry);
                if (r.textPrefix) textPrefixes.push(r.textPrefix);
              }),
            );
          } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
            mediaPromises.push(
              processFileItem(item, groupFolder).then((label) => {
                if (label) textPrefixes.push(label);
              }),
            );
          }
        }

        if (mediaPromises.length > 0) {
          await Promise.allSettled(mediaPromises);
        }

        // Merge file/media labels into content independently of images: a
        // file-only message (no imageAttachments) would otherwise drop its
        // textPrefixes and hit `if (!content) return` below → silently lost.
        if (textPrefixes.length > 0) {
          content = `${textPrefixes.join('\n')}\n${content}`.trim();
        }
        if (imageAttachments.length > 0) {
          attachmentsJson = JSON.stringify(imageAttachments);
        }

        if (!content && imageAttachments.length > 0) {
          content = '[图片]';
        }
      }

      if (!content) return; // No usable content

      // Route was resolved before registration and media download.
      const id = crypto.randomUUID();
      const timestamp = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : nowIso;
      const senderId = `wechat:${fromUserId}`;

      if (targetJid !== jid) storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        {
          attachments: attachmentsJson,
          sourceJid: jid,
        },
      );

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );
      notifyNewImMessage();

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'WeChat message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId: msg.message_id ?? msg.seq },
          'WeChat message stored',
        );
      }
    } catch (err) {
      logger.error(
        { err, msgId: msg.message_id },
        'Error handling WeChat message',
      );
    }
  }

  // ─── Long-Polling Loop ────────────────────────────────────

  function markConnectionHealthy(): void {
    const recoveredFailures = consecutiveFailures;
    const downtimeMs = failureStartedAt
      ? Math.max(0, now() - failureStartedAt)
      : 0;
    const wasConnected = connected;
    connected = true;
    consecutiveFailures = 0;
    consecutivePollTimeouts = 0;
    failureStartedAt = 0;
    lastLoggedErrorCode = null;
    lastRepeatedErrorLogAt = 0;
    if (wasConnected) return;
    lastConnectedAt = new Date(now()).toISOString();
    publishState({ status: 'connected', lastConnectedAt });
    if (!wasConnected && recoveredFailures === 0) {
      logger.info(logContext, 'WeChat poll connection established');
    } else if (!wasConnected && recoveredFailures > 0) {
      logger.info(
        { ...logContext, recoveredFailures, downtimeMs },
        'WeChat poll connection recovered',
      );
    }
  }

  async function handlePollFailure(
    err: unknown,
    baseDelayMs: number,
  ): Promise<void> {
    connected = false;
    consecutiveFailures += 1;
    if (!failureStartedAt) failureStartedAt = now();
    const errorCode = classifyWeChatConnectionError(err);
    const nextRetryMs = jitteredWeChatRetryDelay(baseDelayMs, random);
    const userMessage = weChatConnectionErrorMessage(errorCode);
    publishState({
      status: 'reconnecting',
      error: userMessage,
      errorCode,
      consecutiveFailures,
      nextRetryMs,
      lastConnectedAt,
    });

    const currentTime = now();
    const shouldLogDetails =
      consecutiveFailures === 1 ||
      errorCode !== lastLoggedErrorCode ||
      currentTime - lastRepeatedErrorLogAt >= REPEATED_ERROR_LOG_INTERVAL_MS;
    if (shouldLogDetails) {
      logger.warn(
        {
          ...logContext,
          err,
          errorCode,
          consecutiveFailures,
          nextRetryMs,
        },
        'WeChat poll connection unavailable; retry scheduled',
      );
      lastLoggedErrorCode = errorCode;
      lastRepeatedErrorLogAt = currentTime;
    } else {
      logger.debug(
        { ...logContext, errorCode, consecutiveFailures, nextRetryMs },
        'WeChat poll retry scheduled',
      );
    }
    await sleep(nextRetryMs);
  }

  async function pollLoop(): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_DELAY_MS;

    while (!stopping) {
      try {
        const response = await getUpdates();
        if (stopping) break;

        // Update longpoll timeout from server
        if (response.longpolling_timeout_ms) {
          longpollTimeoutMs = response.longpolling_timeout_ms;
        }

        const responseCode = response.ret ?? response.errcode;

        // Check for session expiry
        if (responseCode === ERRCODE_SESSION_EXPIRED) {
          const error = '微信授权已过期，请重新扫码连接';
          logger.warn(
            { ...logContext, errorCode: 'session_expired' },
            'WeChat session expired; polling stopped',
          );
          connected = false;
          publishState({ status: 'expired', error });
          break;
        }

        // ret/errcode are absent when the request succeeds — treat as 0.
        if (responseCode !== undefined && responseCode !== 0) {
          throw Object.assign(
            new Error(
              `WeChat getUpdates error: code=${responseCode}, message=${response.errmsg ?? ''}`,
            ),
            { code: 'WECHAT_API_ERROR' },
          );
        }

        // Reset backoff on success
        markConnectionHealthy();
        reconnectDelay = RECONNECT_MIN_DELAY_MS;

        const opts = activeOpts;
        if (!opts || stopping) break;

        // Cursor acknowledgement is deliberately last. A crash or processing
        // failure replays the whole batch from the previous durable cursor.
        currentGetUpdatesBuf = await processWeChatUpdateBatch({
          messages: response.msgs,
          nextCursor: response.get_updates_buf,
          currentCursor: currentGetUpdatesBuf,
          processMessage: (msg) => processMessage(msg, opts),
          persistCursor: opts.onUpdatesBuf,
        });
      } catch (err) {
        if (stopping) break;

        // Once healthy, a client-side long-poll timeout only means the server
        // kept the request open longer than advertised. It is not an outage.
        const errorCode = classifyWeChatConnectionError(err);
        if (connected && errorCode === 'request_timeout') {
          consecutivePollTimeouts += 1;
        }
        if (
          connected &&
          errorCode === 'request_timeout' &&
          consecutivePollTimeouts === 1
        ) {
          logger.debug(
            { ...logContext, errorCode },
            'WeChat long poll reached client timeout; retrying',
          );
          continue;
        }

        await handlePollFailure(err, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        if (cancelSleep === cancel) cancelSleep = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const cancel = () => {
        clearTimeout(timer);
        finish();
      };
      cancelSleep = cancel;
    });
  }

  async function closeDispatcher(): Promise<void> {
    const activeDispatcher = dispatcher;
    dispatcher = null;
    if (!activeDispatcher) return;
    await activeDispatcher.close().catch((err) => {
      logger.debug(
        { ...logContext, err },
        'Failed to close WeChat HTTP dispatcher cleanly',
      );
    });
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: WeChatConnection = {
    async connect(opts: WeChatConnectOpts): Promise<void> {
      if (!config.botToken || !config.ilinkBotId) {
        logger.info(
          logContext,
          'WeChat botToken/ilinkBotId not configured, skipping',
        );
        return;
      }

      if (running && pollPromise) {
        logger.debug(
          logContext,
          'WeChat connect ignored: poller already running',
        );
        opts.onReady?.();
        opts.onConnectionStateChange?.(connectionState);
        return;
      }

      activeOpts = opts;

      try {
        ensureDispatcher();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        publishState({ status: 'disconnected', error });
        activeOpts = null;
        throw err;
      }

      stopping = false;
      running = true;
      connected = false;
      consecutiveFailures = 0;
      consecutivePollTimeouts = 0;
      failureStartedAt = 0;
      dedup.clear();
      contextTokenCache.clear();
      knownJids.clear();

      logger.info(
        { ...logContext, baseUrl, bypassProxy },
        'WeChat iLink poller starting',
      );

      publishState({ status: 'connecting' });
      // onReady means the local poller is running. Upstream health is
      // published separately after the first successful getUpdates response.
      opts.onReady?.();

      // Start poll loop in background (non-blocking)
      pollPromise = pollLoop()
        .catch((err) => {
          connected = false;
          if (!stopping && connectionState.status !== 'expired') {
            const error = '微信轮询意外退出，请重新连接';
            publishState({ status: 'disconnected', error, lastConnectedAt });
            logger.error(
              { ...logContext, err },
              'WeChat poll loop exited unexpectedly',
            );
          }
        })
        .finally(async () => {
          running = false;
          if (!stopping) await closeDispatcher();
          pollPromise = null;
        });
    },

    async disconnect(): Promise<void> {
      stopping = true;
      connected = false;
      activePollController?.abort();
      activePollController = null;

      // Abort any pending sleep
      cancelSleep?.();
      cancelSleep = null;

      const pendingPoll = pollPromise;
      if (pendingPoll) await pendingPoll;
      running = false;
      publishState({ status: 'disconnected', lastConnectedAt });
      activeOpts = null;

      await closeDispatcher();

      dedup.clear();
      contextTokenCache.clear();
      knownJids.clear();
      rejectTimestamps.clear();
      logger.info(logContext, 'WeChat iLink poller disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token available for WeChat user, cannot send message',
        );
        throw new Error(`No context_token available for WeChat chat ${chatId}`);
      }

      try {
        const plainText = markdownToPlainText(text);
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendMessageApi(userId, contextToken, chunk);
        }

        logger.info({ chatId }, 'WeChat message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send WeChat message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token for WeChat user, cannot send image',
        );
        throw new Error(`No context_token available for WeChat chat ${chatId}`);
      }

      if (imageBuffer.length > MAX_FILE_SIZE) {
        throw new Error(
          `WeChat image size ${imageBuffer.length} exceeds max ${MAX_FILE_SIZE}`,
        );
      }

      const extMap: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = extMap[mimeType] ?? '.jpg';
      const resolvedFileName = fileName ?? `image_${Date.now()}${ext}`;

      try {
        // Optional caption is sent first as a separate text message — WeChat's
        // sendmessage API does not accept mixed text+image item_list payloads.
        if (caption) {
          const plain = markdownToPlainText(caption);
          for (const chunk of splitTextChunks(plain, MSG_SPLIT_LIMIT)) {
            await sendMessageApi(userId, contextToken, chunk);
          }
        }

        // Upload to WeChat CDN (getuploadurl → AES-128-ECB encrypt → PUT ciphertext).
        const upload = await uploadMediaBuffer({
          buf: imageBuffer,
          fileName: resolvedFileName,
          toUserId: userId,
          baseUrl,
          token: config.botToken,
          cdnBaseUrl,
          mediaType: 1, // MEDIA_IMAGE
          dispatcher: ensureDispatcher(),
        });

        const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
        const resp = await apiPost<{
          ret?: number;
          errcode?: number;
          errmsg?: string;
        }>('ilink/bot/sendmessage', {
          msg: {
            to_user_id: userId,
            context_token: contextToken,
            item_list: [
              {
                type: MESSAGE_ITEM_TYPE_IMAGE,
                image_item: {
                  media: {
                    encrypt_query_param: upload.downloadEncryptedQueryParam,
                    aes_key: upload.aeskey,
                    encrypt_type: 1,
                  },
                  mid_size: upload.fileSizeCiphertext,
                },
              },
            ],
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            client_id: clientId,
          },
          base_info: baseInfo(),
        });

        assertWeChatApiSuccess(resp, 'sendImage');

        logger.info(
          { chatId, size: imageBuffer.length, fileName: resolvedFileName },
          'WeChat image sent',
        );
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send WeChat image');
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token for WeChat user, cannot send file',
        );
        throw new Error(`No context_token available for WeChat chat ${chatId}`);
      }

      // Single readFile + size check, then pass buffer to uploadMediaBuffer —
      // avoids stat + readFile double-I/O that uploadMediaFile would incur.
      const buf = await fs.promises.readFile(filePath);
      if (buf.length > MAX_FILE_SIZE) {
        throw new Error(
          `WeChat file size ${buf.length} exceeds max ${MAX_FILE_SIZE}`,
        );
      }

      try {
        // Upload raw bytes to WeChat CDN as FILE attachment (mediaType=3).
        const upload = await uploadMediaBuffer({
          buf,
          fileName,
          toUserId: userId,
          baseUrl,
          token: config.botToken,
          cdnBaseUrl,
          mediaType: 3, // MEDIA_FILE
          dispatcher: ensureDispatcher(),
        });

        const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
        const resp = await apiPost<{
          ret?: number;
          errcode?: number;
          errmsg?: string;
        }>('ilink/bot/sendmessage', {
          msg: {
            to_user_id: userId,
            context_token: contextToken,
            item_list: [
              {
                type: MESSAGE_ITEM_TYPE_FILE,
                file_item: {
                  media: {
                    encrypt_query_param: upload.downloadEncryptedQueryParam,
                    aes_key: upload.aeskey,
                    encrypt_type: 1,
                  },
                  file_name: fileName,
                  // 'len' is the raw (plaintext) file size as a string — per
                  // nightsailer/wechat-clawbot reference.
                  len: String(upload.fileSize),
                },
              },
            ],
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            client_id: clientId,
          },
          base_info: baseInfo(),
        });

        assertWeChatApiSuccess(resp, 'sendFile');

        logger.info({ chatId, size: buf.length, fileName }, 'WeChat file sent');
      } catch (err) {
        logger.error({ err, chatId, fileName }, 'Failed to send WeChat file');
        throw err;
      }
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) return;

      const ticket = await getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTypingApi(userId, ticket, isTyping ? 1 : 2);
    },

    isRunning(): boolean {
      return running && !stopping;
    },

    isConnected(): boolean {
      return running && connected && !stopping;
    },

    getUpdatesBuf(): string {
      return currentGetUpdatesBuf;
    },
  };

  return connection;
}
