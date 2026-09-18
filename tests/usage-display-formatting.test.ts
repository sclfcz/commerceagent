import { describe, expect, test } from 'vitest';
import {
  getAuthoritativeTokenBreakdown,
  getDisplayedTokenTotal,
  getPrimaryModelUsage,
  parseTokenUsage,
} from '../web/src/lib/token-usage-presentation.js';
import {
  formatFeishuTokenSummary,
  formatFeishuUsageNote,
} from '../src/feishu-usage-display.js';
import { buildMetaRow } from '../src/feishu-cards/sections.js';

describe('web token usage presentation', () => {
  test('uses root five-class totals instead of the highest-cost model', () => {
    const usage = parseTokenUsage(
      JSON.stringify({
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 100_000,
        cacheCreationInputTokens: 25_000,
        modelUsage: {
          'claude-opus': {
            inputTokens: 900,
            outputTokens: 450,
            costUSD: 2,
          },
          'internal-router': {
            inputTokens: 100,
            outputTokens: 50,
            costUSD: 0.01,
          },
        },
      }),
    );

    expect(usage).not.toBeNull();
    expect(getAuthoritativeTokenBreakdown(usage!)).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 25_000,
      reasoningTokens: 0,
      totalTokens: 126_500,
    });
    expect(getPrimaryModelUsage(usage!)?.[0]).toBe('claude-opus');
  });

  test('counts cache creation even when cache read and model usage are absent', () => {
    const usage = parseTokenUsage(
      JSON.stringify({
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationInputTokens: 3_000,
      }),
    );

    expect(getAuthoritativeTokenBreakdown(usage!).totalTokens).toBe(3_030);
  });

  test('counts Kaboo reasoning as a separate conserved token class', () => {
    const usage = parseTokenUsage(
      JSON.stringify({ outputTokens: 250, reasoningTokens: 750 }),
    );
    expect(getAuthoritativeTokenBreakdown(usage!)).toMatchObject({
      outputTokens: 250,
      reasoningTokens: 750,
      totalTokens: 1_000,
    });
  });

  test('supplements a zero main-message ledger with Workflow subagent usage', () => {
    const usage = parseTokenUsage(
      JSON.stringify({ inputTokens: 0, outputTokens: 0, durationMs: 296_100 }),
    );

    expect(getDisplayedTokenTotal(usage!, [251_749])).toBe(251_749);
  });
});

describe('Feishu token usage presentation', () => {
  const highCacheUsage = {
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadInputTokens: 100_000,
    cacheCreationInputTokens: 25_000,
  };

  test('shows an all-class total and labels cache read/write separately', () => {
    expect(formatFeishuTokenSummary(highCacheUsage)).toBe(
      '126.5K tokens（输入 1.0K · 输出 500 · 缓存读取 100.0K · 缓存写入 25.0K）',
    );
  });

  test('includes the same breakdown in legacy usage notes', () => {
    const note = formatFeishuUsageNote({
      ...highCacheUsage,
      costUSD: 1.23456,
      durationMs: 2_500,
      numTurns: 3,
    });

    expect(note).toContain('126.5K tokens');
    expect(note).toContain('缓存读取 100.0K');
    expect(note).toContain('缓存写入 25.0K');
    expect(note).toContain('$1.2346 · 2.5s · 3 turns');
  });

  test('uses the same breakdown in structured card metadata', () => {
    const row = buildMetaRow(highCacheUsage);
    const serialized = JSON.stringify(row);

    expect(serialized).toContain('126.5K tokens');
    expect(serialized).toContain('缓存读取 100.0K');
    expect(serialized).toContain('缓存写入 25.0K');
  });

  test('keeps cache creation visible when it is the only reported class', () => {
    const serialized = JSON.stringify(
      buildMetaRow({ cacheCreationInputTokens: 3_000 }),
    );

    expect(serialized).toContain('3.0K tokens');
    expect(serialized).toContain('缓存写入 3.0K');
  });

  test('shows reasoning separately in both Feishu card modes', () => {
    const usage = { outputTokens: 250, reasoningTokens: 750 };
    expect(formatFeishuTokenSummary(usage)).toBe(
      '1.0K tokens（输入 - · 输出 250 · 推理 750）',
    );
    expect(JSON.stringify(buildMetaRow(usage))).toContain('推理 750');
  });

  test('labels missing or all-zero SDK usage as unreported, never zero tokens', () => {
    expect(formatFeishuTokenSummary({})).toBe('Token 未上报');
    expect(
      formatFeishuTokenSummary({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe('Token 未上报');

    const note = formatFeishuUsageNote({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
      costUSD: 0,
      durationMs: 296_100,
      numTurns: 1,
    });
    expect(note).toBe('💰 Token 未上报 · 296.1s');
    expect(note).not.toContain('0 tokens');
  });

  test('keeps real non-zero classes even when input/output are zero', () => {
    expect(
      formatFeishuTokenSummary({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 199_000,
        cacheCreationInputTokens: 102_500,
        reasoningTokens: 5,
      }),
    ).toBe(
      '301.5K tokens（输入 0 · 输出 0 · 缓存读取 199.0K · 缓存写入 102.5K · 推理 5）',
    );
  });
});
