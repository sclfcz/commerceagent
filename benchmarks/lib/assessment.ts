import type { Candidate, Failure } from './contracts.js';

export function assessAttempt(input: {
  transportFailure: Failure | null;
  usageComplete: boolean;
  scopeIsolated: boolean;
  sdkModelMatches: boolean;
  contextVerified: boolean;
  freshState: boolean;
  auditMatched: boolean;
  mcpRuntimeReady?: boolean;
  toolUnavailable?: boolean;
  fixtureBypass?: boolean;
  onlyAllowedTools: boolean;
  businessPass: boolean;
  gateway: boolean;
}) {
  const measurementFailure: Failure | null =
    input.transportFailure ||
    (input.fixtureBypass
      ? 'fixture_bypass'
      : input.toolUnavailable || input.mcpRuntimeReady === false
        ? 'tool_unavailable'
        : !input.usageComplete || !input.scopeIsolated
          ? 'collection_incomplete'
          : !input.freshState
            ? 'state_not_fresh'
            : !input.contextVerified
              ? 'context_mismatch'
              : !input.auditMatched
                ? 'audit_mismatch'
                : !input.sdkModelMatches
                  ? 'model_identity'
                  : null);
  const businessFailure: Failure | null = !input.onlyAllowedTools
    ? 'tool_policy_violation'
    : !input.businessPass
      ? 'business_assertion'
      : null;
  // A forbidden tool is observed behavior. Do not relabel it as lost telemetry;
  // retain any independent audit mismatch too, so that sample stays ineligible.
  const failure =
    input.transportFailure ||
    measurementFailure ||
    (businessFailure === 'tool_policy_violation' && businessFailure) ||
    (input.gateway ? 'model_identity' : businessFailure);
  return {
    measurementFailure,
    businessFailure,
    failure,
    measurementValid: measurementFailure === null,
    qualityEligible: measurementFailure === null && !input.gateway,
    pass: measurementFailure === null && !input.gateway && input.businessPass,
  };
}

export function rotateCandidates(
  candidates: Candidate[],
  caseIndex: number,
  repetition: number,
): Candidate[] {
  const offset = (caseIndex + repetition) % candidates.length;
  return [...candidates.slice(offset), ...candidates.slice(0, offset)];
}

export type CandidateAttemptEvidence = {
  candidate: string;
  measurementValid: boolean;
  businessPass: boolean;
  qualityEligible: boolean;
  sdkModelMatches: boolean;
  gatewayVerificationRequired: boolean;
  gates: { modelIdentity?: boolean };
};

// A smoke may contain both a verified official candidate and a pending gateway.
// Keep identity status candidate-scoped instead of reducing the matrix to `every()`.
export function summarizeCandidates(results: CandidateAttemptEvidence[]) {
  const aliases = [...new Set(results.map((row) => row.candidate))].sort();
  return Object.fromEntries(
    aliases.map((candidate) => {
      const rows = results.filter((row) => row.candidate === candidate);
      const gatewayVerificationRequired = rows.some(
        (row) => row.gatewayVerificationRequired,
      );
      const identityVerified =
        !gatewayVerificationRequired &&
        rows.every(
          (row) => row.measurementValid && row.gates.modelIdentity === true,
        );
      return [
        candidate,
        {
          attempts: rows.length,
          measurementValidAttempts: rows.filter((row) => row.measurementValid)
            .length,
          businessPassAttempts: rows.filter((row) => row.businessPass).length,
          qualityEligibleAttempts: rows.filter((row) => row.qualityEligible)
            .length,
          sdkModelMatches: rows.every((row) => row.sdkModelMatches),
          gatewayVerificationRequired,
          identityVerified,
          identityStatus: identityVerified
            ? 'verified'
            : gatewayVerificationRequired
              ? 'gateway_pending'
              : 'unverified',
        },
      ];
    }),
  );
}

export function countClassifications(
  results: Array<Record<string, unknown>>,
  field: 'failure' | 'measurementFailure' | 'businessFailure',
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const value = result[field];
    if (typeof value !== 'string') continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

export function measurementValidityGate(input: {
  split: string | null | undefined;
  caseCount: number;
  attempts: number;
  expectedAttempts: number;
  validAttempts: number;
}) {
  const applicable =
    input.split === 'dev' &&
    input.caseCount === 50 &&
    input.attempts === input.expectedAttempts &&
    input.expectedAttempts > 0;
  const rate = input.attempts > 0 ? input.validAttempts / input.attempts : null;
  const minimumRate = 0.95;
  return {
    applicable,
    minimumRate,
    rate,
    passed: applicable && rate !== null && rate >= minimumRate,
  };
}
