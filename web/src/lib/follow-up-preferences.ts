export type FollowUpPreference = 'queue' | 'steer';

export const FOLLOW_UP_MODE_KEY = 'happyclaw:follow-up-mode';
export const FOLLOW_UP_MODE_CHANGED_EVENT = 'happyclaw:follow-up-mode-changed';

export function normalizeFollowUpMode(
  value: string | null | undefined,
): FollowUpPreference {
  return value === 'steer' ? 'steer' : 'queue';
}

export function getDefaultFollowUpMode(): FollowUpPreference {
  if (typeof window === 'undefined') return 'queue';
  return normalizeFollowUpMode(window.localStorage.getItem(FOLLOW_UP_MODE_KEY));
}

export function setDefaultFollowUpMode(mode: FollowUpPreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(FOLLOW_UP_MODE_KEY, mode);
  window.dispatchEvent(
    new CustomEvent<FollowUpPreference>(FOLLOW_UP_MODE_CHANGED_EVENT, {
      detail: mode,
    }),
  );
}

export function alternateFollowUpMode(
  mode: FollowUpPreference,
): FollowUpPreference {
  return mode === 'queue' ? 'steer' : 'queue';
}
