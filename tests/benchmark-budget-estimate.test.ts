import { describe, expect, it } from 'vitest';
import { estimateBenchmarkBudget } from '../benchmarks/lib/budget-estimate.js';
import { modelFingerprint } from '../benchmarks/lib/pricing.js';

describe('offline benchmark budget and time estimates', () => {
  const candidate = {
    alias: 'candidate-test',
    model: 'synthetic-model',
    baseUrl: 'https://provider.example.test/anthropic',
    billingRegion: 'test-region',
  };
  const prices = {
    'candidate-test': {
      currency: 'USD',
      model_fingerprint: modelFingerprint(candidate.model, candidate.baseUrl)!,
      billing_region: candidate.billingRegion,
      input: 1,
      output: 2,
      cache_read: 0.5,
      cache_write: 1.5,
      reasoning: 2,
    },
  };
  const referenceAttempts = [
    {
      candidate: candidate.alias,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        reasoningTokens: 10,
      },
      elapsedMs: 1000,
      logicalRunMs: 700,
    },
    {
      candidate: candidate.alias,
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 50,
        reasoningTokens: 10,
      },
      elapsedMs: 2000,
      logicalRunMs: 1500,
    },
  ];

  it('computes screening, confirmation and holdout attempts and serial estimates', () => {
    const screening = estimateBenchmarkBudget({
      mode: 'screening',
      caseCount: 50,
      candidateCount: 1,
      referenceCandidates: [candidate],
      referenceAttempts,
      prices,
    });
    expect(screening).toMatchObject({
      profileCount: 3,
      repetitions: 1,
      serialAttempts: 150,
      referenceCurrency: 'USD',
      elapsedSerialP50Ms: 150_000,
      costStatus: 'estimated',
    });
    expect(screening.estimatedCost).toBeCloseTo(0.001375 * 150);

    const confirmation = estimateBenchmarkBudget({
      mode: 'confirmation',
      caseCount: 50,
      candidateCount: 1,
      referenceCandidates: [candidate],
      referenceAttempts,
      prices,
    });
    expect(confirmation).toMatchObject({
      profileCount: 2,
      repetitions: 3,
      serialAttempts: 300,
      elapsedSerialP50Ms: 300_000,
    });

    const holdout = estimateBenchmarkBudget({
      mode: 'holdout',
      caseCount: 18,
      candidateCount: 2,
      referenceCandidates: [candidate],
      referenceAttempts,
      prices,
    });
    expect(holdout.serialAttempts).toBe(72);
  });

  it('keeps cost unknown when source attempts or rate fingerprints are incomplete', () => {
    const result = estimateBenchmarkBudget({
      mode: 'formal',
      caseCount: 50,
      candidateCount: 1,
      referenceCandidates: [candidate],
      referenceAttempts: [
        ...referenceAttempts,
        { candidate: candidate.alias, usage: null, elapsedMs: 3000 },
      ],
      prices,
    });
    expect(result.costStatus).toBe('unknown');
    expect(result.estimatedCost).toBeNull();
  });
});
