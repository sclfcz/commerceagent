import { expect, test } from 'vitest';
import {
  buildCapabilityCoverageAttempt,
  summarizeCapabilityCoverage,
} from '../benchmarks/lib/capability-coverage.js';
import type { ToolCall } from '../benchmarks/lib/contracts.js';

const call = (
  sequence: number,
  name: string,
  args: Record<string, unknown>,
  ok = true,
): ToolCall => ({
  sequence,
  name,
  arguments: args,
  result: ok ? { rows: [] } : { error: 'synthetic' },
  success: ok,
  isError: !ok,
});

test('distinguishes a declared fixture tool from one actually invoked with matching arguments', () => {
  const capability = buildCapabilityCoverageAttempt({
    category: 'customer-policy',
    selectedSkillIds: [],
    selectedMcpServers: ['user:commerce_fixture'],
    availableFixtureTools: [
      'mcp__commerce_fixture__get_order',
      'mcp__commerce_fixture__search_policy',
    ],
    fixtureRuntimeStatus: 'connected',
    requiredTools: [
      { name: 'get_order', arguments: { order_id: 'ORD-100' } },
      {
        anyOf: [
          { name: 'search_policy', arguments: { market: 'US' } },
          { name: 'search_policy', arguments: { market: 'DE' } },
        ],
      },
    ],
    calls: [
      call(1, 'get_order', { order_id: 'ORD-101' }),
      call(2, 'search_policy', { market: 'US' }, false),
    ],
    turns: [
      {
        turnIndex: 1,
        runId: 'run-1',
        turnId: 'turn-1',
        messageTurnId: 'message-1',
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 2,
        fixtureCalls: [
          { sequence: 1, name: 'get_order', success: true, isError: false },
          { sequence: 2, name: 'search_policy', success: false, isError: true },
        ],
        streamFixtureTools: [],
        nonFixtureToolNames: [],
        complete: true,
        reasons: [],
      },
    ],
    turnEvidenceComplete: true,
    routingOracleDeclared: false,
  });
  expect(capability.requiredToolGroups).toEqual([
    {
      alternatives: ['get_order'],
      availableNames: ['get_order'],
      observedCallCount: 0,
      successfulCallCount: 0,
      sequences: [],
      turnIndexes: [],
    },
    {
      alternatives: ['search_policy'],
      availableNames: ['search_policy'],
      observedCallCount: 1,
      successfulCallCount: 0,
      sequences: [2],
      turnIndexes: [1],
    },
  ]);
  expect(JSON.stringify(capability)).not.toContain('ORD-101');
  expect(JSON.stringify(capability)).not.toContain('market');
});

test('reports enabled topology, domain coverage, unavailable tools, failures and unscored routing', () => {
  const base = buildCapabilityCoverageAttempt({
    category: 'product-compare',
    selectedSkillIds: [],
    selectedMcpServers: ['user:commerce_fixture'],
    availableFixtureTools: ['mcp__commerce_fixture__list_products'],
    fixtureRuntimeStatus: 'connected',
    requiredTools: [
      { name: 'list_products', arguments: { category: 'cable' } },
      { name: 'get_order', arguments: { order_id: 'ORD-100' } },
    ],
    calls: [call(1, 'list_products', { category: 'cable' })],
    turns: [
      {
        turnIndex: 1,
        runId: 'run-1',
        turnId: 't1',
        messageTurnId: 'm1',
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 1,
        fixtureCalls: [
          { sequence: 1, name: 'list_products', success: true, isError: false },
        ],
        streamFixtureTools: [],
        nonFixtureToolNames: [],
        complete: true,
        reasons: [],
      },
    ],
    turnEvidenceComplete: true,
    routingOracleDeclared: false,
  });
  const report = summarizeCapabilityCoverage([
    { capabilityCoverage: base },
    {
      capabilityCoverage: {
        ...base,
        category: 'customer-policy',
        turnEvidenceComplete: false,
      },
    },
  ]);
  expect(report).toMatchObject({
    attempts: 2,
    caseCategories: { 'customer-policy': 1, 'product-compare': 1 },
    skillsRouting: 'not_scored_no_case_routing_oracle',
    mcpServerRouting: 'not_scored_single_observed_topology',
    casesWithRoutingOracle: 0,
    perTurnToolEvidenceComplete: 1,
    perTurnToolEvidenceIncomplete: 1,
    fixtureTools: {
      mcp__commerce_fixture__get_order: {
        requiredGroups: 2,
        availableRequiredGroups: 0,
        observedCalls: 0,
        successfulCalls: 0,
        failedCalls: 0,
      },
      mcp__commerce_fixture__list_products: {
        requiredGroups: 2,
        availableRequiredGroups: 2,
        observedCalls: 2,
        successfulCalls: 2,
        failedCalls: 0,
      },
    },
  });
});

test('does not claim skill or MCP routing coverage from a configured-but-unused capability', () => {
  const attempt = buildCapabilityCoverageAttempt({
    category: 'ad-review',
    selectedSkillIds: ['catalog-search'],
    selectedMcpServers: ['user:commerce_fixture', 'user:commerce_other'],
    availableFixtureTools: [],
    fixtureRuntimeStatus: 'missing',
    requiredTools: [],
    calls: [],
    turns: [],
    turnEvidenceComplete: false,
    routingOracleDeclared: false,
  });
  const summary = summarizeCapabilityCoverage([
    { capabilityCoverage: attempt },
  ]);
  expect(summary).toMatchObject({
    capabilityTopologies: [
      {
        manifest: {
          skills: ['catalog-search'],
          mcp: ['user:commerce_fixture', 'user:commerce_other'],
        },
        attempts: 1,
      },
    ],
    fixtureRuntimeStatuses: { missing: 1 },
    skillsRouting: 'not_scored_no_case_routing_oracle',
    mcpServerRouting: 'not_scored_single_observed_topology',
  });
});
