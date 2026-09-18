import { describe, expect, test } from 'vitest';

import {
  parseAgentMcpPolicyMode,
  resolveAgentMcpPolicy,
} from '../container/agent-runner/src/runtime-mcp-policy.js';

describe('AgentProfile runtime MCP selection', () => {
  test('inherit preserves plugins, settings and user MCP servers', () => {
    expect(resolveAgentMcpPolicy('inherit')).toEqual({
      loadUserPlugins: true,
      skipPluginMcpDiscovery: false,
      includeUserMcpServers: true,
      strictMcpConfig: false,
      settingSources: ['project', 'user', 'local'],
    });
  });

  test.each(['custom', 'disabled'] as const)(
    '%s materializes an exact MCP set without restricting normal tools',
    (mode) => {
      expect(resolveAgentMcpPolicy(mode)).toEqual({
        loadUserPlugins: true,
        skipPluginMcpDiscovery: true,
        includeUserMcpServers: true,
        strictMcpConfig: true,
        settingSources: ['project', 'user', 'local'],
      });
    },
  );

  test('unknown values fall back to inheritance', () => {
    expect(parseAgentMcpPolicyMode('disabled')).toBe('disabled');
    expect(parseAgentMcpPolicyMode('unknown')).toBe('inherit');
  });
});
