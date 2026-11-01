import { expect, test } from 'vitest';
import { assessAttempt } from '../benchmarks/lib/assessment.js';

const healthy = {
  transportFailure: null,
  usageComplete: true,
  scopeIsolated: true,
  sdkModelMatches: true,
  contextVerified: true,
  freshState: true,
  auditMatched: true,
  turnEvidenceMatched: true,
  onlyAllowedTools: true,
  businessPass: true,
  gateway: false,
};

test('unmatched turn evidence invalidates measurement without changing business assertions', () => {
  expect(
    assessAttempt({ ...healthy, turnEvidenceMatched: false }),
  ).toMatchObject({
    measurementFailure: 'turn_evidence_mismatch',
    measurementValid: false,
    qualityEligible: false,
    businessFailure: null,
  });
});

test('retains the established higher-priority measurement causes', () => {
  expect(
    assessAttempt({
      ...healthy,
      fixtureBypass: true,
      turnEvidenceMatched: false,
    }).measurementFailure,
  ).toBe('fixture_bypass');
  expect(
    assessAttempt({
      ...healthy,
      toolUnavailable: true,
      turnEvidenceMatched: false,
    }).measurementFailure,
  ).toBe('tool_unavailable');
  expect(
    assessAttempt({
      ...healthy,
      auditMatched: false,
      turnEvidenceMatched: false,
    }).measurementFailure,
  ).toBe('audit_mismatch');
});
