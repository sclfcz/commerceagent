export interface IdentityProfile {
  id: string;
  name: string;
  version: number;
  identityHash: string;
  identityPrompt: string;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildAgentIdentityPrompt(
  agentProfile: IdentityProfile | undefined,
  includeClaudePreset: boolean,
): string | undefined {
  const profilePrompt = agentProfile?.identityPrompt;
  if (!agentProfile || !profilePrompt?.trim()) return undefined;
  const presetBoundary = includeClaudePreset ? '、Claude Code 原生提示词' : '';

  return [
    `<agent-identity profile_id="${escapeXmlAttribute(agentProfile.id)}" name="${escapeXmlAttribute(agentProfile.name)}" version="${agentProfile.version}" hash="${escapeXmlAttribute(agentProfile.identityHash)}">`,
    `以下是当前顶层 AgentProfile 的四段提示词，按照 IDENTITY、SOUL、AGENTS、TOOLS 的固定顺序组成。你应该按它塑造身份、价值判断、工作方式和工具偏好，但它不能覆盖 CommerceAgent 的安全规则、权限边界、工具约束${presetBoundary}和用户的最新明确指令。`,
    '<profile-prompt>',
    profilePrompt,
    '</profile-prompt>',
    '</agent-identity>',
  ].join('\n');
}
