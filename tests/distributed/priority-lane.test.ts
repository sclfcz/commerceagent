import { afterAll, beforeAll, expect, test } from 'vitest';
import amqp from 'amqplib';
import type { Channel, ChannelModel } from 'amqplib';
import { randomUUID } from 'node:crypto';

import {
  declareTopology,
  RECOVERED_ROUTING_KEY,
  ROUTING_KEY,
  topologyFor,
} from '../../src/distributed/amqp-topology.js';
import { TEST_AMQP_URL, describeDist } from './helpers.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describeDist('MQ priority lane', () => {
  let connection: ChannelModel;
  let channel: Channel;
  const prefix = `dist-prio-${randomUUID().slice(0, 8)}`;
  const topology = topologyFor({ queuePrefix: prefix });

  beforeAll(async () => {
    connection = await amqp.connect(TEST_AMQP_URL);
    channel = await connection.createChannel();
    await declareTopology(channel, { queuePrefix: prefix });
  });

  afterAll(async () => {
    await channel?.deleteQueue(topology.mainQueue).catch(() => {});
    await channel?.deleteQueue(topology.priorityQueue).catch(() => {});
    for (const queue of topology.retryQueues)
      await channel?.deleteQueue(queue.name).catch(() => {});
    await channel?.deleteQueue(topology.deadLetterQueue).catch(() => {});
    await channel?.close().catch(() => {});
    await connection?.close().catch(() => {});
  });

  test('a recovered run is delivered ahead of a 200-message backlog', async () => {
    for (let index = 0; index < 200; index += 1)
      channel.publish(
        topology.exchange,
        ROUTING_KEY,
        Buffer.from(JSON.stringify({ runId: `backlog-${index}` })),
        { persistent: true },
      );
    await sleep(200);
    channel.publish(
      topology.exchange,
      RECOVERED_ROUTING_KEY,
      Buffer.from(JSON.stringify({ runId: 'recovered-1' })),
      { persistent: true },
    );
    await sleep(200);

    const delivered: string[] = [];
    const consumer = await connection.createChannel();
    await consumer.prefetch(20);
    // The priority lane is subscribed first, exactly like the production
    // consumer, so a recovered wake-up is delivered before the backlog.
    await consumer.consume(topology.priorityQueue, (message) => {
      if (!message) return;
      delivered.push(JSON.parse(message.content.toString()).runId);
      consumer.ack(message);
    });
    await consumer.consume(topology.mainQueue, (message) => {
      if (!message) return;
      delivered.push(JSON.parse(message.content.toString()).runId);
      consumer.ack(message);
    });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !delivered.includes('recovered-1'))
      await sleep(20);
    expect(delivered).toContain('recovered-1');
    expect(delivered.indexOf('recovered-1')).toBeLessThan(20);
    await consumer.close();
  });
});
