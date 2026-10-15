import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { buildTests } from '../benchmarks/promptfoo/build-tests.js';
import {
  loadProfileVariant,
  loadProfileVariants,
} from '../benchmarks/lib/profile-variants.js';
import {
  compareJointHoldoutData,
  compareProfileRunData,
} from '../benchmarks/scripts/compare-profiles.js';
import { validateProfileRunMatrix } from '../benchmarks/scripts/run-promptfoo.js';

const benchmarkDirectory = path.resolve('benchmarks');

describe('benchmark profile variants', () => {
  it('keeps baseline prompts and runtime policy equal to the current profile', () => {
    const baseline = loadProfileVariant('baseline', benchmarkDirectory);
    const source = parse(
      fs.readFileSync(path.join(benchmarkDirectory, 'profile.yaml'), 'utf8'),
    );
    expect(baseline.profile).toEqual(source);
    expect(baseline.sourceHashes.baseProfile).toBeTruthy();
    expect(baseline.definitionHash).toBeTruthy();
  });

  it('creates isolated prompt variants while preserving runtime tools', () => {
    const baseline = loadProfileVariant('baseline', benchmarkDirectory);
    const strictJson = loadProfileVariant('strict-json', benchmarkDirectory);
    const evidenceAudit = loadProfileVariant(
      'evidence-audit',
      benchmarkDirectory,
    );
    expect(strictJson.profile.agents_prompt).toContain(
      '禁止 Markdown 代码围栏',
    );
    expect(evidenceAudit.profile.agents_prompt).toContain('复算');
    expect(strictJson.profile.runtime_policy).toEqual(
      baseline.profile.runtime_policy,
    );
    expect(evidenceAudit.profile.runtime_policy).toEqual(
      baseline.profile.runtime_policy,
    );
    expect(
      new Set([
        baseline.profileHash,
        strictJson.profileHash,
        evidenceAudit.profileHash,
      ]).size,
    ).toBe(3);
    expect(
      loadProfileVariants(['baseline', 'strict-json'], benchmarkDirectory),
    ).toHaveLength(2);
    expect(() =>
      loadProfileVariants(['baseline', 'baseline'], benchmarkDirectory),
    ).toThrow('profile_variant_list_invalid');
  });

  it('rejects invalid and unknown profile variant ids', () => {
    expect(() => loadProfileVariant('../profile', benchmarkDirectory)).toThrow(
      'profile_variant_id_invalid',
    );
    expect(() => loadProfileVariant('missing', benchmarkDirectory)).toThrow(
      'profile_variant_missing',
    );
  });

  it('bootstraps a profile comparison from paired cases without using Judge scores', () => {
    const buildRun = (
      profileVariant: string,
      passByCase: Record<string, boolean>,
    ) => ({
      split: 'dev',
      invalidRun: false,
      profileVariant,
      identityByCandidate: {
        'candidate-a': { identityStatus: 'verified' },
      },
      sourceHashes: {
        caseDefinition: 'same-cases',
        fixtureDefinitions: 'same-fixtures',
      },
      results: Object.entries(passByCase).map(([caseId, pass]) => ({
        candidate: 'candidate-a',
        caseId,
        measurementValid: true,
        qualityEligible: true,
        pass,
      })),
    });
    const result = compareProfileRunData(
      buildRun('strict-json', { a: true, b: true, c: false }),
      buildRun('baseline', { a: true, b: false, c: false }),
      ['candidate-a'],
      1000,
    );
    expect(result.leftProfile).toBe('strict-json');
    expect(result.rightProfile).toBe('baseline');
    expect(result.candidateResults['candidate-a'].pairedCases).toBe(3);
    expect(result.candidateResults['candidate-a'].difference).toBeCloseTo(
      1 / 3,
    );
    expect(result.multipleComparisonCorrection).toBe(
      'single_predeclared_primary_candidate',
    );
  });

  it('builds an interleaved baseline and winner matrix for one final holdout launch', () => {
    expect(
      validateProfileRunMatrix('holdout', ['baseline', 'evidence-audit'], true),
    ).toEqual({ jointHoldout: true });
    expect(() =>
      validateProfileRunMatrix('holdout', ['baseline'], true),
    ).toThrow('profile_matrix_invalid_for_split');
    expect(() =>
      validateProfileRunMatrix('dev', ['baseline', 'evidence-audit'], false),
    ).toThrow('profile_matrix_invalid_for_split');
    const rows = buildTests(
      [
        {
          id: 'case-a',
          scenario: 'normal',
          prompt: 'question a',
          expected: { status: 'answered', facts: {}, evidence: [] },
          requiredTools: [],
          maxCalls: 1,
        },
        {
          id: 'case-b',
          scenario: 'normal',
          prompt: 'question b',
          expected: { status: 'answered', facts: {}, evidence: [] },
          requiredTools: [],
          maxCalls: 1,
        },
      ],
      [
        {
          alias: 'candidate-a',
          model: 'model-a',
          baseUrl: 'https://vendor.example/v1',
          apiKeyEnv: 'KEY_A',
          gatewayDeclared: false,
          gateway: false,
        },
      ],
      1,
      ['baseline', 'evidence-audit'],
    );
    expect(
      rows.map((row) => [row.metadata.caseId, row.metadata.profileVariant]),
    ).toEqual([
      ['case-a', 'baseline'],
      ['case-a', 'evidence-audit'],
      ['case-b', 'baseline'],
      ['case-b', 'evidence-audit'],
    ]);
    expect(rows).toHaveLength(4);
  });

  it('compares the winner with baseline from one valid final holdout run only', () => {
    const result = compareJointHoldoutData(
      {
        split: 'holdout',
        finalRun: true,
        cumulativeHoldoutRuns: 1,
        invalidRun: false,
        profileVariants: ['baseline', 'evidence-audit'],
        identityByCandidate: {
          'candidate-a': { identityStatus: 'verified' },
        },
        results: [
          {
            candidate: 'candidate-a',
            caseId: 'a',
            profileVariant: 'baseline',
            repetition: 1,
            measurementValid: true,
            qualityEligible: true,
            pass: false,
          },
          {
            candidate: 'candidate-a',
            caseId: 'a',
            profileVariant: 'evidence-audit',
            repetition: 1,
            measurementValid: true,
            qualityEligible: true,
            pass: true,
          },
          {
            candidate: 'candidate-a',
            caseId: 'b',
            profileVariant: 'baseline',
            repetition: 1,
            measurementValid: true,
            qualityEligible: true,
            pass: false,
          },
          {
            candidate: 'candidate-a',
            caseId: 'b',
            profileVariant: 'evidence-audit',
            repetition: 1,
            measurementValid: true,
            qualityEligible: true,
            pass: true,
          },
        ],
      },
      ['candidate-a'],
      'evidence-audit',
      1000,
    );
    expect(result.candidateResults['candidate-a'].pairedCases).toBe(2);
    expect(result.candidateResults['candidate-a'].difference).toBe(1);
    expect(() =>
      compareJointHoldoutData(
        {
          split: 'holdout',
          finalRun: true,
          cumulativeHoldoutRuns: 2,
          invalidRun: false,
          profileVariants: ['baseline', 'evidence-audit'],
          results: [],
        },
        ['candidate-a'],
        'evidence-audit',
      ),
    ).toThrow('joint_holdout_run_invalid');
  });
});
