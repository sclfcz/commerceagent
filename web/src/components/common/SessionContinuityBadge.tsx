import type { ProviderSessionContinuity } from '../../types';

/**
 * 会话续接状态标签。
 *
 * `verified` 表示该上游通过了“自己续接自己”的基线实测；`failed` 表示实测
 * 未通过，不能作为智能体的模型配置；`unverified` 表示没有与当前上游指纹
 * 匹配的实测结果（从未验证，或地址/模型在验证后被修改）。
 */
export function SessionContinuityBadge({
  continuity,
  className = '',
}: {
  continuity?: ProviderSessionContinuity | null;
  className?: string;
}) {
  const status = continuity?.status ?? 'unverified';
  const checkedAt = continuity?.checkedAt
    ? new Date(continuity.checkedAt).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : null;
  const partners = continuity?.bidirectionalProviderIds?.length ?? 0;

  const presentation =
    status === 'verified'
      ? {
          label: '已验证续接',
          color:
            'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800',
          title: [
            '该上游可以接续自己产生的会话',
            checkedAt && `最近检查：${checkedAt}`,
            partners > 0 && `可与 ${partners} 个上游双向切换`,
          ]
            .filter(Boolean)
            .join(' · '),
        }
      : status === 'failed'
        ? {
            label: '不可续接',
            color:
              'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 border-red-200 dark:border-red-800',
            title: [
              '该上游未能接续自己产生的会话，不能作为智能体的模型配置',
              checkedAt && `最近检查：${checkedAt}`,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : {
            label: '续接未验证',
            color:
              'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800',
            title:
              '尚未通过续接验证：切换到其他模型配置时会话将以新会话继续。在服务器上运行 npm run probe:session-continuity 完成验证。',
          };

  return (
    <span
      className={`text-[11px] px-1.5 py-0.5 rounded border ${presentation.color} ${className}`.trim()}
      title={presentation.title}
      data-continuity-status={status}
    >
      {presentation.label}
    </span>
  );
}
