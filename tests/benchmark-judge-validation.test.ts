import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import {
  assessJudgeValidationReadiness,
  countSubstantiveBusinessFailures,
  selectFreshUniqueCases,
} from '../benchmarks/lib/judge-validation.js';
import { collectPreviouslyUsedCaseIds } from '../benchmarks/scripts/judge-validation-preflight.js';

test('requires enough fresh natural cases while reserving at most 30% for synthetic failures', () => {
  const insufficient = assessJudgeValidationReadiness({
    requestedSamples: 20,
    maximumSyntheticFraction: 0.3,
    minimumContentFailureFraction: 0.3,
    minimumNaturalContentFailures: 1,
    freshEligibleCases: 10,
    freshNaturalContentFailures: 1,
  });
  expect(insufficient).toMatchObject({
    ready: false,
    requiredContentFailures: 6,
    maximumSyntheticSamples: 6,
    syntheticSamplesNeeded: 5,
    naturalSamplesRequired: 15,
    reasons: ['too_few_fresh_eligible_cases'],
  });

  const sufficient = assessJudgeValidationReadiness({
    requestedSamples: 20,
    maximumSyntheticFraction: 0.3,
    minimumContentFailureFraction: 0.3,
    minimumNaturalContentFailures: 1,
    freshEligibleCases: 20,
    freshNaturalContentFailures: 1,
  });
  expect(sufficient).toMatchObject({
    ready: true,
    syntheticSamplesNeeded: 5,
    naturalSamplesRequired: 15,
    freshCasesRequired: 20,
    additionalFreshCasesNeeded: 0,
    additionalNaturalContentFailuresNeeded: 0,
  });
});

test('does not treat only synthetic errors as an independent natural validation set', () => {
  const readiness = assessJudgeValidationReadiness({
    requestedSamples: 20,
    maximumSyntheticFraction: 0.3,
    minimumContentFailureFraction: 0.3,
    minimumNaturalContentFailures: 1,
    freshEligibleCases: 20,
    freshNaturalContentFailures: 0,
  });
  expect(readiness.ready).toBe(false);
  expect(readiness.reasons).toContain('too_few_natural_content_failures');
});

test('does not count formatting-only failures as substantive content failures', () => {
  expect(countSubstantiveBusinessFailures({ format: false })).toBe(0);
  expect(
    countSubstantiveBusinessFailures({ format: false, facts: false }),
  ).toBe(1);
});

test('counts one unseen case once even when several candidates or repetitions ran it', () => {
  const samples = [
    {
      sampleId: 'later',
      caseId: 'cp-01',
      executionIndex: 7,
    },
    {
      sampleId: 'first',
      caseId: 'cp-01',
      executionIndex: 2,
    },
    {
      sampleId: 'used',
      caseId: 'pc-02',
      executionIndex: 3,
    },
  ] as Array<{ sampleId: string; caseId: string; executionIndex: number }>;
  const selected = selectFreshUniqueCases(samples as never, new Set(['pc-02']));
  expect(selected.map((sample) => sample.sampleId)).toEqual(['first']);
});

test('collects prior dev case IDs but never opens holdout Judge artifacts', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'judge-validation-history-'),
  );
  const makeRun = (name: string, split: 'dev' | 'holdout') => {
    const run = path.join(root, name);
    fs.mkdirSync(path.join(run, 'judge', 'executions', 'execution-1'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ split }));
    fs.writeFileSync(
      path.join(run, 'run-metadata.json'),
      JSON.stringify({ split }),
    );
    return run;
  };
  try {
    const source = makeRun('source', 'dev');
    const priorDev = makeRun('prior-dev', 'dev');
    const holdout = makeRun('holdout', 'holdout');
    fs.writeFileSync(
      path.join(
        priorDev,
        'judge',
        'executions',
        'execution-1',
        'report.private.json',
      ),
      JSON.stringify({ split: 'dev', samples: [{ caseId: 'cp-02' }] }),
    );
    fs.writeFileSync(
      path.join(
        holdout,
        'judge',
        'executions',
        'execution-1',
        'report.private.json',
      ),
      'holdout report content must not be opened',
    );
    const result = collectPreviouslyUsedCaseIds(source, []);
    expect([...result.usedCaseIds]).toEqual(['cp-02']);
    expect(result.sources).toEqual([
      { runId: 'prior-dev', uniquePreviouslyUsedCases: 1 },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when a prior dev Judge report cannot provide case IDs', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'judge-validation-history-invalid-'),
  );
  const run = path.join(root, 'prior-dev');
  const reportFile = path.join(
    run,
    'judge/executions/execution-1/report.private.json',
  );
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(
    path.join(run, 'summary.json'),
    JSON.stringify({ split: 'dev' }),
  );
  fs.writeFileSync(
    path.join(run, 'run-metadata.json'),
    JSON.stringify({ split: 'dev' }),
  );
  fs.writeFileSync(reportFile, JSON.stringify({ split: 'dev' }));
  try {
    expect(() => collectPreviouslyUsedCaseIds(run, [])).toThrow(
      'judge_validation_history_samples_missing',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
