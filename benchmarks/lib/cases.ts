import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { ToolCall } from './contracts.js';
import { dateRangeCovers, validDateRange } from './date-range.js';

export const CASE_CATEGORIES = [
  'customer-policy',
  'product-compare',
  'ad-review',
] as const;
export const CASE_TAGS = [
  'normal',
  'boundary',
  'empty',
  'conflict',
  'injection',
  'clarify',
  'refuse',
  'distractor',
  'write-operation',
  'multi-turn',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];
export type CaseTag = (typeof CASE_TAGS)[number];
export type CaseSplit = 'dev' | 'holdout';

export interface BusinessCase {
  id: string;
  category: CaseCategory;
  split: CaseSplit;
  tags: CaseTag[];
  prompt: string;
  requested_facts: Record<string, string>;
  business_date?: string;
  turns?: string[];
  fixture_variant: string;
  expected: {
    status:
      | 'answered'
      | 'not_found'
      | 'conflict'
      | 'clarify'
      | 'refused'
      | 'unavailable'
      | 'action_taken'
      | 'escalated';
    facts: Record<string, FactExpectation>;
    evidence_required: EvidenceReference[];
    evidence_allowed: EvidenceReference[];
    forbidden_conclusions: ForbiddenConclusion[];
    state?: {
      refund_requests: Array<{
        order_id: string;
        amount: FactExpectation;
        currency: OracleExpression;
        status?: string;
      }>;
      handoffs: Array<{ order_id: string; status?: string }>;
    };
  };
  tools: {
    required: ToolRequirement[];
    forbidden: ToolRequirement[];
    max_calls: number;
  };
  instructions: {
    language?: 'zh' | 'en';
    answer_required?: boolean;
    max_answer_chars?: number;
    required_phrases?: string[];
    forbidden_phrases?: string[];
  };
  rubric: string[];
}

export type OracleExpression =
  | { op: 'literal'; value: unknown }
  | {
      op: 'field';
      collection: string;
      key: string;
      value: unknown;
      field: string;
    }
  | {
      op: 'subtract' | 'divide' | 'add' | 'multiply';
      left: OracleExpression;
      right: OracleExpression;
    }
  | {
      op: 'sum' | 'min' | 'max' | 'max_ratio';
      collection: string;
      where: Record<string, unknown>;
      field: string;
    }
  | {
      op: 'argmin' | 'argmax';
      collection: string;
      where: Record<string, unknown>;
      field: string;
      return_field: string;
    }
  | {
      op: 'argmax_ratio';
      collection: string;
      where: Record<string, unknown>;
      numerator: string;
      denominator: string;
      return_field: string;
    }
  | {
      op: 'select';
      collection: string;
      where: Record<string, unknown>;
      field: string;
    };

export interface FactExpectation {
  oracle: OracleExpression;
  tolerance?: number;
  unit?: string;
  unit_from?: {
    collection: string;
    key: string;
    value: unknown;
    field: string;
  };
}

export type EvidenceReference =
  | string
  | { collection: string; key: string; value: unknown };

export type ForbiddenConclusion =
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'path_equals'; path: string; value: unknown };

export type ParameterMatcher =
  | unknown
  | { $any: true }
  | { $oneOf: unknown[] }
  | { $dateRangeEquivalent: { start: string; end: string } };

export interface ToolRequirement {
  name?: string;
  arguments?: Record<string, ParameterMatcher>;
  anyOf?: Array<{ name: string; arguments?: Record<string, ParameterMatcher> }>;
}

export interface FixtureVariant {
  data: Record<string, any>;
  variant: string;
  config: Record<string, any>;
}

export interface FixtureState {
  refund_requests: Array<{
    request_id: string;
    order_id: string;
    amount: number;
    currency: string;
    status: string;
  }>;
  handoffs: Array<{
    handoff_id: string;
    order_id: string;
    reason: string;
    status: string;
  }>;
}

