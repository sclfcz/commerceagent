import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Download,
  Info,
  RefreshCw,
  SlidersHorizontal,
  Table2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { useUsageStore } from '../stores/usage';
import type {
  UsageBreakdown,
  UsageAttributionItem,
  UsageDailyBucket,
  UsageQuery,
  UsageSummary,
  UsageWindow,
} from '../stores/usage';
import { buildUsageQueryParams, usageQueryKey } from '../stores/usage';
import { useAuthStore } from '../stores/auth';
import { useBillingStore } from '../stores/billing';
import { formatTokens } from '../components/billing/utils';
import {
  UsageTrendChart,
  type DailyUsagePoint,
  type UsageTrendMetric,
} from '../components/usage/UsageTrendChart';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DownloadError,
  downloadFromUrl,
  downloadTextFile,
} from '@/utils/download';

const PERIOD_OPTIONS = [7, 14, 30, 90] as const;
const ALL_VALUE = '__all__';

type TrendView = 'chart' | 'table';
type AttributionDimension = 'model' | 'agent' | 'workspace' | 'source';
type AttributionSort = 'cost' | 'tokens' | 'runs';
type SortDirection = 'desc' | 'asc';

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  model: '模型',
  agent: '智能体',
  workspace: '工作区',
  source: '来源',
};

const SOURCE_LABELS: Record<string, string> = {
  agent: '智能体对话',
  main: '主智能体',
  'main-agent': '主智能体',
  'custom-agent': '自定义智能体',
  scheduled_task: '定时任务',
  task: '定时任务',
  automation: '自动化任务',
  chat: '网页对话',
  im: '消息渠道',
  unknown: '未标记来源',
  unassigned: '未标记来源',
};

interface AttributionRow {
  key: string;
  label: string;
  tokens: number;
  estimatedCost: number;
  billedCost: number | null;
  runCount: number;
  modelCallCount: number;
}

function parseDays(value: string | null): number {
  const parsed = Number.parseInt(value || '7', 10);
  return PERIOD_OPTIONS.includes(parsed as (typeof PERIOD_OPTIONS)[number])
    ? parsed
    : 7;
}

