import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_ROOT =
  process.env.COMMERCEAGENT_HOST_MOUNT_BROWSE_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-host-mount-browse-'),
    );
    process.env.COMMERCEAGENT_HOST_MOUNT_BROWSE_TEST_DIR = dir;
    return dir;
  })();
const allowlistPath = path.join(TEST_ROOT, 'mount-allowlist.json');
const allowedRoot = path.join(TEST_ROOT, 'allowed');
const outsideRoot = path.join(TEST_ROOT, 'outside');
const homeLikeRoot = path.join(TEST_ROOT, 'home-like');
const protectedDataDir = path.join(homeLikeRoot, 'commerceagent-data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(
      process.env.COMMERCEAGENT_HOST_MOUNT_BROWSE_TEST_DIR!,
      'home-like',
      'commerceagent-data',
    ),
    MOUNT_ALLOWLIST_PATH: path.join(
      process.env.COMMERCEAGENT_HOST_MOUNT_BROWSE_TEST_DIR!,
      'mount-allowlist.json',
    ),
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
      id: 'browse-user',
      username: 'browse-user',
      role: process.env.COMMERCEAGENT_TEST_USER_ROLE ?? 'admin',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

function writePolicy(
  allowedRoots: Array<{
    path: string;
    allowReadWrite: boolean;
    description?: string;
  }>,
): void {
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      allowedRoots,
      blockedPatterns: ['blocked'],
      nonMainReadOnly: true,
    }),
  );
}

async function loadBrowseRoutes() {
  vi.resetModules();
  return (await import('../src/routes/browse.js')).default;
}

beforeAll(() => {
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
});

beforeEach(() => {
  process.env.COMMERCEAGENT_TEST_USER_ROLE = 'admin';
  fs.rmSync(allowlistPath, { force: true });
});

describe.sequential('mount-purpose directory browsing', () => {
  test('still enforces the server-side admin gate', async () => {
    writePolicy([
      {
        path: allowedRoot,
        allowReadWrite: false,
        description: 'Allowed',
      },
    ]);
    process.env.COMMERCEAGENT_TEST_USER_ROLE = 'member';
    const routes = await loadBrowseRoutes();

    const response = await routes.request('/directories?purpose=mount');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.code).toBe('HOST_MOUNT_ADMIN_REQUIRED');
  });

  test('fails closed instead of falling back to HOME when policy is missing', async () => {
    const routes = await loadBrowseRoutes();

    const response = await routes.request('/directories?purpose=mount');
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    expect(response.status).toBe(503);
    expect(body.code).toBe('HOST_MOUNT_POLICY_UNAVAILABLE');
    expect(body).not.toHaveProperty('currentPath', os.homedir());
  });

  test('fails closed when policy has no allowed roots', async () => {
    writePolicy([]);
    const routes = await loadBrowseRoutes();

    const response = await routes.request('/directories?purpose=mount');
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;

    expect(response.status).toBe(503);
    expect(body.code).toBe('HOST_MOUNT_POLICY_UNAVAILABLE');
  });

  test('lists only configured roots for mount selection', async () => {
    const nested = path.join(allowedRoot, 'child');
    fs.mkdirSync(nested, { recursive: true });
    writePolicy([
      {
        path: allowedRoot,
        allowReadWrite: false,
        description: 'Approved data',
      },
    ]);
    const routes = await loadBrowseRoutes();

    const response = await routes.request('/directories?purpose=mount');
    const body = (await response.json()) as {
      currentPath: string | null;
      hasAllowlist: boolean;
      mountingEnabled?: boolean;
      directories: Array<{ name: string; path: string }>;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      currentPath: null,
      hasAllowlist: true,
      mountingEnabled: true,
    });
    expect(body.directories).toEqual([
      {
        name: 'Approved data',
        path: fs.realpathSync(allowedRoot),
        hasChildren: true,
        selectable: true,
      },
    ]);
  });

  test('rejects a blocked current path even when manually entered', async () => {
    const blocked = path.join(allowedRoot, 'blocked', 'nested');
    fs.mkdirSync(blocked, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const routes = await loadBrowseRoutes();

    const response = await routes.request(
      `/directories?purpose=mount&path=${encodeURIComponent(blocked)}`,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.code).toBe('HOST_MOUNT_PATH_FORBIDDEN');
  });

  test('rejects a symlink that resolves outside an allowed root', async () => {
    const target = path.join(outsideRoot, 'symlink-target');
    const link = path.join(allowedRoot, 'outside-link');
    fs.mkdirSync(target, { recursive: true });
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(target, link, 'dir');
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const routes = await loadBrowseRoutes();

    const response = await routes.request(
      `/directories?purpose=mount&path=${encodeURIComponent(link)}`,
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(403);
    expect(body.code).toBe('HOST_MOUNT_PATH_FORBIDDEN');
  });

  test('keeps a broad root navigable without making it or protected subtrees selectable', async () => {
    const projects = path.join(homeLikeRoot, 'projects');
    fs.mkdirSync(protectedDataDir, { recursive: true });
    fs.mkdirSync(projects, { recursive: true });
    writePolicy([
      {
        path: homeLikeRoot,
        allowReadWrite: false,
        description: 'Server home',
      },
    ]);
    const routes = await loadBrowseRoutes();

    const rootsResponse = await routes.request('/directories?purpose=mount');
    const rootsBody = (await rootsResponse.json()) as {
      directories: Array<{
        name: string;
        path: string;
        selectable: boolean;
      }>;
    };
    expect(rootsResponse.status).toBe(200);
    expect(rootsBody.directories).toContainEqual(
      expect.objectContaining({
        name: 'Server home',
        path: fs.realpathSync(homeLikeRoot),
        selectable: false,
      }),
    );

    const rootResponse = await routes.request(
      `/directories?purpose=mount&path=${encodeURIComponent(homeLikeRoot)}`,
    );
    const rootBody = (await rootResponse.json()) as {
      currentPath: string;
      currentSelectable: boolean;
      directories: Array<{ path: string; selectable: boolean }>;
    };
    expect(rootResponse.status).toBe(200);
    expect(rootBody).toMatchObject({
      currentPath: fs.realpathSync(homeLikeRoot),
      currentSelectable: false,
    });
    expect(rootBody.directories).toContainEqual(
      expect.objectContaining({
        path: fs.realpathSync(projects),
        selectable: true,
      }),
    );
    expect(rootBody.directories).not.toContainEqual(
      expect.objectContaining({
        path: fs.realpathSync(protectedDataDir),
      }),
    );

    const projectsResponse = await routes.request(
      `/directories?purpose=mount&path=${encodeURIComponent(projects)}`,
    );
    const projectsBody = (await projectsResponse.json()) as {
      currentPath: string;
      currentSelectable: boolean;
    };
    expect(projectsResponse.status).toBe(200);
    expect(projectsBody).toMatchObject({
      currentPath: fs.realpathSync(projects),
      currentSelectable: true,
    });

    const protectedResponse = await routes.request(
      `/directories?purpose=mount&path=${encodeURIComponent(protectedDataDir)}`,
    );
    const protectedBody = (await protectedResponse.json()) as Record<
      string,
      unknown
    >;
    expect(protectedResponse.status).toBe(403);
    expect(protectedBody.code).toBe('HOST_MOUNT_PATH_FORBIDDEN');
  });
});
