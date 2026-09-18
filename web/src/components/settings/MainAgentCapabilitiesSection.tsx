import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '../../api/client';
import { useAgentProfilesStore } from '../../stores/agent-profiles';
import { useMcpServersStore } from '../../stores/mcp-servers';
import { useSkillsStore } from '../../stores/skills';
import type { AgentEffortLevel, AgentProfileRuntimePolicy } from '../../types';
import {
  buildMcpPolicyOptions,
  normalizeMcpPolicyReferences,
} from '../../utils/mcp-servers';
import { PolicyResourcePicker } from '../agents/PolicyResourcePicker';
import { AgentSkillsPolicyEditor } from '../agents/AgentSkillsPolicyEditor';
import { EffectiveCapabilitiesPreview } from '../agents/EffectiveCapabilitiesPreview';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  getHostSkillPolicy,
  skillSelectionError,
} from '../../utils/agent-runtime-policy';

type CapabilityMode = 'inherit' | 'custom' | 'disabled';

const AGENT_EFFORT_OPTIONS: Array<{
  value: AgentEffortLevel;
  label: string;
}> = [
  { value: 'inherit', label: '跟随模型配置' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' },
];

export function MainAgentCapabilitiesSection() {
  const profiles = useAgentProfilesStore((state) => state.profiles);
  const modelConfigs = useAgentProfilesStore(
    (state) => state.modelConfigs ?? [],
  );
  const defaultModelConfigId = useAgentProfilesStore(
    (state) => state.defaultModelConfigId ?? null,
  );
  const profilesLoading = useAgentProfilesStore((state) => state.loading);
  const loadProfiles = useAgentProfilesStore((state) => state.loadProfiles);
  const governance = useAgentProfilesStore((state) =>
    profileKey(state.profiles, state.governanceByProfile),
  );
  const loadProfileGovernance = useAgentProfilesStore(
    (state) => state.loadProfileGovernance,
  );
  const skills = useSkillsStore((state) => state.skills);
  const skillsLoading = useSkillsStore((state) => state.loading);
  const skillsError = useSkillsStore((state) => state.error);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const mcpServers = useMcpServersStore((state) => state.servers);
  const mcpLoading = useMcpServersStore((state) => state.loading);
  const mcpError = useMcpServersStore((state) => state.error);
  const loadMcpServers = useMcpServersStore((state) => state.loadServers);
  const profile = profiles.find((item) => item.is_default);

  const [skillsMode, setSkillsMode] = useState<CapabilityMode>('inherit');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [hostSkillsMode, setHostSkillsMode] =
    useState<CapabilityMode>('disabled');
  const [hostSkillIds, setHostSkillIds] = useState<string[]>([]);
  const [mcpMode, setMcpMode] = useState<CapabilityMode>('inherit');
  const [mcpIds, setMcpIds] = useState<string[]>([]);
  const [modelConfigId, setModelConfigId] = useState('inherit');
  const [effort, setEffort] = useState<AgentEffortLevel>('inherit');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void Promise.all([loadProfiles(), loadSkills(), loadMcpServers()]);
  }, [loadMcpServers, loadProfiles, loadSkills]);

  useEffect(() => {
    if (!profile) return;
    setSkillsMode(profile.runtime_policy.skills.mode);
    setSkillIds(profile.runtime_policy.skills.ids);
    const hostPolicy = getHostSkillPolicy(profile.runtime_policy);
    setHostSkillsMode(hostPolicy.mode);
    setHostSkillIds(hostPolicy.ids);
    setMcpMode(profile.runtime_policy.mcp.mode);
    setMcpIds(normalizeMcpPolicyReferences(profile.runtime_policy.mcp.ids));
    setModelConfigId(profile.model_config_id ?? 'inherit');
    setEffort(profile.runtime_policy.reasoning?.effort ?? 'inherit');
  }, [profile?.id, profile?.updated_at]);

  useEffect(() => {
    if (!profile?.id) return;
    void loadProfileGovernance(profile.id).catch(() => undefined);
  }, [loadProfileGovernance, profile?.id]);

  const skillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'user' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
      }));
    const known = new Set(available.map((item) => item.id));
    return [
      ...available,
      ...skillIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [skillIds, skills]);

  const hostSkillOptions = useMemo(() => {
    const available = skills
      .filter((skill) => skill.source === 'external' && skill.enabled)
      .map((skill) => ({
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description,
        sourceLabel: '宿主机',
      }));
    const known = new Set(available.map((item) => item.id));
    return [
      ...available,
      ...hostSkillIds
        .filter((id) => !known.has(id))
        .map((id) => ({
          id,
          name: id,
          sourceLabel: '宿主机',
          unavailable: true,
        })),
    ];
  }, [hostSkillIds, skills]);

  const mcpOptions = useMemo(() => {
    const available = buildMcpPolicyOptions(mcpServers);
    const known = new Set(available.map((item) => item.id));
    return [
      ...available,
      ...mcpIds
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: id, unavailable: true })),
    ];
  }, [mcpIds, mcpServers]);

  const persistedHostPolicy = profile
    ? getHostSkillPolicy(profile.runtime_policy)
    : null;
  const managedSkillsError = skillSelectionError(' CommerceAgent Skill', {
    mode: skillsMode,
    ids: skillIds,
  });
  const hostSkillsError = skillSelectionError('宿主机 Skill', {
    mode: hostSkillsMode,
    ids: hostSkillIds,
  });
  const capabilityError = managedSkillsError ?? hostSkillsError;

  const dirty =
    !!profile &&
    ((modelConfigId === 'inherit' ? null : modelConfigId) !==
      profile.model_config_id ||
      effort !== (profile.runtime_policy.reasoning?.effort ?? 'inherit') ||
      skillsMode !== profile.runtime_policy.skills.mode ||
      JSON.stringify(skillIds) !==
        JSON.stringify(profile.runtime_policy.skills.ids) ||
      hostSkillsMode !== persistedHostPolicy?.mode ||
      JSON.stringify(hostSkillIds) !==
        JSON.stringify(persistedHostPolicy?.ids ?? []) ||
      mcpMode !== profile.runtime_policy.mcp.mode ||
      JSON.stringify(mcpIds) !==
        JSON.stringify(
          normalizeMcpPolicyReferences(profile.runtime_policy.mcp.ids),
        ));

  const currentRuntimePolicy = useMemo<AgentProfileRuntimePolicy | null>(
    () =>
      profile
        ? {
            ...profile.runtime_policy,
            reasoning: { effort },
            skills: {
              mode: skillsMode,
              ids: skillIds,
              host: { mode: hostSkillsMode, ids: hostSkillIds },
            },
            mcp: { mode: mcpMode, ids: mcpIds },
          }
        : null,
    [
      effort,
      hostSkillIds,
      hostSkillsMode,
      mcpIds,
      mcpMode,
      profile,
      skillIds,
      skillsMode,
    ],
  );

  const save = async () => {
    if (!profile || !dirty || capabilityError) return;
    setSaving(true);
    try {
      await api.patch(`/api/agent-profiles/${encodeURIComponent(profile.id)}`, {
        model_config_id: modelConfigId === 'inherit' ? null : modelConfigId,
        runtime_policy: {
          reasoning: { effort },
          skills: {
            mode: skillsMode,
            ids: skillIds,
            host: { mode: hostSkillsMode, ids: hostSkillIds },
          },
          mcp: { mode: mcpMode, ids: mcpIds },
        } satisfies Partial<AgentProfileRuntimePolicy>,
      });
      await loadProfiles();
      toast.success('主 CommerceAgent 模型、推理档位与能力已保存');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存能力失败');
    } finally {
      setSaving(false);
    }
  };

  if (profilesLoading && !profile) {
    return (
      <div className="flex min-h-28 items-center justify-center border-b border-border py-6">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="border-b border-border py-6 text-sm text-destructive">
        无法读取当前管理员的主 CommerceAgent 配置。
      </div>
    );
  }

  return (
    <section className="space-y-5 border-b border-border py-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground">
          模型与系统附加能力
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          为主智能体选择完整模型网关环境，并按来源控制 Skills 与 CommerceAgent
          附加的 MCP。宿主机 Skills 可独立于宿主机 Prompt 与 Rules 启用。
        </p>
      </div>

      <div className="max-w-xl space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          模型配置
        </label>
        <Select value={modelConfigId} onValueChange={setModelConfigId}>
          <SelectTrigger aria-label="主 CommerceAgent 模型配置">
            <SelectValue placeholder="选择模型配置" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              跟随系统默认
              {defaultModelConfigId
                ? `（${modelConfigs.find((item) => item.id === defaultModelConfigId)?.name ?? '当前默认'}）`
                : '（尚未配置）'}
            </SelectItem>
            {modelConfigs.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name}
                {model.anthropic_model ? ` · ${model.anthropic_model}` : ''}
                {!model.enabled ? '（仅显式使用）' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-5 text-muted-foreground">
          Home
          工作区、主会话、独立会话与定时任务都会继承该选择。未启用的配置仍可在这里显式使用。
        </p>
      </div>

      <div className="max-w-xl space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          推理努力档位
        </label>
        <Select
          value={effort}
          onValueChange={(next) => setEffort(next as AgentEffortLevel)}
        >
          <SelectTrigger aria-label="主 CommerceAgent 推理努力档位">
            <SelectValue placeholder="选择推理努力档位" />
          </SelectTrigger>
          <SelectContent>
            {AGENT_EFFORT_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-5 text-muted-foreground">
          跟随模型配置时保留 Provider 环境或 SDK
          默认值；显式档位会覆盖该默认值。
        </p>
      </div>

      <AgentSkillsPolicyEditor
        managedPolicy={{ mode: skillsMode, ids: skillIds }}
        onManagedModeChange={setSkillsMode}
        onManagedIdsChange={setSkillIds}
        managedOptions={skillOptions}
        hostPolicy={{ mode: hostSkillsMode, ids: hostSkillIds }}
        onHostModeChange={setHostSkillsMode}
        onHostIdsChange={setHostSkillIds}
        hostOptions={hostSkillOptions}
        loading={skillsLoading}
        error={skillsError}
        hostAvailable
        managedError={managedSkillsError}
        hostError={hostSkillsError}
      />

      <div className="max-w-xl border-t border-border pt-5">
        <CapabilityPicker
          label="CommerceAgent MCP"
          value={mcpMode}
          onValueChange={setMcpMode}
          customLabel="只允许所选 MCP"
          disabledLabel="关闭 CommerceAgent MCP"
        >
          {mcpMode === 'custom' && (
            <PolicyResourcePicker
              label="允许目录"
              options={mcpOptions}
              selectedIds={mcpIds}
              onChange={setMcpIds}
              loading={mcpLoading}
              error={mcpError}
              emptyText="没有已启用的 CommerceAgent MCP"
            />
          )}
        </CapabilityPicker>
      </div>

      <div className="flex justify-end">
        <Button
          onClick={() => void save()}
          disabled={!dirty || saving || !!capabilityError}
          className="min-h-11"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存模型与能力
        </Button>
      </div>
      {currentRuntimePolicy && (
        <ErrorBoundary resetKeys={[profile.id]}>
          <EffectiveCapabilitiesPreview
            profileId={profile.id}
            runtimePolicy={currentRuntimePolicy}
            workspaces={governance?.workspaces ?? []}
          />
        </ErrorBoundary>
      )}
    </section>
  );
}

function profileKey(
  profiles: ReturnType<typeof useAgentProfilesStore.getState>['profiles'],
  governanceByProfile: ReturnType<
    typeof useAgentProfilesStore.getState
  >['governanceByProfile'],
) {
  const profile = profiles.find((item) => item.is_default);
  return profile ? governanceByProfile[profile.id] : undefined;
}

function CapabilityPicker({
  label,
  value,
  onValueChange,
  customLabel,
  disabledLabel,
  children,
}: {
  label: string;
  value: CapabilityMode;
  onValueChange: (mode: CapabilityMode) => void;
  customLabel: string;
  disabledLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select
        value={value}
        onValueChange={(next) => onValueChange(next as CapabilityMode)}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">使用全部已启用项</SelectItem>
          <SelectItem value="custom">{customLabel}</SelectItem>
          <SelectItem value="disabled">{disabledLabel}</SelectItem>
        </SelectContent>
      </Select>
      {children}
    </div>
  );
}
