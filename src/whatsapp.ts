/**
 * WhatsApp Channel — Baileys integration (M1: QR login + connection state)
 *
 * 基于 OpenClaw 同版本的 baileys 7.0.0-rc13 接入 WhatsApp Web 协议。
 *
 * M1 范围（本提交）：
 *  - useMultiFileAuthState 持久化登录态（多文件 auth state，存在 authDir 下）
 *  - makeWASocket 建立 WebSocket 长连接到 Meta
 *  - 监听 connection.update：将 status / QR 串通过 onConnectionUpdate 推到上层
 *  - QR 串经 qrcode 库 render 成 PNG data URL，前端可直接 <img src=> 展示
 *  - disconnect 优雅关闭、isConnected 反映真实状态
 *  - 自动重连：被 Meta 主动断开（非 logged out）时延迟 3s 重连
 *
 * M2/M3 待补：messages.upsert 转发到 onMessage、sendMessage / sendImage / sendFile
 * 实际投递（目前仍 throw NOT_IMPLEMENTED 占位）。
 *
 * 风险：Baileys 是逆向 WhatsApp Web 协议的社区方案，封号率随 Meta 风控收紧上升。
 * 商用场景应使用官方 Cloud API。
 */
import { mkdir, chmod } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import qrcode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type proto,
} from 'baileys';
import type { Boom } from '@hapi/boom';
import { ProxyAgent } from 'proxy-agent';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { markdownToPlainText, splitTextChunks } from './im-utils.js';
import { saveDownloadedFile, FileTooLargeError } from './im-downloader.js';
import { ProcessingLock, isStale } from './im-safety/index.js';
import {
  evaluateChannelAdmission,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';

const CHANNEL_PREFIX = 'whatsapp:';
/** WhatsApp text message safe limit. Baileys allows up to 64KB but UX clamps far below. */
const TEXT_CHUNK_LIMIT = 4096;
/** Inline image as base64 attachment (for Vision API) only when ≤ 5MB. */
const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────

export interface WhatsAppConnectionConfig {
  /** Account identifier — currently 固定 'default'，未来扩展 multi-account 用 */
  accountId?: string;
  /** Optional phone number hint for display purposes (E.164 format, e.g. +15551234567) */
  phoneNumber?: string;
  /** Auth state directory; required for production use to persist login between restarts */
  authDir: string;
}

export type WhatsAppConnectionStatus =
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  /** Raw QR string (only when status='qr') */
  qr?: string;
  /** Pre-rendered PNG data URL of the QR (only when status='qr'), ready for <img src=> */
  qrDataUrl?: string;
  /** Human-readable error reason when status='disconnected' or 'logged_out' */
  error?: string;
  /** Self-bot WhatsApp JID once logged in (e.g. 15551234567@s.whatsapp.net) */
  meJid?: string;
  /** Display name of the logged-in account */
  meName?: string;
}

export interface WhatsAppConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
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
  /** Bot added to a new group */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot removed from a group / group dissolved */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** Group msg gate: bot not mentioned + this returns false → drop */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** owner_mentioned mode: bot @mentioned but sender not group owner → drop */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Sender allowlist: false → drop before any further processing */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** WhatsApp 专属：连接状态变化回调（QR 出现、connected、断线等） */
  onConnectionUpdate?: (state: WhatsAppConnectionState) => void;
  normalizeIncomingJid?: (jid: string) => string;
}

