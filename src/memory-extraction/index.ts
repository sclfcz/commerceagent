import crypto from 'node:crypto';

import {
  advanceWorkspaceMemoryExtractionCursor,
  createWorkspaceMemoryCandidate,
  expireStaleWorkspaceMemoryCandidates,
  getWorkspaceMemoryExtractionCursor,
  listWorkspaceMemoryForCandidateDedupe,
  recordWorkspaceMemoryExtractionAttempt,
  type WorkspaceMemoryExtractionCursor,
} from '../memory-candidate-store.js';
import { getJidsByFolder, getRegisteredGroup, getSession } from '../db.js';
import { logger } from '../logger.js';
import { sdkQuery } from '../sdk-query.js';
import {
  MEMORY_EXTRACTION_MAX_ATTEMPTS,
  MEMORY_EXTRACTION_MAX_INPUT_CHARS,
  MEMORY_EXTRACTION_MAX_WINDOW_MESSAGES,
  MEMORY_EXTRACTION_RETRY_BACKOFF_MS,
  MEMORY_EXTRACTION_SWEEP_INTERVAL_MS,
  MEMORY_EXTRACTION_SWEEP_START_DELAY_MS,
  loadMemoryExtractionPrompt,
  resolveMemoryExtractionSettings,
  type MemoryExtractionSettings,
} from './config.js';
import {
  containsSensitiveContent,
  findDuplicateReason,
  type ExistingMemoryForDedupe,
} from './filters.js';
import { parseExtractionResponse, type ExtractedCandidate } from './schema.js';
import {
  hasHumanMessage,
  listExtractionSessions,
  loadExtractionMessageWindow,
  type ExtractionSession,
} from './sessions.js';

/**
 * Post-session extraction of candidate memories.
 *
 * Flow: a session goes idle (or compacts) → the host reads only the messages
 * after that session's persisted cursor → one lightweight model call through
 * the same provider path the rest of the host uses (`sdkQuery`, shared with
 * title generation and the AgentProfile generator) → strict JSON validation →
 * secret/PII and duplicate filters → rows with `status = 'proposed'`.
 *
 * Nothing here can make a memory active: confirmation is a separate, human
 * decision (Web confirm/reject or the `workspace_memory_review` tool). The
 * model is therefore treated as untrusted input throughout.
 */

export type MemoryExtractionLlm = (prompt: string) => Promise<string | null>;

export interface MemoryExtractionDeps {
  /** Model call; tests inject a fake, production uses `sdkQuery`. */
  llm?: MemoryExtractionLlm;
  now?: () => Date;
  settings?: MemoryExtractionSettings;
}

export type SessionExtractionOutcome =
  | 'extracted'
  | 'no_candidates'
  | 'disabled'
  | 'not_idle'
  | 'backoff'
  | 'empty'
  | 'no_human_message'
  | 'model_failed'
  | 'invalid_output'
  | 'error';

export interface SessionExtractionResult {
  workspaceJid: string;
  sessionKey: string;
  outcome: SessionExtractionOutcome;
  proposed: number;
  droppedSensitive: number;
  droppedDuplicate: number;
  droppedRule: number;
  consumedMessages: number;
}

const MAX_MESSAGE_CHARS = 4000;
const MAX_EXISTING_ENTRIES = 40;
const MAX_EXISTING_CHARS = 4000;

function defaultLlm(prompt: string): Promise<string | null> {
  // Same one-shot host path used by title generation and the AgentProfile
  // generator, so extraction inherits the configured provider/model instead of
  // introducing a second SDK or vendor.
  return sdkQuery(prompt, { timeout: 90_000 });
}

function resolveSession(chatJid: string): ExtractionSession | null {
  const baseJid = chatJid.includes('#agent:')
    ? chatJid.slice(0, chatJid.indexOf('#agent:'))
    : chatJid;
  const group = getRegisteredGroup(baseJid);
  if (!group) return null;
  const agentId = chatJid.includes('#agent:')
    ? chatJid.slice(chatJid.indexOf('#agent:') + '#agent:'.length)
    : null;
  return {
    workspaceJid:
      getJidsByFolder(group.folder).find((jid) => jid.startsWith('web:')) ??
      baseJid,
    sessionKey: chatJid,
    sessionId: agentId
      ? (getSession(group.folder, agentId) ?? agentId)
      : (getSession(group.folder) ?? null),
  };
}

