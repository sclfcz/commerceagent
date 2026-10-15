import { describe, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { observeTurn } from '../benchmarks/providers/commerceagent-provider.js';

async function simulate(emit: (ws: WebSocket) => void, timeoutMs = 500) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, path: '/ws' });
  let sent: unknown;
  sockets.on('connection', (ws, req) => {
    expect(req.headers.cookie).toBe('session=test');
    ws.on('message', (raw) => {
      sent = JSON.parse(raw.toString());
      emit(ws);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const observation = await observeTurn({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      cookie: 'session=test',
      workspaceJid: 'web:g',
      sessionId: 's',
      prompt: 'business question',
      timeoutMs,
    });
    expect(sent).toMatchObject({
      type: 'send_message',
      chatJid: 'web:g',
      agentId: 's',
      content: 'business question',
    });
    return observation;
  } finally {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
}
const send = (ws: WebSocket, value: unknown) => ws.send(JSON.stringify(value));
const start = { type: 'run_started', chatJid: 'web:g#agent:s', runId: 'r' };
const finish = (reason: string) => ({
  type: 'run_finished',
  chatJid: 'web:g#agent:s',
  runId: 'r',
  reason,
});

describe('exact runtime attempt lifecycle', () => {
  test('collects a final message delivered after the matching run terminal', async () => {
    const result = await simulate((ws) => {
      send(ws, start);
      send(ws, finish('completed'));
      send(ws, {
        type: 'new_message',
        chatJid: 'web:g',
        agentId: 's',
        message: {
          is_from_me: true,
          sender: 'commerceagent-agent',
          content: '{"status":"answered"}',
          turn_id: 't',
          finalization_reason: 'completed',
        },
      });
    });
    expect(result).toMatchObject({
      reason: 'completed',
      failure: null,
      output: '{"status":"answered"}',
    });
  });
  test('does not confuse the stream IPC turn id with the persisted message turn id', async () => {
    const result = await simulate((ws) => {
      send(ws, start);
      send(ws, {
        type: 'stream_event',
        chatJid: 'web:g',
        agentId: 's',
        runId: 'r',
        event: {
          eventType: 'status',
          turnId: 'ipc-run-identity',
        },
      });
      send(ws, finish('completed'));
      send(ws, {
        type: 'new_message',
        chatJid: 'web:g',
        agentId: 's',
        message: {
          is_from_me: true,
          sender: 'commerceagent-agent',
          content: '{"status":"answered"}',
          turn_id: 'persisted-message-identity',
          finalization_reason: 'completed',
        },
      });
    });
    expect(result).toMatchObject({
      failure: null,
      turnId: 'ipc-run-identity',
      messageTurnId: 'persisted-message-identity',
      output: '{"status":"answered"}',
    });
  });
  test('a host-confirmed Provider failure is not scored as a successful answer', async () => {
    const result = await simulate((ws) => {
      send(ws, start);
      send(ws, {
        type: 'new_message',
        chatJid: 'web:g',
        agentId: 's',
        message: {
          is_from_me: true,
          sender: 'commerceagent-agent',
          content: 'provider unavailable',
          turn_id: 't',
          finalization_reason: 'completed',
          provider_failure: true,
        },
      });
      send(ws, finish('completed'));
    });
    expect(result).toMatchObject({
      reason: 'completed',
      failure: 'upstream_error',
    });
  });
  test('ignores unrelated/stale events and finishes only on the matching terminal', async () => {
    const result = await simulate((ws) => {
      send(ws, start);
      send(ws, { ...finish('completed'), runId: 'stale' });
      send(ws, {
        type: 'stream_event',
        chatJid: 'web:g',
        agentId: 's',
        runId: 'stale',
        event: { eventType: 'text_delta', text: 'wrong' },
      });
      send(ws, {
        type: 'stream_event',
        chatJid: 'web:g',
        agentId: 's',
        runId: 'r',
        event: {
          eventType: 'tool_use_start',
          turnId: 't',
          toolUseId: 'tool1',
          toolName: 'mcp__commerce_fixture__get_order',
        },
      });
      send(ws, {
        type: 'new_message',
        chatJid: 'web:g',
        agentId: 'other',
        message: {
          is_from_me: true,
          sender: 'commerceagent-agent',
          content: 'wrong',
          turn_id: 't',
          finalization_reason: 'completed',
        },
      });
      send(ws, {
        type: 'new_message',
        chatJid: 'web:g',
        agentId: 's',
        message: {
          is_from_me: true,
          sender: 'commerceagent-agent',
          content: '{"status":"answered"}',
          turn_id: 't',
          finalization_reason: 'completed',
        },
      });
      send(ws, finish('completed'));
    });
    expect(result).toMatchObject({
      failure: null,
      runId: 'r',
      turnId: 't',
      output: '{"status":"answered"}',
    });
    expect(result.tools).toHaveLength(1);
  });
  test.each(['runner_exit', 'released', 'stopped'])(
    'classifies %s separately',
    async (reason) => {
      expect(
        (
          await simulate((ws) => {
            send(ws, start);
            send(ws, finish(reason));
          })
        ).failure,
      ).toBe(reason);
    },
  );
  test('completed without a final response is incomplete', async () => {
    expect(
      (
        await simulate((ws) => {
          send(ws, start);
          send(ws, finish('completed'));
        })
      ).failure,
    ).toBe('collection_incomplete');
  });
  test('distinguishes queue timeout from running timeout', async () => {
    expect((await simulate(() => {}, 100)).failure).toBe('queue_timeout');
    expect((await simulate((ws) => send(ws, start), 100)).failure).toBe(
      'run_timeout',
    );
  });
  test('disconnection and validation error never pass', async () => {
    expect((await simulate((ws) => ws.close())).failure).toBe(
      'stream_disconnected',
    );
    expect(
      (
        await simulate((ws) =>
          send(ws, {
            type: 'ws_error',
            chatJid: 'web:g',
            error: 'not accepted',
          }),
        )
      ).failure,
    ).toBe('upstream_error');
  });
  test('a replacement run is not silently folded into the original attempt', async () => {
    expect(
      (
        await simulate((ws) => {
          send(ws, start);
          send(ws, { ...start, runId: 'new' });
        })
      ).failure,
    ).toBe('collection_incomplete');
  });
});
