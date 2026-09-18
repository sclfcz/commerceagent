export type FeishuActivationMode =
  | 'auto'
  | 'always'
  | 'when_mentioned'
  | 'owner_mentioned'
  | 'disabled';

export interface ActiveFeishuContext {
  contextId: string;
  rootMessageId: string;
}

export interface FeishuConversationPolicyInput {
  chatType?: 'p2p' | 'group';
  chatMode?: string;
  activationMode?: FeishuActivationMode;
  requireMention?: boolean;
  mentionedBot: boolean;
  messageId: string;
  threadId?: string;
  rootId?: string;
  activeContext?: ActiveFeishuContext;
}

export interface FeishuConversationPlan {
  /** A hard stop that cannot be bypassed by mentioning the bot. */
  disabled: boolean;
  /** Whether a group message may pass without mentioning the bot. */
  allowWithoutMention: boolean;
  /** Whether this message belongs to an isolated conversation agent. */
  independentContext: boolean;
  /** Canonical, durable context identity used by im_context_bindings. */
  contextId?: string;
  /** Feishu message used as the reply_in_thread anchor. */
  rootMessageId?: string;
  reason:
    | 'disabled'
    | 'direct'
    | 'shared_chat'
    | 'new_mention_context'
    | 'new_native_topic'
    | 'active_context'
    | 'mention_required';
}

export function requiresMention(
  activationMode: FeishuActivationMode | undefined,
  requireMention: boolean | undefined,
): boolean {
  if (
    activationMode === 'when_mentioned' ||
    activationMode === 'owner_mentioned'
  ) {
    return true;
  }
  if (activationMode === 'always' || activationMode === 'disabled') {
    return false;
  }
  return requireMention === true;
}

export function isMentionActivationMode(
  activationMode: FeishuActivationMode | undefined,
): boolean {
  return (
    activationMode === 'when_mentioned' || activationMode === 'owner_mentioned'
  );
}

export function isFeishuTopicChat(chatMode: string | undefined): boolean {
  return chatMode === 'topic';
}

/**
 * Resolve Feishu activation and session isolation as one deterministic plan.
 *
 * Delivery placement and session identity intentionally remain separate:
 * an ordinary always-on group may reply inside an existing Feishu thread while
 * still sharing the group's single Agent session.
 */
export function resolveFeishuConversationPlan(
  input: FeishuConversationPolicyInput,
): FeishuConversationPlan {
  if (input.activationMode === 'disabled') {
    return {
      disabled: true,
      allowWithoutMention: false,
      independentContext: false,
      reason: 'disabled',
    };
  }

  if (input.chatType === 'p2p' || input.chatMode === 'p2p') {
    return {
      disabled: false,
      allowWithoutMention: true,
      independentContext: false,
      reason: 'direct',
    };
  }

  const mentionRequired = requiresMention(
    input.activationMode,
    input.requireMention,
  );
  const topicChat = isFeishuTopicChat(input.chatMode);

  // A real Feishu topic/thread keeps its durable identity even when the user
  // mentions the bot again inside that topic. Mentions inside an established
  // thread must never create nested conversation agents.
  if (
    input.activeContext &&
    (topicChat || (mentionRequired && input.threadId))
  ) {
    return {
      disabled: false,
      allowWithoutMention: true,
      independentContext: true,
      contextId: input.activeContext.contextId,
      rootMessageId: input.activeContext.rootMessageId,
      reason: 'active_context',
    };
  }

  if (topicChat) {
    if (mentionRequired && !input.mentionedBot) {
      return {
        disabled: false,
        allowWithoutMention: false,
        independentContext: false,
        reason: 'mention_required',
      };
    }
    const contextId = input.threadId || input.rootId || input.messageId;
    return {
      disabled: false,
      allowWithoutMention: !mentionRequired,
      independentContext: true,
      contextId,
      rootMessageId: input.rootId || input.messageId || contextId,
      reason: 'new_native_topic',
    };
  }

  // Feishu can deliver the first bot mention from an already-existing native
  // thread before CommerceAgent has created its durable context binding. Preserve
  // that native thread identity instead of anchoring a second, nested topic to
  // the triggering message. Once admitted, subsequent messages resolve via
  // the active-context branch above and no longer require another mention.
  if (mentionRequired && input.threadId) {
    if (!input.mentionedBot) {
      return {
        disabled: false,
        allowWithoutMention: false,
        independentContext: false,
        reason: 'mention_required',
      };
    }
    return {
      disabled: false,
      allowWithoutMention: false,
      independentContext: true,
      contextId: input.threadId,
      rootMessageId: input.rootId || input.messageId,
      reason: 'new_native_topic',
    };
  }

  if (!mentionRequired) {
    return {
      disabled: false,
      allowWithoutMention: true,
      independentContext: false,
      reason: 'shared_chat',
    };
  }

  if (!input.mentionedBot) {
    // Feishu may omit thread_id on an early follow-up while still supplying
    // root_id. The durable binding is authoritative for an unmentioned
    // follow-up, so it remains in the already-active topic.
    if (input.activeContext) {
      return {
        disabled: false,
        allowWithoutMention: true,
        independentContext: true,
        contextId: input.activeContext.contextId,
        rootMessageId: input.activeContext.rootMessageId,
        reason: 'active_context',
      };
    }
    return {
      disabled: false,
      allowWithoutMention: false,
      independentContext: false,
      reason: 'mention_required',
    };
  }

  // In an ordinary group, every valid mention outside a real Feishu thread
  // starts a new topic anchored to the mentioned message itself. A native
  // root_id here can describe an ordinary reply chain; inheriting it would
  // incorrectly merge the new request into an older Agent session. The old
  // chain remains useful only as bounded referenced context.
  const rootMessageId = input.messageId;
  return {
    disabled: false,
    allowWithoutMention: false,
    independentContext: true,
    contextId: rootMessageId,
    rootMessageId,
    reason: 'new_mention_context',
  };
}
