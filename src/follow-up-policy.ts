import type { FollowUpMode } from './types.js';

/**
 * Feishu has no persistent composer mode switch. An ordinary message follows
 * the safe default queue, while replying to the active card is the deliberate
 * "guide this run" gesture. Slash commands remain an explicit override.
 */
export function resolveFeishuFollowUpMode(
  requestedMode: FollowUpMode | undefined,
  repliedToActiveCard: boolean,
): FollowUpMode {
  return requestedMode ?? (repliedToActiveCard ? 'steer' : 'queue');
}
