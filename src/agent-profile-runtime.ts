import { createHash } from 'node:crypto';

import type { WebDeps } from './web-context.js';
import {
  computeAgentProfileIdentityHash,
  getAllRegisteredGroups,
  getJidsByFolder,
  getOrCreateDefaultAgentProfile,
  getUserById,
  getWorkspaceAgentProfileId,
} from './db.js';
import { getSystemSettings } from './runtime-config.js';
import type { AgentProfile, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

/**
 * The built-in CommerceAgent identity is code-owned rather than persisted in an
 * editable AgentProfile field. Bump this version whenever the protected
 * identity contract changes so existing SDK sessions restart under it.
 */
export const COMMERCEAGENT_PLATFORM_IDENTITY_VERSION = 1;

export function bindCommerceAgentPlatformIdentityHash(
  identityHash: string,
): string {
  return createHash('sha256')
    .update(
      `commerceagent-platform-identity:v${COMMERCEAGENT_PLATFORM_IDENTITY_VERSION}\0${identityHash}`,
      'utf8',
    )
    .digest('hex');
}

export interface AgentProfileWorkspace {
  jid: string;
  group: RegisteredGroup;
}

export interface WorkspaceRuntimeQuiesceTarget {
  folder: string;
  primaryJid?: string;
}

/**
 * Resolve security-sensitive policy at execution time. Persisted profile data
 * is never sufficient authorization: role downgrades must take effect without
 * rewriting every historical profile.
 */
export function resolveEffectiveAgentProfile(
  profile: AgentProfile | undefined,
): AgentProfile | undefined {
  if (!profile) return undefined;
  const owner = getUserById(profile.owner_user_id);
  const canUseHostResources =
    owner?.role === 'admin' && owner.status === 'active';
  const contextSource = !canUseHostResources
    ? 'managed'
    : profile.is_default
      ? getSystemSettings().mainAgentContextSource
      : profile.runtime_policy.context.source;
  const autoCompactWindow = profile.is_default
    ? getSystemSettings().mainAgentAutoCompactWindow
    : profile.runtime_policy.context.auto_compact_window;
  const autoCompactPercentage = profile.is_default
    ? getSystemSettings().mainAgentAutoCompactPercentage
    : profile.runtime_policy.context.auto_compact_percentage;
  const effectiveSkills =
    !canUseHostResources &&
    profile.runtime_policy.skills.host &&
    profile.runtime_policy.skills.host.mode !== 'disabled'
      ? {
          ...profile.runtime_policy.skills,
          host: {
            mode: 'disabled' as const,
            // Retain requested ids for audit/editing while failing closed.
            ids: profile.runtime_policy.skills.host.ids,
          },
        }
      : profile.runtime_policy.skills;
  const effectiveRuntimePolicy = {
    ...profile.runtime_policy,
    context: {
      ...profile.runtime_policy.context,
      source: contextSource,
      auto_compact_window: autoCompactWindow,
      auto_compact_percentage: autoCompactPercentage,
    },
    skills: effectiveSkills,
  };
  const effectiveIdentityHash = computeAgentProfileIdentityHash(
    profile,
    effectiveRuntimePolicy,
    profile.name,
  );
  return {
    ...profile,
    identity_hash: profile.is_default
      ? bindCommerceAgentPlatformIdentityHash(effectiveIdentityHash)
      : effectiveIdentityHash,
    runtime_policy: effectiveRuntimePolicy,
  };
}

export class WorkspaceRuntimeQuiesceError<T = unknown> extends Error {
  constructor(
    public readonly phase: 'pre_commit' | 'post_commit',
    public readonly failures: Array<{ jid: string; err: unknown }>,
    public readonly committedValue?: T,
  ) {
    super(
      phase === 'pre_commit'
        ? 'Failed to quiesce workspace runtimes before commit'
        : 'Commit succeeded but failed to quiesce workspace runtimes afterward',
    );
    this.name = 'WorkspaceRuntimeQuiesceError';
  }

  get persisted(): boolean {
    return this.phase === 'post_commit';
  }
}

type AgentProfileLockState = {
  tail: Promise<void>;
  references: number;
};

const agentProfileLocks = new Map<string, AgentProfileLockState>();

async function acquireAgentProfileLock(profileId: string): Promise<() => void> {
  let state = agentProfileLocks.get(profileId);
  if (!state) {
    state = { tail: Promise.resolve(), references: 0 };
    agentProfileLocks.set(profileId, state);
  }
  state.references += 1;

  const previous = state.tail;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  state.tail = previous.then(() => gate);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    state!.references -= 1;
    if (state!.references === 0 && agentProfileLocks.get(profileId) === state) {
      agentProfileLocks.delete(profileId);
    }
  };
}

/**
 * Serialize membership/config mutations by top-level AgentProfile. Multiple
 * keys are always acquired in lexical order, so opposite A→B/B→A migrations
 * cannot deadlock. References include queued holders and are removed in the
 * exceptional path as well as success.
 */
export async function withAgentProfileLocks<T>(
  profileIds: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  const orderedIds = Array.from(new Set(profileIds)).sort();
  const releases: Array<() => void> = [];
  try {
    for (const profileId of orderedIds) {
      releases.push(await acquireAgentProfileLock(profileId));
    }
    return await operation();
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      releases[index]();
    }
  }
}

