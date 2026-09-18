import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test } from 'vitest';

import {
  assessContextBudget,
  calculateStaticStartupTokens,
} from '../container/agent-runner/src/context-budget.js';

function usage(
  startupTokens: number,
  maxTokens = 200_000,
  totalTokens = startupTokens,
): SDKControlGetContextUsageResponse {
  return {
    categories: [],
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage: (totalTokens / maxTokens) * 100,
    gridRows: [],
    model: 'test-model',
    memoryFiles: [],
    mcpTools: [],
    systemPromptSections: [{ name: 'CommerceAgent', tokens: startupTokens }],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  };
}

describe('startup context budget', () => {
  test('counts static sources but excludes conversation history', () => {
    const value = usage(20_000, 200_000, 170_000);
    value.memoryFiles.push({ path: 'CLAUDE.md', type: 'project', tokens: 500 });
    value.skills = {
      totalSkills: 1,
      includedSkills: 1,
      tokens: 1_000,
      skillFrontmatter: [],
    };

    expect(calculateStaticStartupTokens(value)).toBe(21_500);
    expect(assessContextBudget(value).status).toBe('ok');
  });

  test('uses min(50k, 25%) warning and min(100k, 40%) hard limits', () => {
    const soft = assessContextBudget(usage(50_000));
    expect(soft).toMatchObject({
      status: 'warning',
      warningThreshold: 50_000,
      hardThreshold: 80_000,
    });

    const hard = assessContextBudget(usage(80_000));
    expect(hard).toMatchObject({
      status: 'hard_exceeded',
      warningThreshold: 50_000,
      hardThreshold: 80_000,
    });
  });

  test('scales thresholds for small windows and degrades safely without usage', () => {
    expect(assessContextBudget(usage(10_000, 32_000))).toMatchObject({
      status: 'warning',
      warningThreshold: 8_000,
      hardThreshold: 12_800,
    });
    expect(assessContextBudget(undefined)).toMatchObject({
      status: 'unavailable',
      warning: expect.any(String),
    });
  });
});
