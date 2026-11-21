/**
 * 结构化会话迁移上下文（Session Migration Context）。
 *
 * 当底层 SDK 会话确实无法续接时（resume 失败、崩溃恢复、provider 轮换后清洗
 * thinking 块），新会话需要知道旧会话做过什么。旧行为只是把最近 N 条聊天记录
 * 截断回放，既丢失工具调用链，也看不到进度。本模块直接把旧 transcript JSONL
 * 提炼成结构化摘要：
 *
 * - 用户提出的要求（尽量完整保留）；
 * - assistant 的结论性回复；
 * - 工具调用摘要（工具名 + 关键参数 + 结果摘要）；
 * - 最近一次 compact summary；
 * - 任务进度（最新 TodoWrite 状态）。
 *
 * 本文件是唯一真相源：通过 `make sync-types` 同步到 `src/session-migration.ts`
 * 与 `container/agent-runner/src/session-migration.ts`，Host 与 Runner 两侧
 * 输出必须逐字节一致。因此这里**不能**依赖 fs/path 或任何 Node 内建模块，
 * 只接收 transcript 文本。
 */

/** 孤立代理项（lone surrogate）清理正则；与各处截断路径保持同一份定义。 */
export const LONE_SURROGATE_RE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/g;

const SYSTEM_CONTEXT_CLOSE_RE = /<\/system_context>/gi;

/**
 * 截断后的文本可能切到 emoji 中间，必须清理孤立代理项；同时把用于围栏的
 * `</system_context>` 中和掉，避免历史内容提前闭合注入块。
 */
export function sanitizeMigrationText(text: string): string {
  return text
    .replace(LONE_SURROGATE_RE, '')
    .replace(SYSTEM_CONTEXT_CLOSE_RE, '</system_context_>');
}

/** 总预算（字符数，约等于 token × 3~4）的环境变量名。Host 与 Runner 各自读取自身进程环境。 */
export const MIGRATION_BUDGET_ENV =
  'COMMERCEAGENT_SESSION_MIGRATION_BUDGET_CHARS';

/** 默认总预算 24000 字符 ≈ 6k tokens。 */
export const DEFAULT_MIGRATION_BUDGET_CHARS = 24000;
export const MIN_MIGRATION_BUDGET_CHARS = 2000;
export const MAX_MIGRATION_BUDGET_CHARS = 200000;

/** 各段预算占比。分配按优先级顺序进行，未用尽的额度顺延给后面的段。 */
const SECTION_SHARE = {
  requests: 0.5,
  conclusions: 0.15,
  tools: 0.15,
  todos: 0.06,
  compact: 0.14,
} as const;

const LIMITS = {
  /** 外框文案预留，避免总长超预算。 */
  framingReserveChars: 900,
  /** 单条用户要求的上限；比结论/工具结果宽松得多。 */
  maxRequestChars: 4000,
  maxConclusionChars: 1500,
  maxToolResultChars: 900,
  maxToolInputChars: 220,
  /** 工具调用最多列出多少条；超出的更早调用只记工具名。 */
  maxToolCalls: 40,
  /** 低于该长度的剩余预算不再继续塞内容。 */
  minRemainingChars: 160,
} as const;

export interface SessionMigrationOptions {
  /** 总长度预算（字符）。默认读取 MIGRATION_BUDGET_ENV，再回退到 DEFAULT_MIGRATION_BUDGET_CHARS。 */
  budgetChars?: number | string | null;
  /** 覆盖单条用户要求上限（字符）。 */
  maxRequestChars?: number;
  /** 覆盖单条工具结果上限（字符）。 */
  maxToolResultChars?: number;
  /** 覆盖工具调用条数上限。 */
  maxToolCalls?: number;
}

export interface SessionMigrationStats {
  userRequests: number;
  assistantConclusions: number;
  toolCalls: number;
  toolResults: number;
  compactSummaries: number;
  todos: number;
  /** 因预算被整体丢弃的用户要求 / 工具调用条数。 */
  droppedUserRequests: number;
  droppedToolCalls: number;
  budgetChars: number;
  contextChars: number;
}

