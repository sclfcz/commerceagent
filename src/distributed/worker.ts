import type { DistributedConfig } from './config.js';
import {
  ExecutorAbortedError,
  RetryableError,
  type Executor,
} from './executors.js';
import type { ClaimedRun, RunRepository } from './run-repository.js';

export class LeaseLostError extends Error {
  constructor(message = 'lease lost') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export interface WorkerLogger {
  (event: Record<string, unknown>): void;
}

interface RunState {
  claim: ClaimedRun;
  controller: AbortController;
  done: Promise<void>;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  heartbeatInFlight: boolean;
  lastHeartbeatAt: number;
  leaseLost: boolean;
}

export interface WorkerOptions {
  repository: RunRepository;
  executor: Executor;
  config: DistributedConfig;
  logger?: WorkerLogger;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A worker claims due runs, keeps their leases alive, and reports a final
 * state. Every write is fenced by `(id, status='running', lease_owner,
 * lease_token)`, so a worker that already lost its lease cannot overwrite the
 * result of the worker that took over.
 */
export class Worker {
  private readonly repository: RunRepository;
  private readonly executor: Executor;
  private readonly config: DistributedConfig;
  private readonly logger: WorkerLogger;
  private readonly runs = new Map<string, RunState>();
  private stopping = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.repository = options.repository;
    this.executor = options.executor;
    this.config = options.config;
    this.logger = options.logger ?? (() => {});
  }

  /** Number of runs currently executing in this process. */
  get inFlight(): number {
    return this.runs.size;
  }

  get workerId(): string {
    return this.config.workerId;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      const free = this.config.concurrency - this.runs.size;
      if (free <= 0) {
        await this.sleep(50);
        continue;
      }
      let claimed: ClaimedRun[] = [];
      try {
        claimed = await this.repository.claim(
          this.config.workerId,
          Math.min(free, this.config.claimBatch || free),
        );
      } catch (error) {
        this.logger({
          event: 'claim_failed',
          workerId: this.config.workerId,
          error: errorMessage(error),
        });
        await this.sleep(this.pollDelayMs());
        continue;
      }
      if (this.stopping) {
        // stop() was requested while the claim transaction was in flight.
        await this.releaseClaimed(claimed);
        break;
      }
      if (!claimed.length) {
        await this.sleep(this.pollDelayMs());
        continue;
      }
      for (const claim of claimed) this.execute(claim);
    }
  }

  /** Hand back runs claimed after stop() began so another worker can take them. */
  private async releaseClaimed(claimed: ClaimedRun[]): Promise<void> {
    for (const claim of claimed) {
      try {
        await this.repository.fail({
          runId: claim.runId,
          workerId: this.config.workerId,
          leaseToken: claim.leaseToken,
          error: 'worker stopping before execution started',
          retryable: true,
        });
      } catch {
        /* the lease will expire and be reaped */
      }
    }
  }

  private pollDelayMs(): number {
    // Jitter avoids a fleet of idle workers polling in lock step.
    return Math.round(this.config.pollMs * (1 + Math.random() * 0.3));
  }

  private execute(claim: ClaimedRun): void {
    const controller = new AbortController();
    const state: RunState = {
      claim,
      controller,
      done: Promise.resolve(),
      heartbeatTimer: null,
      heartbeatInFlight: false,
      lastHeartbeatAt: Date.now(),
      leaseLost: false,
    };
    const done = (async () => {
      state.heartbeatTimer = setInterval(() => {
        void this.heartbeat(claim, state);
      }, this.config.heartbeatMs);
      try {
        const result = await this.executor.execute({
          runId: claim.runId,
          tenantId: claim.tenantId,
          taskId: claim.taskId,
          attempt: claim.attempt,
          maxAttempts: claim.maxAttempts,
          payload: claim.payload,
          workerId: this.config.workerId,
          signal: controller.signal,
        });
        if (state.leaseLost || controller.signal.aborted) return;
        const applied = await this.repository.complete({
          runId: claim.runId,
          workerId: this.config.workerId,
          leaseToken: claim.leaseToken,
          result,
        });
        if (!applied)
          this.logger({
            event: 'complete_rejected',
            workerId: this.config.workerId,
            runId: claim.runId,
          });
      } catch (error) {
        // A lost lease or a cancellation means the outcome belongs to someone
        // else (or to nobody); never report a result in that case.
        if (state.leaseLost || controller.signal.aborted) return;
        if (error instanceof ExecutorAbortedError) return;
        const retryable = error instanceof RetryableError;
        try {
          const outcome = await this.repository.fail({
            runId: claim.runId,
            workerId: this.config.workerId,
            leaseToken: claim.leaseToken,
            error: errorMessage(error),
            retryable,
          });
          if (!outcome.applied)
            this.logger({
              event: 'fail_rejected',
              workerId: this.config.workerId,
              runId: claim.runId,
            });
          else
            this.logger({
              event: 'run_failed',
              workerId: this.config.workerId,
              runId: claim.runId,
              status: outcome.status,
              retryable,
            });
        } catch (writeError) {
          this.logger({
            event: 'fail_write_error',
            workerId: this.config.workerId,
            runId: claim.runId,
            error: errorMessage(writeError),
          });
        }
      } finally {
        if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
        this.runs.delete(claim.runId);
      }
    })();
    state.done = done;
    this.runs.set(claim.runId, state);
  }

