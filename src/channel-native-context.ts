import type { ChannelMessageMeta } from './types.js';

export interface NativeThreadContext {
  contextId: string;
  rootMessageId: string;
  title: string;
}

const TITLE_MAX_LENGTH = 48;

export function summarizeNativeThreadTitle(value?: string): string {
  const firstLine = (value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalized = (firstLine || '渠道话题').replace(/\s+/g, ' ').trim();
  return normalized.length <= TITLE_MAX_LENGTH
    ? normalized
    : `${normalized.slice(0, TITLE_MAX_LENGTH - 1)}…`;
}

/**
 * Normalize legacy Feishu fields and provider-neutral context fields into the
 * one context identity used by im_context_bindings.
 */
export function resolveNativeThreadContext(
  meta?: ChannelMessageMeta,
): NativeThreadContext | null {
  if (!meta) return null;
  const contextId =
    meta.contextId || meta.threadId || meta.rootId || meta.messageId;
  if (!contextId) return null;
  return {
    contextId,
    rootMessageId: meta.rootId || contextId,
    title: summarizeNativeThreadTitle(meta.title || meta.text),
  };
}

/** Preserve the full account-scoped base JID before adding native fragments. */
export function buildNativeThreadRouteJid(
  baseJid: string,
  contextId: string,
  rootMessageId: string,
): string {
  return `${baseJid}#thread:${contextId}#root:${rootMessageId}`;
}
