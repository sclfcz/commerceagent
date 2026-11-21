import crypto from 'node:crypto';
import os from 'node:os';

import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config.js';
import { logger } from '../logger.js';
import type { MemoryDatabase } from '../memory-pg/index.js';
import { withWorkspaceMemoryDatabase } from '../memory-store.js';
import { getSystemSettings, type SystemSettings } from '../runtime-config.js';
import { isTrigramSimilarityAvailable, mergeDuplicateBatch } from './dedupe.js';
import { demoteExpiredBatch } from './demote.js';
import {
  acquireConsolidationLease,
  listConsolidationStates,
  recordConsolidationRun,
  releaseConsolidationLease,
  type ConsolidationRunStatus,
  type ConsolidationState,
} from './state.js';

/**
 * Nightly Workspace Memory consolidation.
 *
 * This is host-side background maintenance, not a user-visible scheduled task:
 * it never appears in the task list, never runs in a container, and has no
 * per-workspace prompt. Once per local day (default 03:30, `TZ`) it walks every
 * workspace in turn and makes the store smaller and more honest:
 *
 * 1. expired items are demoted to history (see `demote.ts`);
 * 2. deterministic duplicates are merged into one keeper (see `dedupe.ts`).
 *
 * Both steps only ever add revisions — nothing is deleted.
 *
 * Safety properties:
 *
 * - One workspace at a time, guarded by a lease row, so several service
 *   instances can run this loop without double work.
 * - Bounded work per pass (`batchSize`) and per run (`maxRuntimeMs`); a huge
 *   workspace is finished over several nights, with a `partial` record.
 * - Missed nights are caught up: every tick processes the workspaces whose last
 *   recorded run predates the most recent scheduled instant, so a restart after
 *   03:30 still consolidates once, and a restart before it does not run early.
 */

export interface ConsolidationSettings {
  enabled: boolean;
  /** Local wall-clock time, `HH:MM`. */
  time: string;
  batchSize: number;
  maxRuntimeMs: number;
}

export function resolveConsolidationSettings(
  settings: Pick<
    SystemSettings,
    | 'memoryConsolidationEnabled'
    | 'memoryConsolidationTime'
    | 'memoryConsolidationBatchSize'
    | 'memoryConsolidationMaxRuntimeMs'
  > = getSystemSettings(),
): ConsolidationSettings {
  return {
    enabled: settings.memoryConsolidationEnabled,
    time: settings.memoryConsolidationTime,
    batchSize: settings.memoryConsolidationBatchSize,
    maxRuntimeMs: settings.memoryConsolidationMaxRuntimeMs,
  };
}

/** `03:30` → `30 3 * * *`. */
export function consolidationCronExpression(time: string): string {
  const [hour, minute] = time.split(':');
  return `${Number(minute)} ${Number(hour)} * * *`;
}

/**
 * The most recent scheduled instant at or before `now`, in the deployment's
 * local time. Adding a second first makes "right now, to the minute" count as
 * reached instead of waiting a whole day.
 */
export function lastDueInstant(
  now: Date,
  time: string,
  timeZone: string = TIMEZONE,
): Date {
  return CronExpressionParser.parse(consolidationCronExpression(time), {
    tz: timeZone,
    currentDate: new Date(now.getTime() + 1000),
  })
    .prev()
    .toDate();
}

export function nextDueInstant(
  now: Date,
  time: string,
  timeZone: string = TIMEZONE,
): Date {
  return CronExpressionParser.parse(consolidationCronExpression(time), {
    tz: timeZone,
    currentDate: now,
  })
    .next()
    .toDate();
}

/**
 * A workspace is due when it has never run or when its last run is older than
 * the latest scheduled instant. This single rule serves both the nightly tick
 * and the startup catch-up.
 */
export function isConsolidationDue(
  state: Pick<ConsolidationState, 'lastRunAt'> | undefined,
  now: Date,
  time: string,
  timeZone: string = TIMEZONE,
): boolean {
  if (!state?.lastRunAt) return true;
  const lastRunMs = new Date(state.lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) return true;
  return lastRunMs < lastDueInstant(now, time, timeZone).getTime();
}

