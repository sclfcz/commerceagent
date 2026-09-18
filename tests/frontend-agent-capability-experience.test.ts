import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  buildAgentPromptPatch,
  composeAgentPrompt,
  estimatePromptTokens,
  totalPromptStats,
} from '../web/src/utils/agent-prompts';
import { hostSkillPolicyForMode } from '../web/src/utils/agent-runtime-policy';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Agent prompt and capability frontend contract', () => {
  test('composes the same canonical four-part prompt as the runner', () => {
    const prompt = composeAgentPrompt({
      identity_prompt: '  identity body  ',
      soul_prompt: '',
      agents_prompt: 'agents body',
      tools_prompt: 'tools body\n',
    });

    expect(prompt).toBe(
      '## IDENTITY\n  identity body  \n\n## AGENTS\nagents body\n\n## TOOLS\ntools body\n',
    );
    expect(prompt).not.toContain('## SOUL');
  });

  test('reports useful, explicitly estimated prompt size', () => {
    expect(estimatePromptTokens('你好abcd')).toBe(3);
    expect(
      totalPromptStats({
        identity_prompt: '身份',
        soul_prompt: '简洁',
        agents_prompt: '',
        tools_prompt: '',
      }),
    ).toMatchObject({ characters: 4, completedSections: 2 });
  });

  test('sends the complete four-part payload when only identity changes', () => {
    expect(
      buildAgentPromptPatch(
        {
          identity_prompt: 'new identity',
          soul_prompt: 'existing soul',
          agents_prompt: 'existing agents',
          tools_prompt: 'existing tools',
        },
        'append',
        {
          identity_prompt: 'old identity',
          soul_prompt: 'existing soul',
          agents_prompt: 'existing agents',
          tools_prompt: 'existing tools',
          prompt_mode: 'append',
        },
      ),
    ).toEqual({
      identity_prompt: 'new identity',
      soul_prompt: 'existing soul',
      agents_prompt: 'existing agents',
      tools_prompt: 'existing tools',
      prompt_mode: 'append',
      prompt_schema_version: 2,
    });
  });

  test('offers a usable four-part creation wizard, template, and version diff', () => {
    const page = read('web/src/pages/AgentProfilesPage.tsx');
    const editor = read('web/src/components/agents/AgentPromptEditor.tsx');
    const history = read(
      'web/src/components/agents/AgentPromptVersionHistory.tsx',
    );

    expect(page).toMatch(
      /基本信息[\s\S]*四段提示词[\s\S]*宿主机配置[\s\S]*Skills \/ MCP[\s\S]*确认创建/,
    );
    expect(page).toContain('draftStep');
    expect(page).toContain('提示词完成度');
    expect(editor).toContain('一键填入推荐模板');
    expect(editor).toContain('DEFAULT_AGENT_PROMPTS');
    expect(history).toContain('对比当前');
    expect(history).toContain('changedSections');
    expect(history).toContain('<PromptSnapshot');
  });

  test('governs host Skills independently from host Prompt and Rules', () => {
    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const skillEditor = read(
      'web/src/components/agents/AgentSkillsPolicyEditor.tsx',
    );
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );
    const system = read(
      'web/src/components/settings/SystemSettingsSection.tsx',
    );

    expect(profiles).toMatch(
      /CommerceAgent MCP[\s\S]*宿主机 Skills[\s\S]*“能力配置”独立控制/,
    );
    expect(profiles).toContain("skill.source === 'external' && skill.enabled");
    expect(skillEditor).toMatch(/不使用[\s\S]*选择部分[\s\S]*全部使用/);
    expect(skillEditor).toContain('来自 ~/.claude/skills，可单独启用');
    expect(main).toContain('<AgentSkillsPolicyEditor');
    expect(main).toContain("skill.source === 'user' && skill.enabled");
    expect(main).toContain("skill.source === 'external' && skill.enabled");
    expect(system).toContain('宿主机');
  });

  test('treats all host Skills as symbolic inherit and auto-applies existing-profile changes', () => {
    expect(
      hostSkillPolicyForMode('inherit', [
        'old-custom-selection',
        'another-selection',
      ]),
    ).toEqual({ mode: 'inherit', ids: [] });
    expect(
      hostSkillPolicyForMode('custom', ['research', 'research', 'docs']),
    ).toEqual({ mode: 'custom', ids: ['research', 'docs'] });

    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    expect(profiles).toContain('onHostModeChange={handleHostSkillsModeChange}');
    expect(profiles).toContain('void persistHostSkillPolicy(');
    expect(profiles).toMatch(
      /runtime_policy:\s*\{\s*skills:\s*\{\s*host: nextPolicy/,
    );
  });

  test('isolates capability preview failures instead of blanking the page', () => {
    const app = read('web/src/App.tsx');
    const appLayout = read('web/src/components/layout/AppLayout.tsx');
    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );
    const boundary = read('web/src/components/common/ErrorBoundary.tsx');

    expect(appLayout).toMatch(
      /<ErrorBoundary resetKeys=\{\[location\.pathname\]\}>[\s\S]*<Outlet \/>/,
    );
    expect(profiles).toMatch(
      /<ErrorBoundary resetKeys=\{\[selected\.id\]\}>[\s\S]*<EffectiveCapabilitiesPreview/,
    );
    expect(main).toMatch(
      /<ErrorBoundary resetKeys=\{\[profile\.id\]\}>[\s\S]*<EffectiveCapabilitiesPreview/,
    );
    expect(boundary).toMatch(/role="alert"[\s\S]*重试渲染[\s\S]*刷新页面/);
    expect(app).toContain(
      '<Suspense fallback={<AgentProfilesRouteFallback />}>',
    );
    expect(app).toContain('正在加载智能体设置…');
  });

  test('never refills or reveals stored MCP secrets', () => {
    const detail = read('web/src/components/mcp-servers/McpServerDetail.tsx');
    const store = read('web/src/stores/mcp-servers.ts');

    expect(detail).not.toMatch(
      /\bEye\b|EyeOff|showEnvValues|server\.env(?!Keys)|server\.headers(?!Keys)/,
    );
    expect(detail).toContain('密钥不会回填或显示');
    expect(detail).toContain('buildMcpSecretClear');
    expect(detail).toContain('buildMcpSecretReplacement');
    const responseShape = store.slice(
      store.indexOf('export interface McpServer'),
      store.indexOf('interface SyncHostResult'),
    );
    expect(responseShape).not.toContain('env?: Record');
    expect(responseShape).not.toContain('headers?: Record');
  });

  test('keeps each Skill source visible and read-only sources immutable', () => {
    const page = read('web/src/pages/SkillsPage.tsx');
    const card = read('web/src/components/skills/SkillCard.tsx');
    const store = read('web/src/stores/skills.ts');

    expect(page).toMatch(/我的 Skills[\s\S]*CommerceAgent 内置[\s\S]*宿主机/);
    expect(page).toContain('skill.sourceKey');
    expect(card).toContain('isReadonlySkill(skill)');
    expect(card).toContain('skillConflictLabel');
    expect(store).toContain('effective?: boolean');
  });

  test('allows every saved model configuration to be selected by an Agent', () => {
    const profiles = read('web/src/pages/AgentProfilesPage.tsx');
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );

    for (const source of [profiles, main]) {
      expect(source).not.toContain('disabled={!model.enabled}');
      expect(source).toContain("!model.enabled ? '（仅显式使用）' : ''");
    }
  });

  test('lets the main CommerceAgent read and persist its reasoning effort', () => {
    const main = read(
      'web/src/components/settings/MainAgentCapabilitiesSection.tsx',
    );

    expect(main).toContain('aria-label="主 CommerceAgent 推理努力档位"');
    expect(main).toContain(
      "setEffort(profile.runtime_policy.reasoning?.effort ?? 'inherit')",
    );
    expect(main).toMatch(
      /runtime_policy:\s*\{[\s\S]*reasoning: \{ effort \}[\s\S]*skills:/,
    );
    for (const effort of ['inherit', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(main).toContain(`value: '${effort}'`);
    }
  });
});
