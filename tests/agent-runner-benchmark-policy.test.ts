import { describe, expect, test } from 'vitest';
import {
  resolveAllowedTools,
  resolveAvailableBuiltInTools,
  resolveMcpServers,
} from '../container/agent-runner/src/eval-tool-policy.js';

describe('isolated benchmark Runner policy', () => {
  test('removes the product memory MCP and any other MCP in benchmark mode', () => {
    const fixture = { name: 'fixture' };
    const product = { name: 'product' };
    const user = { commerce_fixture: fixture, other: { name: 'other' } };
    expect(resolveMcpServers(true, user, product)).toEqual({
      commerce_fixture: fixture,
    });
    expect(resolveMcpServers(false, user, product)).toEqual({
      ...user,
      commerceagent: product,
    });
    expect(resolveMcpServers(true, {}, product)).toEqual({});
  });
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
