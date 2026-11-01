import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import {
  diagnoseAttribution,
  diagnoseChecks,
  applyAdjudication,
  summarizeAttributions,
  summarizeRegradeTransitions,
  type AttributionEvidence,
  type HumanAdjudication,
} from '../benchmarks/lib/failure-attribution.js';
import {
  safeArtifactPath,
  readReviewArtifact,
  verifyCitation,
  readAdjudications,
  writeImmutableReview,
} from '../benchmarks/lib/failure-review-artifacts.js';

const healthy: AttributionEvidence = {
  sourceComplete: true,
  independentAssessmentAvailable: true,
  runIntegrityVerified: true,
  caseMatches: true,
  referencePass: true,
  fixtureReplayMatches: true,
  measurementValid: true,
  checksMatch: true,
  recordedMeasurementMatches: true,
  fixtureDiscoverabilityFailure: false,
};

test('offline regrading reports verdict transitions without claiming causal corrections or model faults', () => {
  expect(
    summarizeRegradeTransitions([
      { oldBusinessPass: false, newBusinessPass: true },
      { oldBusinessPass: false, newBusinessPass: false },
      { oldBusinessPass: true, newBusinessPass: false },
      { oldBusinessPass: true, newBusinessPass: true },
      { oldBusinessPass: false, newBusinessPass: null },
    ]),
  ).toEqual({
    changedToPassing: 1,
    changedToFailing: 1,
    stillFailing: 1,
    currentBusinessFailures: 2,
    notEvaluable: 1,
    causalAttribution: 'unresolved',
  });
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function artifacts() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-attribution-'));
  roots.push(root);
  const relative = 'promptfoo-0001/trace.json';
  fs.mkdirSync(path.join(root, 'promptfoo-0001'));
  fs.writeFileSync(
    path.join(root, relative),
    JSON.stringify({
      output: 'synthetic output',
      tools: [],
      nullable: null,
      'a/b': { '~key': false },
    }),
  );
  const digest = () =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(root, relative)))
      .digest('hex');
  return {
    root,
    relative,
    citation: { artifact: relative, sha256: digest(), pointer: '/output' },
  };
}
const subject = {
  executionIndex: 1,
  candidate: 'candidate-private',
  caseId: 'cp-01',
};
const human: HumanAdjudication = {
  ...subject,
  category: 'agent_error',
  reviewer: 'human-reviewer',
  rationale:
    'Compared the observed amount against the returned order and policy.',
  evidence: [
    {
      artifact: 'promptfoo-0001/trace.json',
      sha256: 'a'.repeat(64),
      pointer: '/output',
    },
  ],
};

test('passing evaluator self-tests cannot prove an Agent root cause', () => {
  expect(diagnoseAttribution(healthy)).toMatchObject({
    category: 'unresolved',
    status: 'needs_review',
    findings: [],
    agentAttributionAllowed: true,
  });
  expect(
    applyAdjudication(diagnoseAttribution(healthy), ['facts'], undefined)
      .category,
  ).toBe('unresolved');
});

test('retains simultaneous evidence problems and does not call a transport failure a fixture error', () => {
  const measurement = diagnoseAttribution({
    ...healthy,
    measurementValid: false,
  });
  expect(measurement.suspectedCategories).toEqual(['measurement_error']);
  const mixed = diagnoseAttribution({
    ...healthy,
    caseMatches: false,
    referencePass: false,
    fixtureReplayMatches: false,
    measurementValid: false,
  });
  expect(mixed.category).toBe('unresolved');
  expect(mixed.findings).toHaveLength(4);
  expect(mixed.suspectedCategories).toEqual([
    'case_or_assertion_error',
    'data_or_fixture_error',
    'measurement_error',
  ]);
});