function parseQuery(params: URLSearchParams, isAdmin: boolean): UsageQuery {
  const read = (name: string) => params.get(name)?.trim() || null;
  return {
    days: parseDays(params.get('days')),
    userId: isAdmin ? read('userId') : null,
    model: read('model'),
    agentId: read('agentId'),
    groupFolder: read('groupFolder'),
    source: read('source'),
  };
}

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function formatDateRange(window: UsageWindow | null, days: number): string {
  if (!window) return `过去 ${days} 天`;
  return `${window.from} 至 ${window.to}`;
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return '等待首次更新';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function enumerateDates(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start > end
  ) {
    return [];
  }
  const dates: string[] = [];
  for (
    const date = start;
    date <= end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

function buildDailyData(
  breakdown: UsageBreakdown[],
  daily: UsageDailyBucket[],
  window: UsageWindow | null,
): DailyUsagePoint[] {
  if (!window) return [];
  const byDate = new Map<string, DailyUsagePoint>();
  for (const date of enumerateDates(window.from, window.to)) {
    byDate.set(date, {
      date,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: null,
      runCount: 0,
      modelCallCount: 0,
    });
  }
  if (daily.length > 0) {
    for (const row of daily) {
      const point = byDate.get(row.date);
      if (!point) continue;
      point.inputTokens = row.inputTokens;
      point.cacheReadTokens = row.cacheReadTokens;
      point.cacheCreationTokens = row.cacheCreationTokens;
      point.reasoningTokens = row.reasoningTokens;
      point.outputTokens = row.outputTokens;
      point.totalTokens = row.totalTokens;
      point.providerEstimatedCostUSD = row.providerEstimatedCostUSD;
      point.billedCostUSD = row.billedCostUSD;
      point.runCount = row.runCount;
      point.modelCallCount = row.modelCallCount;
    }
    return Array.from(byDate.values());
  }
  for (const row of breakdown) {
    const point = byDate.get(row.date);
    if (!point) continue;
    point.inputTokens += row.input_tokens;
    point.cacheReadTokens += row.cache_read_tokens;
    point.cacheCreationTokens += row.cache_creation_tokens;
    point.reasoningTokens += row.reasoning_tokens;
    point.outputTokens += row.output_tokens;
    point.totalTokens +=
      row.input_tokens +
      row.cache_read_tokens +
      row.cache_creation_tokens +
      row.output_tokens +
      row.reasoning_tokens;
    point.providerEstimatedCostUSD += row.provider_estimated_cost_usd;
    if (row.billed_cost_usd !== null) {
      point.billedCostUSD = (point.billedCostUSD || 0) + row.billed_cost_usd;
    }
    point.runCount += row.run_count;
    point.modelCallCount += row.model_call_count;
  }
  return Array.from(byDate.values());
}

function attributionKey(
  row: UsageBreakdown,
  dimension: AttributionDimension,
): { key: string; label: string } {
  if (dimension === 'model') {
    return { key: row.model || 'unknown', label: row.model || '未知模型' };
  }
  if (dimension === 'agent') {
    return {
      key: row.agent_id || 'unknown',
      label: row.agent_name || row.agent_id || '未标记智能体',
    };
  }
  if (dimension === 'workspace') {
    return {
      key: row.group_folder || 'unknown',
      label: row.workspace_name || row.group_folder || '未标记工作区',
    };
  }
  const source = row.source || 'unknown';
  return { key: source, label: SOURCE_LABELS[source] || source };
}

function buildAttributionRows(
  breakdown: UsageBreakdown[],
  dimension: AttributionDimension,
): AttributionRow[] {
  const rows = new Map<string, AttributionRow>();
  for (const item of breakdown) {
    const identity = attributionKey(item, dimension);
    const existing = rows.get(identity.key) || {
      key: identity.key,
      label: identity.label,
      tokens: 0,
      estimatedCost: 0,
      billedCost: null,
      runCount: 0,
      modelCallCount: 0,
    };
    existing.tokens +=
      item.input_tokens +
      item.cache_read_tokens +
      item.cache_creation_tokens +
      item.output_tokens +
      item.reasoning_tokens;
    existing.estimatedCost += item.provider_estimated_cost_usd;
    if (item.billed_cost_usd !== null) {
      existing.billedCost = (existing.billedCost || 0) + item.billed_cost_usd;
    }
    existing.runCount += item.run_count;
    existing.modelCallCount += item.model_call_count;
    rows.set(identity.key, existing);
  }
  return Array.from(rows.values());
}

function attributionRowsFromServer(
  items: UsageAttributionItem[],
  dimension: AttributionDimension,
): AttributionRow[] {
  return items.map((item) => ({
    key: item.key,
    label:
      dimension === 'source'
        ? SOURCE_LABELS[item.key] || item.name || item.key
        : item.name || item.key,
    tokens: item.totalTokens,
    estimatedCost: item.providerEstimatedCostUSD,
    billedCost: item.billedCostUSD,
    runCount: item.runCount,
    modelCallCount: item.modelCallCount,
  }));
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function buildFallbackCsv(rows: UsageBreakdown[]): string {
  const headers = [
    '日期',
    '模型',
    '用户 ID',
    '智能体 ID',
    '工作区',
    '来源',
    '普通输入 Token',
    '缓存读取 Token',
    '缓存写入 Token',
    '输出 Token',
    '推理 Token',
    '模型估算费用 USD',
    '账单扣费 USD',
    '智能体运行次数',
    '模型调用次数',
  ];
  const body = rows.map((row) =>
    [
      row.date,
      row.model,
      row.user_id,
      row.agent_id,
      row.group_folder,
      row.source,
      row.input_tokens,
      row.cache_read_tokens,
      row.cache_creation_tokens,
      row.output_tokens,
      row.reasoning_tokens,
      row.provider_estimated_cost_usd,
      row.billed_cost_usd,
      row.run_count,
      row.model_call_count,
    ]
      .map(csvCell)
      .join(','),
  );
  return `\uFEFF${[headers.map(csvCell).join(','), ...body].join('\n')}`;
}

function metricValue(
  summary: UsageSummary,
  key: 'tokens' | 'runs' | 'cost' | 'average',
): string {
  if (key === 'tokens') return formatTokens(summary.totalTokens);
  if (key === 'runs') return formatInteger(summary.runCount);
  if (key === 'cost') return formatCost(summary.providerEstimatedCostUSD);
  return formatCost(summary.averageCostPerRunUSD);
}

export function UsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const user = useAuthStore((state) => state.user);
  const billingEnabled = useBillingStore((state) => state.billingEnabled);
  const isAdmin = user?.role === 'admin';
  const query = useMemo(
    () => parseQuery(searchParams, isAdmin),
    [isAdmin, searchParams],
  );
  const queryKey = usageQueryKey(query);
  const {
    ownerUserId,
    summary,
    breakdown,
    daily,
    window,
    generatedAt,
    attributions,
    billing,
    loading,
    error,
    availableModels,
    availableUsers,
    availableAgents,
    availableWorkspaces,
    availableSources,
    agentNames,
    workspaceNames,
    ensureOwner,
    setQuery,
    loadStats,
    loadFilters,
  } = useUsageStore();

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [trendMetric, setTrendMetric] = useState<UsageTrendMetric>('tokens');
  const [trendView, setTrendView] = useState<TrendView>('chart');
  const [dimension, setDimension] = useState<AttributionDimension>('model');
  const [sortBy, setSortBy] = useState<AttributionSort>('cost');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [exporting, setExporting] = useState(false);

  const authUserId = user?.id || null;
  const ownsState = ownerUserId === authUserId;
  const visibleSummary = ownsState ? summary : null;
  const visibleBreakdown = ownsState ? breakdown : [];
  const visibleDaily = ownsState ? daily : [];
  const visibleWindow = ownsState ? window : null;
  const visibleGeneratedAt = ownsState ? generatedAt : null;
  const visibleBilling = ownsState ? billing : null;
  const visibleLoading = !ownsState || loading;
  const visibleError = ownsState ? error : null;

  useEffect(() => {
    if (isAdmin || !searchParams.has('userId')) return;
    const next = new URLSearchParams(searchParams);
    next.delete('userId');
    setSearchParams(next, { replace: true });
  }, [isAdmin, searchParams, setSearchParams]);

  useEffect(() => {
    ensureOwner(authUserId);
    setQuery(query);
    void loadStats(query);
    void loadFilters(query);
  }, [authUserId, ensureOwner, loadFilters, loadStats, queryKey, setQuery]);

  const updateFilter = (name: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    next.set('days', String(query.days));
    if (!value || value === ALL_VALUE) next.delete(name);
    else next.set(name, value);
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    setSearchParams({ days: String(query.days) }, { replace: true });
  };

  const dailyData = useMemo(
    () => buildDailyData(visibleBreakdown, visibleDaily, visibleWindow),
    [visibleBreakdown, visibleDaily, visibleWindow],
  );

  const attributionRows = useMemo(() => {
    const serverItems =
      dimension === 'model'
        ? attributions.models
        : dimension === 'agent'
          ? attributions.agents
          : dimension === 'workspace'
            ? attributions.workspaces
            : attributions.sources;
    const rows =
      ownsState && serverItems.length > 0
        ? attributionRowsFromServer(serverItems, dimension)
        : buildAttributionRows(visibleBreakdown, dimension);
    const multiplier = sortDirection === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      const left =
        sortBy === 'cost'
          ? a.estimatedCost
          : sortBy === 'tokens'
            ? a.tokens
            : a.runCount;
      const right =
        sortBy === 'cost'
          ? b.estimatedCost
          : sortBy === 'tokens'
            ? b.tokens
            : b.runCount;
      return (left - right) * multiplier || a.label.localeCompare(b.label);
    });
  }, [
    attributions,
    dimension,
    ownsState,
    sortBy,
    sortDirection,
    visibleBreakdown,
  ]);

  const selectedUser = availableUsers.find(
    (option) => option.id === query.userId,
  );
  const scopeLabel = isAdmin
    ? selectedUser?.username || (query.userId ? '指定用户' : '全组织')
    : '我的用量';
  const activeFilterCount = [
    query.userId,
    query.model,
    query.agentId,
    query.groupFolder,
    query.source,
  ].filter(Boolean).length;
  const cacheDenominator = visibleSummary
    ? visibleSummary.inputTokens +
      visibleSummary.cacheReadTokens +
      visibleSummary.cacheCreationTokens
    : 0;
  const cacheReadShare =
    visibleSummary && cacheDenominator > 0
      ? (visibleSummary.cacheReadTokens / cacheDenominator) * 100
      : 0;
  const billingApplicable = visibleBilling?.applicable ?? billingEnabled;
  const billingFeatureEnabled = visibleBilling?.enabled ?? billingEnabled;

  const handleExport = async () => {
    if (!visibleWindow || visibleBreakdown.length === 0) return;
    setExporting(true);
    const filename = `commerceagent-usage-${visibleWindow.from}-${visibleWindow.to}.csv`;
    try {
      await downloadFromUrl(
        `/api/usage/export.csv?${buildUsageQueryParams(query)}`,
        filename,
      );
      toast.success('用量明细已导出');
    } catch (exportError) {
      if (exportError instanceof DownloadError && exportError.status === 404) {
        downloadTextFile(
          buildFallbackCsv(visibleBreakdown),
          filename,
          'text/csv;charset=utf-8',
        );
        toast.success('已导出当前聚合数据');
      } else if (
        exportError instanceof DownloadError &&
        exportError.status === 413
      ) {
        toast.error('导出记录过多，请缩小时间范围或增加筛选条件后重试');
      } else if (
        exportError instanceof DownloadError &&
        (exportError.status === 401 || exportError.status === 403)
      ) {
        toast.error('登录状态已失效，请重新登录');
      } else {
        toast.error('导出失败，请稍后重试');
      }
    } finally {
      setExporting(false);
    }
  };

  const hasUsage = Boolean(visibleSummary && visibleSummary.runCount > 0);

  return (
    <div className="min-h-full bg-background px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto min-w-0 max-w-7xl space-y-6">
        <header className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                用量分析
              </h1>
              <Badge variant="outline">{scopeLabel}</Badge>
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              查看智能体运行、Token
              与模型成本估算。模型估算费用用于分析资源消耗，不等同于账单扣费。
            </p>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                统计范围：{formatDateRange(visibleWindow, query.days)}
              </span>
              <span>时区：{visibleWindow?.timezone || '加载中'}</span>
              <span>更新时间：{formatUpdatedAt(visibleGeneratedAt)}</span>
            </div>
          </div>
          <div className="flex w-full flex-wrap gap-2 lg:w-auto lg:justify-end">
            <Button
              variant="outline"
              size="lg"
              className="min-h-11 flex-1 sm:flex-none"
              onClick={() =>
                void Promise.all([loadStats(query), loadFilters(query)])
              }
              disabled={visibleLoading}
              aria-label={visibleLoading ? '正在刷新用量数据' : '刷新用量数据'}
            >
              <RefreshCw
                className={visibleLoading ? 'motion-safe:animate-spin' : ''}
              />
              刷新数据
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="min-h-11 flex-1 sm:flex-none"
              onClick={() => void handleExport()}
              disabled={exporting || visibleBreakdown.length === 0}
            >
              <Download />
              {exporting ? '正在导出' : '导出 CSV'}
            </Button>
          </div>
        </header>
        <p className="sr-only" role="status" aria-live="polite">
          {visibleLoading
            ? '正在更新用量数据'
            : visibleSummary
              ? `用量数据已更新，共 ${visibleSummary.runCount} 次智能体运行`
              : ''}
        </p>

        <section
          className="rounded-xl border border-border bg-card/40 p-3 sm:p-4"
          aria-label="用量筛选"
          aria-busy={visibleLoading}
        >
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-between rounded-lg px-2 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="usage-filter-fields"
          >
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="size-4" />
              筛选条件
              {activeFilterCount > 0 && (
                <Badge variant="secondary">{activeFilterCount}</Badge>
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {filtersOpen ? '收起' : '展开'}
            </span>
          </button>
          <div
            id="usage-filter-fields"
            className={`${filtersOpen ? 'grid' : 'hidden'} min-w-0 grid-cols-1 gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6`}
          >
            <FilterSelect
              id="usage-days"
              label="时间范围"
              value={String(query.days)}
              onChange={(value) => updateFilter('days', value)}
              options={PERIOD_OPTIONS.map((days) => ({
                value: String(days),
                label: `过去 ${days} 天`,
              }))}
            />
            {isAdmin && (
              <FilterSelect
                id="usage-user"
                label="统计用户"
                value={query.userId || ALL_VALUE}
                onChange={(value) => updateFilter('userId', value)}
                options={[
                  { value: ALL_VALUE, label: '全部用户' },
                  ...availableUsers.map((option) => ({
                    value: option.id,
                    label: option.username,
                  })),
                ]}
              />
            )}
            <FilterSelect
              id="usage-model"
              label="模型"
              value={query.model || ALL_VALUE}
              onChange={(value) => updateFilter('model', value)}
              options={[
                { value: ALL_VALUE, label: '全部模型' },
                ...availableModels.map((model) => ({
                  value: model,
                  label: model,
                })),
              ]}
            />
            <FilterSelect
              id="usage-agent"
              label="智能体"
              value={query.agentId || ALL_VALUE}
              onChange={(value) => updateFilter('agentId', value)}
              options={[
                { value: ALL_VALUE, label: '全部智能体' },
                ...availableAgents.map((agentId) => ({
                  value: agentId,
                  label: agentNames[agentId] || agentId,
                })),
              ]}
            />
            <FilterSelect
              id="usage-workspace"
              label="工作区"
              value={query.groupFolder || ALL_VALUE}
              onChange={(value) => updateFilter('groupFolder', value)}
              options={[
                { value: ALL_VALUE, label: '全部工作区' },
                ...availableWorkspaces.map((folder) => ({
                  value: folder,
                  label: workspaceNames[folder] || folder,
                })),
              ]}
            />
            <FilterSelect
              id="usage-source"
              label="来源"
              value={query.source || ALL_VALUE}
              onChange={(value) => updateFilter('source', value)}
              options={[
                { value: ALL_VALUE, label: '全部来源' },
                ...availableSources.map((source) => ({
                  value: source,
                  label: SOURCE_LABELS[source] || source,
                })),
              ]}
            />
          </div>
          {activeFilterCount > 0 && (
            <div className="mt-3 flex justify-end border-t border-border pt-3">
              <Button
                variant="ghost"
                size="lg"
                className="min-h-11"
                onClick={clearFilters}
              >
                清除筛选
              </Button>
            </div>
          )}
        </section>

        {visibleError && (
          <section
            className="rounded-xl border border-destructive/30 bg-destructive/5 p-5"
            role="alert"
          >
            <h2 className="font-semibold text-foreground">用量数据加载失败</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {visibleError}
              。请检查网络连接后重试，当前不会展示旧账号或旧筛选的数据。
            </p>
            <Button
              variant="outline"
              size="lg"
              className="mt-4 min-h-11"
              onClick={() => void loadStats(query)}
            >
              <RefreshCw />
              重试加载
            </Button>
          </section>
        )}

        {visibleLoading && !visibleError && <UsageLoadingState />}

        {!visibleLoading && !visibleError && visibleSummary && !hasUsage && (
          <UsageEmptyState
            filtered={activeFilterCount > 0}
            onClear={clearFilters}
          />
        )}

        {!visibleLoading && !visibleError && visibleSummary && hasUsage && (
          <div className="min-w-0 space-y-6">
            <section aria-labelledby="usage-summary-heading">
              <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2
                    id="usage-summary-heading"
                    className="text-base font-semibold text-foreground"
                  >
                    核心指标
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    下列指标与趋势图使用同一组服务端日期桶。
                  </p>
                </div>
                <Badge variant="secondary">
                  {visibleSummary.activeDays} 个活跃日
                </Badge>
              </div>
              <dl className="grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-card md:grid-cols-4">
                <MetricItem
                  label="总 Token"
                  value={metricValue(visibleSummary, 'tokens')}
                  exactValue={formatInteger(visibleSummary.totalTokens)}
                />
                <MetricItem
                  label="智能体运行次数"
                  value={metricValue(visibleSummary, 'runs')}
                  note={`${formatInteger(visibleSummary.modelCallCount)} 次模型调用`}
                />
                <MetricItem
                  label="模型估算费用 (USD)"
                  value={metricValue(visibleSummary, 'cost')}
                  note={
                    !billingApplicable
                      ? '账单扣费：不适用（未启用计费）'
                      : visibleSummary.billedCostUSD === null
                        ? '不是账单扣费'
                        : `账单扣费 ${formatCost(visibleSummary.billedCostUSD)}`
                  }
                />
                <MetricItem
                  label="平均每次成本"
                  value={metricValue(visibleSummary, 'average')}
                  note="模型估算费用 ÷ 智能体运行次数"
                />
              </dl>
            </section>

            <section
              className="rounded-xl border border-border bg-muted/20 p-4"
              aria-labelledby="token-composition-heading"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <h2
                    id="token-composition-heading"
                    className="text-sm font-semibold text-foreground"
                  >
                    Token 构成
                  </h2>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    五类互斥，不重复相加。缓存读取占全部输入的{' '}
                    {cacheReadShare.toFixed(1)}%；公式：缓存读取 ÷（普通输入 +
                    缓存读取 + 缓存写入）。
                  </p>
                </div>
                <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
                  <TokenValue
                    label="普通输入"
                    value={visibleSummary.inputTokens}
                  />
                  <TokenValue
                    label="缓存读取"
                    value={visibleSummary.cacheReadTokens}
                  />
                  <TokenValue
                    label="缓存写入"
                    value={visibleSummary.cacheCreationTokens}
                  />
                  <TokenValue
                    label="输出"
                    value={visibleSummary.outputTokens}
                  />
                  <TokenValue
                    label="推理"
                    value={visibleSummary.reasoningTokens}
                  />
                </dl>
              </div>
            </section>

            <Card className="min-w-0">
              <CardContent className="min-w-0 space-y-4">
                <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      每日趋势
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      费用按咖宝模型价格在 UTC 30
                      分钟桶内统一取整；运行次数按完成的智能体用量事件计数。
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <SegmentedControl
                      label="趋势指标"
                      value={trendMetric}
                      onChange={(value) =>
                        setTrendMetric(value as UsageTrendMetric)
                      }
                      options={[
                        { value: 'tokens', label: 'Token' },
                        { value: 'cost', label: '费用' },
                        { value: 'runs', label: '运行次数' },
                      ]}
                    />
                    <SegmentedControl
                      label="趋势视图"
                      value={trendView}
                      onChange={(value) => setTrendView(value as TrendView)}
                      options={[
                        { value: 'chart', label: '图表', icon: BarChart3 },
                        { value: 'table', label: '表格', icon: Table2 },
                      ]}
                    />
                  </div>
                </div>
                {trendView === 'chart' ? (
                  <UsageTrendChart data={dailyData} metric={trendMetric} />
                ) : (
                  <UsageTrendTable
                    data={dailyData}
                    metric={trendMetric}
                    billingApplicable={billingApplicable}
                  />
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0">
              <CardContent className="min-w-0 space-y-4">
                <div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">
                      用量归因
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      找出当前范围内的主要成本与 Token 来源。
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <SegmentedControl
                      label="归因维度"
                      value={dimension}
                      onChange={(value) =>
                        setDimension(value as AttributionDimension)
                      }
                      options={(
                        Object.keys(DIMENSION_LABELS) as AttributionDimension[]
                      ).map((value) => ({
                        value,
                        label: DIMENSION_LABELS[value],
                      }))}
                    />
                    <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-background px-3 text-sm">
                      <span className="shrink-0 text-muted-foreground">
                        排序
                      </span>
                      <select
                        value={sortBy}
                        onChange={(event) =>
                          setSortBy(event.target.value as AttributionSort)
                        }
                        className="min-w-0 flex-1 bg-transparent py-2 text-foreground outline-none"
                        aria-label="归因表排序指标"
                      >
                        <option value="cost">估算费用</option>
                        <option value="tokens">Token</option>
                        <option value="runs">运行次数</option>
                      </select>
                    </label>
                    <Button
                      variant="outline"
                      size="lg"
                      className="min-h-11"
                      onClick={() =>
                        setSortDirection((direction) =>
                          direction === 'desc' ? 'asc' : 'desc',
                        )
                      }
                      aria-label={
                        sortDirection === 'desc'
                          ? '当前降序，切换为升序'
                          : '当前升序，切换为降序'
                      }
                    >
                      {sortDirection === 'desc' ? <ArrowDown /> : <ArrowUp />}
                      {sortDirection === 'desc' ? '降序' : '升序'}
                    </Button>
                  </div>
                </div>
                <AttributionTable
                  rows={attributionRows}
                  dimension={dimension}
                  totalCost={visibleSummary.providerEstimatedCostUSD}
                />
              </CardContent>
            </Card>

            <aside className="flex items-start gap-2 rounded-xl border border-border bg-muted/20 p-4 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              <p>
                模型估算费用按咖宝价格表和 UTC 30
                分钟模型桶计算，可能与套餐倍率、赠送额度或实际账单扣费不同。
                {billingFeatureEnabled && (
                  <>
                    需要核对余额和交易时，请前往{' '}
                    <Link
                      to="/billing"
                      className="font-medium text-primary hover:underline"
                    >
                      账单
                    </Link>
                    。
                  </>
                )}
              </p>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className="block min-w-0">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-11 w-full min-w-0 truncate rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function MetricItem({
  label,
  value,
  note,
  exactValue,
}: {
  label: string;
  value: string;
  note?: string;
  exactValue?: string;
}) {
  return (
    <div className="min-w-0 border-b border-r border-border p-4 last:border-r-0 md:border-b-0 md:p-5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className="mt-2 truncate text-2xl font-semibold tracking-tight text-foreground"
        title={exactValue || value}
      >
        {value}
      </dd>
      {(note || exactValue) && (
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {note || exactValue}
        </p>
      )}
    </div>
  );
}

function TokenValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="mt-1 truncate text-sm font-semibold text-foreground"
        title={formatInteger(value)}
      >
        {formatTokens(value)}
      </dd>
    </div>
  );
}

function SegmentedControl({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{
    value: string;
    label: string;
    icon?: React.ComponentType<{ className?: string }>;
  }>;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className="flex min-w-0 overflow-x-auto rounded-lg border border-border bg-muted/30 p-0.5"
      role="group"
      aria-label={label}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={`flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active
                ? 'bg-background text-foreground ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {Icon && <Icon className="size-4" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function UsageTrendTable({
  data,
  metric,
  billingApplicable,
}: {
  data: DailyUsagePoint[];
  metric: UsageTrendMetric;
  billingApplicable: boolean;
}) {
  return (
    <div className="max-h-[28rem] max-w-full overflow-auto rounded-lg border border-border">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <caption className="sr-only">
          {metric === 'tokens'
            ? '每日 Token 分类数据'
            : metric === 'cost'
              ? '每日模型估算费用数据'
              : '每日智能体运行次数数据'}
        </caption>
        <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-3 text-left font-medium">日期</th>
            {metric === 'tokens' && (
              <>
                <th className="px-3 py-3 text-right font-medium">普通输入</th>
                <th className="px-3 py-3 text-right font-medium">缓存读取</th>
                <th className="px-3 py-3 text-right font-medium">缓存写入</th>
                <th className="px-3 py-3 text-right font-medium">输出</th>
                <th className="px-3 py-3 text-right font-medium">推理</th>
                <th className="px-3 py-3 text-right font-medium">合计</th>
              </>
            )}
            {metric === 'cost' && (
              <>
                <th className="px-3 py-3 text-right font-medium">
                  模型估算费用
                </th>
                <th className="px-3 py-3 text-right font-medium">账单扣费</th>
              </>
            )}
            {metric === 'runs' && (
              <>
                <th className="px-3 py-3 text-right font-medium">
                  智能体运行次数
                </th>
                <th className="px-3 py-3 text-right font-medium">
                  模型调用次数
                </th>
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.map((row) => (
            <tr key={row.date} className="hover:bg-muted/30">
              <td className="whitespace-nowrap px-3 py-3 text-foreground">
                {row.date}
              </td>
              {metric === 'tokens' && (
                <>
                  <NumberCell value={formatTokens(row.inputTokens)} />
                  <NumberCell value={formatTokens(row.cacheReadTokens)} />
                  <NumberCell value={formatTokens(row.cacheCreationTokens)} />
                  <NumberCell value={formatTokens(row.outputTokens)} />
                  <NumberCell value={formatTokens(row.reasoningTokens)} />
                  <NumberCell value={formatTokens(row.totalTokens)} strong />
                </>
              )}
              {metric === 'cost' && (
                <>
                  <NumberCell
                    value={formatCost(row.providerEstimatedCostUSD)}
                    strong
                  />
                  <NumberCell
                    value={
                      !billingApplicable
                        ? '不适用'
                        : row.billedCostUSD === null
                          ? '—'
                          : formatCost(row.billedCostUSD)
                    }
                  />
                </>
              )}
              {metric === 'runs' && (
                <>
                  <NumberCell value={formatInteger(row.runCount)} strong />
                  <NumberCell value={formatInteger(row.modelCallCount)} />
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NumberCell({ value, strong }: { value: string; strong?: boolean }) {
  return (
    <td
      className={`whitespace-nowrap px-3 py-3 text-right ${
        strong ? 'font-medium text-foreground' : 'text-muted-foreground'
      }`}
    >
      {value}
    </td>
  );
}

function AttributionTable({
  rows,
  dimension,
  totalCost,
}: {
  rows: AttributionRow[];
  dimension: AttributionDimension;
  totalCost: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
        当前范围没有可归因的数据
      </p>
    );
  }
  return (
    <div className="max-w-full overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <caption className="sr-only">
          按{DIMENSION_LABELS[dimension]}汇总的用量归因表
        </caption>
        <thead className="bg-muted text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-3 text-left font-medium">
              {DIMENSION_LABELS[dimension]}
            </th>
            <th className="px-3 py-3 text-right font-medium">总 Token</th>
            <th className="px-3 py-3 text-right font-medium">智能体运行次数</th>
            <th className="px-3 py-3 text-right font-medium">模型调用次数</th>
            <th className="px-3 py-3 text-right font-medium">模型估算费用</th>
            <th className="px-3 py-3 text-right font-medium">费用占比</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.key} className="hover:bg-muted/30">
              <td className="max-w-[20rem] break-all px-3 py-3 font-medium text-foreground">
                {row.label}
              </td>
              <NumberCell value={formatTokens(row.tokens)} />
              <NumberCell value={formatInteger(row.runCount)} />
              <NumberCell value={formatInteger(row.modelCallCount)} />
              <NumberCell value={formatCost(row.estimatedCost)} strong />
              <NumberCell
                value={
                  totalCost > 0
                    ? `${((row.estimatedCost / totalCost) * 100).toFixed(1)}%`
                    : '0.0%'
                }
              />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageLoadingState() {
  return (
    <div className="space-y-6" aria-label="正在加载用量数据" aria-live="polite">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-border md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-3 border-r border-border p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-4">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-72 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

function UsageEmptyState({
  filtered,
  onClear,
}: {
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <section className="rounded-xl border border-dashed border-border px-5 py-12 text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Zap className="size-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold text-foreground">
        {filtered ? '当前筛选没有用量数据' : '还没有智能体用量数据'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {filtered
          ? '尝试扩大时间范围或清除筛选，即可继续查看成本和 Token 趋势。'
          : '完成一次 AI 对话或智能体任务后，这里会展示运行次数、Token 构成和模型成本估算。'}
      </p>
      <div className="mt-5 flex justify-center">
        {filtered ? (
          <Button size="lg" className="min-h-11" onClick={onClear}>
            清除筛选
          </Button>
        ) : (
          <Button asChild size="lg" className="min-h-11">
            <Link to="/chat">开始一次对话</Link>
          </Button>
        )}
      </div>
    </section>
  );
}
