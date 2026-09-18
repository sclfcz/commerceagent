import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-context-db-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('native context persistence', () => {
  test('registered group round-trips its provider-native context capability', () => {
    db.setRegisteredGroup('telegram:-100#account:bot', {
      name: 'Forum',
      folder: 'forum-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner',
      native_context_type: 'thread',
      target_main_jid: 'web:workspace',
      binding_mode: 'thread_map',
    });

    expect(db.getRegisteredGroup('telegram:-100#account:bot')).toMatchObject({
      native_context_type: 'thread',
      target_main_jid: 'web:workspace',
      binding_mode: 'thread_map',
    });
  });

  test('unpair clears reply routes only for the exact account conversation', () => {
    const now = new Date().toISOString();
    for (const id of ['session-bot-a', 'session-bot-b']) {
      db.createAgent({
        id,
        group_folder: 'workspace',
        chat_jid: 'web:workspace',
        name: id,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_by: 'owner',
        created_at: now,
        completed_at: null,
        result_summary: null,
        spawned_from_jid: null,
        last_im_jid:
          id === 'session-bot-a'
            ? 'telegram:same#account:bot-a#thread:1#root:one'
            : 'telegram:same#account:bot-b#thread:1#root:two',
      });
    }

    db.deleteImGroupRecord('telegram:same#account:bot-a');

    expect(db.getAgent('session-bot-a')?.last_im_jid).toBeNull();
    expect(db.getAgent('session-bot-b')?.last_im_jid).toBe(
      'telegram:same#account:bot-b#thread:1#root:two',
    );
  });

  test('the same native context id stays isolated by source JID', () => {
    const now = new Date().toISOString();
    db.upsertImContextBinding({
      source_jid: 'feishu:topic-a#account:bot-a',
      context_type: 'thread',
      context_id: 'same-context',
      workspace_jid: 'web:shared-workspace',
      agent_id: 'session-from-feishu',
      root_message_id: 'feishu-root',
      title: 'Feishu topic',
      last_active_at: now,
      created_at: now,
      updated_at: now,
    });
    db.upsertImContextBinding({
      source_jid: 'telegram:forum-b#account:bot-b',
      context_type: 'thread',
      context_id: 'same-context',
      workspace_jid: 'web:shared-workspace',
      agent_id: 'session-from-telegram',
      root_message_id: 'telegram-root',
      title: 'Telegram topic',
      last_active_at: now,
      created_at: now,
      updated_at: now,
    });

    expect(
      db.getImContextBinding(
        'feishu:topic-a#account:bot-a',
        'thread',
        'same-context',
      ),
    ).toMatchObject({
      agent_id: 'session-from-feishu',
      root_message_id: 'feishu-root',
    });
    expect(
      db.getImContextBinding(
        'telegram:forum-b#account:bot-b',
        'thread',
        'same-context',
      ),
    ).toMatchObject({
      agent_id: 'session-from-telegram',
      root_message_id: 'telegram-root',
    });
  });

  test('resolves a Feishu context by its stable root after thread_id appears', () => {
    const now = new Date().toISOString();
    db.upsertImContextBinding({
      source_jid: 'feishu:ordinary-group',
      context_type: 'thread',
      context_id: 'om_mention_root',
      workspace_jid: 'web:workspace',
      agent_id: 'session-from-mention',
      root_message_id: 'om_mention_root',
      title: 'Mention topic',
      last_active_at: now,
      created_at: now,
      updated_at: now,
    });

    expect(
      db.getImContextBindingByRootMessageId(
        'feishu:ordinary-group',
        'thread',
        'om_mention_root',
      ),
    ).toMatchObject({
      context_id: 'om_mention_root',
      agent_id: 'session-from-mention',
    });
    expect(
      db.getImContextBindingByRootMessageId(
        'feishu:another-group',
        'thread',
        'om_mention_root',
      ),
    ).toBeUndefined();
  });
});
