#!/usr/bin/env node
/**
 * Standalone outbox relay.
 *
 * Reads `pending` rows from MySQL, publishes them to RabbitMQ with confirms,
 * then marks them `published` and commits. Multiple relays can run at once:
 * `FOR UPDATE SKIP LOCKED` hands each batch to exactly one relay process.
 */
import { loadDistributedConfig } from './config.js';
import { createPool } from './mysql.js';
import { Relay } from './relay.js';

const log = (event: Record<string, unknown>) => {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
  );
};

async function main(): Promise<void> {
  const config = loadDistributedConfig();
  const pool = createPool(config.mysqlUrl, { connectionLimit: 4 });
  const relay = new Relay({
    pool,
    amqpUrl: config.amqpUrl,
    batchSize: config.relayBatchSize,
    pollIntervalMs: config.relayPollMs,
    crashAfterConfirmRate: config.relayCrashAfterConfirmRate,
    duplicateRate: config.relayDuplicateRate,
    logger: log,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ event: 'relay_shutdown_started', signal });
    try {
      await relay.stop();
      // Last stdout line: the chaos/bench scripts parse it for throughput.
      log({ event: 'relay_stats', ...relay.stats() });
      await pool.end();
      process.exit(0);
    } catch (error) {
      log({
        event: 'relay_shutdown_failed',
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await relay.tick().catch((error) => {
    log({
      event: 'relay_warmup_failed',
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    });
  });
  relay.start();
  log({
    event: 'relay_started',
    queue: relay.queueTopology.mainQueue,
    exchange: relay.queueTopology.exchange,
    batchSize: config.relayBatchSize,
    pollMs: config.relayPollMs,
    crashAfterConfirmRate: config.relayCrashAfterConfirmRate,
    duplicateRate: config.relayDuplicateRate,
  });
}

main().catch((error) => {
  log({
    event: 'relay_failed',
    error: error instanceof Error ? error.message.slice(0, 500) : String(error),
  });
  process.exit(1);
});
