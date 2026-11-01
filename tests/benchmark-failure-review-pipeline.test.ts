import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { hash } from '../benchmarks/lib/contracts.js';
import {
  assertBusinessCase,
  loadBusinessCases,
} from '../benchmarks/lib/cases.js';
import {
  executeReference,
  loadReferenceAnswers,
} from '../benchmarks/lib/reference-answers.js';
import { definitionsForFixture } from '../benchmarks/mcp-fixture-server/server.js';
import { readReviewArtifact } from '../benchmarks/lib/failure-review-artifacts.js';
import { reviewFailures } from '../benchmarks/lib/failure-review.js';
import { reassessPromptfoo } from '../benchmarks/lib/reassess-promptfoo.js';

// The raw-evidence reassessor is tested separately. These tests exercise the
// attribution adapter, real local reference/fixture replay and immutable I/O.
vi.mock('../benchmarks/lib/reassess-promptfoo.js', () => ({
  reassessPromptfoo: vi.fn(),
}));
const roots: string[] = [];
beforeEach(() => {
  vi.mocked(reassessPromptfoo).mockReset();
});
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

async function savedAttempt() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'failure-review-pipeline-'),
  );
  roots.push(root);
  const write = (relative: string, data: unknown) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  };
  const test = loadBusinessCases('dev').find((item) => item.id === 'cp-01')!;
  const reference = loadReferenceAnswers('dev').find(
    (item) => item.caseId === test.id,
  )!;
  const observed = await executeReference(test, reference);
  const response = structuredClone(reference.response);
  response.facts.net_refund = { value: 999, unit: 'USD' };
  response.answer += ' PRIVATE_REPLY_SENTINEL';
  const output = JSON.stringify(response);
  const business = assertBusinessCase(
    output,
    test,
    observed.fixture,
    observed.ledger,
    observed.streamTools,
    observed.state,
  );
  const row = {
    candidate: 'candidate-private',
    caseId: test.id,
    executionIndex: 1,
    repetition: 1,
    measurementValid: true,
    businessPass: business.pass,
    businessChecks: business.checks,
  };
  write('summary.json', {
    split: 'dev',
    attempts: 1,
    businessPassedAttempts: 0,
    invalidRun: false,
    measurementValidityGate: { passed: true },
    results: [row],
  });
  write('cases.used.json', [test]);
  write('case-selftest.json', { caseHashes: { [test.id]: hash(test) } });
  write('candidates.json', [
    {
      alias: 'candidate-private',
      model: 'vendor-guarded-identifier',
      baseUrl: 'https://private-gateway.invalid/anthropic',
    },
  ]);
  write('promptfoo-0001/trace.json', { output, tools: observed.streamTools });
  const ledgerFile = path.join(root, 'promptfoo-0001/fixture.jsonl');
  fs.writeFileSync(
    ledgerFile,
    observed.ledger.map((call) => JSON.stringify(call)).join('\n') + '\n',
  );
  write('promptfoo-0001/fixture-state.json', observed.state);
  write('promptfoo-0001/fixture-snapshot.json', observed.fixture);
  const { businessChecks, ...runtimeRow } = row;
  write('promptfoo-0001/result.json', {
    ...runtimeRow,
    business: businessChecks,
    output,
    caseHash: hash(test),
    fixtureHash: hash(observed.fixture),
    toolSchemaHash: hash(definitionsForFixture(false, observed.fixture.data)),
  });
  fs.writeFileSync(
    path.join(root, 'reassessed.json'),
    'historical reassessment must not be replaced',
  );
  const independent = {
    invalidRun: false,
    measurementValidityGate: { passed: true },
    measurementValidAttempts: 1,
    businessPassedAttempts: 0,
    results: [{ ...row, measurementFailure: null }],
  };
  vi.mocked(reassessPromptfoo).mockReturnValue(independent as any);
  const sourceFiles = [
    'summary.json',
    'cases.used.json',
    'case-selftest.json',
    'candidates.json',
    'promptfoo-0001/trace.json',
    'promptfoo-0001/fixture.jsonl',
    'promptfoo-0001/fixture-state.json',
    'promptfoo-0001/fixture-snapshot.json',
    'promptfoo-0001/result.json',
    'reassessed.json',
  ];
  const sourceBytes = Object.fromEntries(
    sourceFiles.map((file) => [file, fs.readFileSync(path.join(root, file))]),
  );
  return { root, write, row, independent, sourceBytes };
}

