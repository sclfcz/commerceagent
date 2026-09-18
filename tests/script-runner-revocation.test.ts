import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'script-revocation-'));
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(path.join(groupsDir, 'workspace'), { recursive: true });

vi.mock('../src/config.js', () => ({ GROUPS_DIR: groupsDir }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    containerTimeout: 60_000,
  }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getActiveScriptCount, runScript, terminateScriptsForOwner } =
  await import('../src/script-runner.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('host script privilege revocation', () => {
  test('terminates the active process tree owned by the revoked user', async () => {
    const running = runScript(
      `${process.execPath} -e "setInterval(() => {}, 1000)"`,
      'workspace',
      { ownerId: 'admin-1' },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(getActiveScriptCount()).toBe(1);

    await expect(terminateScriptsForOwner('admin-1')).resolves.toBe(1);
    await expect(running).resolves.toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
    });
    expect(getActiveScriptCount()).toBe(0);
  });
});
