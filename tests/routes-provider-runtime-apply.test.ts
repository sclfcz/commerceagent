import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'commerceagent-provider-runtime-apply-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'provider-runtime-admin',
        username: 'provider-runtime-admin',
        display_name: 'Provider Runtime Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { GroupQueue } = await import('../src/group-queue.js');

const app = web.createAppForTest({
  queue: {
    stopGroup: vi.fn(async () => {}),
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 0 }),
    resumeGroupsAfterMutation: vi.fn(),
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

let sequence = 0;
let liveQueue: InstanceType<typeof GroupQueue> | null = null;

function unique(label: string): string {
  sequence += 1;
  return `${label}-${sequence}`;
}

function registerWorkspace(jid: string, folder: string) {
  const group = {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container' as const,
    created_by: 'provider-runtime-admin',
  };
  db.setRegisteredGroup(jid, group);
  return group;
}

function bindDeps(
  groups: Record<string, ReturnType<typeof registerWorkspace>>,
  queue: unknown,
  sessions: Record<string, string> = {},
): void {
  web.createAppForTest({
    queue,
    getRegisteredGroups: () => groups,
    sessions,
  } as any);
}

async function patchProvider(
  providerId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function setProviderEnabled(
  providerId: string,
  enabled: boolean,
): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}/toggle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

async function deleteProvider(providerId: string): Promise<Response> {
  return app.request(`/api/config/claude/providers/${providerId}`, {
    method: 'DELETE',
  });
}

async function setDefaultProvider(providerId: string): Promise<Response> {
  return app.request('/api/config/claude/default', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId }),
  });
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  fs.rmSync(path.join(tmpDir, 'container-env'), {
    recursive: true,
    force: true,
  });
});