export interface WorkspaceConsolidationResult {
  workspaceJid: string;
  status: ConsolidationRunStatus;
  /** Item rows scanned by all passes (an item can be scanned more than once). */
  processed: number;
  /** Duplicates retired into their keeper. */
  merged: number;
  /** Items demoted as expired or out of validity. */
  demoted: number;
  /** Groups deferred because a concurrent edit invalidated the plan. */
  skippedGroups: number;
  error: string | null;
  durationMs: number;
  leaseHeld?: boolean;
}

export interface ConsolidationRunSummary {
  reason: ConsolidationRunReason;
  startedAt: string;
  finishedAt: string;
  disabled: boolean;
  workspaces: WorkspaceConsolidationResult[];
  processed: number;
  merged: number;
  demoted: number;
  skippedGroups: number;
}

export type ConsolidationRunReason = 'scheduled' | 'startup' | 'manual';

/**
 * Consolidate one already-leased workspace, in bounded passes.
 *
 * Demotion runs before dedupe so an item that is about to expire is not first
 * merged into another item as though it were still current.
 */
async function consolidateWorkspace(
  db: MemoryDatabase,
  options: {
    workspaceJid: string;
    storeId: string;
    settings: ConsolidationSettings;
    clock: () => Date;
    trigramAvailable: boolean;
  },
): Promise<{
  processed: number;
  merged: number;
  demoted: number;
  skippedGroups: number;
  partial: boolean;
}> {
  const deadline = options.clock().getTime() + options.settings.maxRuntimeMs;
  let processed = 0;
  let merged = 0;
  let demoted = 0;
  let skippedGroups = 0;
  for (;;) {
    if (options.clock().getTime() >= deadline) {
      return { processed, merged, demoted, skippedGroups, partial: true };
    }
    const demotion = await demoteExpiredBatch(db, {
      storeId: options.storeId,
      limit: options.settings.batchSize,
      now: options.clock(),
    });
    processed += demotion.scanned;
    demoted += demotion.demoted;

    if (options.clock().getTime() >= deadline) {
      return { processed, merged, demoted, skippedGroups, partial: true };
    }
    const dedupe = await mergeDuplicateBatch(db, {
      storeId: options.storeId,
      workspaceJid: options.workspaceJid,
      limit: options.settings.batchSize,
      trigramAvailable: options.trigramAvailable,
      now: options.clock(),
    });
    processed += dedupe.scanned;
    merged += dedupe.merged;
    skippedGroups += dedupe.skippedGroups;

    // Nothing changed: the workspace is stable (a skipped group is retried on
    // the next nightly run, not spun on here).
    if (demotion.demoted === 0 && dedupe.merged === 0) {
      return { processed, merged, demoted, skippedGroups, partial: false };
    }
  }
}

