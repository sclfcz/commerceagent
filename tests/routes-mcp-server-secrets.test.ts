import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerceagent-mcp-secrets-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return { ...real, DATA_DIR: tmpDir };
});

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'mcp-secret-user',
      username: 'mcp-secret-user',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
    });
    return next();
  },
}));

const routes = (await import('../src/routes/mcp-servers.js')).default;
const { loadUserMcpServers } = await import('../src/mcp-utils.js');
const app = new Hono().route('/api/mcp-servers', routes);

beforeAll(() => fs.mkdirSync(tmpDir, { recursive: true }));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('MCP secret exposure boundary', () => {
  test('first runtime read atomically migrates legacy embedded secrets and is idempotent', () => {
    const root = path.join(tmpDir, 'mcp-servers', 'legacy-owner');
    fs.mkdirSync(root, { recursive: true });
    const definitionsPath = path.join(root, 'servers.json');
    fs.writeFileSync(
      definitionsPath,
      JSON.stringify({
        servers: {
          legacy: {
            enabled: true,
            command: 'node',
            env: { TOKEN: 'legacy-secret' },
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    expect(loadUserMcpServers('legacy-owner').legacy).toMatchObject({
      env: { TOKEN: 'legacy-secret' },
    });
    expect(fs.readFileSync(definitionsPath, 'utf8')).not.toContain(
      'legacy-secret',
    );
    const secretsPath = path.join(root, 'secrets.json');
    const firstSecrets = fs.readFileSync(secretsPath, 'utf8');
    expect(firstSecrets).toContain('legacy-secret');
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);

    expect(loadUserMcpServers('legacy-owner').legacy).toMatchObject({
      env: { TOKEN: 'legacy-secret' },
    });
    expect(fs.readFileSync(secretsPath, 'utf8')).toBe(firstSecrets);
  });

  test('reclaims a pre-existing stale migration lock without leaving plaintext secrets', () => {
    const root = path.join(tmpDir, 'mcp-servers', 'stale-lock-owner');
    fs.mkdirSync(root, { recursive: true });
    const definitionsPath = path.join(root, 'servers.json');
    const secretsPath = path.join(root, 'secrets.json');
    const lockPath = path.join(root, '.secret-migration.lock');
    fs.writeFileSync(
      definitionsPath,
      JSON.stringify({
        servers: {
          legacy: {
            enabled: true,
            command: 'node',
            env: { TOKEN: 'stale-lock-secret' },
            headers: { Authorization: 'stale-header-secret' },
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        token: 'abandoned-owner-token',
        pid: 2_147_483_647,
        processStartTime: '1',
        createdAt: Date.now() - 60 * 60 * 1000,
      }),
      { mode: 0o600 },
    );
    const staleAt = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockPath, staleAt, staleAt);

    expect(loadUserMcpServers('stale-lock-owner').legacy).toMatchObject({
      env: { TOKEN: 'stale-lock-secret' },
    });
    expect(fs.existsSync(lockPath)).toBe(false);
    const scrubbed = fs.readFileSync(definitionsPath, 'utf8');
    expect(scrubbed).not.toContain('stale-lock-secret');
    expect(scrubbed).not.toContain('stale-header-secret');
    expect(scrubbed).not.toContain('"env"');
    expect(scrubbed).not.toContain('"headers"');
    const migratedSecrets = fs.readFileSync(secretsPath, 'utf8');
    expect(migratedSecrets).toContain('stale-lock-secret');
    expect(migratedSecrets).toContain('stale-header-secret');
    expect(fs.statSync(secretsPath).mode & 0o777).toBe(0o600);
  });

  test('does not remove a live migration lock owned by this process', () => {
    const root = path.join(tmpDir, 'mcp-servers', 'live-lock-owner');
    fs.mkdirSync(root, { recursive: true });
    const definitionsPath = path.join(root, 'servers.json');
    const lockPath = path.join(root, '.secret-migration.lock');
    fs.writeFileSync(
      definitionsPath,
      JSON.stringify({
        servers: {
          legacy: {
            enabled: true,
            command: 'node',
            env: { TOKEN: 'live-lock-secret' },
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const liveOwner = {
      token: 'live-owner-token',
      pid: process.pid,
      createdAt: Date.now(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(liveOwner), { mode: 0o600 });

    expect(loadUserMcpServers('live-lock-owner').legacy).toMatchObject({
      env: { TOKEN: 'live-lock-secret' },
    });
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toMatchObject(
      liveOwner,
    );
    expect(fs.readFileSync(definitionsPath, 'utf8')).toContain(
      'live-lock-secret',
    );

    fs.rmSync(lockPath);
    loadUserMcpServers('live-lock-owner');
    expect(fs.readFileSync(definitionsPath, 'utf8')).not.toContain(
      'live-lock-secret',
    );
  });

  test('never returns secret values and stores definitions separately', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'private_stdio',
        command: 'node',
        args: ['server.js'],
        env: { PRIVATE_TOKEN: 'top-secret' },
      }),
    });
    expect(create.status).toBe(200);
    expect(await create.json()).toMatchObject({
      server: { id: 'private_stdio', envKeys: ['PRIVATE_TOKEN'] },
    });

    const list = await app.request('/api/mcp-servers');
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.servers[0]).toMatchObject({
      id: 'private_stdio',
      envKeys: ['PRIVATE_TOKEN'],
    });
    expect(listBody.servers[0]).not.toHaveProperty('env');
    expect(JSON.stringify(listBody)).not.toContain('top-secret');

    const detail = await app.request('/api/mcp-servers/private_stdio');
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      server: {
        id: 'private_stdio',
        envKeys: ['PRIVATE_TOKEN'],
        hasEnvSecrets: true,
      },
    });
    expect(JSON.stringify(detailBody)).not.toContain('top-secret');

    const root = path.join(tmpDir, 'mcp-servers', 'mcp-secret-user');
    expect(
      fs.readFileSync(path.join(root, 'servers.json'), 'utf8'),
    ).not.toContain('top-secret');
    expect(fs.readFileSync(path.join(root, 'secrets.json'), 'utf8')).toContain(
      'top-secret',
    );
    expect(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777).toBe(
      0o600,
    );
  });

  test('PATCH omission preserves secrets and explicit null clears them', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'patch_secret',
        command: 'node',
        env: { PATCH_TOKEN: 'patch-secret' },
      }),
    });
    expect(create.status).toBe(200);
    const preserve = await app.request('/api/mcp-servers/patch_secret', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'updated without secret fields' }),
    });
    expect(preserve.status).toBe(200);
    expect(loadUserMcpServers('mcp-secret-user').patch_secret).toMatchObject({
      env: { PATCH_TOKEN: 'patch-secret' },
    });

    const clear = await app.request('/api/mcp-servers/patch_secret', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ env: null }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({
      server: { envKeys: [], hasEnvSecrets: false },
    });
    expect(
      loadUserMcpServers('mcp-secret-user').patch_secret,
    ).not.toHaveProperty('env');
  });

  test('does not echo HTTP header values from create or list responses', async () => {
    const create = await app.request('/api/mcp-servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'private_http',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer secret' },
      }),
    });
    const createBody = await create.json();
    expect(createBody.server).toMatchObject({
      id: 'private_http',
      headerKeys: ['Authorization'],
    });
    expect(createBody.server).not.toHaveProperty('headers');

    const list = await app.request('/api/mcp-servers');
    expect(JSON.stringify(await list.json())).not.toContain('Bearer secret');
  });
});
