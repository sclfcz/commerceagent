const BENCHMARK_ALLOWED_TOOLS = ['mcp__commerce_fixture__*'];

export function resolveMcpServers<T>(
  benchmarkMode: boolean,
  userServers: Record<string, T>,
  productServer: T,
): Record<string, T> {
  if (benchmarkMode)
    return userServers.commerce_fixture
      ? { commerce_fixture: userServers.commerce_fixture }
      : {};
  return { ...userServers, commerceagent: productServer };
}

export function resolveAllowedTools(
  benchmarkMode: boolean,
  defaultAllowedTools: string[],
): string[] {
  return benchmarkMode ? BENCHMARK_ALLOWED_TOOLS : defaultAllowedTools;
}

export function resolveAvailableBuiltInTools(
  benchmarkMode: boolean,
): string[] | undefined {
  // `allowedTools` only auto-approves calls; it does not make other tools
  // unavailable. SDK `tools: []` removes all built-in tools while preserving
  // explicitly configured MCP servers and their tools.
  return benchmarkMode ? [] : undefined;
}
