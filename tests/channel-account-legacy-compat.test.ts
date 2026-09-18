import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-legacy-compat-'));
vi.mock('../src/config.js', async () => ({
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
  DATA_DIR: tmp,
}));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('legacy default channel account compatibility', () => {
  test('projection is idempotent and preserves existing group/mount JIDs', async () => {
    fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
    const db = await import('../src/db.js');
    const migration = await import('../src/channel-account-migration.js');
    const secrets = await import('../src/channel-account-secrets.js');
    db.initDatabase();
    db.setRegisteredGroup('web:legacy-workspace', {
      name: 'Legacy workspace',
      folder: 'legacy-workspace',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-owner',
    });
    db.setRegisteredGroup('feishu:legacy-chat', {
      name: 'Legacy group',
      folder: 'legacy-workspace',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-owner',
      target_main_jid: 'web:legacy-workspace',
    });

    const first = migration.ensureLegacyDefaultChannelAccount({
      ownerUserId: 'legacy-owner',
      provider: 'feishu',
      name: '默认飞书',
      enabled: true,
      secret: { appId: 'cli_old', appSecret: 'old-secret' },
    });
    const second = migration.ensureLegacyDefaultChannelAccount({
      ownerUserId: 'legacy-owner',
      provider: 'feishu',
      name: '默认飞书',
      enabled: true,
      secret: { appId: 'cli_old', appSecret: 'old-secret' },
    });
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      is_default: true,
      is_legacy_default: true,
    });
    expect(db.getRegisteredGroup('feishu:legacy-chat')).toMatchObject({
      target_main_jid: 'web:legacy-workspace',
      channel_account_id: first.id,
    });
    expect(db.getChannelMount('feishu:legacy-chat')).toMatchObject({
      workspace_jid: 'web:legacy-workspace',
      channel_account_id: first.id,
    });

    const updated = migration.syncDefaultChannelAccountCredentials({
      ownerUserId: 'legacy-owner',
      provider: 'feishu',
      name: '默认飞书',
      enabled: true,
      secret: { appId: 'cli_new', appSecret: 'new-secret' },
    });
    expect(updated.id).toBe(first.id);
    expect(secrets.loadChannelAccountSecret(first.secret_ref)).toMatchObject({
      appId: 'cli_new',
      appSecret: 'new-secret',
    });
    expect(db.listChannelAccountsForUser('legacy-owner')).toHaveLength(1);

    db.closeDatabase();
    db.initDatabase();
    expect(db.getRegisteredGroup('feishu:legacy-chat')).toMatchObject({
      target_main_jid: 'web:legacy-workspace',
      channel_account_id: first.id,
    });
    expect(db.getChannelMount('feishu:legacy-chat')).toMatchObject({
      workspace_jid: 'web:legacy-workspace',
      channel_account_id: first.id,
    });
    db.closeDatabase();
  });
});
