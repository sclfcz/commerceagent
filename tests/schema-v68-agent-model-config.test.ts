import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v68-agent-model-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO router_state VALUES ('schema_version', '67');
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
    runtime_policy TEXT NOT NULL DEFAULT '{}',
    identity_hash TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO agent_profiles (
    id, owner_user_id, name, identity_hash, is_default, created_at, updated_at
  ) VALUES (
    'legacy-agent', 'legacy-user', 'Legacy Agent', 'legacy-hash', 1,
    '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z'
  );
`);
legacy.close();

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v68 Agent model configuration migration', () => {
  test('adds a nullable model binding and preserves existing Agents', () => {
    db.initDatabase();

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getAgentProfile('legacy-agent')).toMatchObject({
      id: 'legacy-agent',
      name: 'Legacy Agent',
      model_config_id: null,
    });

    const probe = new Database(databasePath, { readonly: true });
    const columns = probe.pragma('table_info(agent_profiles)') as Array<{
      name: string;
    }>;
    expect(columns.some((column) => column.name === 'model_config_id')).toBe(
      true,
    );
    expect(
      probe
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_agent_profiles_model_config'",
        )
        .get(),
    ).toEqual({ name: 'idx_agent_profiles_model_config' });
    probe.close();
  });
});
