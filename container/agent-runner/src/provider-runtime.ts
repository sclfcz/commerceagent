export const CLAUDE_ENDPOINT_KIND_ENV = 'COMMERCEAGENT_CLAUDE_ENDPOINT_KIND';
/** Must stay aligned with the host pool's default-tier identity. */
export const SDK_DEFAULT_MODEL_TIER = '__commerceagent_sdk_default_model__';

export type ClaudeEndpointKind = 'official' | 'custom';

export interface ClaudeProviderRuntime {
  endpointKind: ClaudeEndpointKind;
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
  missingRequiredModel: boolean;
}

export interface ClaudeQueryModelRuntime {
  model: string;
  queryModelOptions: { model?: string };
  usageModelKey: string;
}

/** Model identity reported to the host without forcing the SDK's default. */
export function resolveProviderReportedModelTier(
  providerRuntime: ClaudeProviderRuntime,
  modelOverride?: string,
): string {
  return (
    modelOverride?.trim() || providerRuntime.model || SDK_DEFAULT_MODEL_TIER
  );
}

/** Resolve a model at query time so a warm runner can switch tiers without respawn. */
export function resolveClaudeQueryModelRuntime(
  providerRuntime: ClaudeProviderRuntime,
  modelOverride?: string,
): ClaudeQueryModelRuntime {
  const model = modelOverride?.trim() || providerRuntime.model;
  return {
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
  };
}

/**
 * Resolve the provider/model contract once at runner startup.
 *
 * New hosts inject an authoritative endpoint-kind marker. Falling back to
 * ANTHROPIC_BASE_URL keeps the runner compatible with older hosts and images.
 */
export function resolveClaudeProviderRuntime(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeProviderRuntime {
  const model = env.ANTHROPIC_MODEL?.trim() ?? '';
  const marker = env[CLAUDE_ENDPOINT_KIND_ENV]?.trim().toLowerCase();
  const endpointKind: ClaudeEndpointKind =
    marker === 'official' || marker === 'custom'
      ? marker
      : env.ANTHROPIC_BASE_URL?.trim()
        ? 'custom'
        : 'official';

  return {
    endpointKind,
    model,
    queryModelOptions: model ? { model } : {},
    usageModelKey: model || 'default',
    missingRequiredModel: endpointKind === 'custom' && !model,
  };
}
