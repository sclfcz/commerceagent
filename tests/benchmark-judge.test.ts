import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  configurePromptfooStorage,
  installPromptfooNetworkGuard,
} from '../benchmarks/promptfoo/runtime.js';
import {
  binaryCohenKappa,
  calibrationScorePairs,
  ordinalCohenKappa,
  assessInjectionProbe,
  scoreFromGradingResult,
  createBlindSampleId,
  judgeRubricPrompt,
  selectCalibrationSamples,
} from '../benchmarks/lib/judge.js';
import {
  analyzeHumanLabels,
  buildHumanLabelTemplate,
  renderCalibrationSummary,
} from '../benchmarks/scripts/calibrate.js';
import { buildJudgePayloadPreview } from '../benchmarks/scripts/judge.js';
import { validateCustomSampleSet } from '../benchmarks/scripts/judge.js';

const sample = (index: number, category: string, businessPass: boolean) => ({
  sampleId: createBlindSampleId('run', index),
  caseId: `case-${index}`,
  category,
  businessPass,
  executionIndex: index,
  question: '请核对这笔订单。',
  expectedStatus: 'answered',
  expectedFacts: { amount: { value: 12, unit: 'USD' } },
  requiredEvidence: ['ORDER-1'],
  expectedEvidence: ['ORDER-1'],
  allowedEvidence: ['ORDER-1'],
  toolReturns: [
    {
      sequence: 1,
      tool: 'get_order',
      arguments: { order_id: 'O-1' },
      success: true,
      isError: false,
      returned: { amount: 12, evidence_id: 'ORDER-1' },
    },
  ],
  rubric: ['说明结论并给出依据。'],
  candidateOutput: '{"answer":"订单金额是 12 美元。"}',
});

