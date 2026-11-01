import { createHash } from 'node:crypto';
import {
  execute,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
} from './mysql.js';
import { stableStringify } from './run-repository.js';
import { RetryableError } from './errors.js';

/** The lease this context is allowed to write under. */
export interface DurableRunIdentity {
  runId: string;
  workerId: string;
  leaseToken: number;
}

export interface EffectProvider {
  name: string;
  supportsLookup: boolean;
  send(
    request: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<{ ref: string }>;
  lookup?(idempotencyKey: string): Promise<{ ref: string } | null>;
}

/** Thrown when our fenced write loses against a newer lease owner. */
export class LeaseLostError extends Error {
  constructor(message = 'lease lost') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

/** The same stepKey was previously used with a different request body. */
export class EffectRequestMismatchError extends Error {
  constructor(readonly stepKey: string) {
    super(`effect request changed for step ${stepKey}`);
    this.name = 'EffectRequestMismatchError';
  }
}

/** The run cannot be completed automatically and must be inspected by a human. */
export class NeedsReviewError extends Error {
  constructor(readonly stepKey: string) {
    super(`effect ${stepKey} needs manual review`);
    this.name = 'NeedsReviewError';
  }
}

/** A non-retryable provider rejection (4xx). */
export class EffectPermanentError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'EffectPermanentError';
  }
}

export interface DurableStats {
  stepsExecuted: number;
  stepsSkippedFromCheckpoint: number;
  effectsSent: number;
  reconciledCommitted: number;
  reconciledNotFound: number;
  needsReview: number;
}

export function emptyDurableStats(): DurableStats {
  return {
    stepsExecuted: 0,
    stepsSkippedFromCheckpoint: 0,
    effectsSent: 0,
    reconciledCommitted: 0,
    reconciledNotFound: 0,
    needsReview: 0,
  };
}

export interface RunContext {
  step<T>(stepKey: string, fn: () => Promise<T>): Promise<T>;
  effect(
    stepKey: string,
    request: unknown,
    provider: EffectProvider,
  ): Promise<{ ref: string }>;
}

/** Hooks the context needs from the run repository (kept as an interface). */
export interface DurableRunHooks {
  markNeedsReview(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    stepKey: string;
  }): Promise<boolean>;
  recordEvent(input: {
    runId: string;
    leaseToken: number;
    workerId: string | null;
    event: string;
    detail?: Record<string, unknown> | null;
  }): Promise<void>;
}

interface StepRow {
  step_key: string;
  kind: 'compute' | 'effect';
  status: 'intent' | 'committed' | 'unknown' | 'failed';
  lease_token: number;
  request_hash: string | null;
  output: unknown;
  provider_ref: string | null;
  attempts: number;
  last_error: string | null;
}

const requestDigest = (value: unknown) =>
  createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');

export interface DurableContextOptions {
  pool: Pool;
  hooks: DurableRunHooks;
  identity: DurableRunIdentity;
  signal: AbortSignal;
  /** DIST_EFFECT_TIMEOUT_MS. */
  effectTimeoutMs?: number;
  stats?: DurableStats;
  logger?: (event: Record<string, unknown>) => void;
}

/**
 * Per-run execution context that makes steps replayable.
 *
 * Fencing caveat (see README): the fence below prevents a zombie worker from
 * *writing the database*, but it cannot stop it from sending an outbound
 * request between the fence check and the send. Providers that honour the
 * idempotency key remove that duplicate downstream; providers that neither
 * honour it nor support lookup can only be "at most once + human review".
 */
export class DurableContext implements RunContext {
  private readonly pool: Pool;
  private readonly hooks: DurableRunHooks;
  private readonly identity: DurableRunIdentity;
  private readonly signal: AbortSignal;
  private readonly effectTimeoutMs: number;
  private readonly stats: DurableStats;
  private readonly logger: (event: Record<string, unknown>) => void;

  constructor(options: DurableContextOptions) {
    this.pool = options.pool;
    this.hooks = options.hooks;
    this.identity = options.identity;
    this.signal = options.signal;
    this.effectTimeoutMs = options.effectTimeoutMs ?? 5_000;
    this.stats = options.stats ?? emptyDurableStats();
    this.logger = options.logger ?? (() => {});
  }

