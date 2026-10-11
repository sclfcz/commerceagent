import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function databaseState(data: string) {
  const db = new Database(path.join(data, 'db/messages.db'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const ids = (table: string, column = 'id') =>
      (
        db.prepare(`SELECT ${column} AS id FROM ${table}`).all() as {
          id: string;
        }[]
      ).map((r) => r.id);
    return db.transaction(() => ({
      users: ids('users'),
      workspaces: ids('registered_groups', 'jid'),
      sessions: ids('agents'),
      sdkSessions: ids('sessions', 'session_id'),
      messages: (
        db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }
      ).n,
      usageEvents: (
        db.prepare('SELECT count(*) AS n FROM usage_events').get() as {
          n: number;
        }
      ).n,
    }))();
  } finally {
    db.close();
  }
}

export interface FreshStateEvidence {
  serviceDirectoryCreated: boolean;
  dataDirectoryCreated: boolean;
  initialDataEntries: number;
  initialDatabase: ReturnType<typeof databaseState>;
  dataDirectory: string;
  userId: string;
  sessionId: string;
  workspaceJid: string;
  userAbsentBeforeSetup: boolean;
  sessionAbsentBeforeCreate: boolean;
  sessionOwned: boolean;
  sessionEmpty: boolean;
  workspaceBaselineHash: string;
}

export function inspectSession(
  data: string,
  userId: string,
  workspaceJid: string,
  sessionId: string,
) {
  const db = new Database(path.join(data, 'db/messages.db'), {
    readonly: true,
  });
  try {
    const session = db
      .prepare('SELECT created_by, chat_jid FROM agents WHERE id = ?')
      .get(sessionId) as { created_by: string; chat_jid: string } | undefined;
    const prior = db
      .prepare('SELECT count(*) AS n FROM messages WHERE chat_jid IN (?, ?)')
      .get(workspaceJid, `${workspaceJid}#agent:${sessionId}`) as { n: number };
    const sdk = db
      .prepare('SELECT count(*) AS n FROM sessions WHERE agent_id = ?')
      .get(sessionId) as { n: number };
    return {
      sessionOwned:
        session?.created_by === userId && session.chat_jid === workspaceJid,
      sessionEmpty: prior.n === 0 && sdk.n === 0,
    };
  } finally {
    db.close();
  }
}

export class FreshStateTracker {
  private readonly seen = {
    users: new Set<string>(),
    sessions: new Set<string>(),
    directories: new Set<string>(),
    workspaces: new Set<string>(),
  };
  private baseline: string | null = null;
  verify(e: FreshStateEvidence): boolean {
    const initial = e.initialDatabase;
    const directory = fs.realpathSync(e.dataDirectory);
    const checks = [
      e.serviceDirectoryCreated,
      e.dataDirectoryCreated,
      e.initialDataEntries === 0,
      initial.users.length === 0,
      initial.workspaces.length === 0,
      initial.sessions.length === 0,
      initial.sdkSessions.length === 0,
      initial.messages === 0,
      initial.usageEvents === 0,
      e.userAbsentBeforeSetup,
      e.sessionAbsentBeforeCreate,
      e.sessionOwned,
      e.sessionEmpty,
      !!e.userId,
      !!e.sessionId,
      !!e.workspaceJid,
      !!e.workspaceBaselineHash,
      !this.seen.users.has(e.userId),
      !this.seen.sessions.has(e.sessionId),
      !this.seen.directories.has(directory),
      !this.seen.workspaces.has(e.workspaceJid),
      this.baseline === null || this.baseline === e.workspaceBaselineHash,
    ];
    // Even an invalid attempt must never be recycled for another sample.
    this.seen.users.add(e.userId);
    this.seen.sessions.add(e.sessionId);
    this.seen.directories.add(directory);
    this.seen.workspaces.add(e.workspaceJid);
    const valid = checks.every(Boolean);
    if (valid && this.baseline === null)
      this.baseline = e.workspaceBaselineHash;
    return valid;
  }
}
