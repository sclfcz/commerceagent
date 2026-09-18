import { MoreHorizontal, Pencil, Trash2, RotateCcw, Pin } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../stores/auth';

export interface ChatGroupItemProps {
  jid: string;
  name: string;
  folder: string;
  lastMessage?: string;

  isActive: boolean;
  isHome: boolean;
  isPinned?: boolean;
  isRunning?: boolean;
  // Owner-only ACL (backend buildGroupsPayload 下发的 can_modify)，门控所有破坏性操作
  canModify?: boolean;
  onSelect: (jid: string, folder: string) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
  onTogglePin?: (jid: string) => void;
}

export function ChatGroupItem({
  jid,
  name,
  folder,
  isActive,
  isHome,
  isPinned,
  isRunning,
  canModify,
  onSelect,
  onRename,
  onClearHistory,
  onDelete,
  onTogglePin,
}: ChatGroupItemProps) {
  const currentUser = useAuthStore((s) => s.user);
  const defaultHomeName = '我的工作区';
  // Use actual name if it's been renamed, otherwise fall back to default
  const isDefaultName =
    !name || name === 'Main' || name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? defaultHomeName : name;
  return (
    <div
      className={cn(
        'ecommerce-sidebar-item group relative mb-0.5 rounded-md transition-colors',
        isActive
          ? 'bg-accent/80 text-foreground'
          : 'text-foreground hover:bg-accent/45',
      )}
    >
      <button
        onClick={() => onSelect(jid, folder)}
        aria-current={isActive ? 'page' : undefined}
        className="flex min-h-11 w-full items-center px-2.5 pr-10 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        <span className="min-w-0 flex-1 truncate text-[14px] font-normal leading-5">
          {displayName}
        </span>
        {isPinned && !isHome && (
          <span className="ml-1 shrink-0 text-[10px] text-muted-foreground">
            固定
          </span>
        )}
        {isRunning && (
          <span className="ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
        )}
      </button>

      {/* Dropdown menu */}
      <div
        className={cn(
          'absolute right-2 top-1/2 -translate-y-1/2 flex items-center',
          'opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity',
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={(e) => e.stopPropagation()}
              title={`${displayName}的更多操作`}
              aria-label={`${displayName}的更多操作`}
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            {!isHome && onTogglePin && (
              <DropdownMenuItem onClick={() => onTogglePin(jid)}>
                <Pin className="w-4 h-4" />
                {isPinned ? '取消固定' : '固定'}
              </DropdownMenuItem>
            )}
            {canModify && onRename && (
              <DropdownMenuItem onClick={() => onRename(jid, name)}>
                <Pencil className="w-4 h-4" />
                重命名
              </DropdownMenuItem>
            )}
            {canModify && (
              <DropdownMenuItem
                onClick={() => onClearHistory(jid, displayName)}
                className="text-amber-700 dark:text-amber-400 focus:text-amber-700 dark:focus:text-amber-400"
              >
                <RotateCcw className="w-4 h-4" />
                重建工作区
              </DropdownMenuItem>
            )}
            {!isHome && canModify && onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete(jid, name)}
              >
                <Trash2 className="w-4 h-4" />
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