export interface SessionMigrationResult {
  /** 可直接前置到 prompt 的 `<system_context>` 块（以两个换行结尾）。 */
  context: string;
  stats: SessionMigrationStats;
}

export function resolveMigrationBudgetChars(
  value?: number | string | null,
): number {
  const clamp = (n: number): number =>
    Math.min(
      MAX_MIGRATION_BUDGET_CHARS,
      Math.max(MIN_MIGRATION_BUDGET_CHARS, Math.round(n)),
    );

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return clamp(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return clamp(parsed);
  }
  const envRaw =
    typeof process !== 'undefined' ? process.env?.[MIGRATION_BUDGET_ENV] : '';
  if (envRaw) {
    const parsed = Number(String(envRaw).trim());
    if (Number.isFinite(parsed) && parsed > 0) return clamp(parsed);
  }
  return DEFAULT_MIGRATION_BUDGET_CHARS;
}

// ─── transcript 解析 ──────────────────────────────────────────────

interface ToolCall {
  id: string;
  name: string;
  inputSummary: string;
  order: number;
  resultText: string | null;
  isError: boolean;
}

interface ExtractedTranscript {
  requests: string[];
  conclusions: string[];
  toolCalls: ToolCall[];
  compactSummaries: string[];
  todos: string[] | null;
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 去掉平台每轮注入的噪声，避免挤占预算：
 * - `[当前时间: ...]` 行；
 * - `<workspace_owner_profile ...>...</workspace_owner_profile>` 块；
 * - 之前恢复时注入的 `<system_context>...</system_context>` 块（否则迁移摘要
 *   会把上一份迁移摘要当成用户原话再抄一遍）。
 */
function stripPromptNoise(text: string): string {
  return text
    .replace(/<system_context>[\s\S]*?<\/system_context_?>/gi, ' ')
    .replace(
      /<workspace_owner_profile\b[^>]*>[\s\S]*?<\/workspace_owner_profile>/gi,
      ' ',
    )
    .replace(/^[ \t]*\[当前时间:[^\]]*\][ \t]*$/gm, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从 content（字符串或 block 数组）中取出文本块，忽略 tool_result 等非文本块。 */
function textFromBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const block of asArray(content)) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      texts.push(rec.text);
    }
  }
  return texts.join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of asArray(content)) {
    const rec = asRecord(block);
    if (!rec) continue;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push(rec.text);
    } else if (rec.type === 'image') {
      parts.push('[图片]');
    } else if (typeof rec.type === 'string') {
      parts.push(`[${rec.type}]`);
    }
  }
  return parts.join('\n');
}

function compactValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[object]';
    }
  }
  return String(value);
}

const PRIMARY_INPUT_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'glob',
  'url',
  'query',
  'description',
  'subject',
  'skill',
  'agent',
  'name',
  'prompt',
] as const;

/** 工具参数摘要：已知主键优先，其余键补齐，总长受 maxToolInputChars 约束。 */
function summarizeToolInput(input: unknown, maxChars: number): string {
  if (input == null) return '';
  if (typeof input === 'string') {
    return clampText(input, maxChars);
  }
  const rec = asRecord(input);
  if (!rec) return clampText(String(input), maxChars);

  const parts: string[] = [];
  for (const key of PRIMARY_INPUT_KEYS) {
    if (rec[key] === undefined || rec[key] === null) continue;
    parts.push(`${key}=${compactValue(rec[key])}`);
  }
  const used = new Set<string>(PRIMARY_INPUT_KEYS);
  for (const key of Object.keys(rec)) {
    if (used.has(key) || key === 'todos') continue;
    if (rec[key] === undefined || rec[key] === null) continue;
    parts.push(`${key}=${compactValue(rec[key])}`);
  }
  return clampText(parts.join(', '), maxChars);
}

function todoLines(input: unknown): string[] | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const todos = asArray(rec.todos);
  if (todos.length === 0) return null;
  const lines: string[] = [];
  for (const todo of todos) {
    const t = asRecord(todo);
    if (!t) continue;
    const content = typeof t.content === 'string' ? t.content : '';
    if (!content) continue;
    const status = typeof t.status === 'string' ? t.status : '';
    const mark =
      status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]';
    lines.push(`${mark} ${content}`);
  }
  return lines.length > 0 ? lines : null;
}

