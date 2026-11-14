import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-strip-'));
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'CommerceAgent Test',
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const createdAt = '2026-08-01T00:00:00.000Z';
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '69');
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    permissions TEXT NOT NULL DEFAULT '[]',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disable_reason TEXT,
    notes TEXT,
    avatar_emoji TEXT,
    avatar_color TEXT,
    ai_name TEXT,
    ai_avatar_emoji TEXT,
    ai_avatar_color TEXT,
    ai_avatar_url TEXT,
    default_require_mention INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    deleted_at TEXT
  );
  INSERT INTO users (
    id, username, password_hash, display_name, role, status, created_at, updated_at
  ) VALUES (
    'legacy-user', 'legacy-user', 'hash', 'Legacy User', 'admin', 'active',
    '${createdAt}', '${createdAt}'
  );
  CREATE TABLE sessions (
    group_folder TEXT NOT NULL,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    provider_id TEXT,
    agent_profile_id TEXT,
    identity_hash TEXT,
    agent_profile_version INTEGER,
    PRIMARY KEY (group_folder, agent_id)
  );
  INSERT INTO sessions (group_folder, session_id, agent_id, provider_id)
    VALUES ('legacy-workspace', 'sdk-session-before-v70', '', 'provider-legacy');
`);
legacy.close();

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v70 thinking-strip resume marker', () => {
  test('upgrades to head and defaults existing sessions to plain resume', () => {
    db.initDatabase();

    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    expect(db.getSession('legacy-workspace')).toBe('sdk-session-before-v70');
    expect(db.getSessionProviderId('legacy-workspace')).toBe('provider-legacy');
    // Upgrading must not invalidate anything on its own: only an actual
    // provider config change marks a session.
    expect(db.getSessionResumeStripThinking('legacy-workspace')).toBe(false);

    const probe = new Database(databasePath, { readonly: true });
    const columns = probe
      .prepare("PRAGMA table_info('sessions')")
      .all() as Array<{ name: string; dflt_value: string | null }>;
    expect(columns.map((c) => c.name)).toContain('resume_strip_thinking');
    expect(
      columns.find((c) => c.name === 'resume_strip_thinking')?.dflt_value,
    ).toBe('0');
    const stored = probe
      .prepare(
        'SELECT resume_strip_thinking FROM sessions WHERE group_folder = ?',
      )
      .get('legacy-workspace') as { resume_strip_thinking: number };
    expect(stored.resume_strip_thinking).toBe(0);
    probe.close();
  });

  test('marking a bound provider flags the row and keeps the conversation', () => {
    const result =
      db.markSessionsForThinkingStripByProviderId('provider-legacy');
    expect(result.markedCount).toBe(1);
    expect(db.getSessionResumeStripThinking('legacy-workspace')).toBe(true);
    expect(db.getSession('legacy-workspace')).toBe('sdk-session-before-v70');
    expect(db.getSessionProviderId('legacy-workspace')).toBe('provider-legacy');

    db.setSession('legacy-workspace', 'sdk-session-after-strip', '');
    expect(db.getSessionResumeStripThinking('legacy-workspace')).toBe(false);
  });
});