test.each([
  ['sourceComplete', false],
  ['independentAssessmentAvailable', false],
  ['runIntegrityVerified', false],
  ['caseMatches', null],
  ['referencePass', null],
  ['fixtureReplayMatches', null],
  ['measurementValid', null],
  ['checksMatch', null],
  ['recordedMeasurementMatches', false],
  ['fixtureDiscoverabilityFailure', true],
  ['fixtureDiscoverabilityFailure', null],
] as const)('cannot confirm an Agent error with %s=%s', (key, value) => {
  const diagnosis = diagnoseAttribution({ ...healthy, [key]: value });
  expect(diagnosis.agentAttributionAllowed).toBe(false);
  expect(() => applyAdjudication(diagnosis, ['facts'], human)).toThrow(
    'failure_review_agent_attribution_blocked',
  );
});

test('observed layer ordering preserves secondary failures and independent safety checks', () => {
  const diagnostic = diagnoseChecks(
    {
      format: false,
      facts: true,
      status: false,
      injection: false,
      requiredTools: false,
      newFutureCheck: false,
    },
    { outputParsed: true, injectionApplicable: true },
  );
  expect(diagnostic.firstObservedFailureLayer).toBe('format');
  expect(diagnostic.failedChecks).toEqual([
    'format',
    'status',
    'injection',
    'requiredTools',
    'newFutureCheck',
  ]);
  expect(
    diagnostic.layers.find((item) => item.layer === 'safety')?.checks[0].state,
  ).toBe('failed');
  expect(
    diagnostic.layers.find((item) => item.layer === 'facts_evidence')?.checks[0]
      .state,
  ).toBe('passed');
  expect(
    diagnostic.layers.find((item) => item.layer === 'other')?.checks[0].name,
  ).toBe('newFutureCheck');
});

test('null checks are never failures; inapplicable and unevaluable remain distinct', () => {
  const diagnostic = diagnoseChecks(
    { format: false, facts: null, injection: null },
    { outputParsed: false, injectionApplicable: false },
  );
  expect(diagnostic.failedChecks).toEqual(['format']);
  expect(diagnostic.notEvaluableChecks).toEqual(['facts']);
  expect(
    diagnostic.layers.find((item) => item.layer === 'safety')?.checks[0].state,
  ).toBe('not_applicable');
});

test('human confirmation requires a real failed check, identity, rationale and citations', () => {
  const diagnosis = diagnoseAttribution(healthy);
  expect(applyAdjudication(diagnosis, ['facts'], human)).toMatchObject({
    category: 'agent_error',
    status: 'human_confirmed',
  });
  expect(() => applyAdjudication(diagnosis, [], human)).toThrow(
    'failure_review_agent_attribution_blocked',
  );
  for (const invalid of [
    { reviewer: '' },
    { rationale: '' },
    { evidence: [] },
    { category: 'arbitrary' },
  ]) {
    expect(() =>
      applyAdjudication(diagnosis, ['facts'], {
        ...human,
        ...invalid,
      } as HumanAdjudication),
    ).toThrow('failure_review_adjudication_invalid');
  }
});

test('a human can record uncertainty with evidence without confirming a root cause', () => {
  const attribution = applyAdjudication(
    diagnoseAttribution(healthy),
    ['facts'],
    {
      ...human,
      category: 'unresolved',
      rationale:
        'Evidence does not establish whether the rubric or answer is wrong.',
    },
  );
  expect(attribution).toMatchObject({
    category: 'unresolved',
    status: 'human_reviewed_unresolved',
  });
  const counts = summarizeAttributions([
    {
      attribution,
      diagnostics: diagnoseChecks(
        { facts: false },
        { outputParsed: true, injectionApplicable: false },
      ),
    },
  ]);
  expect(counts).toMatchObject({
    confirmedAttempts: 0,
    humanReviewedAttempts: 1,
    unresolvedAttempts: 1,
  });
});