  private async heartbeat(claim: ClaimedRun, state: RunState): Promise<void> {
    if (
      state.heartbeatInFlight ||
      state.leaseLost ||
      state.controller.signal.aborted
    )
      return;
    state.heartbeatInFlight = true;
    try {
      const applied = await this.repository.heartbeat({
        runId: claim.runId,
        workerId: this.config.workerId,
        leaseToken: claim.leaseToken,
      });
      if (applied) {
        state.lastHeartbeatAt = Date.now();
        return;
      }
      state.leaseLost = true;
      this.logger({
        event: 'heartbeat_lost',
        workerId: this.config.workerId,
        runId: claim.runId,
      });
      await this.repository.recordHeartbeatLost({
        runId: claim.runId,
        workerId: this.config.workerId,
        leaseToken: claim.leaseToken,
      });
      state.controller.abort(new LeaseLostError());
    } catch (error) {
      // A transient database error is not proof that the lease is gone. Only
      // give up once the last successful heartbeat is about to age out.
      const elapsed = Date.now() - state.lastHeartbeatAt;
      const budget = this.config.leaseMs - this.config.heartbeatMs;
      this.logger({
        event: 'heartbeat_error',
        workerId: this.config.workerId,
        runId: claim.runId,
        elapsedMs: elapsed,
        error: errorMessage(error),
      });
      if (elapsed > budget) {
        state.leaseLost = true;
        state.controller.abort(
          new LeaseLostError('heartbeat budget exhausted'),
        );
      }
    } finally {
      state.heartbeatInFlight = false;
    }
  }

  /**
   * Stop claiming, wait up to `leaseMs` for in-flight runs, then abort the rest.
   * Aborted executors must not report a result; the lease expires and the
   * reaper hands the run to another worker.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopping = true;
    this.wake?.();
    await this.loopPromise?.catch(() => {});
    this.loopPromise = null;

    const pending = [...this.runs.values()];
    if (pending.length) {
      await Promise.race([
        Promise.allSettled(pending.map((state) => state.done)),
        sleep(this.config.leaseMs),
      ]);
    }
    // Runs that outlived the grace window are handed back *before* aborting:
    // a graceful stop must not burn an attempt, and another worker can pick
    // them up immediately with their original queue position.
    for (const state of [...this.runs.values()]) {
      if (state.heartbeatTimer) {
        clearInterval(state.heartbeatTimer);
        state.heartbeatTimer = null;
      }
      state.leaseLost = true;
      try {
        const released = await this.repository.release({
          runId: state.claim.runId,
          workerId: this.config.workerId,
          leaseToken: state.claim.leaseToken,
        });
        this.logger({
          event: released ? 'run_released' : 'release_rejected',
          workerId: this.config.workerId,
          runId: state.claim.runId,
        });
      } catch (error) {
        this.logger({
          event: 'release_failed',
          workerId: this.config.workerId,
          runId: state.claim.runId,
          error: errorMessage(error),
        });
      }
      state.controller.abort(new LeaseLostError('worker stopping'));
    }
    // Give abort-aware executors a moment to unwind, but never hang shutdown.
    const remaining = [...this.runs.values()];
    if (remaining.length)
      await Promise.race([
        Promise.allSettled(remaining.map((state) => state.done)),
        sleep(2_000),
      ]);
    this.logger({ event: 'worker_stopped', workerId: this.config.workerId });
    this.started = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}
