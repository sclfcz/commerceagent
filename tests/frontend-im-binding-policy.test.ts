import { describe, expect, test } from 'vitest';

import {
  resolveBindingActivationMode,
  resolveBindingAudienceMode,
} from '../web/src/utils/im-binding-policy.js';
import type { AvailableImGroup } from '../web/src/types.js';

function makeGroup(
  overrides: Partial<AvailableImGroup> = {},
): AvailableImGroup {
  return {
    jid: 'feishu:chat-a',
    name: 'Feishu chat',
    added_at: '2026-07-22T00:00:00.000Z',
    bound_agent_id: null,
    bound_main_jid: null,
    bound_target_name: null,
    bound_workspace_name: null,
    channel_type: 'feishu',
    ...overrides,
  };
}

describe('IM binding policy selection', () => {
  test('preserves a newly-synced chat durable policy when local form state is absent', () => {
    const group = makeGroup({
      activation_mode: 'always',
      audience_mode: 'owner_only',
    });

    expect(resolveBindingActivationMode(group)).toBe('always');
    expect(resolveBindingAudienceMode(group)).toBe('owner_only');
  });

  test('normalizes the legacy composite owner policy without widening its audience', () => {
    const group = makeGroup({ activation_mode: 'owner_mentioned' });

    expect(resolveBindingActivationMode(group)).toBe('when_mentioned');
    expect(resolveBindingAudienceMode(group)).toBe('owner_only');
  });

  test('uses an explicit user selection instead of the durable fallback', () => {
    const group = makeGroup({
      activation_mode: 'when_mentioned',
      audience_mode: 'owner_only',
    });

    expect(resolveBindingActivationMode(group, 'disabled')).toBe('disabled');
    expect(resolveBindingAudienceMode(group, 'everyone')).toBe('everyone');
  });

  test('rejects invalid stale form values instead of sending them to the API', () => {
    const group = makeGroup();

    expect(resolveBindingActivationMode(group, 'invalid')).toBe('auto');
    expect(resolveBindingAudienceMode(group, 'invalid')).toBe('everyone');
  });
});