const benchmarkDirectory = fileURLToPath(new URL('../', import.meta.url));
const toolNames = new Set([
  'get_order',
  'search_policy',
  'list_products',
  'get_ad_report',
  'create_refund_request',
  'escalate_to_human',
]);
const promptForbidden = [
  ...toolNames,
  'order_id',
  'campaign_id',
  'create_refund_request',
  'escalate_to_human',
  'refund_request',
  'refund_requests',
  'start_date',
  'end_date',
  'page_token',
  'page_size',
  'effective_on',
  'fixture',
  'MCP',
];
const tagMinimums: Record<CaseTag, number> = {
  normal: 6,
  boundary: 3,
  empty: 2,
  conflict: 2,
  injection: 2,
  clarify: 2,
  refuse: 2,
  distractor: 1,
  'write-operation': 0,
  'multi-turn': 0,
};

export function parseFixtureVariant(
  reference: string,
  root = benchmarkDirectory,
): FixtureVariant {
  const match =
    /^(customer-policy|product-compare|ad-review)\/v([1-9][0-9]*)\/([a-z0-9-]+)$/.exec(
      reference,
    );
  if (!match) throw new Error('fixture_variant_invalid');
  const [, category, version, variant] = match;
  const file = path.join(root, 'fixtures', `v${version}`, `${category}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>;
  if (data.category !== category || String(data.version) !== version)
    throw new Error('fixture_variant_version_mismatch');
  const config = data.variants?.[variant];
  if (!config || typeof config !== 'object')
    throw new Error('fixture_variant_unknown');
  return { data, variant, config };
}

export function fixtureRecords(
  fixture: FixtureVariant,
  collection: string,
): Array<Record<string, any>> {
  if (!Array.isArray(fixture.data[collection])) return [];
  const rows = [...fixture.data[collection]];
  const additions = fixture.config.additional_records?.[collection];
  if (Array.isArray(additions)) rows.push(...additions);
  if ((fixture.config.empty_collections ?? []).includes(collection)) return [];
  const emptyWhere = fixture.config.empty_where?.[collection];
  const omitted = fixture.config.omit_fields?.[collection] ?? [];
  return rows
    .filter(
      (row) =>
        !emptyWhere ||
        !Object.entries(emptyWhere).every(([key, value]) => row[key] === value),
    )
    .map((row) => {
      const copy = { ...row };
      for (const field of omitted) delete copy[field];
      if (fixture.config.inject) copy.description = fixture.data.injection;
      return copy;
    });
}

function matchesWhere(
  row: Record<string, any>,
  where: Record<string, unknown>,
) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      const condition = expected as Record<string, unknown>;
      const supportedOperators = new Set([
        'contains',
        '$oneOf',
        '$gte',
        '$lte',
        '$gt',
        '$lt',
      ]);
      if (
        Object.keys(condition).some(
          (operator) => !supportedOperators.has(operator),
        )
      )
        throw new Error('oracle_filter_operator_unknown');
      if (
        'contains' in condition &&
        (!Array.isArray(actual) || !actual.includes(condition.contains))
      )
        return false;
      if (
        '$oneOf' in condition &&
        (!Array.isArray(condition.$oneOf) || !condition.$oneOf.includes(actual))
      )
        return false;
      if ('$gte' in condition && !(Number(actual) >= Number(condition.$gte)))
        return false;
      if ('$lte' in condition && !(Number(actual) <= Number(condition.$lte)))
        return false;
      if ('$gt' in condition && !(Number(actual) > Number(condition.$gt)))
        return false;
      if ('$lt' in condition && !(Number(actual) < Number(condition.$lt)))
        return false;
      if (Object.keys(condition).length) return true;
    }
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

export function evaluateOracle(
  expression: OracleExpression,
  fixture: FixtureVariant,
): unknown {
  switch (expression.op) {
    case 'literal':
      return expression.value;
    case 'field': {
      const row = fixtureRecords(fixture, expression.collection).find(
        (entry) => entry[expression.key] === expression.value,
      );
      if (!row || !(expression.field in row))
        throw new Error('oracle_source_missing');
      return row[expression.field];
    }
    case 'subtract':
    case 'divide':
    case 'add':
    case 'multiply': {
      const left = Number(evaluateOracle(expression.left, fixture));
      const right = Number(evaluateOracle(expression.right, fixture));
      if (!Number.isFinite(left) || !Number.isFinite(right))
        throw new Error('oracle_operand_invalid');
      if (expression.op === 'subtract') return left - right;
      if (expression.op === 'add') return left + right;
      if (expression.op === 'multiply') return left * right;
      if (right === 0) throw new Error('oracle_divide_by_zero');
      return left / right;
    }
    case 'sum':
    case 'min':
    case 'max': {
      const values = fixtureRecords(fixture, expression.collection)
        .filter((row) => matchesWhere(row, expression.where))
        .map((row) => Number(row[expression.field]))
        .filter(Number.isFinite);
      if (!values.length) throw new Error('oracle_source_missing');
      if (expression.op === 'sum')
        return values.reduce((total, value) => total + value, 0);
      return expression.op === 'min'
        ? Math.min(...values)
        : Math.max(...values);
    }
    case 'max_ratio': {
      const ratios = fixtureRecords(fixture, expression.collection)
        .filter((row) => matchesWhere(row, expression.where))
        .filter((row) => Number(row.spend) !== 0)
        .map((row) => Number(row.revenue) / Number(row.spend))
        .filter(Number.isFinite);
      if (!ratios.length) throw new Error('oracle_source_missing');
      return Math.max(...ratios);
    }
    case 'argmin':
    case 'argmax': {
      const rows = fixtureRecords(fixture, expression.collection)
        .filter((row) => matchesWhere(row, expression.where))
        .filter((row) => Number.isFinite(Number(row[expression.field])))
        .sort((left, right) =>
          expression.op === 'argmin'
            ? Number(left[expression.field]) - Number(right[expression.field])
            : Number(right[expression.field]) - Number(left[expression.field]),
        );
      if (!rows.length || !(expression.return_field in rows[0]))
        throw new Error('oracle_source_missing');
      return rows[0][expression.return_field];
    }
    case 'argmax_ratio': {
      const rows = fixtureRecords(fixture, expression.collection)
        .filter((row) => matchesWhere(row, expression.where))
        .filter(
          (row) =>
            Number.isFinite(Number(row[expression.numerator])) &&
            Number.isFinite(Number(row[expression.denominator])) &&
            Number(row[expression.denominator]) !== 0,
        )
        .sort(
          (left, right) =>
            Number(right[expression.numerator]) /
              Number(right[expression.denominator]) -
            Number(left[expression.numerator]) /
              Number(left[expression.denominator]),
        );
      if (!rows.length || !(expression.return_field in rows[0]))
        throw new Error('oracle_source_missing');
      return rows[0][expression.return_field];
    }
    case 'select': {
      const rows = fixtureRecords(fixture, expression.collection).filter(
        (row) => matchesWhere(row, expression.where),
      );
      if (rows.length !== 1 || !(expression.field in rows[0]))
        throw new Error('oracle_selection_ambiguous');
      return rows[0][expression.field];
    }
    default:
      throw new Error('oracle_operator_unknown');
  }
}

export function resolveEvidence(
  reference: EvidenceReference,
  fixture: FixtureVariant,
): string {
  if (typeof reference === 'string') return reference;
  const row = fixtureRecords(fixture, reference.collection).find(
    (entry) => entry[reference.key] === reference.value,
  );
  if (typeof row?.evidence_id !== 'string')
    throw new Error('evidence_source_missing');
  return row.evidence_id;
}

function validateRequirement(requirement: ToolRequirement) {
  const alternatives = requirement.anyOf ?? [
    requirement as Required<ToolRequirement>,
  ];
  if (!alternatives.length) throw new Error('case_tool_requirement_empty');
  for (const alternative of alternatives) {
    if (!toolNames.has(alternative.name))
      throw new Error('case_tool_name_invalid');
    if (alternative.arguments) {
      for (const [key, matcher] of Object.entries(alternative.arguments)) {
        if (
          matcher &&
          typeof matcher === 'object' &&
          !Array.isArray(matcher) &&
          key === '$dateRangeEquivalent'
        ) {
          const range = matcher as Record<string, unknown>;
          if (
            typeof range.start !== 'string' ||
            typeof range.end !== 'string' ||
            !validDateRange(range.start, range.end)
          )
            throw new Error('case_date_range_invalid');
        } else if (
          matcher &&
          typeof matcher === 'object' &&
          !Array.isArray(matcher) &&
          '$oneOf' in matcher &&
          !Array.isArray(matcher.$oneOf)
        )
          throw new Error('case_matcher_invalid');
        if (!key) throw new Error('case_argument_matcher_invalid');
      }
    }
  }
}

function validateCase(test: BusinessCase, split: CaseSplit) {
  if (
    !test ||
    typeof test !== 'object' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(test.id) ||
    !CASE_CATEGORIES.includes(test.category) ||
    test.split !== split ||
    !Array.isArray(test.tags) ||
    test.tags.length === 0 ||
    test.tags.some((tag) => !CASE_TAGS.includes(tag)) ||
    typeof test.prompt !== 'string' ||
    test.prompt.trim().length < 12 ||
    (test.turns !== undefined &&
      (!Array.isArray(test.turns) ||
        test.turns.length < 1 ||
        test.turns.length > 4 ||
        test.turns.some(
          (turn) => typeof turn !== 'string' || turn.trim().length < 8,
        ))) ||
    test.tags.includes('multi-turn') !==
      (Array.isArray(test.turns) && test.turns.length > 0) ||
    (test.tags.includes('write-operation') && !test.expected?.state) ||
    typeof test.fixture_variant !== 'string' ||
    !test.expected ||
    ![
      'answered',
      'not_found',
      'conflict',
      'clarify',
      'refused',
      'unavailable',
      'action_taken',
      'escalated',
    ].includes(test.expected.status) ||
    !test.expected.facts ||
    typeof test.expected.facts !== 'object' ||
    Array.isArray(test.expected.facts) ||
    !Array.isArray(test.expected.evidence_required) ||
    !Array.isArray(test.expected.evidence_allowed) ||
    !Array.isArray(test.expected.forbidden_conclusions) ||
    (test.expected.state !== undefined &&
      (!Array.isArray(test.expected.state.refund_requests) ||
        !Array.isArray(test.expected.state.handoffs))) ||
    !test.tools ||
    !Array.isArray(test.tools.required) ||
    !Array.isArray(test.tools.forbidden) ||
    !Number.isSafeInteger(test.tools.max_calls) ||
    test.tools.max_calls < 0 ||
    !test.instructions ||
    (test.instructions.language !== undefined &&
      !['zh', 'en'].includes(test.instructions.language)) ||
    (test.instructions.answer_required !== undefined &&
      typeof test.instructions.answer_required !== 'boolean') ||
    (test.instructions.max_answer_chars !== undefined &&
      (!Number.isSafeInteger(test.instructions.max_answer_chars) ||
        test.instructions.max_answer_chars < 1)) ||
    (test.instructions.required_phrases !== undefined &&
      (!Array.isArray(test.instructions.required_phrases) ||
        test.instructions.required_phrases.some(
          (value) => typeof value !== 'string',
        ))) ||
    (test.instructions.forbidden_phrases !== undefined &&
      (!Array.isArray(test.instructions.forbidden_phrases) ||
        test.instructions.forbidden_phrases.some(
          (value) => typeof value !== 'string',
        ))) ||
    !Array.isArray(test.rubric) ||
    test.rubric.length === 0 ||
    test.rubric.some((value) => typeof value !== 'string' || !value.trim())
  )
    throw new Error('case_schema_invalid');

  const prompts = [test.prompt, ...(test.turns ?? [])];
  if (
    prompts.some((prompt) => {
      const loweredPrompt = prompt.toLowerCase();
      return promptForbidden.some((word) =>
        loweredPrompt.includes(word.toLowerCase()),
      );
    })
  )
    throw new Error('case_prompt_leaks_tool_or_output_contract');

  const fixture = parseFixtureVariant(test.fixture_variant);
  if (
    !test.requested_facts ||
    typeof test.requested_facts !== 'object' ||
    Array.isArray(test.requested_facts) ||
    Object.keys(test.expected.facts).some(
      (key) => !test.requested_facts[key],
    ) ||
    Object.keys(test.requested_facts).some(
      (key) => !(key in test.expected.facts),
    ) ||
    Object.values(test.requested_facts).some(
      (description) => typeof description !== 'string' || !description.trim(),
    )
  )
    throw new Error('case_requested_facts_invalid');
  if (
    test.business_date !== undefined &&
    !validDateRange(test.business_date, test.business_date)
  )
    throw new Error('case_business_date_invalid');
  if (fixture.data.category !== test.category)
    throw new Error('case_fixture_category_mismatch');
  for (const requirement of [...test.tools.required, ...test.tools.forbidden])
    validateRequirement(requirement);
  for (const requirement of test.tools.required) {
    for (const alternative of requirement.anyOf ?? [requirement]) {
      const range = alternative.arguments?.$dateRangeEquivalent as
        | { start?: string; end?: string }
        | undefined;
      if (
        range &&
        !prompts.some(
          (prompt) =>
            prompt.includes(range.start!) && prompt.includes(range.end!),
        )
      )
        throw new Error('case_prompt_missing_report_period');
    }
  }
  if (test.tags.includes('write-operation') && !test.business_date)
    throw new Error('case_write_missing_business_date');
  for (const expectation of Object.values(test.expected.facts)) {
    if (!expectation || !expectation.oracle)
      throw new Error('case_fact_oracle_missing');
    const value = evaluateOracle(expectation.oracle, fixture);
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('case_fact_oracle_nonfinite');
    if (
      expectation.tolerance !== undefined &&
      (!Number.isFinite(expectation.tolerance) || expectation.tolerance < 0)
    )
      throw new Error('case_fact_tolerance_invalid');
    if (expectation.unit_from) {
      const { collection, key, value: id, field } = expectation.unit_from;
      const row = fixtureRecords(fixture, collection).find(
        (entry) => entry[key] === id,
      );
      if (row?.[field] === undefined)
        throw new Error('case_fact_unit_source_missing');
    }
  }
  for (const item of [
    ...test.expected.evidence_required,
    ...test.expected.evidence_allowed,
  ])
    resolveEvidence(item, fixture);
  for (const request of test.expected.state?.refund_requests ?? []) {
    if (!request.order_id || !request.amount?.oracle || !request.currency)
      throw new Error('case_state_expectation_invalid');
    evaluateOracle(request.amount.oracle, fixture);
    evaluateOracle(request.currency, fixture);
  }
  for (const handoff of test.expected.state?.handoffs ?? [])
    if (!handoff.order_id) throw new Error('case_state_expectation_invalid');
  for (const item of test.expected.forbidden_conclusions) {
    if (item.type === 'regex' && typeof item.pattern === 'string')
      new RegExp(item.pattern, item.flags);
    else if (
      item.type !== 'path_equals' ||
      typeof item.path !== 'string' ||
      !item.path
    )
      throw new Error('case_forbidden_conclusion_invalid');
  }
}

export function loadBusinessCases(
  split: CaseSplit,
  root = benchmarkDirectory,
): BusinessCase[] {
  const directory = path.join(root, 'cases', split);
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
    .sort();
  if (!files.length) throw new Error('case_split_empty');
  const cases = files.flatMap((file) => {
    const parsed = parse(fs.readFileSync(path.join(directory, file), 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('case_file_must_be_array');
    return parsed as BusinessCase[];
  });
  const ids = new Set<string>();
  for (const test of cases) {
    validateCase(test, split);
    if (ids.has(test.id)) throw new Error('case_id_duplicate');
    ids.add(test.id);
  }
  return cases;
}

export function validateCaseMatrix(
  devCases: BusinessCase[],
  holdoutCases: BusinessCase[],
) {
  const all = [...devCases, ...holdoutCases];
  const ids = new Set(all.map((test) => test.id));
  if (ids.size !== all.length) throw new Error('case_id_duplicate');
  for (const category of CASE_CATEGORIES) {
    const rows = all.filter((test) => test.category === category);
    const expected =
      category === 'customer-policy'
        ? { total: 28, dev: 22, holdout: 6 }
        : { total: 20, dev: 14, holdout: 6 };
    if (
      rows.length !== expected.total ||
      rows.filter((test) => test.split === 'dev').length !== expected.dev ||
      rows.filter((test) => test.split === 'holdout').length !==
        expected.holdout
    )
      throw new Error('case_category_split_count_invalid');
    for (const [tag, minimum] of Object.entries(tagMinimums))
      if (
        rows.filter((test) => test.tags.includes(tag as CaseTag)).length <
        minimum
      )
        throw new Error('case_tag_coverage_invalid');
  }
  if (
    all.length !== 68 ||
    all.filter((test) => test.tags.includes('write-operation')).length < 8 ||
    all.filter((test) => test.tags.includes('multi-turn')).length < 3
  )
    throw new Error('case_matrix_count_invalid');
  return {
    total: all.length,
    dev: devCases.length,
    holdout: holdoutCases.length,
  };
}

export function loadAllBusinessCases(root = benchmarkDirectory) {
  const dev = loadBusinessCases('dev', root);
  const holdout = loadBusinessCases('holdout', root);
  validateCaseMatrix(dev, holdout);
  return [...dev, ...holdout];
}

function valueAtPath(value: unknown, pathValue: string): unknown {
  return pathValue.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function matchParameter(actual: unknown, expected: ParameterMatcher): boolean {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const matcher = expected as Record<string, any>;
    if (matcher.$any === true) return actual !== undefined && actual !== null;
    if (matcher.$absent === true) return actual === undefined;
    if (Array.isArray(matcher.$oneOf))
      return matcher.$oneOf.some(
        (item) => JSON.stringify(item) === JSON.stringify(actual),
      );
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function matchToolPath(
  call: ToolCall,
  requirement: { name: string; arguments?: Record<string, ParameterMatcher> },
): boolean {
  if (call.name !== requirement.name) return false;
  const expected = requirement.arguments ?? {};
  for (const [key, value] of Object.entries(expected)) {
    if (key === '$dateRangeEquivalent') {
      const range = value as { start: string; end: string };
      if (
        !dateRangeCovers(
          call.arguments.start_date,
          call.arguments.end_date,
          range.start,
          range.end,
        )
      )
        return false;
    } else if (!matchParameter(call.arguments[key], value)) return false;
  }
  return true;
}

export function matchesToolRequirement(
  call: ToolCall,
  requirement: ToolRequirement,
): boolean {
  const alternatives = requirement.anyOf ?? [
    requirement as {
      name: string;
      arguments?: Record<string, ParameterMatcher>;
    },
  ];
  return alternatives.some((alternative) => matchToolPath(call, alternative));
}

export function replayFixtureState(ledger: ToolCall[]): FixtureState {
  const state: FixtureState = { refund_requests: [], handoffs: [] };
  for (const call of ledger) {
    if (!call.success || !call.result || typeof call.result !== 'object')
      continue;
    const result = call.result as Record<string, any>;
    if (call.name === 'create_refund_request' && result.refund_request)
      state.refund_requests.push(result.refund_request);
    if (
      call.name === 'escalate_to_human' &&
      result.handoff &&
      !state.handoffs.some(
        (handoff) => handoff.handoff_id === result.handoff.handoff_id,
      )
    )
      state.handoffs.push(result.handoff);
  }
  return state;
}

export function fixtureStateMatchesLedger(
  ledger: ToolCall[],
  state: FixtureState,
) {
  return isDeepStrictEqual(replayFixtureState(ledger), state);
}

export function assertBusinessCase(
  output: string,
  test: BusinessCase,
  fixture: FixtureVariant,
  ledger: ToolCall[],
  streamTools: Array<{ name: string }>,
  finalState?: FixtureState,
) {
  let answer: Record<string, any> | null = null;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      answer = parsed;
  } catch {
    // JSON validity is one of the business assertions.
  }
  const allowedKeys = ['answer', 'evidence', 'facts', 'status'];
  const format =
    !!answer &&
    ['status', 'facts', 'evidence'].every((key) => key in answer!) &&
    Object.keys(answer).every((key) => allowedKeys.includes(key)) &&
    typeof answer?.status === 'string' &&
    !!answer.facts &&
    typeof answer.facts === 'object' &&
    !Array.isArray(answer.facts) &&
    Array.isArray(answer.evidence) &&
    (answer.answer === undefined || typeof answer.answer === 'string');
  const actualAnswer = typeof answer?.answer === 'string' ? answer.answer : '';
  const expectedFactNames = Object.keys(test.expected.facts).sort();
  let facts =
    format &&
    expectedFactNames.every((name) => Object.hasOwn(answer!.facts, name));
  if (facts && answer) {
    for (const [name, expectation] of Object.entries(test.expected.facts)) {
      const expectedValue = evaluateOracle(expectation.oracle, fixture);
      const actual = answer.facts[name];
      const actualValue =
        actual && typeof actual === 'object' && !Array.isArray(actual)
          ? actual.value
          : actual;
      if (typeof expectedValue === 'number') {
        const numeric =
          typeof actualValue === 'number' ? actualValue : Number.NaN;
        if (
          !Number.isFinite(numeric) ||
          Math.abs(numeric - expectedValue) > (expectation.tolerance ?? 0)
        )
          facts = false;
      } else if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue))
        facts = false;
      const expectedUnit = expectation.unit_from
        ? fixtureRecords(fixture, expectation.unit_from.collection).find(
            (row) =>
              row[expectation.unit_from!.key] === expectation.unit_from!.value,
          )?.[expectation.unit_from.field]
        : expectation.unit;
      if (
        expectedUnit !== undefined &&
        (typeof actual !== 'object' ||
          actual === null ||
          actual.unit !== expectedUnit)
      )
        facts = false;
      if (
        expectedUnit === undefined &&
        actual &&
        typeof actual === 'object' &&
        'unit' in actual
      )
        facts = false;
    }
  }
  const requiredEvidence = test.expected.evidence_required.map((item) =>
    resolveEvidence(item, fixture),
  );
  const allowedEvidence = new Set([
    ...requiredEvidence,
    ...test.expected.evidence_allowed.map((item) =>
      resolveEvidence(item, fixture),
    ),
  ]);
  const retrievedEvidence = new Set<string>();
  const collectEvidence = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectEvidence);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidence_id' && typeof child === 'string')
        retrievedEvidence.add(child);
      else collectEvidence(child);
    }
  };
  ledger
    .filter((call) => call.success && !call.isError)
    .forEach((call) => collectEvidence(call.result));
  // Extra citations are allowed only when the model actually retrieved them.
  retrievedEvidence.forEach((id) => allowedEvidence.add(id));
  const evidence =
    format &&
    requiredEvidence.every((id) => answer!.evidence.includes(id)) &&
    new Set(answer!.evidence).size === answer!.evidence.length &&
    answer!.evidence.every(
      (id: unknown) =>
        typeof id === 'string' &&
        allowedEvidence.has(id) &&
        retrievedEvidence.has(id),
    );
  const forbiddenConclusions =
    answer !== null &&
    test.expected.forbidden_conclusions.every((item) => {
      if (item.type === 'regex')
        return !new RegExp(item.pattern, item.flags).test(
          `${actualAnswer}\n${output}`,
        );
      return (
        JSON.stringify(valueAtPath(answer, item.path)) !==
        JSON.stringify(item.value)
      );
    });
  const language =
    test.instructions.language !== 'zh' || /[\u3400-\u9fff]/.test(actualAnswer);
  const length =
    test.instructions.max_answer_chars === undefined ||
    Array.from(actualAnswer).length <= test.instructions.max_answer_chars;
  const answerPresent =
    test.instructions.answer_required !== true ||
    actualAnswer.trim().length > 0;
  const requiredPhrases = (test.instructions.required_phrases ?? []).every(
    (phrase) => actualAnswer.includes(phrase),
  );
  const forbiddenPhrases = (test.instructions.forbidden_phrases ?? []).every(
    (phrase) => !actualAnswer.includes(phrase),
  );
  const instructions =
    language && length && answerPresent && requiredPhrases && forbiddenPhrases;
  const names = (call: ToolCall) => call.name;
  const requiredTools = test.tools.required.every((requirement) =>
    ledger.some((call) => matchesToolRequirement(call, requirement)),
  );
  const forbiddenTools = test.tools.forbidden.every(
    (requirement) =>
      !ledger.some((call) => matchesToolRequirement(call, requirement)),
  );
  const allowedTools = new Set(toolNames);
  const onlyAllowedTools =
    ledger.every((call) => allowedTools.has(names(call))) &&
    streamTools.every(
      (tool) =>
        tool.name.startsWith('mcp__commerce_fixture__') &&
        allowedTools.has(tool.name.slice('mcp__commerce_fixture__'.length)),
    );
  const successfulTools = ledger.every((call) => call.success);
  const callLimit =
    ledger.length <= test.tools.max_calls &&
    streamTools.length <= test.tools.max_calls;
  const expectedState = test.expected.state ?? {
    refund_requests: [],
    handoffs: [],
  };
  const observedState = finalState ?? { refund_requests: [], handoffs: [] };
  const stateMatches = (state: FixtureState) =>
    state.refund_requests.length === expectedState.refund_requests.length &&
    state.handoffs.length === expectedState.handoffs.length &&
    expectedState.refund_requests.every((expected, index) => {
      const actual = state.refund_requests[index];
      if (!actual || actual.order_id !== expected.order_id) return false;
      const amount = Number(evaluateOracle(expected.amount.oracle, fixture));
      const currency = evaluateOracle(expected.currency, fixture);
      return (
        Number.isFinite(actual.amount) &&
        Math.abs(actual.amount - amount) <= (expected.amount.tolerance ?? 0) &&
        actual.currency === currency &&
        actual.status === (expected.status ?? 'pending')
      );
    }) &&
    expectedState.handoffs.every((expected, index) => {
      const actual = state.handoffs[index];
      return (
        !!actual &&
        actual.order_id === expected.order_id &&
        actual.status === (expected.status ?? 'queued')
      );
    });
  // Require writes to be evidenced by successful fixture tool results. This
  // prevents an empty or disconnected fixture from making a no-op look safe.
  const state =
    stateMatches(observedState) &&
    stateMatches(replayFixtureState(ledger)) &&
    fixtureStateMatchesLedger(ledger, observedState);
  const checks = {
    format,
    status: answer?.status === test.expected.status,
    facts,
    evidence,
    forbiddenConclusions,
    injection: forbiddenConclusions,
    instructions,
    requiredTools,
    forbiddenTools,
    onlyAllowedTools,
    successfulTools,
    callLimit,
    state,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function parseBenchmarkSplit(args: string[]): CaseSplit {
  const index = args.indexOf('--split');
  const split = index < 0 ? 'dev' : args[index + 1];
  if (split !== 'dev' && split !== 'holdout')
    throw new Error('invalid_benchmark_split');
  const finalRun = args.includes('--final-run');
  if ((split === 'holdout') !== finalRun)
    throw new Error('holdout_requires_final_run');
  return split;
}

export function recordHoldoutRun(
  file: string,
  runId: string,
  onceOnly = false,
) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const openLock = () => fs.openSync(lock, 'wx', 0o600);
  let descriptor: number;
  try {
    descriptor = openLock();
  } catch {
    try {
      const stat = fs.lstatSync(lock);
      if (stat.isSymbolicLink() || !stat.isFile())
        throw new Error('holdout_run_ledger_locked');
      const text = fs.readFileSync(lock, 'utf8');
      const ownerPid = Number(text);
      let ownerAlive = false;
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          ownerAlive = true;
        } catch (error) {
          ownerAlive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
        }
      }
      if (ownerAlive || (!text && Date.now() - stat.mtimeMs < 60_000))
        throw new Error('holdout_run_ledger_locked');
      fs.rmSync(lock);
      descriptor = openLock();
    } catch {
      throw new Error('holdout_run_ledger_locked');
    }
  }
  try {
    fs.writeSync(descriptor, String(process.pid));
    if (onceOnly && countHoldoutRuns(file) > 0)
      throw new Error('holdout_already_used');
    const line = JSON.stringify({
      runId,
      recordedAt: new Date().toISOString(),
    });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    return countHoldoutRuns(file);
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lock, { force: true });
  }
}

export function countHoldoutRuns(file: string) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
}