function formatExistingForPrompt(
  existing: readonly ExistingMemoryForDedupe[],
): string {
  if (existing.length === 0) return '（工作区暂无已有记忆）';
  const lines: string[] = [];
  let size = 0;
  for (const entry of existing.slice(0, MAX_EXISTING_ENTRIES)) {
    const title = entry.title?.trim() || '(无标题)';
    const line = `- [${entry.kind}] ${title}：${entry.content.replaceAll(/\s+/g, ' ').slice(0, 160)}`;
    if (size + line.length > MAX_EXISTING_CHARS) break;
    lines.push(line);
    size += line.length;
  }
  return lines.join('\n');
}

function buildExtractionPrompt(input: {
  messages: ReturnType<typeof loadExtractionMessageWindow>['messages'];
  existing: readonly ExistingMemoryForDedupe[];
}): string {
  const transcript: string[] = [];
  let size = 0;
  const selected: typeof input.messages = [];
  for (const message of input.messages) {
    const role = message.is_from_me ? 'assistant' : 'user';
    const content = message.content.slice(0, MAX_MESSAGE_CHARS);
    const line = `[msg:${message.id}] ${role}: ${content}`;
    if (size + line.length > MEMORY_EXTRACTION_MAX_INPUT_CHARS) break;
    selected.push(message);
    transcript.push(line);
    size += line.length;
  }
  return [
    loadMemoryExtractionPrompt(),
    '',
    '## 已有记忆（用于去重，不要重复提出）',
    formatExistingForPrompt(input.existing),
    '',
    '## 待提炼消息',
    transcript.join('\n\n'),
    '',
    '请只输出 JSON 对象。',
  ].join('\n');
}

function pickMessagesWithinBudget(
  messages: ReturnType<typeof loadExtractionMessageWindow>['messages'],
): typeof messages {
  const selected: typeof messages = [];
  let size = 0;
  for (const message of messages) {
    const cost = Math.min(message.content.length, MAX_MESSAGE_CHARS) + 40;
    if (selected.length > 0 && size + cost > MEMORY_EXTRACTION_MAX_INPUT_CHARS)
      break;
    selected.push(message);
    size += cost;
  }
  return selected;
}

function inBackoff(
  cursor: WorkspaceMemoryExtractionCursor,
  now: Date,
): boolean {
  if (cursor.attemptCount < MEMORY_EXTRACTION_MAX_ATTEMPTS) return false;
  if (!cursor.lastAttemptAt) return false;
  const last = Date.parse(cursor.lastAttemptAt);
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last < MEMORY_EXTRACTION_RETRY_BACKOFF_MS;
}

/**
 * Validate and write the model's candidates for one session.
 *
 * Returns the counts used for tracing. Every candidate is checked against the
 * Workspace's current non-forgotten items (active, proposed and conflicted) and
 * against the candidates accepted earlier in this same response.
 */
async function persistCandidates(input: {
  workspaceJid: string;
  sessionKey: string;
  sessionId: string | null;
  runId: string;
  candidates: readonly ExtractedCandidate[];
  allowedMessageIds: Set<string>;
  settings: MemoryExtractionSettings;
  now: Date;
}): Promise<{
  proposed: number;
  droppedSensitive: number;
  droppedDuplicate: number;
  droppedRule: number;
}> {
  const existing = await listWorkspaceMemoryForCandidateDedupe(
    input.workspaceJid,
  );
  const acceptedAsExisting: ExistingMemoryForDedupe[] = [];
  let proposed = 0;
  let droppedSensitive = 0;
  let droppedDuplicate = 0;
  let droppedRule = 0;
  let facts = 0;
  for (const [index, candidate] of input.candidates.entries()) {
    if (proposed >= input.settings.maxCandidates) break;
    const haystack = `${candidate.title}\n${candidate.content}\n${candidate.applies_when ?? ''}`;
    if (containsSensitiveContent(haystack)) {
      droppedSensitive += 1;
      continue;
    }
    if (
      candidate.kind === 'lesson' &&
      (candidate.confidence < input.settings.lessonMinConfidence ||
        !candidate.applies_when?.trim())
    ) {
      droppedRule += 1;
      continue;
    }
    if (candidate.kind === 'fact') {
      // One session-summary fact per run keeps the store from filling with
      // overlapping "what happened in this chat" entries.
      if (facts >= 1) {
        droppedRule += 1;
        continue;
      }
      facts += 1;
    }
    const existingEntries = [...existing, ...acceptedAsExisting];
    if (findDuplicateReason(candidate, existingEntries)) {
      droppedDuplicate += 1;
      continue;
    }
    const evidence = candidate.evidence_message_ids.filter((id) =>
      input.allowedMessageIds.has(id),
    );
    const created = await createWorkspaceMemoryCandidate({
      workspaceJid: input.workspaceJid,
      sessionKey: input.sessionKey,
      sessionId: input.sessionId,
      runId: input.runId,
      kind: candidate.kind,
      title: candidate.title,
      content: candidate.content,
      confidence: candidate.confidence,
      importance: candidate.importance,
      appliesWhen: candidate.applies_when ?? null,
      searchKeys: candidate.search_keys ?? [],
      evidenceMessageIds: evidence,
      model: null,
      ttlDays: input.settings.ttlDays,
      idempotencyKey: `${input.runId}:${index}`,
      requestHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(candidate))
        .digest('hex'),
      now: input.now.toISOString(),
    });
    proposed += 1;
    acceptedAsExisting.push({
      id: created.item.id,
      status: created.item.status,
      kind: created.item.kind,
      title: created.item.title,
      content: created.item.content,
      canonicalKey: created.item.canonicalKey,
    });
  }
  return { proposed, droppedSensitive, droppedDuplicate, droppedRule };
}

