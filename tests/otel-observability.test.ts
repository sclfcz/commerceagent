import { createServer, type Server } from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StreamEvent } from '../shared/stream-event.js';
import {
  createObservabilityRun,
  getObservabilityExportFailureCount,
  type ObservabilityExportConfig,
} from '../src/otel-observability.js';

const identity = {
  runId: 'run-synthetic-123',
  turnId: 'turn-synthetic-456',
  workspace: '/synthetic/workspace',
  profileVersion: 7,
  userId: 'user-synthetic-789',
};

const config: ObservabilityExportConfig = {
  enabled: true,
  endpoint: 'http://127.0.0.1:4318',
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  sampleRate: 1,
};

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

describe('OpenTelemetry runtime export', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it('does not create an exporter or make a request while disabled', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200).end();
    });
    servers.push(server);
    const port = await listen(server);
    const run = createObservabilityRun(identity, {
      ...config,
      endpoint: `http://127.0.0.1:${port}`,
      enabled: false,
    });

    expect(run).toBeNull();
  });

  it('exports metadata without any message or tool content', async () => {
    let requestBody = '';
    let resolveRequest!: () => void;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });
    const server = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (requestBody += chunk));
      req.on('end', () => {
        res.writeHead(200).end();
        resolveRequest();
      });
    });
    servers.push(server);
    const port = await listen(server);
    const run = createObservabilityRun(identity, {
      ...config,
      endpoint: `http://127.0.0.1:${port}`,
    });
    expect(run).not.toBeNull();

    const promptMarker = 'PRIVATE_PROMPT_SENTINEL_4f32';
    const toolInputMarker = 'PRIVATE_TOOL_INPUT_SENTINEL_92bd';
    const toolResultMarker = 'PRIVATE_TOOL_RESULT_SENTINEL_e130';
    const assistantMarker = 'PRIVATE_ASSISTANT_SENTINEL_581e';
    run!.record({
      eventType: 'raw_sdk_event',
      rawType: 'stream_event/message_start',
      messageUuid: 'api-message-id-1',
      apiRequestId: 'request-id-1',
      text: promptMarker,
      rawEvent: { content: promptMarker },
    } as StreamEvent);
    run!.record({
      eventType: 'tool_use_start',
      toolName: 'get_order',
      toolUseId: 'tool-call-1',
      toolInputSummary: toolInputMarker,
      toolInput: { order: toolInputMarker },
    } as StreamEvent);
    run!.record({
      eventType: 'tool_result',
      toolUseId: 'tool-call-1',
      toolResult: toolResultMarker,
      detail: toolResultMarker,
    } as StreamEvent);
    run!.record({
      eventType: 'text_delta',
      text: assistantMarker,
    } as StreamEvent);
    run!.record({
      eventType: 'usage',
      usage: {
        eventId: 'usage-event-id-1',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        costUSD: 0.001,
        durationMs: 20,
        numTurns: 1,
        modelUsage: {
          'model-synthetic': {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 0,
            reasoningTokens: 0,
            costUSD: 0.001,
          },
        },
      },
    } as StreamEvent);
    run!.finish('completed');
    await requestReceived;

    for (const marker of [
      promptMarker,
      toolInputMarker,
      toolResultMarker,
      assistantMarker,
    ]) {
      expect(requestBody).not.toContain(marker);
    }
    expect(requestBody).toContain('run-synthetic-123');
    expect(requestBody).toContain('turn-synthetic-456');
    expect(requestBody).toContain('model-synthetic');
    expect(requestBody).toContain('get_order');
    expect(requestBody).toContain('usage-event-id-1');
    expect(requestBody).toContain('completed');
  });

  it('keeps turn completion and usage independent of an unreachable exporter', async () => {
    const run = createObservabilityRun(identity, {
      ...config,
      endpoint: 'http://127.0.0.1:1',
    });
    expect(run).not.toBeNull();
    const usage = {
      inputTokens: 30,
      outputTokens: 7,
      costUSD: 0.002,
    };
    const before = { ...usage };
    const startedAt = Date.now();
    run!.record({
      eventType: 'usage',
      usage: {
        eventId: 'usage-survives-export-failure',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
        costUSD: usage.costUSD,
        durationMs: 15,
        numTurns: 1,
      },
    } as StreamEvent);
    expect(() => run!.finish('completed')).not.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(usage).toEqual(before);

    await vi.waitFor(
      () => {
        expect(getObservabilityExportFailureCount()).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
  });
});