/**
 * 单遍扫描 transcript JSONL。容错优先：坏行跳过，单条 entry 解析失败不影响
 * 整体迁移。
 */
function extractTranscript(raw: string): ExtractedTranscript {
  const requests: string[] = [];
  const conclusions: string[] = [];
  const toolCalls: ToolCall[] = [];
  const pendingResults = new Map<string, { text: string; isError: boolean }>();
  const compactSummaries: string[] = [];
  let todos: string[] | null = null;
  let order = 0;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: AnyRecord;
    try {
      entry = JSON.parse(line) as AnyRecord;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    // 子代理（sidechain）的 transcript 混在主文件里，不属于主对话上下文。
    if (entry.isSidechain === true) continue;

    const type = entry.type;

    if (type === 'summary') {
      // 旧版 CLI 的会话摘要条目。
      if (typeof entry.summary === 'string' && entry.summary.trim()) {
        compactSummaries.push(entry.summary);
      }
      continue;
    }

    const message = asRecord(entry.message);
    if (!message) continue;
    const content = message.content;

    if (type === 'user') {
      if (entry.isCompactSummary === true) {
        const summaryText = textFromBlocks(content);
        if (summaryText.trim()) compactSummaries.push(summaryText);
        continue;
      }
      if (entry.isMeta === true) continue;

      if (Array.isArray(content)) {
        for (const block of content) {
          const rec = asRecord(block);
          if (!rec || rec.type !== 'tool_result') continue;
          const id = typeof rec.tool_use_id === 'string' ? rec.tool_use_id : '';
          if (!id) continue;
          pendingResults.set(id, {
            text: toolResultText(rec.content),
            isError: rec.is_error === true,
          });
        }
      }

      const clean = stripPromptNoise(textFromBlocks(content));
      if (clean) requests.push(clean);
      continue;
    }

    if (type === 'assistant') {
      const textParts: string[] = [];
      for (const block of asArray(content)) {
        const rec = asRecord(block);
        if (!rec) continue;
        if (rec.type === 'text' && typeof rec.text === 'string') {
          textParts.push(rec.text);
        } else if (rec.type === 'tool_use') {
          const name = typeof rec.name === 'string' ? rec.name : 'unknown';
          const id = typeof rec.id === 'string' ? rec.id : `call-${order}`;
          if (name === 'TodoWrite') {
            const lines = todoLines(rec.input);
            if (lines) todos = lines;
          }
          toolCalls.push({
            id,
            name,
            inputSummary: summarizeToolInput(
              rec.input,
              LIMITS.maxToolInputChars,
            ),
            order: order++,
            resultText: null,
            isError: false,
          });
        }
      }
      const text = textParts.join('\n').trim();
      if (text) conclusions.push(text);
    }
  }

  for (const call of toolCalls) {
    const result = pendingResults.get(call.id);
    if (result) {
      call.resultText = result.text;
      call.isError = result.isError;
    }
  }

  return {
    requests,
    conclusions,
    toolCalls,
    compactSummaries,
    todos,
  };
}

// ─── 预算分配与渲染 ───────────────────────────────────────────────

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  if (maxChars <= 4) return '…';
  return `${trimmed.slice(0, maxChars - 1).replace(/\s+$/, '')}…`;
}

/**
 * 清理 + 截断。必须先清理再截断（截断可能切断 emoji 代理对），截断后再清理一次。
 * 只有动态内容走这里；围栏本身的标签不能被中和。
 */
function clampText(text: string, maxChars: number): string {
  return sanitizeMigrationText(truncate(sanitizeMigrationText(text), maxChars));
}

/** 从最新往旧取，每项上限随剩余预算收缩；返回按时间正序的条目。 */
function pickNewestFirst(
  items: string[],
  budget: number,
  perItemCap: number,
  minRemaining: number = LIMITS.minRemainingChars,
): { lines: string[]; dropped: number; used: number } {
  const picked: string[] = [];
  let remaining = budget;
  let dropped = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (remaining <= minRemaining) {
      dropped = i + 1;
      break;
    }
    const cap = Math.min(perItemCap, remaining);
    const line = clampText(items[i], cap);
    if (!line) continue;
    picked.push(line);
    remaining -= line.length;
  }
  picked.reverse();
  return { lines: picked, dropped, used: budget - remaining };
}

