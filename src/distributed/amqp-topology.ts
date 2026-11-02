import amqp from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel } from 'amqplib';

/**
 * Broker topology for the run dispatcher.
 *
 * Only the main queue is quorum-backed: it holds the work that must survive a
 * broker restart. Retry queues are classic because they only carry delay
 * (per-queue `x-message-ttl` + dead-lettering back to the exchange).
 */
export const EXCHANGE = 'dist.runs';
export const ROUTING_KEY = 'run.ready';
/**
 * Recovered work (lease expiry, admission rejection, graceful hand-back) gets
 * its own queue: RabbitMQ 4 quorum queues reject `x-max-priority` (406), so the
 * priority lane is a separate queue whose consumer is otherwise idle.
 */
export const RECOVERED_ROUTING_KEY = 'run.recovered';
export const DEFAULT_QUEUE_PREFIX = 'dist.runs';
export const DEFAULT_RETRY_TTLS_MS = [5_000, 30_000, 300_000] as const;
export const MAX_RETRY_COUNT = 5;

export interface TopologyOptions {
  /** Defaults to `dist.runs`; tests use a unique prefix to isolate queues. */
  queuePrefix?: string;
  /** Overrides the retry delays; queue names then use numeric suffixes. */
  retryTtlsMs?: number[];
}

export interface RetryQueue {
  name: string;
  ttlMs: number;
}

export interface Topology {
  exchange: string;
  mainQueue: string;
  /** Priority lane for `run.recovered`; consumed before the main backlog. */
  priorityQueue: string;
  retryQueues: RetryQueue[];
  deadLetterQueue: string;
}

export function topologyFor(options: TopologyOptions = {}): Topology {
  const prefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
  const customTtls = options.retryTtlsMs;
  const ttls = customTtls?.length ? customTtls : [...DEFAULT_RETRY_TTLS_MS];
  return {
    exchange: EXCHANGE,
    mainQueue: `${prefix}.ready`,
    priorityQueue: `${prefix}.ready.hp`,
    retryQueues: ttls.map((ttlMs, index) => ({
      // Canonical names encode the delay; custom (test) delays get a stable
      // numeric suffix so two different TTL sets never collide on arguments.
      name: customTtls
        ? `${prefix}.retry.${index + 1}`
        : `${prefix}.retry.${formatTtl(ttlMs)}`,
      ttlMs,
    })),
    deadLetterQueue: `${prefix}.dlq`,
  };
}

function formatTtl(ttlMs: number): string {
  return `${Math.round(ttlMs / 1000)}s`;
}

/** Queue a message with the given retry count should go to (or the DLQ). */
export function retryTargetFor(
  topology: Topology,
  retryCount: number,
): { queue: string; deadLetter: boolean } {
  if (retryCount >= MAX_RETRY_COUNT)
    return { queue: topology.deadLetterQueue, deadLetter: true };
  if (retryCount <= 0) {
    return { queue: topology.retryQueues[0].name, deadLetter: false };
  }
  if (retryCount === 1) {
    const second = topology.retryQueues[1] ?? topology.retryQueues[0];
    return { queue: second.name, deadLetter: false };
  }
  const slowest =
    topology.retryQueues[topology.retryQueues.length - 1] ??
    topology.retryQueues[0];
  return { queue: slowest.name, deadLetter: false };
}

export async function declareTopology(
  channel: Channel,
  options: TopologyOptions = {},
): Promise<Topology> {
  const topology = topologyFor(options);
  await channel.assertExchange(topology.exchange, 'direct', { durable: true });
  await channel.assertQueue(topology.mainQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(topology.mainQueue, topology.exchange, ROUTING_KEY);
  await channel.assertQueue(topology.priorityQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'quorum' },
  });
  await channel.bindQueue(
    topology.priorityQueue,
    topology.exchange,
    RECOVERED_ROUTING_KEY,
  );
  for (const queue of topology.retryQueues) {
    await channel.assertQueue(queue.name, {
      durable: true,
      arguments: {
        'x-queue-type': 'classic',
        'x-message-ttl': queue.ttlMs,
        'x-dead-letter-exchange': topology.exchange,
        'x-dead-letter-routing-key': ROUTING_KEY,
      },
    });
  }
  await channel.assertQueue(topology.deadLetterQueue, {
    durable: true,
    arguments: { 'x-queue-type': 'classic' },
  });
  return topology;
}

export async function connectAmqp(url: string): Promise<ChannelModel> {
  return amqp.connect(url);
}

export async function createChannels(model: ChannelModel): Promise<{
  channel: Channel;
  confirmChannel: ConfirmChannel;
}> {
  const channel = await model.createChannel();
  const confirmChannel = await model.createConfirmChannel();
  return { channel, confirmChannel };
}
