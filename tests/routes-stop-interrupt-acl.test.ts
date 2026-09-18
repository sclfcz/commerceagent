/**
 * Resource-level ACL for POST /:jid/stop and /:jid/interrupt.
 *
 * Both routes require workspace ownership. Non-owners cannot discover or
 * control another account's workspace runner.
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
      path.join(os.tmpdir(), 'commerceagent-stop-interrupt-'),
    );
    process.env.COMMERCEAGENT_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

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
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.COMMERCEAGENT_TEST_USER_ID ?? 'alice',
        username: 'alice',
        role: (process.env.COMMERCEAGENT_TEST_USER_ROLE ?? 'member') as
          | 'admin'
          | 'member',
        permissions: [],
      });
      return next();
    },
  };
});

// groups.ts statically imports these from web.js — mock so importing the route
// module doesn't pull in the full Hono app + WebSocket.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:stop-interrupt-group';
const GROUP_FOLDER = 'stop-interrupt-group';

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Stop/Interrupt ACL Group',
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

async function post(
  pathSuffix: string,
): Promise<{ status: number; body: any }> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}${pathSuffix}`,
    { method: 'POST' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    queue: {
      stopGroup: async () => {},
      interruptQuery: () => false,
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  delete process.env.COMMERCEAGENT_TEST_USER_ID;
  delete process.env.COMMERCEAGENT_TEST_USER_ROLE;
});

for (const route of ['/stop', '/interrupt'] as const) {
  describe(`POST /:jid${route} resource-level ACL`, () => {
    test('owner is allowed (200)', async () => {
      seedTestGroup();
      asUser(OWNER_ID);
      const { status } = await post(route);
      expect(status).toBe(200);
    });

    test('non-owner gets 404 (group hidden by canAccessGroup)', async () => {
      seedTestGroup();
      asUser(OUTSIDER_ID);
      const { status, body } = await post(route);
      expect(status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });
}
