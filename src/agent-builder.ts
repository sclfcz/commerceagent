import crypto from 'node:crypto';
import path from 'node:path';

import { AgentProfileCreateSchema } from './schemas.js';
import { DATA_DIR } from './config.js';
import { getEffectiveExternalDir } from './runtime-config.js';
import { loadManagedMcpLayers } from './mcp-utils.js';
import { scanSkillDirectory } from './skill-utils.js';
import {
  commitAgentBuilderDraft,
  createAgentProfile,
  discardAgentBuilderDraft,
  getAgentBuilderDraftForUser,
  getAgentProfileForUser,
  listReadyAgentBuilderDraftsForUser,
  listAgentProfilesForUser,
  normalizeAgentProfileRuntimePolicy,
  saveAgentBuilderDraft,
  updateAgentProfile,
} from './db.js';
import {
  hasEmptyCustomHostSkillSelection,
  hasInvalidRuntimePolicyReferences,
  isUnauthorizedHostClaudeContext,
  isUnauthorizedHostSkills,
  validateRuntimePolicyReferences,
} from './agent-profile-policy.js';
import {
  listWorkspaceGroupsForAgentProfile,
  quiesceWorkspaceRunnersAroundCommit,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from './agent-profile-runtime.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from './capability-lock.js';
import { getWebDeps } from './web-context.js';
import type {
  AgentBuilderDefinition,
  AgentBuilderDraft,
  AgentProfile,
  User,
} from './types.js';

export interface AgentBuilderActor {
  user: Pick<User, 'id' | 'role' | 'status'>;
  sourceGroup: string;
  sourceChatJid: string;
  sourceTurnId?: string | null;
  sourceMessageContent?: string | null;
}

export interface AgentBuilderPrepareInput {
  draftId?: string;
  expectedDraftRevision?: number;
  targetAgentProfileId?: string | null;
  expectedAgentVersion?: number;
  definition: unknown;
  assumptions?: string[];
}

function normalizeDefinition(input: unknown): AgentBuilderDefinition {
  const parsed = AgentProfileCreateSchema.safeParse(input);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map(
        (issue) => `${issue.path.join('.') || 'definition'}: ${issue.message}`,
      )
      .join('; ');
    throw new Error(`Agent definition is invalid: ${details}`);
  }
  const policy = normalizeAgentProfileRuntimePolicy(parsed.data.runtime_policy);
  policy.skills.host ??= { mode: 'disabled', ids: [] };
  return {
    name: parsed.data.name,
    identity_prompt: parsed.data.identity_prompt ?? '',
    soul_prompt: parsed.data.soul_prompt ?? '',
    agents_prompt: parsed.data.agents_prompt ?? '',
    tools_prompt: parsed.data.tools_prompt ?? '',
    prompt_mode: parsed.data.prompt_mode ?? 'append',
    avatar_emoji: parsed.data.avatar_emoji ?? null,
    avatar_color: parsed.data.avatar_color ?? null,
    runtime_policy: policy,
  };
}

function validatePromptStructure(definition: AgentBuilderDefinition): void {
  const missing: string[] = [];
  if (!definition.identity_prompt.trim()) missing.push('identity_prompt');
  if (!definition.agents_prompt.trim()) missing.push('agents_prompt');
  if (missing.length === 0) return;
  throw new Error(
    `Agent definition must include substantive ${missing.join(
      ' and ',
    )}. Keep identity_prompt concise (role, mission, boundary) and put workflows, inputs, defaults, refusal rules, and failure handling in agents_prompt. soul_prompt and tools_prompt may be empty when not useful.`,
  );
}

function validateDefinitionForActor(
  actor: AgentBuilderActor,
  definition: AgentBuilderDefinition,
): void {
  if (actor.user.status !== 'active') throw new Error('User is not active');
  validatePromptStructure(definition);
  if (isUnauthorizedHostClaudeContext(actor.user, definition.runtime_policy)) {
    throw new Error('host_claude context requires an admin role');
  }
  if (isUnauthorizedHostSkills(actor.user, definition.runtime_policy)) {
    throw new Error('host skills require an admin role');
  }
  if (hasEmptyCustomHostSkillSelection(definition.runtime_policy)) {
    throw new Error('Custom host skills require at least one selected skill');
  }
  const invalid = validateRuntimePolicyReferences(
    actor.user.id,
    definition.runtime_policy,
    actor.user.role === 'admin',
  );
  if (hasInvalidRuntimePolicyReferences(invalid)) {
    throw new Error(
      `Agent definition references unavailable capabilities: ${JSON.stringify(invalid)}`,
    );
  }
}

