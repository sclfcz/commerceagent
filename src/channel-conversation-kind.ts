/**
 * Provider-neutral classification for an external channel conversation.
 *
 * Binding policy depends on this value:
 *   - group  -> workspace binding
 *   - direct -> session binding
 *
 * Unknown values deliberately fail closed. In particular, Feishu uses the
 * same opaque `oc_*` identifier for P2P and group chats, so its durable/live
 * metadata is authoritative and the JID alone must never be guessed.
 */
export type ChannelConversationKind = 'direct' | 'group' | 'unknown';

export interface ChannelConversationMetadata {
  /** Live provider value (for example Feishu `p2p`, `group`, or `topic`). */
  chat_mode?: string | null;
  /** Durable Feishu chat mode stored on registered_groups. */
  feishu_chat_mode?: string | null;
}

function baseConversationJid(jid: string): string {
  return jid.split('#', 1)[0];
}

export function resolveChannelConversationKind(
  jid: string,
  metadata: ChannelConversationMetadata = {},
): ChannelConversationKind {
  const baseJid = baseConversationJid(jid);

  if (baseJid.startsWith('feishu:')) {
    const mode = (metadata.chat_mode ?? metadata.feishu_chat_mode)
      ?.trim()
      .toLowerCase();
    if (mode === 'p2p') return 'direct';
    if (mode === 'group' || mode === 'topic') return 'group';
    return 'unknown';
  }

  if (baseJid.startsWith('qq:')) {
    if (baseJid.startsWith('qq:c2c:')) return 'direct';
    if (baseJid.startsWith('qq:group:')) return 'group';
    return 'unknown';
  }

  if (baseJid.startsWith('dingtalk:')) {
    if (baseJid.startsWith('dingtalk:c2c:')) return 'direct';
    return baseJid.length > 'dingtalk:'.length ? 'group' : 'unknown';
  }

  if (baseJid.startsWith('discord:')) {
    if (baseJid.startsWith('discord:dm:')) return 'direct';
    return baseJid.length > 'discord:'.length ? 'group' : 'unknown';
  }

  if (baseJid.startsWith('whatsapp:')) {
    if (baseJid.endsWith('@s.whatsapp.net')) return 'direct';
    if (baseJid.endsWith('@g.us')) return 'group';
    return 'unknown';
  }

  // The current WeChat connector is P2P-only.
  if (baseJid.startsWith('wechat:')) {
    return baseJid.length > 'wechat:'.length ? 'direct' : 'unknown';
  }

  if (baseJid.startsWith('telegram:')) {
    const id = Number(baseJid.slice('telegram:'.length));
    if (!Number.isSafeInteger(id) || id === 0) return 'unknown';
    return id > 0 ? 'direct' : 'group';
  }

  return 'unknown';
}

export function conversationBindingPolicyError(
  kind: ChannelConversationKind,
  target: 'workspace' | 'session',
): string | null {
  if (kind === 'unknown') {
    return 'Unable to determine whether this channel chat is a direct or group conversation; sync the chat metadata and try again';
  }
  if (target === 'workspace' && kind !== 'group') {
    return 'Workspace bindings only accept group chats';
  }
  if (target === 'session' && kind !== 'direct') {
    return 'Session bindings only accept direct chats';
  }
  return null;
}