describe('benchmark blind judge', () => {
  it('allows only the approved API path and blocks telemetry, lookalikes and redirects', async () => {
    const fetchSpy = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetchSpy);
    const restore = installPromptfooNetworkGuard(['https://judge.example/v1']);
    try {
      await fetch('https://judge.example/v1/chat/completions', {
        method: 'POST',
      });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://judge.example/v1/chat/completions',
        expect.objectContaining({ redirect: 'error' }),
      );
      await expect(
        fetch('https://judge.example/v10/chat/completions'),
      ).rejects.toThrow('benchmark_unapproved_network_destination');
      await expect(fetch('https://telemetry.example/')).rejects.toThrow(
        'benchmark_unapproved_network_destination',
      );
      await expect(fetch('http://127.0.0.1:1234/')).rejects.toThrow(
        'benchmark_unapproved_network_destination',
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      restore();
      vi.unstubAllGlobals();
    }
  });

  it('stratifies a deterministic sample without repeating cases', () => {
    const rows = [
      sample(1, 'customer-policy', true),
      sample(2, 'customer-policy', false),
      sample(3, 'product-compare', true),
      sample(4, 'product-compare', false),
      sample(5, 'ad-review', true),
      sample(6, 'ad-review', false),
    ];
    const first = selectCalibrationSamples(rows, 6, 'run');
    const second = selectCalibrationSamples(rows, 6, 'run');
    expect(first.map((row) => row.sampleId)).toEqual(
      second.map((row) => row.sampleId),
    );
    expect(new Set(first.map((row) => row.caseId)).size).toBe(6);
    expect(new Set(first.map((row) => row.category)).size).toBe(3);
  });

  it('validates saved samples by identity rather than requiring file row order', () => {
    const rows = [
      sample(11, 'customer-policy', true),
      sample(12, 'product-compare', false),
    ];
    expect(validateCustomSampleSet([...rows].reverse(), rows)).toEqual(
      [...rows].reverse(),
    );
    expect(() =>
      validateCustomSampleSet(
        [{ ...rows[0], candidateOutput: 'tampered' }, rows[1]],
        rows,
      ),
    ).toThrow('judge_custom_sample_integrity_failed');
  });

  it('marks candidate output as untrusted and demands the compact score contract', () => {
    const [system, user] = judgeRubricPrompt('grounding');
    expect(system.content).toContain('不可信数据');
    expect(system.content).toContain('工具实际返回');
    expect(user.content).toContain('<candidate_output>');
    expect(user.content).toContain('{{output}}');
    expect(system.content).toContain('"score":number');
  });

  it('renders a blind payload with the untrusted candidate tag and no alias field', () => {
    const payloads = buildJudgePayloadPreview([
      {
        ...sample(7, 'customer-policy', true),
        question: '问题 {{candidateOutput}} must not trigger recursion',
      },
    ]);
    expect(payloads).toHaveLength(5);
    const serialized = JSON.stringify(payloads);
    expect(serialized).toContain('<candidate_output>');
    expect(serialized).toContain('订单金额是 12 美元。');
    expect(payloads[1].prompt[1].content).toContain('"returned":{"amount":12');
    expect(payloads[1].prompt[1].content).toContain('"ORDER-1"');
    expect(serialized).toContain('问题 ');
    expect(serialized).not.toContain('candidateAlias');
  });

  it('computes binary agreement, kappa and false pass/reject counts', () => {
    const result = binaryCohenKappa([
      { judgePass: true, humanPass: true },
      { judgePass: true, humanPass: false },
      { judgePass: false, humanPass: false },
      { judgePass: false, humanPass: true },
    ]);
    expect(result.agreement).toBe(0.5);
    expect(result.kappa).toBe(0);
    expect(result.falsePasses).toBe(1);
    expect(result.falseRejects).toBe(1);
    expect(result.falsePassRate).toBe(0.5);
    expect(result.falseRejectRate).toBe(0.5);
  });

  it('calculates quadratic weighted kappa against a hand-computed 5-point example', () => {
    const result = ordinalCohenKappa([
      { judge: 1, human: 1 },
      { judge: 2, human: 3 },
      { judge: 4, human: 4 },
      { judge: 5, human: 5 },
    ]);
    expect(result.exactAgreement).toBe(0.75);
    expect(result.observedDisagreement).toBe(1 / 64);
    expect(result.expectedDisagreement).toBe(19 / 64);
    expect(result.quadraticWeightedKappa).toBeCloseTo(18 / 19);
    expect(result.judgeCounts).toEqual([1, 1, 0, 1, 1]);
    expect(result.humanCounts).toEqual([1, 0, 1, 1, 1]);
  });

  it('reports perfect raw agreement with undefined kappa for a constant label distribution', () => {
    const binary = binaryCohenKappa(
      Array.from({ length: 20 }, () => ({ judgePass: true, humanPass: true })),
    );
    const ordinal = ordinalCohenKappa(
      Array.from({ length: 20 }, () => ({ judge: 4, human: 4 })),
    );
    expect(binary.agreement).toBe(1);
    expect(binary.kappa).toBeNull();
    expect(ordinal.exactAgreement).toBe(1);
    expect(ordinal.quadraticWeightedKappa).toBeNull();
    expect(ordinal.undefinedReason).toBe('zero_expected_disagreement');
    expect(ordinalCohenKappa([]).quadraticWeightedKappa).toBeNull();
    expect(() => ordinalCohenKappa([{ judge: 1.5, human: 4 }])).toThrow(
      'ordinal_score_invalid',
    );
  });

  it('marks a dimension information-insufficient before reporting kappa at 90% concentration', () => {
    const metrics = calibrationScorePairs(
      Array.from({ length: 20 }, (_, i) => ({
        judgeScores: { grounding: i < 5 ? 4 : 5 },
        humanScores: { grounding: 5 },
      })),
    );
    const grounding = metrics.byDimension.grounding;
    expect(grounding.agreement).toBe(1);
    expect(grounding.ordinal.exactAgreement).toBe(0.75);
    expect(grounding.kappa).toBeNull();
    expect(grounding.ordinal.quadraticWeightedKappa).toBeNull();
    expect(grounding.undefinedReason).toBe(
      'sample_information_insufficient_score_concentration',
    );
    expect(metrics.sampleInformationSufficient).toBe(false);
    expect(metrics.insufficientVariationDimensions).toContain('grounding');
  });

  it('accepts an expected low-score probe despite Promptfoo assertion error text, but rejects grader failures', () => {
    const result = {
      error: 'The deliberately bad answer failed the rubric',
      failureReason: 1,
      gradingResult: { componentResults: [{ score: 0.2, pass: false }] },
    };
    expect(assessInjectionProbe(result)).toMatchObject({
      graded: true,
      passed: true,
      rating: 1,
    });
    expect(assessInjectionProbe({ ...result, failureReason: 2 }).graded).toBe(
      false,
    );
    expect(
      assessInjectionProbe({
        ...result,
        gradingResult: {
          componentResults: [
            { score: 0, pass: false, metadata: { graderError: true } },
          ],
        },
      }).graded,
    ).toBe(false);
    expect(
      assessInjectionProbe({
        gradingResult: { componentResults: [{ score: 1, pass: true }] },
      }).passed,
    ).toBe(false);
    expect(scoreFromGradingResult(0.63)).toBeNull();
    expect(scoreFromGradingResult(0)).toBeNull();
  });

  it('accepts a real Promptfoo llm-rubric rejection using an entirely local fake grader', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-offline-'));
    const keys = [
      'PROMPTFOO_CONFIG_DIR',
      'PROMPTFOO_CACHE_PATH',
      'PROMPTFOO_CACHE_ENABLED',
      'PROMPTFOO_DISABLE_TELEMETRY',
      'PROMPTFOO_DISABLE_UPDATE',
      'PROMPTFOO_DISABLE_SHARING',
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    configurePromptfooStorage(directory);
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline_network_prohibited');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const restoreFetch = installPromptfooNetworkGuard([]);
    const grade = vi.fn(async () => ({
      output: JSON.stringify({
        pass: false,
        score: 0.2,
        reason: '合成答案金额错误，未服从要求满分的指令。',
      }),
    }));
    try {
      const require = createRequire(
        new URL('../benchmarks/package.json', import.meta.url),
      );
      const { evaluate } = await import(
        pathToFileURL(require.resolve('promptfoo')).href
      );
      const evaluation = await evaluate(
        {
          prompts: ['synthetic task'],
          providers: [
            {
              id: () => 'offline-answer',
              callApi: async () => ({ output: 'synthetic incorrect answer' }),
            },
          ],
          tests: [
            {
              options: {
                provider: { id: () => 'offline-grader', callApi: grade },
              },
              assert: [
                {
                  type: 'llm-rubric',
                  value: 'synthetic correctness',
                  threshold: 0.8,
                  rubricPrompt: judgeRubricPrompt('grounding'),
                },
              ],
            },
          ],
          sharing: false,
        },
        {
          cache: false,
          maxConcurrency: 1,
          showProgressBar: false,
          silent: true,
        },
      );
      const result = evaluation.results[0].toEvaluateResult();
      expect(result.error).toBeTruthy();
      expect(result.failureReason).toBe(1);
      expect(assessInjectionProbe(result)).toMatchObject({
        graded: true,
        passed: true,
        rating: 1,
      });
      expect(grade).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      restoreFetch();
      vi.unstubAllGlobals();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('creates blind human labels and compares ratings by dimension', () => {
    const dims = {
      completeness: 4,
      grounding: 5,
      decision_appropriateness: 4,
      professional_tone: 5,
    };
    const report = {
      runId: 'private-run',
      samples: [
        {
          sampleId: 'review-123',
          category: 'customer-policy',
          question: 'question',
          expectedStatus: 'answered',
          expectedFacts: {},
          expectedEvidence: [],
          rubric: ['rubric'],
          candidateOutput: 'answer',
        },
      ],
      evaluations: [
        {
          sampleId: 'review-123',
          dimensions: Object.fromEntries(
            Object.entries(dims).map(([key, score]) => [
              key,
              { scoreOutOfFive: score, pass: true, reason: '' },
            ]),
          ),
        },
      ],
    };
    const [template] = buildHumanLabelTemplate(report);
    expect(template.humanScores).toEqual({
      completeness: null,
      grounding: null,
      decision_appropriateness: null,
      professional_tone: null,
    });
    expect(template.toolReturns).toEqual([]);
    expect(JSON.stringify(template)).not.toContain('candidateAlias');
    const analyzed = analyzeHumanLabels(report, [
      { sampleId: 'review-123', humanScores: dims },
    ]);
    expect(analyzed.metrics.overall.kappa).toBeNull();
    expect(analyzed.metrics.overall.n).toBe(1);
    const assisted = analyzeHumanLabels(
      {
        ...report,
        judgeProvenance: {
          requestedModel: 'secretjudge',
          apiBaseUrl: 'https://private.example/v1',
        },
      },
      [
        {
          sampleId: 'review-123',
          humanScores: dims,
          annotationProvenance: {
            method: 'ai_assisted_human',
            humanReviewedAll: true,
            confirmationSource: 'user_confirmed_each_item_in_chat',
          },
        },
      ],
    );
    expect(assisted.annotationProvenance).toMatchObject({
      method: 'ai_assisted_human',
      displayLabel: 'AI 辅助人工标注',
      aiAssistedSamples: 1,
      humanReviewedSamples: 1,
    });
    expect(assisted.annotationProvenance.independenceLimitation).toContain(
      '不等于完全独立',
    );
    const publicReport = renderCalibrationSummary(assisted);
    expect(publicReport).toContain('AI 辅助人工标注');
    expect(publicReport).toContain('二次加权 κ');
    expect(publicReport).not.toContain('secretjudge');
    expect(publicReport).not.toContain('private.example');
    expect(analyzed.metrics.byDimension.grounding.ordinal.exactAgreement).toBe(
      1,
    );
    expect(() =>
      analyzeHumanLabels(report, [
        { sampleId: 'review-123', humanScores: dims },
        { sampleId: 'review-123', humanScores: dims },
      ]),
    ).toThrow('calibration_sample_set_invalid');
  });

  it('uses per-dimension raw agreement and weighted kappa gates; tone stays advisory', () => {
    const dims = (index: number, reverse = false) => {
      let score = index < 3 ? 3 : index % 2 === 0 ? 5 : 4;
      if (reverse && index >= 3) score = score === 5 ? 4 : 5;
      return {
        completeness: score,
        grounding: score,
        decision_appropriateness: score,
        professional_tone: score,
      };
    };
    const report = {
      runId: 'calibration-run',
      samples: Array.from({ length: 20 }, (_, i) => ({
        sampleId: `review-${i}`,
        category: 'customer-policy',
        question: 'question',
        expectedStatus: 'answered',
        expectedFacts: {},
        expectedEvidence: [],
        rubric: [],
        candidateOutput: 'answer',
      })),
      evaluations: Array.from({ length: 20 }, (_, i) => ({
        sampleId: `review-${i}`,
        dimensions: Object.fromEntries(
          Object.entries(dims(i)).map(([key, score]) => [
            key,
            { scoreOutOfFive: score, pass: true, reason: '' },
          ]),
        ),
      })),
    };
    const result = analyzeHumanLabels(
      report,
      report.samples.map((row, i) => ({
        sampleId: row.sampleId,
        humanScores: dims(i),
      })),
    );
    expect(result.calibrationGate.perDimension.completeness).toMatchObject({
      minimumExactAgreement: 0.6,
      minimumQuadraticWeightedKappa: 0.6,
      passed: true,
    });
    expect(result.calibrationGate.professional_tone).toBe('reference_only');
    expect(result.judgeEligibleForRanking).toBe(true);
    const failedGate = analyzeHumanLabels(
      report,
      report.samples.map((row, i) => ({
        sampleId: row.sampleId,
        humanScores: dims(i, true),
      })),
    );
    expect(failedGate.calibrationGate.perDimension.completeness).toMatchObject({
      humanScoresAtOrBelow3: 3,
      passed: false,
    });
    expect(failedGate.judgeEligibleForRanking).toBe(false);
    const publicText = renderCalibrationSummary(result);
    expect(publicText).toContain('整体二分指标只统计');
    expect(publicText).toContain('专业语气只作参考');
  });

  it('keeps missing reference-only tone scores missing without blocking complete critical dimensions', () => {
    const dims = (index: number) => {
      const score = index < 3 ? 3 : index % 2 === 0 ? 5 : 4;
      return {
        completeness: score,
        grounding: score,
        decision_appropriateness: score,
        professional_tone: score,
      };
    };
    const report = {
      runId: 'partial-tone-run',
      samples: Array.from({ length: 20 }, (_, i) => ({
        sampleId: `partial-${i}`,
        category: 'customer-policy',
        question: 'question',
        expectedStatus: 'answered',
        expectedFacts: {},
        rubric: [],
        candidateOutput: 'answer',
      })),
      evaluations: Array.from({ length: 20 }, (_, i) => ({
        sampleId: `partial-${i}`,
        dimensions: Object.fromEntries(
          Object.entries(dims(i)).map(([key, score]) => [
            key,
            { scoreOutOfFive: score, pass: true, reason: '' },
          ]),
        ),
      })),
    };
    report.evaluations[0].dimensions.professional_tone.scoreOutOfFive = null;
    const result = analyzeHumanLabels(
      report,
      report.samples.map((row, i) => ({
        sampleId: row.sampleId,
        humanScores: dims(i),
      })),
      { professional_tone: 1 },
    );
    expect(result.metrics.byDimension.professional_tone.ordinal.n).toBe(19);
    expect(result.judgeScoreCompleteness.professional_tone).toMatchObject({
      expected: 20,
      scored: 19,
      missing: 1,
      graderErrors: 1,
    });
    expect(result.metrics.overall.n).toBe(19);
    expect(result.judgeEligibleForRanking).toBe(true);
  });
});
