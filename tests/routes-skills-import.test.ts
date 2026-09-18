import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-skills-import-'));
const dataDir = path.join(tempDir, 'data');

vi.mock('../src/config.js', () => ({ DATA_DIR: dataDir }));
vi.mock('../src/runtime-config.js', () => ({
  getEffectiveExternalDir: () => path.join(tempDir, '.claude'),
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('user', { id: 'skill-user', role: 'member', permissions: [] });
    return next();
  },
}));

const routes = (await import('../src/routes/skills.js')).default;

afterAll(() => fs.rmSync(tempDir, { recursive: true, force: true }));

function archiveFile(): File {
  const zip = new AdmZip();
  zip.addFile(
    'review/SKILL.md',
    Buffer.from('---\nname: Review\ndescription: Review code\n---\n'),
  );
  return new File([zip.toBuffer()], 'review.zip', { type: 'application/zip' });
}

describe('Skills import routes', () => {
  test('rejects an oversized archive before multipart parsing', async () => {
    const response = await routes.request('/import/archive', {
      method: 'POST',
      headers: {
        'content-type': 'multipart/form-data; boundary=test',
        'content-length': String(11 * 1024 * 1024),
      },
      body: '--test--',
    });
    expect(response.status).toBe(413);
  });

  test('imports ZIP skills and exposes source metadata', async () => {
    const form = new FormData();
    form.append('archive', archiveFile());
    const response = await routes.request('/import/archive', {
      method: 'POST',
      body: form,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      installed: ['review'],
    });

    const listResponse = await routes.request('/', { method: 'GET' });
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      skills: Array<Record<string, unknown>>;
    };
    expect(list.skills.find((skill) => skill.id === 'review')).toMatchObject({
      id: 'review',
      source: 'user',
      installSource: 'zip',
      sourceUrl: 'review.zip',
    });
  });

  test('returns a conflict without replacing by default and rejects unsafe Git URLs', async () => {
    const form = new FormData();
    form.append('archive', archiveFile());
    const conflict = await routes.request('/import/archive', {
      method: 'POST',
      body: form,
    });
    expect(conflict.status).toBe(409);

    const unsafeGit = await routes.request('/import/git', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://127.0.0.1/skills.git' }),
    });
    expect(unsafeGit.status).toBe(400);
    expect(await unsafeGit.json()).toMatchObject({
      error: expect.stringContaining('Refused Git URL'),
    });
  });
});
