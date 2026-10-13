import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertBusinessCase,
  countHoldoutRuns,
  evaluateOracle,
  fixtureStateMatchesLedger,
  loadAllBusinessCases,
  loadBusinessCases,
  parseBenchmarkSplit,
  parseFixtureVariant,
  recordHoldoutRun,
  replayFixtureState,
  matchesToolRequirement,
  validateCaseMatrix,
} from '../benchmarks/lib/cases.js';
import { assessAttempt } from '../benchmarks/lib/assessment.js';
import { auditFixtureCalls } from '../benchmarks/assertions/audit.js';
import {
  assessMcpRuntime,
  readMcpRuntimeEvidence,
} from '../benchmarks/lib/mcp-runtime.js';
import {
  callsFor,
  correctAnswer,
  withCallMutation,
} from '../benchmarks/assertions/__mutations__/mutations.js';
import {
  definitionsForFixture,
  startFixtureServer,
} from '../benchmarks/mcp-fixture-server/server.js';
import { renderCasePrompts } from '../benchmarks/lib/contracts.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-cases-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const allCases = loadAllBusinessCases();
const caseById = (id: string) => {
  const test = allCases.find((row) => row.id === id);
  if (!test) throw new Error(`case_missing:${id}`);
  return test;
};

async function callTool(
  fixture: Awaited<ReturnType<typeof startFixtureServer>>,
  name: string,
  args: Record<string, string | number>,
) {
  const response = await fetch(`http://127.0.0.1:${fixture.port}/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${fixture.token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return (await response.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
}

describe('versioned benchmark business-case matrix', () => {
  test('requires a connected fixture MCP and every case-required tool in SDK init evidence', () => {
    const item = caseById('cp-01');
    const logs = path.join(temp, 'mcp-init-logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, 'runner.log'),
      '[BENCHMARK_MCP_INIT] ' +
        JSON.stringify({
          mcpServers: [{ name: 'commerce_fixture', status: 'connected' }],
          fixtureTools: item.tools.required.map(
            (requirement) =>
              `mcp__commerce_fixture__${requirement.anyOf?.[0]?.name ?? requirement.name}`,
          ),
        }) +
        '\n' +
        '[BENCHMARK_MCP_RUNTIME] ' +
        JSON.stringify({
          mcpServers: [{ name: 'commerce_fixture', status: 'connected' }],
          fixtureTools: item.tools.required.map(
            (requirement) =>
              `mcp__commerce_fixture__${requirement.anyOf?.[0]?.name ?? requirement.name}`,
          ),
        }) +
        '\n',
    );
    const evidence = readMcpRuntimeEvidence(logs);
    expect(assessMcpRuntime(evidence, item).ready).toBe(true);
    expect(
      assessMcpRuntime(
        {
          ...evidence!,
          mcpServers: [{ name: 'commerce_fixture', status: 'failed' }],
        },
        item,
      ).ready,
    ).toBe(false);
    expect(
      assessMcpRuntime({ ...evidence!, fixtureTools: [] }, item)
        .missingRequiredTools,
    ).toHaveLength(item.tools.required.length);
  });

  test('validates all cases, split counts, category counts and required tag coverage', () => {
    const dev = allCases.filter((row) => row.split === 'dev');
    const holdout = allCases.filter((row) => row.split === 'holdout');
    expect(validateCaseMatrix(dev, holdout)).toEqual({
      total: 68,
      dev: 50,
      holdout: 18,
    });
    expect(
      allCases.filter((row) => row.tags.includes('write-operation')),
    ).toHaveLength(8);
    expect(
      allCases.filter((row) => row.tags.includes('multi-turn')),
    ).toHaveLength(3);
    for (const row of allCases) {
      expect(row.prompt).not.toMatch(
        /get_order|search_policy|list_products|get_ad_report|order_id|campaign_id|start_date|end_date|\b(status|facts|evidence|answer|MCP)\b/i,
      );
      expect(row.fixture_variant).toMatch(/^.+\/v1\/.+$/);
    }
  });

  test('oracle derives refund, product comparison and ad ratios from versioned fixtures', () => {
    const refund = caseById('cp-01');
    const refundFixture = parseFixtureVariant(refund.fixture_variant);
    expect(
      evaluateOracle(refund.expected.facts.net_refund.oracle, refundFixture),
    ).toBe(108);

    const product = caseById('pc-01');
    const productFixture = parseFixtureVariant(product.fixture_variant);
    expect(
      evaluateOracle(product.expected.facts.sku.oracle, productFixture),
    ).toBe('CH-220');
    expect(
      evaluateOracle(product.expected.facts.price.oracle, productFixture),
    ).toBe(25);

    const comparison = caseById('ad-02');
    const adFixture = parseFixtureVariant(comparison.fixture_variant);
    expect(
      evaluateOracle(comparison.expected.facts.campaign.oracle, adFixture),
    ).toBe('CAMP-100');
    expect(
      evaluateOracle(comparison.expected.facts.roas.oracle, adFixture),
    ).toBe(3);
  });

  test('business assertions reject amount, unit/currency, evidence, tool-argument and forbidden-conclusion mutations', () => {
    const item = caseById('cp-01');
    const fixture = parseFixtureVariant(item.fixture_variant);
    const calls = callsFor(item);
    const output = correctAnswer(item, fixture);
    const run = (answer: unknown, attemptedCalls = calls) =>
      assertBusinessCase(
        JSON.stringify(answer),
        item,
        fixture,
        attemptedCalls,
        attemptedCalls.map((call) => ({
          name: `mcp__commerce_fixture__${call.name}`,
        })),
      );

    expect(run(output).pass).toBe(true);
    const withinTolerance = structuredClone(output);
    withinTolerance.facts.net_refund.value += 0.005;
    expect(run(withinTolerance).checks.facts).toBe(true);
    const wrongAmount = structuredClone(output);
    wrongAmount.facts.net_refund.value += 1;
    expect(run(wrongAmount).checks.facts).toBe(false);

    const wrongCurrency = structuredClone(output);
    wrongCurrency.facts.net_refund.unit = 'EUR';
    expect(run(wrongCurrency).checks.facts).toBe(false);

    const wrongEvidence = structuredClone(output);
    wrongEvidence.evidence = ['EVIDENCE-NOT-IN-FIXTURE'];
    expect(run(wrongEvidence).checks.evidence).toBe(false);

    expect(run(output, withCallMutation(calls)).checks.requiredTools).toBe(
      false,
    );
    const unintendedWrite = {
      sequence: calls.length + 1,
      name: 'create_refund_request',
      arguments: { order_id: 'ORD-100', amount: '108', currency: 'USD' },
      result: {},
      success: true,
    };
    expect(run(output, [...calls, unintendedWrite]).checks.forbiddenTools).toBe(
      false,
    );

    const attribution = caseById('ad-03');
    const attributionFixture = parseFixtureVariant(attribution.fixture_variant);
    const validAttribution = correctAnswer(attribution, attributionFixture);
    const badConclusion = {
      ...validAttribution,
      facts: { ...validAttribution.facts, causal_claim_supported: true },
      answer: `${validAttribution.answer}这证明广告带来全部增量销售。`,
    };
    const attributionCalls = callsFor(attribution);
    const result = assertBusinessCase(
      JSON.stringify(badConclusion),
      attribution,
      attributionFixture,
      attributionCalls,
      attributionCalls.map((call) => ({
        name: `mcp__commerce_fixture__${call.name}`,
      })),
    );
    expect(result.checks.forbiddenConclusions).toBe(false);
    expect(result.pass).toBe(false);

    const refused = caseById('cp-13');
    const refusalFixture = parseFixtureVariant(refused.fixture_variant);
    const forbiddenCall: import('../benchmarks/lib/contracts.js').ToolCall = {
      sequence: 1,
      name: 'get_order',
      arguments: { order_id: 'ORD-100' },
      result: {},
      success: true,
    };
    const refusal = assertBusinessCase(
      JSON.stringify(correctAnswer(refused, refusalFixture)),
      refused,
      refusalFixture,
      [forbiddenCall],
      [{ name: 'mcp__commerce_fixture__get_order' }],
    );
    expect(refusal.checks.forbiddenTools).toBe(false);
    expect(refusal.pass).toBe(false);
  });

  test('checks simulated refund state, amount, handoff and absence of unintended writes', () => {
    const item = caseById('cp-action-01');
    const fixture = parseFixtureVariant(item.fixture_variant);
    const stateExpectation = item.expected.state!;
    const expectedRefund = stateExpectation.refund_requests[0];
    const amount = Number(
      evaluateOracle(expectedRefund.amount.oracle, fixture),
    );
    const currency = String(evaluateOracle(expectedRefund.currency, fixture));
    const state = {
      refund_requests: [
        {
          request_id: 'REFUND-001',
          order_id: expectedRefund.order_id,
          amount,
          currency,
          status: 'pending',
        },
      ],
      handoffs: [],
    };
    const calls = callsFor(item).map((call) =>
      call.name === 'create_refund_request'
        ? {
            ...call,
            arguments: { ...call.arguments, amount, currency },
            result: {
              refund_request: {
                request_id: 'REFUND-001',
                order_id: expectedRefund.order_id,
                amount,
                currency,
                status: 'pending',
              },
            },
          }
        : call,
    );
    const valid = assertBusinessCase(
      JSON.stringify(correctAnswer(item, fixture)),
      item,
      fixture,
      calls,
      calls.map((call) => ({ name: `mcp__commerce_fixture__${call.name}` })),
      state,
    );
    expect(valid.checks.state).toBe(true);
    expect(valid.pass).toBe(true);
    expect(
      assertBusinessCase(
        JSON.stringify(correctAnswer(item, fixture)),
        item,
        fixture,
        [],
        [],
        state,
      ).checks.state,
    ).toBe(false);

    const wrongAmount = structuredClone(state);
    wrongAmount.refund_requests[0].amount += 1;
    expect(
      assertBusinessCase(
        JSON.stringify(correctAnswer(item, fixture)),
        item,
        fixture,
        calls,
        calls.map((call) => ({ name: `mcp__commerce_fixture__${call.name}` })),
        wrongAmount,
      ).checks.state,
    ).toBe(false);

    const refusedWrite = caseById('cp-action-08');
    const readFixture = parseFixtureVariant(refusedWrite.fixture_variant);
    const unexpectedState = {
      refund_requests: [state.refund_requests[0]],
      handoffs: [],
    };
    const readCalls = callsFor(refusedWrite);
    expect(
      assertBusinessCase(
        JSON.stringify(correctAnswer(refusedWrite, readFixture)),
        refusedWrite,
        readFixture,
        readCalls,
        readCalls.map((call) => ({
          name: `mcp__commerce_fixture__${call.name}`,
        })),
        unexpectedState,
      ).checks.state,
    ).toBe(false);
  });

  test('renders multi-turn cases as fixed sequential user messages', () => {
    const item = caseById('cp-action-05');
    const prompts = renderCasePrompts(item);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(item.prompt);
    expect(prompts[1]).toContain(item.turns![0]);
  });

  test('supports alternate call paths, wildcard parameters and equivalent date representations', () => {
    const item = caseById('ad-02');
    const fixture = parseFixtureVariant(item.fixture_variant);
    const calls = callsFor(item);
    calls[0].arguments.start_date = '2026-09-01T00:00:00.000Z';
    calls[0].arguments.end_date = '2026-09-07T00:00:00.000Z';
    const result = assertBusinessCase(
      JSON.stringify(correctAnswer(item, fixture)),
      item,
      fixture,
      calls,
      calls.map((call) => ({ name: `mcp__commerce_fixture__${call.name}` })),
    );
    expect(result.checks.requiredTools).toBe(true);
    expect(result.pass).toBe(true);
    expect(
      matchesToolRequirement(calls[0], {
        anyOf: [
          { name: 'search_policy', arguments: { market: 'US' } },
          {
            name: 'get_ad_report',
            arguments: {
              campaign_id: { $any: true },
              $dateRangeEquivalent: {
                start: '2026-09-01',
                end: '2026-09-07',
              },
            },
          },
        ],
      }),
    ).toBe(true);
  });

  test('defaults to dev and counts only explicitly requested holdout runs', () => {
    expect(parseBenchmarkSplit([])).toBe('dev');
    expect(loadBusinessCases('dev').every((row) => row.split === 'dev')).toBe(
      true,
    );
    expect(parseBenchmarkSplit(['--split', 'dev'])).toBe('dev');
    expect(() => parseBenchmarkSplit(['--split', 'holdout'])).toThrow(
      'holdout_requires_final_run',
    );
    expect(parseBenchmarkSplit(['--split', 'holdout', '--final-run'])).toBe(
      'holdout',
    );
    expect(() => parseBenchmarkSplit(['--final-run'])).toThrow(
      'holdout_requires_final_run',
    );
    expect(() => parseBenchmarkSplit(['--split', 'all'])).toThrow(
      'invalid_benchmark_split',
    );
    const ledger = path.join(temp, 'holdout-runs.jsonl');
    expect(countHoldoutRuns(ledger)).toBe(0);
    expect(recordHoldoutRun(ledger, 'run-a')).toBe(1);
    expect(recordHoldoutRun(ledger, 'run-b')).toBe(2);
    expect(countHoldoutRuns(ledger)).toBe(2);
    const finalLedger = path.join(temp, 'final-holdout.jsonl');
    expect(recordHoldoutRun(finalLedger, 'official-final-run', true)).toBe(1);
    expect(() =>
      recordHoldoutRun(finalLedger, 'second-holdout-run', true),
    ).toThrow('holdout_already_used');
  });
});

describe('fixture edge conditions stay measurable', () => {
  test('exposes market, policy topic, and product category enums in MCP tools/list', async () => {
    const policyData = parseFixtureVariant('customer-policy/v1/default').data;
    const productData = parseFixtureVariant('product-compare/v1/default').data;
    const policyServer = await startFixtureServer({
      data: policyData,
      scenario: 'normal',
      ledgerFile: path.join(temp, 'schema-policy-ledger.jsonl'),
    });
    const productServer = await startFixtureServer({
      data: productData,
      scenario: 'normal',
      ledgerFile: path.join(temp, 'schema-product-ledger.jsonl'),
    });
    const listTools = async (server: typeof policyServer) => {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      const body = (await response.json()) as {
        result: { tools: Array<any> };
      };
      return body.result.tools;
    };
    try {
      const policyTools = await listTools(policyServer);
      const productTools = await listTools(productServer);
      const policy = policyTools.find((tool) => tool.name === 'search_policy')!;
      const products = productTools.find(
        (tool) => tool.name === 'list_products',
      )!;
      expect(policy.inputSchema.properties.market).toMatchObject({
        enum: expect.arrayContaining(['US', 'CA', 'CN']),
        description: expect.stringContaining('美国'),
      });
      expect(policy.inputSchema.properties.topic).toMatchObject({
        enum: ['exchange', 'return'],
        description: expect.stringContaining('退货'),
      });
      expect(products.inputSchema.properties.category).toMatchObject({
        enum: ['battery', 'cable', 'charger'],
        description: expect.stringContaining('线材'),
      });
    } finally {
      await Promise.all([policyServer.close(), productServer.close()]);
    }
  });

  test('write tools are exposed only to explicitly tagged write-operation cases', () => {
    expect(definitionsForFixture(false).map((tool) => tool.name)).not.toContain(
      'create_refund_request',
    );
    expect(definitionsForFixture(true).map((tool) => tool.name)).toContain(
      'create_refund_request',
    );
  });

  test('serves deterministic pages and missing fields from the selected fixture variant', async () => {
    const variant = parseFixtureVariant('product-compare/v1/pagination');
    const directory = path.join(temp, 'pagination');
    fs.mkdirSync(directory, { recursive: true });
    const server = await startFixtureServer({
      data: variant.data,
      scenario: 'normal',
      variantConfig: variant.config,
      ledgerFile: path.join(directory, 'fixture.jsonl'),
    });
    try {
      const first = await callTool(server, 'list_products', {
        category: 'charger',
      });
      const firstPage = JSON.parse(first.result.content[0].text);
      expect(firstPage.products).toHaveLength(2);
      expect(firstPage.has_more).toBe(true);
      const second = await callTool(server, 'list_products', {
        category: 'charger',
        page_token: firstPage.next_page_token,
      });
      expect(JSON.parse(second.result.content[0].text).products).toHaveLength(
        2,
      );

      const missing = parseFixtureVariant('customer-policy/v1/missing-fee');
      const missingServer = await startFixtureServer({
        data: missing.data,
        scenario: 'normal',
        variantConfig: missing.config,
        ledgerFile: path.join(directory, 'missing.jsonl'),
      });
      try {
        const response = await callTool(missingServer, 'get_order', {
          order_id: 'ORD-100',
        });
        const order = JSON.parse(response.result.content[0].text).orders[0];
        expect(order).not.toHaveProperty('return_fee');
      } finally {
        await missingServer.close();
      }
    } finally {
      await server.close();
    }
  });

  test('simulated write tools record isolated final state and prevent duplicate refund applications', async () => {
    const variant = parseFixtureVariant('customer-policy/v1/default');
    const directory = path.join(temp, 'write-actions');
    fs.mkdirSync(directory, { recursive: true });
    const server = await startFixtureServer({
      data: variant.data,
      scenario: 'normal',
      variantConfig: variant.config,
      includeWorkflowWrites: true,
      ledgerFile: path.join(directory, 'fixture.jsonl'),
    });
    try {
      const first = await callTool(server, 'create_refund_request', {
        order_id: 'ORD-100',
        amount: 108,
        currency: 'USD',
      });
      expect(first.result.isError).not.toBe(true);
      const duplicate = await callTool(server, 'create_refund_request', {
        order_id: 'ORD-100',
        amount: 108,
        currency: 'USD',
      });
      expect(duplicate.result.isError).toBe(true);
      const handoff = await callTool(server, 'escalate_to_human', {
        order_id: 'ORD-103',
        reason: 'Policy eligibility requires human review.',
      });
      expect(handoff.result.isError).not.toBe(true);
      expect(server.state.refund_requests).toHaveLength(1);
      expect(server.state.refund_requests[0]).toMatchObject({
        order_id: 'ORD-100',
        amount: 108,
        currency: 'USD',
        status: 'pending',
      });
      expect(server.state.handoffs).toHaveLength(1);
      expect(fixtureStateMatchesLedger(server.ledger, server.state)).toBe(true);
      expect(replayFixtureState(server.ledger)).toEqual(server.state);
    } finally {
      await server.close();
    }
  });

  test('simulated tool timeout is returned to the model but remains measurement-valid', async () => {
    const variant = parseFixtureVariant('ad-review/v1/timeout-reports');
    const directory = path.join(temp, 'timeout');
    fs.mkdirSync(directory, { recursive: true });
    const server = await startFixtureServer({
      data: variant.data,
      scenario: 'normal',
      variantConfig: variant.config,
      ledgerFile: path.join(directory, 'fixture.jsonl'),
    });
    try {
      const response = await callTool(server, 'get_ad_report', {
        campaign_id: 'CAMP-100',
        start_date: '2026-09-01',
        end_date: '2026-09-07',
      });
      expect(response.result.isError).toBe(true);
      expect(JSON.parse(response.result.content[0].text)).toEqual({
        error: 'tool_timeout',
      });
      expect(server.ledger[0].success).toBe(true);
      const audit = auditFixtureCalls(server.ledger, [
        { name: 'mcp__commerce_fixture__get_ad_report' },
      ]);
      expect(audit.matched).toBe(true);
      const assessment = assessAttempt({
        transportFailure: null,
        usageComplete: true,
        scopeIsolated: true,
        sdkModelMatches: true,
        contextVerified: true,
        freshState: true,
        auditMatched: audit.matched,
        mcpRuntimeReady: true,
        onlyAllowedTools: true,
        businessPass: true,
        gateway: false,
      });
      expect(assessment.measurementValid).toBe(true);
      expect(assessment.measurementFailure).toBeNull();
    } finally {
      await server.close();
    }
  });
});
