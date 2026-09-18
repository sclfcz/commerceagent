import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatTokens } from '../billing/utils';

export type UsageTrendMetric = 'tokens' | 'cost' | 'runs';

export interface DailyUsagePoint {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerEstimatedCostUSD: number;
  billedCostUSD: number | null;
  runCount: number;
  modelCallCount: number;
}

const TOKEN_LABELS: Record<string, string> = {
  inputTokens: '普通输入',
  cacheReadTokens: '缓存读取',
  cacheCreationTokens: '缓存写入',
  outputTokens: '输出',
  reasoningTokens: '推理',
};

function formatCost(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return '$0.00';
}

export function UsageTrendChart({
  data,
  metric,
}: {
  data: DailyUsagePoint[];
  metric: UsageTrendMetric;
}) {
  const valueFormatter = (value: number) => {
    if (metric === 'tokens') return formatTokens(value);
    if (metric === 'cost') return formatCost(value);
    return new Intl.NumberFormat('zh-CN').format(value);
  };

  return (
    <div
      className="h-72 min-w-0 lg:h-80"
      role="img"
      aria-label={
        metric === 'tokens'
          ? '每日 Token 趋势图，按普通输入、缓存读取、缓存写入、输出和推理堆叠展示'
          : metric === 'cost'
            ? '每日模型估算费用趋势图'
            : '每日智能体运行次数趋势图'
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
          accessibilityLayer
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            vertical={false}
          />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickFormatter={(value: string) => value.slice(5)}
            minTickGap={18}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            width={62}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickFormatter={(value) => valueFormatter(Number(value))}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.45 }}
            contentStyle={{
              backgroundColor: 'var(--popover)',
              border: '1px solid var(--border)',
              borderRadius: '10px',
              color: 'var(--popover-foreground)',
            }}
            formatter={(value, name) => [
              valueFormatter(Number(value) || 0),
              metric === 'tokens'
                ? TOKEN_LABELS[String(name)] || String(name)
                : metric === 'cost'
                  ? '模型估算费用'
                  : '智能体运行次数',
            ]}
            labelFormatter={(label) => `日期：${label}`}
          />
          {metric === 'tokens' && (
            <>
              <Legend
                iconType="circle"
                iconSize={8}
                formatter={(value) => TOKEN_LABELS[value] || value}
                wrapperStyle={{ fontSize: 12 }}
              />
              <Bar
                dataKey="inputTokens"
                stackId="tokens"
                fill="var(--chart-1)"
              />
              <Bar
                dataKey="cacheReadTokens"
                stackId="tokens"
                fill="var(--chart-2)"
              />
              <Bar
                dataKey="cacheCreationTokens"
                stackId="tokens"
                fill="var(--chart-3)"
              />
              <Bar
                dataKey="outputTokens"
                stackId="tokens"
                fill="var(--chart-4)"
              />
              <Bar
                dataKey="reasoningTokens"
                stackId="tokens"
                fill="var(--chart-5)"
                radius={[3, 3, 0, 0]}
              />
            </>
          )}
          {metric === 'cost' && (
            <Bar
              dataKey="providerEstimatedCostUSD"
              fill="var(--color-primary)"
              radius={[4, 4, 0, 0]}
            />
          )}
          {metric === 'runs' && (
            <Bar
              dataKey="runCount"
              fill="var(--color-primary)"
              radius={[4, 4, 0, 0]}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
