import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fullJitterBackoff } from './backoff.js';
import type { RuntimeStats } from './runtime-stats.js';
import {
  execute,
  queryRows,
  withTransaction,
  type Pool,
  type PoolConnection,
  type Queryable,
} from './mysql.js';

export type RunStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'dead'
  | 'cancelled';

export type RunEventName =
  | 'submitted'
  | 'claimed'
  | 'heartbeat_lost'
  | 'succeeded'
  | 'failed_retry'
  | 'dead'
  | 'reaped'
  | 'released'
  | 'stale_write_rejected'
  | 'cancelled';

export interface TaskRun {
  id: string;
  tenant_id: string;
  task_id: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  status: RunStatus;
  attempt: number;
  max_attempts: number;
  available_at: Date;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  result: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface TaskRunEvent {
  id: number;
  run_id: string;
  lease_token: number;
  worker_id: string | null;
  event: RunEventName;
  detail: Record<string, unknown> | null;
  created_at: Date;
}

export interface ClaimedRun {
  runId: string;
  tenantId: string;
  taskId: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseToken: number;
}

export interface SubmitInput {
  tenantId: string;
  taskId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

export class IdempotencyConflictError extends Error {
  constructor(
    readonly tenantId: string,
    readonly idempotencyKey: string,
  ) {
    super('idempotency key already used with a different payload');
    this.name = 'IdempotencyConflictError';
  }
}

export interface RunRepositoryOptions {
  /** Lease duration used when claiming and when extending leases. */
  leaseMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Injectable for deterministic backoff in tests. */
  random?: () => number;
  /** Optional counters used by `dist:bench`; cheap when omitted. */
  stats?: RuntimeStats;
}

const MAX_PAYLOAD_BYTES = 512 * 1024;

/** Deterministic JSON with sorted object keys, used for the payload hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

export function payloadDigest(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify(payload), 'utf8')
    .digest('hex');
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRun(row: Record<string, any>): TaskRun {
  return {
    ...(row as TaskRun),
    attempt: toNumber(row.attempt),
    max_attempts: toNumber(row.max_attempts),
    lease_token: toNumber(row.lease_token),
  };
}

function isDuplicateKeyError(error: unknown): boolean {
  const value = error as { errno?: number; code?: string } | null;
  return value?.errno === 1062 || value?.code === 'ER_DUP_ENTRY';
}

export class RunRepository {
  private readonly leaseMicros: number;
  private readonly random: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly options: RunRepositoryOptions,
  ) {
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs < 1)
      throw new Error('invalid leaseMs');
    this.leaseMicros = options.leaseMs * 1000;
    this.random = options.random ?? Math.random;
  }

  private async insertEvent(
    target: Queryable,
    input: {
      runId: string;
      leaseToken: number;
      workerId: string | null;
      event: RunEventName;
      detail?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    await execute(
      target,
      `INSERT INTO dist_task_run_events
         (run_id, lease_token, worker_id, event, detail, created_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))`,
      [
        input.runId,
        input.leaseToken,
        input.workerId,
        input.event,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
  }

  private async recordStaleWrite(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    operation: 'heartbeat' | 'complete' | 'fail' | 'release';
    reason: string;
  }): Promise<void> {
    // Deliberately a separate transaction: the rejected write must not roll
    // back the audit trail, and the write itself is never retried.
    await withTransaction(this.pool, async (connection) => {
      await this.insertEvent(connection, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        event: 'stale_write_rejected',
        detail: { operation: input.operation, reason: input.reason },
      });
    });
  }

  /**
   * Enqueue `run.ready` in the same transaction as the state change that made
   * the run executable. `available_at` is copied from the run row so a relay
   * can never publish a retry before its backoff has elapsed.
   */
  private async enqueueOutbox(
    connection: Queryable,
    runId: string,
    tenantId: string,
  ): Promise<void> {
    await execute(
      connection,
      `INSERT INTO dist_outbox
         (run_id, event_type, payload, status, publish_attempts, available_at, created_at)
       SELECT ?, 'run.ready', ?, 'pending', 0, available_at, NOW(3)
         FROM dist_task_runs WHERE id = ?`,
      [runId, JSON.stringify({ runId, tenantId }), runId],
    );
  }