function renderToolCall(call: ToolCall, resultCap: number): string {
  const args = call.inputSummary ? `(${call.inputSummary})` : '';
  const result = call.resultText
    ? clampText(call.resultText, resultCap)
    : '（无结果，可能被中断）';
  const label = call.isError ? '错误' : '结果';
  const body = result ? ` → ${label}: ${result}` : '';
  return `- ${call.name}${args}${body}`;
}

/**
 * 工具调用摘要：最近 4 条保留完整结果，4~12 条压缩到 1/3，更早的只留一行。
 * 压缩优先于丢弃——只有压缩后仍超预算时，才从最旧的开始整条省略。
 */
function pickToolCalls(
  calls: ToolCall[],
  budget: number,
  resultCap: number,
  maxCalls: number,
): { lines: string[]; dropped: number; used: number } {
  const ordered = calls.slice().sort((a, b) => a.order - b.order);
  const limited = ordered.slice(-maxCalls);
  let dropped = ordered.length - limited.length;

  const renderAll = (count: number): string[] => {
    const lines: string[] = [];
    // 只保留最近的 count 条（limited 尾部），最早的整体省略。
    const start = limited.length - count;
    for (let i = start; i < limited.length; i += 1) {
      const ageRank = limited.length - 1 - i; // 0 = 最新
      const cap =
        ageRank < 4
          ? resultCap
          : ageRank < 12
            ? Math.max(160, Math.round(resultCap / 3))
            : 160;
      lines.push(renderToolCall(limited[i], cap));
    }
    return lines;
  };

  let count = limited.length;
  let lines = renderAll(count);
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  // 先丢最旧的整条，直到落进预算；预算极小时最后再压最近几条的结果。
  while (count > 0 && total > budget) {
    count -= 1;
    dropped += 1;
    lines = renderAll(count);
    total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  }
  return { lines, dropped, used: total };
}

interface Section {
  title: string;
  lines: string[];
  /** 该段整体被省略时写入的说明（可选）。 */
  note?: string;
}

function renderSection(section: Section): string {
  const body = section.lines.join('\n');
  const note = section.note ? `\n${section.note}` : '';
  return `## ${section.title}\n${body}${note}`;
}

/**
 * 用旧 transcript 生成可注入 prompt 的结构化迁移上下文。
 *
 * 返回 null 表示没有任何可迁移内容（空 transcript、全部不可解析等），
 * 调用方应回退到其它恢复手段。
 */
