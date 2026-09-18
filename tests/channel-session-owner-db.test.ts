import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-owner-db-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('durable session channel ownership', () => {
  test('the first native transport remains authoritative across restarts/follow-ups', () => {
    const feishu = 'feishu:chat-a#account:bot-a#thread:thread-a';
    const qq = 'qq:group-b#account:bot-b';

    expect(db.setSessionChannelOwnerOnce('workspace-a', null, feishu)).toBe(
      feishu,
    );
    expect(db.setSessionChannelOwnerOnce('workspace-a', null, qq)).toBe(feishu);
    expect(db.getSessionChannelOwner('workspace-a')).toBe(feishu);
  });

  test('SDK session deletion preserves transport ownership until an explicit conversation reset', () => {
    db.setSessionChannelOwnerOnce('workspace-b', null, 'feishu:main');
    db.setSessionChannelOwnerOnce('workspace-b', 'agent-1', 'feishu:agent');

    expect(db.getSessionChannelOwner('workspace-b')).toBe('feishu:main');
    expect(db.getSessionChannelOwner('workspace-b', 'agent-1')).toBe(
      'feishu:agent',
    );

    db.deleteSession('workspace-b', 'agent-1');
    expect(db.getSessionChannelOwner('workspace-b', 'agent-1')).toBe(
      'feishu:agent',
    );
    expect(db.getSessionChannelOwner('workspace-b')).toBe('feishu:main');

    db.clearSessionChannelOwner('workspace-b', 'agent-1');
    expect(db.getSessionChannelOwner('workspace-b', 'agent-1')).toBeUndefined();
    expect(db.getSessionChannelOwner('workspace-b')).toBe('feishu:main');
  });
});