export interface WhatsAppConnection {
  connect(opts: WhatsAppConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  /** Force log out and clear local auth state (user clicks "退出登录") */
  logout(): Promise<void>;
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
  isConnected(): boolean;
  /** Current connection state snapshot (latest seen) */
  getState(): WhatsAppConnectionState;
}

export function assertWhatsAppSocketConnected(
  socket: WASocket | null,
  state: WhatsAppConnectionState,
): asserts socket is WASocket {
  if (!socket || state.status !== 'connected') {
    throw new Error('WhatsApp socket is not connected');
  }
}

const RECONNECT_BASE_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
/** Message dedup cache: matches feishu/qq/dingtalk (1000 entries, 30min TTL). */
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL_MS = 30 * 60 * 1000;
/**
 * Delay between WhatsApp text chunks. WhatsApp Web's anti-spam will rate-limit
 * (and at the high end, contribute to bans) bursts of messages from the same
 * sender. 300ms keeps small replies fast while throttling long chunked replies.
 */
const CHUNK_SEND_DELAY_MS = 300;

/**
 * Cached Baileys protocol version. fetchLatestBaileysVersion() hits the network
 * on every reconnect — if the box is offline it blocks the socket. We hit the
 * network the first time we successfully connect, then reuse across reconnects.
 */
let cachedBaileysVersion: [number, number, number] | null = null;

type ClosableWhatsAppSocket = Pick<WASocket, 'end'> & {
  ws?: {
    isConnecting?: boolean;
    close?: () => Promise<void> | void;
    on?: (event: string, listener: (error: Error) => void) => void;
  };
};

/**
 * Baileys 6.17.x declares `sock.end()` as synchronous, but its WebSocket
 * client implements `close()` as an async method. While the websocket is
 * still CONNECTING, `ws.close()` rejects and `sock.end()` does not observe
 * that promise, which becomes an unhandled rejection and can terminate the
 * whole CommerceAgent process.
 *
 * OpenClaw treats socket shutdown as best-effort and contains every failure.
 * We keep that contract while explicitly awaiting the CONNECTING close path
 * required by the Baileys version used here.
 */
export async function closeWhatsAppSocketSafely(
  socket: ClosableWhatsAppSocket | null | undefined,
  reason = 'CommerceAgent WhatsApp socket close',
): Promise<void> {
  if (!socket) return;
  if (socket.ws?.isConnecting && typeof socket.ws.close === 'function') {
    try {
      await socket.ws.close();
    } catch (error) {
      logger.debug(
        { error, feature: 'whatsapp' },
        'Ignored WhatsApp CONNECTING socket close failure',
      );
    }
    return;
  }
  try {
    await Promise.resolve(socket.end(new Error(reason)));
  } catch (error) {
    logger.debug(
      { error, feature: 'whatsapp' },
      'Ignored WhatsApp socket shutdown failure',
    );
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createWhatsAppConnection(
  config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  let sock: WASocket | null = null;
  let currentState: WhatsAppConnectionState = { status: 'disconnected' };
  let opts: WhatsAppConnectOpts | null = null;
  let intentionalDisconnect = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  // Cache real group display names (jid → name); fetched lazily per group on
  // first message arrival to avoid blowing up reconnect.
  const groupNameCache = new Map<string, string>();
  // LRU dedup cache: key = `${remoteJid}|${msgId}`, value = insertion timestamp.
  // Baileys can re-emit the same key.id at reconnect boundaries or when
  // history/notify streams overlap; without this cache the Agent responds twice.
  const msgCache = new Map<string, number>();
  const processingLock = new ProcessingLock();
  const rejectTimestamps = new Map<string, number>();
  const hasAmbientProxy = [
    'https_proxy',
    'HTTPS_PROXY',
    'http_proxy',
    'HTTP_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ].some((name) => !!process.env[name]);
  const ambientProxyAgent = hasAmbientProxy ? new ProxyAgent() : undefined;
  let saveCredsQueue: Promise<void> = Promise.resolve();

  function isDuplicate(msgKey: string): boolean {
    const now = Date.now();
    // Map preserves insertion order; expire from the head until first fresh entry.
    for (const [k, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL_MS) {
        msgCache.delete(k);
      } else {
        break;
      }
    }
    return msgCache.has(msgKey);
  }

  function markSeen(msgKey: string): void {
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    msgCache.delete(msgKey);
    msgCache.set(msgKey, Date.now());
  }

  async function resolveGroupName(remoteJid: string): Promise<void> {
    if (!sock) return;
    try {
      const meta = await sock.groupMetadata(remoteJid);
      const subject = meta?.subject;
      if (subject) {
        groupNameCache.set(remoteJid, subject);
        try {
          const rawJid = `${CHANNEL_PREFIX}${remoteJid}`;
          updateChatName(
            opts?.normalizeIncomingJid?.(rawJid) ?? rawJid,
            subject,
          );
        } catch (err) {
          logger.debug({ err, remoteJid }, 'Failed to persist group name');
        }
      }
    } catch (err) {
      logger.debug({ err, remoteJid }, 'WhatsApp groupMetadata failed');
    }
  }

  function setState(next: WhatsAppConnectionState): void {
    currentState = next;
    try {
      opts?.onConnectionUpdate?.(next);
    } catch (err) {
      logger.warn({ err }, 'WhatsApp onConnectionUpdate callback threw');
    }
  }

  async function startSocket(): Promise<void> {
    const generation = ++socketGeneration;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    await mkdir(config.authDir, { recursive: true });
    // Baileys MultiFileAuthState holds the full WhatsApp login session
    // (noise keys, Signal pre-keys, etc.) — equivalent to a permanent
    // login credential. Tighten perms to 0700 to match session-secret.key's
    // 0600 posture on multi-user machines.
    try {
      await chmod(config.authDir, 0o700);
    } catch (err) {
      logger.warn(
        { err, authDir: config.authDir },
        'Failed to chmod WhatsApp auth dir to 0700 — proceeding with umask default',
      );
    }
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

    // Reuse cached version across reconnects to avoid blocking the socket
    // when the network is flaky. First connect still hits the network so
    // we pick up Baileys protocol bumps within the same process lifetime.
    let version: [number, number, number] | null = cachedBaileysVersion;
    let isLatest = true;
    if (!version) {
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
        isLatest = fetched.isLatest;
        cachedBaileysVersion = version;
      } catch (err) {
        logger.warn(
          { err },
          'fetchLatestBaileysVersion failed; Baileys will use its bundled default version',
        );
      }
    }
    logger.info(
      { feature: 'whatsapp', version, isLatest, authDir: config.authDir },
      'Initialising WhatsApp socket',
    );

    const nextSock = makeWASocket({
      // Skip version when unavailable so Baileys uses its bundled default
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      // 用 pino 兼容的 logger（baileys 期望 pino 接口）
      logger: logger.child({ feature: 'whatsapp-baileys' }) as never,
      browser: ['CommerceAgent', 'Desktop', '1.0.0'],
      markOnlineOnConnect: false,
      // proxy-agent follows HTTP(S)_PROXY / ALL_PROXY and NO_PROXY. This is
      // the WebSocket transport path; Baileys' media fetch dispatcher is a
      // different (undici) type and intentionally remains untouched here.
      ...(ambientProxyAgent ? { agent: ambientProxyAgent } : {}),
    });
    if (generation !== socketGeneration || intentionalDisconnect) {
      await closeWhatsAppSocketSafely(
        nextSock,
        'WhatsApp socket superseded during startup',
      );
      return;
    }
    sock = nextSock;

    // OpenClaw also observes the WebSocket error surface directly. Baileys
    // normally translates these to connection.update, but keeping an explicit
    // listener prevents a transport error from becoming process-fatal when a
    // socket is being replaced at exactly the same time.
    nextSock.ws?.on?.('error', (error: Error) => {
      logger.warn({ error, feature: 'whatsapp' }, 'WhatsApp WebSocket error');
    });

    setState({ status: 'connecting' });

    // Serialize credential writes. Baileys can emit overlapping updates while
    // pairing; parallel multi-file writes are a common source of corrupt auth
    // state after a process crash or reconnect boundary.
    nextSock.ev.on('creds.update', () => {
      saveCredsQueue = saveCredsQueue
        .then(() => saveCreds())
        .catch((error) => {
          logger.error(
            { error, authDir: config.authDir },
            'WhatsApp credential persistence failed',
          );
        });
    });

    nextSock.ev.on('connection.update', (update) => {
      void handleConnectionUpdate(update).catch((error) => {
        logger.error(
          { error, feature: 'whatsapp' },
          'WhatsApp connection.update handler failed',
        );
      });
    });

    async function handleConnectionUpdate(
      update: Parameters<
        Parameters<typeof nextSock.ev.on<'connection.update'>>[1]
      >[0],
    ): Promise<void> {
      if (generation !== socketGeneration || sock !== nextSock) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 6,
          });
          if (generation !== socketGeneration || sock !== nextSock) return;
          setState({ status: 'qr', qr, qrDataUrl });
          logger.info(
            { feature: 'whatsapp' },
            'WhatsApp QR ready, awaiting scan',
          );
        } catch (err) {
          logger.warn({ err }, 'Failed to render WhatsApp QR data URL');
          setState({ status: 'qr', qr });
        }
      }

      if (connection === 'open') {
        reconnectAttempt = 0;
        const meJid = nextSock.user?.id;
        const meName = nextSock.user?.name ?? undefined;
        setState({ status: 'connected', meJid, meName });
        logger.info(
          { feature: 'whatsapp', meJid, meName },
          'WhatsApp connected',
        );
        try {
          opts?.onReady?.();
        } catch (err) {
          logger.warn({ err }, 'WhatsApp onReady callback threw');
        }
      }

      if (connection === 'close') {
        const boomErr = lastDisconnect?.error as Boom | undefined;
        const statusCode = boomErr?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const reason = boomErr?.message || `closed (code ${statusCode})`;

        logger.warn(
          { feature: 'whatsapp', statusCode, reason, intentionalDisconnect },
          'WhatsApp connection closed',
        );

        if (isLoggedOut) {
          setState({ status: 'logged_out', error: reason });
          // Auth state on disk is now invalid; user must re-scan QR
          // We do NOT auto-reconnect on logged_out — it would just yield a new QR
          // immediately and surprise the user. They re-enable from UI.
          sock = null;
          return;
        }

        setState({ status: 'disconnected', error: reason });
        if (sock === nextSock) sock = null;

        if (!intentionalDisconnect) {
          const delayMs = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
            RECONNECT_MAX_DELAY_MS,
          );
          reconnectAttempt += 1;
          logger.info(
            { feature: 'whatsapp', delayMs, reconnectAttempt },
            'Scheduling WhatsApp reconnect',
          );
          reconnectTimer = setTimeout(() => {
            if (generation !== socketGeneration || intentionalDisconnect)
              return;
            startSocket().catch((err) =>
              logger.error({ err }, 'WhatsApp reconnect failed'),
            );
          }, delayMs);
        }
      }
    }

    nextSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (generation !== socketGeneration || sock !== nextSock) return;
      // 'notify' = real-time incoming, 'append' = history sync (skip)
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          logger.error(
            { err, msgId: msg.key?.id },
            'WhatsApp message handler threw',
          );
        }
      }
    });

    // Group membership events: bot added/removed from groups
    nextSock.ev.on('group-participants.update', async (update) => {
      if (generation !== socketGeneration || sock !== nextSock) return;
      try {
        const selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
        if (!selfJid) return;
        const involvesSelf = update.participants.some(
          (participant) =>
            jidNormalizedUser(participant.phoneNumber ?? participant.id) ===
            selfJid,
        );
        if (!involvesSelf) return;

        const rawJid = `${CHANNEL_PREFIX}${update.id}`;
        const chatJid = opts?.normalizeIncomingJid?.(rawJid) ?? rawJid;
        if (update.action === 'add') {
          let chatName = update.id;
          try {
            const meta = await sock?.groupMetadata(update.id);
            if (meta?.subject) {
              chatName = meta.subject;
              groupNameCache.set(update.id, meta.subject);
            }
          } catch (err) {
            logger.debug(
              { err, jid: update.id },
              'group meta fetch failed on add',
            );
          }
          // Account-backed WhatsApp groups must pair explicitly. Merely adding
          // the bot must not silently create/authorize a CommerceAgent chat.
          if (!opts?.isChatAuthorized || opts.isChatAuthorized(chatJid)) {
            opts?.onBotAddedToGroup?.(chatJid, chatName);
          } else {
            logger.info(
              { chatJid, chatName },
              'WhatsApp bot added to unpaired group; awaiting /pair',
            );
          }
          logger.info({ chatJid, chatName }, 'WhatsApp bot added to group');
        } else if (update.action === 'remove') {
          opts?.onBotRemovedFromGroup?.(chatJid);
          groupNameCache.delete(update.id);
          logger.info({ chatJid }, 'WhatsApp bot removed from group');
        }
      } catch (err) {
        logger.warn(
          { err },
          'WhatsApp group-participants.update handler threw',
        );
      }
    });
  }

  /**
   * Detect and download a media message (image/video/audio/document).
   * Returns null if `content` has no supported media node.
   * Returns { content, attachmentsJson } shaped like dingtalk's normalize result.
   */
  async function tryHandleMediaMessage(
    msg: WAMessage,
    content: proto.IMessage,
    groupFolder: string | undefined,
  ): Promise<{ content: string; attachmentsJson?: string } | null> {
    const detected = detectMedia(content);
    if (!detected) return null;
    const { kind, label, node, defaultExt } = detected;

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: logger.child({ feature: 'whatsapp-media' }) as never,
          reuploadRequest: sock?.updateMediaMessage as never,
        },
      );
    } catch (err) {
      logger.warn(
        { err, kind, msgId: msg.key?.id },
        'WhatsApp media download failed',
      );
      const cap = node.caption ? `: ${node.caption}` : '';
      return { content: `[${label} 下载失败${cap}]` };
    }

    const captionLine = node.caption ? `\n${node.caption}` : '';

    if (!groupFolder) {
      // No workspace mapping for this chat — skip disk save, just signal what arrived
      return { content: `[${label}（未关联工作区）${captionLine}]` };
    }

    const fileName =
      (node as { fileName?: string }).fileName ||
      `wa_${kind}_${Date.now()}${extFromMime(node.mimetype) || defaultExt}`;

    let savedPath: string;
    try {
      savedPath = await saveDownloadedFile(
        groupFolder,
        'whatsapp',
        fileName,
        buffer,
      );
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        return {
          content: `[${label}: 文件过大未保存 ${(buffer.length / 1024 / 1024).toFixed(1)}MB${captionLine}]`,
        };
      }
      logger.warn({ err, kind, fileName }, 'WhatsApp media save failed');
      return { content: `[${label} 保存失败${captionLine}]` };
    }

    // Inline base64 for Vision when image fits
    let attachmentsJson: string | undefined;
    if (kind === 'image' && buffer.length <= IMAGE_MAX_BASE64_SIZE) {
      attachmentsJson = JSON.stringify([
        {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType: node.mimetype || 'image/jpeg',
        },
      ]);
    }

    return {
      content: `[${label}: ${savedPath}]${captionLine}`,
      attachmentsJson,
    };
  }

  /** Convert one baileys WAMessage into our IM pipeline (storeMessageDirect + broadcast). */
  async function handleIncomingMessage(msg: WAMessage): Promise<void> {
    if (!opts) return;
    const { key, message: content, pushName, messageTimestamp } = msg;
    if (!key || !content) return;
    if (key.fromMe) return; // 自己发的消息不回流

    const remoteJid = key.remoteJid;
    if (!remoteJid) return;

    // newsletter / status broadcasts and unrelated system jids — skip
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
      return;
    }

    // Global stale-message drop (>30min). Independent of reconnect filter
    // below; handles edge cases like webhook retries delivering an hour late.
    const tsMs = normalizeTimestamp(messageTimestamp);
    if (isStale(tsMs)) {
      logger.debug(
        { msgId: key.id, remoteJid, tsMs },
        'Stale WhatsApp message (>30min), dropping',
      );
      return;
    }

    // LRU dedup + in-flight lock: skip duplicates that re-arrive at reconnect
    // / stream-switch boundaries. Keyed by (remoteJid, key.id) because Baileys
    // reuses key.id across chats. Messages without key.id bypass both checks
    // (no way to address them reliably).
    const dedupKey = key.id ? `${remoteJid}|${key.id}` : '';
    if (dedupKey) {
      if (isDuplicate(dedupKey)) {
        logger.debug(
          { msgId: key.id, remoteJid },
          'WhatsApp duplicate dropped',
        );
        return;
      }
      if (!processingLock.acquire(dedupKey)) {
        logger.debug(
          { msgId: key.id, remoteJid },
          'WhatsApp message already in-flight, skipping',
        );
        return;
      }
      markSeen(dedupKey);
    }
    try {
      // Filter old messages (heat-up after reconnect, history sync stragglers)
      if (
        tsMs > 0 &&
        opts.ignoreMessagesBefore &&
        tsMs < opts.ignoreMessagesBefore
      ) {
        return;
      }

      // Unwrap ephemeral / view-once envelopes once so text, media, and mention
      // detection all see the real inner message (they otherwise diverge).
      const inner = unwrapMessageContent(content);
      let text = extractMessageText(inner);
      const rawChatJid = `${CHANNEL_PREFIX}${remoteJid}`;
      const chatJid = opts.normalizeIncomingJid?.(rawChatJid) ?? rawChatJid;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderRaw = isGroup ? key.participant || remoteJid : remoteJid;
      const senderImId = jidNormalizedUser(senderRaw);
      const senderId = `${CHANNEL_PREFIX}${senderRaw}`;
      const senderName = pushName || (isGroup ? '群成员' : remoteJid);
      const chatName =
        groupNameCache.get(remoteJid) || (isGroup ? remoteJid : senderName);
      const timestampISO = new Date(tsMs > 0 ? tsMs : Date.now()).toISOString();

      // Pairing/authorization is the first stateful gate. Unpaired traffic must
      // not create a chat, write metadata, resolve a workspace, or download
      // media. Pairing itself registers the chat against the account's default
      // workspace through buildOnPairAttempt.
      const admission = await evaluateChannelAdmission({
        jid: chatJid,
        chatName,
        text: text ?? '',
        isChatAuthorized: opts.isChatAuthorized,
        onPairAttempt: opts.onPairAttempt,
      });
      if (admission.kind === 'paired') {
        await sock?.sendMessage(remoteJid, {
          text: '配对成功！此聊天已连接到你的工作区。',
        });
        return;
      }
      if (admission.kind === 'pair_rejected') {
        await sock?.sendMessage(remoteJid, {
          text: '配对码无效或已过期，请在 Web 设置页重新生成。',
        });
        return;
      }
      if (admission.kind === 'deny') {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(chatJid) ?? 0;
        if (now - lastReject >= 60_000) {
          rejectTimestamps.set(chatJid, now);
          await sock?.sendMessage(remoteJid, {
            text: '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
          });
        }
        logger.debug({ chatJid }, 'WhatsApp chat not authorized');
        return;
      }

      // ── Group gates: sender allowlist → mention required → owner check ──
      if (isGroup) {
        if (
          opts.isSenderAllowedInGroup &&
          !opts.isSenderAllowedInGroup(chatJid, senderImId)
        ) {
          logger.debug(
            { chatJid, senderImId },
            'WhatsApp dropped: sender not allowlisted',
          );
          return;
        }

        const isBotMentioned = isMentioningBot(inner, sock?.user?.id);
        if (
          opts.shouldProcessGroupMessage &&
          !isBotMentioned &&
          !opts.shouldProcessGroupMessage(chatJid, senderImId)
        ) {
          logger.debug(
            { chatJid, senderImId },
            'WhatsApp dropped: mention required but bot not @mentioned',
          );
          return;
        }
        if (
          isBotMentioned &&
          opts.isGroupOwnerMessage &&
          !opts.isGroupOwnerMessage(chatJid, senderImId)
        ) {
          logger.debug(
            { chatJid, senderImId },
            'WhatsApp dropped: owner_mentioned mode, sender is not group owner',
          );
          return;
        }
        if (isBotMentioned && text) {
          text = stripLeadingWhatsAppBotMention(text, inner, sock?.user?.id);
        }
      }

      // Control commands may repair/change a binding. Consume them before
      // route validation; media must not be downloaded for a stale route.
      const commandText = text?.trim() ?? '';
      const slashMatch = commandText.match(/^\/(\S+)(?:\s+(.*))?$/s);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(chatJid, cmdBody, senderImId);
          if (reply !== null && reply !== undefined) {
            if (sock) {
              try {
                await sock.sendMessage(remoteJid, { text: reply });
              } catch (err) {
                logger.warn(
                  { err, chatJid },
                  'WhatsApp slash reply send failed',
                );
              }
            }
            return;
          }
        } catch (err) {
          logger.error(
            { err, chatJid, cmd: slashMatch[1] },
            'WhatsApp slash command failed',
          );
        }
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        chatJid,
        opts.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { chatJid },
          'WhatsApp message dropped: binding resolver rejected route',
        );
        return;
      }
      const { targetJid, routing } = resolvedRoute;

      // Only admitted, policy-approved, routable chats may mutate metadata or
      // start provider/network side effects.
      storeChatMetadata(chatJid, timestampISO);
      updateChatName(chatJid, chatName);
      opts.onNewChat(chatJid, chatName);
      if (isGroup && !groupNameCache.has(remoteJid)) {
        groupNameCache.set(remoteJid, remoteJid);
        void resolveGroupName(remoteJid);
      }

      // Handle media (image/video/audio/document) whenever the message carries
      // it — NOT only when there's no text. A captioned image/video has non-empty
      // `text` (extractMessageText reads the caption), so gating on `!finalContent`
      // would skip the download entirely (media lost + no Vision inlining).
      // tryHandleMediaMessage already folds the caption into its returned content.
      // tryHandleMediaMessage returns null only when `inner` carries no supported
      // media (its first step is detectMedia), so calling it unconditionally folds
      // the media probe + download into one pass — no second detectMedia, no
      // duplicated "neither text nor media" branch.
      let finalContent = text;
      let attachmentsJson: string | undefined;
      const media = await tryHandleMediaMessage(
        msg,
        inner,
        opts.resolveGroupFolder?.(chatJid),
      );
      if (media) {
        finalContent = media.content;
        attachmentsJson = media.attachmentsJson;
      }
      if (!finalContent) {
        logger.debug(
          { remoteJid, msgId: key.id, types: Object.keys(inner) },
          'WhatsApp message has neither text nor supported media',
        );
        return;
      }

      const id = crypto.randomUUID();

      storeChatMetadata(targetJid, timestampISO);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        finalContent,
        timestampISO,
        false,
        { attachments: attachmentsJson, sourceJid: chatJid },
      );

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: chatJid,
          sender: senderId,
          sender_name: senderName,
          content: finalContent,
          timestamp: timestampISO,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        routing?.agentId ?? undefined,
      );
      notifyNewImMessage();

      if (routing?.agentId) {
        opts.onAgentMessage?.(chatJid, routing.agentId);
        logger.info(
          { chatJid, effectiveJid: targetJid, agentId: routing.agentId },
          'WhatsApp message routed to conversation agent',
        );
      } else {
        logger.info(
          { chatJid, sender: senderName, msgId: key.id, isGroup },
          'WhatsApp message stored',
        );
      }
    } finally {
      if (dedupKey) processingLock.release(dedupKey);
    }
  }

  return {
    async connect(connectOpts: WhatsAppConnectOpts): Promise<void> {
      opts = connectOpts;
      intentionalDisconnect = false;
      await startSocket();
    },

    async disconnect(): Promise<void> {
      intentionalDisconnect = true;
      socketGeneration += 1;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const currentSock = sock;
      sock = null;
      await closeWhatsAppSocketSafely(currentSock);
      await saveCredsQueue;
      ambientProxyAgent?.destroy();
      processingLock.dispose();
      setState({ status: 'disconnected' });
    },

    async logout(): Promise<void> {
      intentionalDisconnect = true;
      socketGeneration += 1;
      const currentSock = sock;
      sock = null;
      if (currentSock) {
        try {
          await currentSock.logout();
        } catch (err) {
          logger.warn({ err }, 'WhatsApp logout threw');
        }
        await closeWhatsAppSocketSafely(currentSock);
      }
      await saveCredsQueue;
      ambientProxyAgent?.destroy();
      // Note: auth files on disk remain; caller (im-manager) wipes authDir if needed
      setState({ status: 'logged_out' });
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      assertWhatsAppSocketConnected(sock, currentState);
      const jid = stripChannelPrefix(chatId);

      // Strip markdown to WhatsApp plain text (matches dingtalk/wechat/qq pattern).
      // WhatsApp DOES support its own markdown subset (*bold*/_italic_/~strike~)
      // but Claude output uses standard markdown — converting in-place is fragile,
      // so we pick the safe option: drop formatting, send plain text.
      const plain = markdownToPlainText(text);
      const chunks = splitTextChunks(plain, TEXT_CHUNK_LIMIT);

      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk =
            chunks.length > 1
              ? `${chunks[i]}\n\n(${i + 1}/${chunks.length})`
              : chunks[i];
          await sock.sendMessage(jid, { text: chunk });
          // Throttle between chunks to stay under WhatsApp Web's anti-spam
          // burst threshold; same reason qq/dingtalk soft-throttle bulk sends.
          if (i < chunks.length - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, CHUNK_SEND_DELAY_MS),
            );
          }
        }

        if (localImagePaths && localImagePaths.length > 0) {
          for (const imgPath of localImagePaths) {
            try {
              const buf = await readFile(imgPath);
              const mime = guessMimeType(imgPath) || 'image/jpeg';
              await sock.sendMessage(jid, { image: buf, mimetype: mime });
            } catch (err) {
              logger.error(
                { err, imgPath, chatId },
                'WhatsApp local image attach failed',
              );
              throw err;
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId },
          'WhatsApp sendMessage failed',
        );
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
      assertWhatsAppSocketConnected(sock, currentState);
      const jid = stripChannelPrefix(chatId);
      try {
        await sock.sendMessage(jid, {
          image: imageBuffer,
          mimetype: mimeType,
          caption: caption ? markdownToPlainText(caption) : undefined,
          fileName,
        });
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId },
          'WhatsApp sendImage failed',
        );
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      assertWhatsAppSocketConnected(sock, currentState);
      const jid = stripChannelPrefix(chatId);
      try {
        const buf = await readFile(filePath);
        const mime = guessMimeType(fileName) || 'application/octet-stream';
        await sock.sendMessage(jid, {
          document: buf,
          mimetype: mime,
          fileName,
        });
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId, filePath },
          'WhatsApp sendFile failed',
        );
        throw err;
      }
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!sock) return;
      const jid = stripChannelPrefix(chatId);
      try {
        await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
      } catch (err) {
        logger.debug({ err, chatId }, 'WhatsApp sendPresenceUpdate failed');
      }
    },

    isConnected(): boolean {
      return currentState.status === 'connected' && sock !== null;
    },

    getState(): WhatsAppConnectionState {
      return currentState;
    },
  };
}

