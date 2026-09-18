import {
  deleteRouterState,
  getAllRegisteredGroups,
  getRouterState,
  isDatabaseInitialized,
  setRouterState,
} from './db.js';
import {
  getWorkspaceRuntimeJids,
  type WorkspaceRuntimeQuiesceTarget,
} from './agent-profile-runtime.js';
import type { WebDeps } from './web-context.js';
import { logger } from './logger.js';

const CLEANUP_STATE_KEY = 'admin_host_only_runtime_cleanup_pending';
export const ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE = 'admin-host-only-policy';

const volatilePendingFolders = new Set<string>();

function normalizeFolders(folders: Iterable<string>): string[] {
  return Array.from(
    new Set(Array.from(folders).filter((folder) => folder.length > 0)),
  ).sort();
}

export function getPendingAdminHostOnlyCleanupFolders(): string[] {
  const folders = new Set(volatilePendingFolders);
  const raw = getRouterState(CLEANUP_STATE_KEY);
  let markerCorrupt = false;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        for (const folder of parsed) {
          if (typeof folder === 'string' && folder.length > 0) {
            folders.add(folder);
          }
        }
      } else {
        markerCorrupt = true;
      }
    } catch {
      markerCorrupt = true;
      logger.error(
        'Invalid admin host-only runtime cleanup marker; conservatively blocking all workspaces',
      );
    }
  }
  if (markerCorrupt) {
    for (const group of Object.values(getAllRegisteredGroups())) {
      folders.add(group.folder);
    }
  }
  return normalizeFolders(folders);
}

/**
 * Persist a fail-closed marker before the mutation pause is released. The
 * volatile copy is installed first so a SQLite failure still leaves an exact
 * retry path for the lifetime of this process.
 */
export function markAdminHostOnlyCleanupPending(
  folders: Iterable<string>,
): void {
  for (const folder of folders) {
    if (folder.length > 0) volatilePendingFolders.add(folder);
  }
  try {
    setRouterState(
      CLEANUP_STATE_KEY,
      JSON.stringify(getPendingAdminHostOnlyCleanupFolders()),
    );
  } catch (error) {
    logger.error(
      { error },
      'Failed to persist admin host-only runtime cleanup marker',
    );
  }
}

export function clearAdminHostOnlyCleanupPending(
  repairedFolders: Iterable<string>,
): void {
  const repaired = new Set(repairedFolders);
  const remaining = getPendingAdminHostOnlyCleanupFolders().filter(
    (folder) => !repaired.has(folder),
  );
  try {
    if (remaining.length > 0) {
      setRouterState(CLEANUP_STATE_KEY, JSON.stringify(remaining));
    } else {
      deleteRouterState(CLEANUP_STATE_KEY);
    }
    volatilePendingFolders.clear();
    for (const folder of remaining) volatilePendingFolders.add(folder);
  } catch (error) {
    // A stale marker is safe: it keeps the runtime blocked and a later exact
    // retry can clear it. Do not erase the volatile repair signal here.
    logger.error(
      { error },
      'Failed to clear admin host-only runtime cleanup marker',
    );
  }
}

export function listWorkspaceRuntimeTargetsForFolders(
  folders: Iterable<string>,
): WorkspaceRuntimeQuiesceTarget[] {
  const requested = new Set(folders);
  const byFolder = new Map<string, WorkspaceRuntimeQuiesceTarget>();
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (!requested.has(group.folder)) continue;
    const existing = byFolder.get(group.folder);
    if (
      !existing ||
      (!existing.primaryJid?.startsWith('web:') && jid.startsWith('web:'))
    ) {
      byFolder.set(group.folder, {
        folder: group.folder,
        primaryJid: jid,
      });
    }
  }
  return Array.from(byFolder.values());
}

export function getRuntimeJidsForTargets(
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

/** Rebuild the fail-closed queue gate after a process restart. */
export function restorePendingAdminHostOnlyRuntimeSafetyBlocks(
  deps: WebDeps,
): void {
  if (!isDatabaseInitialized()) return;
  const pendingFolders = getPendingAdminHostOnlyCleanupFolders();
  if (pendingFolders.length === 0) return;
  const targets = listWorkspaceRuntimeTargetsForFolders(pendingFolders);
  const runtimeJids = getRuntimeJidsForTargets(deps, targets);
  if (runtimeJids.length === 0) return;
  deps.queue.blockGroupsForRuntimeSafety?.(
    runtimeJids,
    `admin host-only runtime cleanup pending after restart: ${pendingFolders.length}`,
    ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
  );
}
