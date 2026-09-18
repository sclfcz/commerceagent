import { beforeEach, describe, expect, test, vi } from 'vitest';

const query = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query }));
vi.mock('../src/runtime-config.js', () => ({
  buildClaudeEnvLines: () => ['ANTHROPIC_API_KEY=test-key'],
  clearInheritedClaudeProviderEnv: () => {},
  getClaudeProviderConfig: () => ({ anthropicModel: 'test-model' }),
}));
vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

const { sdkQuery } = await import('../src/sdk-query.js');

function successfulConversation(result: string) {
  return (async function* () {
    yield { type: 'result', subtype: 'success', result };
  })();
}

beforeEach(() => query.mockReset());

describe('sdkQuery', () => {
  test('runs one-turn text queries without exposing tools or filesystem settings', async () => {
    query.mockReturnValue(successfulConversation(' generated response '));

    await expect(sdkQuery('generate a profile')).resolves.toBe(
      'generated response',
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toMatchObject({
      prompt: 'generate a profile',
      options: {
        model: 'test-model',
        maxTurns: 2,
        tools: [],
        skills: [],
        settingSources: [],
        allowedTools: [],
      },
    });
  });
});
