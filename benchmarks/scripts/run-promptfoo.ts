import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  buildTests,
  validateExecutionOrder,
} from '../promptfoo/build-tests.js';
import {
  configurePromptfooStorage,
  installPromptfooNetworkGuard,
} from '../promptfoo/runtime.js';
import { preflight } from './spike.js';
import { parseCandidates, privateJson } from '../lib/contracts.js';
import {
  countHoldoutRuns,
  loadBusinessCases,
  parseBenchmarkSplit,
  recordHoldoutRun,
  type BusinessCase,
  type CaseSplit,
} from '../lib/cases.js';
import { reassessPromptfoo } from '../lib/reassess-promptfoo.js';
import { aggregatePromptfooCosts, modelFingerprint } from '../lib/pricing.js';
import { selfTestReferences } from '../lib/reference-answers.js';
import { hash } from '../lib/contracts.js';
import { loadProfileVariant } from '../lib/profile-variants.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

export function validateProfileRunMatrix(
  split: CaseSplit,
  profileVariantIds: string[],
  finalRun: boolean,
) {
  const jointHoldout = profileVariantIds.length === 2;
  if (
    !profileVariantIds.length ||
    new Set(profileVariantIds).size !== profileVariantIds.length ||
    (split === 'holdout' &&
      (!finalRun ||
        !jointHoldout ||
        !profileVariantIds.includes('baseline'))) ||
    (split === 'dev' && jointHoldout)
  )
    throw new Error('profile_matrix_invalid_for_split');
  return { jointHoldout };
}

