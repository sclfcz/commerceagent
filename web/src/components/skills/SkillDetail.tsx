import { useCallback, useEffect, useRef, useState } from 'react';
import {
  File,
  Folder,
  Loader2,
  Lock,
  Trash2,
  RefreshCw,
  Package,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  useSkillsStore,
  type SkillDetail as SkillDetailType,
} from '../../stores/skills';
import {
  createLatestRequestGate,
  isSelectionCurrent,
  type LatestRequestTicket,
} from '../../utils/latest-request';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface SkillDetailProps {
  skillId: string | null;
  onDeleted?: () => void;
}

export function SkillDetail({ skillId, onDeleted }: SkillDetailProps) {
  const [detailState, setDetailState] = useState<{
    sourceKey: string | null;
    detail: SkillDetailType | null;
    loading: boolean;
    error: string | null;
  }>({ sourceKey: null, detail: null, loading: false, error: null });
  const [pendingActions, setPendingActions] = useState<
    Record<string, 'delete' | 'reinstall'>
  >({});
  const requestGateRef = useRef(createLatestRequestGate());
  const currentSkillIdRef = useRef(skillId);
  currentSkillIdRef.current = skillId;
  const getSkillDetail = useSkillsStore((state) => state.getSkillDetail);
  const deleteSkill = useSkillsStore((state) => state.deleteSkill);
  const reinstallSkill = useSkillsStore((state) => state.reinstallSkill);

  const loadDetail = useCallback(
    (sourceKey: string): LatestRequestTicket => {
      const ticket = requestGateRef.current.begin(sourceKey);
      setDetailState({
        sourceKey,
        detail: null,
        loading: true,
        error: null,
      });
      void getSkillDetail(sourceKey).then(
        (detail) => {
          if (
            !requestGateRef.current.isCurrent(ticket, currentSkillIdRef.current)
          ) {
            return;
          }
          setDetailState({
            sourceKey,
            detail,
            loading: false,
            error: null,
          });
        },
        (error: unknown) => {
          if (
            !requestGateRef.current.isCurrent(ticket, currentSkillIdRef.current)
          ) {
            return;
          }
          setDetailState({
            sourceKey,
            detail: null,
            loading: false,
            error: error instanceof Error ? error.message : '加载失败',
          });
        },
      );
      return ticket;
    },
    [getSkillDetail],
  );

  useEffect(() => {
    if (!skillId) {
      requestGateRef.current.invalidate();
      setDetailState({
        sourceKey: null,
        detail: null,
        loading: false,
        error: null,
      });
      return;
    }
    const ticket = loadDetail(skillId);
    return () => requestGateRef.current.cancel(ticket);
  }, [loadDetail, skillId]);

  const stateMatchesSelection = detailState.sourceKey === skillId;
  const detail = stateMatchesSelection ? detailState.detail : null;
  const loading = !stateMatchesSelection || detailState.loading;
  const error = stateMatchesSelection ? detailState.error : null;
  const deleting = !!skillId && pendingActions[skillId] === 'delete';
  const reinstalling = !!skillId && pendingActions[skillId] === 'reinstall';

  const setActionPending = (
    sourceKey: string,
    action: 'delete' | 'reinstall' | null,
  ) => {
    setPendingActions((current) => {
      if (action) return { ...current, [sourceKey]: action };
      if (!(sourceKey in current)) return current;
      const next = { ...current };
      delete next[sourceKey];
      return next;
    });
  };

  if (!skillId) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-muted-foreground text-center">
            选择一个技能查看详情
          </p>
        </CardContent>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="animate-spin text-primary" size={32} />
        </CardContent>
      </Card>
    );
  }

  if (error || !detail) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-error text-center">{error || '加载失败'}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-foreground">
                {detail.name}
              </h2>
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  detail.source === 'user'
                    ? 'bg-brand-100 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {detail.source === 'user'
                  ? '我的 Skills'
                  : detail.source === 'external'
                    ? '宿主机'
                    : 'CommerceAgent 内置'}
              </span>
              {detail.userInvocable && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                  可调用
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {detail.description}
            </p>
          </div>

          {detail.source !== 'user' ? (
            <div
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title="此来源由系统或宿主机管理"
            >
              <Lock size={16} className="text-muted-foreground" />
              <Badge variant="outline">
                只读 · 由{detail.source === 'external' ? '宿主机' : '系统'}管理
              </Badge>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {detail.packageName && (
                <button
                  disabled={reinstalling || deleting}
                  onClick={async () => {
                    const actionSourceKey = skillId;
                    const actionDetail = detail;
                    if (
                      !actionSourceKey ||
                      detailState.sourceKey !== actionSourceKey ||
                      !confirm(`确认重新安装技能「${actionDetail.name}」？`)
                    ) {
                      return;
                    }
                    setActionPending(actionSourceKey, 'reinstall');
                    try {
                      await reinstallSkill(actionDetail.id);
                      if (
                        isSelectionCurrent(
                          actionSourceKey,
                          currentSkillIdRef.current,
                        )
                      ) {
                        loadDetail(actionSourceKey);
                      }
                    } catch {
                      // error handled by store
                    } finally {
                      setActionPending(actionSourceKey, null);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition-colors disabled:opacity-50"
                >
                  <RefreshCw
                    size={16}
                    className={reinstalling ? 'animate-spin' : ''}
                  />
                  {reinstalling ? '重装中...' : '重新安装'}
                </button>
              )}
              <button
                disabled={deleting || reinstalling}
                onClick={async () => {
                  const actionSourceKey = skillId;
                  const actionDetail = detail;
                  if (
                    !actionSourceKey ||
                    detailState.sourceKey !== actionSourceKey ||
                    !confirm(`确认删除技能「${actionDetail.name}」？`)
                  ) {
                    return;
                  }
                  setActionPending(actionSourceKey, 'delete');
                  try {
                    await deleteSkill(actionDetail.id);
                    if (
                      isSelectionCurrent(
                        actionSourceKey,
                        currentSkillIdRef.current,
                      )
                    ) {
                      onDeleted?.();
                    }
                  } catch {
                    // error is handled by the store
                  } finally {
                    setActionPending(actionSourceKey, null);
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-error hover:bg-error-bg transition-colors disabled:opacity-50"
              >
                <Trash2 size={16} />
                {deleting ? '删除中...' : '删除'}
              </button>
            </div>
          )}
        </div>

        {/* 元信息区域 */}
        <div className="space-y-2 text-sm">
          {detail.packageName && (
            <div className="flex items-center gap-1.5">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">来源：</span>
              <span className="text-foreground font-mono text-xs">
                {detail.packageName}
              </span>
            </div>
          )}
          {!detail.packageName && detail.sourceUrl && (
            <div className="flex items-center gap-1.5">
              <Package size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">导入来源：</span>
              <span className="text-foreground font-mono text-xs break-all">
                {detail.sourceUrl}
              </span>
            </div>
          )}
          {detail.installSource && (
            <div>
              <span className="text-muted-foreground">安装方式：</span>
              <span className="text-foreground ml-1">
                {detail.installSource === 'git'
                  ? 'Git'
                  : detail.installSource === 'zip'
                    ? 'ZIP'
                    : 'skills.sh'}
              </span>
            </div>
          )}
          {detail.version && (
            <div>
              <span className="text-muted-foreground">版本：</span>
              <span
                className="text-foreground ml-1 font-mono text-xs"
                title={detail.version}
              >
                {detail.version.slice(0, 12)}
              </span>
            </div>
          )}
          {detail.installedAt && (
            <div>
              <span className="text-muted-foreground">安装时间：</span>
              <span className="text-foreground ml-1">
                {new Date(detail.installedAt).toLocaleString('zh-CN')}
              </span>
            </div>
          )}
          {detail.allowedTools && detail.allowedTools.length > 0 && (
            <div>
              <span className="text-muted-foreground">允许工具：</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {detail.allowedTools.map((tool: string) => (
                  <span
                    key={tool}
                    className="px-2 py-0.5 bg-muted text-foreground rounded text-xs"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {detail.argumentHint && (
            <div>
              <span className="text-muted-foreground">参数提示：</span>
              <span className="text-foreground ml-2">
                {detail.argumentHint}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* SKILL.md 内容 */}
      <div className="p-6 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground mb-3">技能说明</h3>
        <div className="max-w-none">
          <MarkdownRenderer content={detail.content} variant="docs" />
        </div>
      </div>

      {/* 文件列表 */}
      {detail.files && detail.files.length > 0 && (
        <div className="p-6 border-b border-border">
          <h3 className="text-sm font-semibold text-foreground mb-3">
            文件列表
          </h3>
          <div className="space-y-1">
            {detail.files.map((file) => (
              <div
                key={file.name}
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                {file.type === 'directory' ? (
                  <Folder size={16} className="text-muted-foreground" />
                ) : (
                  <File size={16} className="text-muted-foreground" />
                )}
                <span>{file.name}</span>
                {file.type === 'file' && (
                  <span className="text-xs text-muted-foreground">
                    ({file.size} B)
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 底部操作区 */}
      <div className="p-6 bg-muted">
        <p className="text-sm text-muted-foreground">
          {detail.source === 'user'
            ? detail.packageName
              ? `通过 ${detail.packageName} 安装，可重新安装以获取最新版本`
              : '用户级技能可启用/禁用或删除，也可在对话中让 AI 安装或卸载技能'
            : detail.source === 'external'
              ? '宿主机技能为只读，来自 ~/.claude/skills/'
              : '项目级技能为只读，不可修改或删除'}
        </p>
      </div>
    </Card>
  );
}
