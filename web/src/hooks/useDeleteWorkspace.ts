import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useChatStore } from '../stores/chat';
import type { WorkspaceDeleteImpact } from '../types';

export interface DeleteWorkspaceState {
  open: boolean;
  jid: string;
  name: string;
  checking: boolean;
  impact: WorkspaceDeleteImpact | null;
}

const EMPTY_STATE: DeleteWorkspaceState = {
  open: false,
  jid: '',
  name: '',
  checking: false,
  impact: null,
};

export function useDeleteWorkspace(
  options: {
    onDeleted?: (jid: string) => void;
  } = {},
) {
  const inspectDeleteFlow = useChatStore((state) => state.inspectDeleteFlow);
  const deleteFlow = useChatStore((state) => state.deleteFlow);
  const [deleteState, setDeleteState] =
    useState<DeleteWorkspaceState>(EMPTY_STATE);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const inspectionSequence = useRef(0);

  const closeDelete = () => {
    if (deleteLoading) return;
    inspectionSequence.current += 1;
    setDeleteState(EMPTY_STATE);
  };

  const openDelete = async (jid: string, name: string) => {
    const sequence = inspectionSequence.current + 1;
    inspectionSequence.current = sequence;
    setDeleteState({
      open: true,
      jid,
      name,
      checking: true,
      impact: null,
    });
    try {
      const impact = await inspectDeleteFlow(jid);
      if (inspectionSequence.current !== sequence) return;
      setDeleteState({
        open: true,
        jid,
        name,
        checking: false,
        impact,
      });
    } catch (error) {
      if (inspectionSequence.current !== sequence) return;
      setDeleteState(EMPTY_STATE);
      toast.error(
        error instanceof Error
          ? `无法检查工作区：${error.message}`
          : '无法检查工作区，请稍后重试',
      );
    }
  };

  const handleDeleteConfirm = async () => {
    if (
      deleteState.checking ||
      !deleteState.impact ||
      !deleteState.jid ||
      deleteLoading
    ) {
      return;
    }
    const deletedJid = deleteState.jid;
    setDeleteLoading(true);
    try {
      // The user has confirmed that deletion may clean up channel bindings.
      // Always send the flag so a binding created after preflight is handled
      // consistently instead of turning this into another manual retry loop.
      await deleteFlow(deletedJid, { unbindChannels: true });
      inspectionSequence.current += 1;
      setDeleteState(EMPTY_STATE);
      toast.success(
        deleteState.impact.has_channel_bindings
          ? '渠道绑定已解除，工作区已删除'
          : '工作区已删除',
      );
      options.onDeleted?.(deletedJid);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `删除工作区失败：${error.message}`
          : '删除工作区失败，请稍后重试',
      );
    } finally {
      setDeleteLoading(false);
    }
  };

  return {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  };
}
