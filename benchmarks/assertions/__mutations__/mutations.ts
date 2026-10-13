import type { BusinessCase, FixtureVariant } from '../../lib/cases.js';
import type { ToolCall } from '../../lib/contracts.js';
import {
  evaluateOracle,
  resolveEvidence,
  fixtureRecords,
  parseFixtureVariant,
} from '../../lib/cases.js';

export function correctAnswer(test: BusinessCase, fixture: FixtureVariant) {
  const facts = Object.fromEntries(
    Object.entries(test.expected.facts).map(([name, expectation]) => {
      const value = evaluateOracle(expectation.oracle, fixture);
      const unit = expectation.unit_from
        ? fixture.data[expectation.unit_from.collection]?.find(
            (row: Record<string, unknown>) =>
              row[expectation.unit_from!.key] === expectation.unit_from!.value,
          )?.[expectation.unit_from.field]
        : expectation.unit;
      return [name, unit === undefined ? value : { value, unit }];
    }),
  );
  return {
    status: test.expected.status,
    facts,
    evidence: test.expected.evidence_required.map((item) =>
      resolveEvidence(item, fixture),
    ),
    answer: [
      '根据已查到的资料，以下结论有对应证据支持。',
      ...(test.instructions.required_phrases ?? []),
    ].join(''),
  };
}

function matcherValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const matcher = value as Record<string, unknown>;
  if (matcher.$any === true) return 'synthetic';
  if (Array.isArray(matcher.$oneOf)) return matcher.$oneOf[0];
  return value;
}

export function callsFor(test: BusinessCase): ToolCall[] {
  const fixture = parseFixtureVariant(test.fixture_variant);
  const calls = test.tools.required.map((requirement) => {
    const path = requirement.anyOf?.[0] ?? requirement;
    const args: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(path.arguments ?? {})) {
      if (key === '$dateRangeEquivalent') {
        const range = raw as { start: string; end: string };
        args.start_date = range.start;
        args.end_date = range.end;
      } else args[key] = matcherValue(raw);
    }
    const collection =
      path.name === 'get_order'
        ? 'orders'
        : path.name === 'search_policy'
          ? 'policies'
          : path.name === 'list_products'
            ? 'products'
            : 'ads';
    const rows = fixtureRecords(fixture, collection).filter((row) =>
      Object.entries(args).every(
        ([key, value]) =>
          ['page_token', 'start_date', 'end_date', 'effective_on'].includes(
            key,
          ) || row[key] === value,
      ),
    );
    return {
      sequence: 0,
      name: path.name!,
      arguments: args,
      result: { [collection === 'ads' ? 'reports' : collection]: rows },
      success: true,
    };
  });
  calls.forEach((call, index) => (call.sequence = index + 1));
  return calls;
}

export function withCallMutation(calls: ToolCall[]) {
  const changed = structuredClone(calls);
  if (changed[0]) changed[0].arguments = { unexpected: true };
  return changed;
}
