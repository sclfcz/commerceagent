import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-isolation-'));
const externalDir = path.join(root, 'configured-claude');
const customProfiles = vi.hoisted(() => [] as any[]);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return { ...real, DATA_DIR: root };
});
vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/runtime-config.js')>();
  return { ...real, getEffectiveExternalDir: () => externalDir };
});
vi.mock('../src/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db.js')>();
  return { ...real, listAgentProfilesForUser: () => customProfiles };
});
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: c.req.header('x-test-user') || 'member-a',
      username: 'test',
      role: c.req.header('x-test-role') || 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const routes = (await import('../src/routes/mcp-servers.js')).default;
const app = new Hono().route('/api/mcp-servers', routes);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('MCP owner isolation and explicit host import', () => {
  test('admin manages system MCP while members receive a read-only source-qualified view', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'admin-system',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        id: 'platform',
        scope: 'system',
        command: 'platform-mcp',
        args: ['--token', 'args-secret'],
        env: { TOKEN: 'system-secret' },
      }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({
      server: {
        source: 'system',
        sourceKey: 'system:platform',
        memberAccess: 'admin_only',
        runtimeAvailable: true,
        envKeys: ['TOKEN'],
      },
    });

    const memberList = await app.request('/api/mcp-servers', {
      headers: { 'x-test-user': 'member-system' },
    });
    const platform = (await memberList.json()).servers.find(
      (server: any) => server.sourceKey === 'system:platform',
    );
    expect(platform).toMatchObject({
      readonly: true,
      source: 'system',
      envKeys: [],
      hasEnvSecrets: true,
      memberAccess: 'admin_only',
      runtimeAvailable: false,
      unavailableReason: 'system_admin_only',
    });
    expect(JSON.stringify(platform)).not.toContain('system-secret');
    expect(JSON.stringify(platform)).not.toContain('TOKEN');
    expect(JSON.stringify(platform)).not.toContain('args-secret');
    expect(platform).not.toHaveProperty('command');
    expect(platform).not.toHaveProperty('args');

    const detail = await app.request(
      '/api/mcp-servers/platform?source=system',
      { headers: { 'x-test-user': 'member-system' } },
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      server: {
        memberAccess: 'admin_only',
        runtimeAvailable: false,
      },
    });
    const forbidden = await app.request(
      '/api/mcp-servers/platform?source=system',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-test-user': 'member-system',
        },
        body: JSON.stringify({ memberAccess: 'shared' }),
      },
    );
    expect(forbidden.status).toBe(403);

    const share = await app.request('/api/mcp-servers/platform?source=system', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'admin-system',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({ memberAccess: 'shared' }),
    });
    expect(share.status).toBe(200);
    expect(await share.json()).toMatchObject({
      server: { memberAccess: 'shared', runtimeAvailable: true },
    });

    const sharedDetail = await app.request(
      '/api/mcp-servers/platform?source=system',
      { headers: { 'x-test-user': 'member-system' } },
    );
    expect(sharedDetail.status).toBe(200);
    const sharedServer = (await sharedDetail.json()).server;
    expect(sharedServer).toMatchObject({
      memberAccess: 'shared',
      runtimeAvailable: true,
      command: 'platform-mcp',
      args: ['--token', 'args-secret'],
      envKeys: [],
    });
    expect(JSON.stringify(sharedServer)).not.toContain('TOKEN');
  });

  test('validates memberAccess and defaults legacy-risky URL definitions to admin-only', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'admin-access',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        id: 'gateway',
        scope: 'system',
        type: 'http',
        url: 'https://example.test/mcp?token=url-secret',
      }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({
      server: { memberAccess: 'admin_only' },
    });

    const memberDetail = await app.request(
      '/api/mcp-servers/gateway?source=system',
      { headers: { 'x-test-user': 'member-access' } },
    );
    const memberServer = (await memberDetail.json()).server;
    expect(memberServer).toMatchObject({
      memberAccess: 'admin_only',
      runtimeAvailable: false,
    });
    expect(memberServer).not.toHaveProperty('url');
    expect(JSON.stringify(memberServer)).not.toContain('url-secret');

    const invalidCreate = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'admin-access',
        'x-test-role': 'admin',
      },
      body: JSON.stringify({
        id: 'invalid_access',
        scope: 'system',
        command: 'node',
        memberAccess: 'public',
      }),
    });
    expect(invalidCreate.status).toBe(400);

    const invalidPatch = await app.request(
      '/api/mcp-servers/gateway?source=system',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-test-user': 'admin-access',
          'x-test-role': 'admin',
        },
        body: JSON.stringify({ memberAccess: null }),
      },
    );
    expect(invalidPatch.status).toBe(400);

    const personalAccess = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'member-access',
      },
      body: JSON.stringify({
        id: 'personal_access',
        command: 'node',
        memberAccess: 'shared',
      }),
    });
    expect(personalAccess.status).toBe(400);
  });

  test('isolates definitions and secrets by authenticated owner', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-user': 'member-a',
      },
      body: JSON.stringify({
        id: 'only_a',
        command: 'node',
        env: { TOKEN: 'owner-a-secret' },
      }),
    });
    expect(create.status).toBe(200);

    const otherList = await app.request('/api/mcp-servers', {
      headers: { 'x-test-user': 'member-b' },
    });
    const otherServers = (await otherList.json()).servers;
    expect(
      otherServers.filter((server: any) => server.source === 'user'),
    ).toEqual([]);
    const otherDetail = await app.request('/api/mcp-servers/only_a', {
      headers: { 'x-test-user': 'member-b' },
    });
    expect(otherDetail.status).toBe(404);
  });

  test('imports a copy from configured externalClaudeDir without later overwriting it', async () => {
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(
      path.join(externalDir, 'settings.json'),
      JSON.stringify({
        mcpServers: {
          native: {
            command: 'native-v1',
            env: { NATIVE_TOKEN: 'host-secret' },
          },
        },
      }),
    );
    const headers = { 'x-test-user': 'admin-a', 'x-test-role': 'admin' };
    const first = await app.request('/api/mcp-servers/sync-host', {
      method: 'POST',
      headers,
    });
    expect(await first.json()).toMatchObject({
      added: 1,
      updated: 0,
      deleted: 0,
      importedFrom: externalDir,
    });

    fs.writeFileSync(
      path.join(externalDir, 'settings.json'),
      JSON.stringify({
        mcpServers: { native: { command: 'native-v2' } },
      }),
    );
    const second = await app.request('/api/mcp-servers/sync-host', {
      method: 'POST',
      headers,
    });
    expect(await second.json()).toMatchObject({
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: 1,
    });
    const detail = await app.request('/api/mcp-servers/native', { headers });
    expect(await detail.json()).toMatchObject({
      server: {
        command: 'native-v1',
        importedFromHost: true,
        envKeys: ['NATIVE_TOKEN'],
      },
    });
  });

  test('fails closed when disabling or deleting an MCP selected by a custom Agent', async () => {
    const headers = {
      'content-type': 'application/json',
      'x-test-user': 'guarded-owner',
    };
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'guarded', command: 'node' }),
    });
    expect(create.status).toBe(200);
    customProfiles.push({
      name: 'Guarded Agent',
      runtime_policy: { mcp: { mode: 'custom', ids: ['guarded'] } },
    });

    const disable = await app.request('/api/mcp-servers/guarded', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(409);
    expect(await disable.json()).toMatchObject({
      referencedByProfiles: ['Guarded Agent'],
    });
    const remove = await app.request('/api/mcp-servers/guarded', {
      method: 'DELETE',
      headers,
    });
    expect(remove.status).toBe(409);
  });
});
