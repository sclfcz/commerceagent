import { describe, expect, test } from 'vitest';

import {
  findDuplicateActiveAgentTask,
  type TaskExecutionDefinition,
} from '../src/task-definition-fingerprint.js';
import type { ScheduledTask } from '../src/types.js';
import { resolveTaskExecutionModeForTarget } from '../src/script-task-policy.js';

function definition(
  overrides: Partial<TaskExecutionDefinition> = {},
): TaskExecutionDefinition {
  return {
    group_folder: 'workspace-a',
    chat_jid: 'feishu:chat-a',
    prompt: 'Generate the daily report',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    created_by: 'user-a',
    notify_channels: null,
    ...overrides,
  };
}

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-existing',
    ...definition(),
    next_run: '2026-07-20T01:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: '2026-07-19T00:00:00.000Z',
    revision: 1,
    updated_at: '2026-07-19T00:00:00.000Z',
    deleted_at: null,
    ...overrides,
  };
}

describe('scheduled-task execution fingerprint', () => {
  test('deduplicates an exactly identical active agent task', () => {
    const existing = task();

    expect(findDuplicateActiveAgentTask([existing], definition())).toBe(
      existing,
    );
  });

  test('does not deduplicate host and container tasks with identical content', () => {
    const existing = task({ execution_mode: 'host' });

    expect(
      findDuplicateActiveAgentTask(
        [existing],
        definition({ execution_mode: 'container' }),
      ),
    ).toBeUndefined();
  });

  test('does not deduplicate tasks routed to different IM targets', () => {
    const existing = task({ chat_jid: 'feishu:chat-b' });

    expect(
      findDuplicateActiveAgentTask([existing], definition()),
    ).toBeUndefined();
  });

  test('does not deduplicate tasks owned or notified differently', () => {
    const existing = task({
      created_by: 'user-b',
      notify_channels: ['telegram:chat-a'],
    });

    expect(
      findDuplicateActiveAgentTask([existing], definition()),
    ).toBeUndefined();
  });
});

describe('target-bound task execution mode', () => {
  test('inherits from the target workspace, independent of the source workspace', () => {
    // Admin home (host) -> container target must remain container.
    expect(resolveTaskExecutionModeForTarget('container', undefined)).toBe(
      'container',
    );
    // A container-backed source targeting an authorized host workspace inherits
    // the target's host mode; source mode is intentionally not an input.
    expect(resolveTaskExecutionModeForTarget('host', undefined)).toBe('host');
  });

  test('rejects explicit host on a container target and permits host downgrade', () => {
    expect(() =>
      resolveTaskExecutionModeForTarget('container', 'host'),
    ).toThrow('Target workspace runs in container mode');
    expect(resolveTaskExecutionModeForTarget('host', 'container')).toBe(
      'container',
    );
  });
});