function leaseOwnerId(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

/**
 * Run the consolidation once over the workspaces that are due.
 *
 * Every workspace is leased, consolidated and recorded independently: one
 * failing workspace never stops the others, and its failure is visible in the
 * recorded state.
 */
export async function runMemoryConsolidation(
  options: {
    reason: ConsolidationRunReason;
    now?: Date;
    settings?: ConsolidationSettings;
    /** Restrict the run (tests and manual triggers). */
    workspaceJids?: string[];
    clock?: () => Date;
    owner?: string;
  } = { reason: 'manual' },
): Promise<ConsolidationRunSummary> {
  return await withWorkspaceMemoryDatabase((db) =>
    runMemoryConsolidationOnDatabase(db, options),
  );
}

/**
 * `runMemoryConsolidation` on a caller-provided database connection.
 *
 * Tests use this to run two consolidation workers, each with its own
 * connection pool, over the same external PostgreSQL database — the deployment
 * shape the lease protects. Product code goes through
 * `runMemoryConsolidation`.
 */
export async function runMemoryConsolidationOnDatabase(
  db: MemoryDatabase,
  options: {
    reason: ConsolidationRunReason;
    now?: Date;
    settings?: ConsolidationSettings;
    /** Restrict the run (tests and manual triggers). */
    workspaceJids?: string[];
    clock?: () => Date;
    owner?: string;
  } = { reason: 'manual' },
): Promise<ConsolidationRunSummary> {
  const clock = options.clock ?? (() => new Date());
  const settings = options.settings ?? resolveConsolidationSettings();
  const startedAt = (options.now ?? clock()).toISOString();
  const owner = options.owner ?? leaseOwnerId();
  const summary: ConsolidationRunSummary = {
    reason: options.reason,
    startedAt,
    finishedAt: startedAt,
    disabled: !settings.enabled,
    workspaces: [],
    processed: 0,
    merged: 0,
    demoted: 0,
    skippedGroups: 0,
  };
  if (!settings.enabled) {
    logger.info('Workspace Memory consolidation disabled by settings');
    return summary;
  }

  const stores = await db.query<{ workspace_jid: string; id: string }>(
    `SELECT id, workspace_jid FROM workspace_memory_stores
     ORDER BY workspace_jid`,
  );
  const wanted = options.workspaceJids ? new Set(options.workspaceJids) : null;
  const states = new Map(
    (await listConsolidationStates(db)).map((state) => [
      state.workspaceJid,
      state,
    ]),
  );
  const trigramAvailable = await isTrigramSimilarityAvailable(db);
  if (!trigramAvailable) {
    logger.info(
      'Workspace Memory consolidation runs without pg_trgm; similar-text duplicate groups are skipped and only exact duplicate arms are merged',
    );
  }

  for (const store of stores.rows) {
    const workspaceJid = store.workspace_jid;
    if (wanted && !wanted.has(workspaceJid)) continue;
    if (!isConsolidationDue(states.get(workspaceJid), clock(), settings.time))
      continue;

    const acquired = await acquireConsolidationLease(db, {
      workspaceJid,
      owner,
      now: clock(),
      ttlMs: settings.maxRuntimeMs + 60_000,
    });
    if (!acquired) {
      logger.info(
        { workspaceJid },
        'Workspace Memory consolidation skipped: another instance holds the lease',
      );
      summary.workspaces.push({
        workspaceJid,
        status: 'success',
        processed: 0,
        merged: 0,
        demoted: 0,
        skippedGroups: 0,
        error: null,
        durationMs: 0,
        leaseHeld: true,
      });
      continue;
    }

    const workspaceStartedAt = clock();
    let result: WorkspaceConsolidationResult;
    try {
      // Another instance may have completed between the initial due snapshot
      // and our lease acquisition. The lease serializes work, but does not by
      // itself make that earlier snapshot current again.
      const latest = await db.query<{ last_run_at: string | null }>(
        `SELECT last_run_at FROM workspace_memory_consolidation_state
         WHERE workspace_jid = $1`,
        [workspaceJid],
      );
      if (
        !isConsolidationDue(
          { lastRunAt: latest.rows[0]?.last_run_at ?? null },
          clock(),
          settings.time,
        )
      ) {
        await releaseConsolidationLease(db, {
          workspaceJid,
          owner,
          now: clock(),
        });
        continue;
      }
      const outcome = await consolidateWorkspace(db, {
        workspaceJid,
        storeId: store.id,
        settings,
        clock,
        trigramAvailable,
      });
      result = {
        workspaceJid,
        status: outcome.partial ? 'partial' : 'success',
        processed: outcome.processed,
        merged: outcome.merged,
        demoted: outcome.demoted,
        skippedGroups: outcome.skippedGroups,
        error: null,
        durationMs: Math.max(
          0,
          clock().getTime() - workspaceStartedAt.getTime(),
        ),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(
        { err: error, workspaceJid },
        'Workspace Memory consolidation failed for workspace',
      );
      result = {
        workspaceJid,
        status: 'error',
        processed: 0,
        merged: 0,
        demoted: 0,
        skippedGroups: 0,
        error: message,
        durationMs: Math.max(
          0,
          clock().getTime() - workspaceStartedAt.getTime(),
        ),
      };
    }
    try {
      await recordConsolidationRun(db, {
        workspaceJid,
        finishedAt: clock(),
        status: result.status,
        processed: result.processed,
        merged: result.merged,
        demoted: result.demoted,
        skippedGroups: result.skippedGroups,
        error: result.error,
        durationMs: result.durationMs,
      });
    } catch (error) {
      logger.warn(
        { err: error, workspaceJid },
        'Failed to record Workspace Memory consolidation result',
      );
    } finally {
      await releaseConsolidationLease(db, {
        workspaceJid,
        owner,
        now: clock(),
      }).catch((error: unknown) =>
        logger.warn(
          { err: error, workspaceJid },
          'Failed to release Workspace Memory consolidation lease',
        ),
      );
    }
    summary.workspaces.push(result);
    summary.processed += result.processed;
    summary.merged += result.merged;
    summary.demoted += result.demoted;
    summary.skippedGroups += result.skippedGroups;
  }
  summary.finishedAt = clock().toISOString();
  if (
    summary.merged > 0 ||
    summary.demoted > 0 ||
    summary.workspaces.length > 0
  ) {
    logger.info(
      {
        reason: summary.reason,
        workspaces: summary.workspaces.length,
        processed: summary.processed,
        merged: summary.merged,
        demoted: summary.demoted,
        skippedGroups: summary.skippedGroups,
      },
      'Workspace Memory consolidation finished',
    );
  }
  return summary;
}

export interface MemoryConsolidationWorkerHandle {
  /** Stops the poll and waits (bounded) for the in-flight run to finish. */
  stop(timeoutMs?: number): Promise<void>;
  runNow(reason?: ConsolidationRunReason): Promise<ConsolidationRunSummary>;
}

/** Re-check the wall clock periodically so settings changes apply promptly. */
export const CONSOLIDATION_POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Start the host-side consolidation loop.
 *
 * The timer polls rather than sleeping to the next occurrence: settings are
 * read from the database-backed file on every check, so a changed time or a
 * disabled worker takes effect within one poll without a restart.
 */
export function startMemoryConsolidationWorker(
  options: {
    clock?: () => Date;
    settings?: () => ConsolidationSettings;
    run?: (
      input: Parameters<typeof runMemoryConsolidation>[0],
    ) => Promise<ConsolidationRunSummary>;
    pollMs?: number;
  } = {},
): MemoryConsolidationWorkerHandle {
  const clock = options.clock ?? (() => new Date());
  const readSettings =
    options.settings ?? (() => resolveConsolidationSettings());
  const run = options.run ?? runMemoryConsolidation;
  const pollMs = options.pollMs ?? CONSOLIDATION_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<ConsolidationRunSummary> | null = null;

  const check = (reason: ConsolidationRunReason) => {
    if (stopped) return Promise.resolve(null);
    const settings = readSettings();
    if (!settings.enabled) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = run({
      reason,
      clock,
      settings,
    })
      .catch((error: unknown) => {
        logger.warn(
          { err: error },
          'Workspace Memory consolidation run failed',
        );
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight.catch(() => null);
  };

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void check('scheduled').finally(arm);
    }, pollMs);
    // Never hold the process open for maintenance work.
    timer.unref?.();
  };

  // Startup catch-up: the same check covers "missed 03:30 while the service was
  // down" and "03:30 passed while we were booting".
  void check('startup').finally(arm);

  return {
    /**
     * Every write the worker makes is a small transaction, so an abandoned run
     * leaves the store consistent; the workspace simply looks "not run yet" and
     * is caught up at the next start. Shutdown therefore waits only briefly.
     */
    async stop(timeoutMs = 30_000) {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const pending = inFlight;
      if (!pending) return;
      const timeout: { timer?: ReturnType<typeof setTimeout> } = {};
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout.timer = setTimeout(resolve, timeoutMs);
          timeout.timer.unref?.();
        }),
      ]);
      if (timeout.timer) clearTimeout(timeout.timer);
    },
    async runNow(reason: ConsolidationRunReason = 'manual') {
      const settings = readSettings();
      return await run({ reason, clock, settings });
    },
  };
}
