import { matchesToolRequirement } from './cases.js';
import type { BusinessCase, ToolRequirement } from './cases.js';
import type { ToolCall } from './contracts.js';
import type { PerTurnEvidence } from './turn-evidence.js';

const isFixtureError = (call: ToolCall) =>
  call.isError === true ||
  (!!call.result && typeof call.result === 'object' && 'error' in call.result);

export interface AttemptCapabilityEvidence {
  category: string;
  selectedSkillIds: string[];
  selectedMcpServers: string[];
  availableFixtureTools: string[];
  fixtureRuntimeStatus: string;
  requiredTools: ToolRequirement[];
  calls: ToolCall[];
  turns: PerTurnEvidence[];
  turnEvidenceComplete: boolean;
  routingOracleDeclared: boolean;
}

export function buildCapabilityCoverageAttempt(
  input: AttemptCapabilityEvidence,
) {
  const available = new Set(input.availableFixtureTools);
  const turnForSequence = new Map<number, number>();
  for (const turn of input.turns)
    for (const call of turn.fixtureCalls)
      turnForSequence.set(call.sequence, turn.turnIndex);
  return {
    category: input.category,
    selectedSkillIds: [...input.selectedSkillIds].sort(),
    selectedMcpServers: [...input.selectedMcpServers].sort(),
    availableFixtureTools: [...available].sort(),
    fixtureRuntimeStatus: input.fixtureRuntimeStatus,
    requiredToolGroups: input.requiredTools.map((requirement) => {
      const alternatives = requirement.anyOf ?? [
        requirement as { name: string },
      ];
      const names = [...new Set(alternatives.map((item) => item.name))];
      const matchingCalls = input.calls.filter((call) =>
        matchesToolRequirement(call, requirement),
      );
      return {
        alternatives: names,
        availableNames: names.filter((name) =>
          available.has(`mcp__commerce_fixture__${name}`),
        ),
        observedCallCount: matchingCalls.length,
        successfulCallCount: matchingCalls.filter(
          (call) => call.success && !isFixtureError(call),
        ).length,
        sequences: matchingCalls.map((call) => call.sequence),
        turnIndexes: matchingCalls.map(
          (call) => turnForSequence.get(call.sequence) ?? null,
        ),
      };
    }),
    callsByTurn: input.calls.map((call) => ({
      sequence: call.sequence,
      tool: call.name,
      turnIndex: turnForSequence.get(call.sequence) ?? null,
      success: call.success,
      isError: isFixtureError(call),
    })),
    turnEvidenceComplete: input.turnEvidenceComplete,
    routingOracleDeclared: input.routingOracleDeclared,
  };
}

export function summarizeCapabilityCoverage(
  attempts: Array<{
    capabilityCoverage?: ReturnType<
      typeof buildCapabilityCoverageAttempt
    > | null;
  }>,
) {
  const rows = attempts
    .map((attempt) => attempt.capabilityCoverage)
    .filter(
      (row): row is ReturnType<typeof buildCapabilityCoverageAttempt> => !!row,
    );
  const categories = [...new Set(rows.map((row) => row.category))].sort();
  const toolNames = [
    ...new Set(
      rows.flatMap((row) => [
        ...row.availableFixtureTools,
        ...row.requiredToolGroups.flatMap((group) =>
          group.alternatives.map((name) => `mcp__commerce_fixture__${name}`),
        ),
        ...row.callsByTurn.map((call) => `mcp__commerce_fixture__${call.tool}`),
      ]),
    ),
  ].sort();
  const toolCoverage = Object.fromEntries(
    toolNames.map((fullName) => {
      const name = fullName.replace(/^mcp__commerce_fixture__/, '');
      const requiredGroups = rows.flatMap((row) =>
        row.requiredToolGroups.filter((group) =>
          group.alternatives.includes(name),
        ),
      );
      const calls = rows.flatMap((row) =>
        row.callsByTurn.filter((call) => call.tool === name),
      );
      return [
        fullName,
        {
          requiredGroups: requiredGroups.length,
          availableRequiredGroups: requiredGroups.filter((group) =>
            group.availableNames.includes(name),
          ).length,
          observedCalls: calls.length,
          successfulCalls: calls.filter((call) => call.success && !call.isError)
            .length,
          failedCalls: calls.filter((call) => !call.success || call.isError)
            .length,
        },
      ];
    }),
  );
  const topologies = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify({
      skills: row.selectedSkillIds,
      mcp: row.selectedMcpServers,
    });
    topologies.set(key, (topologies.get(key) ?? 0) + 1);
  }
  const serverTopologies = new Set(
    rows.map((row) => JSON.stringify(row.selectedMcpServers)),
  );
  const routingOracleCount = rows.filter(
    (row) => row.routingOracleDeclared,
  ).length;
  return {
    schemaVersion: 1 as const,
    attempts: rows.length,
    caseCategories: Object.fromEntries(
      categories.map((category) => [
        category,
        rows.filter((row) => row.category === category).length,
      ]),
    ),
    capabilityTopologies: [...topologies.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([manifest, count]) => ({
        manifest: JSON.parse(manifest),
        attempts: count,
      })),
    fixtureRuntimeStatuses: Object.fromEntries(
      [...new Set(rows.map((row) => row.fixtureRuntimeStatus))]
        .sort()
        .map((status) => [
          status,
          rows.filter((row) => row.fixtureRuntimeStatus === status).length,
        ]),
    ),
    fixtureTools: toolCoverage,
    skillsRouting: routingOracleCount
      ? 'has_case_oracle'
      : 'not_scored_no_case_routing_oracle',
    mcpServerRouting: routingOracleCount
      ? 'has_case_oracle'
      : serverTopologies.size > 1
        ? 'not_scored_no_case_routing_oracle'
        : 'not_scored_single_observed_topology',
    casesWithRoutingOracle: routingOracleCount,
    perTurnToolEvidenceComplete: rows.filter((row) => row.turnEvidenceComplete)
      .length,
    perTurnToolEvidenceIncomplete: rows.filter(
      (row) => !row.turnEvidenceComplete,
    ).length,
  };
}
