/**
 * Claude Agent SDK result usage normalization.
 *
 * Official SDK 0.3.x derives root `usage` from cumulative `modelUsage`, while
 * `num_turns`/`duration_ms` describe the current result. Some compatible
 * providers have nevertheless emitted a per-result/reset root `usage` beside
 * cumulative modelUsage. We therefore use per-model high-water deltas as the
 * single token authority whenever modelUsage is available, and reserve root
 * usage for validation/fallback.
 *
 * Keeping that distinction here prevents later results in a streaming query
 * from being reduced to zero tokens while still protecting cumulative cost and
 * per-model counters from being charged more than once.
 */

export interface SdkResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface SdkModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  costUSD?: number;
}

export interface ResultUsagePayload {
  eventId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
      reasoningTokens: number;
      costUSD: number;
    }
  >;
}

interface ModelUsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  costUSD: number;
}

export interface ResultUsageState {
  totalCostUSD: number;
  rootUsage: Omit<ModelUsageSnapshot, 'costUSD'>;
  modelUsage: Map<string, ModelUsageSnapshot>;
}

export function createResultUsageState(): ResultUsageState {
  return {
    totalCostUSD: 0,
    rootUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    },
    modelUsage: new Map(),
  };
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value || 0) : 0;
}

/**
 * Delta for a cumulative counter. A decrease means the upstream counter
 * started a new epoch; treating the current value as the new delta avoids
 * silently losing the first result after a model/provider reset.
 */
function cumulativeDelta(current: number, previous: number): number {
  return current >= previous ? current - previous : current;
}

function snapshot(value: SdkModelUsage): ModelUsageSnapshot {
  return {
    inputTokens: nonNegative(value.inputTokens),
    outputTokens: nonNegative(value.outputTokens),
    cacheReadInputTokens: nonNegative(value.cacheReadInputTokens),
    cacheCreationInputTokens: nonNegative(value.cacheCreationInputTokens),
    reasoningTokens: nonNegative(value.reasoningTokens),
    costUSD: nonNegative(value.costUSD),
  };
}

function hasBillableUsage(value: ModelUsageSnapshot): boolean {
  return (
    value.inputTokens > 0 ||
    value.outputTokens > 0 ||
    value.cacheReadInputTokens > 0 ||
    value.cacheCreationInputTokens > 0 ||
    value.reasoningTokens > 0 ||
    value.costUSD > 0
  );
}

export function extractResultUsage(
  input: {
    eventId: string;
    usage: SdkResultUsage | undefined;
    totalCostUSD?: number;
    durationMs?: number;
    numTurns?: number;
    modelUsage?: Record<string, SdkModelUsage>;
    fallbackModelKey: string;
  },
  state: ResultUsageState,
): ResultUsagePayload | undefined {
  if (!input.usage) return undefined;

  const totalCostUSD = nonNegative(input.totalCostUSD);
  const costUSD = cumulativeDelta(totalCostUSD, state.totalCostUSD);
  state.totalCostUSD = totalCostUSD;

  const rawRoot = {
    inputTokens: nonNegative(input.usage.input_tokens),
    outputTokens: nonNegative(input.usage.output_tokens),
    cacheReadInputTokens: nonNegative(input.usage.cache_read_input_tokens),
    cacheCreationInputTokens: nonNegative(
      input.usage.cache_creation_input_tokens,
    ),
    reasoningTokens: nonNegative(input.usage.reasoning_output_tokens),
  };

  const modelUsage: NonNullable<ResultUsagePayload['modelUsage']> = {};
  const rawModels = input.modelUsage || {};
  for (const [model, raw] of Object.entries(rawModels)) {
    const current = snapshot(raw);
    const previous = state.modelUsage.get(model) || {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
    };
    const delta: ModelUsageSnapshot = {
      inputTokens: cumulativeDelta(current.inputTokens, previous.inputTokens),
      outputTokens: cumulativeDelta(
        current.outputTokens,
        previous.outputTokens,
      ),
      cacheReadInputTokens: cumulativeDelta(
        current.cacheReadInputTokens,
        previous.cacheReadInputTokens,
      ),
      cacheCreationInputTokens: cumulativeDelta(
        current.cacheCreationInputTokens,
        previous.cacheCreationInputTokens,
      ),
      reasoningTokens: cumulativeDelta(
        current.reasoningTokens,
        previous.reasoningTokens,
      ),
      costUSD: cumulativeDelta(current.costUSD, previous.costUSD),
    };
    state.modelUsage.set(model, current);
    // Cumulative modelUsage repeats previously used models on later results.
    // Do not turn those zero deltas into fake model calls in analytics.
    if (hasBillableUsage(delta)) modelUsage[model] = delta;
  }

  const hasModelAuthority = Object.keys(rawModels).length > 0;
  const root = hasModelAuthority
    ? Object.values(modelUsage).reduce(
        (sum, value) => ({
          inputTokens: sum.inputTokens + value.inputTokens,
          outputTokens: sum.outputTokens + value.outputTokens,
          cacheReadInputTokens:
            sum.cacheReadInputTokens + value.cacheReadInputTokens,
          cacheCreationInputTokens:
            sum.cacheCreationInputTokens + value.cacheCreationInputTokens,
          reasoningTokens: sum.reasoningTokens + value.reasoningTokens,
        }),
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
        },
      )
    : {
        inputTokens: cumulativeDelta(
          rawRoot.inputTokens,
          state.rootUsage.inputTokens,
        ),
        outputTokens: cumulativeDelta(
          rawRoot.outputTokens,
          state.rootUsage.outputTokens,
        ),
        cacheReadInputTokens: cumulativeDelta(
          rawRoot.cacheReadInputTokens,
          state.rootUsage.cacheReadInputTokens,
        ),
        cacheCreationInputTokens: cumulativeDelta(
          rawRoot.cacheCreationInputTokens,
          state.rootUsage.cacheCreationInputTokens,
        ),
        reasoningTokens: cumulativeDelta(
          rawRoot.reasoningTokens,
          state.rootUsage.reasoningTokens,
        ),
      };
  state.rootUsage = rawRoot;

  if (!hasModelAuthority) {
    const fallback: ModelUsageSnapshot = { ...root, costUSD };
    if (hasBillableUsage(fallback)) {
      modelUsage[input.fallbackModelKey || 'default'] = fallback;
    }
  }

  return {
    eventId: input.eventId,
    ...root,
    costUSD,
    // duration_ms and num_turns belong to the current result, like `usage`.
    durationMs: nonNegative(input.durationMs),
    numTurns: nonNegative(input.numTurns),
    modelUsage: Object.keys(modelUsage).length > 0 ? modelUsage : undefined,
  };
}
