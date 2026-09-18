import {
  ArrowRight,
  Link2,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Workflow,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AgentProfile, AgentProfileGovernance } from '@/types';

export function AgentGovernanceSection({
  selected,
  profiles,
  governance,
  busy,
  error,
  workspaceMoveTargets,
  movingWorkspaceJid,
  onRefresh,
  onMoveTargetChange,
  onMoveWorkspace,
}: {
  selected: AgentProfile;
  profiles: AgentProfile[];
  governance?: AgentProfileGovernance;
  busy: boolean;
  error?: string;
  workspaceMoveTargets: Record<string, string>;
  movingWorkspaceJid: string | null;
  onRefresh: () => void;
  onMoveTargetChange: (workspaceJid: string, targetProfileId: string) => void;
  onMoveWorkspace: (workspaceJid: string, targetProfileId: string) => void;
}) {
  const runtimeSessionCount =
    governance?.workspaces.reduce(
      (sum, workspace) => sum + workspace.runtime_sessions.length,
      0,
    ) ?? 0;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">运行归属</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            工作区、运行态会话和渠道绑定的当前归属
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={busy}>
          <RefreshCw className={busy ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          刷新
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryItem
          icon={Workflow}
          label="工作区"
          value={governance?.workspaces.length ?? 0}
        />
        <SummaryItem
          icon={MessagesSquare}
          label="运行态会话"
          value={runtimeSessionCount}
        />
        <SummaryItem
          icon={Link2}
          label="渠道绑定"
          value={governance?.channel_mounts.length ?? 0}
        />
      </div>

      {error && !governance ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-error/30 bg-error-bg px-3 py-3 text-sm text-error"
          role="alert"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            重试
          </Button>
        </div>
      ) : busy && !governance ? (
        <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              工作区与运行态会话
            </div>
            <div className="max-h-64 overflow-auto rounded-md border">
              {(governance?.workspaces.length ?? 0) === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  {selected.is_default
                    ? '暂无工作区'
                    : '尚未绑定工作区。该智能体当前没有 Session 或 Memory；请显式为它新建工作区，或迁移一个非 Home 工作区。'}
                </div>
              ) : (
                governance?.workspaces.map((workspace) => (
                  <div
                    key={workspace.jid}
                    className="border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {workspace.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {workspace.folder}
                        </div>
                      </div>
                      <Badge variant="secondary">
                        {workspace.runtime_sessions.length} 个运行态会话
                      </Badge>
                    </div>
                    {workspace.runtime_sessions.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {workspace.runtime_sessions.map((session) => (
                          <div
                            key={`${workspace.jid}:${session.runtime_agent_id || 'main'}`}
                            className="truncate text-xs text-muted-foreground"
                          >
                            {session.runtime_agent_id || 'main'} ·{' '}
                            {session.sdk_session_id || '-'}
                          </div>
                        ))}
                      </div>
                    )}
                    {workspace.is_home ? (
                      <div className="mt-2">
                        <Badge variant="outline">
                          Home · 固定归属 CommerceAgent
                        </Badge>
                      </div>
                    ) : (
                      <div className="mt-2 flex items-center gap-2">
                        <Select
                          value={workspaceMoveTargets[workspace.jid] || ''}
                          onValueChange={(value) =>
                            onMoveTargetChange(workspace.jid, value)
                          }
                        >
                          <SelectTrigger
                            className="h-8 min-w-0 flex-1 text-xs"
                            aria-label={`迁移工作区 ${workspace.name}`}
                          >
                            <SelectValue placeholder="迁移到其他智能体" />
                          </SelectTrigger>
                          <SelectContent>
                            {profiles
                              .filter((profile) => profile.id !== selected.id)
                              .map((profile) => (
                                <SelectItem key={profile.id} value={profile.id}>
                                  {profile.is_default
                                    ? '主智能体'
                                    : profile.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8"
                          disabled={
                            movingWorkspaceJid === workspace.jid ||
                            !workspaceMoveTargets[workspace.jid]
                          }
                          onClick={() =>
                            onMoveWorkspace(
                              workspace.jid,
                              workspaceMoveTargets[workspace.jid],
                            )
                          }
                        >
                          {movingWorkspaceJid === workspace.jid ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                          )}
                          迁移
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">
              渠道绑定
            </div>
            <div className="max-h-64 overflow-auto rounded-md border">
              {(governance?.channel_mounts.length ?? 0) === 0 ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">
                  暂无渠道绑定
                </div>
              ) : (
                governance?.channel_mounts.map((mount) => (
                  <div
                    key={mount.channel_jid}
                    className="border-b px-3 py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {mount.channel_jid}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {mount.workspace_folder || mount.workspace_jid}
                        </div>
                      </div>
                      <Badge variant="outline">{mount.channel_type}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>
                        {mount.session_id
                          ? `session ${mount.session_id}`
                          : 'main'}
                      </span>
                      <span>{mount.routing_mode}</span>
                      <span>{mount.reply_policy}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Workflow;
  label: string;
  value: number;
}) {
  return (
    <div className="min-w-0 rounded-md bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
    </div>
  );
}
