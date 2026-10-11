import type { Candidate, Failure } from './contracts.js';

export function assessAttempt(input: {
  transportFailure: Failure | null;
  usageComplete: boolean;
  scopeIsolated: boolean;
  sdkModelMatches: boolean;
  contextVerified: boolean;
  freshState: boolean;
  auditMatched: boolean;
  onlyAllowedTools: boolean;
  businessPass: boolean;
  gateway: boolean;
}) {
  const measurementFailure: Failure | null =
    input.transportFailure ||
    (!input.usageComplete || !input.scopeIsolated
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
    (businessFailure === 'tool_policy_violation' && businessFailure) ||
    measurementFailure ||
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
