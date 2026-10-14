import { calculateCost, type CandidatePrice } from './pricing.js';

export type EstimateMode = 'screening' | 'confirmation' | 'formal' | 'holdout';

export interface BudgetReferenceCandidate {
  alias: string;
  model: string;
  baseUrl: string;
  billingRegion?: string;
}

export interface BudgetReferenceAttempt {
  candidate: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
  } | null;
  elapsedMs?: number | null;
  logicalRunMs?: number | null;
}

const quantile = (values: number[], percentile: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? sorted[0];
};

export function estimateBenchmarkBudget(input: {
  mode: EstimateMode;
  caseCount: number;
  candidateCount: number;
  profileCount?: number;
  repetitions?: number;
  referenceCandidates: BudgetReferenceCandidate[];
  referenceAttempts: BudgetReferenceAttempt[];
  prices: Record<string, Partial<CandidatePrice>>;
}) {
  const defaults: Record<
    EstimateMode,
    { profiles: number; repetitions: number }
  > = {
    screening: { profiles: 3, repetitions: 1 },
    confirmation: { profiles: 2, repetitions: 3 },
    formal: { profiles: 1, repetitions: 3 },
    holdout: { profiles: 2, repetitions: 1 },
  };
  const profileCount = input.profileCount ?? defaults[input.mode].profiles;
  const repetitions = input.repetitions ?? defaults[input.mode].repetitions;
  for (const value of [
    input.caseCount,
    input.candidateCount,
    profileCount,
    repetitions,
  ])
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('budget_estimate_dimensions_invalid');

  const candidateByAlias = new Map(
    input.referenceCandidates.map((candidate) => [candidate.alias, candidate]),
  );
  const referenceCosts = input.referenceAttempts.map((attempt) => {
    const candidate = candidateByAlias.get(attempt.candidate);
    const price = input.prices[attempt.candidate];
    return {
      candidate,
      cost: calculateCost(attempt.usage ?? null, price, candidate),
      currency: price?.currency ?? null,
    };
  });
  const currencies = [
    ...new Set(referenceCosts.map((entry) => entry.currency).filter(Boolean)),
  ];
  const costsKnown =
    referenceCosts.length > 0 &&
    referenceCosts.every(
      (entry) => entry.cost !== null && entry.currency !== null,
    ) &&
    currencies.length === 1;
  const meanCostPerAttempt = costsKnown
    ? referenceCosts.reduce((sum, entry) => sum + entry.cost!, 0) /
      referenceCosts.length
    : null;
  const elapsedValues = input.referenceAttempts
    .map((attempt) => attempt.elapsedMs)
    .filter(
      (value): value is number => typeof value === 'number' && value >= 0,
    );
  const logicalValues = input.referenceAttempts
    .map((attempt) => attempt.logicalRunMs)
    .filter(
      (value): value is number => typeof value === 'number' && value >= 0,
    );
  const attempts =
    input.caseCount * input.candidateCount * profileCount * repetitions;
  const elapsedP50 = quantile(elapsedValues, 0.5);
  const elapsedP95 = quantile(elapsedValues, 0.95);
  const logicalP50 = quantile(logicalValues, 0.5);
  const logicalP95 = quantile(logicalValues, 0.95);
  return {
    mode: input.mode,
    caseCount: input.caseCount,
    candidateCount: input.candidateCount,
    profileCount,
    repetitions,
    serialAttempts: attempts,
    referenceAttempts: input.referenceAttempts.length,
    referenceCurrency: currencies.length === 1 ? currencies[0] : null,
    meanCostPerAttempt,
    estimatedCost:
      meanCostPerAttempt === null ? null : meanCostPerAttempt * attempts,
    costStatus: meanCostPerAttempt === null ? 'unknown' : 'estimated',
    coldStart: true,
    elapsedP50PerAttemptMs: elapsedP50,
    elapsedP95PerAttemptMs: elapsedP95,
    elapsedSerialP50Ms: elapsedP50 === null ? null : elapsedP50 * attempts,
    elapsedSerialP95ProxyMs: elapsedP95 === null ? null : elapsedP95 * attempts,
    logicalP50PerAttemptMs: logicalP50,
    logicalP95PerAttemptMs: logicalP95,
    limitation:
      'Linear extrapolation from the supplied synthetic-workflow reference run; prompt variants and models may change token use and latency.',
  };
}
