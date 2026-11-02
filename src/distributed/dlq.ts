import {
  connectAmqp,
  declareTopology,
  EXCHANGE,
  ROUTING_KEY,
  topologyFor,
  type Topology,
  type TopologyOptions,
} from './amqp-topology.js';

export interface DlqHandle {
  connection: Awaited<ReturnType<typeof connectAmqp>>;
  channel: Awaited<
    ReturnType<Awaited<ReturnType<typeof connectAmqp>>['createChannel']>
  >;
  topology: Topology;
}

export async function openDlq(
  amqpUrl: string,
  options: TopologyOptions = {},
): Promise<DlqHandle> {
  const connection = await connectAmqp(amqpUrl);
  const channel = await connection.createChannel();
  const topology = await declareTopology(channel, options);
  return { connection, channel, topology };
}

export async function closeDlq(handle: DlqHandle): Promise<void> {
  try {
    await handle.channel.close();
  } catch {
    /* already closed */
  }
  try {
    await handle.connection.close();
  } catch {
    /* already closed */
  }
}

export async function queueDepth(
  handle: DlqHandle,
  queue: string,
): Promise<number> {
  const info = await handle.channel.checkQueue(queue);
  return info.messageCount;
}

export async function dlqDepth(handle: DlqHandle): Promise<number> {
  return queueDepth(handle, handle.topology.deadLetterQueue);
}

/**
 * Move up to `count` parked messages back to the main queue.
 * The retry counter is reset so a replayed message gets the full retry ladder
 * instead of bouncing straight back to the DLQ on its next failure.
 */
export async function replayDlq(
  handle: DlqHandle,
  count: number,
): Promise<{ replayed: number; runIds: string[] }> {
  const replayedIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const message = await handle.channel.get(handle.topology.deadLetterQueue, {
      noAck: false,
    });
    if (!message) break;
    const headers = { ...(message.properties.headers ?? {}) };
    delete headers['x-retry-count'];
    handle.channel.publish(EXCHANGE, ROUTING_KEY, message.content, {
      persistent: true,
      messageId: message.properties.messageId,
      contentType: message.properties.contentType ?? 'application/json',
      headers: { ...headers, 'x-replayed': 'true' },
    });
    handle.channel.ack(message);
    const runId = headers['x-run-id'];
    if (typeof runId === 'string') replayedIds.push(runId);
  }
  return { replayed: replayedIds.length, runIds: replayedIds };
}

export { topologyFor };
