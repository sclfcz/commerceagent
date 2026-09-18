import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-scheduler-startup-'));
const store = path.join(root, 'db');
const groups = path.join(root, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  DATA_DIR: root,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { startSchedulerLoop, notifyTaskSchedulerChanged } =
  await import('../src/task-scheduler.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('task scheduler startup recovery', () => {
  test('closes legacy running logs, preserves leases, and pauses legacy fast intervals', async () => {
    const createdAt = new Date().toISOString();
    db.createTask({
      id: 'startup-recovery',
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'status',
      schedule_type: 'cron',
      schedule_value: '0 * * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() + 3_600_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });
    const task = db.getTaskById('startup-recovery')!;
    db.logTaskRunStart(task.id);
    const durable = db.createTaskRun({ task, triggerType: 'manual' });
    const claim = db.claimNextTaskRun('previous-worker', 60_000)!;
    db.createTask({
      id: 'legacy-fast-interval',
      group_folder: 'workspace',
      chat_jid: 'web:workspace',
      prompt: 'legacy fast task',
      schedule_type: 'interval',
      schedule_value: '1',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: new Date(Date.now() - 1_000).toISOString(),
      status: 'active',
      created_at: createdAt,
      notify_channels: null,
    });

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: {
        isShuttingDown: () => false,
      },
      onProcess: vi.fn(),
      sendMessage: vi.fn(),
      assistantName: 'CommerceAgent',
    } as never);

    expect(db.getTaskRunLogs(task.id)[0]).toMatchObject({
      status: 'error',
      error: 'Process crashed before completion',
    });
    expect(db.getTaskRunById(durable.run.id)).toMatchObject({
      status: 'running',
      lease_owner: 'previous-worker',
      lease_token: claim.lease_token,
    });
    expect(db.getTaskById('legacy-fast-interval')).toMatchObject({
      status: 'paused',
      next_run: null,
    });
    expect(db.getTaskRunsForTask('legacy-fast-interval', 10)).toHaveLength(1);
    expect(db.getTaskRunsForTask('legacy-fast-interval', 10)[0]).toMatchObject({
      status: 'missed',
      trigger_type: 'backfill',
      error: expect.stringContaining('at least 60000 milliseconds'),
    });

    // A subsequent wake must not materialize an unbounded stream of runs.
    notifyTaskSchedulerChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(db.getTaskRunsForTask('legacy-fast-interval', 10)).toHaveLength(1);
  });
});
