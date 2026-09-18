import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';

export type ContextBudgetStatus =
  | 'unavailable'
  | 'ok'
  | 'warning'
  | 'hard_exceeded';

export interface ContextBudgetAssessment {
  status: ContextBudgetStatus;
  startupTokens?: number;
  totalTokens?: number;
  maxTokens?: number;
  warningThreshold?: number;
  hardThreshold?: number;
  warning?: string;
  error?: string;
}

export function calculateStaticStartupTokens(
  usage: SDKControlGetContextUsageResponse,
): number {
  const sum = (values: Array<{ tokens: number }> | undefined): number =>
    (values ?? []).reduce((total, value) => total + (value.tokens || 0), 0);

  return (
    sum(usage.memoryFiles) +
    sum(usage.mcpTools.filter((tool) => tool.isLoaded !== false)) +
    sum(usage.deferredBuiltinTools?.filter((tool) => tool.isLoaded)) +
    sum(usage.systemTools) +
    sum(usage.systemPromptSections) +
    sum(usage.agents) +
    (usage.slashCommands?.tokens ?? 0) +
    (usage.skills?.tokens ?? 0)
  );
}

/**
 * Applies the model-aware startup-context policy. min() keeps the policy useful
 * for small context windows instead of assuming every model has 200K+ tokens.
 */
export function assessContextBudget(
  usage?: SDKControlGetContextUsageResponse,
): ContextBudgetAssessment {
  if (
    !usage ||
    !Number.isFinite(usage.totalTokens) ||
    !Number.isFinite(usage.maxTokens) ||
    usage.maxTokens <= 0
  ) {
    return {
      status: 'unavailable',
      warning: 'SDK context budget unavailable or invalid',
    };
  }

  const warningThreshold = Math.floor(Math.min(50_000, usage.maxTokens * 0.25));
  const hardThreshold = Math.floor(Math.min(100_000, usage.maxTokens * 0.4));
  const startupTokens = calculateStaticStartupTokens(usage);
  const common = {
    startupTokens,
    totalTokens: usage.totalTokens,
    maxTokens: usage.maxTokens,
    warningThreshold,
    hardThreshold,
  };

  if (startupTokens >= hardThreshold) {
    return {
      ...common,
      status: 'hard_exceeded',
      error: `static startup context ${startupTokens} tokens exceeds hard limit ${hardThreshold} for a ${usage.maxTokens}-token window`,
    };
  }
  if (startupTokens >= warningThreshold) {
    return {
      ...common,
      status: 'warning',
      warning: `static startup context ${startupTokens} tokens exceeds warning limit ${warningThreshold} for a ${usage.maxTokens}-token window`,
    };
  }
  return { ...common, status: 'ok' };
}
