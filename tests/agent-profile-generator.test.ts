import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkQuery = vi.fn();
vi.mock('../src/sdk-query.js', () => ({ sdkQuery }));
vi.mock('../src/runtime-config.js', () => ({
  getClaudeProviderConfig: () => ({ anthropicApiKey: 'configured' }),
}));

const { generateAgentProfileDraft, refineAgentProfilePrompt } =
  await import('../src/agent-profile-generator.js');

beforeEach(() => sdkQuery.mockReset());

describe('AgentProfile AI generation', () => {
  test('generates all four prompt sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Review Agent',
        identity_prompt: 'Reviewer',
        soul_prompt: 'Evidence first',
        agents_prompt: 'Review diffs',
        tools_prompt: 'Read before write',
        prompt_mode: 'append',
      }),
    );

    await expect(generateAgentProfileDraft('review code')).resolves.toEqual({
      name: 'Review Agent',
      identity_prompt: 'Reviewer',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append',
    });
  });

  test('refinement returns a complete candidate and preserves omitted sections', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        reply: 'Updated tools',
        tools_prompt: 'Ask before destructive writes',
      }),
    );
    const currentPrompts = {
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Read before write',
      prompt_mode: 'append' as const,
    };

    await expect(
      refineAgentProfilePrompt({
        agentName: 'Review Agent',
        currentPrompts,
        section: 'tools',
        message: 'ask before dangerous changes',
        history: [],
      }),
    ).resolves.toEqual({
      reply: 'Updated tools',
      identity_prompt: '\nReviewer\n',
      soul_prompt: 'Evidence first',
      agents_prompt: 'Review diffs',
      tools_prompt: 'Ask before destructive writes',
    });
  });

  test('rejects an oversized generated section instead of silently truncating it', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Oversized Agent',
        identity_prompt: 'x'.repeat(20_001),
        soul_prompt: 'Evidence first',
        agents_prompt: 'Review diffs',
        tools_prompt: 'Read before write',
      }),
    );

    await expect(generateAgentProfileDraft('make it huge')).rejects.toThrow(
      '单段提示词超过 20000 字符限制',
    );
  });

  test('rejects a generated all-in-one IDENTITY without an AGENTS workflow', async () => {
    sdkQuery.mockResolvedValueOnce(
      JSON.stringify({
        name: 'Receipt Agent',
        identity_prompt:
          'Receipt assistant. Parse input, invoke scripts, retry failures, and send files.',
        soul_prompt: '',
        agents_prompt: '',
        tools_prompt: '',
        prompt_mode: 'append',
      }),
    );

    await expect(
      generateAgentProfileDraft('generate and send receipts'),
    ).rejects.toThrow('AI 生成的智能体配置格式无效');
  });
});
