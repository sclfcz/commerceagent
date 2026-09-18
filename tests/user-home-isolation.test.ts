import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-home-isolation-'));
const storeDir = path.join(tmpDir, 'db');
const groupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('per-user home workspace isolation', () => {
  test('never reuses another admin home workspace', () => {
    db.initDatabase();

    const firstAdminJid = db.ensureUserHomeGroup(
      'admin-one',
      'admin',
      'admin-one',
    );
    const secondAdminJid = db.ensureUserHomeGroup(
      'admin-two',
      'admin',
      'admin-two',
    );
    const memberJid = db.ensureUserHomeGroup(
      'member-one',
      'member',
      'member-one',
    );

    expect(firstAdminJid).toBe('web:main');
    expect(secondAdminJid).toBe('web:home-admin-two');
    expect(memberJid).toBe('web:home-member-one');

    expect(db.getRegisteredGroup(firstAdminJid)).toMatchObject({
      folder: 'main',
      created_by: 'admin-one',
      is_home: true,
      executionMode: 'host',
    });
    expect(db.getRegisteredGroup(secondAdminJid)).toMatchObject({
      folder: 'home-admin-two',
      created_by: 'admin-two',
      is_home: true,
      executionMode: 'host',
    });
    expect(db.getRegisteredGroup(memberJid)).toMatchObject({
      folder: 'home-member-one',
      created_by: 'member-one',
      is_home: true,
      executionMode: 'container',
    });

    expect(db.getUserHomeGroup('admin-one')?.jid).toBe(firstAdminJid);
    expect(db.getUserHomeGroup('admin-two')?.jid).toBe(secondAdminJid);
    expect(db.ensureUserHomeGroup('admin-two', 'admin')).toBe(secondAdminJid);
  });
});
