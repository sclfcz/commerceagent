import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';
import { loadManagedMcpLayers, resolveManagedMcpPolicy } from './mcp-utils.js';
import { getEffectiveExternalDir } from './runtime-config.js';
import { validateSkillId, validateSkillPath } from './skill-utils.js';
import type { AgentProfileRuntimePolicy, AuthUser } from './types.js';

export type HostSkillPolicy = NonNullable<
  AgentProfileRuntimePolicy['skills']['host']
>;

/**
 * Resolve the optional host Skill policy after the effective context source is
 * known. Missing is intentionally a compatibility sentinel for profiles
 * persisted before host Skills became independently configurable.
 */
export function resolveHostSkillPolicy(runtimePolicy: {
  context?: { source?: string };
  skills?: { host?: HostSkillPolicy };
}): HostSkillPolicy {
  return (
    runtimePolicy.skills?.host ??
    (runtimePolicy.context?.source === 'host_claude'
      ? { mode: 'inherit', ids: [] }
      : { mode: 'disabled', ids: [] })
  );
}

export function requestsHostClaudeContext(
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return runtimePolicy?.context?.source === 'host_claude';
}

export function isUnauthorizedHostClaudeContext(
  user: Pick<AuthUser, 'role'>,
  runtimePolicy: { context?: { source?: string } } | undefined,
): boolean {
  return user.role !== 'admin' && requestsHostClaudeContext(runtimePolicy);
}

export function requestsHostSkills(
  runtimePolicy: { skills?: { host?: { mode?: string } } } | undefined,
): boolean {
  const mode = runtimePolicy?.skills?.host?.mode;
  return mode === 'inherit' || mode === 'custom';
}

export function isUnauthorizedHostSkills(
  user: Pick<AuthUser, 'role'>,
  runtimePolicy: { skills?: { host?: { mode?: string } } } | undefined,
): boolean {
  return user.role !== 'admin' && requestsHostSkills(runtimePolicy);
}

export function hasEmptyCustomHostSkillSelection(
  runtimePolicy:
    | { skills?: { host?: { mode?: string; ids?: string[] } } }
    | undefined,
): boolean {
  const host = runtimePolicy?.skills?.host;
  return host?.mode === 'custom' && (host.ids?.length ?? 0) === 0;
}

export function validateRuntimePolicyReferences(
  userId: string,
  policy: AgentProfileRuntimePolicy,
  allowAdminOnlySystemMcp: boolean,
): {
  skills: string[];
  host_skills: string[];
  mcp: string[];
  restricted_system_mcp: string[];
} {
  const invalid = {
    skills: [] as string[],
    host_skills: [] as string[],
    mcp: [] as string[],
    restricted_system_mcp: [] as string[],
  };

  if (policy.skills.mode === 'custom') {
    const root = path.join(DATA_DIR, 'skills', userId);
    for (const id of policy.skills.ids) {
      if (
        !validateSkillId(id) ||
        !fs.existsSync(path.join(root, id, 'SKILL.md'))
      ) {
        invalid.skills.push(id);
      }
    }
  }

  if (policy.skills.host?.mode === 'custom') {
    const root = path.join(getEffectiveExternalDir(), 'skills');
    for (const id of policy.skills.host.ids) {
      const skillDir = path.join(root, id);
      if (
        !validateSkillId(id) ||
        !validateSkillPath(root, skillDir) ||
        !fs.existsSync(path.join(skillDir, 'SKILL.md'))
      ) {
        invalid.host_skills.push(id);
      }
    }
  }

  if (policy.mcp.mode === 'custom') {
    const layers = loadManagedMcpLayers(userId, {
      allowAdminOnlySystemMcp,
    });
    invalid.mcp.push(...resolveManagedMcpPolicy(layers, policy.mcp).missing);
    if (!allowAdminOnlySystemMcp) {
      const restricted = new Set(layers.restrictedSystemIds);
      invalid.restricted_system_mcp.push(
        ...policy.mcp.ids.filter((reference) => {
          if (!reference.startsWith('system:')) return false;
          return restricted.has(reference.slice('system:'.length));
        }),
      );
    }
  }
  return invalid;
}

export function hasInvalidRuntimePolicyReferences(
  invalid: ReturnType<typeof validateRuntimePolicyReferences>,
): boolean {
  return (
    invalid.skills.length + invalid.host_skills.length + invalid.mcp.length > 0
  );
}
