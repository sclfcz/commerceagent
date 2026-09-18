import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v69-agent-effort-'));
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
const legacyPolicy = {
  context: {
    source: 'host_claude',
    auto_compact_window: 0,
    auto_compact_percentage: 0,
  },
  skills: {
    mode: 'custom',
    ids: ['legacy-skill'],
    host: { mode: 'custom', ids: ['legacy-host-skill'] },
  },
  mcp: { mode: 'custom', ids: ['legacy-mcp'] },
};
const legacyPrompts = {
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
  prompt_mode: 'append',
};
const legacyIdentityHash = createHash('sha256')
  .update(
    JSON.stringify({
      prompts: legacyPrompts,
      name: 'Legacy Agent',
      runtimePolicy: {
        context: { source: legacyPolicy.context.source },
        skills: legacyPolicy.skills,
        mcp: legacyPolicy.mcp,
      },
    }),
  )
  .digest('hex');
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '68');
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
  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    identity_prompt TEXT NOT NULL DEFAULT '',
    soul_prompt TEXT NOT NULL DEFAULT '',
    agents_prompt TEXT NOT NULL DEFAULT '',
    tools_prompt TEXT NOT NULL DEFAULT '',
    prompt_mode TEXT NOT NULL DEFAULT 'append',
    include_claude_preset INTEGER NOT NULL DEFAULT 1,
    avatar_emoji TEXT,
    avatar_color TEXT,
    avatar_url TEXT,
    model_config_id TEXT,
    runtime_policy TEXT NOT NULL DEFAULT '{}',
    identity_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
legacy
  .prepare(
    `INSERT INTO agent_profiles (
       id, owner_user_id, name, runtime_policy, identity_hash, version,
       is_default, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'legacy-agent',
    'legacy-user',
    'Legacy Agent',
    JSON.stringify(legacyPolicy),
    legacyIdentityHash,
    7,
    0,
    createdAt,
    createdAt,
  );
legacy
  .prepare(
    `INSERT INTO sessions (
       group_folder, session_id, agent_id, agent_profile_id,
       agent_profile_version, identity_hash
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run(
    'legacy-workspace',
    'sdk-session-before-v69',
    '',
    'legacy-agent',
    7,
    legacyIdentityHash,
  );
legacy.close();

const db = await import('../src/db.js');
const agentProfileRuntime = await import('../src/agent-profile-runtime.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v69 Agent effort migration', () => {
  test('preserves v68 identity and warm session compatibility for inherited effort', () => {
    db.initDatabase();

    const profile = db.getAgentProfile('legacy-agent');
    expect(profile?.runtime_policy.reasoning).toEqual({ effort: 'inherit' });
    expect(profile).toMatchObject({
      version: 7,
      identity_hash: legacyIdentityHash,
      updated_at: createdAt,
    });
    expect(profile?.runtime_policy).toMatchObject(legacyPolicy);

    const effectiveProfile =
      agentProfileRuntime.resolveEffectiveAgentProfile(profile);
    const sessionIdentity = db.getSessionAgentIdentity('legacy-workspace');
    expect(db.getSession('legacy-workspace')).toBe('sdk-session-before-v69');
    expect(effectiveProfile?.identity_hash).toBe(legacyIdentityHash);
    expect(sessionIdentity).toEqual({
      agent_profile_id: 'legacy-agent',
      agent_profile_version: 7,
      identity_hash: legacyIdentityHash,
    });
    expect(sessionIdentity?.identity_hash).toBe(
      effectiveProfile?.identity_hash,
    );

    const probe = new Database(databasePath, { readonly: true });
    const stored = probe
      .prepare(
        'SELECT runtime_policy, version, identity_hash, updated_at FROM agent_profiles WHERE id = ?',
      )
      .get('legacy-agent') as {
      runtime_policy: string;
      version: number;
      identity_hash: string;
      updated_at: string;
    };
    expect(JSON.parse(stored.runtime_policy).reasoning).toEqual({
      effort: 'inherit',
    });
    expect(stored).toMatchObject({
      version: 7,
      identity_hash: legacyIdentityHash,
      updated_at: createdAt,
    });
    probe.close();
  });
});
