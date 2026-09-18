export type AgentMcpPolicyMode = 'inherit' | 'custom' | 'disabled';

export interface ResolvedAgentMcpPolicy {
  loadUserPlugins: boolean;
  skipPluginMcpDiscovery: boolean;
  includeUserMcpServers: boolean;
  strictMcpConfig: boolean;
  settingSources: Array<'project' | 'user' | 'local'>;
}

export function parseAgentMcpPolicyMode(
  raw: string | undefined,
): AgentMcpPolicyMode {
  return raw === 'custom' || raw === 'disabled' ? raw : 'inherit';
}

/**
 * MCP selection remains a user-controlled capability choice. Exact selections
 * keep plugins loaded for their commands/agents/skills/hooks while asking the
 * SDK to skip only their MCP discovery. Every mode keeps the normal Claude
 * tool surface and project/user settings available.
 */
export function resolveAgentMcpPolicy(
  mode: AgentMcpPolicyMode,
): ResolvedAgentMcpPolicy {
  const exactUserMcpSet = mode !== 'inherit';
  return {
    loadUserPlugins: true,
    skipPluginMcpDiscovery: exactUserMcpSet,
    includeUserMcpServers: true,
    strictMcpConfig: exactUserMcpSet,
    settingSources: ['project', 'user', 'local'],
  };
}
