import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import {
  assertBusinessCase,
  loadBusinessCases,
  parseFixtureVariant,
  evaluateOracle,
  resolveEvidence,
  type BusinessCase,
  type FixtureState,
} from './cases.js';
import { executeReference, loadReferenceAnswers } from './reference-answers.js';
import { hash, type ToolCall } from './contracts.js';
import { definitionsForFixture } from '../mcp-fixture-server/server.js';

export type FailureCategory =
  | 'model_error'
  | 'case_or_assertion_error'
  | 'fixture_error';
const shaFile = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function classifyFailure(input: {
  caseMatches: boolean;
  referencePass: boolean;
  fixtureReplayMatches: boolean;
  measurementValid: boolean;
  checksMatch: boolean;
  fixtureDiscoverabilityFailure?: boolean;
}): FailureCategory {
  if (!input.caseMatches || !input.referencePass || !input.checksMatch)
    return 'case_or_assertion_error';
  if (
    !input.fixtureReplayMatches ||
    !input.measurementValid ||
    input.fixtureDiscoverabilityFailure
  )
    return 'fixture_error';
  return 'model_error';
}

export async function replayFixtureLedger(
  test: BusinessCase,
  ledger: ToolCall[],
  expectedState: FixtureState,
) {
  const fixture = parseFixtureVariant(test.fixture_variant);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'commerce-fixture-review-'),
  );
  const server = await startFixtureServer({
    data: fixture.data as Record<string, any> & { version: string | number },
    scenario: 'normal',
    variantConfig: fixture.config,
    includeWorkflowWrites: test.tags.includes('write-operation'),
    ledgerFile: path.join(directory, 'fixture.jsonl'),
  });
  try {
    for (const [index, call] of ledger.entries()) {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${server.token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name: call.name, arguments: call.arguments },
        }),
      });
      if (!response.ok)
        return {
          matches: false,
          mismatchIndexes: [index + 1],
          stateMatches: false,
        };
      await response.json();
    }
    const mismatchIndexes = ledger.flatMap((call, index) => {
      const replay = server.ledger[index];
      return replay &&
        replay.name === call.name &&
        isDeepStrictEqual(replay.arguments, call.arguments) &&
        isDeepStrictEqual(replay.result, call.result) &&
        replay.success === call.success &&
        (call.isError === undefined || replay.isError === call.isError)
        ? []
        : [index + 1];
    });
    const stateMatches = isDeepStrictEqual(server.state, expectedState);
    return {
      matches: !mismatchIndexes.length && stateMatches,
      mismatchIndexes,
      stateMatches,
    };
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function businessFailureDetails(
  test: BusinessCase,
  output: string,
  ledger: ToolCall[],
  state: FixtureState,
) {
  let response: Record<string, any> | null = null;
  try {
    response = JSON.parse(output);
  } catch {
    /* record only parse status, never raw reply */
  }
  const fixture = parseFixtureVariant(test.fixture_variant);
  const actualFacts =
    response?.facts && typeof response.facts === 'object' ? response.facts : {};
  const factDifferences = Object.entries(test.expected.facts).flatMap(
    ([field, expectation]) => {
      const expected = evaluateOracle(expectation.oracle, fixture);
      const actual = actualFacts[field];
      const value =
        actual && typeof actual === 'object' ? actual.value : actual;
      const unit =
        expectation.unit ??
        (expectation.unit_from
          ? fixture.data[expectation.unit_from.collection]?.find(
              (row: Record<string, any>) =>
                row[expectation.unit_from!.key] ===
                expectation.unit_from!.value,
            )?.[expectation.unit_from.field]
          : undefined);
      const valueMatches =
        typeof expected === 'number'
          ? typeof value === 'number' &&
            Math.abs(value - expected) <= (expectation.tolerance ?? 0)
          : isDeepStrictEqual(expected, value);
      if (
        Object.hasOwn(actualFacts, field) &&
        valueMatches &&
        (unit === undefined
          ? !actual || typeof actual !== 'object' || !('unit' in actual)
          : actual?.unit === unit)
      )
        return [];
      return [
        {
          field,
          missing: !Object.hasOwn(actualFacts, field),
          expected,
          actual: actual ?? null,
          expectedUnit: unit ?? null,
        },
      ];
    },
  );
  const evidence = Array.isArray(response?.evidence) ? response.evidence : [];
  const expectedEvidence = test.expected.evidence_required.map((item) =>
    resolveEvidence(item, fixture),
  );
  return {
    jsonParsed: response !== null,
    status: {
      expected: test.expected.status,
      actual: response?.status ?? null,
    },
    factDifferences,
    missingEvidence: expectedEvidence.filter((id) => !evidence.includes(id)),
    actualEvidence: evidence,
    toolCalls: ledger.map((call) => ({
      name: call.name,
      arguments: call.arguments,
      acceptedArguments: call.success,
      isError:
        call.isError ??
        (!!call.result &&
          typeof call.result === 'object' &&
          'error' in call.result),
      resultSummary: summarizeToolResult(call.result),
    })),
    callLimit: { actual: ledger.length, maximum: test.tools.max_calls },
    answerLength: {
      actual:
        typeof response?.answer === 'string'
          ? Array.from(response.answer).length
          : 0,
      maximum: test.instructions.max_answer_chars ?? null,
    },
    finalState: state,
    expectedState: test.expected.state ?? { refund_requests: [], handoffs: [] },
  };
}

