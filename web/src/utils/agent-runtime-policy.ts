import {
  getAgentContextSource,
  type AgentProfileRuntimePolicy,
} from '../types';

export type RuntimePolicyMode = 'inherit' | 'custom' | 'disabled';

export interface SkillSourcePolicy {
  mode: RuntimePolicyMode;
  ids: string[];
}

export const DEFAULT_HOST_SKILL_POLICY: SkillSourcePolicy = {
  mode: 'disabled',
  ids: [],
};

/**
 * Profiles saved before host Skill governance was introduced inherited every
 * host Skill together with host Claude context. Preserve that behavior until
 * the profile is saved with an explicit host policy.
 */
export function getHostSkillPolicy(
  policy?: Partial<AgentProfileRuntimePolicy> | null,
): SkillSourcePolicy {
  const explicit = policy?.skills?.host;
  if (explicit) {
    return {
      mode: explicit.mode ?? 'disabled',
      ids: explicit.ids ?? [],
    };
  }
  return getAgentContextSource(policy) === 'host_claude'
    ? { mode: 'inherit', ids: [] }
    : { ...DEFAULT_HOST_SKILL_POLICY };
}

export function skillSelectionError(
  label: string,
  policy: SkillSourcePolicy,
): string | null {
  if (policy.mode !== 'custom') return null;
  if (policy.ids.length === 0) return `请至少选择一个${label}。`;
  if (policy.ids.length > 100) return `${label}最多选择 100 个。`;
  return null;
}

export function hostSkillPolicyForMode(
  mode: RuntimePolicyMode,
  ids: string[],
): SkillSourcePolicy {
  return {
    mode,
    // Inherit is intentionally symbolic: expanding it would stop future
    // Skills from taking effect and can exceed the API's custom-id limit.
    ids: mode === 'custom' ? [...new Set(ids)] : [],
  };
}

export function skillPolicySummary(
  policy: SkillSourcePolicy,
  allLabel = '全部已启用',
): string {
  if (policy.mode === 'disabled') return '不使用';
  if (policy.mode === 'inherit') return allLabel;
  return `选择 ${policy.ids.length} 项`;
}