test('category totals separate confirmed judgments from evidence-blocked unknowns', () => {
  const diagnostics = diagnoseChecks(
    { format: false, injection: true },
    { outputParsed: true, injectionApplicable: true },
  );
  const counts = summarizeAttributions([
    {
      diagnostics,
      attribution: applyAdjudication(
        diagnoseAttribution(healthy),
        ['format'],
        human,
      ),
    },
    {
      diagnostics,
      attribution: diagnoseAttribution({ ...healthy, measurementValid: false }),
    },
  ]);
  expect(counts).toMatchObject({
    confirmedAttempts: 1,
    unresolvedAttempts: 1,
    evidenceBlockedAttempts: 1,
    categories: { agent_error: 1, unresolved: 1 },
    firstObservedFailureLayers: { format: 2 },
  });
});

test('citations bind file bytes and JSON pointer, including JSONL and escaped keys', () => {
  const { root, citation } = artifacts();
  expect(() => verifyCitation(root, citation)).not.toThrow();
  expect(() =>
    verifyCitation(root, { ...citation, pointer: '/a~1b/~0key' }),
  ).not.toThrow();
  expect(() =>
    verifyCitation(root, { ...citation, pointer: '/nullable' }),
  ).not.toThrow();
  expect(() =>
    verifyCitation(root, { ...citation, pointer: '/absent' }),
  ).toThrow('citation_unverified');
  expect(() => verifyCitation(root, { ...citation, pointer: '/a~2b' })).toThrow(
    'citation_unverified',
  );
  const ledger = 'promptfoo-0001/fixture.jsonl';
  fs.writeFileSync(path.join(root, ledger), ' {"result":0}\n');
  const source = readReviewArtifact(root, ledger);
  expect(() =>
    verifyCitation(root, {
      artifact: ledger,
      sha256: source.sha256!,
      pointer: '/0/result',
    }),
  ).not.toThrow();
  fs.writeFileSync(path.join(root, citation.artifact), '{"output":"changed"}');
  expect(() => verifyCitation(root, citation)).toThrow('citation_unverified');
});

test.each([
  '../trace.json',
  '/tmp/trace.json',
  'a/../trace.json',
  'a\\trace.json',
  'cases/holdout/a.json',
  'a//b.json',
])('rejects escaping or holdout citation %s', (relative) => {
  const { root } = artifacts();
  expect(() => safeArtifactPath(root, relative)).toThrow(
    'artifact_path_invalid',
  );
});

test('rejects file and directory symlinks and preserves immutable artifacts', () => {
  const { root, relative } = artifacts();
  fs.symlinkSync(path.join(root, relative), path.join(root, 'alias.json'));
  expect(() => readReviewArtifact(root, 'alias.json')).toThrow(
    'artifact_symlink',
  );
  fs.symlinkSync(path.join(root, 'promptfoo-0001'), path.join(root, 'alias'));
  expect(() => readReviewArtifact(root, 'alias/trace.json')).toThrow(
    'artifact_symlink',
  );
  const file = path.join(root, 'report.json');
  writeImmutableReview(file, 'original\n');
  writeImmutableReview(file, 'original\n');
  expect(() => writeImmutableReview(file, 'overwritten\n')).toThrow(
    'immutable_conflict',
  );
  expect(fs.readFileSync(file, 'utf8')).toBe('original\n');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(() =>
    writeImmutableReview(path.join(root, 'alias.json'), '{}'),
  ).toThrow('immutable_conflict');
});

test('adjudications reject stale revisions, swapped subjects, duplicate rows and cross-attempt citations', () => {
  const { root, citation } = artifacts();
  const file = 'adjudications.json';
  const put = (reviews: unknown[], evidenceRevision = 'revision') =>
    fs.writeFileSync(
      path.join(root, file),
      JSON.stringify({ schemaVersion: 1, evidenceRevision, reviews }),
    );
  const decision = { ...human, evidence: [citation] };
  put([decision]);
  expect(
    readAdjudications(root, file, 'revision', [subject]).decisions.size,
  ).toBe(1);
  expect(() => readAdjudications(root, file, 'stale', [subject])).toThrow(
    'adjudications_stale',
  );
  put([{ ...decision, candidate: 'another' }]);
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'subject_mismatch',
  );
  put([decision, decision]);
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'subject_mismatch',
  );
  fs.mkdirSync(path.join(root, 'promptfoo-0002'));
  fs.copyFileSync(
    path.join(root, citation.artifact),
    path.join(root, 'promptfoo-0002/trace.json'),
  );
  put([
    {
      ...decision,
      evidence: [{ ...citation, artifact: 'promptfoo-0002/trace.json' }],
    },
  ]);
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'citation_subject_mismatch',
  );
  put([null]);
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'adjudication_invalid',
  );
});

