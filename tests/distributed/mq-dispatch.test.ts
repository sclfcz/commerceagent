import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  openDlq,
  closeDlq,
  dlqDepth,
  queueDepth,
  replayDlq,
} from '../../src/distributed/dlq.js';
import { SleepExecutor } from '../../src/distributed/executors.js';
import { createPool, type Pool } from '../../src/distributed/mysql.js';
import { MqConsumer } from '../../src/distributed/mq-consumer.js';
import { Relay } from '../../src/distributed/relay.js';
import { RunRepository } from '../../src/distributed/run-repository.js';
import { Worker } from '../../src/distributed/worker.js';
import {
  acquireSuiteLock,
  clearRuns,
  createTestPool,
  describeDist,
  makeRepository,
  resetSchema,
  sleep,
  TEST_AMQP_URL,
  testConfig,
  uniqueQueuePrefix,
  uniqueTenant,
  waitFor,
} from './helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 240_000 });

function tenant() {
  return uniqueTenant('mq');
}

describeDist('mq dispatch', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool();
    release = await acquireSuiteLock();
    await resetSchema(pool);
    repository = makeRepository(pool, { leaseMs: 5_000 });
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('relay crash after confirm: duplicate publish, single claim', async () => {
    await clearRuns(pool);
    const prefix = uniqueQueuePrefix('crash');
    const relayOptions = {
      pool,
      amqpUrl: TEST_AMQP_URL,
      topology: { queuePrefix: prefix },
      batchSize: 50,
      pollIntervalMs: 50,
    };

    const { run } = await repository.submit({
      tenantId: tenant(),
      taskId: 'crash-after-confirm',
      idempotencyKey: 'crash-1',
      payload: { sleepMs: 5 },
    });

    // 1. Publish + confirm, then "die" before COMMIT.
    const crashingRelay = new Relay({
      ...relayOptions,
      crashAfterConfirmRate: 1,
      exit: () => {
        throw new Error('relay_crash_after_confirm');
      },
    });
    await expect(crashingRelay.tick()).rejects.toThrow(
      'relay_crash_after_confirm',
    );
    await crashingRelay.stop();

    const outbox = (
      await pool.query(
        'SELECT status, publish_attempts FROM dist_outbox WHERE run_id = ?',
        [run.id],
      )
    )[0] as Array<{ status: string; publish_attempts: number }>;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].status).toBe('pending');

    const handle = await openDlq(TEST_AMQP_URL, { queuePrefix: prefix });
    try {
      expect(await queueDepth(handle, handle.topology.mainQueue)).toBe(1);
    } finally {
      await closeDlq(handle);
    }

    // 2. A worker consumes the published message and executes the run once.
    const config = testConfig({
      workerId: 'crash-worker',
      concurrency: 2,
      heartbeatMs: 500,
      leaseMs: 5_000,
      dispatch: 'mq',
      amqpUrl: TEST_AMQP_URL,
      fallbackPollMs: 30_000,
    });
    const startConsumer = async (consumerId: string) => {
      const worker = new Worker({
        repository,
        executor: new SleepExecutor(),
        config: { ...config, workerId: consumerId },
      });
      const consumer = new MqConsumer({
        amqpUrl: TEST_AMQP_URL,
        repository,
        worker,
        concurrency: 2,
        consumerId,
        topology: { queuePrefix: prefix },
      });
      worker.start();
      await consumer.start();
      return { worker, consumer };
    };

    const first = await startConsumer('crash-worker');
    try {
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'succeeded',
        { label: 'run to succeed through MQ', timeoutMs: 20_000 },
      );
    } finally {
      await first.consumer.stop();
      await first.worker.stop();
    }
    expect(await repository.countEvents(run.id, 'claimed')).toBe(1);

    // 3. The relay runs again and re-publishes the same outbox row (same
    //    messageId), because the crash happened before the COMMIT. The failed
    //    attempt pushed available_at 100ms out, so wait for it to become due.
    const relay = new Relay(relayOptions);
    try {
      await waitFor(async () => (await relay.tick()).published === 1, {
        label: 'outbox row to be re-published',
        timeoutMs: 10_000,
      });
    } finally {
      await relay.stop();
    }

    // A different worker receives the re-published message. The run is already
    // finished, so the database rejects the claim and records `skipped` — the
    // duplicate is absorbed, not executed twice.
    const second = await startConsumer('crash-worker-2');
    try {
      await waitFor(
        async () => {
          const rows = (
            await pool.query(
              `SELECT outcome, COUNT(*) AS total FROM dist_consumed_messages
              WHERE run_id = ? GROUP BY outcome`,
              [run.id],
            )
          )[0] as Array<{ outcome: string; total: number }>;
          return rows.some(
            (row) => row.outcome === 'duplicate' || row.outcome === 'skipped',
          );
        },
        { label: 'duplicate delivery to be recorded', timeoutMs: 20_000 },
      );
    } finally {
      await second.consumer.stop();
      await second.worker.stop();
    }

    const outcomes = (
      await pool.query(
        `SELECT outcome, COUNT(*) AS total FROM dist_consumed_messages
        WHERE run_id = ? GROUP BY outcome`,
        [run.id],
      )
    )[0] as Array<{ outcome: string; total: number }>;
    const byOutcome = Object.fromEntries(
      outcomes.map((row) => [row.outcome, Number(row.total)]),
    );
    expect(byOutcome.claimed).toBe(1);
    expect((byOutcome.duplicate ?? 0) + (byOutcome.skipped ?? 0)).toBe(1);
    // The database stayed authoritative: one claim, one success.
    expect(await repository.countEvents(run.id, 'claimed')).toBe(1);
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(1);
  });

  test('claimById deduplicates message ids and skips unavailable runs', async () => {
    await clearRuns(pool);
    const first = await repository.submit({
      tenantId: tenant(),
      taskId: 'dedupe',
      idempotencyKey: 'dedupe-1',
      payload: { sleepMs: 1 },
    });
    const claimed = await repository.claimById({
      workerId: 'dedupe-worker',
      runId: first.run.id,
      messageId: 'message-1',
    });
    expect(claimed.outcome).toBe('claimed');
    expect(claimed.claim?.runId).toBe(first.run.id);

    const duplicate = await repository.claimById({
      workerId: 'dedupe-worker',
      runId: first.run.id,
      messageId: 'message-1',
    });
    expect(duplicate.outcome).toBe('duplicate');

    // A different message id for an already running run is skipped, not claimed.
    const skipped = await repository.claimById({
      workerId: 'dedupe-worker',
      runId: first.run.id,
      messageId: 'message-2',
    });
    expect(skipped.outcome).toBe('skipped');
    expect(await repository.countEvents(first.run.id, 'claimed')).toBe(1);
  });

  test('purging the main queue still completes the run via fallback polling', async () => {
    await clearRuns(pool);
    const prefix = uniqueQueuePrefix('fallback');
    const { run } = await repository.submit({
      tenantId: tenant(),
      taskId: 'fallback',
      idempotencyKey: 'fallback-1',
      payload: { sleepMs: 5 },
    });

    // Simulate a lost wake-up: no relay runs and the main queue is empty.
    const handle = await openDlq(TEST_AMQP_URL, { queuePrefix: prefix });
    try {
      await handle.channel.purgeQueue(handle.topology.mainQueue);
      expect(await queueDepth(handle, handle.topology.mainQueue)).toBe(0);
    } finally {
      await closeDlq(handle);
    }

    const config = testConfig({
      workerId: 'fallback-worker',
      concurrency: 2,
      heartbeatMs: 500,
      leaseMs: 5_000,
      dispatch: 'mq',
      amqpUrl: TEST_AMQP_URL,
      fallbackPollMs: 300,
    });
    const worker = new Worker({
      repository,
      executor: new SleepExecutor(),
      config,
    });
    const consumer = new MqConsumer({
      amqpUrl: TEST_AMQP_URL,
      repository,
      worker,
      concurrency: 2,
      consumerId: 'fallback-worker',
      topology: { queuePrefix: prefix },
    });
    worker.start();
    await consumer.start();
    try {
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'succeeded',
        { label: 'fallback poll to execute the run', timeoutMs: 20_000 },
      );
    } finally {
      await consumer.stop();
      await worker.stop();
    }
    const claimed = (await repository.getEvents(run.id)).filter(
      (event) => event.event === 'claimed',
    );
    expect(claimed).toHaveLength(1);
    expect((claimed[0].detail as Record<string, unknown>)?.via).toBeUndefined();
  });

  test('consumer DB outage walks the retry ladder, DLQ replay executes', async () => {
    await clearRuns(pool);
    const prefix = uniqueQueuePrefix('retry');
    const retryTtlsMs = [120, 160, 200];
    const topology = { queuePrefix: prefix, retryTtlsMs };

    const { run } = await repository.submit({
      tenantId: tenant(),
      taskId: 'retry-ladder',
      idempotencyKey: 'retry-ladder-1',
      payload: { sleepMs: 5 },
    });
    const relay = new Relay({
      pool,
      amqpUrl: TEST_AMQP_URL,
      topology,
      batchSize: 10,
      pollIntervalMs: 50,
    });
    try {
      expect((await relay.tick()).published).toBe(1);
    } finally {
      await relay.stop();
    }

    // A consumer whose database is unreachable fails every claim.
    const brokenPool = createPool(
      `mysql://dist:dist@127.0.0.1:3307/missing_${Date.now()}`,
      { connectionLimit: 2 },
    );
    const brokenRepository = new RunRepository(brokenPool, {
      leaseMs: 5_000,
      backoffBaseMs: 50,
      backoffMaxMs: 100,
    });
    const brokenConsumer = new MqConsumer({
      amqpUrl: TEST_AMQP_URL,
      repository: brokenRepository,
      worker: { inFlight: 0, adopt: () => {} },
      concurrency: 2,
      consumerId: 'broken-consumer',
      topology,
    });
    await brokenConsumer.start();
    let handle = await openDlq(TEST_AMQP_URL, topology);
    try {
      await waitFor(async () => (await dlqDepth(handle)) > 0, {
        label: 'message to reach the DLQ',
        timeoutMs: 30_000,
        intervalMs: 100,
      });
    } finally {
      await closeDlq(handle);
      await brokenConsumer.stop();
      await brokenPool.end();
    }

    // Replay: with a healthy consumer the same run is claimed and executed.
    handle = await openDlq(TEST_AMQP_URL, topology);
    try {
      const replayed = await replayDlq(handle, 1);
      expect(replayed.replayed).toBe(1);
    } finally {
      await closeDlq(handle);
    }

    const config = testConfig({
      workerId: 'healthy-worker',
      concurrency: 2,
      heartbeatMs: 500,
      leaseMs: 5_000,
      dispatch: 'mq',
      amqpUrl: TEST_AMQP_URL,
      fallbackPollMs: 30_000,
    });
    const worker = new Worker({
      repository,
      executor: new SleepExecutor(),
      config,
    });
    const consumer = new MqConsumer({
      amqpUrl: TEST_AMQP_URL,
      repository,
      worker,
      concurrency: 2,
      consumerId: 'healthy-worker',
      topology,
    });
    worker.start();
    await consumer.start();
    try {
      await waitFor(
        async () => (await repository.getRun(run.id))?.status === 'succeeded',
        { label: 'replayed run to execute', timeoutMs: 20_000 },
      );
    } finally {
      await consumer.stop();
      await worker.stop();
    }
    expect(await repository.countEvents(run.id, 'succeeded')).toBe(1);
    await sleep(50);
  });
});
