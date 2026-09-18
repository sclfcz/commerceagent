import { CHANNEL_PREFIXES } from './channel-prefixes.js';

const ACCOUNT_FRAGMENT = 'account:';

export interface ChannelAddress {
  provider: string;
  externalChatId: string;
  channelAccountId: string | null;
  threadId: string | null;
  rootMessageId: string | null;
  fragments: string[];
  legacy: boolean;
}

function decodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeFragment(value: string): string {
  return encodeURIComponent(value);
}

export function parseChannelAddress(jid: string): ChannelAddress | null {
  const entry = Object.entries(CHANNEL_PREFIXES).find(([, prefix]) =>
    jid.startsWith(prefix),
  );
  if (!entry) return null;
  const [provider, prefix] = entry;
  const [externalChatId, ...fragments] = jid.slice(prefix.length).split('#');
  const account = fragments.find((part) => part.startsWith(ACCOUNT_FRAGMENT));
  const thread = fragments.find((part) => part.startsWith('thread:'));
  const root = fragments.find((part) => part.startsWith('root:'));
  return {
    provider,
    externalChatId,
    channelAccountId: account
      ? decodeFragment(account.slice(ACCOUNT_FRAGMENT.length))
      : null,
    threadId: thread ? decodeFragment(thread.slice('thread:'.length)) : null,
    rootMessageId: root ? decodeFragment(root.slice('root:'.length)) : null,
    fragments,
    legacy: !account,
  };
}

/**
 * Add (or replace) the account scope without changing provider-native route
 * fragments such as Feishu thread/root. Legacy JIDs remain valid inputs.
 */
export function scopeChannelJid(jid: string, channelAccountId: string): string {
  if (!channelAccountId) return jid;
  const parsed = parseChannelAddress(jid);
  if (!parsed) return jid;
  const prefix = CHANNEL_PREFIXES[parsed.provider];
  const fragments = parsed.fragments.filter(
    (part) => !part.startsWith(ACCOUNT_FRAGMENT),
  );
  fragments.unshift(`${ACCOUNT_FRAGMENT}${encodeFragment(channelAccountId)}`);
  return `${prefix}${parsed.externalChatId}${fragments.length ? `#${fragments.join('#')}` : ''}`;
}

/** Remove only CommerceAgent's account fragment before invoking a provider SDK. */
export function toProviderJid(jid: string): string {
  const parsed = parseChannelAddress(jid);
  if (!parsed) return jid;
  const prefix = CHANNEL_PREFIXES[parsed.provider];
  const fragments = parsed.fragments.filter(
    (part) => !part.startsWith(ACCOUNT_FRAGMENT),
  );
  return `${prefix}${parsed.externalChatId}${fragments.length ? `#${fragments.join('#')}` : ''}`;
}

/** Provider SDKs receive IDs without the `provider:` prefix. */
export function extractProviderTarget(jid: string): string {
  const providerJid = toProviderJid(jid);
  const parsed = parseChannelAddress(providerJid);
  if (!parsed) return providerJid;
  return providerJid.slice(CHANNEL_PREFIXES[parsed.provider].length);
}

/** Stable registered-group JID: account + external chat, excluding thread/root. */
export function channelConversationJid(jid: string): string {
  const parsed = parseChannelAddress(jid);
  if (!parsed) return jid.split('#')[0];
  const prefix = CHANNEL_PREFIXES[parsed.provider];
  return parsed.channelAccountId
    ? `${prefix}${parsed.externalChatId}#${ACCOUNT_FRAGMENT}${encodeFragment(parsed.channelAccountId)}`
    : `${prefix}${parsed.externalChatId}`;
}

export function channelAddressKey(input: {
  provider: string;
  channelAccountId: string | null;
  externalChatId: string;
  threadId?: string | null;
}): string {
  return [
    input.provider,
    input.channelAccountId ?? 'legacy',
    input.externalChatId,
    input.threadId ?? '',
  ].join('\u0000');
}

export function isJidForChannelAccount(
  jid: string,
  channelAccountId: string,
): boolean {
  return parseChannelAddress(jid)?.channelAccountId === channelAccountId;
}