function summarizeToolResult(result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return { type: result === null ? 'null' : typeof result };
  const value = result as Record<string, unknown>;
  if (typeof value.error === 'string')
    return { error: value.error, fields: Object.keys(value).sort() };
  const collections = Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => Array.isArray(child))
      .map(([key, rows]) => {
        const list = rows as Array<unknown>;
        const evidenceIds = new Set<string>();
        const collect = (item: unknown) => {
          if (Array.isArray(item)) item.forEach(collect);
          else if (item && typeof item === 'object')
            for (const [field, child] of Object.entries(item))
              if (field === 'evidence_id' && typeof child === 'string')
                evidenceIds.add(child);
              else collect(child);
        };
        collect(list);
        return [key, { rowCount: list.length, evidenceIds: [...evidenceIds] }];
      }),
  );
  return { fields: Object.keys(value).sort(), collections };
}

export async function reviewFailures(runDirectory: string) {
  const summaryFile = path.join(runDirectory, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  if (summary.split !== 'dev') throw new Error('failure_review_dev_only');
  const used = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'cases.used.json'), 'utf8'),
  ) as BusinessCase[];
  const current = loadBusinessCases('dev');
  const references = loadReferenceAnswers('dev');
  const selftestFile = path.join(runDirectory, 'case-selftest.json');
  const selftest = JSON.parse(fs.readFileSync(selftestFile, 'utf8'));
  const reviews: Array<Record<string, any>> = [];
  for (const row of summary.results as Array<Record<string, any>>) {
    if (row.businessPass === true && row.measurementValid === true) continue;
    const test = current.find((item) => item.id === row.caseId);
    const saved = used.find((item) => item.id === row.caseId);
    if (!test || !saved) throw new Error('failure_case_missing');
    const directory = path.join(
      runDirectory,
      `promptfoo-${String(row.executionIndex).padStart(4, '0')}`,
    );
    const traceFile = path.join(directory, 'trace.json');
    const ledgerFile = path.join(directory, 'fixture.jsonl');
    const stateFile = path.join(directory, 'fixture-state.json');
    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    const ledger = fs
      .readFileSync(ledgerFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)) as ToolCall[];
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const fixture = parseFixtureVariant(test.fixture_variant);
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(directory, 'fixture-snapshot.json'), 'utf8'),
    );
    const caseMatches =
      hash(test) === hash(saved) &&
      hash(snapshot) === hash(fixture) &&
      selftest.caseHashes?.[test.id] === hash(test);
    const reference = references.find((item) => item.caseId === test.id);
    const referencePass =
      !!reference && (await executeReference(test, reference)).business.pass;
    const replay = await replayFixtureLedger(test, ledger, state);
    const business = assertBusinessCase(
      trace.output,
      test,
      fixture,
      ledger,
      trace.tools,
      state,
    );
    const visibleSchemaHash = hash(
      definitionsForFixture(
        test.tags.includes('write-operation'),
        fixture.data,
      ),
    );
    const savedResult = JSON.parse(
      fs.readFileSync(path.join(directory, 'result.json'), 'utf8'),
    );
    const emptyQueryCall = ledger.some((call) => {
      if (
        !['search_policy', 'list_products'].includes(call.name) ||
        !call.success
      )
        return false;
      const collection =
        call.name === 'search_policy' ? 'policies' : 'products';
      const rows = (call.result as Record<string, unknown>)?.[collection];
      return Array.isArray(rows) && rows.length === 0;
    });
    // Before enum values were published, the schema offered no way to learn
    // the accepted locale-independent query codes. An empty result from that
    // schema is a fixture contract failure when the expected query is known.
    const fixtureDiscoverabilityFailure =
      emptyQueryCall && savedResult.toolSchemaHash !== visibleSchemaHash;
    const changedCheckNames = Object.entries(business.checks)
      .filter(([key, value]) => value !== row.businessChecks?.[key])
      .map(([key]) => key);
    // A previously accepted bare alias is now correctly rejected as an
    // unavailable/non-fixture tool attempt. Treat that recorded behavior as
    // model misuse when recomputing old rows, rather than source drift.
    const bareFixtureAliasEvents = trace.tools.filter(
      (tool: { name: string }) =>
        [
          'get_order',
          'search_policy',
          'list_products',
          'get_ad_report',
          'create_refund_request',
          'escalate_to_human',
        ].includes(tool.name),
    );
    const onlyNamespaceCorrection =
      changedCheckNames.length === 1 &&
      changedCheckNames[0] === 'onlyAllowedTools' &&
      bareFixtureAliasEvents.length > 0 &&
      row.businessChecks?.onlyAllowedTools === true &&
      business.checks.onlyAllowedTools === false;
    const checksMatch =
      (isDeepStrictEqual(business.checks, row.businessChecks) ||
        onlyNamespaceCorrection) &&
      (business.pass === row.businessPass || onlyNamespaceCorrection);
    const category = classifyFailure({
      caseMatches,
      referencePass,
      fixtureReplayMatches: replay.matches,
      measurementValid: row.measurementValid,
      checksMatch,
      fixtureDiscoverabilityFailure,
    });
    reviews.push({
      candidate: row.candidate,
      caseId: row.caseId,
      repetition: row.repetition,
      executionIndex: row.executionIndex,
      category,
      failedChecks: Object.entries(business.checks)
        .filter(([, pass]) => !pass)
        .map(([key]) => key),
      reason:
        category === 'model_error'
          ? '已公开任务字段和参数；固定参考答案通过相同断言，原始调用逐条复放一致，具体差异见 details。'
          : category === 'fixture_error'
            ? '测量证据无效或原始 fixture 响应/最终状态无法独立复放，不能归因于模型。'
            : '用例、参考答案、评分代码或原始执行契约发生不一致，不能归因于模型。',
      evidence: {
        caseMatches,
        referencePass,
        fixtureReplayMatches: replay.matches,
        fixtureReplayMismatchIndexes: replay.mismatchIndexes,
        checksMatch,
        measurementValid: row.measurementValid,
        fixtureDiscoverabilityFailure,
        fixtureToolSchemaHash: savedResult.toolSchemaHash ?? null,
        currentVisibleToolSchemaHash: visibleSchemaHash,
        emptyQueryCall,
      },
      details: {
        ...businessFailureDetails(test, trace.output, ledger, state),
        bareFixtureAliasEvents: bareFixtureAliasEvents.length,
      },
      sourceHashes: {
        trace: shaFile(traceFile),
        ledger: shaFile(ledgerFile),
        state: shaFile(stateFile),
        originalResult: shaFile(path.join(directory, 'result.json')),
        reference: reference ? hash(reference) : null,
      },
    });
  }
  const categories = Object.fromEntries(
    (['model_error', 'case_or_assertion_error', 'fixture_error'] as const).map(
      (category) => [
        category,
        reviews.filter((row) => row.category === category).length,
      ],
    ),
  );
  const revision = hash([
    fs.readFileSync(new URL('./failure-review.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    shaFile(summaryFile),
  ]);
  const report = {
    schemaVersion: 1,
    runId: path.basename(runDirectory),
    revision,
    sourceHashes: {
      summary: shaFile(summaryFile),
      caseSelfTest: shaFile(selftestFile),
    },
    rawOutputsCopied: false,
    modelCalls: 0,
    attempts: summary.attempts,
    businessPassedAttempts: summary.businessPassedAttempts,
    failedAttempts: reviews.length,
    categories,
    stage4ReviewPassed:
      summary.invalidRun === false &&
      summary.measurementValidityGate?.passed === true &&
      categories.case_or_assertion_error === 0 &&
      categories.fixture_error === 0,
    reviews,
  };
  const file = path.join(
    runDirectory,
    `failure-review.${revision.slice(0, 12)}.json`,
  );
  if (!fs.existsSync(file))
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  return { file, report };
}
