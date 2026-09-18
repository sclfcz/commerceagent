import { describe, expect, test } from 'vitest';
import {
  AGENT_PROMPT_SECTION_MAX_LENGTH,
  agentProfilePromptsFromLegacy,
  buildAgentProfilePrompt,
  normalizeAgentProfilePrompts,
} from '../src/agent-profile-prompts.js';

describe('AgentProfile four-part prompt contract', () => {
  test('assembles non-empty sections in one exact canonical order', () => {
    const prompt = buildAgentProfilePrompt({
      identity_prompt: '  Identity boundary\n',
      soul_prompt: '',
      agents_prompt: 'Agents rules',
      tools_prompt: 'Tools policy\n  ',
      prompt_mode: 'append',
    });

    expect(prompt).toBe(
      [
        '## IDENTITY\n  Identity boundary\n',
        '## AGENTS\nAgents rules',
        '## TOOLS\nTools policy\n  ',
      ].join('\n\n'),
    );
    expect(prompt.indexOf('## IDENTITY')).toBeLessThan(
      prompt.indexOf('## AGENTS'),
    );
    expect(prompt.indexOf('## AGENTS')).toBeLessThan(
      prompt.indexOf('## TOOLS'),
    );
  });

  test('preserves prompt document boundaries and only trims for emptiness', () => {
    const prompts = normalizeAgentProfilePrompts({
      identity_prompt: '\n  Keep these edges  \n',
      soul_prompt: '   ',
      prompt_mode: 'replace',
    });
    expect(prompts.identity_prompt).toBe('\n  Keep these edges  \n');
    expect(buildAgentProfilePrompt(prompts)).toBe(
      '## IDENTITY\n\n  Keep these edges  \n',
    );
  });

  test('maps the legacy all-in-one prompt losslessly into AGENTS', () => {
    expect(agentProfilePromptsFromLegacy('\nlegacy\n', false)).toEqual({
      identity_prompt: '',
      soul_prompt: '',
      agents_prompt: '\nlegacy\n',
      tools_prompt: '',
      prompt_mode: 'replace',
    });
  });

  test('never silently truncates an existing prompt document', () => {
    const oversized = 'x'.repeat(AGENT_PROMPT_SECTION_MAX_LENGTH + 1);
    expect(
      normalizeAgentProfilePrompts({ identity_prompt: oversized })
        .identity_prompt,
    ).toBe(oversized);
  });
});
