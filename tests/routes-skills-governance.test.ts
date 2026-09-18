import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-governance-'));
const dataDir = path.join(root, 'data');
const externalDir = path.join(root, 'external-claude');
const customProfiles = vi.hoisted(() => [] as any[]);

vi.mock('../src/config.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => externalDir,
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'skills-owner', role: 'admin', permissions: [] });
    return next();
  },
}));
vi.mock('../src/db.js', () => ({
  listAgentProfilesForUser: () => customProfiles,
}));

const routes = (await import('../src/routes/skills.js')).default;
const app = new Hono().route('/api/skills', routes);

function writeSkill(
  rootDir: string,
  id: string,
  label: string,
  enabled = true,
): void {
  fs.mkdirSync(path.join(rootDir, id), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, id, enabled ? 'SKILL.md' : 'SKILL.md.disabled'),
    `---\nname: ${label}\ndescription: ${label}\n---\n# ${label}\n`,
  );
}

beforeAll(() => {
  writeSkill(path.join(dataDir, 'skills', 'skills-owner'), 'shared', 'Managed');
  writeSkill(
    path.resolve(process.cwd(), 'container', 'skills'),
    '__governance_test_shared__',
    'Project',
  );
  writeSkill(
    path.join(externalDir, 'skills'),
    '__governance_test_shared__',
    'Host',
  );
  writeSkill(
    path.join(dataDir, 'skills', 'skills-owner'),
    '__governance_test_shared__',
    'Managed',
  );
  writeSkill(
    path.resolve(process.cwd(), 'container', 'skills'),
    '__governance_test_disabled_user__',
    'Project enabled',
  );
  writeSkill(
    path.join(dataDir, 'skills', 'skills-owner'),
    '__governance_test_disabled_user__',
    'Managed disabled',
    false,
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(
    path.resolve(
      process.cwd(),
      'container',
      'skills',
      '__governance_test_shared__',
    ),
    { recursive: true, force: true },
  );
  fs.rmSync(
    path.resolve(
      process.cwd(),
      'container',
      'skills',
      '__governance_test_disabled_user__',
    ),
    { recursive: true, force: true },
  );
});

describe('Skills source and deletion governance', () => {
  test('keeps every colliding source with stable source keys and effective precedence', async () => {
    const response = await app.request('/api/skills');
    expect(response.status).toBe(200);
    const body = await response.json();
    const shared = body.skills.filter(
      (skill: any) => skill.id === '__governance_test_shared__',
    );
    expect(shared).toHaveLength(3);
    expect(shared.map((skill: any) => skill.sourceKey)).toEqual([
      'external:__governance_test_shared__',
      'project:__governance_test_shared__',
      'user:__governance_test_shared__',
    ]);
    expect(shared.filter((skill: any) => skill.effective)).toMatchObject([
      { source: 'user', readonly: false },
    ]);

    const detail = await app.request(
      '/api/skills/__governance_test_shared__?source=external',
    );
    expect(await detail.json()).toMatchObject({
      skill: {
        name: 'Host',
        source: 'external',
        sourceKey: 'external:__governance_test_shared__',
        readonly: true,
      },
    });
  });

  test('fails closed when a custom Agent references a managed Skill', async () => {
    customProfiles.push({
      id: 'profile-1',
      name: 'Reviewer',
      runtime_policy: {
        skills: { mode: 'custom', ids: ['shared'] },
      },
    });
    const disable = await app.request('/api/skills/shared', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disable.status).toBe(409);
    expect(await disable.json()).toMatchObject({
      referencedByProfiles: [{ id: 'profile-1', skillIds: ['shared'] }],
    });

    const remove = await app.request('/api/skills/shared', {
      method: 'DELETE',
    });
    expect(remove.status).toBe(409);
    expect(
      fs.existsSync(path.join(dataDir, 'skills', 'skills-owner', 'shared')),
    ).toBe(true);
  });

  test('a disabled managed collision cannot shadow an enabled project Skill', async () => {
    const response = await app.request('/api/skills');
    expect(response.status).toBe(200);
    const body = await response.json();
    const shared = body.skills.filter(
      (skill: any) => skill.id === '__governance_test_disabled_user__',
    );
    expect(shared).toHaveLength(2);
    expect(shared).toMatchObject([
      {
        source: 'project',
        enabled: true,
        effective: true,
        effectiveSource: 'project',
      },
      {
        source: 'user',
        enabled: false,
        effective: false,
        effectiveSource: 'project',
      },
    ]);

    const detail = await app.request(
      '/api/skills/__governance_test_disabled_user__?source=user',
    );
    expect(await detail.json()).toMatchObject({
      skill: {
        enabled: false,
        effective: false,
        effectiveSource: 'project',
      },
    });
  });
});