test('Judge attribution requires a saved input object bound to this attempt', () => {
  const { root, citation } = artifacts();
  fs.mkdirSync(path.join(root, 'judge'));
  const judge = 'judge/samples.jsonl';
  fs.writeFileSync(
    path.join(root, judge),
    JSON.stringify({ ...subject, executionIndex: 2 }) + '\n',
  );
  const source = readReviewArtifact(root, judge);
  const decision = {
    ...human,
    category: 'judge_input_or_prompt_error',
    evidence: [{ artifact: judge, sha256: source.sha256, pointer: '/0' }],
  };
  const file = 'adjudications.json';
  const put = () =>
    fs.writeFileSync(
      path.join(root, file),
      JSON.stringify({
        schemaVersion: 1,
        evidenceRevision: 'revision',
        reviews: [decision],
      }),
    );
  put();
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'judge_evidence_required',
  );
  fs.writeFileSync(path.join(root, judge), JSON.stringify(subject) + '\n');
  decision.evidence[0].sha256 = readReviewArtifact(root, judge).sha256;
  put();
  expect(
    readAdjudications(root, file, 'revision', [subject]).decisions.size,
  ).toBe(1);
  decision.evidence = [citation];
  put();
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'judge_evidence_required',
  );
});

test('an unfilled human template is not treated as a confirmation', () => {
  const { root } = artifacts();
  const file = 'labels.json';
  const row = {
    ...subject,
    category: null,
    reviewer: '',
    rationale: '',
    evidence: [],
  };
  fs.writeFileSync(
    path.join(root, file),
    JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: 'revision',
      reviews: [row],
    }),
  );
  expect(
    readAdjudications(root, file, 'revision', [subject]).decisions.size,
  ).toBe(0);
  fs.writeFileSync(
    path.join(root, file),
    JSON.stringify({
      schemaVersion: 1,
      evidenceRevision: 'revision',
      reviews: [{ ...row, reviewer: 'someone' }],
    }),
  );
  expect(() => readAdjudications(root, file, 'revision', [subject])).toThrow(
    'adjudication_incomplete',
  );
});

test('a Rubric finding must cite the rubric of this case rather than a different case', () => {
  const { root } = artifacts();
  fs.writeFileSync(
    path.join(root, 'cases.used.json'),
    JSON.stringify([
      { id: 'other-case', rubric: ['other rule'] },
      { id: subject.caseId, rubric: ['this rule'] },
    ]),
  );
  const source = readReviewArtifact(root, 'cases.used.json');
  const decision = {
    ...human,
    category: 'rubric_error',
    evidence: [
      {
        artifact: 'cases.used.json',
        sha256: source.sha256,
        pointer: '/0/rubric',
      },
    ],
  };
  const put = () =>
    fs.writeFileSync(
      path.join(root, 'labels.json'),
      JSON.stringify({
        schemaVersion: 1,
        evidenceRevision: 'revision',
        reviews: [decision],
      }),
    );
  put();
  expect(() =>
    readAdjudications(root, 'labels.json', 'revision', [subject]),
  ).toThrow('citation_subject_mismatch');
  decision.evidence[0].pointer = '/1/rubric';
  put();
  expect(
    readAdjudications(root, 'labels.json', 'revision', [subject]).decisions
      .size,
  ).toBe(1);
  decision.evidence[0].pointer = '/1/id';
  put();
  expect(() =>
    readAdjudications(root, 'labels.json', 'revision', [subject]),
  ).toThrow('rubric_evidence_required');
});
