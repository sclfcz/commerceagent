import { describe, expect, test } from 'vitest';

import { resolveClaudeProviderRuntime } from '../container/agent-runner/src/provider-runtime.js';

describe('agent-runner provider model contract', () => {
  test.each([
    {
      name: 'official without model uses the SDK default',
      env: { COMMERCEAGENT_CLAUDE_ENDPOINT_KIND: 'official' },
      missingRequiredModel: false,
      queryModelOptions: {},
      usageModelKey: 'default',
    },
    {
      name: 'official with model passes the selected model',
      env: {
        COMMERCEAGENT_CLAUDE_ENDPOINT_KIND: 'official',
        ANTHROPIC_MODEL: 'sonnet',
      },
      missingRequiredModel: false,
      queryModelOptions: { model: 'sonnet' },
      usageModelKey: 'sonnet',
    },
    {
      name: 'custom endpoint without model fails fast',
      env: { COMMERCEAGENT_CLAUDE_ENDPOINT_KIND: 'custom' },
      missingRequiredModel: true,
      queryModelOptions: {},
      usageModelKey: 'default',
    },
    {
      name: 'custom endpoint with model passes the selected model',
      env: {
        COMMERCEAGENT_CLAUDE_ENDPOINT_KIND: 'custom',
        ANTHROPIC_MODEL: 'glm-5.2',
      },
      missingRequiredModel: false,
      queryModelOptions: { model: 'glm-5.2' },
      usageModelKey: 'glm-5.2',
    },
  ])(
    '$name',
    ({ env, missingRequiredModel, queryModelOptions, usageModelKey }) => {
      const runtime = resolveClaudeProviderRuntime(env);

      expect(runtime.missingRequiredModel).toBe(missingRequiredModel);
      expect(runtime.queryModelOptions).toEqual(queryModelOptions);
      expect(runtime.usageModelKey).toBe(usageModelKey);
    },
  );

  test('authoritative official marker ignores an inherited stale base URL', () => {
    const runtime = resolveClaudeProviderRuntime({
      COMMERCEAGENT_CLAUDE_ENDPOINT_KIND: 'official',
      ANTHROPIC_BASE_URL: 'https://stale-proxy.test',
    });

    expect(runtime.endpointKind).toBe('official');
    expect(runtime.missingRequiredModel).toBe(false);
  });

  test('falls back to base URL detection for older hosts', () => {
    expect(
      resolveClaudeProviderRuntime({
        ANTHROPIC_BASE_URL: 'https://proxy.test',
      }).endpointKind,
    ).toBe('custom');
  });
});