export async function runMemoryExtractionForSession(
  session: ExtractionSession,
  deps: MemoryExtractionDeps = {},
  options: { force?: boolean } = {},
): Promise<SessionExtractionResult> {
  const settings = deps.settings ?? resolveMemoryExtractionSettings();
  const now = deps.now?.() ?? new Date();
  const result: SessionExtractionResult = {
    workspaceJid: session.workspaceJid,
    sessionKey: session.sessionKey,
    outcome: 'empty',
    proposed: 0,
    droppedSensitive: 0,
    droppedDuplicate: 0,
    droppedRule: 0,
    consumedMessages: 0,
  };
  if (!settings.enabled) return { ...result, outcome: 'disabled' };

  const cursor = await getWorkspaceMemoryExtractionCursor(
    session.workspaceJid,
    session.sessionKey,
  );
  const window = loadExtractionMessageWindow({
    sessionKey: session.sessionKey,
    cursorTimestamp: cursor?.lastMessageTimestamp,
    cursorId: cursor?.lastMessageId,
    limit: MEMORY_EXTRACTION_MAX_WINDOW_MESSAGES,
  });
  if (!window.latestMessageTimestamp) {
    return { ...result, outcome: 'empty' };
  }
  if (!options.force) {
    const idleFor = now.getTime() - Date.parse(window.latestMessageTimestamp);
    if (!Number.isFinite(idleFor) || idleFor < settings.idleMs || idleFor < 0) {
      return { ...result, outcome: 'not_idle' };
    }
    if (cursor && inBackoff(cursor, now)) {
      return { ...result, outcome: 'backoff' };
    }
  }
  if (window.messages.length === 0) {
    return { ...result, outcome: 'empty' };
  }

  const selected = pickMessagesWithinBudget(window.messages);
  if (!hasHumanMessage(selected)) {
    // Non-human turns (scheduled results, assistant continuations) never
    // become a source. When the window is full, advance past it so the cursor
    // cannot get stuck behind a long automated stretch.
    if (window.truncated) {
      const last = selected.at(-1);
      if (last) {
        await advanceWorkspaceMemoryExtractionCursor({
          workspaceJid: session.workspaceJid,
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          lastMessageTimestamp: last.timestamp,
          lastMessageId: last.id,
          at: now.toISOString(),
        });
      }
    }
    return { ...result, outcome: 'no_human_message' };
  }

  const existing = await listWorkspaceMemoryForCandidateDedupe(
    session.workspaceJid,
  );
  const prompt = buildExtractionPrompt({ messages: selected, existing });
  const runId = `mer_${crypto.randomUUID()}`;
  await recordWorkspaceMemoryExtractionAttempt({
    workspaceJid: session.workspaceJid,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    at: now.toISOString(),
    attemptCount: (cursor?.attemptCount ?? 0) + 1,
    error: null,
  });

  let raw: string | null;
  try {
    raw = await (deps.llm ?? defaultLlm)(prompt);
  } catch (error) {
    raw = null;
    logger.warn(
      {
        sessionKey: session.sessionKey,
        err:
          error instanceof Error ? error.message.slice(0, 200) : String(error),
      },
      'Workspace Memory extraction model call failed',
    );
  }
  if (raw === null) {
    await recordWorkspaceMemoryExtractionAttempt({
      workspaceJid: session.workspaceJid,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      at: now.toISOString(),
      attemptCount: (cursor?.attemptCount ?? 0) + 1,
      error: 'model_call_failed',
    });
    return { ...result, outcome: 'model_failed' };
  }

  const parsed = parseExtractionResponse(raw);
  const last = selected.at(-1)!;
  if (!parsed.ok) {
    // The model was called and answered: re-sending the same window would only
    // burn another call, so the cursor moves and the rejection is logged.
    await advanceWorkspaceMemoryExtractionCursor({
      workspaceJid: session.workspaceJid,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      lastMessageTimestamp: last.timestamp,
      lastMessageId: last.id,
      at: now.toISOString(),
    });
    logger.warn(
      {
        sessionKey: session.sessionKey,
        reason: parsed.reason,
      },
      'Workspace Memory extraction response rejected by schema',
    );
    return { ...result, outcome: 'invalid_output' };
  }

  const persisted = await persistCandidates({
    workspaceJid: session.workspaceJid,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    runId,
    candidates: parsed.candidates,
    allowedMessageIds: new Set(selected.map((message) => message.id)),
    settings,
    now,
  });
  await advanceWorkspaceMemoryExtractionCursor({
    workspaceJid: session.workspaceJid,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    lastMessageTimestamp: last.timestamp,
    lastMessageId: last.id,
    at: now.toISOString(),
  });
  const outcome: SessionExtractionOutcome =
    persisted.proposed > 0 ? 'extracted' : 'no_candidates';
  logger.info(
    {
      workspaceJid: session.workspaceJid,
      sessionKey: session.sessionKey,
      outcome,
      ...persisted,
      candidates: parsed.candidates.length,
    },
    'Workspace Memory extraction completed',
  );
  return {
    ...result,
    outcome,
    proposed: persisted.proposed,
    droppedSensitive: persisted.droppedSensitive,
    droppedDuplicate: persisted.droppedDuplicate,
    droppedRule: persisted.droppedRule,
    consumedMessages: selected.length,
  };
}

