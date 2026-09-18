import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-repair-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const { initDatabase, ensureChatExists, storeMessageDirect } =
  await import('../src/db.js');

const dbPath = path.join(tmpStoreDir, 'messages.db');

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('startup foreign-key orphan repair', () => {
  test('completes an interrupted chat-deletion cascade and keeps enforcement on', () => {
    initDatabase();
    ensureChatExists('feishu:doomed-chat');
    storeMessageDirect(
      'orphan-1',
      'feishu:doomed-chat',
      'ou_x',
      'Someone',
      'hello',
      new Date().toISOString(),
      false,
    );

    // Simulate the historical partial cascade: the chat row disappeared but
    // its messages survived (observed as 6 permanent violations in prod).
    const raw = new Database(dbPath);
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM chats WHERE jid = ?').run('feishu:doomed-chat');
    expect(raw.pragma('foreign_key_check') as unknown[]).not.toHaveLength(0);
    raw.close();

    // Restart: repair should delete the orphans and keep enforcement enabled.
    initDatabase();
    const probe = new Database(dbPath, { readonly: true });
    expect(
      probe
        .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE id = ?')
        .get('orphan-1'),
    ).toEqual({ cnt: 0 });
    expect(probe.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    probe.close();
  });
});
