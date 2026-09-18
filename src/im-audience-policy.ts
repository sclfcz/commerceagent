import type { AudienceMode, RegisteredGroup } from './types.js';

export function parseAudienceMode(raw: unknown): AudienceMode {
  return raw === 'owner_only' ? 'owner_only' : 'everyone';
}

/**
 * `owner_mentioned` is retained as a read-time compatibility fallback for
 * databases/config clients that have not yet passed through the v58 migration.
 */
export function effectiveAudienceMode(
  group: Pick<RegisteredGroup, 'audience_mode' | 'activation_mode'>,
): AudienceMode {
  if (group.audience_mode) return parseAudienceMode(group.audience_mode);
  return group.activation_mode === 'owner_mentioned'
    ? 'owner_only'
    : 'everyone';
}

/** Audience is evaluated before mention/topic activation on every message. */
export function isSenderAllowedByAudience(
  group: Pick<
    RegisteredGroup,
    'audience_mode' | 'activation_mode' | 'owner_im_id'
  >,
  senderImId?: string,
): boolean {
  if (effectiveAudienceMode(group) === 'everyone') return true;
  return (
    !!senderImId && !!group.owner_im_id && senderImId === group.owner_im_id
  );
}

/** First-DM bootstrap: claim is open only until an account owner is known. */
export function isUnknownFeishuSenderAllowed(
  knownOwnerImId: string | undefined,
  senderImId: string | undefined,
): boolean {
  return !knownOwnerImId || (!!senderImId && senderImId === knownOwnerImId);
}

export function normalizeLegacyOwnerMention(input: {
  activationMode?: RegisteredGroup['activation_mode'];
  audienceMode?: AudienceMode;
}): {
  activationMode?: RegisteredGroup['activation_mode'];
  audienceMode?: AudienceMode;
} {
  if (input.activationMode !== 'owner_mentioned') return input;
  return {
    activationMode: 'when_mentioned',
    audienceMode: 'owner_only',
  };
}
