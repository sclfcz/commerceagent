import fs from 'node:fs';
import path from 'node:path';
import type { BusinessCase } from './cases.js';

const RUNTIME_MARKERS = ['[BENCHMARK_MCP_INIT] ', '[BENCHMARK_MCP_RUNTIME] '];
const FIXTURE_TOOL_PREFIX = 'mcp__commerce_fixture__';

export interface McpRuntimeEvidence {
  mcpServers: Array<{ name: string; status: string }>;
  fixtureTools: string[];
}

export function readMcpRuntimeEvidence(
  logDirectory: string,
): McpRuntimeEvidence | null {
  if (!fs.existsSync(logDirectory)) return null;
  const files = fs
    .readdirSync(logDirectory)
    .filter((name) => name.endsWith('.log'))
    .sort();
  let latest: McpRuntimeEvidence | null = null;
  for (const name of files) {
    const content = fs.readFileSync(path.join(logDirectory, name), 'utf8');
    for (const line of content.split('\n')) {
      const marker = RUNTIME_MARKERS.map((value) => ({
        index: line.indexOf(value),
        length: value.length,
      })).find((item) => item.index >= 0);
      if (!marker) continue;
      try {
        const parsed = JSON.parse(line.slice(marker.index + marker.length));
        if (
          !Array.isArray(parsed.mcpServers) ||
          !Array.isArray(parsed.fixtureTools)
        )
          continue;
        latest = {
          mcpServers: parsed.mcpServers
            .filter(
              (server: unknown) =>
                !!server &&
                typeof server === 'object' &&
                typeof (server as { name?: unknown }).name === 'string' &&
                typeof (server as { status?: unknown }).status === 'string',
            )
            .map((server: { name: string; status: string }) => ({
              name: server.name,
              status: server.status,
            })),
          fixtureTools: parsed.fixtureTools.filter(
            (tool: unknown): tool is string => typeof tool === 'string',
          ),
        };
      } catch {
        // Ignore incomplete log lines; missing init evidence fails closed.
      }
    }
  }
  return latest;
}

export function assessMcpRuntime(
  evidence: McpRuntimeEvidence | null,
  test: BusinessCase,
) {
  const fixture = evidence?.mcpServers.find(
    (server) => server.name === 'commerce_fixture',
  );
  const available = new Set(evidence?.fixtureTools ?? []);
  const missingRequiredTools = test.tools.required.flatMap((requirement) => {
    const alternatives = requirement.anyOf ?? [requirement as { name: string }];
    return alternatives.some((alternative) =>
      available.has(`${FIXTURE_TOOL_PREFIX}${alternative.name}`),
    )
      ? []
      : [alternatives.map((alternative) => alternative.name)];
  });
  return {
    serverStatus: fixture?.status ?? 'missing',
    availableTools: [...available].sort(),
    missingRequiredTools,
    ready: fixture?.status === 'connected' && missingRequiredTools.length === 0,
  };
}

export function countSuccessfulFixtureCalls(
  attempts: Array<{ fixtureAudit?: { successfulFixtureCalls?: number } }>,
): number {
  return attempts.reduce(
    (total, attempt) =>
      total + (attempt.fixtureAudit?.successfulFixtureCalls ?? 0),
    0,
  );
}