/**
 * One sweep: expire overdue candidates, then look at every eligible session and
 * extract the ones that have been idle long enough.
 */
export async function runMemoryExtractionSweep(
  deps: MemoryExtractionDeps = {},
): Promise<{ results: SessionExtractionResult[]; expired: number }> {
  const settings = deps.settings ?? resolveMemoryExtractionSettings();
  if (!settings.enabled) return { results: [], expired: 0 };
  const expired = await expireStaleWorkspaceMemoryCandidates({
    now: (deps.now?.() ?? new Date()).toISOString(),
  });
  const results: SessionExtractionResult[] = [];
  for (const session of listExtractionSessions()) {
    try {
      results.push(await runMemoryExtractionForSession(session, deps));
    } catch (error) {
      logger.warn(
        {
          sessionKey: session.sessionKey,
          err:
            error instanceof Error
              ? error.message.slice(0, 200)
              : String(error),
        },
        'Workspace Memory extraction sweep skipped a session',
      );
      results.push({
        workspaceJid: session.workspaceJid,
        sessionKey: session.sessionKey,
        outcome: 'error',
        proposed: 0,
        droppedSensitive: 0,
        droppedDuplicate: 0,
        droppedRule: 0,
        consumedMessages: 0,
      });
    }
  }
  return { results, expired: expired.expired };
}

/**
 * Pre-compaction trigger.
 *
 * The runner emits `compact_boundary` once the SDK has compacted the context;
 * that is the host's only reliable signal that this session is about to lose
 * detail. Extraction runs immediately instead of waiting for the idle window,
 * still only over messages the cursor has not consumed.
 */
export async function extractBeforeCompaction(
  chatJid: string,
  deps: MemoryExtractionDeps = {},
): Promise<SessionExtractionResult | null> {
  const session = resolveSession(chatJid);
  if (!session) return null;
  try {
    return await runMemoryExtractionForSession(session, deps, { force: true });
  } catch (error) {
    logger.warn(
      {
        chatJid,
        err:
          error instanceof Error ? error.message.slice(0, 200) : String(error),
      },
      'Workspace Memory extraction before compaction failed',
    );
    return null;
  }
}

/**
 * Host sweep. A single 60s timer computes idleness from stored message
 * timestamps, so a restart never loses a pending extraction and no per-session
 * timers have to be tracked.
 */
export function startMemoryExtractionLoop(
  deps: MemoryExtractionDeps = {},
): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runMemoryExtractionSweep(deps);
    } catch (error) {
      logger.warn(
        {
          err:
            error instanceof Error
              ? error.message.slice(0, 200)
              : String(error),
        },
        'Workspace Memory extraction sweep failed',
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    () => void tick(),
    MEMORY_EXTRACTION_SWEEP_INTERVAL_MS,
  );
  timer.unref?.();
  const start = setTimeout(
    () => void tick(),
    MEMORY_EXTRACTION_SWEEP_START_DELAY_MS,
  );
  start.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(start);
  };
}
