import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';
import {
  connectAmqp,
  declareTopology,
  retryTargetFor,
  topologyFor,
  type Topology,
  type TopologyOptions,
} from './amqp-topology.js';
import type { RunRepository } from './run-repository.js';

export interface MqConsumerOptions {
  amqpUrl: string;
  repository: RunRepository;
  /** Adopt a claimed run for execution (the worker's `adopt`). */
  worker: { inFlight: number; adopt(claim: unknown): void };
  concurrency: number;
  /** Recorded in dist_consumed_messages; must be stable per worker. */
  consumerId: string;
  topology?: TopologyOptions;
  /** How long to hold a delivery while waiting for a free execution slot. */
  capacityWaitMs?: number;
  logger?: (event: Record<string, unknown>) => void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * RabbitMQ wake-up consumer.
 *
 * The broker message carries no authority: it only says "run X may be ready".
 * The claim happens in MySQL under the same fencing rules as poll mode, and a
 * duplicate delivery is absorbed by `dist_consumed_messages`.
 */
export class MqConsumer {
  private connection: ChannelModel | null = null;
  private channel: Channel | null = null;
  private topology: Topology;
  private consumerTag: string | null = null;
  private stopping = false;
  private readonly counters = {
    received: 0,
    claimed: 0,
    skipped: 0,
    duplicate: 0,
    retried: 0,
    deadLettered: 0,
  };

  constructor(private readonly options: MqConsumerOptions) {
    this.topology = topologyFor(options.topology);
  }

  get queueTopology(): Topology {
    return this.topology;
  }

  stats() {
    return { ...this.counters };
  }

  private reconnecting = false;

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const connection = await connectAmqp(this.options.amqpUrl);
    this.connection = connection;
    connection.on('error', (error) => {
      this.options.logger?.({
        event: 'consumer_connection_error',
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
    });
    connection.on('close', () => {
      if (!this.stopping) void this.scheduleReconnect();
    });
    const channel = await connection.createChannel();
    this.channel = channel;
    channel.on('error', (error) => {
      this.options.logger?.({
        event: 'consumer_channel_error',
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      });
    });
    channel.on('close', () => {
      if (!this.stopping) void this.scheduleReconnect();
    });
    this.topology = await declareTopology(channel, this.options.topology);
    await channel.prefetch(this.options.concurrency);
    const consumed = await channel.consume(
      this.topology.mainQueue,
      (message) => {
        if (message) void this.handle(message);
      },
      { noAck: false },
    );
    this.consumerTag = consumed.consumerTag;
  }

  /**
   * A broker restart closes the connection; keep consuming once it is back.
   * Backoff is capped at 2s so a short restart is invisible to the run.
   */
  private async scheduleReconnect(): Promise<void> {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.channel = null;
      this.connection = null;
      this.consumerTag = null;
      let delay = 200;
      while (!this.stopping) {
        try {
          await this.connect();
          this.options.logger?.({ event: 'consumer_reconnected' });
          return;
        } catch (error) {
          this.options.logger?.({
            event: 'consumer_reconnect_failed',
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 2_000);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async handle(message: ConsumeMessage): Promise<void> {
    this.counters.received += 1;
    const channel = this.channel;
    if (!channel) return;
    try {
      const runId = this.runIdOf(message);
      const messageId = String(message.properties.messageId ?? '');
      if (!runId || !messageId) {
        // Unusable wake-up: park it instead of looping forever.
        this.publishToDeadLetter(message, 'missing runId or messageId');
        channel.ack(message);
        return;
      }

      await this.waitForCapacity();
      const result = await this.options.repository.claimById({
        workerId: this.options.consumerId,
        runId,
        messageId,
      });
      if (result.outcome === 'claimed' && result.claim) {
        this.counters.claimed += 1;
        this.options.worker.adopt(result.claim);
      } else {
        this.counters[result.outcome] += 1;
      }
      // Ack as soon as the claim transaction commits. Execution can take
      // minutes, and holding the delivery unacked for that long would stall
      // prefetch, block reconnects and turn a broker restart into a replay of
      // work that is already running. The lease — not the unacked message —
      // is what protects the run from a second executor.
      channel.ack(message);
    } catch (error) {
      await this.republishForRetry(message, error);
    }
  }

  private runIdOf(message: ConsumeMessage): string {
    const header = message.properties.headers?.['x-run-id'];
    if (typeof header === 'string' && header) return header;
    try {
      const parsed = JSON.parse(message.content.toString('utf8')) as {
        runId?: unknown;
      };
      return typeof parsed.runId === 'string' ? parsed.runId : '';
    } catch {
      return '';
    }
  }

  /** Hold the delivery until the worker has a free execution slot. */
  private async waitForCapacity(): Promise<void> {
    const deadline = Date.now() + (this.options.capacityWaitMs ?? 5 * 60_000);
    while (
      !this.stopping &&
      this.options.worker.inFlight >= this.options.concurrency
    ) {
      if (Date.now() > deadline) throw new Error('consumer_capacity_timeout');
      await sleep(25);
    }
  }

  private async republishForRetry(
    message: ConsumeMessage,
    error: unknown,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel) return;
    const current = Number(message.properties.headers?.['x-retry-count'] ?? 0);
    const target = retryTargetFor(this.topology, current);
    const headers = {
      ...(message.properties.headers ?? {}),
      'x-retry-count': current + 1,
      'x-last-error':
        error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    };
    const options = {
      persistent: true,
      messageId: message.properties.messageId,
      contentType: message.properties.contentType ?? 'application/json',
      headers,
    };
    try {
      channel.sendToQueue(target.queue, message.content, options);
      this.counters.retried += 1;
      if (target.deadLetter) this.counters.deadLettered += 1;
      channel.ack(message);
      this.options.logger?.({
        event: target.deadLetter ? 'message_dead_lettered' : 'message_retried',
        queue: target.queue,
        retryCount: current + 1,
      });
    } catch (publishError) {
      // Could not park the message: requeue so it is not lost.
      this.options.logger?.({
        event: 'retry_publish_failed',
        error:
          publishError instanceof Error
            ? publishError.message.slice(0, 200)
            : 'unknown',
      });
      channel.nack(message, false, true);
    }
  }

  private publishToDeadLetter(message: ConsumeMessage, reason: string): void {
    this.channel?.sendToQueue(this.topology.deadLetterQueue, message.content, {
      persistent: true,
      messageId: message.properties.messageId,
      contentType: message.properties.contentType ?? 'application/json',
      headers: {
        ...(message.properties.headers ?? {}),
        'x-last-error': reason,
      },
    });
    this.counters.deadLettered += 1;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    try {
      if (this.channel && this.consumerTag)
        await this.channel.cancel(this.consumerTag);
    } catch {
      /* channel already gone */
    }
    try {
      await this.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      await this.connection?.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
    this.connection = null;
    this.consumerTag = null;
  }
}