test('writes an unresolved diagnostic, private template and anonymous summary without mutating evidence', async () => {
  const { root, sourceBytes } = await savedAttempt();
  const { file, publicFile, templateFile, report } = await reviewFailures(root);
  expect(reassessPromptfoo).toHaveBeenCalledWith(root, { persist: false });
  expect(report).toMatchObject({
    schemaVersion: 2,
    reviewedAttempts: 1,
    unresolvedAttempts: 1,
    confirmedAttempts: 0,
    stage4ReviewPassed: false,
    modelCalls: 0,
    categories: { agent_error: 0, unresolved: 1 },
  });
  expect(report.reviews[0].attribution).toMatchObject({
    status: 'needs_review',
    agentAttributionAllowed: true,
  });
  expect(report.reviews[0].diagnostics.failedChecks).toContain('facts');
  expect(report.reviews[0].diagnostics.failedChecks).not.toContain('injection');
  expect(fs.readFileSync(publicFile, 'utf8')).not.toMatch(
    /candidate-private|vendor-guarded|private-gateway|PRIVATE_REPLY_SENTINEL|cp-01/,
  );
  expect(
    JSON.parse(fs.readFileSync(templateFile, 'utf8')).reviews[0],
  ).toMatchObject({ category: null, reviewer: '', evidence: [] });
  expect((await reviewFailures(root)).file).toBe(file);
  for (const [relative, bytes] of Object.entries(sourceBytes))
    expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
});

test('human evidence confirms an Agent cause in a separate immutable revision, never changes grading', async () => {
  const { root, write, row, sourceBytes } = await savedAttempt();
  const initial = await reviewFailures(root);
  const trace = readReviewArtifact(root, 'promptfoo-0001/trace.json');
  write('completed.json', {
    schemaVersion: 1,
    evidenceRevision: initial.report.evidenceRevision,
    reviews: [
      {
        executionIndex: 1,
        candidate: row.candidate,
        caseId: row.caseId,
        category: 'agent_error',
        reviewer: 'human-reviewer',
        rationale:
          'The returned order and policy support 108, while the output says 999.',
        evidence: [
          {
            artifact: 'promptfoo-0001/trace.json',
            sha256: trace.sha256,
            pointer: '/output',
          },
        ],
      },
    ],
  });
  const confirmed = await reviewFailures(root, {
    adjudicationsFile: 'completed.json',
  });
  expect(confirmed.file).not.toBe(initial.file);
  expect(confirmed.report).toMatchObject({
    confirmedAttempts: 1,
    unresolvedAttempts: 0,
    stage4ReviewPassed: true,
    categories: { agent_error: 1 },
  });
  expect(
    JSON.parse(fs.readFileSync(initial.file, 'utf8')).categories.agent_error,
  ).toBe(0);
  for (const [relative, bytes] of Object.entries(sourceBytes))
    expect(fs.readFileSync(path.join(root, relative))).toEqual(bytes);
});

test('does not trust an asserted measurement pass when independent evidence disagrees', async () => {
  const { root, independent } = await savedAttempt();
  independent.results[0].measurementValid = false;
  independent.results[0].measurementFailure = 'stream_disconnected' as any;
  const { report } = await reviewFailures(root);
  expect(report.reviews[0]).toMatchObject({
    measurementFailure: 'stream_disconnected',
    attribution: {
      category: 'unresolved',
      status: 'evidence_blocked',
      agentAttributionAllowed: false,
    },
  });
  expect(report.reviews[0].attribution.suspectedCategories).toContain(
    'measurement_error',
  );
  expect(report.reviews[0].attribution.suspectedCategories).not.toContain(
    'data_or_fixture_error',
  );
});

test('a check becoming inapplicable is not reported as a changed task verdict', async () => {
  const { root, write, row } = await savedAttempt();
  const oldChecks = { ...row.businessChecks, injection: true };
  write('summary.json', {
    split: 'dev',
    results: [{ ...row, businessChecks: oldChecks }],
  });
  const source = readReviewArtifact(root, 'promptfoo-0001/result.json');
  write('promptfoo-0001/result.json', { ...source.data, business: oldChecks });
  const { report } = await reviewFailures(root);
  expect(report).toMatchObject({
    businessVerdictChangedAttempts: 0,
    measurementVerdictChangedAttempts: 0,
    recordedCheckDisagreementAttempts: 1,
  });
});

test('missing trace produces an incomplete diagnostic, not a model or fixture verdict', async () => {
  const { root } = await savedAttempt();
  fs.rmSync(path.join(root, 'promptfoo-0001/trace.json'));
  vi.mocked(reassessPromptfoo).mockImplementation(() => {
    throw new Error('raw trace unavailable');
  });
  const { report } = await reviewFailures(root);
  expect(report).toMatchObject({
    unresolvedAttempts: 1,
    evidenceBlockedAttempts: 1,
    stage4ReviewPassed: false,
  });
  expect(report.reviews[0].evidenceErrors).toContainEqual({
    artifact: 'promptfoo-0001/trace.json',
    code: 'missing',
  });
  expect(report.reviews[0].diagnostics.failedChecks).toEqual([]);
});

