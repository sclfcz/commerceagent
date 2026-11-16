// Pure transcript utilities: rebuild one SDK session transcript into a fresh
// sessionId with `thinking` / `redacted_thinking` content blocks removed.
//
// Why this exists: thinking-block signatures are produced by the exact upstream
// (account + endpoint + model) that answered the turn, so a transcript that
// contains them cannot be resumed through a different upstream — the API
// rejects them. Dropping the SDK session throws away the whole conversation
// though. Stripping only the thinking blocks keeps text, tool calls and tool
// results, which is what the conversation actually depends on.
//
// The new transcript is written under a new session id and the original file is
// never touched, so a failed strip/resume can always fall back to the original
// session.

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Content block types that carry upstream-signed state and cannot travel. */
export const STRIP_THINKING_BLOCK_TYPES = [
  'thinking',
  'redacted_thinking',
] as const;

const STRIPPED_BLOCK_TYPES = new Set<string>(STRIP_THINKING_BLOCK_TYPES);

export interface StripThinkingStats {
  /** Content blocks removed across the whole transcript. */
  strippedBlocks: number;
  /**
   * Assistant entries whose content became empty. They are kept (with
   * `content: []`) so every later `parentUuid` still resolves.
   */
  emptiedAssistantEntries: number;
  /** Entries whose `sessionId` field was rewritten to the new session. */
  rewrittenEntries: number;
  /** Lines kept verbatim because they are not parseable JSON objects. */
  unparsableLines: number;
}

export interface StripThinkingContentResult {
  content: string;
  didMutate: boolean;
  stats: StripThinkingStats;
}

export type ThinkingStripFailureReason =
  | 'missing_transcript'
  | 'empty_transcript'
  | 'write_failed';

export interface CreateThinkingStrippedSessionResult {
  /**
   * Session id to resume. The freshly created copy when `created` is true;
   * otherwise the original id (the caller keeps its existing behavior).
   */
  sessionId: string;
  created: boolean;
  reason?: ThinkingStripFailureReason;
  strippedBlocks: number;
  emptiedAssistantEntries: number;
  transcriptPath?: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Remove thinking blocks from one transcript line.
 *
 * Returns the (possibly replaced) line together with per-line counters. The
 * line is returned unchanged whenever it carries no thinking block, so callers
 * can rely on byte-level stability for untouched entries.
 */
function stripLineThinking(
  line: string,
  newSessionId: string,
  stats: StripThinkingStats,
): string {
  if (!line.trim()) return line;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    stats.unparsableLines += 1;
    return line;
  }
  if (!isRecord(parsed)) {
    stats.unparsableLines += 1;
    return line;
  }

  let didMutate = false;

  if (
    typeof parsed.sessionId === 'string' &&
    parsed.sessionId !== newSessionId
  ) {
    parsed.sessionId = newSessionId;
    stats.rewrittenEntries += 1;
    didMutate = true;
  }

  const message = parsed.message;
  if (parsed.type === 'assistant' && isRecord(message)) {
    const content = message.content;
    if (Array.isArray(content)) {
      const kept = content.filter(
        (block) =>
          !(isRecord(block) && STRIPPED_BLOCK_TYPES.has(String(block.type))),
      );
      const removed = content.length - kept.length;
      if (removed > 0) {
        // An assistant turn that only produced thinking keeps its entry with an
        // empty content array: later entries reference this uuid through
        // `parentUuid`, and dropping it would orphan their tool results.
        if (kept.length === 0) stats.emptiedAssistantEntries += 1;
        message.content = kept;
        stats.strippedBlocks += removed;
        didMutate = true;
      }
    }
  }

  return didMutate ? JSON.stringify(parsed) : line;
}

/**
 * Rewrite a whole transcript (JSONL text) for a new session id with thinking
 * blocks removed. Pure: the input string is not modified and no I/O happens.
 *
 * Invariants, by construction:
 * - entry order is preserved, so the `parentUuid` chain never breaks;
 * - `tool_use` / `tool_result` blocks are never touched, so calls stay paired;
 * - entries that carry no thinking block are emitted byte-identically.
 */
