import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Server, Download, Loader2 } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMcpServersStore } from '../stores/mcp-servers';
import { useAuthStore } from '../stores/auth';
import { McpServerCard } from '../components/mcp-servers/McpServerCard';
import { McpServerDetail } from '../components/mcp-servers/McpServerDetail';
import { AddMcpServerDialog } from '../components/mcp-servers/AddMcpServerDialog';
import type { McpServer } from '../stores/mcp-servers';

export function McpServersPage() {
  const {
    servers,
    loading,
    error,
    syncing,
    loadServers,
    addServer,
    getServer,
    syncHostServers,
  } = useMcpServersStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(
    null,
  );
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        !q ||
        s.id.toLowerCase().includes(q) ||
        (s.command && s.command.toLowerCase().includes(q)) ||
        (s.url && s.url.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [servers, searchQuery]);

  const userServers = filtered.filter((server) => server.source === 'user');
  const systemServers = filtered.filter((server) => server.source === 'system');
  const importedCount = servers.filter(
    (server) => server.importedFromHost || server.syncedFromHost,
  ).length;

  const enabledCount = servers.filter((s) => s.enabled).length;
  const selectedSummary =
    servers.find((server) => server.sourceKey === selectedSourceKey) || null;

  useEffect(() => {
    if (!selectedSourceKey || !selectedSummary) {
      setSelectedServer(null);
      setSelectedError(null);
      return;
    }

    let cancelled = false;
    setSelectedLoading(true);
    setSelectedError(null);
    getServer(selectedSourceKey)
      .then((server) => {
        if (!cancelled) {
          setSelectedServer({
            ...server,
            conflictSources: selectedSummary.conflictSources,
            effective: selectedSummary.effective,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedServer(null);
          setSelectedError(
            error instanceof Error ? error.message : '读取 MCP 详情失败',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getServer, selectedSourceKey, selectedSummary]);

  const handleSync = async () => {
    setSyncMessage(null);
    try {
      const result = await syncHostServers();
      const { added, skipped } = result;
      setSyncMessage(
        `导入完成：新增 ${added}，跳过 ${skipped}。已导入的是独立副本，不会覆盖现有配置。`,
      );
      setTimeout(() => setSyncMessage(null), 5000);
    } catch {
      // error handled by store
    }
  };

  const handleAdd = async (server: Parameters<typeof addServer>[0]) => {
    await addServer(server);
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="MCP 服务器"
            subtitle={`我的 ${servers.filter((server) => server.source === 'user').length} · 系统 ${servers.filter((server) => server.source === 'system').length} · 启用 ${enabledCount}${importedCount > 0 ? ` · 宿主机副本 ${importedCount}` : ''}`}
            actions={
              <div className="flex items-center gap-3">
                {isAdmin && (
                  <Button
                    variant="outline"
                    onClick={handleSync}
                    disabled={syncing}
                  >
                    <Download
                      size={18}
                      className={syncing ? 'animate-pulse' : ''}
                    />
                    {syncing ? '导入中...' : '导入宿主机副本'}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={loadServers}
                  disabled={loading}
                >
                  <RefreshCw
                    size={18}
                    className={loading ? 'animate-spin' : ''}
                  />
                  刷新
                </Button>
                <Button onClick={() => setShowAddDialog(true)}>
                  <Plus size={18} />
                  添加
                </Button>
              </div>
            }
          />
        </div>

        <div className="mx-6 mt-4 rounded-lg border border-warning/20 bg-warning-bg px-4 py-3 text-xs leading-5 text-warning">
          这里管理 CommerceAgent 额外提供的 MCP，再由各智能体决定是否允许使用。
          继承宿主机 ~/.claude 的智能体会自动获得宿主机全部
          MCP，无需导入或勾选。 密钥写入后不会再次显示；STDIO 命令会在智能体
          的实际运行环境中执行。
        </div>

        {/* Sync message toast */}
        {syncMessage && (
          <div className="mx-6 mt-4 p-3 bg-success-bg border border-success/20 rounded-lg text-sm text-success">
            {syncMessage}
          </div>
        )}

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* Left list */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索 ID、命令或 URL"
              />
            </div>

            <div className="space-y-6">
              {loading && servers.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <Card className="border-error/20">
                  <CardContent className="text-center">
                    <p className="text-error">{error}</p>
                  </CardContent>
                </Card>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={
                    searchQuery
                      ? '没有找到匹配的 MCP 服务器'
                      : '暂无 MCP 服务器'
                  }
                  description={
                    searchQuery
                      ? undefined
                      : '点击"添加"按钮添加第一个 MCP 服务器'
                  }
                />
              ) : (
                <>
                  {userServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        我的 MCP ({userServers.length})
                      </h2>
                      <div className="space-y-2">
                        {userServers.map((server) => (
                          <McpServerCard
                            key={server.sourceKey}
                            server={server}
                            selected={selectedSourceKey === server.sourceKey}
                            onSelect={() =>
                              setSelectedSourceKey(server.sourceKey)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {systemServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-muted-foreground mb-3">
                        系统 MCP ({systemServers.length})
                      </h2>
                      <p className="mb-3 text-xs leading-5 text-muted-foreground">
                        系统列表对所有用户可见，仅管理员可修改；是否允许成员的
                        智能体
                        使用由每项配置决定。系统与个人存在同名配置时，个人配置优先。
                      </p>
                      <div className="space-y-2">
                        {systemServers.map((server) => (
                          <McpServerCard
                            key={server.sourceKey}
                            server={server}
                            selected={selectedSourceKey === server.sourceKey}
                            onSelect={() =>
                              setSelectedSourceKey(server.sourceKey)
                            }
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right detail (desktop) */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            {selectedLoading ? (
              <div className="flex min-h-40 items-center justify-center rounded-xl border border-border">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : selectedError ? (
              <div
                role="alert"
                className="rounded-xl border border-error/20 bg-error-bg p-4 text-sm text-error"
              >
                {selectedError}
              </div>
            ) : (
              <McpServerDetail
                server={selectedServer}
                onDeleted={() => setSelectedSourceKey(null)}
              />
            )}
          </div>
        </div>

        {/* Mobile detail */}
        {selectedSourceKey && (
          <div className="lg:hidden p-4">
            {selectedLoading ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl border border-border">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : selectedError ? (
              <div
                role="alert"
                className="rounded-xl border border-error/20 bg-error-bg p-4 text-sm text-error"
              >
                {selectedError}
              </div>
            ) : (
              <McpServerDetail
                server={selectedServer}
                onDeleted={() => setSelectedSourceKey(null)}
              />
            )}
          </div>
        )}
      </div>

      <AddMcpServerDialog
        open={showAddDialog}
        isAdmin={isAdmin}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAdd}
      />
    </div>
  );
}
