#!/usr/bin/env node
/**
 * Standalone worker process.
 *
 * Applies pending migrations, then runs a Worker (claims and executes) and a
 * Reaper (recovers expired leases) until SIGTERM/SIGINT.
 */
import { loadDistributedConfig } from './config.js';
import { createPool } from './mysql.js';
import { runMigrations } from './migrate.js';
import { RunRepository } from './run-repository.js';
import { RuntimeStats } from './runtime-stats.js';
import { SleepExecutor } from './executors.js';
import { Worker } from './worker.js';
import { Reaper } from './reaper.js';
import { MqConsumer } from './mq-consumer.js';

const log = (event: Record<string, unknown>) => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
  );
};

async function main(): Promise<void> {
  const config = loadDistributedConfig();
  const stats = new RuntimeStats();
  const pool = createPool(config.mysqlUrl, {
    connectionLimit: Math.min(64, Math.max(6, config.concurrency * 2 + 2)),
  });
  let worker: Worker | null = null;
  let reaper: Reaper | null = null;
  let consumer: MqConsumer | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: 'shutdown_started', signal, workerId: config.workerId });
    try {
      await consumer?.stop();
      await reaper?.stop();
      await worker?.stop();
      // Last stdout line: `dist:bench` parses this to aggregate claim latency
      // and deadlock retries across worker processes.
      log({
        event: 'worker_stats',
        workerId: config.workerId,
        dispatch: config.dispatch,
        consumer: consumer?.stats() ?? null,
        ...stats.snapshot(),
      });
      await pool.end();
      process.exit(0);
    } catch (error) {
      log({
        event: 'shutdown_failed',
        workerId: config.workerId,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const migrations = await runMigrations(pool);
  const repository = new RunRepository(pool, {
    leaseMs: config.leaseMs,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    stats,
  });
  reaper = new Reaper(repository, {
    intervalMs: config.reaperIntervalMs,
    logger: log,
  });
  worker = new Worker({
    repository,
    executor: new SleepExecutor(),
    config,
    logger: log,
  });
  reaper.start();
  worker.start();
  if (config.dispatch === 'mq') {
    consumer = new MqConsumer({
      amqpUrl: config.amqpUrl,
      repository,
      worker,
      concurrency: config.concurrency,
      consumerId: config.workerId,
      logger: log,
    });
    await consumer.start();
    log({
      event: 'consumer_started',
      queue: consumer.queueTopology.mainQueue,
      prefetch: config.concurrency,
    });
  }
  log({
    event: 'worker_started',
    workerId: config.workerId,
    leaseMs: config.leaseMs,
    heartbeatMs: config.heartbeatMs,
    concurrency: config.concurrency,
    claimBatch: config.claimBatch,
    dispatch: config.dispatch,
    migrationsApplied: migrations.applied,
  });
}

main().catch((error) => {
  log({
    event: 'worker_failed',
    error: error instanceof Error ? error.message.slice(0, 500) : String(error),
  });
  process.exit(1);
});