export function stripThinkingFromTranscriptContent(
  content: string,
  newSessionId: string,
): StripThinkingContentResult {
  const stats: StripThinkingStats = {
    strippedBlocks: 0,
    emptiedAssistantEntries: 0,
    rewrittenEntries: 0,
    unparsableLines: 0,
  };

  const lines = content.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    out.push(stripLineThinking(line, newSessionId, stats));
  }

  return {
    content: out.join('\n'),
    didMutate:
      stats.strippedBlocks > 0 ||
      stats.rewrittenEntries > 0 ||
      stats.emptiedAssistantEntries > 0,
    stats,
  };
}

/**
 * Add a `sessions-index.json` entry for the new session when the CLI keeps an
 * index next to the transcripts. Best-effort: the index is a listing cache, and
 * a missing entry must never fail the strip (resume resolves by file name).
 */
function copySessionsIndexEntry(
  transcriptDir: string,
  sourceSessionId: string,
  newSessionId: string,
  newTranscriptPath: string,
): void {
  const indexPath = path.join(transcriptDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) return;
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as {
      entries?: unknown;
    };
    if (!Array.isArray(index.entries)) return;
    const source = index.entries.find(
      (entry) => isRecord(entry) && entry.sessionId === sourceSessionId,
    ) as JsonRecord | undefined;
    if (!source) return;
    const cloned: JsonRecord = {
      ...source,
      sessionId: newSessionId,
      fullPath: newTranscriptPath,
    };
    index.entries.push(cloned);
    const tempPath = `${indexPath}.strip-tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(index, null, 2));
    fs.renameSync(tempPath, indexPath);
  } catch {
    // Index maintenance is optional; the transcript copy is what resume needs.
  }
}

/**
 * Copy `<transcriptDir>/<sessionId>.jsonl` into a fresh session id with
 * thinking blocks removed, leaving the original transcript untouched.
 *
 * The caller resumes the returned `sessionId`. When no usable transcript exists
 * the original id is returned with `created: false`, so callers can keep their
 * existing resume/failure behavior instead of silently dropping context.
 */
export function createThinkingStrippedSession(options: {
  transcriptDir: string;
  sessionId: string;
  /** Testing seam; production generates a fresh uuid. */
  newSessionId?: string;
  log?: (message: string) => void;
}): CreateThinkingStrippedSessionResult {
  const { transcriptDir, sessionId } = options;
  const log = options.log ?? (() => {});
  const notCreated = (
    reason: ThinkingStripFailureReason,
  ): CreateThinkingStrippedSessionResult => ({
    sessionId,
    created: false,
    reason,
    strippedBlocks: 0,
    emptiedAssistantEntries: 0,
  });

  const sourcePath = path.join(transcriptDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(sourcePath)) {
    log(`Thinking strip: no transcript at ${sourcePath}`);
    return notCreated('missing_transcript');
  }

  let original: string;
  try {
    original = fs.readFileSync(sourcePath, 'utf-8');
  } catch (err) {
    log(
      `Thinking strip: failed to read ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return notCreated('missing_transcript');
  }
  if (!original.trim()) return notCreated('empty_transcript');

  const newSessionId = options.newSessionId ?? randomUUID();
  const result = stripThinkingFromTranscriptContent(original, newSessionId);
  const targetPath = path.join(transcriptDir, `${newSessionId}.jsonl`);

  try {
    const tempPath = `${targetPath}.strip-tmp`;
    fs.writeFileSync(tempPath, result.content);
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    log(
      `Thinking strip: failed to write ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return notCreated('write_failed');
  }

  copySessionsIndexEntry(transcriptDir, sessionId, newSessionId, targetPath);

  log(
    `Thinking strip: ${sessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)} ` +
      `(${result.stats.strippedBlocks} thinking blocks removed, ` +
      `${result.stats.emptiedAssistantEntries} assistant entries emptied, ` +
      `${result.stats.rewrittenEntries} entries re-keyed)`,
  );

  return {
    sessionId: newSessionId,
    created: true,
    strippedBlocks: result.stats.strippedBlocks,
    emptiedAssistantEntries: result.stats.emptiedAssistantEntries,
    transcriptPath: targetPath,
  };
}
