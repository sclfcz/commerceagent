import { describe, expect, test } from 'vitest';
import {
  loadAllBusinessCases,
  assertBusinessCase,
} from '../benchmarks/lib/cases.js';
import { renderCasePrompts } from '../benchmarks/lib/contracts.js';
import {
  executeReference,
  loadReferenceAnswers,
  referenceMutations,
} from '../benchmarks/lib/reference-answers.js';
import {
  dateRangeCovers,
  dateRangesOverlap,
  validDateRange,
} from '../benchmarks/lib/date-range.js';

const cases = loadAllBusinessCases();
const refs = [
  ...loadReferenceAnswers('dev'),
  ...loadReferenceAnswers('holdout'),
];
describe('every case has an executable fixed reference answer', () => {
  test.each(cases)(
    '$id: all assertions pass, every mutated answer fails',
    async (item) => {
      const reference = refs.find((row) => row.caseId === item.id)!;
      expect(reference).toBeDefined();
      const evidence = await executeReference(item, reference);
      expect(evidence.business.checks).toEqual(
        Object.fromEntries(
          Object.entries(evidence.business.checks).map(([key, value]) => [
            key,
            value === null ? null : true,
          ]),
        ),
      );
      expect(
        referenceMutations(item, reference, evidence).filter(
          (row) => !row.rejected,
        ),
      ).toEqual([]);
      const rendered = renderCasePrompts(item).at(-1)!;
      for (const field of Object.keys(item.requested_facts))
        expect(rendered).toContain(JSON.stringify(field));
      const contract = rendered.slice(rendered.indexOf('响应 facts'));
      expect(contract).not.toContain('oracle');
      expect(contract).not.toContain('evidence_id');
      expect(contract).not.toContain('get_order');
      if (item.instructions.max_answer_chars !== undefined)
        expect(contract).toContain(
          `"max_answer_chars":${item.instructions.max_answer_chars}`,
        );
      const extra = structuredClone(reference.response);
      extra.facts.retrieved_record_count = evidence.ledger.length;
      expect(
        assertBusinessCase(
          JSON.stringify(extra),
          item,
          evidence.fixture,
          evidence.ledger,
          evidence.streamTools,
          evidence.state,
        ).pass,
      ).toBe(true);
    },
  );
  test('in-stock selection excludes the larger out-of-stock battery but permits its comparison citation', async () => {
    const item = cases.find((row) => row.id === 'pc-02')!;
    const reference = refs.find((row) => row.caseId === item.id)!;
    const evidence = await executeReference(item, reference);
    expect(reference.response.facts.sku).toBe('BT-A');
    expect(reference.response.facts.capacity_mah).toEqual({
      value: 10000,
      unit: 'mAh',
    });
    const extra = structuredClone(reference.response);
    extra.evidence.push('PRODUCT-BATTERY-B');
    expect(
      assertBusinessCase(
        JSON.stringify(extra),
        item,
        evidence.fixture,
        evidence.ledger,
        evidence.streamTools,
        evidence.state,
      ).pass,
    ).toBe(true);
    const bareAlias = [...evidence.streamTools, { name: 'get_ad_report' }];
    expect(
      assertBusinessCase(
        JSON.stringify(reference.response),
        item,
        evidence.fixture,
        evidence.ledger,
        bareAlias,
        evidence.state,
      ).checks.onlyAllowedTools,
    ).toBe(false);
  });
  test('one covering all-campaign query is equivalent to separate exact campaign queries', async () => {
    const item = cases.find((row) => row.id === 'ad-02')!;
    const reference = structuredClone(
      refs.find((row) => row.caseId === item.id)!,
    );
    reference.calls = [
      {
        name: 'get_ad_report',
        arguments: { start_date: '2026-09-01', end_date: '2026-09-30' },
        turn: 1,
      },
    ];
    const evidence = await executeReference(item, reference);
    expect((evidence.ledger[0].result as any).reports).toHaveLength(10);
    expect(evidence.business.pass).toBe(true);
  });
  test('a partial overlap returns whole report rows but cannot stand in for querying the entire required period', async () => {
    const item = cases.find((row) => row.id === 'ad-01')!;
    const reference = structuredClone(
      refs.find((row) => row.caseId === item.id)!,
    );
    reference.calls[0].arguments.start_date = '2026-09-07';
    reference.calls[0].arguments.end_date = '2026-09-08';
    const evidence = await executeReference(item, reference);
    expect((evidence.ledger[0].result as any).reports).toHaveLength(2);
    expect(evidence.business.checks.requiredTools).toBe(false);
  });
  test('valid arguments with a fixture timeout are audited separately from successful tool results', async () => {
    const item = cases.find((row) => row.id === 'ad-12')!;
    const evidence = await executeReference(
      item,
      refs.find((row) => row.caseId === item.id)!,
    );
    expect(evidence.ledger[0]).toMatchObject({
      success: true,
      isError: true,
      result: { error: 'tool_timeout' },
    });
    expect(evidence.business.pass).toBe(true);
  });
});

describe('date intervals are explicit and inclusive', () => {
  test('supports overlapping fixture ranges and covering query equivalence, rejects invalid dates', () => {
    expect(
      dateRangesOverlap('2026-09-01', '2026-09-30', '2026-09-01', '2026-09-07'),
    ).toBe(true);
    expect(
      dateRangesOverlap('2026-09-07', '2026-09-08', '2026-09-01', '2026-09-07'),
    ).toBe(true);
    expect(
      dateRangesOverlap('2026-09-08', '2026-09-14', '2026-09-01', '2026-09-07'),
    ).toBe(false);
    expect(
      dateRangeCovers(
        '2026-09-01T00:00:00Z',
        '2026-09-30T23:59:59Z',
        '2026-09-01',
        '2026-09-07',
      ),
    ).toBe(true);
    expect(
      dateRangeCovers('2026-09-02', '2026-09-07', '2026-09-01', '2026-09-07'),
    ).toBe(false);
    expect(validDateRange('2026-02-30', '2026-03-01')).toBe(false);
    expect(validDateRange('2026-09-07', '2026-09-01')).toBe(false);
  });
});
