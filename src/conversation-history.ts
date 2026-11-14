import { getMessagesPage } from './db.js';
import { escapeXml } from './message-prompt.js';
import {
  buildSessionMigrationContext,
  resolveMigrationBudgetChars,
  type SessionMigrationStats,
} from './session-migration.js';
import {
  findSessionTranscript,
  readSessionTranscript,
} from './session-transcript.js';

export interface ConversationHistoryTranscriptSource {
  /** `data/sessions/{folder}[/agents/{agentId}]/.claude` */
  sessionsDir: string;
  /** 旧 SDK session id；崩溃恢复路径可能拿不到，此时取最近修改的 transcript。 */
  sessionId?: string | null;
}

export interface ConversationHistoryOptions {
  intro: string;
  /**
   * 总长度预算（字符，约等于 token × 3~4）。transcript 结构化迁移与聊天记录
   * 回退共用这一个预算，默认读取 COMMERCEAGENT_SESSION_MIGRATION_BUDGET_CHARS，
   * 再回退到 shared 默认值（24000 字符）。
   */
  maxChars?: number | string | null;
  /** 回退到聊天记录时单条消息的长度上限，默认 4000 字符。 */
  maxMessageChars?: number;
  /** 回退到聊天记录时从 DB 抓取的消息条数上限，默认 200 条。 */
  messageFetchLimit?: number;
  /**
   * 旧 SDK transcript 来源。Host 能读到该工作区的 `.claude/projects/**` 时
   * 优先用结构化迁移上下文；读不到则回退到持久化聊天记录。
   */
  transcript?: ConversationHistoryTranscriptSource | null;
}

export interface ConversationHistoryContext {
  context: string;
  count: number;
  messageIds: string[];
  /** `transcript` = 结构化迁移；`messages` = 旧聊天记录回退。 */
  source: 'transcript' | 'messages';
  stats?: SessionMigrationStats;
}

const DEFAULT_MESSAGE_FETCH_LIMIT = 200;
const DEFAULT_MAX_MESSAGE_CHARS = 4000;
const MIN_REMAINING_CHARS = 200;

/** 孤立代理项清理 + `</system_context>` 中和，和 shared/session-migration.ts 一致。 */
function sanitizeHistoryText(text: string): string {
  return text
    .replace(
      /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g,
      '',
    )
    .replace(/<\/system_context>/gi, '</system_context_>');
}

/**
 * 旧 SDK transcript → 结构化迁移上下文。拿不到 transcript 或解析不出内容时
 * 返回 null，调用方继续走聊天记录回退。
 */
function buildTranscriptHistoryContext(
  source: ConversationHistoryTranscriptSource,
  maxChars: number | string | null | undefined,
): ConversationHistoryContext | null {
  const file = findSessionTranscript(source.sessionsDir, source.sessionId);
  if (!file) return null;
  const raw = readSessionTranscript(file);
  if (!raw) return null;

  const migration = buildSessionMigrationContext(raw, {
    budgetChars: maxChars,
  });
  if (!migration) return null;

  return {
    context: migration.context,
    count:
      migration.stats.userRequests +
      migration.stats.assistantConclusions +
      migration.stats.toolCalls,
    // transcript 迁移不按 DB message id 去重：当前轮消息由 pendingMessageIds
    // 排除，历史内容来自 transcript 而非 messages 表。
    messageIds: [],
    source: 'transcript',
    stats: migration.stats,
  };
}

/**
 * Build a `<system_context>` block of recent persisted CommerceAgent chat history
 * to prepend to a prompt when the underlying Claude SDK session is fresh
 * (recovery after a crash, or after switching provider/model so the old
 * thinking-block-bearing session was cleared). Without this the new model sees
 * an empty conversation and loses context the user already established.
 *
 * 拿得到旧 transcript 时，优先用 shared/session-migration.ts 的结构化迁移
 * （用户要求 / 结论 / 工具调用摘要 / TodoWrite 进度 / compact summary），
 * 与 agent-runner 的 resume 失败路径输出逐字节一致；否则回退到持久化聊天
 * 记录，并按总长度预算取尽可能多的最近消息。
 *
 * Shared by the orchestration layer (index.ts: recovery + agent fresh-session)
 * and the container/host runner (proactive provider switch that clears the
 * session).
 */
export function buildRecentConversationHistoryContext(
  chatJid: string,
  pendingMessageIds: Set<string>,
  opts: ConversationHistoryOptions,
): ConversationHistoryContext | null {
  const maxChars = resolveMigrationBudgetChars(opts.maxChars);

  if (opts.transcript) {
    const migrated = buildTranscriptHistoryContext(opts.transcript, maxChars);
    if (migrated) return migrated;
  }

  const messageFetchLimit =
    opts.messageFetchLimit ?? DEFAULT_MESSAGE_FETCH_LIMIT;
  const maxMessageChars = opts.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;

  // DB 按时间倒序返回；先按“最新优先”在预算内挑选，最后再翻回正序渲染。
  const recentHistory = getMessagesPage(chatJid, undefined, messageFetchLimit)
    .reverse()
    .filter((m) => !pendingMessageIds.has(m.id))
    .filter((m) => m.content.trim().length > 0);

  if (recentHistory.length === 0) return null;

  const prelude =
    '<system_context>\n' +
    opts.intro +
    '\n重要：这些只是 CommerceAgent 持久化的历史聊天记录，用来在新模型/新 session 中恢复上下文。回答当前用户消息时，请优先依据当前消息和当前文件状态；如果历史与当前问题无关，请直接忽略。\n\n';
  const suffix = '\n</system_context>\n\n';

  // 最新优先挑：按渲染后的实际长度（含 XML 转义）扣预算，选完再翻回正序。
  let remaining = Math.max(
    MIN_REMAINING_CHARS,
    maxChars - prelude.length - suffix.length,
  );
  const historyLines: string[] = [];
  const selectedIds: string[] = [];
  for (let i = recentHistory.length - 1; i >= 0; i -= 1) {
    if (remaining <= MIN_REMAINING_CHARS) break;
    const m = recentHistory[i];
    const cap = Math.min(maxMessageChars, remaining);
    const body =
      m.content.length > cap ? `${m.content.slice(0, cap)}…` : m.content;
    // Strip lone (unpaired) surrogates while preserving valid surrogate pairs
    // such as emoji, then neutralise the closing tag that fences this block.
    const cleaned = sanitizeHistoryText(body);
    const role = m.is_from_me ? 'assistant' : 'user';
    const sender = m.is_from_me ? 'CommerceAgent' : m.sender_name;
    const line =
      `<history_message id="${escapeXml(m.id)}" role="${role}"` +
      ` sender="${escapeXml(sender)}">${escapeXml(cleaned)}</history_message>`;
    if (line.length + 1 > remaining && historyLines.length > 0) break;
    historyLines.push(line);
    selectedIds.push(m.id);
    remaining -= line.length + 1;
  }
  historyLines.reverse();
  selectedIds.reverse();

  return {
    count: historyLines.length,
    messageIds: selectedIds,
    source: 'messages',
    context: prelude + historyLines.join('\n') + suffix,
  };
}
