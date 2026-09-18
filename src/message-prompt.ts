import { CHANNEL_PREFIXES } from './channel-prefixes.js';
import type { ChannelReferencedMessage, NewMessage } from './types.js';

export interface FormatMessagesOptions {
  /**
   * Referenced provider message IDs already available in the active SDK
   * transcript or in the recovery history prepended to this prompt.
   */
  knownMessageIds?: ReadonlySet<string>;
}

function parseChannelJid(
  jid: string,
): { channelType: string; chatId: string } | null {
  for (const [channelType, prefix] of Object.entries(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) {
      return { channelType, chatId: jid.slice(prefix.length) };
    }
  }
  return null;
}

const LEGACY_REFERENCE_PREFIX = '[引用消息链（最早到最近）]\n';
const LEGACY_CURRENT_SEPARATOR = '\n[当前消息]\n';

export function splitLegacyEmbeddedReferenceContent(
  content: string,
): { currentContent: string; referenceText: string } | null {
  if (!content.startsWith(LEGACY_REFERENCE_PREFIX)) return null;
  const separatorIndex = content.indexOf(
    LEGACY_CURRENT_SEPARATOR,
    LEGACY_REFERENCE_PREFIX.length,
  );
  if (separatorIndex < 0) return null;
  return {
    referenceText: content.slice(
      LEGACY_REFERENCE_PREFIX.length,
      separatorIndex,
    ),
    currentContent: content.slice(
      separatorIndex + LEGACY_CURRENT_SEPARATOR.length,
    ),
  };
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function referencedMessages(message: NewMessage): ChannelReferencedMessage[] {
  return message.channel_context?.message.referencedMessages ?? [];
}

export function collectReferencedMessageIds(
  messages: NewMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const reference of referencedMessages(message)) {
      if (reference.id) ids.add(reference.id);
    }
  }
  return ids;
}

export function collectKnownReferenceAttachmentIndexes(
  message: NewMessage,
  knownMessageIds: ReadonlySet<string>,
): Set<number> {
  const indexes = new Set<number>();
  for (const reference of referencedMessages(message)) {
    if (!knownMessageIds.has(reference.id)) continue;
    for (const index of reference.attachmentIndexes ?? []) {
      if (Number.isInteger(index) && index >= 0) indexes.add(index);
    }
  }
  return indexes;
}

function formatMissingReference(
  reference: ChannelReferencedMessage,
  knownMessageIds: ReadonlySet<string>,
): string | null {
  const alreadyKnown = knownMessageIds.has(reference.id);
  const body = alreadyKnown
    ? (reference.attachmentHints ?? []).join('\n')
    : reference.text;
  if (!body.trim()) return null;

  const senderAttr = reference.sender
    ? ` sender="${escapeXml(reference.sender)}"`
    : '';
  return `<referenced_message id="${escapeXml(reference.id)}"${senderAttr}>${escapeXml(body)}</referenced_message>`;
}

/**
 * Project persisted messages into an SDK user turn.
 *
 * Provider reply semantics stay structural (`id` + `reply_to`). Quoted bodies
 * are emitted only when the referenced message is absent from the active
 * conversation. This keeps fresh cross-session replies self-contained without
 * duplicating history inside one logical session.
 */
export function formatMessages(
  messages: NewMessage[],
  options: FormatMessagesOptions = {},
): string {
  const knownMessageIds = new Set(options.knownMessageIds ?? []);
  const lines = messages.map((message) => {
    const sourceJid = message.source_jid || message.chat_jid;
    const channel = parseChannelJid(sourceJid);
    const sourceAttr = channel
      ? ` source="${escapeXml(channel.channelType)}:${escapeXml(channel.chatId)}"`
      : '';
    const replyTo = message.channel_context?.message.parentId;
    const replyAttr = replyTo ? ` reply_to="${escapeXml(replyTo)}"` : '';
    const references = referencedMessages(message)
      .map((reference) => formatMissingReference(reference, knownMessageIds))
      .filter((reference): reference is string => !!reference);
    const referenceBlock =
      references.length > 0
        ? `<referenced_messages>\n${references.join('\n')}\n</referenced_messages>\n`
        : '';

    const formatted =
      `<message id="${escapeXml(message.id)}" sender="${escapeXml(message.sender_name)}"` +
      `${sourceAttr}${replyAttr} time="${escapeXml(message.timestamp)}">` +
      `${referenceBlock}${escapeXml(message.content)}</message>`;
    knownMessageIds.add(message.id);
    return formatted;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}
