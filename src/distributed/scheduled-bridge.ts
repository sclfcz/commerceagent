import type { ClaimedTaskRun, TaskRun } from '../types.js';
import {
  claimTaskRunById,
  getTaskRunById,
  getTaskRunsByStatus,
} from '../db.js';
import {
  executeClaimedTaskRun,
  resolveTaskExecutionMode,
  setDistSchedulerHooks,
  type SchedulerDependencies,
} from '../task-scheduler.js';
import type { DistributedConfig } from './config.js';
import { loadDistributedConfig } from './config.js';
import type { RunContext } from './durable.js';
import type { Executor, ExecutorRunContext } from './executors.js';
import { createPool, queryRows, type Pool } from './mysql.js';
import { createRedis } from './redis.js';
import { Reaper } from './reaper.js';
import { RunRepository } from './run-repository.js';
import { TenantSlots } from './tenant-slots.js';
import { Worker } from './worker.js';

/** SQLite statuses that will never change again (`delivered` = group hand-off). */
const TERMINAL = new Set([
  'success',
  'failed',
  'cancelled',
  'missed',
  'delivered',
]);

/** dist `max_attempts`: dispatch attempts only, the retry budget lives in SQLite. */
export const DIST_SCHEDULER_MAX_ATTEMPTS = 20;

export interface ScheduledTaskExecutorOptions {
  repository: RunRepository;
  scheduler: SchedulerDependencies;
  /** SQLite execution lease (TASK_RUN_LEASE_MS). */
  leaseMs: number;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
  /** Injectable seams (tests use the defaults). */
  getRun?: (id: string) => TaskRun | undefined;
  claimRun?: (
    id: string,
    owner: string,
    leaseMs: number,
  ) => ClaimedTaskRun | undefined;
  runClaimed?: (
    claim: ClaimedTaskRun,
    deps: SchedulerDependencies,
  ) => Promise<void>;
}

/**
 * Executes a dist envelope by driving the *legacy* scheduler run.
 *
 * SQLite stays the execution and result authority; the dist run is only a
 * dispatch envelope. Every claim therefore re-reads SQLite and mirrors whatever
 * it finds instead of assuming the run is still ours.
 *
 * The MySQL lease fences *dispatch* only: when it is lost the worker stops
 * writing the dist envelope, but the legacy execution (fenced by its own SQLite
 * lease) is never aborted from here.
 */
export class ScheduledTaskExecutor implements Executor {
  private readonly repository: RunRepository;
  private readonly scheduler: SchedulerDependencies;
  private readonly leaseMs: number;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly getRun: (id: string) => TaskRun | undefined;
  private readonly claimRun: ScheduledTaskExecutorOptions['claimRun'];
  private readonly runClaimed: NonNullable<
    ScheduledTaskExecutorOptions['runClaimed']
  >;

  constructor(options: ScheduledTaskExecutorOptions) {
    this.repository = options.repository;
    this.scheduler = options.scheduler;
    this.leaseMs = options.leaseMs;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? Date.now;
    this.getRun = options.getRun ?? getTaskRunById;
    this.claimRun = options.claimRun ?? claimTaskRunById;
    this.runClaimed = options.runClaimed ?? executeClaimedTaskRun;
  }

  private async mirror(run: ExecutorRunContext, status: string): Promise<void> {
    const applied = await this.repository.complete({
      runId: run.runId,
      workerId: run.workerId,
      leaseToken: run.leaseToken,
      result: { mirroredStatus: status },
    });
    if (!applied)
      this.logger({
        event: 'scheduler_mirror_rejected',
        runId: run.runId,
        status,
      });
  }

