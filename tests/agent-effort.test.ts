import { describe, expect, test } from 'vitest';

import {
  normalizeAgentEffort,
  removeProviderEffortEnv,
  resolveAgentSdkEffort,
} from '../src/agent-effort.js';
import { resolveAgentSdkEffort as resolveRunnerAgentSdkEffort } from '../container/agent-runner/src/agent-effort.js';
import {
  buildClaudeEnvLines,
  type ClaudeProviderConfig,
} from '../src/runtime-config.js';

function providerConfig(
  patch: Partial<ClaudeProviderConfig>,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicApiKey: 'test-key',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: 'claude-test',
    updatedAt: null,
    ...patch,
  };
}

describe('Agent effort resolution', () => {
  test('normalizes legacy, missing, and invalid values to inherit', () => {
    expect(normalizeAgentEffort(undefined)).toBe('inherit');
    expect(normalizeAgentEffort('inherit')).toBe('inherit');
    expect(normalizeAgentEffort('turbo')).toBe('inherit');
    expect(normalizeAgentEffort('xhigh')).toBe('xhigh');
  });

  test('returns only explicit SDK effort levels in host and runner resolvers', () => {
    const explicit = { reasoning: { effort: 'high' } } as const;
    const inherited = { reasoning: { effort: 'inherit' } } as const;

    expect(resolveAgentSdkEffort(explicit as any)).toBe('high');
    expect(resolveRunnerAgentSdkEffort(explicit)).toBe('high');
    expect(resolveAgentSdkEffort(inherited as any)).toBeUndefined();
    expect(resolveRunnerAgentSdkEffort(inherited)).toBeUndefined();
    expect(
      resolveRunnerAgentSdkEffort({ reasoning: { effort: 'turbo' } }),
    ).toBeUndefined();
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'passes %s through without model-side filtering',
    (effort) => {
      expect(resolveRunnerAgentSdkEffort({ reasoning: { effort } })).toBe(
        effort,
      );
    },
  );

  test('explicit Agent effort removes Provider env while inherit preserves it', () => {
    const inheritedLines = [
      'ANTHROPIC_MODEL=claude-test',
      'CLAUDE_CODE_EFFORT_LEVEL=max',
    ];
    removeProviderEffortEnv(inheritedLines, undefined);
    expect(inheritedLines).toContain('CLAUDE_CODE_EFFORT_LEVEL=max');

    const explicitLines = [
      'CLAUDE_CODE_EFFORT_LEVEL=low',
      'ANTHROPIC_MODEL=third-party-model',
      'CLAUDE_CODE_EFFORT_LEVEL=max',
    ];
    removeProviderEffortEnv(explicitLines, 'medium');
    expect(explicitLines).toEqual(['ANTHROPIC_MODEL=third-party-model']);
  });

  test.each([
    {
      name: 'official',
      config: providerConfig({}),
      customEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
      expectedInherited: 'CLAUDE_CODE_EFFORT_LEVEL=low',
    },
    {
      name: 'third-party',
      config: providerConfig({
        anthropicBaseUrl: 'https://models.example.test',
        anthropicApiKey: '',
        anthropicAuthToken: 'third-party-token',
        anthropicModel: 'third-party-model',
      }),
      customEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' },
      expectedInherited: 'CLAUDE_CODE_EFFORT_LEVEL=medium',
    },
  ])(
    '$name Provider env is kept for inherit and removed for an explicit Agent',
    ({ config, customEnv, expectedInherited }) => {
      const inherited = buildClaudeEnvLines(config, customEnv);
      removeProviderEffortEnv(inherited, undefined);
      expect(inherited).toContain(expectedInherited);

      const explicit = buildClaudeEnvLines(config, customEnv);
      removeProviderEffortEnv(explicit, 'high');
      expect(
        explicit.some((line) => line.startsWith('CLAUDE_CODE_EFFORT_LEVEL=')),
      ).toBe(false);
    },
  );
});
