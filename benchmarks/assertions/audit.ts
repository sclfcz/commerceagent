import { isDeepStrictEqual } from 'node:util';
import type { ToolCall } from '../lib/contracts.js';

// Instrumentation integrity only. An empty ledger and empty MCP sequence match;
// task completion and tool policy are evaluated independently by assertSpike.
export function auditFixtureCalls(
  ledger: ToolCall[],
  streamTools: Array<{ name: string }>,
) {
  const prefix = 'mcp__commerce_fixture__';
  const streamNames = streamTools
    .filter((tool) => tool.name.startsWith(prefix))
    .map((tool) => tool.name.slice(prefix.length));
  return {
    matched: isDeepStrictEqual(
      ledger.map((call) => call.name).sort(),
      streamNames.sort(),
    ),
    ledgerCount: ledger.length,
    fixtureStreamCount: streamNames.length,
  };
}
