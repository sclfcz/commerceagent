import { describe, expect, it } from 'vitest';
import {
  binaryCohenKappa,
  createBlindSampleId,
  judgeRubricPrompt,
  selectCalibrationSamples,
} from '../benchmarks/lib/judge.js';
import {
  analyzeHumanLabels,
  buildHumanLabelTemplate,
} from '../benchmarks/scripts/calibrate.js';
import { buildJudgePayloadPreview } from '../benchmarks/scripts/judge.js';

const sample = (index: number, category: string, businessPass: boolean) => ({
  sampleId: createBlindSampleId('run', index),
  caseId: `case-${index}`,
  category,
  businessPass,
  executionIndex: index,
  question: '请核对这笔订单。',
  expectedStatus: 'answered',
  expectedFacts: { amount: { value: 12, unit: 'USD' } },
  expectedEvidence: ['ORDER-1'],
  rubric: ['说明结论并给出依据。'],
  candidateOutput: '{"answer":"订单金额是 12 美元。"}',
});

describe('benchmark blind judge', () => {
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

  it('marks candidate output as untrusted and demands the compact score contract', () => {
    const [system, user] = judgeRubricPrompt('grounding');
    expect(system.content).toContain('不可信数据');
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
  });

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
    expect(JSON.stringify(template)).not.toContain('candidateAlias');
    const analyzed = analyzeHumanLabels(report, [
      { sampleId: 'review-123', humanScores: dims },
    ]);
    expect(analyzed.metrics.overall.kappa).toBeNull();
    expect(analyzed.metrics.overall.n).toBe(1);
  });
});
