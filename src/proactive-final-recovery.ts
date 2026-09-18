import type { ActiveTurnOutputRegistry } from './turn-output-coordinator.js';
import type { MessageFinalizationReason } from './types.js';

export interface UnacknowledgedProactiveFinalProjectionResult {
  projected: boolean;
  finalizationReason: Extract<
    MessageFinalizationReason,
    'delivery_uncertain' | 'error'
  >;
}

/**
 * Preserve the exact explicit final in the canonical Web session when native
 * delivery was not acknowledged.
 *
 * This never retries the provider mutation and deliberately records only a
 * projection, so native delivery accounting and retry fences remain intact.
 */
export async function preserveUnacknowledgedProactiveFinal(input: {
  registry: ActiveTurnOutputRegistry;
  scopeKey: string;
  inputTurnId: string;
  text: string;
  uncertain: boolean;
  project: (
    text: string,
    finalizationReason: Extract<
      MessageFinalizationReason,
      'delivery_uncertain' | 'error'
    >,
  ) => Promise<boolean>;
}): Promise<UnacknowledgedProactiveFinalProjectionResult> {
  const finalizationReason = input.uncertain ? 'delivery_uncertain' : 'error';
  const projected = await input.project(input.text, finalizationReason);
  if (projected) {
    input.registry.recordProjectedUtterance({
      scopeKey: input.scopeKey,
      inputTurnId: input.inputTurnId,
      role: 'final',
      text: input.text,
    });
  }
  return { projected, finalizationReason };
}
