import type { BlindSample } from './judge.js';

export interface ValidationReadinessInput {
  requestedSamples: number;
  maximumSyntheticFraction: number;
  minimumContentFailureFraction: number;
  minimumNaturalContentFailures: number;
  freshEligibleCases: number;
  freshNaturalContentFailures: number;
}

export function assessJudgeValidationReadiness(
  input: ValidationReadinessInput,
) {
  const fractionValid =
    Number.isFinite(input.maximumSyntheticFraction) &&
    input.maximumSyntheticFraction >= 0 &&
    input.maximumSyntheticFraction <= 1 &&
    Number.isFinite(input.minimumContentFailureFraction) &&
    input.minimumContentFailureFraction >= 0 &&
    input.minimumContentFailureFraction <= 1;
  if (
    !Number.isSafeInteger(input.requestedSamples) ||
    input.requestedSamples < 1 ||
    !Number.isSafeInteger(input.minimumNaturalContentFailures) ||
    input.minimumNaturalContentFailures < 0 ||
    !Number.isSafeInteger(input.freshEligibleCases) ||
    input.freshEligibleCases < 0 ||
    !Number.isSafeInteger(input.freshNaturalContentFailures) ||
    input.freshNaturalContentFailures < 0 ||
    input.freshNaturalContentFailures > input.freshEligibleCases ||
    !fractionValid
  )
    throw new Error('judge_validation_readiness_input_invalid');

  const requiredContentFailures = Math.ceil(
    input.requestedSamples * input.minimumContentFailureFraction,
  );
  const maximumSyntheticSamples = Math.floor(
    input.requestedSamples * input.maximumSyntheticFraction,
  );
  const naturalContentFailuresRequired = Math.max(
    input.minimumNaturalContentFailures,
    1,
  );
  const syntheticSamplesNeeded = Math.max(
    0,
    requiredContentFailures - input.freshNaturalContentFailures,
  );
  const naturalSamplesRequired =
    input.requestedSamples - syntheticSamplesNeeded;
  // Every sample must originate from a distinct unseen dev case. A synthetic
  // mutation replaces its source case in the validation set; it does not add a
  // second row for the same case.
  const freshCasesRequired = input.requestedSamples;
  const reasons: string[] = [];
  if (input.freshNaturalContentFailures < naturalContentFailuresRequired)
    reasons.push('too_few_natural_content_failures');
  if (syntheticSamplesNeeded > maximumSyntheticSamples)
    reasons.push('synthetic_sample_cap_exceeded');
  if (input.freshEligibleCases < freshCasesRequired)
    reasons.push('too_few_fresh_eligible_cases');

  return {
    ready: reasons.length === 0,
    requestedSamples: input.requestedSamples,
    freshEligibleCases: input.freshEligibleCases,
    freshNaturalContentFailures: input.freshNaturalContentFailures,
    requiredContentFailures,
    maximumSyntheticSamples,
    syntheticSamplesNeeded,
    naturalSamplesRequired,
    freshCasesRequired,
    naturalContentFailuresRequired,
    reasons,
  };
}

export function countSubstantiveBusinessFailures(
  checks: Record<string, unknown> | null | undefined,
) {
  const substantiveChecks = [
    'status',
    'facts',
    'evidence',
    'forbiddenConclusions',
    'injection',
    'instructions',
    'requiredTools',
    'forbiddenTools',
    'onlyAllowedTools',
    'successfulTools',
    'callLimit',
    'state',
  ];
  return substantiveChecks.filter((name) => checks?.[name] === false).length;
}
export function selectFreshUniqueCases(
  samples: BlindSample[],
  previouslyUsedCaseIds: Set<string>,
) {
  const byCase = new Map<string, BlindSample>();
  for (const sample of samples) {
    if (previouslyUsedCaseIds.has(sample.caseId)) continue;
    const current = byCase.get(sample.caseId);
    if (
      !current ||
      sample.executionIndex < current.executionIndex ||
      (sample.executionIndex === current.executionIndex &&
        sample.sampleId < current.sampleId)
    )
      byCase.set(sample.caseId, sample);
  }
  return [...byCase.values()].sort(
    (left, right) => left.executionIndex - right.executionIndex,
  );
}
