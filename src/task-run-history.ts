import { getTaskRunLogs, getTaskRunsForTask } from './db.js';
import type {
  TaskRun,
  TaskRunLog,
  TaskRunNotificationStatus,
  TaskRunStatus,
} from './types.js';

export interface LegacyTaskRunHistory extends Omit<
  TaskRunLog,
  'id' | 'status'
> {
  id: string;
  trigger_type: 'scheduled';
  scheduled_for: string;
  started_at: string;
  completed_at: string | null;
  status: TaskRunStatus;
  attempt: number;
  notification_status: TaskRunNotificationStatus;
  notification_error: null;
}

export type TaskRunHistoryEntry = TaskRun | LegacyTaskRunHistory;

function normalizeLegacyRun(log: TaskRunLog): LegacyTaskRunHistory {
  return {
    ...log,
    id: String(log.id ?? `legacy-${log.run_at}`),
    trigger_type: 'scheduled',
    scheduled_for: log.run_at,
    started_at: log.run_at,
    completed_at:
      log.status === 'running'
        ? null
        : new Date(
            new Date(log.run_at).getTime() + log.duration_ms,
          ).toISOString(),
    status: log.status === 'error' ? 'failed' : log.status,
    attempt: 1,
    notification_status: 'skipped',
    notification_error: null,
  };
}

function historyTimestamp(run: TaskRunHistoryEntry): number {
  return new Date(
    'created_at' in run ? (run.started_at ?? run.created_at) : run.run_at,
  ).getTime();
}

function isLegacyDuplicateOfDurable(
  legacy: LegacyTaskRunHistory,
  durable: TaskRun,
): boolean {
  const legacyTime = new Date(legacy.run_at).getTime();
  const durableTime = new Date(
    durable.started_at ?? durable.created_at,
  ).getTime();
  const compatibleStatus =
    durable.status === legacy.status ||
    (legacy.status === 'queued' && durable.status === 'delivered') ||
    (legacy.status === 'running' &&
      ['queued', 'running', 'retry_wait'].includes(durable.status)) ||
    // Cancelling an in-flight V2 run fences the durable row first. The legacy
    // execution log is finalized independently and may still be `running` or
    // become `error` when the worker observes SIGKILL/AbortSignal. They are two
    // views of the same execution, not two runs. The time window and closest
    // one-to-one matching below keep this compatibility rule from consuming
    // an unrelated nearby failure.
    (durable.status === 'cancelled' &&
      (legacy.status === 'running' || legacy.status === 'failed'));
  return (
    compatibleStatus &&
    Number.isFinite(legacyTime) &&
    Number.isFinite(durableTime) &&
    Math.abs(legacyTime - durableTime) <= 5_000
  );
}

/** Merge pre-V2 logs with durable runs so upgrades never hide old history. */
export function getMergedTaskRunHistory(
  taskId: string,
  limit = 20,
): TaskRunHistoryEntry[] {
  const normalizedLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
  const durableRuns = getTaskRunsForTask(taskId, normalizedLimit);
  // At most one legacy mirror exists per durable run, so this window can skip
  // all mirrors and still fill the requested page with pre-upgrade history.
  const legacyRuns = getTaskRunLogs(
    taskId,
    normalizedLimit + durableRuns.length,
  ).map(normalizeLegacyRun);
  // Fuzzy timestamp matching is necessarily heuristic. Match each durable row
  // to the single closest compatible legacy row; this removes the mirror at
  // the exact execution time without swallowing another real nearby run.
  const duplicateLegacyIndexes = new Set<number>();
  for (const durable of durableRuns) {
    const durableTime = new Date(
      durable.started_at ?? durable.created_at,
    ).getTime();
    let bestIndex = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let index = 0; index < legacyRuns.length; index++) {
      if (duplicateLegacyIndexes.has(index)) continue;
      const legacy = legacyRuns[index];
      if (!isLegacyDuplicateOfDurable(legacy, durable)) continue;
      const delta = Math.abs(new Date(legacy.run_at).getTime() - durableTime);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) duplicateLegacyIndexes.add(bestIndex);
  }
  const dedupedLegacy = legacyRuns.filter(
    (_, index) => !duplicateLegacyIndexes.has(index),
  );
  return [...durableRuns, ...dedupedLegacy]
    .sort((a, b) => {
      const byTime = historyTimestamp(b) - historyTimestamp(a);
      if (byTime !== 0) return byTime;
      // Prefer the authoritative durable row on exact ties, then make the
      // remaining order stable across SQLite/JS runtime variations.
      const aDurable = 'created_at' in a;
      const bDurable = 'created_at' in b;
      if (aDurable !== bDurable) return aDurable ? -1 : 1;
      return String(b.id).localeCompare(String(a.id));
    })
    .slice(0, normalizedLimit);
}
