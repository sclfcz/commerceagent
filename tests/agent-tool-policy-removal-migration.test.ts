import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tool-removal-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('retired Agent tool policy migration', () => {
  test('removes persisted tool restrictions and invalidates their runtime identity', () => {
    db.initDatabase();
    const now = new Date().toISOString();
    db.createUser({
      id: 'legacy-policy-owner',
      username: 'legacy-policy-owner',
      password_hash: 'hash',
      display_name: 'Legacy Owner',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const profile = db.createAgentProfile({
      ownerUserId: 'legacy-policy-owner',
      name: 'Legacy Restricted Agent',
    });
    db.closeDatabase();

    const raw = new Database(path.join(storeDir, 'messages.db'));
    raw
      .prepare(
        `UPDATE agent_profiles
       SET runtime_policy = ?, identity_hash = 'legacy-restricted-hash', version = 3
       WHERE id = ?`,
      )
      .run(
        JSON.stringify({
          context: { source: 'managed' },
          skills: { mode: 'inherit', ids: [] },
          mcp: { mode: 'inherit', ids: [] },
          tools: { mode: 'restricted' },
        }),
        profile.id,
      );
    raw.close();

    db.initDatabase();
    const migrated = db.getAgentProfile(profile.id)!;
    expect(migrated.runtime_policy).toEqual({
      reasoning: { effort: 'inherit' },
      context: {
        source: 'managed',
        auto_compact_window: 0,
        auto_compact_percentage: 0,
      },
      skills: { mode: 'inherit', ids: [] },
      mcp: { mode: 'inherit', ids: [] },
    });
    expect(migrated.identity_hash).not.toBe('legacy-restricted-hash');
    expect(migrated.version).toBe(4);

    db.closeDatabase();
    const inspected = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const row = inspected
      .prepare('SELECT runtime_policy FROM agent_profiles WHERE id = ?')
      .get(profile.id) as { runtime_policy: string };
    inspected.close();
    expect(JSON.parse(row.runtime_policy)).not.toHaveProperty('tools');
  });
});
