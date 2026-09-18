import { describe, expect, test } from 'vitest';
import {
  effectiveAudienceMode,
  isSenderAllowedByAudience,
  isUnknownFeishuSenderAllowed,
  normalizeLegacyOwnerMention,
  parseAudienceMode,
} from '../src/im-audience-policy.js';
import { resolveFeishuConversationPlan } from '../src/feishu-conversation-policy.js';

describe('IM response audience policy', () => {
  test('everyone accepts any identifiable or anonymous sender', () => {
    const group = { audience_mode: 'everyone' as const };
    expect(isSenderAllowedByAudience(group, 'ou_member')).toBe(true);
    expect(isSenderAllowedByAudience(group)).toBe(true);
  });

  test('owner_only accepts exactly the configured owner', () => {
    const group = {
      audience_mode: 'owner_only' as const,
      owner_im_id: 'ou_owner',
    };
    expect(isSenderAllowedByAudience(group, 'ou_owner')).toBe(true);
    expect(isSenderAllowedByAudience(group, 'ou_member')).toBe(false);
    expect(isSenderAllowedByAudience(group)).toBe(false);
  });

  test('owner_only fails closed until owner identity is known', () => {
    expect(
      isSenderAllowedByAudience({ audience_mode: 'owner_only' }, 'ou_member'),
    ).toBe(false);
  });

  test('legacy owner_mentioned is read as owner_only', () => {
    const legacy = {
      activation_mode: 'owner_mentioned' as const,
      owner_im_id: 'ou_owner',
    };
    expect(effectiveAudienceMode(legacy)).toBe('owner_only');
    expect(isSenderAllowedByAudience(legacy, 'ou_owner')).toBe(true);
    expect(isSenderAllowedByAudience(legacy, 'ou_member')).toBe(false);
  });

  test('legacy owner_mentioned normalizes to two independent policies', () => {
    expect(
      normalizeLegacyOwnerMention({ activationMode: 'owner_mentioned' }),
    ).toEqual({
      activationMode: 'when_mentioned',
      audienceMode: 'owner_only',
    });
    expect(
      normalizeLegacyOwnerMention({
        activationMode: 'always',
        audienceMode: 'owner_only',
      }),
    ).toEqual({ activationMode: 'always', audienceMode: 'owner_only' });
  });

  test('unknown persisted values safely fall back to everyone', () => {
    expect(parseAudienceMode('something-new')).toBe('everyone');
  });

  test('first DM bootstraps an unknown owner but cannot bypass a known owner', () => {
    expect(isUnknownFeishuSenderAllowed(undefined, 'ou_first_dm')).toBe(true);
    expect(isUnknownFeishuSenderAllowed('ou_owner', 'ou_owner')).toBe(true);
    expect(isUnknownFeishuSenderAllowed('ou_owner', 'ou_other')).toBe(false);
    expect(isUnknownFeishuSenderAllowed('ou_owner', undefined)).toBe(false);
  });

  test('owner_only combines with always without requiring a mention', () => {
    const group = {
      audience_mode: 'owner_only' as const,
      owner_im_id: 'ou_owner',
    };
    const plan = resolveFeishuConversationPlan({
      chatType: 'group',
      chatMode: 'group',
      activationMode: 'always',
      mentionedBot: false,
      messageId: 'om_1',
    });
    expect(plan.allowWithoutMention).toBe(true);
    expect(isSenderAllowedByAudience(group, 'ou_owner')).toBe(true);
    expect(isSenderAllowedByAudience(group, 'ou_member')).toBe(false);
  });

  test('owner_only still blocks another member inside an activated no-@ topic', () => {
    const group = {
      audience_mode: 'owner_only' as const,
      owner_im_id: 'ou_owner',
    };
    const plan = resolveFeishuConversationPlan({
      chatType: 'group',
      chatMode: 'group',
      activationMode: 'when_mentioned',
      mentionedBot: false,
      messageId: 'om_followup',
      threadId: 'omt_topic',
      rootId: 'om_root',
      activeContext: {
        contextId: 'om_root',
        rootMessageId: 'om_root',
      },
    });
    expect(plan.reason).toBe('active_context');
    expect(plan.allowWithoutMention).toBe(true);
    expect(isSenderAllowedByAudience(group, 'ou_member')).toBe(false);
  });

  test('everyone combines with mention activation without owner filtering', () => {
    const group = { audience_mode: 'everyone' as const };
    const plan = resolveFeishuConversationPlan({
      chatType: 'group',
      chatMode: 'group',
      activationMode: 'when_mentioned',
      mentionedBot: false,
      messageId: 'om_2',
    });
    expect(isSenderAllowedByAudience(group, 'ou_member')).toBe(true);
    expect(plan.allowWithoutMention).toBe(false);
    expect(plan.reason).toBe('mention_required');
  });
});
