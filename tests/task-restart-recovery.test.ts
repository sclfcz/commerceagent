import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir — same pattern as task-meta.test.ts.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-restart-recovery-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock(import('../src/config.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  createTask,
  getTaskById,
  getDueTasks,
  claimTaskForRun,
  advanceSkippedTask,
  updateTaskAfterRun,
  clearStaleTaskLeases,
} = await import('../src/db.js');

const { shouldSkipBackfill, validateCronMinimumInterval } =
  await import('../src/task-scheduler.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeTask(overrides: Partial<Parameters<typeof createTask>[0]> = {}) {
  const id = `t-${Math.random().toString(36).slice(2, 10)}`;
  createTask({
    id,
    group_folder: 'home-test',
    chat_jid: 'web:home-test',
    prompt: 'noop',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    script_command: null,
    execution_mode: 'container',
    next_run: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // 24h overdue
    status: 'active',
    created_at: new Date().toISOString(),
    notify_channels: null,
    workspace_jid: null,
    workspace_folder: null,
    ...overrides,
  });
  return id;
}

describe('task restart recovery — db helpers', () => {
  test('cron minimum interval is deterministic from the complete seconds field', () => {
    for (const value of ['* * * * * *', '0,30 0 * * * *', '@secondly']) {
      expect(() => validateCronMinimumInterval(value)).toThrow(
        'at least 60 seconds',
      );
    }
    for (const value of ['* * * * *', '0 * * * * *', '*/60 * * * * *']) {
      expect(() => validateCronMinimumInterval(value)).not.toThrow();
    }
  });

  test('getDueTasks returns all tasks with next_run <= now (regardless of how overdue)', () => {
    const id1 = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(), // 1 min overdue
    });
    const id2 = makeTask({
      next_run: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days overdue
    });
    const due = getDueTasks();
    const ids = due.map((t) => t.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);
  });

  test('advanceSkippedTask updates next_run and does NOT touch last_run', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    });
    const before = getTaskById(id)!;
    expect(before.last_run).toBeFalsy(); // never ran

    const newNext = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    advanceSkippedTask(id, newNext);

    const after = getTaskById(id)!;
    expect(after.next_run).toBe(newNext);
    expect(after.last_run).toBeFalsy(); // still not set — skipping is not running
    expect(after.status).toBe('active');
  });

  test('advanceSkippedTask with null nextRun marks once-task as completed', () => {
    const id = makeTask({
      schedule_type: 'once',
      schedule_value: new Date(Date.now() - 60_000).toISOString(),
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    advanceSkippedTask(id, null);
    const after = getTaskById(id)!;
    expect(after.next_run).toBeNull();
    expect(after.status).toBe('completed');
  });

  test('updateTaskAfterRun continues to set last_run (sanity check the helpers stay distinct)', () => {
    const id = makeTask();
    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'ran ok',
    );
    const after = getTaskById(id)!;
    expect(after.last_run).toBeTruthy(); // contrast with advanceSkippedTask
    expect(after.last_result).toBe('ran ok');
  });

  test('claimTaskForRun gives a due task to only one scheduler runner and hides it from getDueTasks until released', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(claimTaskForRun(id, 'runner-a', 60_000)).toBe(true);
    expect(claimTaskForRun(id, 'runner-b', 60_000)).toBe(false);
    expect(getDueTasks().map((t) => t.id)).not.toContain(id);

    updateTaskAfterRun(
      id,
      new Date(Date.now() + 60_000).toISOString(),
      'claimed run done',
    );
    const after = getTaskById(id)!;
    expect(after.running_until).toBeNull();
    expect(after.runner_id).toBeNull();
  });

  test('clearStaleTaskLeases releases a lease abandoned by a crashed runner so the task becomes due again', () => {
    const id = makeTask({
      next_run: new Date(Date.now() - 60_000).toISOString(),
    });
    // Simulate a runner claiming the task, then crashing before it can call
    // updateTaskAfterRun/advanceSkippedTask — running_until/runner_id are
    // left set in the DB, exactly as they would be after a process kill.
    expect(claimTaskForRun(id, 'crashed-runner', 30 * 60_000)).toBe(true);
    expect(getDueTasks().map((t) => t.id)).not.toContain(id);

    const cleared = clearStaleTaskLeases();
    expect(cleared).toBeGreaterThanOrEqual(1);

    const after = getTaskById(id)!;
    expect(after.running_until).toBeNull();
    expect(after.runner_id).toBeNull();
    // The task must be immediately claimable again by the restarted
    // scheduler, not hidden until the old (now-meaningless) lease expiry.
    expect(getDueTasks().map((t) => t.id)).toContain(id);
    expect(claimTaskForRun(id, 'new-runner', 30 * 60_000)).toBe(true);
  });

  test('clearStaleTaskLeases is a no-op when no task holds a lease', () => {
    // A task with no lease at all must not be touched/counted.
    makeTask({ next_run: new Date(Date.now() - 60_000).toISOString() });
    const clearedFirst = clearStaleTaskLeases();
    expect(clearedFirst).toBeGreaterThanOrEqual(0);
    const clearedSecond = clearStaleTaskLeases();
    expect(clearedSecond).toBe(0);
  });
});

describe('task restart recovery — decision predicate', () => {
  // Imported directly from production code so a future inline-only change
  // breaks the test rather than silently drifting from a local mirror.

  test('does not skip before the scheduler has started', () => {
    const tenDaysAgo = new Date(
      Date.now() - 10 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(shouldSkipBackfill(tenDaysAgo, 0)).toBe(false);
  });

  test('work scheduled after process startup is not backfill', () => {
    const startedAt = Date.now();
    const scheduledAfterStart = new Date(startedAt + 1).toISOString();
    expect(shouldSkipBackfill(scheduledAfterStart, startedAt)).toBe(false);
  });

  test('work that became due while the process was offline is skipped', () => {
    const startedAt = Date.now();
    const scheduledBeforeStart = new Date(startedAt - 1).toISOString();
    expect(shouldSkipBackfill(scheduledBeforeStart, startedAt)).toBe(true);
  });

  test('null next_run never triggers skip', () => {
    expect(shouldSkipBackfill(null, Date.now())).toBe(false);
  });

  test('exactly at process startup is not considered downtime', () => {
    const startedAt = Date.now();
    expect(
      shouldSkipBackfill(new Date(startedAt).toISOString(), startedAt),
    ).toBe(false);
  });
});
