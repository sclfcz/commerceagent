import { channelConversationJid } from './channel-address.js';
import type { RegisteredGroup } from './types.js';

/**
 * Resolve an IPC delivery target to its durable registered conversation.
 *
 * Provider-native routing fragments (for example Feishu thread/root) select
 * where a reply is delivered, but registered_groups stores the stable
 * conversation JID. Authorization must therefore use the stable JID while the
 * original route remains untouched for the connector call.
 */
export function resolveIpcDeliveryTargetGroup(
  chatJid: string,
  lookupGroup: (jid: string) => RegisteredGroup | undefined,
): RegisteredGroup | undefined {
  return lookupGroup(channelConversationJid(chatJid));
}

export interface IpcImRouteInput {
  ipcAgentId?: string | null;
  isHome: boolean;
  chatJid: string;
  sourceGroup: string;
  getActiveRoute: (runtimeJid: string) => string | null;
  getAgentChatJid: (agentId: string) => string | null;
  isImJid: (jid: string) => boolean;
}

/**
 * Resolve the live IM reply route for media IPC.
 *
 * Conversation agents publish their route under the Web conversation's
 * virtual JID (`web:...#agent:...`). Their tool context may carry the current
 * provider-native source JID, so rebuilding the lookup key from `chatJid`
 * points at a key that was never registered. Resolve the Agent's canonical
 * Web JID first instead.
 */
export function resolveIpcImRoute(input: IpcImRouteInput): string | null {
  if (input.ipcAgentId) {
    const agentChatJid = input.getAgentChatJid(input.ipcAgentId);
    if (!agentChatJid) return null;
    return (
      input.getActiveRoute(`${agentChatJid}#agent:${input.ipcAgentId}`) ?? null
    );
  }

  const imFromJid = input.isImJid(input.chatJid) ? input.chatJid : null;
  const imFromGroup = input.getActiveRoute(input.sourceGroup);
  return input.isHome ? (imFromGroup ?? imFromJid) : (imFromJid ?? imFromGroup);
}