test('reviews forged passing summaries instead of silently skipping them', async () => {
  const { root, write, row } = await savedAttempt();
  write('summary.json', {
    split: 'dev',
    results: [
      {
        ...row,
        businessPass: true,
        businessChecks: Object.fromEntries(
          Object.keys(row.businessChecks).map((key) => [key, true]),
        ),
      },
    ],
  });
  const { report } = await reviewFailures(root);
  expect(report.reviewedAttempts).toBe(1);
  expect(report.reviews[0].evidence.checksMatch).toBe(false);
  expect(report.categories.agent_error).toBe(0);
});

test('a summary cannot hide a failed attempt that exists in the independent evidence', async () => {
  const { root, write, row, independent } = await savedAttempt();
  const omitted = { ...independent.results[0], executionIndex: 2 };
  independent.results.push(omitted);
  fs.cpSync(
    path.join(root, 'promptfoo-0001'),
    path.join(root, 'promptfoo-0002'),
    { recursive: true },
  );
  const { report } = await reviewFailures(root);
  expect(report).toMatchObject({
    attempts: 2,
    reviewedAttempts: 2,
    summaryCoverageVerified: false,
    stage4ReviewPassed: false,
    causalReviewComplete: false,
  });
  expect(
    report.reviews.find((review) => review.executionIndex === 2)?.attribution,
  ).toMatchObject({ category: 'unresolved', agentAttributionAllowed: false });
  write('summary.json', { split: 'dev', results: [row] });
});

test('changing evidence invalidates a previously completed human review', async () => {
  const { root, write, row } = await savedAttempt();
  const initial = await reviewFailures(root);
  const source = readReviewArtifact(root, 'promptfoo-0001/trace.json');
  write('completed.json', {
    schemaVersion: 1,
    evidenceRevision: initial.report.evidenceRevision,
    reviews: [
      {
        ...row,
        category: 'agent_error',
        reviewer: 'human',
        rationale: 'Verified the amount.',
        evidence: [
          {
            artifact: 'promptfoo-0001/trace.json',
            sha256: source.sha256,
            pointer: '/output',
          },
        ],
      },
    ],
  });
  const trace = source.data;
  trace.output += ' ';
  write('promptfoo-0001/trace.json', trace);
  await expect(
    reviewFailures(root, { adjudicationsFile: 'completed.json' }),
  ).rejects.toThrow('adjudications_stale');
});

test('rejects source edits made while the independent review is running', async () => {
  const { root, write, row, independent } = await savedAttempt();
  vi.mocked(reassessPromptfoo).mockImplementation(() => {
    write('summary.json', {
      split: 'dev',
      results: [row],
      injectedChange: true,
    });
    return independent as any;
  });
  await expect(reviewFailures(root)).rejects.toThrow(
    'failure_review_source_changed',
  );
  expect(
    fs.readdirSync(root).some((file) => file.startsWith('failure-review.')),
  ).toBe(false);
});

test.each([
  { output: 'substituted output' },
  { repetition: 2 },
  { caseHash: 'f'.repeat(64) },
  { fixtureHash: 'f'.repeat(64) },
])(
  'a saved result cannot be swapped away from its trace, repetition or contract: %j',
  async (patch) => {
    const { root, write } = await savedAttempt();
    const source = readReviewArtifact(root, 'promptfoo-0001/result.json');
    write('promptfoo-0001/result.json', { ...source.data, ...patch });
    const { report } = await reviewFailures(root);
    expect(report.reviews[0].evidenceErrors).toContainEqual({
      artifact: 'promptfoo-0001/result.json',
      code: 'recorded_result_binding_mismatch',
    });
    expect(report.reviews[0].attribution).toMatchObject({
      category: 'unresolved',
      agentAttributionAllowed: false,
    });
  },
);

test('rejects holdout and duplicate attempt identities before independently reassessing', async () => {
  const { root, write, row } = await savedAttempt();
  vi.mocked(reassessPromptfoo).mockClear();
  write('summary.json', { split: 'holdout', results: [row] });
  await expect(reviewFailures(root)).rejects.toThrow('failure_review_dev_only');
  expect(reassessPromptfoo).not.toHaveBeenCalled();
  write('summary.json', { split: 'dev', results: [row, row] });
  await expect(reviewFailures(root)).rejects.toThrow(
    'failure_review_attempt_identity_invalid',
  );
  expect(reassessPromptfoo).not.toHaveBeenCalled();
});
