import type { ChannelAccount, RegisteredGroup } from './types.js';

export interface ChannelAccountFallbackWorkspace {
  jid: string;
  folder: string;
}

/** Account routing is workspace-owned. A deprecated Agent default must never
 * pick that Agent's arbitrary first workspace. */
export function resolveChannelAccountFallbackWorkspace(
  account: ChannelAccount,
  lookup: {
    getGroup: (jid: string) => RegisteredGroup | undefined;
    getHome: (
      ownerUserId: string,
    ) => (RegisteredGroup & { jid: string }) | undefined;
  },
): ChannelAccountFallbackWorkspace | null {
  if (account.default_workspace_jid) {
    const group = lookup.getGroup(account.default_workspace_jid);
    if (group?.created_by === account.owner_user_id) {
      return { jid: account.default_workspace_jid, folder: group.folder };
    }
  }
  const home = lookup.getHome(account.owner_user_id);
  return home ? { jid: home.jid, folder: home.folder } : null;
}

/**
 * Attach an inbound chat to its channel account without changing a binding the
 * user already selected. Account defaults are only a registration fallback;
 * they must never turn every subsequent IM message into a binding update.
 * Returns the input object unchanged when nothing needs to move, so callers
 * can skip persistence — every inbound message funnels through this path, and
 * an unconditional setRegisteredGroup costs ~10 statements per message.
 */
export function applyChannelAccountRegistrationFallback(
  group: RegisteredGroup,
  accountId: string,
  fallbackWorkspaceJid: string,
): RegisteredGroup {
  const hasExplicitBinding = Boolean(
    group.target_main_jid || group.target_agent_id,
  );
  const nextAccountId = group.channel_account_id ?? accountId;
  const changed =
    nextAccountId !== group.channel_account_id ||
    (!hasExplicitBinding && group.target_main_jid !== fallbackWorkspaceJid);
  if (!changed) return group;
  return {
    ...group,
    channel_account_id: nextAccountId,
    ...(hasExplicitBinding ? {} : { target_main_jid: fallbackWorkspaceJid }),
  };
}
