import fs from 'node:fs';
import path from 'node:path';

/**
 * A completed isolated run must not be deleted until the host IPC consumer has
 * durably handled every output file.  The marker is written only after the
 * runner exits, so no new send_message/send_image/task request can appear
 * after it.  Both the scheduler and the startup IPC scan may call the cleanup
 * helper; deleting an already-removed directory is intentionally harmless.
 */
export const ISOLATED_TASK_RUN_COMPLETE_MARKER = '.run-complete';

/** The marker lives beside (not inside) the bind-mounted run directory, so an
 * untrusted container cannot forge producer completion and race future writes. */
export function getIsolatedTaskRunCompletionMarker(runDir: string): string {
  return path.join(
    path.dirname(runDir),
    `${ISOLATED_TASK_RUN_COMPLETE_MARKER}-${path.basename(runDir)}.json`,
  );
}

export interface IsolatedTaskRunCompletion {
  taskId: string;
  taskRunId: string;
  /** Durable task_runs.id; taskRunId is only the filesystem namespace. */
  durableRunId?: string;
  workspaceFolder: string;
  virtualChatJid: string;
  sessionAgentId: string;
  completedAt: string;
}

const DURABLE_RUN_NAMESPACE_RE =
  /^task-run-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-attempt-\d+$/i;

/** Recover the durable occurrence id before the completion marker exists. */
export function extractDurableTaskRunIdFromNamespace(
  namespace: string | null | undefined,
): string | null {
  if (!namespace) return null;
  return namespace.match(DURABLE_RUN_NAMESPACE_RE)?.[1] ?? null;
}

/** New IPC requests are disposable only after their result ACK is durable.
 * Legacy requests without requestId keep the historical fire-and-forget path. */
export function canDeleteAcknowledgedIpcSource(
  requestId: string | undefined,
  resultWritten: boolean,
): boolean {
  return !requestId || resultWritten;
}

/**
 * A scheduled-task output file is the durable delivery record until every
 * required IM side effect settles successfully.  Keep this helper separate
 * from the watcher so the ACK ordering can be tested without booting index.ts.
 * A rejected delivery or an exhausted retry (false) rejects the whole batch;
 * the watcher will then archive the source JSON in its error inbox.
 */
export async function awaitRequiredIpcSideEffects(
  deliveries: Iterable<Promise<boolean>>,
): Promise<void> {
  const results = await Promise.allSettled([...deliveries]);
  const failures = results.filter(
    (result) => result.status === 'rejected' || result.value !== true,
  );
  if (failures.length > 0) {
    throw new Error(
      `Failed to complete ${failures.length} required IPC side effect(s)`,
    );
  }
}

export function markIsolatedTaskRunIpcComplete(
  runDir: string,
  completion: Omit<IsolatedTaskRunCompletion, 'completedAt'>,
): void {
  fs.mkdirSync(runDir, { recursive: true });
  const markerPath = getIsolatedTaskRunCompletionMarker(runDir);
  const tempPath = `${markerPath}.${process.pid}.tmp`;
  fs.writeFileSync(
    tempPath,
    JSON.stringify({
      ...completion,
      completedAt: new Date().toISOString(),
    } satisfies IsolatedTaskRunCompletion),
  );
  fs.renameSync(tempPath, markerPath);
}

function hasPendingJsonFiles(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Remove a completed run only after its outbound message and task queues are
 * empty.  The host watcher unlinks/archives each source file only after the
 * corresponding side effect finishes, so "empty" is the durable ACK.  If the
 * process crashes before that point, the marker and files survive and the
 * startup scan resumes delivery before calling this helper again.
 */
export function tryCleanupCompletedIsolatedTaskRunIpc(
  runDir: string,
  beforeRemove?: (completion: IsolatedTaskRunCompletion) => void,
): boolean {
  const markerPath = getIsolatedTaskRunCompletionMarker(runDir);
  if (!fs.existsSync(markerPath)) {
    return false;
  }
  if (
    hasPendingJsonFiles(path.join(runDir, 'messages')) ||
    hasPendingJsonFiles(path.join(runDir, 'tasks'))
  ) {
    return false;
  }
  const completion = JSON.parse(
    fs.readFileSync(markerPath, 'utf-8'),
  ) as IsolatedTaskRunCompletion;
  if (
    !completion ||
    typeof completion.workspaceFolder !== 'string' ||
    typeof completion.virtualChatJid !== 'string' ||
    typeof completion.sessionAgentId !== 'string' ||
    (completion.durableRunId !== undefined &&
      typeof completion.durableRunId !== 'string')
  ) {
    throw new Error(`Invalid isolated task completion marker: ${markerPath}`);
  }
  beforeRemove?.(completion);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(markerPath, { force: true });
  return true;
}
