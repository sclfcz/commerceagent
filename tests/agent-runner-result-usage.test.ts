import { describe, expect, test } from 'vitest';

import {
  createResultUsageState,
  extractResultUsage,
} from '../container/agent-runner/src/result-usage.js';
import { AssistantUsageCollector } from '../container/agent-runner/src/assistant-usage.js';

function assistant(
  id: string,
  model: string,
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    reasoning_output_tokens?: number;
  },
  content: Array<Record<string, unknown>> = [],
) {
  return {
    type: 'assistant',
    uuid: `uuid-${id}`,
    message: { id, model, usage, content },
  };
}

describe('Kaboo-compatible assistant usage collection', () => {
  test('keeps the largest snapshot for one message ID and flushes it once', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest(assistant('msg-1', 'claude-sonnet-4-5', {}));
    collector.ingest(
      assistant('msg-1', 'claude-sonnet-4-5', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      }),
    );
    collector.ingest(
      assistant('msg-1', 'claude-sonnet-4-5', {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 40,
      }),
    );
    expect(collector.drain('session-1')).toMatchObject({
      eventId: 'claude-code:msg-1',
      tokens: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 40,
      },
    });
    expect(collector.drain('session-1')).toBeUndefined();
  });

  test('counts distinct message IDs even when their usage is identical', () => {
    const collector = new AssistantUsageCollector();
    const usage = {
      input_tokens: 10,
      output_tokens: 2,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 4,
    };
    collector.ingest(assistant('msg-a', 'claude-sonnet-4-5', usage));
    collector.ingest(assistant('msg-b', 'claude-sonnet-4-5', usage));
    expect(collector.drain('session-2')).toMatchObject({
      eventId: 'claude-code:msg-a',
      tokens: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 4,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 4,
          },
        },
      },
    });
    expect(collector.drain('session-2')).toMatchObject({
      eventId: 'claude-code:msg-b',
      tokens: { inputTokens: 10, outputTokens: 2 },
    });
  });

  test('accepts camelCase usage from SDK-compatible live providers', () => {
    const collector = new AssistantUsageCollector();
    collector.ingest({
      type: 'assistant',
      uuid: 'uuid-camel',
      message: {
        id: 'msg-camel',
        model: 'glm-5.2',
        usage: {
          inputTokens: 504,
          outputTokens: 6_182,
          cacheReadInputTokens: 46_656,
          cacheCreationInputTokens: 20,
          reasoningTokens: 300,
        },
        content: [],
      },
    });

    expect(collector.drain('session-camel')).toMatchObject({
      eventId: 'claude-code:msg-camel',
      tokens: {
        inputTokens: 504,
        outputTokens: 6_182,
        cacheReadInputTokens: 46_656,
        cacheCreationInputTokens: 20,
        reasoningTokens: 300,
      },
    });
  });

  test('uses the same event ID when a copied message is replayed in a fork', () => {
    const original = new AssistantUsageCollector();
    const fork = new AssistantUsageCollector();
    const message = assistant('msg-fork-stable', 'claude-sonnet-4-5', {
      input_tokens: 10,
      output_tokens: 2,
    });
    original.ingest(message);
    fork.ingest(message);
    expect(original.drain('original-session')?.eventId).toBe(
      'claude-code:msg-fork-stable',
    );
    expect(fork.drain('different-fork-session')?.eventId).toBe(
      'claude-code:msg-fork-stable',
    );
  });

  test('carves Claude thinking from output using Kaboo turn-level proportions', () => {
    const collector = new AssistantUsageCollector();
    const usage = { input_tokens: 100, output_tokens: 1_000 };
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'thinking', thinking: 'x'.repeat(300), signature: 'ignored' },
      ]),
    );
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'text', text: 'y'.repeat(100) },
      ]),
    );
    // Replayed content blocks must not distort the ratio.
    collector.ingest(
      assistant('msg-thinking', 'claude-opus-4-8', usage, [
        { type: 'thinking', thinking: 'x'.repeat(300), signature: 'ignored' },
      ]),
    );
    expect(collector.drain('session-thinking')).toMatchObject({
      tokens: {
        inputTokens: 100,
        outputTokens: 250,
        reasoningTokens: 750,
        modelUsage: {
          'claude-opus-4-8': {
            outputTokens: 250,
            reasoningTokens: 750,
          },
        },
      },
    });
  });

  test('trusts native reasoning and does not carve non-Anthropic models', () => {
    const native = new AssistantUsageCollector();
    native.ingest(
      assistant(
        'msg-native',
        'claude-opus-4-8',
        {
          output_tokens: 1_000,
          reasoning_output_tokens: 200,
        },
        [{ type: 'thinking', thinking: 'x'.repeat(300) }],
      ),
    );
    expect(native.drain('native')?.tokens).toMatchObject({
      outputTokens: 1_000,
      reasoningTokens: 200,
    });

    const proxy = new AssistantUsageCollector();
    proxy.ingest(
      assistant('msg-proxy', 'gemini-2.5-pro', { output_tokens: 1_000 }, [
        { type: 'thinking', thinking: 'x'.repeat(300) },
      ]),
    );
    expect(proxy.drain('proxy')?.tokens).toMatchObject({
      outputTokens: 1_000,
      reasoningTokens: 0,
    });
  });
});

