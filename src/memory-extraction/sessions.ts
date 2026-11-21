import {
  getAllRegisteredGroups,
  getChatLatestMessageTimestamp,
  getJidsByFolder,
  getMemoryExtractionMessages,
  getSession,
  listAgentsByFolder,
  type MemoryExtractionMessage,
} from '../db.js';
import type { RegisteredGroup } from '../types.js';

/**
 * Which conversational sessions are eligible for extraction.
 *
 * A session is a chat JID whose messages belong to exactly one Claude context:
 * the Workspace main session, or a conversation-kind Runtime Session
 * (`<jid>#agent:<id>`). Scheduled runs, task/spawn sub-agents and slash-command
 * turns are filtered out at the message level (they carry `task_id` or a
 * command/scheduled `source_kind`), so they can never become a source.
 */
export interface ExtractionSession {
  workspaceJid: string;
  /** Chat JID whose messages are read; also the cursor key. */
  sessionKey: string;
  /** Claude session identifier recorded as provenance when available. */
  sessionId: string | null;
}

export interface ExtractionMessageWindow {
  messages: MemoryExtractionMessage[];
  /** Newest message in the whole chat, used for the idle check. */
  latestMessageTimestamp: string | null;
  latestMessageId: string | null;
  /** True when the window was cut by the message cap. */
  truncated: boolean;
}

function workspaceJidFor(folder: string, fallbackJid: string): string {
  const siblings = getJidsByFolder(folder);
  return siblings.find((jid) => jid.startsWith('web:')) ?? fallbackJid;
}

/**
 * Enumerate sessions across every registered Workspace.
 *
 * Runtime Sessions are included only for `kind = 'conversation'`: task and
 * spawn agents have no human-only transcript of their own and are additionally
 * excluded by the message filter.
 */
export function listExtractionSessions(): ExtractionSession[] {
  const groups = getAllRegisteredGroups();
  const sessions: ExtractionSession[] = [];
  const seen = new Set<string>();
  const add = (session: ExtractionSession): void => {
    const key = `${session.workspaceJid}\u0000${session.sessionKey}`;
    if (seen.has(key)) return;
    seen.add(key);
    sessions.push(session);
  };

  for (const [jid, group] of Object.entries(groups)) {
    if (!group?.folder) continue;
    const workspaceJid = workspaceJidFor(group.folder, jid);
    add({
      workspaceJid,
      sessionKey: jid,
      sessionId: getSession(group.folder) ?? null,
    });
  }

  const folders = new Set(
    Object.values(groups)
      .map((group: RegisteredGroup) => group.folder)
      .filter((folder): folder is string => Boolean(folder)),
  );
  for (const folder of folders) {
    for (const agent of listAgentsByFolder(folder)) {
      if (agent.kind !== 'conversation' || !agent.chat_jid) continue;
      add({
        workspaceJid: workspaceJidFor(folder, agent.chat_jid),
        sessionKey: agent.chat_jid,
        sessionId: getSession(folder, agent.id) ?? agent.id,
      });
    }
  }
  return sessions;
}

export function loadExtractionMessageWindow(input: {
  sessionKey: string;
  cursorTimestamp?: string | null;
  cursorId?: string | null;
  limit: number;
}): ExtractionMessageWindow {
  const cursorTimestamp = input.cursorTimestamp ?? '';
  const cursorId = input.cursorId ?? '';
  const messages = getMemoryExtractionMessages(
    input.sessionKey,
    { timestamp: cursorTimestamp, id: cursorId },
    input.limit,
  );
  const latest = getChatLatestMessageTimestamp(input.sessionKey);
  return {
    messages,
    latestMessageTimestamp: latest,
    latestMessageId: messages.at(-1)?.id ?? null,
    truncated: messages.length >= input.limit,
  };
}

/**
 * A batch is only worth a model call when a human participated in it. This is
 * the final guard that keeps non-human turns (scheduled results, assistant
 * continuations) from triggering extraction.
 */
export function hasHumanMessage(
  messages: readonly MemoryExtractionMessage[],
): boolean {
  return messages.some((message) => !message.is_from_me);
}