/** Compute the auth state directory for a given user / account. */
const SAFE_AUTH_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function safeAuthPathSegment(
  value: string | undefined,
  fallback?: string,
): string {
  const resolved = value || fallback;
  if (!resolved || !SAFE_AUTH_PATH_SEGMENT.test(resolved)) {
    throw new Error('Invalid WhatsApp auth path segment');
  }
  return resolved;
}

export function getWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  accountId = 'default',
): string {
  const safeUserId = safeAuthPathSegment(userId);
  const safeAccountId = safeAuthPathSegment(accountId, 'default');
  const root = path.resolve(
    dataDir,
    'config',
    'user-im',
    safeUserId,
    'whatsapp-auth',
  );
  const candidate = path.resolve(root, safeAccountId);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('WhatsApp auth directory escaped its account root');
  }
  return candidate;
}

/** Move a legacy singleton auth state to the immutable channel-account id. */
export function migrateLegacyWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  legacyAccountId: string | undefined,
  channelAccountId: string,
): boolean {
  if (!legacyAccountId || legacyAccountId === channelAccountId) return false;
  let source: string;
  let destination: string;
  try {
    source = getWhatsAppAuthDir(dataDir, userId, legacyAccountId);
    destination = getWhatsAppAuthDir(dataDir, userId, channelAccountId);
  } catch {
    // Legacy config is untrusted. Invalid paths are ignored without touching
    // any filesystem location, especially paths outside the auth root.
    return false;
  }
  if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(source, destination, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  return true;
}

/**
 * Strip ephemeral / view-once envelopes so the real inner message is exposed.
 * extractMessageText recurses through these on its own, but detectMedia and
 * isMentioningBot only inspect top-level nodes — so a disappearing-message photo
 * (`ephemeralMessage.message.imageMessage`, increasingly the Meta default) would
 * never be downloaded and @mentions inside a wrapper would be missed. Unwrap once
 * up front and feed the inner content to all of them. Bounded to avoid a
 * pathological/cyclic payload spinning forever.
 */
export function unwrapMessageContent(content: proto.IMessage): proto.IMessage {
  let inner = content;
  for (let i = 0; i < 5; i++) {
    // Mirror baileys' getFutureProofMessage (Utils/messages.js): a captioned
    // document arrives as documentWithCaptionMessage; edits/view-once-extension
    // wrap too. Missing any of these drops the message — e.g. a PDF WITH a
    // caption (documentWithCaptionMessage) would extract no text and detect no
    // media, while the same PDF without a caption (bare documentMessage) works.
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message ||
      inner.viewOnceMessageV2?.message ||
      inner.viewOnceMessageV2Extension?.message ||
      inner.documentWithCaptionMessage?.message ||
      inner.editedMessage?.message;
    if (!next) break;
    inner = next;
  }
  return inner;
}

/**
 * Extract human-readable text from a baileys IMessage payload.
 * Returns null for unsupported message types (image/audio/video/document — M3 scope).
 */
export function extractMessageText(content: proto.IMessage): string | null {
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text)
    return content.extendedTextMessage.text;
  // Sometimes ephemeral / view-once wrap the inner content
  if (content.ephemeralMessage?.message) {
    return extractMessageText(content.ephemeralMessage.message);
  }
  if (content.viewOnceMessage?.message) {
    return extractMessageText(content.viewOnceMessage.message);
  }
  if (content.viewOnceMessageV2?.message) {
    return extractMessageText(content.viewOnceMessageV2.message);
  }
  // Image / video / document with caption — treat caption as the message text
  // so the user at least sees what was sent. Media binary download is M3.
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  return null;
}

