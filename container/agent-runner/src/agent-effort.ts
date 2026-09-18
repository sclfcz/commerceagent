export const SDK_AGENT_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type SdkAgentEffort = (typeof SDK_AGENT_EFFORT_LEVELS)[number];

const SDK_AGENT_EFFORT_LEVEL_SET = new Set<string>(SDK_AGENT_EFFORT_LEVELS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Return only an explicit Agent effort. Undefined means inherit: the host has
 * kept the Provider's CLAUDE_CODE_EFFORT_LEVEL (if any), otherwise the SDK
 * selects its model-aware default.
 */
export function resolveAgentSdkEffort(
  runtimePolicy: unknown,
): SdkAgentEffort | undefined {
  if (!isRecord(runtimePolicy) || !isRecord(runtimePolicy.reasoning)) {
    return undefined;
  }
  const effort = runtimePolicy.reasoning.effort;
  return typeof effort === 'string' && SDK_AGENT_EFFORT_LEVEL_SET.has(effort)
    ? (effort as SdkAgentEffort)
    : undefined;
}
