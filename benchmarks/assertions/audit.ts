import type { ToolCall } from '../lib/contracts.js';

// Instrumentation integrity only. An empty ledger and empty MCP sequence match;
// task completion and tool policy are evaluated independently by assertSpike.
export function auditFixtureCalls(
  ledger: ToolCall[],
  streamTools: Array<{
    name: string;
    resultObserved?: boolean;
    failed?: boolean | null;
    unavailable?: boolean;
  }>,
) {
  const prefix = 'mcp__commerce_fixture__';
  const streamFixtureTools = streamTools
    .filter((tool) => tool.name.startsWith(prefix))
    .map((tool) => ({ ...tool, name: tool.name.slice(prefix.length) }));
  const successfulFixtureCalls = streamFixtureTools.filter(
    (tool) => tool.resultObserved && tool.failed === false && !tool.unavailable,
  ).length;
  const remaining = new Map<string, number>();
  for (const call of ledger)
    remaining.set(call.name, (remaining.get(call.name) ?? 0) + 1);

  const unmatchedStream: string[] = [];
  const failedBeforeFixture: string[] = [];
  const toolUnavailableCalls: string[] = [];
  for (const tool of streamFixtureTools) {
    const count = remaining.get(tool.name) ?? 0;
    if (count > 0) {
      remaining.set(tool.name, count - 1);
    } else if (
      tool.resultObserved &&
      (tool.failed === true || tool.unavailable === true)
    ) {
      // The stream contains the failed tool result, so this is observed
      // execution failure rather than missing telemetry from the fixture.
      failedBeforeFixture.push(tool.name);
      if (tool.unavailable) toolUnavailableCalls.push(tool.name);
    } else {
      unmatchedStream.push(tool.name);
    }
  }
  const unmatchedLedger = [...remaining.entries()].flatMap(([name, count]) =>
    Array.from({ length: count }, () => name),
  );
  const nonFixtureToolObserved = streamTools.some(
    (tool) => !tool.name.startsWith(prefix),
  );
  // A ledger entry with a visible non-fixture tool event is a policy bypass
  // (for example Bash/curl), not evidence that stream collection was lost.
  const bypassedFixtureCalls =
    nonFixtureToolObserved && unmatchedLedger.length > 0 ? unmatchedLedger : [];
  const unexplainedLedger = bypassedFixtureCalls.length ? [] : unmatchedLedger;
  return {
    matched: unmatchedStream.length === 0 && unexplainedLedger.length === 0,
    ledgerCount: ledger.length,
    fixtureStreamCount: streamFixtureTools.length,
    successfulFixtureCalls,
    matchedFixtureCalls:
      ledger.length - bypassedFixtureCalls.length - unexplainedLedger.length,
    failedBeforeFixture,
    toolUnavailableCalls,
    bypassedFixtureCalls,
    unexplainedStream: unmatchedStream,
    unexplainedLedger,
  };
}
