import type { DeleteWorkspaceState } from '../hooks/useDeleteWorkspace';

export function workspaceDeleteBindingNames(
  state: DeleteWorkspaceState,
): string[] {
  const impact = state.impact;
  if (!impact) return [];
  const names = new Map<string, string>();
  for (const group of impact.bound_main_im_groups) {
    names.set(group.jid, group.name);
  }
  for (const session of impact.bound_sessions) {
    for (const group of session.imGroups) names.set(group.jid, group.name);
  }
  for (const context of impact.bound_thread_contexts) {
    names.set(context.jid, context.name);
  }
  return Array.from(names.values());
}

export function workspaceDeleteDialogMessage(
  state: DeleteWorkspaceState,
): string {
  if (state.checking) {
    return `正在检查「${state.name}」的消息渠道绑定…`;
  }
  const impact = state.impact;
  if (!impact?.has_channel_bindings) {
    return `删除「${state.name}」？工作区文件、会话和运行数据将被永久删除。此操作无法撤销。`;
  }

  const names = workspaceDeleteBindingNames(state);
  const visible = names.slice(0, 5).map((name) => `• ${name}`);
  if (names.length > visible.length) {
    visible.push(`• 以及其他 ${names.length - visible.length} 个渠道`);
  }
  return [
    `「${state.name}」仍绑定 ${impact.channel_binding_count} 个消息渠道：`,
    ...visible,
    '',
    '继续后，系统会先将这些渠道恢复到对应 Bot 的默认工作区；没有可用默认工作区的渠道会解除路由，然后永久删除此工作区的文件、会话和运行数据。',
    '此操作无法撤销。',
  ].join('\n');
}
