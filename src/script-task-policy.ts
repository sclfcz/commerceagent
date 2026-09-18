import type { RegisteredGroup, ScheduledTask } from './types.js';

export const SCRIPT_TASK_HOST_REQUIRED_ERROR =
  '脚本任务只能在管理员宿主机工作区中以 host 模式执行。';

export function getScriptTaskHostExecutionError(
  task: Pick<
    ScheduledTask,
    'execution_type' | 'execution_mode' | 'chat_jid' | 'group_folder'
  >,
  groups: Record<string, RegisteredGroup>,
): string | null {
  if (task.execution_type !== 'script') return null;
  if (task.execution_mode !== 'host') {
    return SCRIPT_TASK_HOST_REQUIRED_ERROR;
  }
  const target = groups[task.chat_jid];
  if (
    !target ||
    target.folder !== task.group_folder ||
    target.executionMode !== 'host'
  ) {
    return SCRIPT_TASK_HOST_REQUIRED_ERROR;
  }
  return null;
}

export function resolveTaskExecutionModeForTarget(
  targetMode: 'host' | 'container' | undefined,
  requestedMode: 'host' | 'container' | undefined,
): 'host' | 'container' {
  const normalizedTarget = targetMode === 'host' ? 'host' : 'container';
  if (requestedMode === 'host' && normalizedTarget !== 'host') {
    throw new Error(
      'Target workspace runs in container mode; host execution is not allowed.',
    );
  }
  return requestedMode ?? normalizedTarget;
}
