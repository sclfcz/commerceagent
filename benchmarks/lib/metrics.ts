export interface MetricAttempt {
  candidate: string;
  caseId: string;
  repetition: number;
  measurementValid: boolean;
  qualityEligible: boolean;
  pass: boolean;
  businessPass: boolean | null;
  businessChecks?: Record<string, boolean>;
  elapsedMs?: number | null;
  logicalRunMs?: number | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    reasoningTokens: number;
  } | null;
}

const quantile = (values: number[], q: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(q * sorted.length) - 1] ?? sorted[0];
};

export function bootstrapPairedDifference(
  left: MetricAttempt[],
  right: MetricAttempt[],
  iterations = 10_000,
  seed = 0x51a7e,
) {
  if (!Number.isSafeInteger(iterations) || iterations < 1)
    throw new Error('invalid_bootstrap_iterations');
  const byCandidateCase = (rows: MetricAttempt[]) => {
    const grouped = new Map<string, MetricAttempt[]>();
    for (const row of rows.filter(
      (item) => item.measurementValid && item.qualityEligible,
    )) {
      const group = grouped.get(row.caseId) || [];
      group.push(row);
      grouped.set(row.caseId, group);
    }
    return grouped;
  };
  const leftCases = byCandidateCase(left);
  const rightCases = byCandidateCase(right);
  const caseIds = [...leftCases.keys()]
    .filter((id) => rightCases.has(id))
    .sort();
  if (!caseIds.length)
    return { pairedCases: 0, difference: null, lower95: null, upper95: null };
  const caseRate = (rows: MetricAttempt[]) =>
    rows.filter((row) => row.pass).length / rows.length;
  const differences = caseIds.map(
    (id) => caseRate(leftCases.get(id)!) - caseRate(rightCases.get(id)!),
  );
  const difference =
    differences.reduce((sum, value) => sum + value, 0) / differences.length;
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const samples = Array.from({ length: iterations }, () => {
    let total = 0;
    for (let index = 0; index < differences.length; index++)
      total += differences[Math.floor(random() * differences.length)];
    return total / differences.length;
  });
  return {
    pairedCases: caseIds.length,
    difference,
    lower95: quantile(samples, 0.025),
    upper95: quantile(samples, 0.975),
  };
}

export function summarizeMetrics(
  rows: MetricAttempt[],
  options: {
    expectedRepetitions?: number;
    bootstrapIterations?: number;
    runValid?: boolean;
    caseIds?: string[];
    candidateAliases?: string[];
  } = {},
) {
  const expectedRepetitions = options.expectedRepetitions ?? 3;
  const bootstrapIterations = options.bootstrapIterations ?? 10_000;
  const runValid = options.runValid ?? true;
  const aliases = [
    ...new Set([
      ...rows.map((row) => row.candidate),
      ...(options.candidateAliases ?? []),
    ]),
  ].sort();
  const allCaseIds = [
    ...new Set([...rows.map((row) => row.caseId), ...(options.caseIds ?? [])]),
  ].sort();
  const candidates = Object.fromEntries(
    aliases.map((alias) => {
      const attempts = rows.filter((row) => row.candidate === alias);
      const eligible = attempts.filter(
        (row) => row.measurementValid && row.qualityEligible,
      );
      const first = eligible.filter((row) => row.repetition === 1);
      const dimensions = {
        status_accuracy: ['status'],
        facts_evidence: ['facts', 'evidence', 'forbiddenConclusions'],
        instruction: ['format', 'injection', 'instructions'],
        tools: [
          'requiredTools',
          'forbiddenTools',
          'onlyAllowedTools',
          'successfulTools',
          'callLimit',
          'state',
        ],
      };
      const dimensionPassRates = Object.fromEntries(
        Object.entries(dimensions).map(([dimension, checks]) => {
          const applicable = eligible.filter((row) => row.businessChecks);
          const observedChecks = applicable.flatMap((row) =>
            checks
              .filter(
                (check) => typeof row.businessChecks?.[check] === 'boolean',
              )
              .map((check) => row.businessChecks?.[check] === true),
          );
          const opportunities = observedChecks.length;
          const passed = observedChecks.filter(Boolean).length;
          return [dimension, opportunities ? passed / opportunities : null];
        }),
      );
      dimensionPassRates.completion = eligible.length
        ? eligible.filter((row) => row.businessPass).length / eligible.length
        : null;
      const pass3 = allCaseIds.map((caseId) => {
        const repeated = attempts.filter((row) => row.caseId === caseId);
        if (
          repeated.length !== expectedRepetitions ||
          repeated.some((row) => !row.measurementValid || !row.qualityEligible)
        )
          return { caseId, status: 'undetermined' as const };
        return {
          caseId,
          status: repeated.every((row) => row.pass)
            ? ('passed' as const)
            : ('failed' as const),
        };
      });
      const invalidAttempts = attempts.length - eligible.length;
      const invalidRate = attempts.length
        ? invalidAttempts / attempts.length
        : null;
      const percentilePair = (field: 'elapsedMs' | 'logicalRunMs') => {
        const values = attempts
          .filter((row) => row.measurementValid)
          .map((row) => row[field])
          .filter(
            (value): value is number =>
              typeof value === 'number' && Number.isFinite(value),
          );
        return {
          p50: quantile(values, 0.5),
          p95: quantile(values, 0.95),
          coldStart: true,
        };
      };
      return [
        alias,
        {
          attempts: attempts.length,
          eligibleAttempts: eligible.length,
          ineligibleAttempts: invalidAttempts,
          ineligibleRate: invalidRate,
          rankEligible: runValid && eligible.length > 0 && invalidRate! <= 0.1,
          firstPassRate: first.length
            ? first.filter((row) => row.pass).length / first.length
            : null,
          averagePassRate: eligible.length
            ? eligible.filter((row) => row.pass).length / eligible.length
            : null,
          dimensionPassRates,
          pass3: {
            passed: pass3.filter((row) => row.status === 'passed').length,
            failed: pass3.filter((row) => row.status === 'failed').length,
            undetermined: pass3.filter((row) => row.status === 'undetermined')
              .length,
            cases: pass3,
          },
          latency: {
            elapsedMs: percentilePair('elapsedMs'),
            logicalRunMs: percentilePair('logicalRunMs'),
          },
        },
      ];
    }),
  );
  const comparisonAliases = aliases.filter(
    (alias) => candidates[alias].rankEligible,
  );
  const pairwise: Record<string, unknown> = {};
  const comparisonOmissions: Array<{
    left: string;
    right: string;
    reason: string;
  }> = [];
  for (let leftIndex = 0; leftIndex < comparisonAliases.length; leftIndex++) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < comparisonAliases.length;
      rightIndex++
    ) {
      const left = comparisonAliases[leftIndex];
      const right = comparisonAliases[rightIndex];
      const estimate = bootstrapPairedDifference(
        rows.filter((row) => row.candidate === left),
        rows.filter((row) => row.candidate === right),
        bootstrapIterations,
      );
      if (estimate.pairedCases === 0) {
        comparisonOmissions.push({
          left,
          right,
          reason: 'no_shared_eligible_cases',
        });
        continue;
      }
      pairwise[`${left}__vs__${right}`] = estimate;
    }
  }
  return {
    candidates,
    pairwise,
    excludedFromPairwise: aliases.filter(
      (alias) => !candidates[alias].rankEligible,
    ),
    comparisonOmissions,
  };
}
