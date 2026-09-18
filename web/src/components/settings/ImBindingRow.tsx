import {
  Loader2,
  MessageSquare,
  Users,
  ArrowRightLeft,
  RotateCcw,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AvailableImGroup } from '../../types';
import { ChannelAccountBadge, ChannelBadge } from './channel-meta';
import {
  ACTIVATION_MODE_OPTIONS,
  AUDIENCE_MODE_OPTIONS,
} from '../../constants/im';
import { getImChannelCapabilities } from '../../constants/im-capabilities';

interface ImBindingRowProps {
  group: AvailableImGroup;
  isActioning: boolean;
  onRebind: (group: AvailableImGroup) => void;
  onUnbind: (group: AvailableImGroup) => void;
  onResetAllowlist: (group: AvailableImGroup) => void;
  onActivationModeChange: (jid: string, mode: string) => void;
  onAudienceModeChange: (jid: string, mode: 'everyone' | 'owner_only') => void;
  onDelete: (group: AvailableImGroup) => void;
}

export function ImBindingRow({
  group,
  isActioning,
  onRebind,
  onUnbind,
  onResetAllowlist,
  onActivationModeChange,
  onAudienceModeChange,
  onDelete,
}: ImBindingRowProps) {
  const boundSessionId = group.bound_session_id ?? group.bound_agent_id;
  const boundWorkspaceJid = group.bound_workspace_jid ?? group.bound_main_jid;
  const hasBound = !!boundSessionId || !!boundWorkspaceJid;
  const isLegacyGroupSessionBinding =
    !!boundSessionId && group.conversation_kind !== 'direct';
  const supportsActivation =
    group.conversation_kind === 'group' &&
    !isLegacyGroupSessionBinding &&
    getImChannelCapabilities(group.channel_type)?.supports_activation_modes ===
      true;
  const supportsOwnerMention =
    getImChannelCapabilities(group.channel_type)?.supports_owner_mention ===
    true;
  const activationModeOptions = ACTIVATION_MODE_OPTIONS.filter(
    (option) =>
      (option.value !== 'owner_mentioned' || supportsOwnerMention) &&
      !(group.channel_type === 'feishu' && option.value === 'owner_mentioned'),
  );
  // Empty array = "owner-locked trap": bot was added before Feishu owner DM'd it,
  // so nobody (not even the owner) can trigger the bot until allowlist is reset
  // or owner sends a DM (which auto-backfills via learnFeishuOwner).
  const isAllowlistLocked =
    group.channel_type === 'feishu' && group.sender_allowlist_locked === true;

  const bindingLabel = (): string => {
    if (boundSessionId && group.bound_target_name) {
      const target =
        group.bound_workspace_name &&
        group.bound_workspace_name !== group.bound_target_name
          ? `${group.bound_workspace_name} / ${group.bound_target_name}`
          : group.bound_target_name;
      return group.conversation_kind === 'direct'
        ? `会话 · ${target}`
        : `异常会话绑定 · ${target}`;
    }
    if (boundWorkspaceJid && group.bound_target_name) {
      return group.conversation_kind === 'direct'
        ? `主会话 · ${group.bound_target_name}`
        : `工作区 · ${group.bound_target_name}`;
    }
    return '未绑定';
  };

  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border p-3 transition-colors sm:flex-row sm:items-center ${
        isAllowlistLocked
          ? 'border-amber-300 bg-amber-50/50 dark:border-amber-700/40 dark:bg-amber-900/10'
          : hasBound
            ? 'border-brand-200 bg-brand-50/50 dark:border-brand-700/30 dark:bg-brand-700/10'
            : 'border-border'
      }`}
    >
      <div className="flex w-full min-w-0 items-center gap-3 sm:flex-1">
        {/* Avatar */}
        {group.avatar ? (
          <img
            src={group.avatar}
            alt=""
            className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-muted flex items-center justify-center">
            <MessageSquare className="w-5 h-5 text-muted-foreground" />
          </div>
        )}

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{group.name}</span>
            <ChannelBadge channelType={group.channel_type} />
            <ChannelAccountBadge
              accountId={group.channel_account_id}
              accountName={group.channel_account_name}
            />
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
            <span>
              {group.conversation_kind === 'direct'
                ? '私聊'
                : group.conversation_kind === 'group'
                  ? '群聊'
                  : '类型待确认'}
            </span>
            {group.member_count != null && (
              <span className="flex items-center gap-0.5">
                <Users className="w-3 h-3" />
                {group.member_count}
              </span>
            )}
            <span
              className={
                hasBound
                  ? 'text-primary dark:text-brand-400'
                  : 'text-muted-foreground'
              }
            >
              → {bindingLabel()}
            </span>
          </div>
          {isAllowlistLocked && (
            <div className="flex items-start gap-1 mt-1 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
              <span>
                发言者白名单为空，bot 无法响应任何人。请向 bot
                发条私聊以认领群聊，或点击右侧「重置」清空白名单。
              </span>
            </div>
          )}
          {isLegacyGroupSessionBinding && (
            <div className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <span>历史绑定需要迁移：群聊只能绑定工作区。</span>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex w-full flex-shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border/60 pt-2 sm:w-auto sm:flex-nowrap sm:border-0 sm:pt-0">
        {isAllowlistLocked && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onResetAllowlist(group)}
            disabled={isActioning}
            className="text-amber-700 border-amber-300 hover:bg-amber-100 dark:text-amber-400 dark:border-amber-700 dark:hover:bg-amber-900/30"
          >
            {isActioning ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <AlertTriangle className="w-3 h-3 mr-1" />
            )}
            解除限制
          </Button>
        )}
        {supportsActivation && (
          <div className="flex items-center gap-1.5">
            <select
              value={
                group.channel_type === 'feishu' &&
                group.activation_mode === 'owner_mentioned'
                  ? 'when_mentioned'
                  : group.activation_mode || 'auto'
              }
              onChange={(e) =>
                onActivationModeChange(group.jid, e.target.value)
              }
              disabled={isActioning}
              aria-label={`${group.name} 的消息响应方式`}
              title="消息响应方式"
              className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground disabled:opacity-50"
            >
              {activationModeOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value === 'auto'
                    ? `${o.label}（当前：${group.require_mention ? '仅 @机器人' : '所有允许成员'}）`
                    : o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {group.channel_type === 'feishu' &&
          group.conversation_kind === 'group' &&
          !isLegacyGroupSessionBinding && (
            <select
              value={
                group.audience_mode === 'owner_only' ||
                group.activation_mode === 'owner_mentioned'
                  ? 'owner_only'
                  : 'everyone'
              }
              onChange={(e) =>
                onAudienceModeChange(
                  group.jid,
                  e.target.value as 'everyone' | 'owner_only',
                )
              }
              disabled={isActioning}
              aria-label={`${group.name} 的响应对象`}
              title="响应对象"
              className="text-xs px-1.5 py-1 rounded border border-border bg-background text-foreground disabled:opacity-50"
            >
              {AUDIENCE_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        {hasBound && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUnbind(group)}
            disabled={isActioning}
            className="text-muted-foreground hover:text-foreground"
            title="恢复账号默认工作区"
          >
            {isActioning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RotateCcw className="w-3.5 h-3.5" />
            )}
            <span className="sr-only">恢复账号默认工作区</span>
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRebind(group)}
          disabled={isActioning}
        >
          {isActioning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ArrowRightLeft className="w-3 h-3 mr-1" />
          )}
          {hasBound ? '换绑' : '绑定'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onDelete(group)}
          disabled={isActioning}
          className="text-muted-foreground hover:text-error"
          title="删除（群已不存在/bot 已被踢时使用）"
        >
          {isActioning ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}
