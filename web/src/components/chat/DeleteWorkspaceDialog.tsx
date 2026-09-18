import { ConfirmDialog } from '@/components/common';
import type { DeleteWorkspaceState } from '../../hooks/useDeleteWorkspace';
import { workspaceDeleteDialogMessage } from '../../utils/workspace-delete';

export function DeleteWorkspaceDialog({
  state,
  loading,
  onClose,
  onConfirm,
}: {
  state: DeleteWorkspaceState;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const hasBindings = state.impact?.has_channel_bindings === true;
  return (
    <ConfirmDialog
      open={state.open}
      onClose={onClose}
      onConfirm={onConfirm}
      title={hasBindings ? '解除渠道绑定并删除工作区' : '删除工作区'}
      message={workspaceDeleteDialogMessage(state)}
      messageClassName="max-h-72 overflow-y-auto"
      confirmText={
        state.checking
          ? '正在检查'
          : hasBindings
            ? '解除绑定并删除'
            : '删除工作区'
      }
      cancelText="取消"
      confirmVariant="danger"
      loading={loading}
      confirmDisabled={state.checking || !state.impact}
    />
  );
}
