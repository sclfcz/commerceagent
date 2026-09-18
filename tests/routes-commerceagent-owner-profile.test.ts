import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'routes-commerceagent-owner-profile-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_USER ?? 'route-owner';
    c.set('user', {
      id,
      username: id,
      display_name: id,
      role:
        process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_ROLE === 'admin'
          ? 'admin'
          : 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const memoryStore = await import('../src/memory-store.js');
const workspaceRoutes = (await import('../src/routes/workspaces.js')).default;
const memoryRoutes = (await import('../src/routes/memory.js')).default;

const OWNER_ID = 'route-owner';
const OTHER_ID = 'route-other';
const ADMIN_ID = 'route-admin';
let homeJid: string;
let skipHomeJid: string;

function createUser(id: string, role: 'member' | 'admin' = 'member'): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

function asUser(id: string, role: 'member' | 'admin' = 'member'): void {
  process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_USER = id;
  process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_ROLE = role;
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function ownerProfileRequest(
  workspaceJid: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await workspaceRoutes.request(
    `/${encodeURIComponent(workspaceJid)}/owner-profile`,
    {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function genericMemoryRequest(
  workspaceJid: string,
  suffix: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await memoryRoutes.request(
    `/workspaces/${encodeURIComponent(workspaceJid)}/items${suffix}`,
    {
      method,
      headers:
        body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

beforeAll(() => {
  db.initDatabase();
  createUser(OWNER_ID);
  createUser(OTHER_ID);
  createUser(ADMIN_ID, 'admin');
  homeJid = db.ensureUserHomeGroup(OWNER_ID, 'member', OWNER_ID);

  skipHomeJid = 'web:route-owner-skip-home';
  db.setRegisteredGroup(skipHomeJid, {
    name: 'Skip onboarding Home',
    folder: 'route-owner-skip-home',
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    is_home: true,
  });
  db.assignWorkspaceAgentProfile(
    'route-owner-skip-home',
    db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
  );
});

afterEach(() => {
  delete process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_USER;
  delete process.env.COMMERCEAGENT_OWNER_PROFILE_ROUTE_ROLE;
});

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('/api/workspaces/:jid/owner-profile', () => {
  test('owner can get, set, update, clear, and retain completed onboarding', async () => {
    asUser(OWNER_ID);
    expect(await ownerProfileRequest(homeJid)).toMatchObject({
      status: 200,
      body: {
        profile: {
          preferredAddress: null,
          revision: null,
          onboarding: { state: 'pending', revision: 0 },
        },
      },
    });

    const set = await ownerProfileRequest(homeJid, 'PATCH', {
      action: 'set',
      preferredAddress: '小何',
      expectedRevision: 0,
      idempotencyKey: 'route-owner-first-set',
    });
    expect(set).toMatchObject({
      status: 200,
      body: {
        changed: true,
        replayed: false,
        projection: {
          preferredAddress: '小何',
          revision: 1,
          onboarding: { state: 'completed' },
        },
      },
    });

    const stale = await ownerProfileRequest(homeJid, 'PATCH', {
      action: 'set',
      preferredAddress: '过期写入',
      expectedRevision: 0,
    });
    expect(stale).toMatchObject({
      status: 409,
      body: {
        error: 'revision_conflict',
        currentRevision: 1,
      },
    });

    const updated = await ownerProfileRequest(homeJid, 'PATCH', {
      action: 'set',
      preferredAddress: '何先生',
      expectedRevision: 1,
    });
    expect(updated).toMatchObject({
      status: 200,
      body: {
        projection: { preferredAddress: '何先生', revision: 2 },
      },
    });
    const cleared = await ownerProfileRequest(homeJid, 'PATCH', {
      action: 'clear',
      expectedRevision: 2,
    });
    expect(cleared).toMatchObject({
      status: 200,
      body: {
        projection: {
          preferredAddress: null,
          revision: 3,
          onboarding: { state: 'completed' },
        },
      },
    });
    expect(await ownerProfileRequest(homeJid)).toMatchObject({
      status: 200,
      body: {
        profile: {
          preferredAddress: null,
          revision: 3,
          onboarding: { state: 'completed' },
        },
      },
    });

    const raw = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const actors = raw
      .prepare(
        `SELECT actor_id
         FROM workspace_memory_versions
         WHERE workspace_jid = ? AND canonical_key = ?
         ORDER BY revision`,
      )
      .all(
        homeJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      ) as Array<{ actor_id: string }>;
    expect(actors).toEqual([
      { actor_id: OWNER_ID },
      { actor_id: OWNER_ID },
      { actor_id: OWNER_ID },
    ]);
    raw.close();
  });

  test('owner can permanently skip first-wake onboarding', async () => {
    asUser(OWNER_ID);
    const initial = await ownerProfileRequest(skipHomeJid);
    const revision = initial.body.profile.onboarding.revision;
    const skipped = await ownerProfileRequest(skipHomeJid, 'PATCH', {
      action: 'skip',
      expectedOnboardingRevision: revision,
    });
    expect(skipped).toMatchObject({
      status: 200,
      body: {
        changed: true,
        projection: {
          preferredAddress: null,
          onboarding: { state: 'skipped' },
        },
      },
    });
  });

  test('other users and admin-as-non-owner receive indistinguishable 404s', async () => {
    for (const [id, role] of [
      [OTHER_ID, 'member'],
      [ADMIN_ID, 'admin'],
    ] as const) {
      asUser(id, role);
      expect((await ownerProfileRequest(homeJid)).status).toBe(404);
      expect(
        (
          await ownerProfileRequest(homeJid, 'PATCH', {
            action: 'set',
            preferredAddress: '越权称呼',
            expectedRevision: 3,
          })
        ).status,
      ).toBe(404);
    }
  });

  test('non-Home and custom-profile Home workspaces fail closed', async () => {
    const defaultProfile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    db.setRegisteredGroup('web:route-owner-non-home', {
      name: 'Non Home',
      folder: 'route-owner-non-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('route-owner-non-home', defaultProfile.id);

    const custom = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Custom route profile',
      identityPrompt: 'Remain isolated from CommerceAgent Owner Profile.',
    });
    const customJid = 'web:route-owner-custom-home';
    db.setRegisteredGroup(customJid, {
      name: 'Temporarily non-Home',
      folder: 'route-owner-custom-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('route-owner-custom-home', custom.id);
    db.setRegisteredGroup(customJid, {
      name: 'Corrupt custom-profile Home',
      folder: 'route-owner-custom-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      is_home: true,
    });

    asUser(OWNER_ID);
    expect((await ownerProfileRequest('web:route-owner-non-home')).status).toBe(
      404,
    );
    expect((await ownerProfileRequest(customJid)).status).toBe(404);
  });

  test('generic Workspace Memory API cannot create, update, or forget the reserved item', async () => {
    asUser(OWNER_ID);
    const created = await ownerProfileRequest(skipHomeJid, 'PATCH', {
      action: 'set',
      preferredAddress: '专用称呼',
      expectedRevision: 0,
    });
    expect(created.status).toBe(200);

    const genericCreate = await genericMemoryRequest(skipHomeJid, '', 'POST', {
      kind: 'fact',
      content: 'generic create',
      canonicalKey: memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
    });
    expect(genericCreate).toMatchObject({
      status: 400,
      body: { error: 'reserved_canonical_key' },
    });

    const raw = new Database(path.join(storeDir, 'messages.db'));
    const item = raw
      .prepare(
        `SELECT id, store_id, revision
         FROM workspace_memory_items
         WHERE workspace_jid = ? AND canonical_key = ?`,
      )
      .get(
        skipHomeJid,
        memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
      ) as { id: string; store_id: string; revision: number };
    const legacyCreateKey = 'route-legacy-generic-create-replay';
    const legacyUpdateKey = 'route-legacy-generic-update-replay';
    const legacyForgetKey = 'route-legacy-generic-forget-replay';
    const legacyUpdatePatch = { content: 'legacy replay update' };
    const legacyUpdateHash = requestHash({
      itemId: item.id,
      expectedRevision: item.revision,
      patch: legacyUpdatePatch,
    });
    const legacyForgetHash = requestHash({
      itemId: item.id,
      expectedRevision: item.revision,
      reason: null,
    });
    raw
      .prepare(
        `UPDATE workspace_memory_items
       SET create_idempotency_key = ?, create_request_hash = NULL
       WHERE id = ?`,
      )
      .run(legacyCreateKey, item.id);
    const leakedReplay = JSON.stringify({
      store: { id: item.store_id, workspaceJid: skipHomeJid, revision: 1 },
      item: {
        id: item.id,
        workspaceJid: skipHomeJid,
        canonicalKey:
          memoryStore.COMMERCEAGENT_OWNER_PREFERRED_ADDRESS_CANONICAL_KEY,
        content: '专用称呼',
        revision: item.revision,
      },
    });
    raw
      .prepare(
        `INSERT INTO workspace_memory_mutation_requests (
        store_id, idempotency_key, operation, item_id, request_hash,
        response_json, created_at
      ) VALUES
        (?, ?, 'update', ?, ?, ?, ?),
        (?, ?, 'forget', ?, ?, ?, ?)`,
      )
      .run(
        item.store_id,
        legacyUpdateKey,
        item.id,
        legacyUpdateHash,
        leakedReplay,
        '2026-07-28T15:00:00.000Z',
        item.store_id,
        legacyForgetKey,
        item.id,
        legacyForgetHash,
        leakedReplay,
        '2026-07-28T15:00:00.000Z',
      );
    raw.close();

    const genericUpdate = await genericMemoryRequest(
      skipHomeJid,
      `/${item.id}`,
      'PATCH',
      {
        expectedRevision: item.revision,
        content: 'generic update',
      },
    );
    const genericForget = await genericMemoryRequest(
      skipHomeJid,
      `/${item.id}`,
      'DELETE',
      { expectedRevision: item.revision },
    );
    for (const response of [genericUpdate, genericForget]) {
      expect(response).toMatchObject({
        status: 400,
        body: { error: 'reserved_canonical_key' },
      });
    }

    const legacyCreateReplay = await genericMemoryRequest(
      skipHomeJid,
      '',
      'POST',
      {
        kind: 'fact',
        content: 'ordinary generic create replay',
        idempotencyKey: legacyCreateKey,
      },
    );
    const legacyUpdateReplay = await genericMemoryRequest(
      skipHomeJid,
      `/${item.id}`,
      'PATCH',
      {
        expectedRevision: item.revision,
        content: legacyUpdatePatch.content,
        idempotencyKey: legacyUpdateKey,
      },
    );
    const legacyForgetReplay = await genericMemoryRequest(
      skipHomeJid,
      `/${item.id}`,
      'DELETE',
      {
        expectedRevision: item.revision,
        idempotencyKey: legacyForgetKey,
      },
    );
    for (const response of [
      legacyCreateReplay,
      legacyUpdateReplay,
      legacyForgetReplay,
    ]) {
      expect(response).toMatchObject({
        status: 400,
        body: { error: 'reserved_canonical_key' },
      });
      expect(JSON.stringify(response.body)).not.toContain('专用称呼');
    }
  });
});