  private stepKeyOf(stepKey: string): void {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(stepKey))
      throw new Error(`invalid_step_key:${stepKey}`);
  }

  private async readStep(stepKey: string): Promise<StepRow | null> {
    const rows = await queryRows(
      this.pool,
      `SELECT step_key, kind, status, lease_token, request_hash, output,
              provider_ref, attempts, last_error
         FROM dist_run_steps WHERE run_id = ? AND step_key = ?`,
      [this.identity.runId, stepKey],
    );
    return rows.length ? (rows[0] as StepRow) : null;
  }

  /** Fenced write guard: the run must still be ours inside this transaction. */
  private async assertFence(connection: PoolConnection): Promise<void> {
    const rows = await queryRows(
      connection,
      `SELECT 1 AS ok FROM dist_task_runs
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
        FOR UPDATE`,
      [this.identity.runId, this.identity.workerId, this.identity.leaseToken],
    );
    if (!rows.length) throw new LeaseLostError('fence_rejected');
  }

  /** Cheap unlocked check used right before an outbound request. */
  async isFenced(): Promise<boolean> {
    const rows = await queryRows(
      this.pool,
      `SELECT 1 AS ok FROM dist_task_runs
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
      [this.identity.runId, this.identity.workerId, this.identity.leaseToken],
    );
    return rows.length === 1;
  }

  private async record(
    event: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.hooks.recordEvent({
        runId: this.identity.runId,
        leaseToken: this.identity.leaseToken,
        workerId: this.identity.workerId,
        event,
        detail,
      });
    } catch {
      /* metrics-only event; never fail the step for it */
    }
  }

  /** Pure computation step: replayed from the checkpoint when committed. */
  async step<T>(stepKey: string, fn: () => Promise<T>): Promise<T> {
    this.stepKeyOf(stepKey);
    const existing = await this.readStep(stepKey);
    if (existing?.status === 'committed') {
      this.stats.stepsSkippedFromCheckpoint += 1;
      await this.record('step_skipped', { stepKey, kind: 'compute' });
      return existing.output as T;
    }

    const value = await fn();
    await withTransaction(this.pool, async (connection) => {
      await this.assertFence(connection);
      await execute(
        connection,
        `INSERT INTO dist_run_steps
           (run_id, step_key, kind, status, lease_token, idempotency_key,
            output, attempts, created_at, updated_at)
         VALUES (?, ?, 'compute', 'committed', ?, ?, ?, 1, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           status = 'committed',
           lease_token = VALUES(lease_token),
           output = VALUES(output),
           attempts = attempts + 1,
           last_error = NULL,
           updated_at = NOW(3)`,
        [
          this.identity.runId,
          stepKey,
          this.identity.leaseToken,
          `${this.identity.runId}:${stepKey}`,
          JSON.stringify(value ?? null),
        ],
      );
    });
    this.stats.stepsExecuted += 1;
    await this.record('step_executed', { stepKey, kind: 'compute' });
    return value;
  }

  /** External side effect: intent -> (reconcile) -> committed / unknown / failed. */
  async effect(
    stepKey: string,
    request: unknown,
    provider: EffectProvider,
  ): Promise<{ ref: string }> {
    this.stepKeyOf(stepKey);
    const idempotencyKey = `${this.identity.runId}:${stepKey}`;
    const requestHash = requestDigest(request);

    let existing = await this.readStep(stepKey);
    let createdNow = false;

    if (existing) {
      if (existing.request_hash && existing.request_hash !== requestHash)
        throw new EffectRequestMismatchError(stepKey);
      if (existing.status === 'committed') {
        this.stats.stepsSkippedFromCheckpoint += 1;
        await this.record('step_skipped', { stepKey, kind: 'effect' });
        if (!existing.provider_ref)
          throw new Error(`committed_effect_missing_ref:${stepKey}`);
        return { ref: existing.provider_ref };
      }
      if (existing.status === 'failed')
        throw new Error(
          `effect_failed:${stepKey}:${existing.last_error ?? ''}`,
        );
    } else {
      // Record the intent before touching the outside world.
      await withTransaction(this.pool, async (connection) => {
        await this.assertFence(connection);
        await execute(
          connection,
          `INSERT INTO dist_run_steps
             (run_id, step_key, kind, status, lease_token, idempotency_key,
              request_hash, attempts, created_at, updated_at)
           VALUES (?, ?, 'effect', 'intent', ?, ?, ?, 1, NOW(3), NOW(3))`,
          [
            this.identity.runId,
            stepKey,
            this.identity.leaseToken,
            idempotencyKey,
            requestHash,
          ],
        );
      });
      createdNow = true;
      existing = await this.readStep(stepKey);
    }

    // A leftover intent/unknown means a previous attempt may already have sent.
    if (!createdNow) {
      if (!provider.supportsLookup || !provider.lookup) {
        const marked = await this.hooks.markNeedsReview({
          runId: this.identity.runId,
          workerId: this.identity.workerId,
          leaseToken: this.identity.leaseToken,
          stepKey,
        });
        if (marked) this.stats.needsReview += 1;
        throw new NeedsReviewError(stepKey);
      }
      const found = await provider.lookup(idempotencyKey);
      if (found) {
        await this.commitEffect(stepKey, found.ref, true);
        this.stats.reconciledCommitted += 1;
        await this.record('effect_reconciled', {
          stepKey,
          result: 'committed',
        });
        return { ref: found.ref };
      }
      this.stats.reconciledNotFound += 1;
      await this.record('effect_reconciled', {
        stepKey,
        result: 'not_found',
      });
    }

    // Fence once more right before the request to shrink the zombie window.
    if (!(await this.isFenced()))
      throw new LeaseLostError('fence_rejected_before_send');

    let ref: string;
    try {
      ref = await this.sendWithTimeout(provider, request, idempotencyKey);
    } catch (error) {
      if (this.signal.aborted) throw new LeaseLostError('aborted');
      if (error instanceof EffectPermanentError) {
        await this.markEffect(stepKey, 'failed', error.message);
        throw error;
      }
      const message =
        error instanceof Error ? error.message.slice(0, 300) : 'unknown';
      await this.markEffect(stepKey, 'unknown', message);
      throw new RetryableEffectError(
        `effect_outcome_unknown:${stepKey}:${message}`,
      );
    }

    await this.commitEffect(stepKey, ref, false);
    this.stats.effectsSent += 1;
    await this.record('effect_sent', { stepKey, ref });
    return { ref };
  }

  private sendWithTimeout(
    provider: EffectProvider,
    request: unknown,
    idempotencyKey: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const controller = new AbortController();
      let timedOut = false;
      const onAbort = () => controller.abort();
      this.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.effectTimeoutMs);
      provider
        .send(request, idempotencyKey, controller.signal)
        .then((result) => resolve(result.ref))
        .catch((error) =>
          reject(
            timedOut
              ? new Error(`effect_timeout_after_${this.effectTimeoutMs}ms`)
              : error,
          ),
        )
        .finally(() => {
          clearTimeout(timer);
          this.signal.removeEventListener('abort', onAbort);
        });
    });
  }

  private async commitEffect(
    stepKey: string,
    ref: string,
    reconciled: boolean,
  ): Promise<void> {
    await withTransaction(this.pool, async (connection) => {
      await this.assertFence(connection);
      await execute(
        connection,
        `UPDATE dist_run_steps
            SET status = 'committed', provider_ref = ?, output = ?,
                lease_token = ?, attempts = attempts + 1,
                last_error = NULL, updated_at = NOW(3)
          WHERE run_id = ? AND step_key = ?`,
        [
          ref,
          JSON.stringify({ ref, reconciled }),
          this.identity.leaseToken,
          this.identity.runId,
          stepKey,
        ],
      );
    });
    this.logger({ event: 'effect_committed', stepKey, reconciled });
  }

  /**
   * Best effort: when the fence is gone we still want the caller to retry, and
   * the next owner will reconcile the leftover intent/unknown row.
   */
  private async markEffect(
    stepKey: string,
    status: 'unknown' | 'failed',
    error: string,
  ): Promise<void> {
    try {
      await withTransaction(this.pool, async (connection) => {
        await this.assertFence(connection);
        await execute(
          connection,
          `UPDATE dist_run_steps
              SET status = ?, last_error = ?, lease_token = ?,
                  attempts = attempts + 1, updated_at = NOW(3)
            WHERE run_id = ? AND step_key = ?`,
          [
            status,
            error.slice(0, 2000),
            this.identity.leaseToken,
            this.identity.runId,
            stepKey,
          ],
        );
      });
    } catch (writeError) {
      this.logger({
        event: 'effect_mark_failed',
        stepKey,
        status,
        error:
          writeError instanceof Error
            ? writeError.message.slice(0, 200)
            : 'unknown',
      });
    }
  }
}

/** Retryable effect failure (timeout / network / 5xx): outcome unknown. */
export class RetryableEffectError extends RetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableEffectError';
  }
}

export interface UnknownSweepResult {
  staleUnknownSteps: number;
}

/**
 * Monitoring-only scan: steps stuck in `unknown` for more than 5 minutes whose
 * run already reached a terminal/needs_review state. No state is changed.
 */
export async function sweepUnknownSteps(
  pool: Pool,
): Promise<UnknownSweepResult> {
  const rows = await queryRows(
    pool,
    `SELECT COUNT(*) AS total
       FROM dist_run_steps s
       JOIN dist_task_runs r ON r.id = s.run_id
      WHERE s.status = 'unknown'
        AND s.updated_at < NOW(3) - INTERVAL 5 MINUTE
        AND r.status IN ('succeeded','dead','cancelled','needs_review')`,
  );
  return { staleUnknownSteps: Number(rows[0]?.total ?? 0) };
}
