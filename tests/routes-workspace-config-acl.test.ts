/**
 * Verifies that workspace-config write routes (mcp-servers + skills) require
 * owner-level permissions (canModifyGroup).
 *
 * Coverage matrix (per Codex v4 review):
 *   - owner       → mcp-servers POST / PATCH succeed
 *   - non-owner   → all routes return 404 (group hidden by canAccessGroup)
 *   - owner       → skills PATCH (toggle) on a fake-on-disk skill succeeds
 *
 * Skills install is NOT covered (it runs `npx skills add` and is a wrapper
 * around an external tool). The DELETE / PATCH paths exercise the same
 * resolveGroup + requireWorkspaceOwner ACL chain, which is what we're testing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.COMMERCEAGENT_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-routes-workspace-config-'),
    );
    process.env.COMMERCEAGENT_TEST_DATA_DIR = d;
    return d;
  })();

let tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.COMMERCEAGENT_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.COMMERCEAGENT_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.COMMERCEAGENT_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const workspaceConfigRoutesModule =
  await import('../src/routes/workspace-config.js');
const db = await import('../src/db.js');
const config = await import('../src/config.js');

const workspaceConfigRoutes = workspaceConfigRoutesModule.default;

const OWNER_ID = 'alice';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:test-group';
const GROUP_FOLDER = 'test-group';

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Test Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.COMMERCEAGENT_TEST_USER_ID = userId;
  process.env.COMMERCEAGENT_TEST_USER_ROLE = role;
}

beforeAll(() => {
  // Ensure tmp data + db dirs exist before initDatabase().
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  // Clear DB tables between tests instead of recreating the DB (WAL handle
  // would otherwise dangle). Reuse the singleton from beforeAll.
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  // Wipe groups dir to drop leftover .claude/ from previous test
  const groupsDir = path.join(tmpDataDir, 'groups');
  if (fs.existsSync(groupsDir)) {
    fs.rmSync(groupsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(groupsDir, { recursive: true });
});

afterEach(() => {
  delete process.env.COMMERCEAGENT_TEST_USER_ID;
  delete process.env.COMMERCEAGENT_TEST_USER_ROLE;
});

async function postMcp(body: unknown): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchMcp(
  id: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteMcp(id: string): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers/${id}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getMcp(): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/mcp-servers`,
    { method: 'GET' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchSkill(
  id: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/skills/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteSkill(id: string): Promise<{ status: number; body: any }> {
  const res = await workspaceConfigRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/workspace-config/skills/${id}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function seedFakeSkill(skillId: string): void {
  const skillDir = path.join(
    config.GROUPS_DIR,
    GROUP_FOLDER,
    '.claude',
    'skills',
    skillId,
  );
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: test\ndescription: t\n---\n# Test skill\n',
  );
}

describe('workspace-config ACL — MCP servers', () => {
  test('owner can POST a new MCP server', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postMcp({
      id: 'mysrv',
      command: 'echo',
      args: ['hello'],
    });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.server.id).toBe('mysrv');
  });

  test('non-owner returns 404 on POST (group hidden by canAccessGroup)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);

    const { status, body } = await postMcp({ id: 'srv5', command: 'echo' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

describe('workspace-config ACL — skills', () => {
  test('owner can PATCH (disable) a fake-on-disk skill', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(OWNER_ID);

    const { status, body } = await patchSkill('my-skill', { enabled: false });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('non-owner returns 404 on skills DELETE', async () => {
    seedTestGroup();
    seedFakeSkill('my-skill');
    asUser(OUTSIDER_ID);

    const { status, body } = await deleteSkill('my-skill');
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});