describe('Claude Agent SDK result usage scopes', () => {
  test('keeps root usage per-result while deltaing cumulative model usage and cost', () => {
    const state = createResultUsageState();
    const first = extractResultUsage(
      {
        eventId: 'turn-1',
        usage: {
          input_tokens: 6_583,
          output_tokens: 2_049,
          cache_read_input_tokens: 50_000,
          cache_creation_input_tokens: 20,
        },
        totalCostUSD: 0.488644,
        durationMs: 20_000,
        numTurns: 8,
        modelUsage: {
          'glm-5.2[1m]': {
            inputTokens: 6_583,
            outputTokens: 2_049,
            cacheReadInputTokens: 50_000,
            cacheCreationInputTokens: 20,
            costUSD: 0.488644,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    expect(first).toMatchObject({
      inputTokens: 6_583,
      outputTokens: 2_049,
      cacheReadInputTokens: 50_000,
      cacheCreationInputTokens: 20,
      costUSD: 0.488644,
      durationMs: 20_000,
      numTurns: 8,
    });

    // Official SDK 0.3.205 shape: root usage, total cost and modelUsage have
    // grown from the previous result. Only numTurns/duration are per-result.
    const second = extractResultUsage(
      {
        eventId: 'turn-2',
        usage: {
          input_tokens: 7_107,
          output_tokens: 2_462,
          cache_read_input_tokens: 101_712,
          cache_creation_input_tokens: 20,
        },
        totalCostUSD: 0.527445,
        durationMs: 11_000,
        numTurns: 1,
        modelUsage: {
          'glm-5.2[1m]': {
            inputTokens: 7_107,
            outputTokens: 2_462,
            cacheReadInputTokens: 101_712,
            cacheCreationInputTokens: 20,
            costUSD: 0.527445,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    expect(second).toMatchObject({
      inputTokens: 524,
      outputTokens: 413,
      cacheReadInputTokens: 51_712,
      cacheCreationInputTokens: 0,
      durationMs: 11_000,
      numTurns: 1,
      modelUsage: {
        'glm-5.2[1m]': {
          inputTokens: 524,
          outputTokens: 413,
          cacheReadInputTokens: 51_712,
          cacheCreationInputTokens: 0,
        },
      },
    });
    expect(second?.costUSD).toBeCloseTo(0.038801, 9);
    expect(second?.modelUsage?.['glm-5.2[1m]'].costUSD).toBeCloseTo(
      0.038801,
      9,
    );
  });

  test('uses model deltas when a compatible provider resets root usage', () => {
    const state = createResultUsageState();
    extractResultUsage(
      {
        eventId: 'provider-1',
        usage: {
          input_tokens: 6_583,
          output_tokens: 2_049,
          cache_read_input_tokens: 50_000,
        },
        totalCostUSD: 0.488644,
        modelUsage: {
          model: {
            inputTokens: 6_583,
            outputTokens: 2_049,
            cacheReadInputTokens: 50_000,
            costUSD: 0.488644,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    const next = extractResultUsage(
      {
        eventId: 'provider-2',
        // Observed proxy shape: root reset to the current turn while
        // modelUsage and total cost remained cumulative.
        usage: {
          input_tokens: 524,
          output_tokens: 413,
          cache_read_input_tokens: 51_712,
        },
        totalCostUSD: 0.527445,
        modelUsage: {
          model: {
            inputTokens: 7_107,
            outputTokens: 2_462,
            cacheReadInputTokens: 101_712,
            costUSD: 0.527445,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    expect(next).toMatchObject({
      inputTokens: 524,
      outputTokens: 413,
      cacheReadInputTokens: 51_712,
    });
    expect(next?.costUSD).toBeCloseTo(0.038801, 9);
  });

  test('omits repeated zero-delta models when a later result switches model', () => {
    const state = createResultUsageState();
    extractResultUsage(
      {
        eventId: 'first',
        usage: { input_tokens: 10, output_tokens: 2 },
        totalCostUSD: 0.01,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0.01,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    const next = extractResultUsage(
      {
        eventId: 'second',
        usage: { input_tokens: 3, output_tokens: 1 },
        totalCostUSD: 0.02,
        modelUsage: {
          'claude-sonnet-4-5': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0.01,
          },
          'claude-haiku-4-5': {
            inputTokens: 3,
            outputTokens: 1,
            costUSD: 0.01,
          },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    expect(Object.keys(next?.modelUsage || {})).toEqual(['claude-haiku-4-5']);
  });

  test('treats a decreasing cumulative counter as a new epoch', () => {
    const state = createResultUsageState();
    extractResultUsage(
      {
        eventId: 'before-reset',
        usage: { input_tokens: 100, output_tokens: 10 },
        totalCostUSD: 2,
        modelUsage: {
          model: { inputTokens: 100, outputTokens: 10, costUSD: 2 },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    const after = extractResultUsage(
      {
        eventId: 'after-reset',
        usage: { input_tokens: 7, output_tokens: 3 },
        totalCostUSD: 0.2,
        modelUsage: {
          model: { inputTokens: 7, outputTokens: 3, costUSD: 0.2 },
        },
        fallbackModelKey: 'default',
      },
      state,
    );
    expect(after).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      costUSD: 0.2,
      modelUsage: {
        model: { inputTokens: 7, outputTokens: 3, costUSD: 0.2 },
      },
    });
  });

  test('uses each root result directly when modelUsage is unavailable', () => {
    const state = createResultUsageState();
    extractResultUsage(
      {
        eventId: 'fallback-1',
        usage: { input_tokens: 20, output_tokens: 5 },
        totalCostUSD: 0.1,
        fallbackModelKey: 'configured-model',
      },
      state,
    );
    const next = extractResultUsage(
      {
        eventId: 'fallback-2',
        usage: { input_tokens: 4, output_tokens: 1 },
        totalCostUSD: 0.13,
        fallbackModelKey: 'configured-model',
      },
      state,
    );
    expect(next?.modelUsage?.['configured-model']).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
      costUSD: 0.03,
    });
  });
});
