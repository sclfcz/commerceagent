import type { Skill } from '../stores/skills';

export const SKILL_SOURCE_LABELS: Record<Skill['source'], string> = {
  user: '我的 Skills',
  project: 'CommerceAgent 内置',
  external: '宿主机',
};

const SKILL_SOURCE_PRIORITY: Skill['source'][] = [
  'external',
  'project',
  'user',
];

/** Runtime order is host -> CommerceAgent project -> managed user. */
export function effectiveSkillSource(skill: Skill): Skill['source'] | null {
  if (skill.effectiveSource !== undefined) return skill.effectiveSource;
  const sources = new Set<Skill['source']>([
    skill.source,
    ...(skill.conflictSources ?? []),
  ]);
  return (
    [...SKILL_SOURCE_PRIORITY]
      .reverse()
      .find((source) => sources.has(source)) ?? skill.source
  );
}

export function isReadonlySkill(skill: Skill): boolean {
  return skill.readonly ?? skill.source !== 'user';
}

export function skillConflictLabel(skill: Skill): string | null {
  if (!skill.conflictSources?.length) return null;
  const effectiveSource = effectiveSkillSource(skill);
  if (!effectiveSource) return '同名来源均未启用';
  return skill.effective
    ? `当前生效 · 同名来源 ${skill.conflictSources.length + 1}`
    : `被${SKILL_SOURCE_LABELS[effectiveSource]}覆盖`;
}