  async submit(
    input: SubmitInput,
  ): Promise<{ run: TaskRun; created: boolean }> {
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new Error('invalid_max_attempts');
    const payloadJson = JSON.stringify(input.payload ?? {});
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES)
      throw new Error('payload_too_large');
    const payloadHash = payloadDigest(input.payload ?? {});
    const id = randomUUID();

    try {
      const run = await withTransaction(this.pool, async (connection) => {
        await execute(
          connection,
          `INSERT INTO dist_task_runs
             (id, tenant_id, task_id, idempotency_key, payload, payload_hash,
              status, attempt, max_attempts, available_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NOW(3), NOW(3), NOW(3))`,
          [
            id,
            input.tenantId,
            input.taskId,
            input.idempotencyKey,
            payloadJson,
            payloadHash,
            maxAttempts,
          ],
        );
        await this.insertEvent(connection, {
          runId: id,
          leaseToken: 0,
          workerId: null,
          event: 'submitted',
          detail: { taskId: input.taskId, maxAttempts },
        });
        await this.enqueueOutbox(connection, id, input.tenantId);
        const rows = await queryRows(
          connection,
          'SELECT * FROM dist_task_runs WHERE id = ?',
          [id],
        );
        return mapRun(rows[0]);
      });
      return { run, created: true };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const rows = await queryRows(
        this.pool,
        'SELECT * FROM dist_task_runs WHERE tenant_id = ? AND idempotency_key = ?',
        [input.tenantId, input.idempotencyKey],
      );
      if (!rows.length) throw error;
      const existing = mapRun(rows[0]);
      if (existing.payload_hash !== payloadHash)
        throw new IdempotencyConflictError(
          input.tenantId,
          input.idempotencyKey,
        );
      return { run: existing, created: false };
    }
  }