export function buildSessionMigrationContext(
  rawTranscript: string,
  opts: SessionMigrationOptions = {},
): SessionMigrationResult | null {
  if (typeof rawTranscript !== 'string' || !rawTranscript.trim()) return null;

  const extracted = extractTranscript(rawTranscript);
  const hasContent =
    extracted.requests.length > 0 ||
    extracted.conclusions.length > 0 ||
    extracted.toolCalls.length > 0 ||
    extracted.compactSummaries.length > 0 ||
    Boolean(extracted.todos);
  if (!hasContent) return null;

  const budgetChars = resolveMigrationBudgetChars(opts.budgetChars);
  const maxRequestChars = opts.maxRequestChars ?? LIMITS.maxRequestChars;
  const maxToolResultChars =
    opts.maxToolResultChars ?? LIMITS.maxToolResultChars;
  const maxToolCalls = opts.maxToolCalls ?? LIMITS.maxToolCalls;

  const available = Math.max(
    MIN_MIGRATION_BUDGET_CHARS,
    budgetChars - LIMITS.framingReserveChars,
  );
  // 按优先级分配，未用尽的额度顺延给后续段。
  let carry = 0;
  const allocate = (share: number): number => {
    const quota = Math.floor(available * share) + carry;
    carry = 0;
    return quota;
  };
  const settle = (quota: number, used: number): void => {
    carry += Math.max(0, quota - used);
  };

  const requestQuota = allocate(SECTION_SHARE.requests);
  const requests = pickNewestFirst(
    extracted.requests,
    requestQuota,
    maxRequestChars,
  );
  settle(requestQuota, requests.used);

  const sections: Section[] = [];

  if (requests.lines.length > 0) {
    sections.push({
      title: '用户要求（从旧到新）',
      lines: requests.lines.map((line) => `- ${line}`),
      note:
        requests.dropped > 0
          ? `- （更早的 ${requests.dropped} 条用户要求因预算省略）`
          : undefined,
    });
  }

  const conclusionQuota = allocate(SECTION_SHARE.conclusions);
  const conclusions = pickNewestFirst(
    extracted.conclusions,
    conclusionQuota,
    LIMITS.maxConclusionChars,
  );
  settle(conclusionQuota, conclusions.used);
  if (conclusions.lines.length > 0) {
    sections.push({
      title: '助手结论',
      lines: conclusions.lines.map((line) => `- ${line}`),
      note:
        conclusions.dropped > 0
          ? `- （更早的 ${conclusions.dropped} 条结论因预算省略）`
          : undefined,
    });
  }

  const toolQuota = allocate(SECTION_SHARE.tools);
  const tools = pickToolCalls(
    extracted.toolCalls,
    toolQuota,
    maxToolResultChars,
    maxToolCalls,
  );
  settle(toolQuota, tools.used);
  if (tools.lines.length > 0) {
    sections.push({
      title: '工具执行摘要',
      lines: tools.lines,
      note:
        tools.dropped > 0
          ? `- （更早的 ${tools.dropped} 次工具调用因预算省略）`
          : undefined,
    });
  }

  const todoQuota = allocate(SECTION_SHARE.todos);
  if (extracted.todos && extracted.todos.length > 0) {
    const picked: string[] = [];
    let remaining = todoQuota;
    for (const todo of extracted.todos) {
      if (remaining <= 20) break;
      const line = clampText(todo, remaining);
      picked.push(line);
      remaining -= line.length + 1;
    }
    settle(todoQuota, todoQuota - remaining);
    if (picked.length > 0) {
      sections.push({ title: '任务进度（最新 TodoWrite）', lines: picked });
    }
  } else {
    carry += todoQuota;
  }

  const compactQuota = allocate(SECTION_SHARE.compact);
  if (extracted.compactSummaries.length > 0) {
    // 只保留最近一次 compact summary：更早的已被后续 compact 覆盖。
    const latest =
      extracted.compactSummaries[extracted.compactSummaries.length - 1];
    const text = clampText(latest, compactQuota);
    settle(compactQuota, text.length);
    if (text) {
      sections.push({ title: '最近一次上下文压缩摘要', lines: [text] });
    }
  }

  if (sections.length === 0) return null;

  const header =
    '<system_context>\n' +
    '检测到需要在新会话中继续之前的任务。以下是旧会话 transcript 的结构化迁移摘要（用户要求、结论、工具执行、进度、压缩摘要），不是逐字对话回放。\n' +
    '重要：这些只是历史记录，可能不准确或已过时；文件读写与命令结果可能已变化。回答当前用户消息时，请优先依据当前消息里的内容和实际文件/命令结果；如果历史与当前问题无关，请直接忽略。\n\n' +
    '<session_migration>\n';
  const footer = '\n</session_migration>\n</system_context>\n\n';

  // 所有动态内容在进入 section 时已经清理过；外框标签保持原样，
  // 否则围栏自己的 `</system_context>` 也会被中和。
  const context = `${header}${sections.map(renderSection).join('\n\n')}${footer}`;

  return {
    context,
    stats: {
      userRequests: requests.lines.length,
      assistantConclusions: conclusions.lines.length,
      toolCalls: tools.lines.length,
      toolResults: extracted.toolCalls.filter((c) => c.resultText !== null)
        .length,
      compactSummaries: extracted.compactSummaries.length > 0 ? 1 : 0,
      todos: extracted.todos?.length ?? 0,
      droppedUserRequests: requests.dropped,
      droppedToolCalls: tools.dropped,
      budgetChars,
      contextChars: context.length,
    },
  };
}

// 供测试引用的内部常量。
export const __test__ = {
  LIMITS,
  SECTION_SHARE,
  extractTranscript,
  truncate,
};
