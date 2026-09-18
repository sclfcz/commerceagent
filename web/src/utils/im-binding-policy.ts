import type { AvailableImGroup } from '../types';

export type BindingActivationMode = NonNullable<
  AvailableImGroup['activation_mode']
>;
export type BindingAudienceMode = NonNullable<
  AvailableImGroup['audience_mode']
>;

const ACTIVATION_MODES = new Set<BindingActivationMode>([
  'auto',
  'always',
  'when_mentioned',
  'owner_mentioned',
  'disabled',
]);

/**
 * Resolve the value submitted by the binding dialog without losing the
 * durable policy of a chat that appeared during live discovery. Form state
 * wins only when it contains a valid, explicit user selection.
 */
export function resolveBindingActivationMode(
  group: AvailableImGroup,
  selected?: string | null,
): BindingActivationMode {
  const candidate =
    selected && ACTIVATION_MODES.has(selected as BindingActivationMode)
      ? (selected as BindingActivationMode)
      : group.activation_mode && ACTIVATION_MODES.has(group.activation_mode)
        ? group.activation_mode
        : 'auto';
  return group.channel_type === 'feishu' && candidate === 'owner_mentioned'
    ? 'when_mentioned'
    : candidate;
}

/** Keep audience independent from activation while preserving legacy data. */
export function resolveBindingAudienceMode(
  group: AvailableImGroup,
  selected?: string | null,
): BindingAudienceMode {
  if (selected === 'everyone' || selected === 'owner_only') return selected;
  if (group.activation_mode === 'owner_mentioned') return 'owner_only';
  return group.audience_mode === 'owner_only' ? 'owner_only' : 'everyone';
}
