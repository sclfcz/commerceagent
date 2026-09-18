import { describe, expect, test } from 'vitest';
import {
  resolveFeishuConversationPlan,
  type FeishuConversationPolicyInput,
} from '../src/feishu-conversation-policy.js';

const base: FeishuConversationPolicyInput = {
  chatType: 'group',
  chatMode: 'group',
  activationMode: 'always',
  mentionedBot: false,
  messageId: 'om_message',
};

function plan(overrides: Partial<FeishuConversationPolicyInput> = {}) {
  return resolveFeishuConversationPlan({ ...base, ...overrides });
}

describe('Feishu conversation policy', () => {
  test('private chats always share one context without mention semantics', () => {
    expect(
      plan({
        chatType: 'p2p',
        chatMode: 'p2p',
        activationMode: 'when_mentioned',
      }),
    ).toMatchObject({
      disabled: false,
      allowWithoutMention: true,
      independentContext: false,
      reason: 'direct',
    });
  });

  test('disabled is a hard stop for direct and group chats', () => {
    expect(plan({ chatType: 'p2p', activationMode: 'disabled' })).toMatchObject(
      { disabled: true, reason: 'disabled' },
    );
    expect(
      plan({ activationMode: 'disabled', mentionedBot: true }),
    ).toMatchObject({ disabled: true, reason: 'disabled' });
  });

  test('ordinary always-on groups keep thread replies in the shared context', () => {
    expect(
      plan({ threadId: 'omt_manual', rootId: 'om_manual_root' }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: false,
      reason: 'shared_chat',
    });
  });

  test('ordinary mention mode rejects an unmentioned main-timeline message', () => {
    expect(
      plan({ activationMode: 'when_mentioned', mentionedBot: false }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: false,
      reason: 'mention_required',
    });
  });

  test('ordinary top-level mention starts an isolated context anchored to itself', () => {
    expect(
      plan({ activationMode: 'when_mentioned', mentionedBot: true }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: true,
      contextId: 'om_message',
      rootMessageId: 'om_message',
      reason: 'new_mention_context',
    });
  });

  test('ordinary reply-chain mention starts a fresh context on the mentioned message', () => {
    expect(
      plan({
        activationMode: 'when_mentioned',
        mentionedBot: true,
        rootId: 'om_old_chain_root',
        parentId: 'om_old_chain_parent',
        activeContext: {
          contextId: 'om_old_chain_root',
          rootMessageId: 'om_old_chain_root',
        },
      }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: true,
      contextId: 'om_message',
      rootMessageId: 'om_message',
      reason: 'new_mention_context',
    });
  });

  test('ordinary real thread mention stays in its durable active context', () => {
    expect(
      plan({
        activationMode: 'when_mentioned',
        mentionedBot: true,
        threadId: 'omt_active_topic',
        rootId: 'om_active_topic_root',
        parentId: 'om_previous_topic_message',
        activeContext: {
          contextId: 'om_active_topic_root',
          rootMessageId: 'om_active_topic_root',
        },
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      contextId: 'om_active_topic_root',
      rootMessageId: 'om_active_topic_root',
      reason: 'active_context',
    });
  });

  test('first mention inside an existing native thread adopts that thread instead of nesting', () => {
    expect(
      plan({
        activationMode: 'when_mentioned',
        mentionedBot: true,
        threadId: 'omt_existing_topic',
        rootId: 'om_existing_topic_root',
        parentId: 'om_existing_topic_parent',
      }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: true,
      contextId: 'omt_existing_topic',
      rootMessageId: 'om_existing_topic_root',
      reason: 'new_native_topic',
    });
  });

  test('ordinary active topic follows the durable binding without another mention', () => {
    expect(
      plan({
        activationMode: 'when_mentioned',
        threadId: 'omt_returned_later',
        rootId: 'om_message',
        activeContext: {
          contextId: 'om_message',
          rootMessageId: 'om_message',
        },
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      contextId: 'om_message',
      rootMessageId: 'om_message',
      reason: 'active_context',
    });
  });

  test('topic groups isolate every topic in always mode', () => {
    expect(
      plan({
        chatMode: 'topic',
        threadId: 'omt_topic_a',
        rootId: 'om_topic_a',
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      contextId: 'omt_topic_a',
      rootMessageId: 'om_topic_a',
      reason: 'new_native_topic',
    });
  });

  test('topic mention mode requires mention only until the topic is active', () => {
    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        threadId: 'omt_topic_a',
      }),
    ).toMatchObject({
      allowWithoutMention: false,
      independentContext: false,
      reason: 'mention_required',
    });

    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        mentionedBot: true,
        threadId: 'omt_topic_a',
        rootId: 'om_topic_a',
      }),
    ).toMatchObject({
      independentContext: true,
      contextId: 'omt_topic_a',
      reason: 'new_native_topic',
    });

    expect(
      plan({
        chatMode: 'topic',
        activationMode: 'when_mentioned',
        threadId: 'omt_topic_a',
        activeContext: {
          contextId: 'omt_topic_a',
          rootMessageId: 'om_topic_a',
        },
      }),
    ).toMatchObject({
      allowWithoutMention: true,
      independentContext: true,
      reason: 'active_context',
    });
  });

  test('auto mode preserves the legacy require_mention flag', () => {
    expect(
      plan({
        activationMode: 'auto',
        requireMention: true,
        mentionedBot: false,
      }),
    ).toMatchObject({ reason: 'mention_required' });
    expect(
      plan({ activationMode: 'auto', requireMention: false }),
    ).toMatchObject({ reason: 'shared_chat' });
  });
});
