import type { ScheduledTask } from './types.js';

/**
 * The persisted fields that define what a scheduled task does and where it
 * executes. Runtime-owned state such as next_run and isolated workspace IDs is
 * intentionally excluded.
 */
export type TaskExecutionDefinition = Pick<
  ScheduledTask,
  | 'group_folder'
  | 'chat_jid'
  | 'prompt'
  | 'schedule_type'
  | 'schedule_value'
  | 'context_mode'
  | 'execution_type'
  | 'execution_mode'
  | 'script_command'
  | 'created_by'
  | 'notify_channels'
>;

function canonicalNotifyChannels(channels: string[] | null | undefined) {
  return channels ? [...new Set(channels)].sort() : [];
}

export function buildTaskExecutionFingerprint(
  task: TaskExecutionDefinition,
): string {
  return JSON.stringify({
    version: 1,
    groupFolder: task.group_folder,
    chatJid: task.chat_jid,
    prompt: task.prompt,
    scheduleType: task.schedule_type,
    scheduleValue: task.schedule_value,
    contextMode: task.context_mode,
    executionType: task.execution_type,
    executionMode: task.execution_mode ?? null,
    scriptCommand: task.script_command ?? null,
    createdBy: task.created_by ?? null,
    notifyChannels: canonicalNotifyChannels(task.notify_channels),
  });
}

/**
 * Content-based compatibility fallback for MCP callers that do not yet send a
 * create idempotency key. Script tasks are deliberately excluded: two scripts
 * may share a label and schedule while performing different work.
 */
export function findDuplicateActiveAgentTask(
  tasks: readonly ScheduledTask[],
  requested: TaskExecutionDefinition,
): ScheduledTask | undefined {
  if (requested.execution_type !== 'agent') return undefined;

  const requestedFingerprint = buildTaskExecutionFingerprint(requested);
  return tasks.find(
    (task) =>
      task.status === 'active' &&
      task.execution_type === 'agent' &&
      buildTaskExecutionFingerprint(task) === requestedFingerprint,
  );
}
