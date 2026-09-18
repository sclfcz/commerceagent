import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v64-reference-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => {
  db.initDatabase();
  const chatJid = 'web:main#agent:agent-1';
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    'om_root',
    chatJid,
    'ou_alice',
    'Alice',
    '原始任务',
    '2026-07-28T02:54:52.156Z',
    false,
  );
  db.storeMessageDirect(
    'om_reply',
    chatJid,
    'ou_alice',
    'Alice',
    '[引用消息链（最早到最近）]\n- Alice: 原始任务\n[当前消息]\n重新调研',
    '2026-07-28T03:23:06.358Z',
    false,
    {
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        channelAccountId: null,
        sourceJid: 'feishu:oc_chat#thread:omt_1#root:om_root',
        chat: { id: 'oc_chat', type: 'group' },
        message: {
          id: 'om_reply',
          parentId: 'om_root',
          rootId: 'om_root',
          threadId: 'omt_1',
        },
      },
    },
  );
  db.storeMessageDirect(
    'om_orphan_reply',
    chatJid,
    'ou_alice',
    'Alice',
    '[引用消息链（最早到最近）]\n- Alice: 外部话题\n[当前消息]\n继续',
    '2026-07-28T03:24:06.358Z',
    false,
    {
      channelContext: {
        schemaVersion: 1,
        provider: 'feishu',
        channelAccountId: null,
        sourceJid: 'feishu:oc_chat',
        chat: { id: 'oc_chat', type: 'group' },
        message: {
          id: 'om_orphan_reply',
          parentId: 'om_missing_parent',
        },
      },
    },
  );
  db.closeDatabase();

  const raw = new Database(databasePath);
  raw
    .prepare(
      `UPDATE router_state SET value = '63' WHERE key = 'schema_version'`,
    )
    .run();
  raw.close();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v64 Feishu reference-content migration', () => {
  test('separates safe quoted context while preserving orphaned copies', () => {
    db.initDatabase();
    const messages = db.getMessagesPage(
      'web:main#agent:agent-1',
      undefined,
      10,
    );
    const migrated = messages.find((message) => message.id === 'om_reply');
    const orphan = messages.find((message) => message.id === 'om_orphan_reply');

    expect(migrated?.content).toBe('重新调研');
    expect(migrated?.channel_context?.message.referencedMessages).toEqual([
      { id: 'om_root', sender: 'Alice', text: '原始任务' },
    ]);
    expect(orphan?.content).toContain('[引用消息链（最早到最近）]');
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    db.closeDatabase();
    db.initDatabase();
    expect(
      db
        .getMessagesPage('web:main#agent:agent-1', undefined, 10)
        .find((message) => message.id === 'om_reply')?.content,
    ).toBe('重新调研');
  });
});