/**
 * Baileys `messageTimestamp` may be number, Long, or undefined. Convert to ms.
 * Returns 0 if not a usable value (caller falls back to Date.now()).
 */
export function normalizeTimestamp(
  ts: number | { toNumber(): number } | null | undefined,
): number {
  if (ts === null || ts === undefined) return 0;
  if (typeof ts === 'number') return ts * 1000;
  // Long.js-like object exposes toNumber()
  if (typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber() * 1000;
  }
  return 0;
}

interface DetectedMedia {
  kind: 'image' | 'video' | 'audio' | 'document';
  label: string;
  defaultExt: string;
  node: {
    mimetype?: string | null;
    caption?: string | null;
    fileName?: string | null;
  };
}

function detectMedia(content: proto.IMessage): DetectedMedia | null {
  if (content.imageMessage) {
    return {
      kind: 'image',
      label: '图片',
      defaultExt: '.jpg',
      node: content.imageMessage as DetectedMedia['node'],
    };
  }
  if (content.videoMessage) {
    return {
      kind: 'video',
      label: '视频',
      defaultExt: '.mp4',
      node: content.videoMessage as DetectedMedia['node'],
    };
  }
  if (content.audioMessage) {
    const isPtt = (content.audioMessage as { ptt?: boolean | null }).ptt;
    return {
      kind: 'audio',
      label: isPtt ? '语音' : '音频',
      defaultExt: '.ogg',
      node: content.audioMessage as DetectedMedia['node'],
    };
  }
  if (content.documentMessage) {
    return {
      kind: 'document',
      label: '文档',
      defaultExt: '',
      node: content.documentMessage as DetectedMedia['node'],
    };
  }
  return null;
}

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  if (m.includes('webm')) return '.webm';
  if (m.includes('mpeg') && m.startsWith('audio')) return '.mp3';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('aac')) return '.aac';
  if (m.includes('wav')) return '.wav';
  if (m.includes('pdf')) return '.pdf';
  return null;
}

