import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api } from '../../api/client';
import type {
  BalancingConfig,
  ProviderWithHealth,
  ProvidersListResponse,
  ProviderHealthStatus,
} from './types';
import { getErrorMessage } from './types';
import { ProviderList } from './ProviderList';
import { ProviderEditor } from './ProviderEditor';
import { BalancingSettings } from './BalancingSettings';

interface ClaudeProviderSectionProps {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ClaudeProviderSection({
  setNotice,
  setError,
}: ClaudeProviderSectionProps) {
  const [providers, setProviders] = useState<ProviderWithHealth[]>([]);
  const enabledCount = providers.filter((provider) => provider.enabled).length;
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(
    null,
  );
  const [balancing, setBalancing] = useState<BalancingConfig | null>(null);

  const [loading, setLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // 编辑器状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProvider, setEditingProvider] =
    useState<ProviderWithHealth | null>(null);

  // 确认对话框
  const [pendingDeleteProvider, setPendingDeleteProvider] =
    useState<ProviderWithHealth | null>(null);

  // 健康轮询标记
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── 加载提供商列表 ──────────────────────────────────────────
  const loadProviders = useCallback(async () => {
    try {
      const data = await api.get<ProvidersListResponse>(
        '/api/config/claude/providers',
      );
      setProviders(data.providers);
      setDefaultProviderId(data.defaultProviderId);
      setBalancing(data.balancing);
    } catch (err) {
      setError(getErrorMessage(err, '加载模型配置列表失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // ─── 健康状态轮询（启用 >= 2 个提供商时） ────────────────────
  useEffect(() => {
    if (healthTimerRef.current) {
      clearInterval(healthTimerRef.current);
      healthTimerRef.current = null;
    }

    if (enabledCount < 2) return;

    const pollHealth = async () => {
      try {
        const data = await api.get<{ statuses: ProviderHealthStatus[] }>(
          '/api/config/claude/providers/health',
        );
        setProviders((prev) =>
          prev.map((p) => {
            const updated = data.statuses.find((s) => s.profileId === p.id);
            return updated ? { ...p, health: updated } : p;
          }),
        );
      } catch {
        // 静默忽略
      }
    };

    healthTimerRef.current = setInterval(pollHealth, 10000);
    return () => {
      if (healthTimerRef.current) {
        clearInterval(healthTimerRef.current);
        healthTimerRef.current = null;
      }
    };
  }, [enabledCount]);

  // ─── 切换提供商启用/禁用 ──────────────────────────────────────
  const handleToggle = useCallback(
    async (provider: ProviderWithHealth) => {
      setTogglingId(provider.id);
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/toggle`,
          { enabled: !provider.enabled },
          120_000,
        );
        await loadProviders();
        setNotice(
          provider.enabled
            ? `已禁用「${provider.name}」`
            : `已启用「${provider.name}」`,
        );
      } catch (err) {
        // A 503 can mean the target state was persisted but runtime teardown
        // failed afterward. Reload instead of leaving a stale toggle that a
        // user might click again and accidentally reverse.
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '切换模型配置状态失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 重置健康状态 ─────────────────────────────────────────────
  const handleResetHealth = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post(
          `/api/config/claude/providers/${provider.id}/reset-health`,
        );
        await loadProviders();
        setNotice('健康状态已重置');
      } catch (err) {
        setError(getErrorMessage(err, '重置健康状态失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  const handleSetDefault = useCallback(
    async (provider: ProviderWithHealth) => {
      setTogglingId(provider.id);
      try {
        await api.put('/api/config/claude/default', {
          providerId: provider.id,
        });
        await loadProviders();
        setNotice(`已将「${provider.name}」设为系统默认模型`);
      } catch (err) {
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '设置默认模型失败'));
      } finally {
        setTogglingId(null);
      }
    },
    [loadProviders, setError, setNotice],
  );

  // ─── 删除提供商 ───────────────────────────────────────────────
  const handleDeleteConfirm = useCallback(async () => {
    if (!pendingDeleteProvider) return;

    const provider = pendingDeleteProvider;
    setDeletingId(provider.id);
    setPendingDeleteProvider(null);

    try {
      await api.delete(`/api/config/claude/providers/${provider.id}`);
      setNotice(`已删除模型配置「${provider.name}」`);
      await loadProviders();
    } catch (err) {
      setError(getErrorMessage(err, '删除模型配置失败'));
    } finally {
      setDeletingId(null);
    }
  }, [pendingDeleteProvider, loadProviders, setNotice, setError]);

  // ─── 复制第三方提供商 ────────────────────────────────────────────
  const handleDuplicate = useCallback(
    async (provider: ProviderWithHealth) => {
      try {
        await api.post('/api/config/claude/providers', {
          name: `${provider.name} (副本)`,
          type: 'third_party',
          anthropicBaseUrl: provider.anthropicBaseUrl,
          anthropicModel: provider.anthropicModel,
          customEnv: provider.customEnv,
          enabled: false,
        });
        await loadProviders();
        setNotice(`已复制模型配置「${provider.name}」，密钥需要重新填写`);
      } catch (err) {
        setError(getErrorMessage(err, '复制模型配置失败'));
      }
    },
    [loadProviders, setNotice, setError],
  );

  // ─── 更新负载均衡设置 ─────────────────────────────────────────
  const handleBalancingChange = useCallback(
    async (updates: Partial<BalancingConfig>) => {
      if (!balancing) return;
      const next = { ...balancing, ...updates };
      setBalancing(next); // 乐观更新；失败时 loadProviders 会拉回真实值
      try {
        const saved = await api.put<BalancingConfig>(
          '/api/config/claude/balancing',
          next,
        );
        setBalancing(saved);
        setNotice('负载均衡设置已更新');
      } catch (err) {
        await loadProviders().catch(() => {});
        setError(getErrorMessage(err, '更新负载均衡设置失败'));
      }
    },
    [balancing, loadProviders, setNotice, setError],
  );

  // ─── 编辑器回调 ───────────────────────────────────────────────
  const handleEditorSave = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
    loadProviders();
  }, [loadProviders]);

  const handleEditorCancel = useCallback(() => {
    setEditorOpen(false);
    setEditingProvider(null);
  }, []);

  const busy = loading || togglingId !== null || deletingId !== null;

  if (loading && providers.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 会话续接状态说明 */}
      <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm font-medium text-foreground">会话续接</div>
          <code className="rounded bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground">
            npm run probe:session-continuity
          </code>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          智能体切换模型配置时，已有对话要由新的上游继续。只有通过实测的上游才能稳定续接：
          <span className="mx-1 rounded border border-emerald-200 bg-emerald-50 px-1 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            已验证续接
          </span>
          表示该上游可以接续自己产生的会话；
          <span className="mx-1 rounded border border-amber-200 bg-amber-50 px-1 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            续接未验证
          </span>
          表示还没测过，仍可选，但切换会让会话以新会话继续；
          <span className="mx-1 rounded border border-red-200 bg-red-50 px-1 text-red-600 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400">
            不可续接
          </span>
          的上游不能作为智能体的模型配置。在服务器上运行上面的命令会产生真实模型请求并可能产生费用；
          修改上游地址或模型后，旧结论自动失效。
        </p>
      </div>

      {/* 提供商列表 */}
      <ProviderList
        providers={providers}
        defaultProviderId={defaultProviderId}
        onEdit={(p) => {
          setEditingProvider(p);
          setEditorOpen(true);
        }}
        onDelete={(p) => setPendingDeleteProvider(p)}
        onToggle={handleToggle}
        onResetHealth={handleResetHealth}
        onSetDefault={handleSetDefault}
        onDuplicate={handleDuplicate}
        onAdd={() => {
          setEditingProvider(null);
          setEditorOpen(true);
        }}
        togglingId={togglingId}
        deletingId={deletingId}
        disabled={busy}
      />

      {/* 负载均衡设置：配置了多个模型时展示（池只在 >=2 启用时生效） */}
      {balancing && providers.length >= 2 && (
        <BalancingSettings
          balancing={balancing}
          onChange={handleBalancingChange}
          disabled={busy}
        />
      )}

      {/* 编辑器弹窗 */}
      <ProviderEditor
        open={editorOpen}
        provider={editingProvider}
        onSave={handleEditorSave}
        onCancel={handleEditorCancel}
        setNotice={setNotice}
        setError={setError}
      />

      {/* 确认删除对话框 */}
      <ConfirmDialog
        open={pendingDeleteProvider !== null}
        onClose={() => setPendingDeleteProvider(null)}
        onConfirm={handleDeleteConfirm}
        title="删除模型配置"
        message={
          pendingDeleteProvider
            ? `确认删除模型配置「${pendingDeleteProvider.name}」？`
            : '确认删除该模型配置？'
        }
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deletingId !== null}
      />
    </div>
  );
}
