import type { AgentProfilePromptMode, AgentProfilePrompts } from './types.js';

export const AGENT_PROMPT_SECTION_MAX_LENGTH = 20_000;

export const EMPTY_AGENT_PROFILE_PROMPTS: AgentProfilePrompts = {
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
  prompt_mode: 'append',
};

export function promptModeFromLegacyPreset(
  includeClaudePreset: boolean | undefined,
): AgentProfilePromptMode {
  return includeClaudePreset === false ? 'replace' : 'append';
}

export function includeClaudePresetForMode(
  mode: AgentProfilePromptMode,
): boolean {
  return mode === 'append';
}

function normalizePrompt(value: unknown): string {
  // Request schemas reject over-limit edits. Preserve legacy/database content
  // verbatim here so normalization never turns a visible validation problem
  // into a silent prompt rewrite.
  return typeof value === 'string' ? value : '';
}

export function normalizeAgentProfilePrompts(
  input?: Partial<AgentProfilePrompts> | null,
): AgentProfilePrompts {
  return {
    identity_prompt: normalizePrompt(input?.identity_prompt),
    soul_prompt: normalizePrompt(input?.soul_prompt),
    agents_prompt: normalizePrompt(input?.agents_prompt),
    tools_prompt: normalizePrompt(input?.tools_prompt),
    prompt_mode: input?.prompt_mode === 'replace' ? 'replace' : 'append',
  };
}

export function hasAgentProfilePrompts(
  prompts: Pick<
    AgentProfilePrompts,
    'identity_prompt' | 'soul_prompt' | 'agents_prompt' | 'tools_prompt'
  >,
): boolean {
  return !!(
    prompts.identity_prompt.trim() ||
    prompts.soul_prompt.trim() ||
    prompts.agents_prompt.trim() ||
    prompts.tools_prompt.trim()
  );
}

/**
 * Build the user-configurable Agent prompt in one canonical order. This is not
 * the complete CommerceAgent system prompt: platform runtime, channel, and memory
 * instructions are appended outside this block and cannot be removed by
 * prompt_mode=replace.
 */
export function buildAgentProfilePrompt(
  input: Partial<AgentProfilePrompts>,
): string {
  const prompts = normalizeAgentProfilePrompts(input);
  if (!hasAgentProfilePrompts(prompts)) return '';
  return [
    ['IDENTITY', prompts.identity_prompt],
    ['SOUL', prompts.soul_prompt],
    ['AGENTS', prompts.agents_prompt],
    ['TOOLS', prompts.tools_prompt],
  ]
    .filter(([, text]) => text.trim().length > 0)
    .map(([title, text]) => `## ${title}\n${text}`)
    .join('\n\n');
}

export function agentProfilePromptsFromLegacy(
  identityPrompt: string | undefined,
  includeClaudePreset: boolean | undefined,
): AgentProfilePrompts {
  return normalizeAgentProfilePrompts({
    // The old all-in-one identity prompt mostly described operating behavior,
    // so migrate it losslessly into AGENTS instead of pretending it was the
    // new, deliberately narrow IDENTITY section.
    agents_prompt: identityPrompt ?? '',
    prompt_mode: promptModeFromLegacyPreset(includeClaudePreset),
  });
}