export function stripChannelPrefix(chatId: string): string {
  return chatId.startsWith(CHANNEL_PREFIX)
    ? chatId.slice(CHANNEL_PREFIX.length)
    : chatId;
}

/**
 * Check if a baileys message @mentions the bot itself.
 *
 * Mentioning lives in `extendedTextMessage.contextInfo.mentionedJid` (string[]).
 * Self jid format from sock.user.id includes a device suffix
 * (e.g. `15551234567:42@s.whatsapp.net`) — normalize both sides before compare.
 */
export function isMentioningBot(
  content: proto.IMessage,
  selfJid: string | null | undefined,
): boolean {
  // Fail closed: 当 selfJid 暂时不可用（reconnect 间隙、auth 状态未就绪），
  // 从前的 fail-open 让 require_mention 模式短暂被绕过——攻击者可在 socket
  // 启动毫秒级窗口中把所有群消息都被处理。一致性优先：没法确认时按"未被
  // mention"处理，主消息处理流会丢弃。和 feishu 实现的语义对齐。
  if (!selfJid) return false;
  const selfNorm = jidNormalizedUser(selfJid);
  const ctx =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.audioMessage?.contextInfo;
  const mentioned = ctx?.mentionedJid;
  if (!mentioned || mentioned.length === 0) return false;
  return mentioned.some((m) => jidNormalizedUser(m) === selfNorm);
}