function profileDefinition(profile: AgentProfile): AgentBuilderDefinition {
  return {
    name: profile.name,
    identity_prompt: profile.identity_prompt,
    soul_prompt: profile.soul_prompt,
    agents_prompt: profile.agents_prompt,
    tools_prompt: profile.tools_prompt,
    prompt_mode: profile.prompt_mode,
    avatar_emoji: profile.avatar_emoji,
    avatar_color: profile.avatar_color,
    runtime_policy: profile.runtime_policy,
  };
}

function changedFields(
  before: AgentBuilderDefinition | null,
  after: AgentBuilderDefinition,
): string[] {
  if (!before) return Object.keys(after);
  return (Object.keys(after) as Array<keyof AgentBuilderDefinition>).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export function listAgentProfilesForBuilder(ownerUserId: string): {
  profiles: Array<{
    id: string;
    name: string;
    version: number;
    is_default: boolean;
    updated_at: string;
  }>;
  ready_drafts: Array<{
    id: string;
    revision: number;
    name: string;
    target_agent_profile_id: string | null;
    updated_at: string;
  }>;
} {
  return {
    profiles: listAgentProfilesForUser(ownerUserId).map((profile) => ({
      id: profile.id,
      name: profile.name,
      version: profile.version,
      is_default: profile.is_default,
      updated_at: profile.updated_at,
    })),
    ready_drafts: listReadyAgentBuilderDraftsForUser(ownerUserId).map(
      (draft) => ({
        id: draft.id,
        revision: draft.revision,
        name: draft.definition.name,
        target_agent_profile_id: draft.target_agent_profile_id,
        updated_at: draft.updated_at,
      }),
    ),
  };
}

export function getAgentCapabilityCatalogForBuilder(actor: AgentBuilderActor): {
  skills: Array<{ id: string; name: string; description: string }>;
  host_skills: Array<{ id: string; name: string; description: string }>;
  mcp: Array<{ reference: string; scope: 'system' | 'user' }>;
} {
  const skills = scanSkillDirectory(
    path.join(DATA_DIR, 'skills', actor.user.id),
    'user',
  )
    .filter((skill) => skill.enabled)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
    }));
  const hostSkills =
    actor.user.role === 'admin'
      ? scanSkillDirectory(
          path.join(getEffectiveExternalDir(), 'skills'),
          'host',
        )
          .filter((skill) => skill.enabled)
          .map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
          }))
      : [];
  const layers = loadManagedMcpLayers(actor.user.id, {
    allowAdminOnlySystemMcp: actor.user.role === 'admin',
  });
  return {
    skills,
    host_skills: hostSkills,
    mcp: [
      ...Object.keys(layers.system).map((id) => ({
        reference: `system:${id}`,
        scope: 'system' as const,
      })),
      ...Object.keys(layers.user).map((id) => ({
        reference: `user:${id}`,
        scope: 'user' as const,
      })),
    ],
  };
}

export function getAgentProfileForBuilder(
  ownerUserId: string,
  profileId: string,
): { profile: AgentProfile; definition: AgentBuilderDefinition } {
  const profile = getAgentProfileForUser(profileId, ownerUserId);
  if (!profile) throw new Error('Agent not found');
  return { profile, definition: profileDefinition(profile) };
}

export function getAgentBuilderDraftForBuilder(
  ownerUserId: string,
  draftId: string,
): AgentBuilderDraft {
  const draft = getAgentBuilderDraftForUser(draftId, ownerUserId);
  if (!draft) throw new Error('Draft not found');
  return draft;
}

