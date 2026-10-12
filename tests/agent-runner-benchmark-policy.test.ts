import { describe, expect, test } from 'vitest';
import {
  resolveAllowedTools,
  resolveAvailableBuiltInTools,
} from '../container/agent-runner/src/eval-tool-policy.js';

describe('isolated benchmark Runner policy', () => {
  test('allows only fixture MCP tools in benchmark mode', () => {
    expect(
      resolveAllowedTools(true, ['Bash', 'Read', 'mcp__commerceagent__*']),
    ).toEqual(['mcp__commerce_fixture__*']);
  });

  test('preserves the ordinary tool set outside benchmark mode', () => {
    const defaults = ['Bash', 'Read', 'mcp__commerceagent__*'];
    expect(resolveAllowedTools(false, defaults)).toBe(defaults);
    expect(resolveAvailableBuiltInTools(false)).toBeUndefined();
  });

  test('removes built-in shell and file tools while keeping MCP tools available', () => {
    expect(resolveAvailableBuiltInTools(true)).toEqual([]);
  });
});
