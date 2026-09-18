import { createHash } from 'node:crypto';

export const COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT = `## CommerceAgent delegated-task contract

You are executing a task delegated by a parent agent. Return the requested findings or work product to that parent agent; do not act as though your text is the final user-facing reply. Stay within the delegated scope. Do not independently operate CommerceAgent memory or Agent Builder unless the delegated task explicitly requires it.`;

export interface SubagentRuntimeContractAudit {
  enabled: boolean;
  hash: string;
  sdkCompatibility: 'claude-agent-sdk-0.3.205';
  cliCompatibility: 'claude-code-2.1.205';
}

type HiddenSubagentPromptOption = {
  appendSubagentSystemPrompt: string;
};

type SdkOptionsWithEnv = {
  env?: Record<string, string | undefined>;
};

function contractHash(): string {
  return createHash('sha256')
    .update(COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT, 'utf8')
    .digest('hex');
}

/**
 * Isolates the SDK/CLI 0.3.205 / 2.1.205 undocumented compatibility surface.
 * The SDK serializes appendSubagentSystemPrompt during its initialize control
 * request, while this CLI version gates consumption behind the environment flag.
 */
export function withCommerceAgentSubagentContract<
  T extends Record<string, unknown>,
>(
  options: T,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): {
  options: T & SdkOptionsWithEnv & HiddenSubagentPromptOption;
  audit: SubagentRuntimeContractAudit;
} {
  const enabled =
    process.env.COMMERCEAGENT_DISABLE_SUBAGENT_RUNTIME_CONTRACT !== 'true';
  const existingEnv = (options as T & SdkOptionsWithEnv).env;
  const hash = contractHash();
  const audit: SubagentRuntimeContractAudit = {
    enabled,
    hash,
    sdkCompatibility: 'claude-agent-sdk-0.3.205',
    cliCompatibility: 'claude-code-2.1.205',
  };

  if (!enabled) {
    return {
      options: options as T & SdkOptionsWithEnv & HiddenSubagentPromptOption,
      audit,
    };
  }

  return {
    options: {
      ...options,
      env: {
        ...inheritedEnv,
        ...existingEnv,
        CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT: '1',
      },
      appendSubagentSystemPrompt: COMMERCEAGENT_SUBAGENT_RUNTIME_CONTRACT,
    },
    audit,
  };
}
