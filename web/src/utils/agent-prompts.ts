export type AgentPromptSection = 'identity' | 'soul' | 'agents' | 'tools';

export type AgentPromptMode = 'append' | 'replace';

export interface AgentPromptParts {
  identity_prompt: string;
  soul_prompt: string;
  agents_prompt: string;
  tools_prompt: string;
}

export const EMPTY_AGENT_PROMPTS: AgentPromptParts = {
  identity_prompt: '',
  soul_prompt: '',
  agents_prompt: '',
  tools_prompt: '',
};

export const DEFAULT_AGENT_PROMPTS: AgentPromptParts = {
  identity_prompt:
    '你是一个专注、可靠的工作智能体。围绕用户交付的目标行动，并清楚说明自己的职责边界。',
  soul_prompt:
    '沟通直接、克制、友好。先给结论，再补充必要依据；不使用夸张赞美，不伪装已经完成的工作。',
  agents_prompt:
    '开始前理解目标与上下文；在授权范围内主动推进。修改后执行相关检查或测试。遇到缺失权限、高风险外部操作或会改变需求方向的选择时，暂停并向用户说明。',
  tools_prompt:
    '根据任务选择最小充分的工具。读取和搜索优先于修改；不在日志或回复中泄露凭据；只有用户明确授权时才发送外部消息或执行不可逆操作。',
};

export const AGENT_PROMPT_SECTIONS: Array<{
  key: AgentPromptSection;
  field: keyof AgentPromptParts;
  eyebrow: string;
  title: string;
  description: string;
  placeholder: string;
}> = [
  {
    key: 'identity',
    field: 'identity_prompt',
    eyebrow: 'IDENTITY',
    title: '身份定位',
    description: '这个智能体是谁、负责什么、不负责什么。',
    placeholder:
      '例如：你是一名产品架构智能体，负责把模糊需求拆成可执行方案，不在未授权时擅自改变外部系统。',
  },
  {
    key: 'soul',
    field: 'soul_prompt',
    eyebrow: 'SOUL',
    title: '人格与表达',
    description: '定义语气、沟通方式和价值判断。',
    placeholder: '例如：先给结论，再说理由；表达直接、克制，不使用夸张的赞美。',
  },
  {
    key: 'agents',
    field: 'agents_prompt',
    eyebrow: 'AGENTS',
    title: '行为规则',
    description: '定义工作流程、边界、检查项和何时停止。',
    placeholder:
      '例如：修改代码前先读取项目规则；每次改动后运行相关测试；需要额外权限时停止并说明原因。',
  },
  {
    key: 'tools',
    field: 'tools_prompt',
    eyebrow: 'TOOLS',
    title: '工具说明',
    description: '定义如何选择工具以及使用工具时必须遵守的规则。',
    placeholder:
      '例如：搜索文件优先使用 rg；只在用户明确要求时发送外部消息；不在日志中输出凭据。',
  },
];

export function estimatePromptTokens(value: string): number {
  if (!value.trim()) return 0;
  // Chinese text is commonly close to one token per character, while Latin
  // prose averages roughly four characters per token. This intentionally stays
  // an estimate so the UI never implies provider-level billing precision.
  const cjk = (value.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

export function composeAgentPrompt(parts: AgentPromptParts): string {
  return AGENT_PROMPT_SECTIONS.flatMap((section) => {
    const value = parts[section.field];
    return value.trim() ? [`## ${section.eyebrow}\n${value}`] : [];
  }).join('\n\n');
}

export function totalPromptStats(parts: AgentPromptParts) {
  const content = composeAgentPrompt(parts);
  return {
    characters: Object.values(parts).reduce(
      (sum, value) => sum + value.length,
      0,
    ),
    estimatedTokens: estimatePromptTokens(content),
    completedSections: Object.values(parts).filter((value) => value.trim())
      .length,
  };
}

export function buildAgentPromptPatch(
  current: AgentPromptParts,
  mode: AgentPromptMode,
  persisted: AgentPromptParts & { prompt_mode: AgentPromptMode },
):
  | (AgentPromptParts & {
      prompt_mode: AgentPromptMode;
      prompt_schema_version: 2;
    })
  | undefined {
  const changed =
    mode !== persisted.prompt_mode ||
    AGENT_PROMPT_SECTIONS.some(
      (section) => current[section.field] !== persisted[section.field],
    );
  return changed
    ? { ...current, prompt_mode: mode, prompt_schema_version: 2 }
    : undefined;
}