export async function main() {
  const split: CaseSplit = parseBenchmarkSplit(process.argv.slice(2));
  const profileVariantIndex = process.argv.indexOf('--profile-variant');
  const profileVariantsIndex = process.argv.indexOf('--profile-variants');
  if (profileVariantIndex >= 0 && profileVariantsIndex >= 0)
    throw new Error('profile_variant_flags_conflict');
  const profileVariantIds =
    profileVariantsIndex >= 0
      ? (process.argv[profileVariantsIndex + 1] || '').split(',')
      : [
          profileVariantIndex >= 0
            ? process.argv[profileVariantIndex + 1]
            : 'baseline',
        ];
  if (
    !profileVariantIds.length ||
    profileVariantIds.some((id) => !id) ||
    new Set(profileVariantIds).size !== profileVariantIds.length
  )
    throw new Error('profile_variant_required');
  const profileVariants = profileVariantIds.map((id) =>
    loadProfileVariant(id, benchmarkDirectory),
  );
  const profileVariant = profileVariants[0];
  const { jointHoldout } = validateProfileRunMatrix(
    split,
    profileVariantIds,
    process.argv.includes('--final-run'),
  );
  if (profileVariantsIndex >= 0 && !jointHoldout)
    throw new Error('profile_variants_requires_joint_holdout');
  const runId = `promptfoo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDirectory = path.join(benchmarkDirectory, 'results', runId);
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const candidateIndex = process.argv.indexOf('--candidate');
  const selectedAlias =
    candidateIndex >= 0 ? process.argv[candidateIndex + 1] : undefined;
  if (
    candidateIndex >= 0 &&
    (!selectedAlias || !/^candidate-[a-z0-9]+$/.test(selectedAlias))
  )
    throw new Error('invalid_candidate_selection');
  const primaryCandidateIndex = process.argv.indexOf('--primary-candidate');
  const requestedPrimaryCandidate =
    primaryCandidateIndex >= 0
      ? process.argv[primaryCandidateIndex + 1]
      : undefined;
  if (
    primaryCandidateIndex >= 0 &&
    (!requestedPrimaryCandidate ||
      !/^candidate-[a-z0-9]+$/.test(requestedPrimaryCandidate))
  )
    throw new Error('invalid_primary_candidate');
  const checks = await preflight(runDirectory, selectedAlias);
  const ready =
    checks.docker &&
    checks.imagePresent &&
    checks.configured &&
    checks.credentials &&
    checks.timeoutValid &&
    checks.candidates.length > 0;
  privateJson(path.join(runDirectory, 'preflight.json'), {
    ready,
    docker: checks.docker,
    imagePresent: checks.imagePresent,
    imageHash: checks.imageHash,
    candidateConfigured: checks.configured,
    credentialsPresent: checks.credentials,
    timeoutValid: checks.timeoutValid,
    runtimeSourceHash: checks.runtimeSourceHash,
  });
  if (!ready) {
    process.stdout.write(JSON.stringify({ stage: 'preflight', ready }) + '\n');
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--preflight')) {
    process.stdout.write(
      JSON.stringify({
        stage: 'preflight',
        ready,
        candidates: checks.candidates.length,
      }) + '\n',
    );
    return;
  }

  const candidates = parseCandidates(checks.candidates);
  const primaryCandidateAlias =
    requestedPrimaryCandidate ?? selectedAlias ?? null;
  const primaryCandidate = candidates.find(
    (candidate) => candidate.alias === primaryCandidateAlias,
  );
  if (
    (jointHoldout && !primaryCandidate) ||
    (profileVariants.length === 1 &&
      profileVariant.id !== 'baseline' &&
      (!selectedAlias || !primaryCandidate))
  )
    throw new Error('selection_anchor_candidate_required');
  for (const variant of profileVariants) {
    fs.writeFileSync(
      path.join(runDirectory, `profile.${variant.id}.used.yaml`),
      variant.profileYaml,
      { mode: 0o600, flag: 'wx' },
    );
    privateJson(path.join(runDirectory, `profile.${variant.id}.variant.json`), {
      id: variant.id,
      description: variant.description,
      profileHash: variant.profileHash,
      definitionHash: variant.definitionHash,
      sourceHashes: variant.sourceHashes,
    });
  }
  if (profileVariants.length === 1) {
    fs.copyFileSync(
      path.join(runDirectory, `profile.${profileVariant.id}.used.yaml`),
      path.join(runDirectory, 'profile.used.yaml'),
      fs.constants.COPYFILE_EXCL,
    );
    fs.copyFileSync(
      path.join(runDirectory, `profile.${profileVariant.id}.variant.json`),
      path.join(runDirectory, 'profile.variant.json'),
      fs.constants.COPYFILE_EXCL,
    );
  }
  const holdoutLedger = path.join(
    benchmarkDirectory,
    'results/holdout-runs.jsonl',
  );
  if (split === 'holdout') {
    if (
      process.argv.includes('--smoke') ||
      process.argv.includes('--case-limit') ||
      process.argv.includes('--candidate') ||
      (!jointHoldout && process.argv.includes('--profile-variants')) ||
      (process.argv.includes('--repetitions') &&
        Number(process.argv[process.argv.indexOf('--repetitions') + 1]) !== 1)
    )
      throw new Error('holdout_requires_full_final_matrix');
    if (countHoldoutRuns(holdoutLedger) > 0)
      throw new Error('holdout_already_used');
  }
  const allCases: BusinessCase[] = loadBusinessCases(split, benchmarkDirectory);
  const smoke = process.argv.includes('--smoke');
  const caseLimitIndex = process.argv.indexOf('--case-limit');
  const caseLimit =
    caseLimitIndex >= 0 ? Number(process.argv[caseLimitIndex + 1]) : null;
  if (
    caseLimit !== null &&
    (!Number.isSafeInteger(caseLimit) ||
      caseLimit < 1 ||
      caseLimit > allCases.length)
  )
    throw new Error('invalid_case_limit');
  const cases = smoke
    ? allCases.slice(0, candidates.length > 1 ? 2 : 1)
    : caseLimit === null
      ? allCases
      : allCases.slice(0, caseLimit);
  const repetitionsIndex = process.argv.indexOf('--repetitions');
  const requestedRepetitions =
    repetitionsIndex >= 0 ? Number(process.argv[repetitionsIndex + 1]) : 3;
  if (!Number.isSafeInteger(requestedRepetitions) || requestedRepetitions < 1)
    throw new Error('invalid_repetitions');
  const repetitions =
    split === 'holdout' ? 1 : smoke ? 1 : requestedRepetitions;
  const tests = buildTests(
    cases,
    candidates,
    repetitions,
    profileVariants.map(({ id }) => id),
  );
  privateJson(path.join(runDirectory, 'cases.used.json'), cases);
  const caseSelfTest = await selfTestReferences(cases);
  privateJson(path.join(runDirectory, 'case-selftest.json'), {
    ...caseSelfTest,
    realModelCalls: 0,
    caseHashes: Object.fromEntries(cases.map((test) => [test.id, hash(test)])),
    assertionCodeHash: hash(
      [
        'lib/cases.ts',
        'lib/date-range.ts',
        'lib/reference-answers.ts',
        'mcp-fixture-server/server.ts',
      ].map((file) =>
        fs.readFileSync(path.join(benchmarkDirectory, file), 'utf8'),
      ),
    ),
  });
  const cumulativeHoldoutRuns =
    split === 'holdout'
      ? recordHoldoutRun(holdoutLedger, runId, true)
      : countHoldoutRuns(holdoutLedger);
  privateJson(path.join(runDirectory, 'run-metadata.json'), {
    split,
    finalRun: process.argv.includes('--final-run'),
    repetitions,
    cumulativeHoldoutRuns,
    stage: smoke ? 'smoke' : 'benchmark',
    scope: 'synthetic-commerce-workflows',
    profileVariant: jointHoldout ? null : profileVariant.id,
    profileVariants: profileVariants.map(({ id }) => id),
    profileHashes: Object.fromEntries(
      profileVariants.map(({ id, profileHash }) => [id, profileHash]),
    ),
    profileDefinitionHashes: Object.fromEntries(
      profileVariants.map(({ id, definitionHash }) => [id, definitionHash]),
    ),
    selectionProtocol: {
      primaryCandidateAlias,
      primaryCandidateFingerprint: primaryCandidate
        ? modelFingerprint(primaryCandidate.model, primaryCandidate.baseUrl)
        : null,
      primaryCandidateBillingRegion: primaryCandidate?.billingRegion ?? null,
      primaryProfileContrast: primaryCandidate
        ? 'evidence-audit_vs_baseline'
        : null,
      modelPairwiseCorrection: 'holm_step_down',
    },
  });
  const promptfooDirectory = path.join(runDirectory, 'promptfoo');
  configurePromptfooStorage(promptfooDirectory);
  installPromptfooNetworkGuard([], true);
  process.env.BENCH_RUN_DIRECTORY = runDirectory;
  process.env.BENCH_PINNED_IMAGE = checks.imageHash!;
  process.env.BENCH_RUNTIME_SOURCE_HASH = checks.runtimeSourceHash!;
  process.env.BENCH_PROFILE_VARIANT = profileVariant.id;
  process.env.BENCH_TIMEOUT_MS = String(
    Number(process.env.BENCH_TIMEOUT_MS || 180000),
  );

  const config = parse(
    fs.readFileSync(
      path.join(benchmarkDirectory, 'promptfoo/promptfooconfig.yaml'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const suite = {
    ...config,
    providers: [
      `file://${path.join(benchmarkDirectory, 'promptfoo/provider.ts')}`,
    ],
    tests,
  };
  privateJson(path.join(promptfooDirectory, 'resolved-config.json'), suite);

  try {
    const { evaluate } = await import('promptfoo');
    const evaluation = await evaluate(suite as never, {
      maxConcurrency: 1,
      cache: false,
      showProgressBar: false,
      silent: true,
    });
    const promptfooResults = evaluation.results.map((row) =>
      row.toEvaluateResult(),
    );
    const pricing = parse(
      fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
    );
    const costByCandidate = aggregatePromptfooCosts(pricing, promptfooResults);
    privateJson(
      path.join(promptfooDirectory, 'results.json'),
      promptfooResults,
    );
    const expected = tests.map((row, index) => ({
      ...row.metadata,
      executionIndex: index + 1,
    }));
    const actual = fs
      .readFileSync(path.join(runDirectory, 'execution-sequence.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((row) => ({
        caseId: row.caseId,
        repetition: row.repetition,
        candidateAlias: row.candidateAlias,
        profileVariant: row.profileVariant,
        executionIndex: row.executionIndex,
      }));
    const order = validateExecutionOrder(expected, actual);
    privateJson(path.join(runDirectory, 'execution-order.json'), {
      ...order,
      expectedAttempts: expected.length,
      actualAttempts: actual.length,
      expected,
      actual,
    });
    const independent = reassessPromptfoo(runDirectory);
    const report = {
      ...independent,
      caseSelfTest,
      schemaVersion: 1,
      stage: smoke ? 'smoke' : 'benchmark',
      split,
      profileVariant: jointHoldout ? null : profileVariant.id,
      profileVariants: profileVariants.map(({ id }) => id),
      finalRun: process.argv.includes('--final-run'),
      repetitions,
      cumulativeHoldoutRuns,
      scope: 'synthetic-commerce-workflows',
      promptfooResultPath: 'promptfoo/results.json',
      costByCandidate,
      promptfooReportedPasses: promptfooResults.filter(
        (result: Record<string, any>) => result.success === true,
      ).length,
      promptfooCostColumnAuthoritative: false,
    };
    privateJson(path.join(runDirectory, 'summary.json'), report);
    process.stdout.write(
      JSON.stringify({
        schemaVersion: report.schemaVersion,
        stage: report.stage,
        split: report.split,
        profileVariant: report.profileVariant,
        finalRun: report.finalRun,
        repetitions: report.repetitions,
        cumulativeHoldoutRuns: report.cumulativeHoldoutRuns,
        scope: report.scope,
        attempts: report.attempts,
        evidenceComplete: report.evidenceComplete,
        executionOrderValid: report.executionOrderValid,
        providerParityValid: report.providerParityValid,
        measurementValidityGate: report.measurementValidityGate,
        measurementValidAttempts: report.measurementValidAttempts,
        businessPassedAttempts: report.businessPassedAttempts,
        failureCounts: report.failureCounts,
        measurementFailureCounts: report.measurementFailureCounts,
        successfulFixtureCalls: report.successfulFixtureCalls,
        businessFailureCounts: report.businessFailureCounts,
        identityByCandidate: report.identityByCandidate,
        costByCandidate: report.costByCandidate,
        promptfooReportedPasses: report.promptfooReportedPasses,
        promptfooCostColumnAuthoritative:
          report.promptfooCostColumnAuthoritative,
        invalidRun: report.invalidRun,
      }) + '\n',
    );
    if (
      !order.valid ||
      independent.invalidRun ||
      independent.attempts !== tests.length ||
      (independent.measurementValidityGate.applicable &&
        !independent.measurementValidityGate.passed)
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Promptfoo benchmark failed; private diagnostics retained\n',
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      'Promptfoo benchmark failed; private diagnostics retained\n',
    );
    process.exitCode = 1;
  });