/** Remove a leading WhatsApp display token only when trusted message metadata
 * says the same account was mentioned. Mention-only messages retain their
 * original text instead of becoming an empty durable message. */
export function stripLeadingWhatsAppBotMention(
  text: string,
  content: proto.IMessage,
  selfJid: string | null | undefined,
): string {
  if (!selfJid || !isMentioningBot(content, selfJid)) return text;
  const selfSubject = jidNormalizedUser(selfJid).split('@', 1)[0];
  if (!selfSubject) return text;
  const normalized = text.trimStart();
  const displayToken = `@${selfSubject}`;
  if (!normalized.startsWith(displayToken)) return text;
  const next = normalized.charAt(displayToken.length);
  if (next && !/\s/.test(next)) return text;
  const remainder = normalized.slice(displayToken.length).trimStart();
  return remainder || text;
}

/**
 * Tiny mime type lookup based on file extension.
 * Covers WhatsApp-relevant types: image/video/audio/document.
 * Returns null when unknown so caller can fall back to a sensible default.
 */
export function guessMimeType(fileName: string): string | null {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  // Image
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  // Video
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  // Audio
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (ext === 'm4a' || ext === 'aac') return 'audio/aac';
  if (ext === 'wav') return 'audio/wav';
  // Document
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx')
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx')
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  if (ext === 'pptx')
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === 'zip') return 'application/zip';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  return null;
}
