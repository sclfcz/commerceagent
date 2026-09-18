import { describe, expect, test } from 'vitest';

import type { Skill } from '../web/src/stores/skills';
import { capabilitySourceLabel } from '../web/src/utils/capability-sources';
import {
  effectiveSkillSource,
  skillConflictLabel,
} from '../web/src/utils/skill-sources';

function skill(overrides: Partial<Skill>): Skill {
  return {
    id: 'deploy',
    name: 'Deploy',
    description: '',
    source: 'external',
    sourceKey: 'external:deploy',
    enabled: true,
    userInvocable: true,
    allowedTools: [],
    argumentHint: null,
    updatedAt: '',
    files: [],
    ...overrides,
  };
}

describe('frontend capability source semantics', () => {
  test('labels every MCP layer returned by the backend', () => {
    expect(capabilitySourceLabel('system')).toBe('系统 MCP');
    expect(capabilitySourceLabel('user')).toBe('我的 MCP');
    expect(capabilitySourceLabel('host')).toBe('宿主机');
    expect(capabilitySourceLabel('workspace')).toBe('工作区项目');
    expect(capabilitySourceLabel('plugin')).toBe('插件');
  });

  test('identifies the effective definition for same-name Skills', () => {
    const shadowed = skill({
      conflictSources: ['project', 'user'],
      effective: false,
    });
    expect(effectiveSkillSource(shadowed)).toBe('user');
    expect(skillConflictLabel(shadowed)).toBe('被我的 Skills覆盖');

    const effective = skill({
      source: 'user',
      sourceKey: 'user:deploy',
      conflictSources: ['external', 'project'],
      effective: true,
    });
    expect(skillConflictLabel(effective)).toBe('当前生效 · 同名来源 3');
  });

  test('does not present a disabled managed collision as effective', () => {
    const disabledManaged = skill({
      source: 'user',
      sourceKey: 'user:deploy',
      enabled: false,
      conflictSources: ['project'],
      effective: false,
      effectiveSource: 'project',
    });

    expect(effectiveSkillSource(disabledManaged)).toBe('project');
    expect(skillConflictLabel(disabledManaged)).toBe('被CommerceAgent 内置覆盖');
    expect(skillConflictLabel(disabledManaged)).not.toContain('当前生效');
  });
});
