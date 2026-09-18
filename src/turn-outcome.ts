/**
 * Explicit host-side interpretation of a runner's terminal state.
 *
 * GroupQueue still consumes a boolean for backwards compatibility, but callers
 * should classify ambiguous runner exits here before mapping the outcome to that
 * legacy contract.  In particular, `status: 'closed'` is not automatically a
 * success: an in-flight input without a reply or healthy completion must replay.
 */
export type TurnOutcome =
  | {
      kind: 'completed';
      cursor: 'commit' | 'already_committed';
      reason: 'healthy_input_completed' | 'reply_delivered';
    }
  | {
      kind: 'retryable';
      cursor: 'keep';
      reason: 'runner_closed_in_flight' | 'runner_failed_in_flight';
    }
  | {
      kind: 'stopped';
      cursor: 'commit' | 'already_committed';
      reason: 'user_stop';
    }
  | {
      kind: 'deterministic_failure';
      cursor: 'commit' | 'already_committed';
      reason: 'configuration_or_input';
    };

export interface ResolveTurnOutcomeInput {
  status: 'success' | 'error' | 'stream' | 'closed';
  healthyInputTurnCompleted: boolean;
  cursorCommitted: boolean;
  replyDelivered: boolean;
  stopRequested?: boolean;
  deterministicFailure?: boolean;
}

export function resolveTurnOutcome(
  input: ResolveTurnOutcomeInput,
): TurnOutcome {
  if (input.stopRequested) {
    return {
      kind: 'stopped',
      cursor: input.cursorCommitted ? 'already_committed' : 'commit',
      reason: 'user_stop',
    };
  }

  if (input.deterministicFailure) {
    return {
      kind: 'deterministic_failure',
      cursor: input.cursorCommitted ? 'already_committed' : 'commit',
      reason: 'configuration_or_input',
    };
  }

  if (input.healthyInputTurnCompleted) {
    return {
      kind: 'completed',
      cursor: input.cursorCommitted ? 'already_committed' : 'commit',
      reason: 'healthy_input_completed',
    };
  }

  // Preserve the existing duplicate-reply guard. A delivered reply is a
  // completed user-visible turn even if the runner later closes before its
  // final bookkeeping marker arrives.
  if (input.replyDelivered) {
    return {
      kind: 'completed',
      cursor: input.cursorCommitted ? 'already_committed' : 'commit',
      reason: 'reply_delivered',
    };
  }

  return {
    kind: 'retryable',
    cursor: 'keep',
    reason:
      input.status === 'closed'
        ? 'runner_closed_in_flight'
        : 'runner_failed_in_flight',
  };
}
