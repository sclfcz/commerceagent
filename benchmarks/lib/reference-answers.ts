import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import { hash, type ToolCall } from './contracts.js';
import {
  assertBusinessCase,
  parseFixtureVariant,
  type BusinessCase,
  type CaseSplit,
  type FixtureState,
} from './cases.js';

export interface ReferenceAnswer {
  caseId: string;
  caseHash: string;
  fixtureHash: string;
  response: {
    status: string;
    facts: Record<string, any>;
    evidence: string[];
    answer: string;
  };
  calls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    turn: number;
  }>;
  reviewNote: string;
}

export function loadReferenceAnswers(split: CaseSplit): ReferenceAnswer[] {
  const directory = fileURLToPath(
    new URL(`../references/${split}/`, import.meta.url),
  );
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      const file = JSON.parse(
        fs.readFileSync(path.join(directory, name), 'utf8'),
      );
      if (file.schemaVersion !== 1 || !Array.isArray(file.references))
        throw new Error('reference_schema_invalid');
      return file.references;
    });
}

export async function executeReference(
  test: BusinessCase,
  reference: ReferenceAnswer,
) {
  const fixture = parseFixtureVariant(test.fixture_variant);
  if (
    reference.caseId !== test.id ||
    reference.caseHash !== hash(test) ||
    reference.fixtureHash !== hash(fixture)
  )
    throw new Error(`reference_snapshot_mismatch:${test.id}`);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'commerce-case-reference-'),
  );
  fs.chmodSync(directory, 0o700);
  const server = await startFixtureServer({
    data: fixture.data as Record<string, any> & { version: string | number },
    scenario: 'normal',
    variantConfig: fixture.config,
    includeWorkflowWrites: test.tags.includes('write-operation'),
    ledgerFile: path.join(directory, 'fixture.jsonl'),
  });
  try {
    for (const [index, call] of reference.calls.entries()) {
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
      const body = (await response.json()) as { error?: unknown };
      if (!response.ok || body.error)
        throw new Error(`reference_fixture_transport:${test.id}`);
    }
    const ledger = structuredClone(server.ledger);
    const state = structuredClone(server.state);
    const streamTools = ledger.map((call) => ({
      name: `mcp__commerce_fixture__${call.name}`,
    }));
    const business = assertBusinessCase(
      JSON.stringify(reference.response),
      test,
      fixture,
      ledger,
      streamTools,
      state,
    );
    return { business, ledger, state, streamTools, fixture };
  } finally {
    await server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** All mutations operate on saved synthetic evidence; no additional model/tool calls. */
export function referenceMutations(
  test: BusinessCase,
  reference: ReferenceAnswer,
  evidence: Awaited<ReturnType<typeof executeReference>>,
) {
  const { fixture, ledger, state, streamTools } = evidence;
  const run = (
    response: unknown,
    calls = ledger,
    finalState = state,
    tools = streamTools,
  ) =>
    assertBusinessCase(
      JSON.stringify(response),
      test,
      fixture,
      calls,
      tools,
      finalState,
    );
  const mutants: Array<{ name: string; rejected: boolean }> = [];
  const add = (
    name: string,
    response: unknown,
    calls = ledger,
    finalState = state,
    tools = streamTools,
  ) =>
    mutants.push({
      name,
      rejected: !run(response, calls, finalState, tools).pass,
    });
  add('wrong_status', { ...reference.response, status: 'mutated' });
  for (const name of Object.keys(test.expected.facts)) {
    const missing = structuredClone(reference.response);
    delete missing.facts[name];
    add(`missing_fact:${name}`, missing);
    const wrong = structuredClone(reference.response);
    const field = wrong.facts[name];
    const value = field && typeof field === 'object' ? field.value : field;
    const mutated =
      typeof value === 'number'
        ? value + Math.max(1, (test.expected.facts[name].tolerance ?? 0) * 2)
        : typeof value === 'boolean'
          ? !value
          : `${String(value)}-incorrect`;
    wrong.facts[name] =
      field && typeof field === 'object'
        ? { ...field, value: mutated }
        : mutated;
    add(`wrong_fact:${name}`, wrong);
    if (field && typeof field === 'object' && 'unit' in field) {
      const wrongUnit = structuredClone(reference.response);
      wrongUnit.facts[name].unit = 'INVALID_UNIT';
      add(`wrong_unit:${name}`, wrongUnit);
    }
  }
  if (reference.response.evidence.length)
    add('missing_evidence', { ...reference.response, evidence: [] });
  add('fabricated_evidence', {
    ...reference.response,
    evidence: [...reference.response.evidence, 'NOT-RETRIEVED-EVIDENCE'],
  });
  if (test.tools.required.length)
    add(
      'wrong_tool_arguments',
      reference.response,
      ledger.map((call) => ({ ...call, arguments: { invalid: true } })),
    );
  if (test.instructions.language === 'zh')
    add('wrong_language', {
      ...reference.response,
      answer: 'I cannot verify the requested business information.',
    });
  if (test.instructions.max_answer_chars !== undefined)
    add('exceeded_answer_length', {
      ...reference.response,
      answer: '甲'.repeat(test.instructions.max_answer_chars + 1),
    });
  if (test.instructions.answer_required)
    add('missing_user_answer', { ...reference.response, answer: '' });
  for (const phrase of test.instructions.required_phrases ?? [])
    add('missing_required_phrase', {
      ...reference.response,
      answer: reference.response.answer.replace(phrase, ''),
    });
  for (const phrase of test.instructions.forbidden_phrases ?? [])
    add('included_forbidden_phrase', {
      ...reference.response,
      answer: `${reference.response.answer}${phrase}`,
    });
  if (ledger.length)
    add(
      'failed_tool_execution',
      reference.response,
      ledger.map((call, index) => (index ? call : { ...call, success: false })),
    );
  const extraCall: ToolCall = {
    sequence: 999,
    name: 'get_order',
    arguments: { order_id: 'unrelated' },
    result: {},
    success: true,
  };
  const tooMany = [...ledger];
  while (tooMany.length <= test.tools.max_calls) tooMany.push(extraCall);
  add('exceeded_call_limit', reference.response, tooMany);
  const badState: FixtureState = structuredClone(state);
  badState.refund_requests.push({
    request_id: 'UNAUTHORIZED',
    order_id: 'ORD-404',
    amount: 1,
    currency: 'USD',
    status: 'pending',
  });
  add('unintended_write', reference.response, ledger, badState);
  for (const forbidden of test.expected.forbidden_conclusions) {
    const wrong = structuredClone(reference.response);
    if (forbidden.type === 'path_equals') {
      const keys = forbidden.path.split('.');
      let target: Record<string, any> = wrong;
      for (const key of keys.slice(0, -1)) target = target[key] ??= {};
      target[keys.at(-1)!] = forbidden.value;
    } else {
      wrong.answer = forbidden.pattern.includes('EVAL_COMPROMISED')
        ? 'EVAL_COMPROMISED'
        : forbidden.pattern.includes('SYSTEM OVERRIDE')
          ? 'SYSTEM OVERRIDE'
          : test.category === 'customer-policy'
            ? '我已经退款'
            : test.category === 'product-compare'
              ? '我已经修改'
              : test.id === 'ad-20'
                ? '我已经提高预算'
                : '我已经暂停';
    }
    add('forbidden_conclusion', wrong);
  }
  return mutants;
}

export async function selfTestReferences(cases: BusinessCase[]) {
  const splits = [...new Set(cases.map((test) => test.split))];
  const references = splits.flatMap(loadReferenceAnswers);
  const unique = new Set(references.map((row) => row.caseId));
  if (unique.size !== references.length)
    throw new Error('duplicate_case_reference');
  let mutationCount = 0;
  for (const test of cases) {
    const reference = references.find((row) => row.caseId === test.id);
    if (!reference) throw new Error(`missing_case_reference:${test.id}`);
    const result = await executeReference(test, reference);
    if (!result.business.pass)
      throw new Error(
        `invalid_case_reference:${test.id}:${Object.entries(
          result.business.checks,
        )
          .filter(([, pass]) => !pass)
          .map(([check]) => check)
          .join(',')}`,
      );
    const mutants = referenceMutations(test, reference, result);
    if (mutants.some((mutant) => !mutant.rejected))
      throw new Error(`undetected_case_mutation:${test.id}`);
    mutationCount += mutants.length;
  }
  return {
    cases: cases.length,
    referencesPassed: cases.length,
    rejectedMutations: mutationCount,
  };
}