export function listWorkspaceGroupsForAgentProfile(
  ownerUserId: string,
  profileId: string,
): AgentProfileWorkspace[] {
  const defaultProfile = getOrCreateDefaultAgentProfile(ownerUserId);
  return Object.entries(getAllRegisteredGroups())
    .filter(([jid, group]) => {
      if (!jid.startsWith('web:')) return false;
      if (group.created_by !== ownerUserId) return false;
      const mappedProfileId =
        getWorkspaceAgentProfileId(group.folder) ?? defaultProfile.id;
      return mappedProfileId === profileId;
    })
    .map(([jid, group]) => ({ jid, group }));
}

export function getWorkspaceRuntimeJids(
  deps: WebDeps,
  folder: string,
  primaryJid?: string,
): string[] {
  const siblingJids = getJidsByFolder(folder);
  if (primaryJid && !siblingJids.includes(primaryJid)) {
    siblingJids.push(primaryJid);
  }

  const descendantJids = Array.from(
    new Set(siblingJids.flatMap((jid) => deps.queue.listDescendantJids(jid))),
  );
  return Array.from(new Set([...siblingJids, ...descendantJids]));
}

function collectWorkspaceRuntimeJids(
  deps: WebDeps,
  targets: WorkspaceRuntimeQuiesceTarget[],
): string[] {
  return Array.from(
    new Set(
      targets.flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
}

async function forceStopRuntimeJids(
  deps: WebDeps,
  stopJids: string[],
  options?: { preserveQueuedWork?: boolean },
): Promise<Array<{ jid: string; err: unknown }>> {
  const failures: Array<{ jid: string; err: unknown }> = [];
  for (const jid of stopJids) {
    try {
      await deps.queue.stopGroup(
        jid,
        options?.preserveQueuedWork
          ? { force: true, preserveQueuedWork: true }
          : { force: true },
      );
    } catch (err) {
      failures.push({ jid, err });
    }
  }
  return failures;
}

/**
 * Stop every affected runtime, synchronously commit the identity/ownership
 * change, then stop the same (plus newly discovered) runtime JIDs again.
 *
 * The second pass closes the stop-before-persist TOCTOU window. A scoped,
 * ref-counted mutation pause parks accepted work across both passes and stays
 * held while a synchronous or asynchronous commit runs. Therefore a runner
 * created after pass one either exists when pass two starts and is awaited to
 * inactive, or starts only after the pause is released and can observe only
 * the new persisted state. The finally block resumes parked work, so the
 * quiesce cannot drop messages/tasks.
 */
export async function quiesceWorkspaceRunnersAroundCommit<T>(
  deps: WebDeps,
  targets: WorkspaceRuntimeQuiesceTarget[],
  options: {
    reason: string;
    /** Called before the mutation pause is released when commit succeeded but
     * runtime teardown did not. Use it to install a persistent fail-closed
     * queue gate without a resume/drain race. */
    onPostCommitFailure?: (runtimeJids: string[]) => void;
  },
  commit: () => Promise<T> | T,
): Promise<{ value: T; runtimeJids: string[] }> {
  const preCommitJids = collectWorkspaceRuntimeJids(deps, targets);
  // Lock all serialization/folder keys synchronously before the first await.
  // Work arriving for these keys is parked, including work for a descendant
  // JID discovered only by the post-commit pass.
  const pauseToken = deps.queue.pauseGroupsForMutation(preCommitJids);
  try {
    const preCommitFailures = await forceStopRuntimeJids(deps, preCommitJids, {
      preserveQueuedWork: true,
    });
    if (preCommitFailures.length > 0) {
      logger.error(
        {
          phase: 'pre_commit',
          stopJids: preCommitJids,
          failures: preCommitFailures,
          reason: options.reason,
        },
        'Failed to quiesce workspace runtimes before commit',
      );
      throw new WorkspaceRuntimeQuiesceError('pre_commit', preCommitFailures);
    }

    const value = await commit();

    const postCommitJids = Array.from(
      new Set([
        ...preCommitJids,
        ...collectWorkspaceRuntimeJids(deps, targets),
      ]),
    );
    const postCommitFailures = await forceStopRuntimeJids(
      deps,
      postCommitJids,
      { preserveQueuedWork: true },
    );
    if (postCommitFailures.length > 0) {
      options.onPostCommitFailure?.(postCommitJids);
      logger.error(
        {
          phase: 'post_commit',
          stopJids: postCommitJids,
          failures: postCommitFailures,
          reason: options.reason,
        },
        'Commit persisted but post-commit workspace runtime cleanup failed',
      );
      throw new WorkspaceRuntimeQuiesceError(
        'post_commit',
        postCommitFailures,
        value,
      );
    }

    if (postCommitJids.length > 0) {
      logger.info(
        { stopJids: postCommitJids, reason: options.reason },
        'Quiesced workspace runtimes around commit',
      );
    }
    return { value, runtimeJids: postCommitJids };
  } finally {
    // Success and both failure phases release exactly once. Resume drains all
    // accepted messages/manual/scheduled tasks parked during the mutation.
    deps.queue.resumeGroupsAfterMutation(pauseToken);
  }
}

export async function stopWorkspaceRunnersForAgentIdentityChange(
  deps: WebDeps,
  folder: string,
  options: {
    primaryJid?: string;
    reason: string;
  },
): Promise<string[]> {
  const stopJids = getWorkspaceRuntimeJids(deps, folder, options.primaryJid);
  const errors = await forceStopRuntimeJids(deps, stopJids);

  if (errors.length > 0) {
    logger.error(
      { folder, stopJids, errors, reason: options.reason },
      'Failed to stop workspace runners for Agent identity change',
    );
    throw new Error('Failed to stop workspace runners');
  }

  if (stopJids.length > 0) {
    logger.info(
      { folder, stopJids, reason: options.reason },
      'Stopped workspace runners for Agent identity change',
    );
  }

  return stopJids;
}
