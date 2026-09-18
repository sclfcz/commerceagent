import { useState, useMemo, useEffect } from 'react';
import {
  Bot,
  Loader2,
  FolderOpen,
  MessageSquare,
  RotateCcw,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common/SearchInput';
import type { BindingTarget } from './hooks/useImBindings';
import { getAgentProfileDisplayName } from '../../utils/agent-product';

interface BindingTargetDialogProps {
  open: boolean;
  imGroupName: string;
  targets: BindingTarget[];
  targetsLoading: boolean;
  targetType: 'workspace' | 'session' | 'both';
  canUnbind: boolean;
  onSelect: (target: BindingTarget) => void;
  onRestoreDefault: () => void;
  onClose: () => void;
  selecting?: string | null;
}

export function BindingTargetDialog({
  open,
  imGroupName,
  targets,
  targetsLoading,
  targetType,
  canUnbind,
  onSelect,
  onRestoreDefault,
  onClose,
  selecting,
}: BindingTargetDialogProps) {
  const [filter, setFilter] = useState('');

  // Clear filter when dialog closes to avoid stale search state on reopen
  useEffect(() => {
    if (!open) setFilter('');
  }, [open]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return targets;
    const q = filter.trim().toLowerCase();
    return targets.filter(
      (t) =>
        t.groupName.toLowerCase().includes(q) ||
        (t.sessionName && t.sessionName.toLowerCase().includes(q)),
    );
  }, [targets, filter]);

  // Group targets by Agent profile, then workspace.
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        agentName: string;
        workspaces: Map<string, BindingTarget[]>;
      }
    >();
    for (const t of filtered) {
      const agentKey = t.agentProfileId || t.agentProfileName || 'default';
      if (!map.has(agentKey)) {
        map.set(agentKey, {
          agentName: getAgentProfileDisplayName(t.agentProfileName),
          workspaces: new Map(),
        });
      }
      const agentGroup = map.get(agentKey)!;
      if (!agentGroup.workspaces.has(t.groupJid)) {
        agentGroup.workspaces.set(t.groupJid, []);
      }
      agentGroup.workspaces.get(t.groupJid)!.push(t);
    }
    return map;
  }, [filtered]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setFilter('');
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base truncate">
            {targetType === 'workspace'
              ? '选择工作区'
              : targetType === 'session'
                ? '选择会话'
                : '选择工作区或会话'}{' '}
            — {imGroupName}
          </DialogTitle>
        </DialogHeader>

        {!targetsLoading && targets.length > 3 && (
          <SearchInput
            value={filter}
            onChange={setFilter}
            placeholder={
              targetType === 'workspace'
                ? '搜索工作区...'
                : targetType === 'session'
                  ? '搜索会话...'
                  : '搜索工作区或会话...'
            }
            debounce={150}
          />
        )}

        <div className="space-y-3 max-h-80 overflow-y-auto">
          {targetsLoading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              加载中...
            </div>
          )}

          {!targetsLoading && targets.length === 0 && (
            <div className="text-center py-8 text-muted-foreground text-sm">
              {targetType === 'workspace'
                ? '暂无可绑定的工作区。请先创建工作区。'
                : targetType === 'session'
                  ? '暂无可绑定的会话。请先在工作区内创建会话。'
                  : '暂无可绑定的工作区或会话。'}
            </div>
          )}

          {!targetsLoading && targets.length > 0 && filtered.length === 0 && (
            <div className="text-center py-6 text-muted-foreground text-sm">
              没有匹配的目标
            </div>
          )}

          {!targetsLoading &&
            Array.from(grouped.entries()).map(([agentKey, agentGroup]) => (
              <div key={agentKey} className="space-y-2">
                <div className="flex items-center gap-1.5 px-1 text-xs font-semibold text-foreground">
                  <Bot className="w-3.5 h-3.5 text-primary" />
                  {agentGroup.agentName}
                </div>
                {Array.from(agentGroup.workspaces.entries()).map(
                  ([groupJid, items]) => (
                    <div
                      key={groupJid}
                      className="space-y-1 rounded-md border border-border/60 p-2"
                    >
                      <div className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
                        <FolderOpen className="w-3 h-3" />
                        {items[0].groupName}
                      </div>
                      {items.map((target) => {
                        const key =
                          target.sessionId || `main:${target.groupJid}`;
                        const isSelecting = selecting === key;
                        return (
                          <button
                            key={key}
                            onClick={() => onSelect(target)}
                            disabled={!!selecting}
                            className="w-full flex items-center gap-3 px-3 py-2 rounded-md border border-border hover:border-brand-300 hover:bg-brand-50/50 dark:hover:border-brand-600 dark:hover:bg-brand-700/10 transition-colors text-left cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <MessageSquare className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                            <span className="flex-1 text-sm truncate">
                              {target.type === 'session'
                                ? target.sessionName || '会话'
                                : '绑定到此工作区'}
                            </span>
                            {isSelecting && (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ),
                )}
              </div>
            ))}
        </div>

        {canUnbind && (
          <div className="border-t border-border pt-3 mt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRestoreDefault}
              disabled={!!selecting}
              className="text-muted-foreground hover:text-foreground w-full"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              恢复账号默认工作区
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
