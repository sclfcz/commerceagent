import type { RunRepository } from './run-repository.js';
import { sweepUnknownSteps } from './durable.js';

export interface ReaperOptions {
  /** How often to look for expired leases. */
  intervalMs: number;
  /** Maximum rows returned by one reap transaction. */
  batchSize?: number;
  /** Low-frequency monitoring scan for stale `unknown` effect steps. */
  unknownSweepMs?: number;
  logger?: (event: Record<string, unknown>) => void;
}

/**
 * Recovers runs whose worker died. Every worker process runs a reaper: the
 * `FOR UPDATE SKIP LOCKED` batch means concurrent reapers split the work
 * instead of blocking on each other.
 */
export class Reaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> = Promise.resolve();
  private closed = false;
  private lastUnknownSweepAt = 0;

  constructor(
    private readonly repository: RunRepository,
    private readonly options: ReaperOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  /** Run one reap pass; serialised so passes never overlap. */
  tick(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      if (this.closed) return;
      try {
        const reaped = await this.repository.reapExpired(
          this.options.batchSize ?? 100,
        );
        if (reaped.length)
          this.options.logger?.({
            event: 'reaped',
            count: reaped.length,
            statuses: reaped.map((item) => item.nextStatus),
          });
        const sweepMs = this.options.unknownSweepMs ?? 60_000;
        if (Date.now() - this.lastUnknownSweepAt >= sweepMs) {
          this.lastUnknownSweepAt = Date.now();
          // Monitoring only: this never changes step or run state.
          const sweep = await sweepUnknownSteps(this.repository.pool);
          this.options.logger?.({
            event: 'unknown_steps_sweep',
            count: sweep.staleUnknownSteps,
          });
        }
      } catch (error) {
        this.options.logger?.({
          event: 'reap_failed',
          error:
            error instanceof Error ? error.message.slice(0, 300) : 'unknown',
        });
      }
    });
    return this.inFlight;
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight.catch(() => {});
  }
}