  async claim(workerId: string, limit: number): Promise<ClaimedRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const startedAt = performance.now();
    const claimed = await withTransaction(
      this.pool,
      async (connection) => {
        const due = await queryRows(
          connection,
          `SELECT id FROM dist_task_runs
          WHERE status IN ('queued','retry_wait') AND available_at <= NOW(3)
          ORDER BY available_at, id
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        if (!due.length) return [];
        return this.claimRows(
          connection,
          workerId,
          due.map((row) => String(row.id)),
        );
      },
      {
        isolation: 'READ COMMITTED',
        onRetry: () => this.options.stats?.recordTransactionRetry(),
      },
    );
    this.options.stats?.recordClaim(
      performance.now() - startedAt,
      claimed.length,
    );
    return claimed;
  }

  /**
   * Tenant-aware claim: pick tenants with due work first (unlocked read), then
   * claim per tenant within one transaction, skipping tenants that Redis says
   * are already at their limit. This keeps an over-quota tenant's backlog from
   * monopolising every claim batch.
   */
  async claimFair(
    workerId: string,
    limit: number,
    saturatedTenants: string[],
    perTenantRoom: Map<string, number>,
  ): Promise<ClaimedRun[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    const startedAt = performance.now();
    const claimed = await withTransaction(
      this.pool,
      async (connection) => {
        const saturated = [...new Set(saturatedTenants)].filter(Boolean);
        const exclude =
          saturated.length > 0
            ? ` AND tenant_id NOT IN (${saturated.map(() => '?').join(',')})`
            : '';
        const candidates = await queryRows(
          connection,
          `SELECT tenant_id, MIN(available_at) AS oldest
             FROM dist_task_runs
            WHERE status IN ('queued','retry_wait') AND available_at <= NOW(3)${exclude}
            GROUP BY tenant_id
            ORDER BY oldest
            LIMIT 32`,
          saturated,
        );
        if (!candidates.length) return [];

        const tenants = candidates.map((row) => String(row.tenant_id));
        const room = new Map<string, number>(
          tenants.map((tenant) => [
            tenant,
            Math.max(0, perTenantRoom.get(tenant) ?? limit),
          ]),
        );
        const out: ClaimedRun[] = [];
        let remaining = limit;
        while (remaining > 0) {
          const active = tenants.filter(
            (tenant) => (room.get(tenant) ?? 0) > 0,
          );
          if (!active.length) break;
          let progressed = false;
          for (let index = 0; index < active.length && remaining > 0; index++) {
            const tenant = active[index];
            // Spread the remaining budget across the tenants still in play so
            // one tenant with a big room does not take the whole batch.
            const share = Math.ceil(remaining / (active.length - index));
            const take = Math.min(remaining, room.get(tenant) ?? 0, share);
            if (take <= 0) continue;
            const due = await queryRows(
              connection,
              `SELECT id FROM dist_task_runs
                WHERE status IN ('queued','retry_wait')
                  AND available_at <= NOW(3)
                  AND tenant_id = ?
                ORDER BY available_at, id
                LIMIT ?
                FOR UPDATE SKIP LOCKED`,
              [tenant, take],
            );
            if (!due.length) {
              room.set(tenant, 0);
              continue;
            }
            const rows = await this.claimRows(
              connection,
              workerId,
              due.map((row) => String(row.id)),
            );
            out.push(...rows);
            room.set(tenant, (room.get(tenant) ?? 0) - rows.length);
            remaining -= rows.length;
            if (rows.length > 0) progressed = true;
          }
          if (!progressed) break;
        }
        return out;
      },
      {
        isolation: 'READ COMMITTED',
        onRetry: () => this.options.stats?.recordTransactionRetry(),
      },
    );
    this.options.stats?.recordClaim(
      performance.now() - startedAt,
      claimed.length,
    );
    return claimed;
  }

  /** Mark the given rows running under `workerId` and emit `claimed` events. */
  private async claimRows(
    connection: PoolConnection,
    workerId: string,
    ids: string[],
  ): Promise<ClaimedRun[]> {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    await execute(
      connection,
      `UPDATE dist_task_runs
          SET status = 'running',
              attempt = attempt + 1,
              lease_owner = ?,
              lease_token = lease_token + 1,
              lease_expires_at = NOW(3) + INTERVAL ? MICROSECOND,
              started_at = COALESCE(started_at, NOW(3)),
              updated_at = NOW(3)
        WHERE id IN (${placeholders})
          AND status IN ('queued','retry_wait')`,
      [workerId, this.leaseMicros, ...ids],
    );
    const rows = await queryRows(
      connection,
      `SELECT id, tenant_id, task_id, payload, attempt, max_attempts, lease_token
         FROM dist_task_runs
        WHERE id IN (${placeholders}) AND status = 'running' AND lease_owner = ?`,
      [...ids, workerId],
    );
    const claimed: ClaimedRun[] = [];
    for (const row of rows) {
      const leaseToken = toNumber(row.lease_token);
      await this.insertEvent(connection, {
        runId: String(row.id),
        leaseToken,
        workerId,
        event: 'claimed',
        detail: { attempt: toNumber(row.attempt) },
      });
      claimed.push({
        runId: String(row.id),
        tenantId: String(row.tenant_id),
        taskId: String(row.task_id),
        payload: (row.payload ?? {}) as Record<string, unknown>,
        attempt: toNumber(row.attempt),
        maxAttempts: toNumber(row.max_attempts),
        leaseToken,
      });
    }
    return claimed;
  }

  /**
   * Claim exactly one run by id (MQ dispatch path).
   *
   * The `dist_consumed_messages` insert makes the whole operation idempotent
   * per (consumer, messageId): a duplicate delivery returns `duplicate`
   * without touching the run. A non-claimable run (already running, finished,
   * or not yet due) returns `skipped`, which is the correct outcome for a
   * wake-up message that arrived late.
   */
  async claimById(input: {
    workerId: string;
    runId: string;
    messageId: string;
  }): Promise<{
    outcome: 'claimed' | 'skipped' | 'duplicate';
    claim?: ClaimedRun;
  }> {
    return withTransaction(
      this.pool,
      async (connection) => {
        try {
          await execute(
            connection,
            `INSERT INTO dist_consumed_messages
               (consumer, message_id, run_id, outcome, consumed_at)
             VALUES (?, ?, ?, 'claimed', NOW(3))`,
            [input.workerId, input.messageId, input.runId],
          );
        } catch (error) {
          if (isDuplicateKeyError(error))
            return { outcome: 'duplicate' as const };
          throw error;
        }

        const updated = await execute(
          connection,
          `UPDATE dist_task_runs
              SET status = 'running',
                  attempt = attempt + 1,
                  lease_owner = ?,
                  lease_token = lease_token + 1,
                  lease_expires_at = NOW(3) + INTERVAL ? MICROSECOND,
                  started_at = COALESCE(started_at, NOW(3)),
                  updated_at = NOW(3)
            WHERE id = ?
              AND status IN ('queued','retry_wait')
              AND available_at <= NOW(3)`,
          [input.workerId, this.leaseMicros, input.runId],
        );
        if (updated.affectedRows === 0) {
          await execute(
            connection,
            `UPDATE dist_consumed_messages SET outcome = 'skipped'
              WHERE consumer = ? AND message_id = ?`,
            [input.workerId, input.messageId],
          );
          return { outcome: 'skipped' as const };
        }

        const rows = await queryRows(
          connection,
          `SELECT id, tenant_id, task_id, payload, attempt, max_attempts, lease_token
             FROM dist_task_runs WHERE id = ?`,
          [input.runId],
        );
        const row = rows[0];
        const leaseToken = toNumber(row.lease_token);
        await this.insertEvent(connection, {
          runId: input.runId,
          leaseToken,
          workerId: input.workerId,
          event: 'claimed',
          detail: { attempt: toNumber(row.attempt), via: 'mq' },
        });
        return {
          outcome: 'claimed' as const,
          claim: {
            runId: String(row.id),
            tenantId: String(row.tenant_id),
            taskId: String(row.task_id),
            payload: (row.payload ?? {}) as Record<string, unknown>,
            attempt: toNumber(row.attempt),
            maxAttempts: toNumber(row.max_attempts),
            leaseToken,
          },
        };
      },
      { isolation: 'READ COMMITTED' },
    );
  }

  /**
   * Extend the lease. The `lease_expires_at > NOW(3)` predicate is required so
   * an already-expired lease can never be resurrected by a late heartbeat.
   */
  async heartbeat(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
  }): Promise<boolean> {
    const result = await execute(
      this.pool,
      `UPDATE dist_task_runs
          SET lease_expires_at = NOW(3) + INTERVAL ? MICROSECOND,
              updated_at = NOW(3)
        WHERE id = ?
          AND status = 'running'
          AND lease_owner = ?
          AND lease_token = ?
          AND lease_expires_at > NOW(3)`,
      [this.leaseMicros, input.runId, input.workerId, input.leaseToken],
    );
    const applied = result.affectedRows > 0;
    if (!applied)
      await this.recordStaleWrite({
        ...input,
        operation: 'heartbeat',
        reason: 'lease_not_running_or_expired',
      });
    return applied;
  }

  /** Lifecycle record for a lease the worker observed as lost. */
  async recordHeartbeatLost(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
  }): Promise<void> {
    await this.insertEvent(this.pool, {
      runId: input.runId,
      leaseToken: input.leaseToken,
      workerId: input.workerId,
      event: 'heartbeat_lost',
      detail: { reason: 'heartbeat_rejected' },
    });
  }

  async complete(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    result: unknown;
  }): Promise<boolean> {
    const applied = await withTransaction(this.pool, async (connection) => {
      const updated = await execute(
        connection,
        `UPDATE dist_task_runs
            SET status = 'succeeded',
                result = ?,
                finished_at = NOW(3),
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW(3)
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        [
          JSON.stringify(input.result ?? null),
          input.runId,
          input.workerId,
          input.leaseToken,
        ],
      );
      if (updated.affectedRows === 0) return false;
      await this.insertEvent(connection, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        event: 'succeeded',
        detail: null,
      });
      return true;
    });
    if (!applied)
      await this.recordStaleWrite({
        ...input,
        operation: 'complete',
        reason: 'fencing_mismatch',
      });
    return applied;
  }

  async fail(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    error: string;
    retryable: boolean;
  }): Promise<{
    applied: boolean;
    status: RunStatus | null;
    retryDelayMs: number | null;
  }> {
    const outcome = await withTransaction(this.pool, async (connection) => {
      const rows = await queryRows(
        connection,
        `SELECT attempt, max_attempts, tenant_id FROM dist_task_runs
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
          FOR UPDATE`,
        [input.runId, input.workerId, input.leaseToken],
      );
      if (!rows.length)
        return { applied: false, status: null, retryDelayMs: null };
      const attempt = toNumber(rows[0].attempt);
      const maxAttempts = toNumber(rows[0].max_attempts);
      const message = input.error.slice(0, 4000);
      if (input.retryable && attempt < maxAttempts) {
        const delay = fullJitterBackoff(
          attempt,
          this.options.backoffBaseMs,
          this.options.backoffMaxMs,
          this.random,
        );
        await execute(
          connection,
          `UPDATE dist_task_runs
              SET status = 'retry_wait',
                  available_at = NOW(3) + INTERVAL ? MICROSECOND,
                  error = ?,
                  lease_owner = NULL,
                  lease_expires_at = NULL,
                  updated_at = NOW(3)
            WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
          [
            delay * 1000,
            message,
            input.runId,
            input.workerId,
            input.leaseToken,
          ],
        );
        await this.insertEvent(connection, {
          runId: input.runId,
          leaseToken: input.leaseToken,
          workerId: input.workerId,
          event: 'failed_retry',
          detail: { attempt, maxAttempts, retryDelayMs: delay, error: message },
        });
        await this.enqueueOutbox(
          connection,
          input.runId,
          (rows[0].tenant_id as string) ?? '',
        );
        return {
          applied: true,
          status: 'retry_wait' as RunStatus,
          retryDelayMs: delay,
        };
      }
      await execute(
        connection,
        `UPDATE dist_task_runs
            SET status = 'dead',
                error = ?,
                finished_at = NOW(3),
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW(3)
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        [message, input.runId, input.workerId, input.leaseToken],
      );
      await this.insertEvent(connection, {
        runId: input.runId,
        leaseToken: input.leaseToken,
        workerId: input.workerId,
        event: 'dead',
        detail: {
          attempt,
          maxAttempts,
          retryable: input.retryable,
          error: message,
        },
      });
      return { applied: true, status: 'dead' as RunStatus, retryDelayMs: null };
    });
    if (!outcome.applied)
      await this.recordStaleWrite({
        ...input,
        operation: 'fail',
        reason: 'fencing_mismatch',
      });
    return outcome;
  }

  /**
   * Hand a claimed run back to the queue without consuming an attempt.
   *
   * Used when a worker shuts down gracefully: a deliberate stop should not
   * burn one of the run's `max_attempts`, and `available_at` is preserved so
   * the run keeps its original position in the queue.
   */
  async release(input: {
    runId: string;
    workerId: string;
    leaseToken: number;
    /**
     * Optional re-queue delay (admission rejections). Without it a rejected run
     * keeps its original available_at, which means it stays at the head of the
     * global queue and can starve other tenants.
     */
    retryDelayMs?: number;
    /** Recorded on the `released` event so rejections are countable in SQL. */
    reason?: 'shutdown' | 'admission';
  }): Promise<boolean> {
    const applied = await withTransaction(this.pool, async (connection) => {
      const rows = await queryRows(
        connection,
        `SELECT attempt, tenant_id FROM dist_task_runs
          WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
          FOR UPDATE`,
        [input.runId, input.workerId, input.leaseToken],
      );
      if (!rows.length) return false;
      const attempt = toNumber(rows[0].attempt);
      const updated = await execute(
        connection,
        input.retryDelayMs && input.retryDelayMs > 0
          ? `UPDATE dist_task_runs
                SET status = 'queued',
                    attempt = GREATEST(attempt - 1, 0),
                    lease_token = lease_token + 1,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    available_at = NOW(3) + INTERVAL ? MICROSECOND,
                    updated_at = NOW(3)
              WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`
          : `UPDATE dist_task_runs
                SET status = 'queued',
                    attempt = GREATEST(attempt - 1, 0),
                    lease_token = lease_token + 1,
                    lease_owner = NULL,
                    lease_expires_at = NULL,
                    updated_at = NOW(3)
              WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?`,
        input.retryDelayMs && input.retryDelayMs > 0
          ? [
              input.retryDelayMs * 1000,
              input.runId,
              input.workerId,
              input.leaseToken,
            ]
          : [input.runId, input.workerId, input.leaseToken],
      );
      if (updated.affectedRows === 0) return false;
      await this.insertEvent(connection, {
        runId: input.runId,
        leaseToken: input.leaseToken + 1,
        workerId: input.workerId,
        event: 'released',
        detail: {
          attempt,
          nextAttempt: Math.max(attempt - 1, 0),
          reason: input.reason ?? 'shutdown',
        },
      });
      await this.enqueueOutbox(
        connection,
        input.runId,
        (rows[0].tenant_id as string) ?? '',
      );
      return true;
    });
    if (!applied)
      await this.recordStaleWrite({
        ...input,
        operation: 'release',
        reason: 'fencing_mismatch',
      });
    return applied;
  }

  async reapExpired(limit = 100): Promise<
    Array<{
      runId: string;
      previousOwner: string | null;
      previousToken: number;
      nextStatus: RunStatus;
    }>
  > {
    if (!Number.isSafeInteger(limit) || limit < 1) return [];
    return withTransaction(
      this.pool,
      async (connection) => {
        const rows = await queryRows(
          connection,
          `SELECT id, tenant_id, lease_owner, lease_token, lease_expires_at, attempt, max_attempts
           FROM dist_task_runs
          WHERE status = 'running' AND lease_expires_at < NOW(3)
          ORDER BY lease_expires_at
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
          [limit],
        );
        const reaped: Array<{
          runId: string;
          previousOwner: string | null;
          previousToken: number;
          nextStatus: RunStatus;
        }> = [];
        for (const row of rows) {
          const attempt = toNumber(row.attempt);
          const maxAttempts = toNumber(row.max_attempts);
          const nextStatus: RunStatus =
            attempt >= maxAttempts ? 'dead' : 'retry_wait';
          const previousToken = toNumber(row.lease_token);
          const previousOwner = (row.lease_owner as string | null) ?? null;
          const previousLeaseExpiresAt = (row.lease_expires_at as Date | null)
            ? (row.lease_expires_at as Date).toISOString()
            : null;
          // `available_at` is deliberately left untouched: it already points at
          // (or before) the original submission time, so a recovered run keeps
          // its queue priority instead of jumping to the back of the backlog.
          const updated = await execute(
            connection,
            nextStatus === 'dead'
              ? `UPDATE dist_task_runs
                  SET status = ?, lease_token = lease_token + 1,
                      lease_owner = NULL, lease_expires_at = NULL,
                      finished_at = NOW(3), updated_at = NOW(3)
                WHERE id = ? AND lease_token = ?`
              : `UPDATE dist_task_runs
                  SET status = ?, lease_token = lease_token + 1,
                      lease_owner = NULL, lease_expires_at = NULL,
                      updated_at = NOW(3)
                WHERE id = ? AND lease_token = ?`,
            [nextStatus, String(row.id), previousToken],
          );
          // Another reaper won the row between SELECT and UPDATE; leave its event.
          if (updated.affectedRows !== 1) continue;
          const nextToken = previousToken + 1;
          if (nextStatus === 'retry_wait')
            await this.enqueueOutbox(
              connection,
              String(row.id),
              (row.tenant_id as string) ?? '',
            );
          await this.insertEvent(connection, {
            runId: String(row.id),
            leaseToken: nextToken,
            workerId: previousOwner,
            event: 'reaped',
            detail: {
              previousOwner,
              previousToken,
              nextToken,
              previousLeaseExpiresAt,
              nextStatus,
              attempt,
              maxAttempts,
            },
          });
          reaped.push({
            runId: String(row.id),
            previousOwner,
            previousToken,
            nextStatus,
          });
        }
        return reaped;
      },
      { isolation: 'READ COMMITTED' },
    );
  }

  async cancel(runId: string): Promise<boolean> {
    return withTransaction(this.pool, async (connection) => {
      const rows = await queryRows(
        connection,
        `SELECT lease_token FROM dist_task_runs
          WHERE id = ? AND status IN ('queued','retry_wait','running')
          FOR UPDATE`,
        [runId],
      );
      if (!rows.length) return false;
      const nextToken = toNumber(rows[0].lease_token) + 1;
      const updated = await execute(
        connection,
        `UPDATE dist_task_runs
            SET status = 'cancelled', lease_token = ?, lease_owner = NULL,
                lease_expires_at = NULL, finished_at = NOW(3), updated_at = NOW(3)
          WHERE id = ? AND status IN ('queued','retry_wait','running')`,
        [nextToken, runId],
      );
      if (updated.affectedRows === 0) return false;
      await this.insertEvent(connection, {
        runId,
        leaseToken: nextToken,
        workerId: null,
        event: 'cancelled',
        detail: null,
      });
      return true;
    });
  }

  async getRun(runId: string): Promise<TaskRun | null> {
    const rows = await queryRows(
      this.pool,
      'SELECT * FROM dist_task_runs WHERE id = ?',
      [runId],
    );
    return rows.length ? mapRun(rows[0]) : null;
  }

  async getEvents(runId: string): Promise<TaskRunEvent[]> {
    const rows = await queryRows(
      this.pool,
      'SELECT * FROM dist_task_run_events WHERE run_id = ? ORDER BY id',
      [runId],
    );
    return rows.map((row) => ({
      ...(row as TaskRunEvent),
      id: toNumber(row.id),
      lease_token: toNumber(row.lease_token),
    }));
  }

  async countEvents(runId: string, event: RunEventName): Promise<number> {
    const rows = await queryRows(
      this.pool,
      'SELECT COUNT(*) AS total FROM dist_task_run_events WHERE run_id = ? AND event = ?',
      [runId, event],
    );
    return toNumber(rows[0]?.total);
  }

  /** Exposed for tests that need to simulate a worker dying mid-flight. */
  async forceExpireLease(runId: string): Promise<void> {
    await execute(
      this.pool,
      `UPDATE dist_task_runs
          SET lease_expires_at = NOW(3) - INTERVAL 1 MILLISECOND, updated_at = NOW(3)
        WHERE id = ? AND status = 'running'`,
      [runId],
    );
  }
}

export type { PoolConnection };
