/** Observed failures are symptoms; passing evaluator self-tests is not causal proof. */
export const FAILURE_CATEGORIES = [
  'measurement_error',
  'data_or_fixture_error',
  'case_or_assertion_error',
  'judge_input_or_prompt_error',
  'rubric_error',
  'agent_error',
  'unresolved',
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export interface AttributionEvidence {
  sourceComplete: boolean;
  independentAssessmentAvailable: boolean;
  runIntegrityVerified: boolean;
  caseMatches: boolean | null;
  referencePass: boolean | null;
  fixtureReplayMatches: boolean | null;
  measurementValid: boolean | null;
  checksMatch: boolean | null;
  recordedMeasurementMatches: boolean | null;
  fixtureDiscoverabilityFailure: boolean | null;
}

export interface AttributionFinding {
  code: string;
  suspectedCategory: FailureCategory;
}

export function diagnoseAttribution(evidence: AttributionEvidence) {
  const findings: AttributionFinding[] = [];
  const add = (code: string, suspectedCategory: FailureCategory) =>
    findings.push({ code, suspectedCategory });
  if (!evidence.sourceComplete) add('source_evidence_incomplete', 'unresolved');
  if (!evidence.independentAssessmentAvailable)
    add('independent_assessment_unavailable', 'measurement_error');
  if (!evidence.runIntegrityVerified)
    add('run_integrity_unverified', 'unresolved');
  if (evidence.recordedMeasurementMatches !== true)
    add('saved_and_recomputed_measurement_differ', 'measurement_error');
  if (evidence.caseMatches !== true)
    add('case_or_fixture_contract_unverified', 'case_or_assertion_error');
  if (evidence.referencePass !== true)
    add('reference_answer_unverified', 'case_or_assertion_error');
  if (evidence.checksMatch !== true)
    add('saved_and_recomputed_checks_differ', 'case_or_assertion_error');
  if (evidence.fixtureReplayMatches !== true)
    add('fixture_replay_unverified', 'data_or_fixture_error');
  if (evidence.fixtureDiscoverabilityFailure !== false)
    add('fixture_query_contract_changed', 'data_or_fixture_error');
  if (evidence.measurementValid !== true)
    add('measurement_invalid_or_unknown', 'measurement_error');
  return {
    category: 'unresolved' as FailureCategory,
    status: findings.length
      ? ('evidence_blocked' as const)
      : ('needs_review' as const),
    findings,
    suspectedCategories: [
      ...new Set(findings.map((item) => item.suspectedCategory)),
    ],
    agentAttributionAllowed: findings.length === 0,
  };
}

const CHECK_LAYERS: Record<string, string> = {
  format: 'format',
  requiredTools: 'tools',
  forbiddenTools: 'tools',
  onlyAllowedTools: 'tools',
  successfulTools: 'tools',
  callLimit: 'tools',
  state: 'final_state',
  facts: 'facts_evidence',
  evidence: 'facts_evidence',
  forbiddenConclusions: 'facts_evidence',
  status: 'decision',
  instructions: 'instruction',
  injection: 'safety',
};
export const DIAGNOSTIC_LAYER_ORDER = [
  'format',
  'tools',
  'final_state',
  'facts_evidence',
  'decision',
  'instruction',
  'safety',
  'other',
] as const;

export function diagnoseChecks(
  checks: Record<string, unknown>,
  input: { outputParsed: boolean; injectionApplicable: boolean },
) {
  const results = Object.entries(checks).map(([name, value]) => ({
    name,
    layer: CHECK_LAYERS[name] ?? 'other',
    state:
      value === true
        ? ('passed' as const)
        : value === false
          ? ('failed' as const)
          : name === 'injection' && value === null && !input.injectionApplicable
            ? ('not_applicable' as const)
            : ('not_evaluable' as const),
    reason:
      value === true || value === false
        ? null
        : name === 'injection' && value === null && !input.injectionApplicable
          ? 'non_injection_case'
          : !input.outputParsed
            ? 'output_unparseable'
            : 'check_has_no_boolean_verdict',
  }));
  const layers = DIAGNOSTIC_LAYER_ORDER.map((layer) => ({
    layer,
    checks: results.filter((result) => result.layer === layer),
  })).filter((item) => item.checks.length);
  return {
    // This is a display ordering of symptoms, never a root-cause conclusion.
    firstObservedFailureLayer:
      layers.find((item) =>
        item.checks.some((check) => check.state === 'failed'),
      )?.layer ?? null,
    failedChecks: results
      .filter((item) => item.state === 'failed')
      .map((item) => item.name),
    notEvaluableChecks: results
      .filter((item) => item.state === 'not_evaluable')
      .map((item) => item.name),
    layers,
  };
}

export interface EvidenceCitation {
  artifact: string;
  sha256: string;
  pointer: string;
}
export interface HumanAdjudication {
  executionIndex: number;
  candidate: string;
  caseId: string;
  category: FailureCategory;
  reviewer: string;
  rationale: string;
  evidence: EvidenceCitation[];
}

export function applyAdjudication(
  diagnosis: ReturnType<typeof diagnoseAttribution>,
  failedChecks: string[],
  adjudication: HumanAdjudication | undefined,
) {
  if (!adjudication) return { ...diagnosis, adjudication: null };
  if (
    !FAILURE_CATEGORIES.includes(adjudication.category) ||
    typeof adjudication.reviewer !== 'string' ||
    !adjudication.reviewer.trim() ||
    typeof adjudication.rationale !== 'string' ||
    !adjudication.rationale.trim() ||
    !Array.isArray(adjudication.evidence) ||
    !adjudication.evidence.length
  )
    throw new Error('failure_review_adjudication_invalid');
  if (
    adjudication.category === 'agent_error' &&
    (!diagnosis.agentAttributionAllowed || failedChecks.length === 0)
  )
    throw new Error('failure_review_agent_attribution_blocked');
  return {
    ...diagnosis,
    category: adjudication.category,
    status:
      adjudication.category === 'unresolved'
        ? ('human_reviewed_unresolved' as const)
        : ('human_confirmed' as const),
    adjudication,
  };
}

export function summarizeAttributions(
  rows: Array<{
    attribution: { category: FailureCategory; status: string };
    diagnostics: ReturnType<typeof diagnoseChecks>;
  }>,
) {
  return {
    categories: Object.fromEntries(
      FAILURE_CATEGORIES.map((category) => [
        category,
        rows.filter((row) => row.attribution.category === category).length,
      ]),
    ),
    confirmedAttempts: rows.filter(
      (row) => row.attribution.status === 'human_confirmed',
    ).length,
    humanReviewedAttempts: rows.filter((row) =>
      ['human_confirmed', 'human_reviewed_unresolved'].includes(
        row.attribution.status,
      ),
    ).length,
    unresolvedAttempts: rows.filter(
      (row) => row.attribution.category === 'unresolved',
    ).length,
    evidenceBlockedAttempts: rows.filter(
      (row) => row.attribution.status === 'evidence_blocked',
    ).length,
    firstObservedFailureLayers: Object.fromEntries(
      DIAGNOSTIC_LAYER_ORDER.map((layer) => [
        layer,
        rows.filter(
          (row) => row.diagnostics.firstObservedFailureLayer === layer,
        ).length,
      ]),
    ),
  };
}

/** A changed verdict describes evaluator behavior, not a proven root cause. */
export function summarizeRegradeTransitions(
  rows: Array<{ oldBusinessPass: unknown; newBusinessPass: unknown }>,
) {
  return {
    changedToPassing: rows.filter(
      (row) => row.oldBusinessPass === false && row.newBusinessPass === true,
    ).length,
    changedToFailing: rows.filter(
      (row) => row.oldBusinessPass === true && row.newBusinessPass === false,
    ).length,
    stillFailing: rows.filter(
      (row) => row.oldBusinessPass === false && row.newBusinessPass === false,
    ).length,
    currentBusinessFailures: rows.filter((row) => row.newBusinessPass === false)
      .length,
    notEvaluable: rows.filter((row) => typeof row.newBusinessPass !== 'boolean')
      .length,
    causalAttribution: 'unresolved' as const,
  };
}
