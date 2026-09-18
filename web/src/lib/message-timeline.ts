export interface TimelineMessageLike {
  id: string;
  timestamp: string;
  is_from_me: boolean;
  delivery_status?: 'queued' | 'promoting' | 'released' | 'cancelled' | null;
  delivery_updated_at?: string | null;
  delivery_run_id?: string | null;
}

export interface FollowUpTransitionLike {
  id: string;
  delivery_status: 'released' | 'cancelled';
  delivery_run_id?: string | null;
  delivery_updated_at: string;
}

const HIDDEN_FOLLOW_UP_STATUSES = new Set(['queued', 'promoting', 'cancelled']);

/**
 * Queued user inputs belong beside the composer until they actually start.
 * They should not appear in the durable transcript as if the agent had
 * already accepted them as a turn.
 */
export function isMessageVisibleInTimeline(
  message: TimelineMessageLike,
): boolean {
  return !(
    !message.is_from_me &&
    message.delivery_status &&
    HIDDEN_FOLLOW_UP_STATUSES.has(message.delivery_status)
  );
}

/**
 * Once a follow-up is released, its execution time becomes its presentation
 * time. This places it immediately after the previous answer while preserving
 * the original send timestamp in storage for delivery/cursor semantics.
 */
export function getMessageDisplayTimestamp(
  message: TimelineMessageLike,
): string {
  if (
    !message.is_from_me &&
    message.delivery_status === 'released' &&
    message.delivery_updated_at
  ) {
    return message.delivery_updated_at;
  }
  return message.timestamp;
}

export function orderMessagesForTimeline<T extends TimelineMessageLike>(
  messages: readonly T[],
): T[] {
  return messages
    .filter(isMessageVisibleInTimeline)
    .slice()
    .sort((left, right) => {
      const leftTimestamp = getMessageDisplayTimestamp(left);
      const rightTimestamp = getMessageDisplayTimestamp(right);
      if (leftTimestamp === rightTimestamp) {
        return left.id.localeCompare(right.id);
      }
      return leftTimestamp.localeCompare(rightTimestamp);
    });
}

export function applyFollowUpTransition<T extends TimelineMessageLike>(
  messages: readonly T[],
  transition: FollowUpTransitionLike,
): T[] {
  let changed = false;
  const updated = messages.map((message) => {
    if (message.id !== transition.id) return message;
    if (
      message.delivery_status === transition.delivery_status &&
      message.delivery_run_id === (transition.delivery_run_id ?? null) &&
      message.delivery_updated_at === transition.delivery_updated_at
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      delivery_status: transition.delivery_status,
      delivery_run_id:
        transition.delivery_run_id ?? message.delivery_run_id ?? null,
      delivery_updated_at: transition.delivery_updated_at,
    } as T;
  });
  return changed ? updated : (messages as T[]);
}