afterEach(async () => {
  if (liveQueue) {
    await liveQueue.shutdown(0);
    liveQueue = null;
  }
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('provider runtime apply is a lossless configuration mutation', () => {
  test('sets the system default model configuration through HTTP', async () => {
    bindDeps(
      {},
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 10 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
    );
    const initial = runtimeConfig.createProvider({
      name: unique('initial-default'),
      type: 'official',
      anthropicApiKey: 'initial-key',
      enabled: true,
    });
    const replacement = runtimeConfig.createProvider({
      name: unique('replacement-default'),
      type: 'third_party',
      anthropicBaseUrl: 'https://replacement.example.test',
      anthropicAuthToken: 'replacement-token',
      anthropicModel: 'replacement-model',
      enabled: true,
    });
    expect(runtimeConfig.getDefaultProviderId()).toBe(initial.id);

    const response = await setDefaultProvider(replacement.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultProviderId: replacement.id,
      provider: { id: replacement.id, anthropicModel: 'replacement-model' },
      applied: { success: true, persisted: true },
    });
    expect(runtimeConfig.getDefaultProviderId()).toBe(replacement.id);
  });

  test('allows disabling an Agent model but still blocks deleting it', async () => {
    bindDeps(
      {},
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 11 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
    );
    const target = runtimeConfig.createProvider({
      name: unique('agent-model-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      enabled: true,
    });
    const fallback = runtimeConfig.createProvider({
      name: unique('agent-model-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    runtimeConfig.setDefaultProvider(fallback.id);
    const profile = db.createAgentProfile({
      ownerUserId: 'provider-runtime-admin',
      name: unique('bound-agent'),
      modelConfigId: target.id,
    });

    const disableResponse = await setProviderEnabled(target.id, false);
    expect(disableResponse.status).toBe(200);
    expect(await disableResponse.json()).toMatchObject({
      provider: { id: target.id, enabled: false },
    });
    const deleteResponse = await deleteProvider(target.id);
    expect(deleteResponse.status).toBe(400);
    expect(await deleteResponse.json()).toMatchObject({
      error: expect.stringContaining('智能体'),
    });
    expect(
      runtimeConfig
        .getProviders()
        .find((provider) => provider.id === target.id),
    ).toMatchObject({ enabled: false });

    expect(db.archiveAgentProfile(profile.id, 'provider-runtime-admin')).toBe(
      'ok',
    );
  });

  test('keeps a capacity-queued descendant task instead of dropping it', async () => {
    const folder = unique('queued-work');
    const jid = `web:${folder}`;
    const descendantJid = `${jid}#task:scheduled`;
    const group = registerWorkspace(jid, folder);
    const queue = new GroupQueue();
    liveQueue = queue;
    queue.setSerializationKeyResolver((candidate) => {
      const taskSeparator = candidate.indexOf('#task:');
      if (taskSeparator >= 0) {
        return `${folder}#task:${candidate.slice(taskSeparator + 6)}`;
      }
      return candidate === jid ? folder : candidate;
    });
    let capacityAllowed = false;
    queue.setUserConcurrentLimitChecker(() => ({
      allowed: capacityAllowed,
    }));

    let dropped = 0;
    let runs = 0;
    expect(
      queue.enqueueTask(
        descendantJid,
        'scheduled',
        async () => {
          runs += 1;
        },
        {
          onDropped: () => {
            dropped += 1;
          },
        },
      ),
    ).toBe(true);
    expect(queue.listDescendantJids(jid)).toEqual([descendantJid]);

    bindDeps({ [jid]: group }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(dropped).toBe(0);
    expect(queue.listDescendantJids(jid)).toEqual([descendantJid]);
    capacityAllowed = true;
    (
      queue as unknown as {
        drainWaiting: () => void;
      }
    ).drainWaiting();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runs).toBe(1);
    expect(dropped).toBe(0);
  });

  test('never stops the same descendant concurrently when sibling JIDs share a folder', async () => {
    const folder = unique('sibling-stop');
    const webJid = `web:${folder}`;
    const imJid = `feishu:${folder}`;
    const descendantJid = `${webJid}#agent:researcher`;
    const webGroup = registerWorkspace(webJid, folder);
    const imGroup = registerWorkspace(imJid, folder);
    const inFlight = new Set<string>();
    let overlappingDuplicateStops = 0;
    const stopOptions: unknown[] = [];
    const queue = {
      listDescendantJids: () => [descendantJid],
      pauseGroupsForMutation: () => ({ id: 1 }),
      resumeGroupsAfterMutation: vi.fn(),
      stopGroup: vi.fn(async (target: string, options?: unknown) => {
        stopOptions.push(options);
        if (inFlight.has(target)) overlappingDuplicateStops += 1;
        inFlight.add(target);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight.delete(target);
      }),
    };
    bindDeps({ [webJid]: webGroup, [imJid]: imGroup }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('dedupe-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(overlappingDuplicateStops).toBe(0);
    expect(stopOptions).not.toContain(undefined);
    expect(stopOptions).toSatisfy((options) =>
      options.every(
        (option) =>
          (option as { force?: boolean }).force === true &&
          (option as { preserveQueuedWork?: boolean }).preserveQueuedWork ===
            true,
      ),
    );
  });

  test('does not commit a provider update when pre-commit runtime quiesce fails', async () => {
    const folder = unique('pre-commit-failure');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 2 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {
          throw new Error('simulated stop failure');
        }),
      },
    );
    const provider = runtimeConfig.createProvider({
      name: unique('failed-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://old.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'must-not-commit',
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: expect.stringContaining('not updated'),
      applied: { success: false, persisted: false },
    });
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('old-model');
  });

  test('repairs a stale provider session on an exact retry after post-commit quiesce fails', async () => {
    const folder = unique('post-commit-failure');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('stale-session');
    let stopCalls = 0;
    const blockGroupsForRuntimeSafety = vi.fn();
    const unblockGroupsForRuntimeSafety = vi.fn();
    const queue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: () => ({ id: 4 }),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety,
      unblockGroupsForRuntimeSafety,
      stopGroup: vi.fn(async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          // Reproduce a runner finishing late after the transactional cleanup
          // and writing its old provider session back into SQLite.
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', provider.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, queue);
    const provider = runtimeConfig.createProvider({
      name: unique('partially-applied-provider'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSession(folder, unique('initial-session'));
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicModel: 'persisted-model',
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: expect.stringContaining('saved'),
      provider: { anthropicModel: 'persisted-model' },
      applied: { success: false, persisted: true, phase: 'post_commit' },
    });
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('persisted-model');
    expect(db.getSession(folder)).toBe(staleSessionId);
    expect(blockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      [jid],
      expect.stringContaining('post-commit provider runtime cleanup failed'),
      'provider-config-mutation',
    );
    expect(unblockGroupsForRuntimeSafety).not.toHaveBeenCalled();

    // A process restart creates a fresh in-memory queue. The durable pending
    // marker must rebuild its safety block when web dependencies are injected.
    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue);
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);

    // The desired value is already persisted. The retry must still replay the
    // pending invalidation instead of treating this as a no-op.
    const retryResponse = await patchProvider(provider.id, {
      anthropicModel: 'persisted-model',
    });
    expect(retryResponse.status).toBe(200);
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
    expect(db.getSession(folder)).toBeUndefined();
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicModel,
    ).toBe('persisted-model');
  });

  test('retries a persisted provider toggle idempotently instead of reversing it', async () => {
    const folder = unique('toggle-retry');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    let stopCalls = 0;
    const blockGroupsForRuntimeSafety = vi.fn();
    const unblockGroupsForRuntimeSafety = vi.fn();
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 6 }),
        resumeGroupsAfterMutation: vi.fn(),
        blockGroupsForRuntimeSafety,
        unblockGroupsForRuntimeSafety,
        stopGroup: vi.fn(async () => {
          stopCalls += 1;
          if (stopCalls === 2) {
            throw new Error('simulated post-toggle stop failure');
          }
        }),
      },
    );
    const target = runtimeConfig.createProvider({
      name: unique('toggle-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      enabled: true,
    });
    const fallback = runtimeConfig.createProvider({
      name: unique('toggle-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    runtimeConfig.setDefaultProvider(fallback.id);

    const firstResponse = await setProviderEnabled(target.id, false);
    expect(firstResponse.status).toBe(503);
    expect(firstResponse.ok).toBe(false);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === target.id)
        ?.enabled,
    ).toBe(false);
    expect(blockGroupsForRuntimeSafety).toHaveBeenCalled();

    const retryResponse = await setProviderEnabled(target.id, false);
    expect(retryResponse.status).toBe(200);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === target.id)
        ?.enabled,
    ).toBe(false);
    expect(unblockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      [jid],
      'provider-config-mutation',
    );
  });

  test('unblocks a restarted workspace after a disabled provider repairs pending session cleanup', async () => {
    const folder = unique('disabled-provider-repair');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('disabled-repair-stale-session');
    let stopCalls = 0;
    const initialQueue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: () => ({ id: 8 }),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety: vi.fn(),
      unblockGroupsForRuntimeSafety: vi.fn(),
      stopGroup: vi.fn(async () => {
        stopCalls += 1;
        if (stopCalls === 2) {
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', target.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, initialQueue);
    const target = runtimeConfig.createProvider({
      name: unique('disabled-repair-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    const fallback = runtimeConfig.createProvider({
      name: unique('disabled-repair-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    runtimeConfig.setDefaultProvider(fallback.id);
    db.setSession(folder, unique('disabled-repair-initial-session'));
    db.setSessionProviderId(folder, '', target.id);

    const failedPatch = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(failedPatch.status).toBe(503);
    const disableResponse = await setProviderEnabled(target.id, false);
    expect(disableResponse.status).toBe(200);

    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue, {
      [folder]: staleSessionId,
    });
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);

    const repairResponse = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(repairResponse.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
  });

  test('deletes a pending provider through lossless runtime mutation and clears its gate', async () => {
    const folder = unique('pending-provider-delete');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const staleSessionId = unique('delete-stale-session');
    let stopCalls = 0;
    const stopOptions: unknown[] = [];
    const unblockGroupsForRuntimeSafety = vi.fn();
    const queue = {
      listDescendantJids: () => [],
      pauseGroupsForMutation: vi.fn(() => ({ id: 9 })),
      resumeGroupsAfterMutation: vi.fn(),
      blockGroupsForRuntimeSafety: vi.fn(),
      unblockGroupsForRuntimeSafety,
      stopGroup: vi.fn(async (_targetJid: string, options?: unknown) => {
        stopCalls += 1;
        stopOptions.push(options);
        if (stopCalls === 2) {
          db.setSession(folder, staleSessionId);
          db.setSessionProviderId(folder, '', target.id);
          throw new Error('simulated post-commit stop failure');
        }
      }),
    };
    bindDeps({ [jid]: group }, queue);
    const target = runtimeConfig.createProvider({
      name: unique('delete-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    const fallback = runtimeConfig.createProvider({
      name: unique('delete-fallback'),
      type: 'official',
      anthropicApiKey: 'fallback-key',
      enabled: true,
    });
    runtimeConfig.setDefaultProvider(fallback.id);
    db.setSession(folder, unique('delete-initial-session'));
    db.setSessionProviderId(folder, '', target.id);

    const failedPatch = await patchProvider(target.id, {
      anthropicModel: 'persisted-model',
    });
    expect(failedPatch.status).toBe(503);
    expect(db.getSession(folder)).toBe(staleSessionId);

    const deleteResponse = await deleteProvider(target.id);
    expect(deleteResponse.status).toBe(200);
    expect(
      runtimeConfig
        .getProviders()
        .some((provider) => provider.id === target.id),
    ).toBe(false);
    expect(stopCalls).toBe(4);
    expect(stopOptions).toSatisfy((options) =>
      options.every(
        (option) =>
          (option as { force?: boolean }).force === true &&
          (option as { preserveQueuedWork?: boolean }).preserveQueuedWork ===
            true,
      ),
    );
    expect(db.getSession(folder)).toBeUndefined();
    expect(
      db.getRouterState(`provider_session_invalidation_pending:${target.id}`),
    ).toBeUndefined();
    expect(unblockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      [jid],
      'provider-config-mutation',
    );
  });

  test('does not release a runtime safety block owned by another mutation source', async () => {
    const folder = unique('cross-source-runtime-block');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    const queue = new GroupQueue();
    liveQueue = queue;
    bindDeps({ [jid]: group }, queue);
    queue.blockGroupsForRuntimeSafety(
      [jid],
      'capability mutation requires manual repair',
    );
    const provider = runtimeConfig.createProvider({
      name: unique('cross-source-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(queue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);
  });

  test('serializes manual apply with a concurrent provider mutation', async () => {
    const folder = unique('manual-apply-lock');
    const jid = `web:${folder}`;
    const group = registerWorkspace(jid, folder);
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
      releaseFirstStop = resolve;
    });
    let stopCalls = 0;
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 5 }),
        resumeGroupsAfterMutation: vi.fn(),
        blockGroupsForRuntimeSafety: vi.fn(),
        unblockGroupsForRuntimeSafety: vi.fn(),
        stopGroup: vi.fn(async () => {
          stopCalls += 1;
          if (stopCalls === 1) await firstStopGate;
        }),
      },
    );
    const provider = runtimeConfig.createProvider({
      name: unique('locked-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'test-token',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const patchRequest = patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopCalls).toBe(1);

    const manualApplyRequest = app.request('/api/config/claude/apply', {
      method: 'POST',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopCalls).toBe(1);

    releaseFirstStop();
    const [patchResponse, applyResponse] = await Promise.all([
      patchRequest,
      manualApplyRequest,
    ]);
    expect(patchResponse.status).toBe(200);
    expect(applyResponse.status).toBe(200);
    expect(stopCalls).toBe(4);
  });

  test.each([
    { label: 'pre-commit', failAt: 1, persisted: false },
    { label: 'post-commit', failAt: 2, persisted: true },
  ])(
    'returns a non-2xx status when manual apply fails in the $label pass',
    async ({ failAt, persisted }) => {
      const folder = unique('manual-apply-failure');
      const jid = `web:${folder}`;
      const group = registerWorkspace(jid, folder);
      let stopCalls = 0;
      bindDeps(
        { [jid]: group },
        {
          listDescendantJids: () => [],
          pauseGroupsForMutation: () => ({ id: 7 }),
          resumeGroupsAfterMutation: vi.fn(),
          blockGroupsForRuntimeSafety: vi.fn(),
          unblockGroupsForRuntimeSafety: vi.fn(),
          stopGroup: vi.fn(async () => {
            stopCalls += 1;
            if (stopCalls === failAt) {
              throw new Error('simulated manual apply failure');
            }
          }),
        },
      );

      const response = await app.request('/api/config/claude/apply', {
        method: 'POST',
      });
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.ok).toBe(false);
      expect(body).toMatchObject({ success: false, persisted });
    },
  );
});

describe('provider session invalidation only removes attributable sessions', () => {
  function bindIdleWorkspace(jid: string, folder: string, sessionId: string) {
    const group = registerWorkspace(jid, folder);
    const sessions = { [folder]: sessionId };
    bindDeps(
      { [jid]: group },
      {
        listDescendantJids: () => [],
        pauseGroupsForMutation: () => ({ id: 3 }),
        resumeGroupsAfterMutation: vi.fn(),
        stopGroup: vi.fn(async () => {}),
      },
      sessions,
    );
    return sessions;
  }

  test('preserves an unbound session owned by a workspace-level env override', async () => {
    const folder = unique('env-override');
    const jid = `web:${folder}`;
    const sessionId = unique('override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicBaseUrl: 'https://workspace.example.test',
      anthropicAuthToken: 'workspace-token',
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('preserves an unbound session with a workspace model-only override during a global model-only update', async () => {
    const folder = unique('model-only-override');
    const jid = `web:${folder}`;
    const sessionId = unique('model-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('clears an unbound session when credentials override but the changed model does not', async () => {
    const folder = unique('credential-only-override');
    const jid = `web:${folder}`;
    const sessionId = unique('credential-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicAuthToken: 'workspace-token',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('clears an unbound session unless every changed protocol field is overridden', async () => {
    const folder = unique('partial-protocol-override');
    const jid = `web:${folder}`;
    const sessionId = unique('partial-override-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    runtimeConfig.saveContainerEnvConfig(folder, {
      anthropicModel: 'workspace-model',
    });
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicBaseUrl: 'https://old-global.example.test',
      anthropicModel: 'old-global-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'https://new-global.example.test',
      anthropicModel: 'new-global-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('repairs a corrupt durable invalidation marker instead of leaving a permanent gate', async () => {
    const folder = unique('corrupt-pending-marker');
    const jid = `web:${folder}`;
    const sessionId = unique('corrupt-marker-session');
    const group = registerWorkspace(jid, folder);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'unchanged-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);
    db.setRouterState(
      `provider_session_invalidation_pending:${provider.id}`,
      '{corrupt-json',
    );
    const restartedQueue = new GroupQueue();
    liveQueue = restartedQueue;
    bindDeps({ [jid]: group }, restartedQueue, {
      [folder]: sessionId,
    });

    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(true);
    const response = await patchProvider(provider.id, {
      anthropicModel: 'unchanged-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(restartedQueue.isGroupRuntimeSafetyBlocked(jid)).toBe(false);
    expect(
      db.getRouterState(`provider_session_invalidation_pending:${provider.id}`),
    ).toBeUndefined();
  });

  test('preserves ambiguous unbound sessions when another provider is configured but disabled', async () => {
    const folder = unique('ambiguous-unbound');
    const jid = `web:${folder}`;
    const sessionId = unique('ambiguous-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    runtimeConfig.createProvider({
      name: unique('disabled-third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://disabled.example.test',
      anthropicAuthToken: 'disabled-token',
      enabled: false,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(sessionId);
  });

  test('still clears a legacy unbound session in a true single-provider workspace', async () => {
    const folder = unique('single-provider');
    const jid = `web:${folder}`;
    const sessionId = unique('legacy-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicModel: 'old-model',
      enabled: true,
    });

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
  });

  test('clears a bound third-party session for a model-only change', async () => {
    const folder = unique('third-party-model');
    const jid = `web:${folder}`;
    const sessionId = unique('bound-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('third-party'),
      type: 'third_party',
      anthropicBaseUrl: 'https://same.example.test',
      anthropicAuthToken: 'third-party-token',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBeUndefined();
    expect(db.getSessionProviderId(folder)).toBeUndefined();
  });

  test('does not clear a provider session when the requested config is invalid', async () => {
    const folder = unique('invalid-provider-patch');
    const jid = `web:${folder}`;
    const sessionId = unique('invalid-patch-session');
    bindIdleWorkspace(jid, folder, sessionId);
    db.setSession(folder, sessionId);
    const provider = runtimeConfig.createProvider({
      name: unique('official'),
      type: 'official',
      anthropicApiKey: 'official-key',
      anthropicBaseUrl: 'https://valid.example.test',
      anthropicModel: 'old-model',
      enabled: true,
    });
    db.setSessionProviderId(folder, '', provider.id);

    const response = await patchProvider(provider.id, {
      anthropicBaseUrl: 'not-a-url',
    });

    expect(response.status).toBe(400);
    expect(db.getSession(folder)).toBe(sessionId);
    expect(db.getSessionProviderId(folder)).toBe(provider.id);
    expect(
      runtimeConfig.getProviders().find((item) => item.id === provider.id)
        ?.anthropicBaseUrl,
    ).toBe('https://valid.example.test');
  });

  test('keeps the main-session cache when only a target-provider agent session is invalidated', async () => {
    const folder = unique('agent-only-invalidation');
    const jid = `web:${folder}`;
    const mainSessionId = unique('main-session');
    const agentSessionId = unique('agent-session');
    const sessions = bindIdleWorkspace(jid, folder, mainSessionId);
    db.setSession(folder, mainSessionId);
    const target = runtimeConfig.createProvider({
      name: unique('official-target'),
      type: 'official',
      anthropicApiKey: 'target-key',
      anthropicModel: 'old-model',
      enabled: true,
    });
    const other = runtimeConfig.createProvider({
      name: unique('other-provider'),
      type: 'third_party',
      anthropicBaseUrl: 'https://other.example.test',
      anthropicAuthToken: 'other-token',
      enabled: false,
    });
    db.setSessionProviderId(folder, '', other.id);
    db.setSession(folder, agentSessionId, 'agent-a');
    db.setSessionProviderId(folder, 'agent-a', target.id);

    const response = await patchProvider(target.id, {
      anthropicModel: 'new-model',
    });

    expect(response.status).toBe(200);
    expect(db.getSession(folder)).toBe(mainSessionId);
    expect(db.getSession(folder, 'agent-a')).toBeUndefined();
    expect(sessions[folder]).toBe(mainSessionId);
  });
});
