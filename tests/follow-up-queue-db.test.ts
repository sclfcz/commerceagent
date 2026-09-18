import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'follow-up-queue-db-'));
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

describe('durable follow-up queue', () => {
  test('hides queued rows from the runner and releases them in priority order', () => {
    const jid = 'web:follow-up-test';
    const timestamp = '2026-07-20T00:00:00.000Z';
    db.ensureChatExists(jid);
    for (const [index, id] of ['first', 'second', 'third'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse(timestamp) + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'first',
      'second',
      'third',
    ]);

    const claimed = db.claimNextQueuedFollowUp(jid, 'run-next');
    expect(claimed?.id).toBe('first');
    expect(db.getQueuedFollowUp(jid, 'first')).toMatchObject({
      delivery_status: 'promoting',
      delivery_run_id: 'run-next',
    });

    const releasedAt = '2026-07-20T00:00:05.000Z';
    expect(
      db.releaseQueuedFollowUp(jid, 'first', 'run-next', releasedAt),
    ).not.toBeNull();
    expect(
      db.getMessagesPage(jid).find((item) => item.id === 'first'),
    ).toMatchObject({
      delivery_status: 'released',
      delivery_run_id: 'run-next',
      delivery_updated_at: releasedAt,
    });
    expect(
      db
        .getMessagesSince(jid, { timestamp: '', id: '' })
        .map((item) => item.id),
    ).toEqual(['first']);

    expect(db.cancelQueuedFollowUp(jid, 'third')).not.toBeNull();
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'second',
    ]);
  });

  test('moves an explicit steer ahead without releasing it into the active turn', () => {
    const jid = 'web:follow-up-steer-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['queued-first', 'steer-me'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T01:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    const steered = db.prioritizeQueuedFollowUp(jid, 'steer-me', 'run-current');
    expect(steered).toMatchObject({
      id: 'steer-me',
      delivery_mode: 'steer',
      delivery_status: 'queued',
      delivery_run_id: 'run-current',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'steer-me',
      'queued-first',
    ]);
    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
  });

  test('edits and reorders normal queued messages without releasing them', () => {
    const jid = 'web:follow-up-manage-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['one', 'two', 'three'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        `message ${id}`,
        new Date(Date.parse('2026-07-20T02:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(
      db.updateQueuedFollowUpContent(jid, 'two', '  edited two  '),
    ).toMatchObject({ id: 'two', content: 'edited two' });
    expect(db.moveQueuedFollowUp(jid, 'three', 'up')).toMatchObject({
      id: 'three',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'one',
      'three',
      'two',
    ]);
    expect(db.moveQueuedFollowUp(jid, 'three', 'up')).toMatchObject({
      id: 'three',
    });
    expect(db.listQueuedFollowUps(jid).map((item) => item.id)).toEqual([
      'three',
      'one',
      'two',
    ]);
    expect(db.getMessagesSince(jid, { timestamp: '', id: '' })).toEqual([]);
  });

  test('locks editing and reordering after a queued message starts steering', () => {
    const jid = 'web:follow-up-locked-test';
    db.ensureChatExists(jid);
    for (const [index, id] of ['first', 'second'].entries()) {
      db.storeMessageDirect(
        id,
        jid,
        'user-1',
        'User',
        id,
        new Date(Date.parse('2026-07-20T03:00:00.000Z') + index).toISOString(),
        false,
        {
          meta: {
            deliveryMode: 'queue',
            deliveryStatus: 'queued',
            deliveryRunId: 'run-current',
          },
        },
      );
    }

    expect(
      db.prioritizeQueuedFollowUp(jid, 'second', 'run-current'),
    ).not.toBeNull();
    expect(db.updateQueuedFollowUpContent(jid, 'second', 'changed')).toBeNull();
    expect(db.moveQueuedFollowUp(jid, 'second', 'down')).toBeNull();
    expect(db.listQueuedFollowUps(jid)[0]).toMatchObject({
      id: 'second',
      content: 'second',
      delivery_mode: 'steer',
    });
  });
});