export function prepareAgentBuilderDraft(
  actor: AgentBuilderActor,
  input: AgentBuilderPrepareInput,
): {
  draft: AgentBuilderDraft;
  preview: {
    operation: 'create' | 'update';
    changed_fields: string[];
    affected_workspaces: number;
    confirmation_required: true;
    confirmation_phrase: string;
  };
} {
  const definition = normalizeDefinition(input.definition);
  validateDefinitionForActor(actor, definition);

  const currentDraft = input.draftId
    ? getAgentBuilderDraftForUser(input.draftId, actor.user.id)
    : undefined;
  if (input.draftId && !currentDraft) throw new Error('Draft not found');
  if (currentDraft && currentDraft.state !== 'ready') {
    throw new Error(`Draft is already ${currentDraft.state}`);
  }
  const targetAgentProfileId =
    input.targetAgentProfileId ?? currentDraft?.target_agent_profile_id ?? null;
  const target = targetAgentProfileId
    ? getAgentProfileForUser(targetAgentProfileId, actor.user.id)
    : undefined;
  if (targetAgentProfileId && !target)
    throw new Error('Target Agent not found');
  if (target?.is_default) {
    throw new Error(
      'The main CommerceAgent cannot edit itself through Agent Builder',
    );
  }
  if (
    currentDraft &&
    currentDraft.target_agent_profile_id !== targetAgentProfileId
  ) {
    throw new Error('A draft cannot switch to a different target Agent');
  }

  const baseAgentVersion = target
    ? (currentDraft?.base_agent_version ?? input.expectedAgentVersion)
    : null;
  if (target && baseAgentVersion !== target.version) {
    throw new Error(
      `Agent version conflict: expected ${String(baseAgentVersion)}, current ${target.version}`,
    );
  }
  const assumptions = (input.assumptions ?? currentDraft?.assumptions ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
  const confirmationPhrase = `确认发布 AGENT-${crypto
    .randomBytes(4)
    .toString('hex')
    .toUpperCase()}`;
  const draft = saveAgentBuilderDraft({
    id: currentDraft?.id,
    ownerUserId: actor.user.id,
    sourceGroup: actor.sourceGroup,
    sourceChatJid: actor.sourceChatJid,
    targetAgentProfileId,
    baseAgentVersion: target ? target.version : null,
    expectedRevision: input.expectedDraftRevision,
    definition,
    assumptions,
    preparedTurnId: actor.sourceTurnId,
    confirmationPhrase,
  });
  if (!draft) throw new Error('Draft revision conflict; reload and try again');

  return {
    draft,
    preview: {
      operation: target ? 'update' : 'create',
      changed_fields: changedFields(
        target ? profileDefinition(target) : null,
        definition,
      ),
      affected_workspaces: target
        ? listWorkspaceGroupsForAgentProfile(actor.user.id, target.id).length
        : 0,
      confirmation_required: true,
      confirmation_phrase: draft.confirmation_phrase,
    },
  };
}

export async function publishAgentBuilderDraft(
  actor: AgentBuilderActor,
  draftId: string,
  expectedDraftRevision: number,
): Promise<{
  draft: AgentBuilderDraft;
  profile: AgentProfile;
  invalidated_runtime_jids: number;
}> {
  const returnPublishedDraft = async (
    publishedDraft: AgentBuilderDraft,
  ): Promise<{
    draft: AgentBuilderDraft;
    profile: AgentProfile;
    invalidated_runtime_jids: number;
  } | null> => {
    if (
      publishedDraft.state !== 'published' ||
      !publishedDraft.published_agent_profile_id
    ) {
      return null;
    }
    const profile = getAgentProfileForUser(
      publishedDraft.published_agent_profile_id,
      actor.user.id,
    );
    if (!profile) return null;
    const deps = getWebDeps();
    const workspaces = listWorkspaceGroupsForAgentProfile(
      actor.user.id,
      profile.id,
    );
    const runtimeJids = workspaces.map((workspace) => workspace.jid);
    const needsRuntimeRepair =
      deps != null &&
      runtimeJids.some((jid) => deps.queue.isGroupRuntimeSafetyBlocked(jid));
    if (needsRuntimeRepair && deps && workspaces.length > 0) {
      const result = await quiesceWorkspaceRunnersAroundCommit(
        deps,
        workspaces.map((workspace) => ({
          folder: workspace.group.folder,
          primaryJid: workspace.jid,
        })),
        {
          reason: `Repair Agent Builder runtime cleanup for draft ${publishedDraft.id}`,
          onPostCommitFailure: (failedRuntimeJids) =>
            deps.queue.blockGroupsForRuntimeSafety(
              failedRuntimeJids,
              `Agent Builder draft ${publishedDraft.id} runtime cleanup remains incomplete`,
            ),
        },
        () => ({ draft: publishedDraft, profile }),
      );
      deps.queue.unblockGroupsForRuntimeSafety(result.runtimeJids);
      return {
        ...result.value,
        invalidated_runtime_jids: result.runtimeJids.length,
      };
    }
    return { draft: publishedDraft, profile, invalidated_runtime_jids: 0 };
  };

  const draft = getAgentBuilderDraftForUser(draftId, actor.user.id);
  if (!draft) throw new Error('Draft not found');
  if (draft.revision !== expectedDraftRevision) {
    throw new Error('Draft revision conflict');
  }
  if (draft.state === 'discarded') {
    throw new Error('Draft is no longer publishable');
  }
  if (!draft.confirmation_phrase) {
    throw new Error(
      'This draft predates secure confirmation; prepare it again before publishing',
    );
  }
  if (
    !actor.sourceTurnId ||
    !draft.prepared_turn_id ||
    actor.sourceTurnId === draft.prepared_turn_id ||
    actor.sourceMessageContent?.trim() !== draft.confirmation_phrase
  ) {
    throw new Error(
      `Publishing requires a later human message containing exactly: ${draft.confirmation_phrase}`,
    );
  }
  const alreadyPublished = await returnPublishedDraft(draft);
  if (alreadyPublished) return alreadyPublished;
  if (draft.state !== 'ready') {
    throw new Error(
      'Draft revision conflict or draft is no longer publishable',
    );
  }
  const lockId = draft.target_agent_profile_id ?? `draft:${draft.id}`;
  return withCapabilityScopeLocks(
    [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey(actor.user.id)],
    () =>
      withAgentProfileLocks([lockId], async () => {
        // A concurrent publisher may have completed while this request waited
        // for the lock. Refresh before any state/version decision so duplicate
        // publishes return idempotently and repair a fail-closed runtime gate.
        const currentDraft = getAgentBuilderDraftForUser(
          draft.id,
          actor.user.id,
        );
        if (!currentDraft) throw new Error('Draft not found');
        if (currentDraft.revision !== expectedDraftRevision) {
          throw new Error('Draft revision conflict');
        }
        const concurrentlyPublished = await returnPublishedDraft(currentDraft);
        if (concurrentlyPublished) return concurrentlyPublished;
        if (currentDraft.state !== 'ready') {
          throw new Error('Draft is no longer publishable');
        }
        // Capability deletion and publication share these locks. Revalidate
        // only after both scopes are held so a Skill/MCP cannot disappear in
        // the gap between validation and commit.
        validateDefinitionForActor(actor, currentDraft.definition);
        const target = currentDraft.target_agent_profile_id
          ? getAgentProfileForUser(
              currentDraft.target_agent_profile_id,
              actor.user.id,
            )
          : undefined;
        if (currentDraft.target_agent_profile_id && !target) {
          throw new Error('Target Agent not found');
        }
        if (target?.is_default) {
          throw new Error(
            'The main CommerceAgent cannot edit itself through Agent Builder',
          );
        }
        if (target && target.version !== currentDraft.base_agent_version) {
          throw new Error(
            `Agent version conflict: expected ${currentDraft.base_agent_version}, current ${target.version}`,
          );
        }

        const commit = () => {
          const result = commitAgentBuilderDraft(
            currentDraft.id,
            actor.user.id,
            expectedDraftRevision,
            (currentDraft) => {
              const definition = currentDraft.definition;
              if (!target) {
                return createAgentProfile({
                  profileId: currentDraft.id,
                  ownerUserId: actor.user.id,
                  name: definition.name,
                  identityPrompt: definition.identity_prompt,
                  soulPrompt: definition.soul_prompt,
                  agentsPrompt: definition.agents_prompt,
                  toolsPrompt: definition.tools_prompt,
                  promptMode: definition.prompt_mode,
                  avatarEmoji: definition.avatar_emoji,
                  avatarColor: definition.avatar_color,
                  runtimePolicy: definition.runtime_policy,
                });
              }
              const updated = updateAgentProfile(target.id, actor.user.id, {
                name: definition.name,
                identityPrompt: definition.identity_prompt,
                soulPrompt: definition.soul_prompt,
                agentsPrompt: definition.agents_prompt,
                toolsPrompt: definition.tools_prompt,
                promptMode: definition.prompt_mode,
                avatarEmoji: definition.avatar_emoji,
                avatarColor: definition.avatar_color,
                runtimePolicy: definition.runtime_policy,
              });
              if (!updated) throw new Error('Target Agent disappeared');
              return updated;
            },
          );
          if (!result) throw new Error('Draft revision conflict');
          return result;
        };

        const workspaces = target
          ? listWorkspaceGroupsForAgentProfile(actor.user.id, target.id)
          : [];
        const deps = getWebDeps();
        if (deps && workspaces.length > 0) {
          try {
            const result = await quiesceWorkspaceRunnersAroundCommit(
              deps,
              workspaces.map((workspace) => ({
                folder: workspace.group.folder,
                primaryJid: workspace.jid,
              })),
              {
                reason: `Agent Builder published draft ${currentDraft.id}`,
                onPostCommitFailure: (runtimeJids) =>
                  deps.queue.blockGroupsForRuntimeSafety(
                    runtimeJids,
                    `Agent Builder draft ${currentDraft.id} runtime cleanup failed after publication`,
                  ),
              },
              commit,
            );
            deps.queue.unblockGroupsForRuntimeSafety(result.runtimeJids);
            return {
              ...result.value,
              invalidated_runtime_jids: result.runtimeJids.length,
            };
          } catch (error) {
            if (
              error instanceof WorkspaceRuntimeQuiesceError &&
              error.persisted
            ) {
              const persisted = error.committedValue as ReturnType<
                typeof commit
              >;
              throw new Error(
                `Agent was published but runtime cleanup failed: ${persisted.profile.id}`,
              );
            }
            throw error;
          }
        }
        return { ...commit(), invalidated_runtime_jids: 0 };
      }),
  );
}

export function discardPreparedAgentDraft(
  ownerUserId: string,
  draftId: string,
  expectedDraftRevision: number,
): AgentBuilderDraft {
  const draft = discardAgentBuilderDraft(
    draftId,
    ownerUserId,
    expectedDraftRevision,
  );
  if (!draft) throw new Error('Draft revision conflict or draft not found');
  return draft;
}
