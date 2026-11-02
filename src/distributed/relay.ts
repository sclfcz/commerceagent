import type { ConfirmChannel } from 'amqplib';
import { withTransaction } from './mysql.js';
import type { Pool } from './mysql.js';
import {
  connectAmqp,
  declareTopology,
  RECOVERED_ROUTING_KEY,
  ROUTING_KEY,
  topologyFor,
  type Topology,
  type TopologyOptions,
} from './amqp-topology.js';

export interface RelayOptions {
  pool: Pool;
  amqpUrl: string;
  /** Rows per claim/publish batch. */
  batchSize?: number;
  /** Idle sleep between batches. */
  pollIntervalMs?: number;
  /** `waitForConfirms` timeout for one batch. */
  confirmTimeoutMs?: number;
  /** Fault injection: exit after confirms but before COMMIT (creates duplicates). */
  crashAfterConfirmRate?: number;
  /** Fault injection: publish the same message twice. */
  duplicateRate?: number;
  /** How often to delete published rows older than the retention window. */
  cleanupIntervalMs?: number;
  cleanupRetentionMs?: number;
  topology?: TopologyOptions;
  /** Overridable for tests; defaults to `process.exit`. */
  exit?: (code: number) => never;
  logger?: (event: Record<string, unknown>) => void;
  random?: () => number;
}

interface OutboxRow {
  id: number | string;
  run_id: string;
  event_type: string;
  payload: { runId?: string; tenantId?: string } | null;
}

export interface RelayBatchResult {
  claimed: number;
  published: number;
  failed: number;
  duplicatesInjected: number;
}

/**
 * Transactional outbox relay.
 *
 * MySQL is the source of truth: a batch of `pending` rows is locked with
 * `FOR UPDATE SKIP LOCKED`, published to the broker with publisher confirms,
 * and only then marked `published` and committed. A crash between confirm and
 * commit therefore re-publishes the same `messageId`; consumers deduplicate.
 */
export class Relay {
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly crashAfterConfirmRate: number;
  private readonly duplicateRate: number;
  private readonly cleanupIntervalMs: number;
  private readonly cleanupRetentionMs: number;
  private readonly exit: (code: number) => never;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly random: () => number;

  private connection: Awaited<ReturnType<typeof connectAmqp>> | null = null;
  private confirmChannel: ConfirmChannel | null = null;
  private topology: Topology;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCleanupAt = 0;
  private inFlight: Promise<void> = Promise.resolve();
  private stopping = false;
  private readonly counters = {
    batches: 0,
    published: 0,
    failed: 0,
    duplicatesInjected: 0,
    deadlockRetries: 0,
  };

  constructor(private readonly options: RelayOptions) {
    this.batchSize = options.batchSize ?? 100;
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 5_000;
    this.crashAfterConfirmRate = options.crashAfterConfirmRate ?? 0;
    this.duplicateRate = options.duplicateRate ?? 0;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 10 * 60_000;
    this.cleanupRetentionMs = options.cleanupRetentionMs ?? 24 * 60 * 60_000;
    this.exit = options.exit ?? ((code: number) => process.exit(code) as never);
    this.logger = options.logger ?? (() => {});
    this.random = options.random ?? Math.random;
    this.topology = topologyFor(options.topology);
  }

