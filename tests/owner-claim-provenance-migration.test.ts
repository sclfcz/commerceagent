import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-provenance-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');

afterAll(() => {
  if (db.isDatabaseInitialized()) db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy owner provenance migration', () => {
  test('marks a historical owner explicit instead of silently trusting it', () => {
    db.initDatabase();
    db.setRegisteredGroup('telegram:123', {
      name: 'Historical direct chat',
      folder: 'new-user-home',
      added_at: new Date().toISOString(),
      created_by: 'new-commerceagent-user',
      owner_im_id: 'old-external-owner',
    });
    db.closeDatabase();

    const raw = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const before = raw
      .prepare(
        "SELECT owner_im_id, owner_claim_source FROM registered_groups WHERE jid = 'telegram:123'",
      )
      .get() as { owner_im_id: string; owner_claim_source: string | null };
    raw.close();
    expect(before).toEqual({
      owner_im_id: 'old-external-owner',
      owner_claim_source: null,
    });

    db.initDatabase();
    expect(db.getRegisteredGroup('telegram:123')).toMatchObject({
      owner_im_id: 'old-external-owner',
      owner_claim_source: 'explicit',
    });
  });
});
