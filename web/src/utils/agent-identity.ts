const DEFAULT_AGENT_NAME = 'CommerceAgent';

export interface AgentDisplayIdentity {
  name: string;
  imageUrl?: string;
  emoji?: string;
  color?: string;
  fallbackChar: string;
}

export interface AgentIdentityOptions {
  agentName?: string | null;
  messageSenderName?: string | null;
  avatarUrl?: string | null;
  avatarEmoji?: string | null;
  avatarColor?: string | null;
  mainAvatarUrl?: string | null;
  mainAvatarEmoji?: string | null;
  mainAvatarColor?: string | null;
}

/**
 * Resolve a chat identity from the active Agent. A custom Agent only replaces
 * the global CommerceAgent avatar when it owns at least one avatar field.
 */
export function resolveAgentDisplayIdentity({
  agentName,
  messageSenderName,
  avatarUrl,
  avatarEmoji,
  avatarColor,
  mainAvatarUrl,
  mainAvatarEmoji,
  mainAvatarColor,
}: AgentIdentityOptions = {}): AgentDisplayIdentity {
  const name =
    agentName?.trim() || messageSenderName?.trim() || DEFAULT_AGENT_NAME;
  const hasProfileOverride = !!(avatarUrl || avatarEmoji || avatarColor);
  const imageUrl = hasProfileOverride
    ? avatarUrl || undefined
    : mainAvatarUrl || undefined;
  const emoji = hasProfileOverride
    ? avatarEmoji || undefined
    : mainAvatarEmoji || undefined;
  const color = hasProfileOverride
    ? avatarColor || undefined
    : mainAvatarColor || undefined;

  return {
    name,
    imageUrl:
      imageUrl ||
      (!emoji ? `${import.meta.env.BASE_URL}icons/commerceagent-icon.png` : undefined),
    emoji,
    color,
    fallbackChar: name[0] || 'A',
  };
}
