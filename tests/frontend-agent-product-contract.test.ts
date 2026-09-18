import { describe, expect, it } from 'vitest';
import {
  buildAgentCapabilitiesHref,
  buildWorkspaceAgentProfilePatch,
  getCustomAgentProfiles,
  getAgentNavigationTargets,
  getAgentProfileDisplayName,
  getPrimaryAgentWorkspaceRows,
  groupWorkspacesByAgent,
  isAgentSectionCollapsible,
  partitionAgentWorkspaceSections,
  workspaceCreationBlockReason,
} from '../web/src/utils/agent-product';
import {
  buildTaskWorkspacePatch,
  canSelectTaskExecutionMode,
  getAllowedTaskExecutionModes,
} from '../web/src/utils/task-edit';
import type { GroupEntry } from '../web/src/utils/group-utils';
import {
  getAgentContextSource,
  withAgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../web/src/types';

function workspace(
  jid: string,
  agentProfileId: string,
  agentProfileName: string,
): GroupEntry {
  return {
    jid,
    name: jid,
    folder: jid,
    agent_profile_id: agentProfileId,
    agent_profile_name: agentProfileName,
  } as GroupEntry;
}

describe('Agent-first frontend product contracts', () => {
  it('treats managed and host Claude context as an Agent setting independent of execution mode', () => {
    const managedPolicy: AgentProfileRuntimePolicy = {
      context: { source: 'managed' },
      skills: { mode: 'custom', ids: ['review'] },
      mcp: { mode: 'custom', ids: ['github'] },
    };

    expect(getAgentContextSource(managedPolicy)).toBe('managed');
    expect(getAgentContextSource({})).toBe('managed');
    expect(withAgentContextSource(managedPolicy, 'host_claude')).toEqual({
      ...managedPolicy,
      context: { source: 'host_claude' },
    });
  });

  it('shows the legacy built-in Agent name as CommerceAgent', () => {
    expect(getAgentProfileDisplayName('Default Agent')).toBe('CommerceAgent');
    expect(getAgentProfileDisplayName(undefined)).toBe('CommerceAgent');
    expect(getAgentProfileDisplayName('代码审查员')).toBe('代码审查员');
  });

  it('keeps the Agent management page scoped to custom Agents', () => {
    expect(
      getCustomAgentProfiles([
        { id: 'commerceagent', is_default: true },
        { id: 'reviewer', is_default: false },
      ]),
    ).toEqual([{ id: 'reviewer', is_default: false }]);
  });

  it('sends the canonical Agent assignment payload for workspace migration', () => {
    expect(buildWorkspaceAgentProfilePatch('agent-reviewer')).toEqual({
      agent_profile_id: 'agent-reviewer',
    });
  });

  it('routes capability management to the owning Agent instead of workspace settings', () => {
    expect(buildAgentCapabilitiesHref('agent/reviewer')).toBe(
      '/agent-profiles?agent=agent%2Freviewer#agent-capabilities',
    );
    expect(buildAgentCapabilitiesHref()).toBe(
      '/agent-profiles#agent-capabilities',
    );
  });

  it('moves a task from a host workspace to a container workspace atomically', () => {
    expect(
      buildTaskWorkspacePatch({
        currentChatJid: 'web:host',
        currentExecutionMode: 'host',
        targetChatJid: 'web:container',
        targetExecutionMode: 'container',
      }),
    ).toEqual({
      chat_jid: 'web:container',
      execution_mode: 'container',
    });
  });

  it('only exposes host task execution to admins', () => {
    expect(getAllowedTaskExecutionModes('admin')).toEqual([
      'host',
      'container',
    ]);
    expect(getAllowedTaskExecutionModes('member')).toEqual(['container']);
    expect(canSelectTaskExecutionMode('member', 'host')).toBe(false);
    expect(canSelectTaskExecutionMode('member', 'container')).toBe(true);
  });

  it('blocks workspace creation when Agent loading failed instead of using a silent default', () => {
    expect(
      workspaceCreationBlockReason({
        name: 'Review workspace',
        submitting: false,
        profilesLoading: false,
        profilesError: 'network down',
        selectedAgentProfileId: '',
      }),
    ).toBe('智能体列表加载失败');
  });

  it('preserves Agent hierarchy for workspace collections', () => {
    expect(
      groupWorkspacesByAgent([
        workspace('web:one', 'agent-a', 'Reviewer'),
        workspace('web:two', 'agent-b', 'Builder'),
        workspace('web:three', 'agent-a', 'Reviewer'),
      ]).map((section) => [
        section.name,
        section.items.map((item) => item.jid),
      ]),
    ).toEqual([
      ['Builder', ['web:two']],
      ['Reviewer', ['web:one', 'web:three']],
    ]);
  });

  it('keeps the default CommerceAgent Agent first and retains its internal home context', () => {
    const home = workspace('web:main', 'agent-commerceagent', 'CommerceAgent');
    home.is_my_home = true;

    const sections = groupWorkspacesByAgent(
      [
        workspace('web:review', 'agent-reviewer', '代码审查员'),
        workspace('web:project', 'agent-commerceagent', 'CommerceAgent'),
        home,
      ],
      'agent-commerceagent',
    );

    expect(sections.map((section) => section.name)).toEqual([
      'CommerceAgent',
      '代码审查员',
    ]);
    expect(sections[0]).toMatchObject({
      isDefault: true,
      items: [{ jid: 'web:main', is_my_home: true }, { jid: 'web:project' }],
    });
  });

  it('keeps the home context separate from additional Agent workspaces for navigation', () => {
    const home = workspace('web:main', 'agent-commerceagent', 'CommerceAgent');
    home.is_my_home = true;
    const [section] = groupWorkspacesByAgent(
      [workspace('web:project', 'agent-commerceagent', 'CommerceAgent'), home],
      'agent-commerceagent',
    );

    expect(getAgentNavigationTargets(section)).toMatchObject({
      directGroup: { jid: 'web:main', is_my_home: true },
      workspaces: [{ jid: 'web:project' }],
    });
  });

  it('presents the home context as the named main workspace of the primary Agent', () => {
    const home = workspace('web:main', 'agent-commerceagent', 'CommerceAgent');
    home.is_my_home = true;
    const [section] = groupWorkspacesByAgent(
      [workspace('web:project', 'agent-commerceagent', 'CommerceAgent'), home],
      'agent-commerceagent',
    );

    expect(
      getPrimaryAgentWorkspaceRows(section).map(({ jid, name }) => ({
        jid,
        name,
      })),
    ).toEqual([
      { jid: 'web:main', name: 'CommerceAgent' },
      { jid: 'web:project', name: 'web:project' },
    ]);
  });

  it('separates CommerceAgent as the primary Agent from custom Agents', () => {
    const sections = groupWorkspacesByAgent(
      [
        workspace('web:main', 'agent-commerceagent', 'CommerceAgent'),
        workspace('web:review', 'agent-reviewer', '代码审查员'),
      ],
      'agent-commerceagent',
    );

    const partitioned = partitionAgentWorkspaceSections(sections);
    expect(partitioned.primary?.name).toBe('CommerceAgent');
    expect(partitioned.custom.map((section) => section.name)).toEqual([
      '代码审查员',
    ]);
  });

  it('keeps the primary CommerceAgent Agent fixed open while custom Agents remain collapsible', () => {
    expect(isAgentSectionCollapsible({ isDefault: true })).toBe(false);
    expect(isAgentSectionCollapsible({ isDefault: false })).toBe(true);
  });
});
