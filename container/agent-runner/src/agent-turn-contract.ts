export interface AgentTurnProfile {
  id: string;
  name: string;
  version: number;
  identityHash: string;
  identityPrompt?: string;
}

export const AGENT_TURN_ANCHOR_MAX_CHARS = 16_000;

export interface AgentTurnAnchor {
  contract: string;
  audit: {
    provider: 'custom';
    maxChars: number;
    sourceChars: number;
    anchoredChars: number;
    truncated: boolean;
    estimatedTokens: number;
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Repeat the selected AgentProfile beside each user turn.
 *
 * Some Claude-compatible providers preserve Claude Code memory and user
 * messages but do not reliably honor a custom SDK systemPrompt. Keeping the
 * canonical system block remains important for providers that do; this small
 * compatibility anchor makes the same Agent contract explicit at the turn
 * boundary without changing the user-visible message stored by CommerceAgent.
 */
export function resolveAgentTurnAnchor(
  profile: AgentTurnProfile | undefined,
  endpointKind: 'official' | 'custom',
  maxChars = AGENT_TURN_ANCHOR_MAX_CHARS,
): AgentTurnAnchor | undefined {
  const sourcePrompt = profile?.identityPrompt?.trim();
  if (!profile || !sourcePrompt || endpointKind !== 'custom') return undefined;

  const safeMaxChars = Math.max(1_000, maxChars);
  const truncated = sourcePrompt.length > safeMaxChars;
  const truncationMarker =
    '\n\n[Agent 契约过长，兼容锚点已省略中间部分；完整版本仍在 system prompt 中。]\n\n';
  const contentBudget = Math.max(1, safeMaxChars - truncationMarker.length);
  const headChars = Math.floor(contentBudget * 0.75);
  const profilePrompt = truncated
    ? `${sourcePrompt.slice(0, headChars)}${truncationMarker}${sourcePrompt.slice(-(contentBudget - headChars))}`
    : sourcePrompt;
  const contract = [
    `<active-agent-turn-contract profile_id="${escapeAttribute(profile.id)}" name="${escapeAttribute(profile.name)}" version="${profile.version}" hash="${escapeAttribute(profile.identityHash)}">`,
    '这是平台为当前会话选定的 Agent 工作契约。请在处理下面这条用户消息时实际执行它；如果用户消息已经匹配契约定义的输入格式或触发条件，直接执行对应流程，不要再次询问用户想做什么。用户最新的明确指令仍然优先。',
    profilePrompt,
    '</active-agent-turn-contract>',
  ].join('\n');

  return {
    contract,
    audit: {
      provider: 'custom',
      maxChars: safeMaxChars,
      sourceChars: sourcePrompt.length,
      anchoredChars: profilePrompt.length,
      truncated,
      estimatedTokens: Math.ceil(Buffer.byteLength(contract, 'utf8') / 4),
    },
  };
}

export function anchorAgentProfileToUserTurn(
  anchor: AgentTurnAnchor | undefined,
  userMessage: string,
): string {
  if (!anchor) return userMessage;

  return [
    anchor.contract,
    '<current-user-message>',
    userMessage,
    '</current-user-message>',
  ].join('\n');
}

export function shouldAnchorInitialAgentTurn(
  emitOutput: boolean,
  sourceKind: string | undefined,
): boolean {
  return emitOutput && sourceKind === undefined;
}
