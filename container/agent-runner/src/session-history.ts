// Pure session-history utilities — extracted from index.ts to enable
// unit testing without pulling in the full agent-runner module graph.

import fs from 'fs';
import path from 'path';

import type { ParsedMessage } from './types.js';
import { buildSessionMigrationContext } from './session-migration.js';

// 孤立代理项清理正则的唯一真相源是 shared/session-migration.ts（同步到本目录
// 的 session-migration.ts）。这里重新导出，保持既有调用方（prompt loader 等）
// 的导入路径不变，同时确保所有截断路径共用同一份定义。
export { LONE_SURROGATE_RE } from './session-migration.js';

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Tolerate malformed JSONL lines silently — partial recovery is better
      // than failing the whole resume path on a single corrupt entry.
    }
  }

  return messages;
}

export interface ExtractSessionHistoryOptions {
  /** Directory containing the SDK transcript files (e.g. ~/.claude/projects/<encoded-cwd>) */
  transcriptDir: string;
  /** Session ID to extract history for. The function reads `${transcriptDir}/${sessionId}.jsonl`. */
  sessionId: string;
  /** Optional logger for debug breadcrumbs. Defaults to no-op. */
  log?: (msg: string) => void;
  /** 迁移上下文总长度预算（字符）。默认走环境变量 / shared 默认值。 */
  budgetChars?: number;
}

/**
 * 用旧会话的 JSONL transcript 生成结构化迁移上下文（`<system_context>` 块），
 * 供无法 resume 时的新会话注入。
 *
 * 内容由 shared/session-migration.ts 构建：用户要求、助手结论、工具调用摘要、
 * TodoWrite 进度、最近一次 compact summary；Host 侧 src/conversation-history.ts
 * 走同一份实现，两侧输出逐字节一致。
 *
 * Returns null when:
 * - the transcript file does not exist
 * - the transcript contains no migratable content
 * - any I/O error occurs
 *
 * Behavior is intentionally tolerant — recovery is best-effort.
 */
export function extractSessionHistory(
  opts: ExtractSessionHistoryOptions,
): string | null {
  const { transcriptDir, sessionId, log = () => {} } = opts;

  try {
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`);

    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        log(`Session transcript not found at ${transcriptPath}`);
        return null;
      }
      throw err;
    }

    const migration = buildSessionMigrationContext(content, {
      budgetChars: opts.budgetChars,
    });
    if (!migration) {
      log(`Session transcript ${transcriptPath} has no migratable content`);
      return null;
    }

    log(
      `Migrated old session ${sessionId}: requests=${migration.stats.userRequests}` +
        ` conclusions=${migration.stats.assistantConclusions}` +
        ` tools=${migration.stats.toolCalls}` +
        ` todos=${migration.stats.todos}` +
        ` chars=${migration.stats.contextChars}`,
    );

    return migration.context;
  } catch (err) {
    opts.log?.(
      `Failed to extract session history: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