  async execute(run: ExecutorRunContext, _ctx: RunContext): Promise<unknown> {
    const taskRunId = String(run.payload?.taskRunId ?? '');
    if (!taskRunId) throw new Error('scheduled_dispatch_payload_missing');

    const snapshot = this.getRun(taskRunId);
    if (!snapshot) {
      await this.mirror(run, 'missing');
      return { mirroredStatus: 'missing' };
    }
    if (TERMINAL.has(snapshot.status)) {
      await this.mirror(run, snapshot.status);
      return { mirroredStatus: snapshot.status };
    }

    const now = this.now();
    const availableAt = new Date(snapshot.available_at).getTime();
    if (
      (snapshot.status === 'queued' || snapshot.status === 'retry_wait') &&
      availableAt > now
    ) {
      await this.repository.release({
        runId: run.runId,
        workerId: run.workerId,
        leaseToken: run.leaseToken,
        retryDelayMs: Math.max(1, availableAt - now),
      });
      return { released: 'not_due' };
    }
    if (snapshot.status === 'running') {
      const leaseUntil = snapshot.lease_expires_at
        ? new Date(snapshot.lease_expires_at).getTime()
        : 0;
      if (leaseUntil > now) {
        await this.repository.release({
          runId: run.runId,
          workerId: run.workerId,
          leaseToken: run.leaseToken,
          retryDelayMs: this.leaseMs,
        });
        return { released: 'running_elsewhere' };
      }
      // Expired and not started: claimable; expired and started: the legacy
      // reaper will mark it failed and the next reconcile mirrors that.
    }

    const owner = `dist:${run.workerId}:${run.leaseToken}`;
    let claim: ClaimedTaskRun | undefined;
    try {
      claim = this.claimRun?.(taskRunId, owner, this.leaseMs);
    } catch (error) {
      // A transient SQLite error must not burn the dist dispatch budget.
      this.logger({
        event: 'scheduler_claim_failed',
        runId: taskRunId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      await this.repository.release({
        runId: run.runId,
        workerId: run.workerId,
        leaseToken: run.leaseToken,
        retryDelayMs: 1_000,
      });
      return { released: 'claim_error' };
    }
    if (!claim) {
      // Lost the race, or the run became non-claimable between the read and the
      // claim (e.g. started-and-expired). Reconcile on the next dispatch.
      await this.repository.release({
        runId: run.runId,
        workerId: run.workerId,
        leaseToken: run.leaseToken,
        retryDelayMs: 1_000,
      });
      return { released: 'claim_lost' };
    }

    try {
      await this.runClaimed(claim, this.scheduler);
    } catch (error) {
      this.logger({
        event: 'scheduler_execution_failed',
        runId: taskRunId,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
    } finally {
      // Re-read instead of trusting the executor's return value: the legacy
      // path can complete, retry or hand off without telling us.
      const after = this.getRun(taskRunId);
      const current = this.now();
      if (after && TERMINAL.has(after.status)) {
        await this.mirror(run, after.status);
      } else if (after?.status === 'retry_wait') {
        await this.repository.release({
          runId: run.runId,
          workerId: run.workerId,
          leaseToken: run.leaseToken,
          retryDelayMs: Math.max(
            1,
            new Date(after.available_at).getTime() - current,
          ),
        });
      } else {
        await this.repository.release({
          runId: run.runId,
          workerId: run.workerId,
          leaseToken: run.leaseToken,
          retryDelayMs: this.leaseMs,
        });
      }
    }
    return { claimed: true };
  }
}

export interface SchedulerForwarderOptions {
  repository: RunRepository;
  scheduler: SchedulerDependencies;
  /** Stable identity for the dist envelope (idempotency key = SQLite run id). */
  tenantOf: (run: TaskRun) => string;
  /** Injected seams (tests). */
  listRuns?: () => TaskRun[];
  logger?: (event: Record<string, unknown>) => void;
  batchLimit?: number;
  intervalMs?: number;
  /** Observer for the dispatch health monitor (never throws into the flush). */
  onFlush?: (result: {
    submitted: number;
    existing: number;
    failed: number;
  }) => void;
}

/**
 * Turns due SQLite occurrences into dist envelopes.
 *
 * The in-memory Set only avoids redundant upserts; correctness comes from the
 * idempotency key, so a restart simply re-submits everything.
 */
export class SchedulerForwarder {
  private readonly repository: RunRepository;
  private readonly tenantOf: (run: TaskRun) => string;
  private readonly scheduler: SchedulerDependencies;
  private readonly listRuns: () => TaskRun[];
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly batchLimit: number;
  private readonly intervalMs: number;
  private readonly onFlush?: SchedulerForwarderOptions['onFlush'];
  private readonly forwarded = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private stopped = true;

  constructor(options: SchedulerForwarderOptions) {
    this.repository = options.repository;
    this.scheduler = options.scheduler;
    this.tenantOf = options.tenantOf;
    this.listRuns =
      options.listRuns ??
      (() =>
        getTaskRunsByStatus(
          ['queued', 'retry_wait'],
          options.batchLimit ?? 200,
        ));
    this.logger = options.logger ?? (() => {});
    this.batchLimit = options.batchLimit ?? 200;
    this.intervalMs = options.intervalMs ?? 1_000;
    this.onFlush = options.onFlush;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    void this.flush();
  }

  wake(): void {
    if (this.stopped) return;
    void this.flush();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Let an in-flight flush finish so we do not leave a half-written batch.
    for (let attempt = 0; attempt < 50 && this.flushing; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }

  async flush(): Promise<{
    submitted: number;
    existing: number;
    failed: number;
  }> {
    if (this.flushing) return { submitted: 0, existing: 0, failed: 0 };
    this.flushing = true;
    let submitted = 0;
    let existing = 0;
    let failed = 0;
    try {
      const runs = this.listRuns().slice(0, this.batchLimit);
      for (const run of runs) {
        if (this.forwarded.has(run.id)) continue;
        const snapshot = run.definition_snapshot;
        const executionMode = schedulerExecutionMode(run, this.scheduler);
        try {
          const result = await this.repository.submit({
            // Same id as the SQLite run: id-keyed operations (cancel) then
            // address the envelope directly instead of guessing.
            id: run.id,
            tenantId: this.tenantOf(run),
            taskId: run.task_id,
            idempotencyKey: run.id,
            maxAttempts: DIST_SCHEDULER_MAX_ATTEMPTS,
            availableAt: new Date(run.available_at),
            payload: {
              taskRunId: run.id,
              taskId: run.task_id,
              contextMode: snapshot.context_mode,
              executionType: snapshot.execution_type,
              executionMode,
              chatJid: snapshot.chat_jid,
              // Host execution has no application-level concurrency cap
              // (CLAUDE.md §4), so those runs must not consume tenant slots.
              skipTenantAdmission: executionMode !== 'container',
            },
          });
          if (result.created) submitted += 1;
          else existing += 1;
          this.forwarded.add(run.id);
          if (result.created)
            this.logger({ event: 'scheduler_forwarded', runId: run.id });
        } catch (error) {
          failed += 1;
          // MySQL down: stop this batch, the next tick resumes.
          this.logger({
            event: 'scheduler_forward_failed',
            runId: run.id,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
          break;
        }
      }
      if (this.forwarded.size > 20_000) this.forwarded.clear();
      const result = { submitted, existing, failed };
      try {
        this.onFlush?.(result);
      } catch {
        // A monitor bug must never break forwarding.
      }
      return result;
    } finally {
      this.flushing = false;
    }
  }
}

export type DispatchHealthState = 'healthy' | 'degraded';

export interface DispatchHealthOptions {
  /** Consecutive forwarder failures that force the legacy claim loop. */
  fallbackAfterFailures: number;
  /** Outage duration that forces the same fallback. */
  fallbackAfterMs: number;
  /** How often a degraded bridge probes MySQL for recovery. */
  probeIntervalMs?: number;
  /** Bound on a single probe so a hung socket cannot stall recovery. */
  probeTimeoutMs?: number;
  /** Consecutive successful probes that reinstall the dispatch hooks. */
  probeSuccesses?: number;
  probe: () => Promise<unknown>;
  onDegrade: (detail: {
    reason: 'consecutive_failures' | 'outage_duration';
    consecutiveFailures: number;
    outageMs: number;
  }) => void;
  onRecover: (detail: { outageMs: number; probeSuccesses: number }) => void;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe_timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Tracks whether the dispatch envelope (MySQL) is usable.
 *
 * When it is not, the scheduler bridge uninstalls its hooks so the pump falls
 * back to the legacy `claimNextTaskRun` loop. That is safe because *both*
 * paths claim the same SQLite row with the same conditions and the same lease
 * fencing, so a run can never be executed twice; the envelopes that pile up
 * while MySQL is down are reconciled to the SQLite outcome afterwards.
 */
export class DispatchHealthMonitor {
  readonly #options: DispatchHealthOptions;
  readonly #now: () => number;
  readonly #probeIntervalMs: number;
  readonly #probeTimeoutMs: number;
  readonly #requiredProbeSuccesses: number;
  #state: DispatchHealthState = 'healthy';
  #failures = 0;
  #firstFailureAt: number | null = null;
  #degradedAt: number | null = null;
  #probeSuccesses = 0;
  #probing = false;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DispatchHealthOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#probeIntervalMs = options.probeIntervalMs ?? 5_000;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 3_000;
    this.#requiredProbeSuccesses = options.probeSuccesses ?? 2;
  }

  get state(): DispatchHealthState {
    return this.#state;
  }

  /** Timestamp the bridge left the dist path, `null` while healthy. */
  get degradedAt(): number | null {
    return this.#degradedAt;
  }

  get consecutiveFailures(): number {
    return this.#failures;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#probeIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Fed by the forwarder after every real flush. */
  record(report: { failed: number }): void {
    if (this.#state === 'degraded') return;
    if (report.failed === 0) {
      this.#failures = 0;
      this.#firstFailureAt = null;
      return;
    }
    this.#failures += 1;
    this.#firstFailureAt ??= this.#now();
    if (this.#failures >= this.#options.fallbackAfterFailures)
      this.degrade('consecutive_failures');
  }

  /** One timer tick: enforce the outage-duration rule, or probe for recovery. */
  async tick(): Promise<void> {
    if (this.#state === 'healthy') {
      if (
        this.#firstFailureAt !== null &&
        this.#now() - this.#firstFailureAt >= this.#options.fallbackAfterMs
      )
        this.degrade('outage_duration');
      return;
    }
    await this.probeOnce();
  }

  async probeOnce(): Promise<boolean> {
    if (this.#probing || this.#state !== 'degraded') return false;
    this.#probing = true;
    try {
      await withTimeout(this.#options.probe(), this.#probeTimeoutMs);
      this.#probeSuccesses += 1;
      if (this.#probeSuccesses >= this.#requiredProbeSuccesses) this.recover();
      return true;
    } catch {
      this.#probeSuccesses = 0;
      return false;
    } finally {
      this.#probing = false;
    }
  }

  private degrade(reason: 'consecutive_failures' | 'outage_duration'): void {
    if (this.#state === 'degraded') return;
    const now = this.#now();
    this.#state = 'degraded';
    this.#degradedAt = now;
    this.#probeSuccesses = 0;
    this.#options.onDegrade({
      reason,
      consecutiveFailures: this.#failures,
      outageMs: this.#firstFailureAt === null ? 0 : now - this.#firstFailureAt,
    });
  }

  private recover(): void {
    if (this.#state !== 'degraded') return;
    const now = this.#now();
    const outageMs = this.#degradedAt === null ? 0 : now - this.#degradedAt;
    this.#state = 'healthy';
    this.#degradedAt = null;
    this.#failures = 0;
    this.#firstFailureAt = null;
    const probeSuccesses = this.#probeSuccesses;
    this.#probeSuccesses = 0;
    this.#options.onRecover({ outageMs, probeSuccesses });
  }
}

export interface StartSchedulerBridgeOptions {
  scheduler: SchedulerDependencies;
  /** Wraps SQLite runs; only mode=container runs pass through slots. */
  tenantOf?: (run: TaskRun) => string;
  logger?: (event: Record<string, unknown>) => void;
}

export interface SchedulerBridge {
  worker: Worker;
  reaper: Reaper;
  forwarder: SchedulerForwarder;
  executor: ScheduledTaskExecutor;
  repository: RunRepository;
  health: DispatchHealthMonitor;
  start(): void;
  /** Install hooks + forwarder without the embedded worker (tests). */
  startForwardingOnly(): void;
  stop(): Promise<void>;
}

/** Test seams: nothing here is needed in production wiring. */
export interface SchedulerBridgeOverrides {
  repository?: RunRepository;
  /** MySQL liveness probe (defaults to `SELECT 1`). */
  probe?: () => Promise<unknown>;
}

/**
 * Build (but do not start) the embedded dispatcher for scheduled tasks.
 * Callers start it next to `startSchedulerLoop` when DIST_SCHEDULER=1.
 */
export function createSchedulerBridge(
  options: StartSchedulerBridgeOptions,
  config: DistributedConfig = loadDistributedConfig(),
  overrides: SchedulerBridgeOverrides = {},
): {
  bridge: SchedulerBridge;
  pool: Pool;
  config: DistributedConfig;
} {
  const pool = createPool(config.mysqlUrl, { connectionLimit: 8 });
  const repository =
    overrides.repository ??
    new RunRepository(pool, {
      leaseMs: config.leaseMs,
      backoffBaseMs: config.backoffBaseMs,
      backoffMaxMs: config.backoffMaxMs,
    });
  const executor = new ScheduledTaskExecutor({
    repository,
    scheduler: options.scheduler,
    leaseMs: 60_000,
    logger: options.logger,
  });
  let health: DispatchHealthMonitor | null = null;
  const forwarder = new SchedulerForwarder({
    repository,
    scheduler: options.scheduler,
    onFlush: (result) => health?.record(result),
    tenantOf:
      options.tenantOf ??
      ((run) => {
        const group =
          options.scheduler.registeredGroups()[
            run.definition_snapshot.chat_jid
          ];
        return group?.created_by || 'system';
      }),
    logger: options.logger,
  });
  // Embedded worker: concurrency only bounds one dispatch batch; host runs have
  // no application-level concurrency cap (CLAUDE.md §4). Container concurrency
  // remains governed by maxConcurrentContainers inside the legacy path.
  const workerConfig: DistributedConfig = {
    ...config,
    workerId: `scheduler:${config.workerId}`,
    concurrency: 1_000,
    claimBatch: 1_000,
  };
  const redis =
    config.tenantConcurrency > 0 ? createRedis(config.redisUrl) : null;
  const tenantSlots = redis
    ? new TenantSlots({
        redis,
        leaseMs: config.leaseMs,
        limit: config.tenantConcurrency,
        failMode: config.admissionFailMode,
        logger: options.logger,
      })
    : undefined;
  const worker = new Worker({
    repository,
    executor,
    config: workerConfig,
    logger: options.logger,
    ...(tenantSlots ? { tenantSlots } : {}),
  });
  const reaper = new Reaper(repository, {
    intervalMs: config.reaperIntervalMs,
    unknownSweepMs: config.unknownSweepMs,
    logger: options.logger,
  });

  const installHooks = (): void =>
    setDistSchedulerHooks({
      wake: () => forwarder.wake(),
      cancel: (runId: string) => {
        void repository.cancel(runId).catch((error: unknown) =>
          options.logger?.({
            event: 'scheduler_dist_cancel_failed',
            runId,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          }),
        );
      },
    });

  health = new DispatchHealthMonitor({
    fallbackAfterFailures: config.fallbackAfterFailures,
    fallbackAfterMs: config.fallbackAfterMs,
    probe: overrides.probe ?? (() => queryRows(pool, 'SELECT 1')),
    onDegrade: (detail) => {
      // Hand claiming back to the pump. Both paths claim the same SQLite row
      // with the same conditions and lease fencing, so no run can execute
      // twice; envelopes are reconciled to the SQLite outcome on recovery.
      setDistSchedulerHooks({ wake: null, cancel: null });
      options.logger?.({
        event: 'scheduler_dist_degraded',
        reason: detail.reason,
        consecutiveFailures: detail.consecutiveFailures,
        outageMs: detail.outageMs,
      });
    },
    onRecover: (detail) => {
      installHooks();
      options.logger?.({
        event: 'scheduler_dist_recovered',
        outageMs: detail.outageMs,
        probeSuccesses: detail.probeSuccesses,
      });
      forwarder.wake();
    },
  });

  const bridge: SchedulerBridge = {
    worker,
    reaper,
    forwarder,
    executor,
    repository,
    health,
    startForwardingOnly() {
      forwarder.start();
      installHooks();
    },
    start() {
      reaper.start();
      forwarder.start();
      worker.start();
      installHooks();
      health?.start();
    },
    async stop() {
      health?.stop();
      await worker.stop();
      await reaper.stop();
      await forwarder.stop();
      setDistSchedulerHooks({ wake: null, cancel: null });
      await tenantSlots?.close();
      await pool.end().catch(() => {});
    },
  };
  return { bridge, pool, config };
}

/** Convenience wrapper used by src/index.ts. */
export function startSchedulerBridge(
  options: StartSchedulerBridgeOptions,
): SchedulerBridge {
  const { bridge } = createSchedulerBridge(options);
  bridge.start();
  return bridge;
}

/** host/container resolution shared with the legacy executor. */
export function schedulerExecutionMode(
  run: TaskRun,
  deps: SchedulerDependencies,
): 'host' | 'container' {
  const snapshot = run.definition_snapshot;
  return resolveTaskExecutionMode(
    {
      execution_mode: snapshot.execution_mode,
      chat_jid: snapshot.chat_jid,
      group_folder: snapshot.group_folder,
    } as never,
    deps,
  );
}
