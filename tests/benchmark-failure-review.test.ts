import { expect, test } from 'vitest';
import {
  loadBusinessCases,
  assertBusinessCase,
} from '../benchmarks/lib/cases.js';
import {
  executeReference,
  loadReferenceAnswers,
} from '../benchmarks/lib/reference-answers.js';
import {
  replayFixtureLedger,
  businessFailureDetails,
  recordedBusinessChecks,
} from '../benchmarks/lib/failure-review.js';
import { diagnoseAttribution } from '../benchmarks/lib/failure-attribution.js';

const healthy = {
  caseMatches: true,
  referencePass: true,
  fixtureReplayMatches: true,
  measurementValid: true,
  checksMatch: true,
  sourceComplete: true,
  independentAssessmentAvailable: true,
  runIntegrityVerified: true,
  recordedMeasurementMatches: true,
  fixtureDiscoverabilityFailure: false,
};

test('reads the actual Runner business check field and rejects conflicting alternate spellings', () => {
  expect(
    recordedBusinessChecks({ business: { facts: false, injection: null } }),
  ).toEqual({ facts: false, injection: null });
  expect(recordedBusinessChecks({ businessChecks: { facts: false } })).toEqual({
    facts: false,
  });
  expect(
    recordedBusinessChecks({
      business: { facts: false },
      businessChecks: { facts: true },
    }),
  ).toBeNull();
  expect(recordedBusinessChecks({ business: { facts: 'false' } })).toBeNull();
  expect(recordedBusinessChecks({})).toBeNull();
});
test('failure attribution rejects case drift and fixture corruption before blaming the model', async () => {
  const item = loadBusinessCases('dev').find((row) => row.id === 'pc-02')!;
  const reference = loadReferenceAnswers('dev').find(
    (row) => row.caseId === item.id,
  )!;
  const original = await executeReference(item, reference);
  expect(
    (await replayFixtureLedger(item, original.ledger, original.state)).matches,
  ).toBe(true);
  const corrupted = structuredClone(original.ledger);
  corrupted[0].result = { products: [] };
  const replay = await replayFixtureLedger(item, corrupted, original.state);
  expect(replay).toMatchObject({ matches: false, mismatchIndexes: [1] });
  expect(
    diagnoseAttribution({ ...healthy, fixtureReplayMatches: replay.matches })
      .suspectedCategories,
  ).toContain('data_or_fixture_error');
  expect(
    diagnoseAttribution({ ...healthy, caseMatches: false }).suspectedCategories,
  ).toContain('case_or_assertion_error');
  expect(
    diagnoseAttribution({ ...healthy, referencePass: false })
      .suspectedCategories,
  ).toContain('case_or_assertion_error');
  const wrong = structuredClone(reference.response);
  wrong.facts.sku = 'BT-B';
  const detail = businessFailureDetails(
    item,
    JSON.stringify(wrong),
    original.ledger,
    original.state,
  );
  expect(detail.factDifferences).toContainEqual(
    expect.objectContaining({ field: 'sku', expected: 'BT-A', actual: 'BT-B' }),
  );
  expect(diagnoseAttribution(healthy).category).toBe('unresolved');
});

test('classifies empty fixture queries under a schema without discoverable enums as fixture errors', () => {
  expect(
    diagnoseAttribution({
      ...healthy,
      fixtureDiscoverabilityFailure: true,
    }).suspectedCategories,
  ).toContain('data_or_fixture_error');
  expect(diagnoseAttribution(healthy).category).toBe('unresolved');
});

test('ad-05 is clarify when the report exists but its conversion field is missing', async () => {
  const item = loadBusinessCases('dev').find((row) => row.id === 'ad-05')!;
  const reference = loadReferenceAnswers('dev').find(
    (row) => row.caseId === item.id,
  )!;
  const evidence = await executeReference(item, reference);
  const reports = evidence.ledger[0]?.result as {
    reports?: Array<Record<string, unknown>>;
  };
  expect(reports.reports).toHaveLength(1);
  expect(reports.reports?.[0]).not.toHaveProperty('conversions');
  expect(reference.response.status).toBe('clarify');
  expect(evidence.business.pass).toBe(true);
});

test('negated causal and completion statements do not trip affirmative-claim checks', async () => {
  for (const id of ['ad-03', 'cp-13']) {
    const item = loadBusinessCases('dev').find((row) => row.id === id)!;
    const reference = loadReferenceAnswers('dev').find(
      (row) => row.caseId === id,
    )!;
    const evidence = await executeReference(item, reference);
    const response = {
      ...reference.response,
      answer:
        id === 'ad-03'
          ? '不能证明广告带来全部增量销售。'
          : '不能确认已经到账，也没有提交真实退款。',
    };
    expect(
      assertBusinessCase(
        JSON.stringify(response),
        item,
        evidence.fixture,
        evidence.ledger,
        evidence.streamTools,
        evidence.state,
      ).pass,
    ).toBe(true);
  }
});
