import type { GroupInfo } from '../types';
import type { GroupEntry } from './group-utils';

export interface AgentWorkspaceSection {
  id: string;
  name: string;
  version?: number;
  isDefault: boolean;
  items: GroupEntry[];
}

export function getAgentProfileDisplayName(name?: string | null): string {
  return !name || name === 'Default Agent' ? 'CommerceAgent' : name;
}

export function getCustomAgentProfiles<T extends { is_default: boolean }>(
  profiles: T[],
): T[] {
  return profiles.filter((profile) => !profile.is_default);
}

export function groupWorkspacesByAgent(
  groups: GroupEntry[],
  defaultAgentId?: string,
): AgentWorkspaceSection[] {
  const byAgent = new Map<string, AgentWorkspaceSection>();
  for (const group of groups) {
    const id = group.agent_profile_id || '__default__';
    const existing = byAgent.get(id) ?? {
      id,
      name: getAgentProfileDisplayName(group.agent_profile_name),
      version: group.agent_profile_version,
      isDefault: id === (defaultAgentId || '__default__'),
      items: [],
    };
    existing.items.push(group);
    if (!existing.version && group.agent_profile_version) {
      existing.version = group.agent_profile_version;
    }
    byAgent.set(id, existing);
  }

  return Array.from(byAgent.values())
    .map((section) => ({
      ...section,
      items: [...section.items].sort(
        (a, b) => Number(!!b.is_my_home) - Number(!!a.is_my_home),
      ),
    }))
    .sort((a, b) => {
      const defaultOrder = Number(b.isDefault) - Number(a.isDefault);
      return defaultOrder || a.name.localeCompare(b.name, 'zh-CN');
    });
}

export function getAgentNavigationTargets(section: AgentWorkspaceSection) {
  return {
    directGroup:
      section.items.find((item) => item.is_my_home) ?? section.items[0] ?? null,
    workspaces: section.items.filter((item) => !item.is_my_home),
  };
}

export function getPrimaryAgentWorkspaceRows(
  section: AgentWorkspaceSection,
): GroupEntry[] {
  const { directGroup, workspaces } = getAgentNavigationTargets(section);
  if (!directGroup) return workspaces;

  return [
    { ...directGroup, name: section.name },
    ...workspaces.filter((workspace) => workspace.jid !== directGroup.jid),
  ];
}

export function partitionAgentWorkspaceSections(
  sections: AgentWorkspaceSection[],
) {
  return {
    primary: sections.find((section) => section.isDefault) ?? null,
    custom: sections.filter((section) => !section.isDefault),
  };
}

export function isAgentSectionCollapsible(
  section: Pick<AgentWorkspaceSection, 'isDefault'>,
): boolean {
  return !section.isDefault;
}

export function buildWorkspaceAgentProfilePatch(agentProfileId: string) {
  return { agent_profile_id: agentProfileId };
}

export function buildAgentCapabilitiesHref(agentProfileId?: string | null) {
  const query = agentProfileId
    ? `?agent=${encodeURIComponent(agentProfileId)}`
    : '';
  return `/agent-profiles${query}#agent-capabilities`;
}

export function workspaceCreationBlockReason(input: {
  name: string;
  submitting: boolean;
  profilesLoading: boolean;
  profilesError: string | null;
  selectedAgentProfileId: string;
}): string | null {
  if (!input.name.trim()) return '请输入工作区名称';
  if (input.submitting) return '正在创建工作区';
  if (input.profilesLoading) return '正在加载智能体';
  if (input.profilesError) return '智能体列表加载失败';
  if (!input.selectedAgentProfileId) return '请选择智能体';
  return null;
}

export function getWorkspaceExecutionMode(
  groups: Record<string, GroupInfo>,
  jid: string,
): 'host' | 'container' | null {
  const mode = groups[jid]?.execution_mode;
  return mode === 'host' || mode === 'container' ? mode : null;
}
