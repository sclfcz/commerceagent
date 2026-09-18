import { useState } from 'react';
import { Download, LockKeyhole } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface McpServerCardProps {
  server: McpServer;
  selected: boolean;
  onSelect: () => void;
}

export function McpServerCard({
  server,
  selected,
  onSelect,
}: McpServerCardProps) {
  const toggleServer = useMcpServersStore((s) => s.toggleServer);
  const [toggling, setToggling] = useState(false);

  const isHttpType = server.type === 'http' || server.type === 'sse';
  const isImported = server.importedFromHost || server.syncedFromHost;
  const hasConflict = server.conflictSources.length > 1;
  const preview =
    server.runtimeAvailable === false
      ? '仅管理员可用'
      : isHttpType
        ? `${server.type?.toUpperCase()} ${server.url || ''}`
        : [server.command, ...(server.args || [])].join(' ');

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
    try {
      await toggleServer(server.sourceKey, enabled);
      toast.success(`${server.id} 已${enabled ? '启用' : '停用'}`);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : `${enabled ? '启用' : '停用'} MCP 失败`,
      );
    } finally {
      setToggling(false);
    }
  };

  return (
    <div
      className={`w-full overflow-hidden rounded-lg border text-left transition-all focus-within:ring-2 focus-within:ring-ring ${
        selected
          ? 'border-primary bg-brand-50 ring-2 ring-ring'
          : 'border-border hover:bg-muted'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`查看 MCP ${server.id}`}
          onClick={onSelect}
          className="min-w-0 flex-1 cursor-pointer p-4 pr-2 text-left focus-visible:outline-none"
        >
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-medium text-foreground truncate">
              {server.id}
            </h3>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                server.source === 'system'
                  ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {server.source === 'system' ? '系统' : '我的'}
            </span>
            {isHttpType && (
              <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                {server.type?.toUpperCase()}
              </span>
            )}
            {isImported && (
              <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning inline-flex items-center gap-1">
                <Download size={10} />
                宿主机副本
              </span>
            )}
            {server.readonly && (
              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                <LockKeyhole size={10} /> 只读
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground truncate font-mono">
            {preview}
          </p>
          {server.description && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
              {server.description}
            </p>
          )}
          {hasConflict && (
            <p className="mt-1 text-xs text-warning">
              同名来源 · {server.effective ? '当前生效' : '由“我的”配置覆盖'}
            </p>
          )}
        </button>

        <div className="flex shrink-0 items-center p-4 pl-2">
          <Switch
            checked={server.enabled}
            disabled={server.readonly || toggling}
            onCheckedChange={(checked) => void handleToggle(checked)}
            aria-label={`${server.enabled ? '禁用' : '启用'} ${server.id}`}
          />
        </div>
      </div>
    </div>
  );
}