  get queueTopology(): Topology {
    return this.topology;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      this.inFlight = this.inFlight.then(() => this.runOnce());
    }, this.pollIntervalMs);
  }

  private async ensureChannel(): Promise<ConfirmChannel> {
    if (this.confirmChannel) return this.confirmChannel;
    this.connection = await connectAmqp(this.options.amqpUrl);
    this.connection.on('error', (error) => {
      this.logger({
        event: 'relay_connection_error',
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
    });
    this.connection.on('close', () => {
      this.confirmChannel = null;
    });
    this.confirmChannel = await this.connection.createConfirmChannel();
    this.topology = await declareTopology(
      this.confirmChannel,
      this.options.topology,
    );
    return this.confirmChannel;
  }

  private async runOnce(): Promise<void> {
    if (this.stopping) return;
    try {
      const result = await this.tick();
      if (result.claimed)
        this.logger({
          event: 'relay_batch',
          claimed: result.claimed,
          published: result.published,
          failed: result.failed,
          duplicatesInjected: result.duplicatesInjected,
        });
      if (Date.now() - this.lastCleanupAt > this.cleanupIntervalMs) {
        this.lastCleanupAt = Date.now();
        await this.cleanup();
      }
    } catch (error) {
      this.logger({
        event: 'relay_tick_failed',
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
    }
  }

  /** Publish at most one batch; returns how many rows were handled. */
  async tick(): Promise<RelayBatchResult> {
    const channel = await this.ensureChannel();
    let attempted: number[] = [];
    try {
      const batch = await withTransaction<{
        selected: OutboxRow[];
        duplicates: number;
      }>(
        this.options.pool,
        async (connection) => {
          const [rawRows] = await connection.query(
            `SELECT id, run_id, event_type, payload FROM dist_outbox
              WHERE status = 'pending' AND available_at <= NOW(3)
              ORDER BY id
              LIMIT ?
              FOR UPDATE SKIP LOCKED`,
            [this.batchSize],
          );
          const selected = rawRows as OutboxRow[];
          if (!selected.length) return { selected, duplicates: 0 };
          attempted = selected.map((row) => Number(row.id));

          let duplicates = 0;
          for (const row of selected) {
            const runId = row.payload?.runId ?? row.run_id;
            const body = Buffer.from(
              JSON.stringify({
                runId,
                tenantId: row.payload?.tenantId ?? null,
              }),
            );
            // The outbox id doubles as the broker message id, so a re-publish
            // after a crash is recognisable as the same logical message.
            const publishOptions = {
              persistent: true,
              messageId: String(row.id),
              contentType: 'application/json',
              headers: { 'x-run-id': runId },
            };
            // Recovered work jumps the backlog through the priority lane.
            const routingKey =
              row.event_type === 'run.recovered'
                ? RECOVERED_ROUTING_KEY
                : ROUTING_KEY;
            channel.publish(
              this.topology.exchange,
              routingKey,
              body,
              publishOptions,
            );
            if (this.duplicateRate > 0 && this.random() < this.duplicateRate) {
              channel.publish(
                this.topology.exchange,
                routingKey,
                body,
                publishOptions,
              );
              duplicates += 1;
            }
          }
          await this.waitForConfirms(channel);

          if (
            this.crashAfterConfirmRate > 0 &&
            this.random() < this.crashAfterConfirmRate
          ) {
            // Simulates SIGKILL between broker confirm and COMMIT: the
            // transaction rolls back, rows stay pending, and the same
            // messages are published again on the next relay run.
            this.logger({ event: 'relay_crash_after_confirm' });
            this.exit(1);
            throw new Error('relay_exit_unreachable');
          }

          const placeholders = selected.map(() => '?').join(',');
          await connection.query(
            `UPDATE dist_outbox
                SET status = 'published', published_at = NOW(3), last_error = NULL
              WHERE id IN (${placeholders})`,
            selected.map((row) => row.id),
          );
          return { selected, duplicates };
        },
        { onRetry: () => (this.counters.deadlockRetries += 1) },
      );

      if (!batch.selected.length)
        return { claimed: 0, published: 0, failed: 0, duplicatesInjected: 0 };
      this.counters.published += batch.selected.length;
      this.counters.batches += 1;
      this.counters.duplicatesInjected += batch.duplicates;
      return {
        claimed: batch.selected.length,
        published: batch.selected.length,
        failed: 0,
        duplicatesInjected: batch.duplicates,
      };
    } catch (error) {
      this.counters.failed += 1;
      await this.recordFailure(
        attempted,
        error instanceof Error ? error.message : String(error),
      ).catch(() => {});
      throw error;
    }
  }

  private async waitForConfirms(channel: ConfirmChannel): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        channel.waitForConfirms(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('relay_confirm_timeout')),
            this.confirmTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Failed batches are rolled back, then their attempts/last_error are bumped
   * in a separate transaction (the row must stay pending, not disappear).
   */
  private async recordFailure(ids: number[], message: string): Promise<void> {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const backoffMicros = 100_000; // 100ms; the next tick retries the batch
    await this.options.pool.query(
      `UPDATE dist_outbox
          SET publish_attempts = publish_attempts + 1,
              last_error = ?,
              available_at = NOW(3) + INTERVAL ? MICROSECOND
        WHERE id IN (${placeholders})`,
      [message.slice(0, 2000), backoffMicros, ...ids],
    );
  }

  async cleanup(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const [result] = await this.options.pool.query(
        `DELETE FROM dist_outbox
          WHERE status = 'published'
            AND published_at < NOW(3) - INTERVAL ? MICROSECOND
          ORDER BY id
          LIMIT 1000`,
        [this.cleanupRetentionMs * 1000],
      );
      const affected = Number(
        (result as { affectedRows?: number }).affectedRows ?? 0,
      );
      deleted += affected;
      if (affected < 1000) break;
    }
    return deleted;
  }

  stats() {
    return { ...this.counters };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight.catch(() => {});
    try {
      await this.confirmChannel?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.connection?.close();
    } catch {
      /* already closed */
    }
    this.confirmChannel = null;
    this.connection = null;
  }
}
