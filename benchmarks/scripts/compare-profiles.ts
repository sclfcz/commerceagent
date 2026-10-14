import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootstrapPairedDifference } from '../lib/metrics.js';
import { hash, parseCandidates, privateJson } from '../lib/contracts.js';
import { modelFingerprint } from '../lib/pricing.js';
import { reassessPromptfoo } from '../lib/reassess-promptfoo.js';
import { validatePublicSummary } from '../lib/public-report.js';
import { countHoldoutRuns } from '../lib/cases.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

function resolveRun(value: string) {
  const absolute = path.resolve(repository, value);
  const results = path.join(benchmarkDirectory, 'results');
  const resolved = fs.existsSync(absolute)
    ? absolute
    : path.join(results, value);
  if (!resolved.startsWith(results + path.sep))
    throw new Error('profile_comparison_path_invalid');
  return resolved;
}

export function compareJointHoldoutData(
  report: Record<string, any>,
  candidateAliases: string[],
  winner: string,
  iterations = 10_000,
  primaryCandidate: string | null = null,
) {
  const variants = report.profileVariants;
  if (
    report.split !== 'holdout' ||
    report.finalRun !== true ||
    report.cumulativeHoldoutRuns !== 1 ||
    report.invalidRun !== false ||
    winner === 'baseline' ||
    !Array.isArray(variants) ||
    variants.length !== 2 ||
    !variants.includes('baseline') ||
    !variants.includes(winner)
  )
    throw new Error('joint_holdout_run_invalid');
  for (const alias of candidateAliases) {
    const candidateRows = report.results.filter(
      (row: Record<string, any>) => row.candidate === alias,
    );
    const baselineRows = candidateRows.filter(
      (row: Record<string, any>) => row.profileVariant === 'baseline',
    );
    const winnerRows = candidateRows.filter(
      (row: Record<string, any>) => row.profileVariant === winner,
    );
    const caseIds = (rows: Array<Record<string, any>>) =>
      rows.map((row) => row.caseId).sort();
    if (
      !baselineRows.length ||
      baselineRows.some((row: Record<string, any>) => row.repetition !== 1) ||
      winnerRows.some((row: Record<string, any>) => row.repetition !== 1) ||
      JSON.stringify(caseIds(baselineRows)) !==
        JSON.stringify(caseIds(winnerRows)) ||
      new Set(caseIds(baselineRows)).size !== baselineRows.length
    )
      throw new Error('joint_holdout_matrix_incomplete');
  }
  const candidateResults = Object.fromEntries(
    candidateAliases.map((alias) => {
      const candidateIdentity = report.identityByCandidate?.[alias];
      const baseline = report.results.filter(
        (row: Record<string, any>) =>
          row.candidate === alias && row.profileVariant === 'baseline',
      );
      const variant = report.results.filter(
        (row: Record<string, any>) =>
          row.candidate === alias && row.profileVariant === winner,
      );
      const allRows = [...baseline, ...variant];
      const ineligibleRate = allRows.length
        ? allRows.filter((row) => !row.qualityEligible).length / allRows.length
        : 1;
      const policyViolations = allRows.filter(
        (row) => row.businessFailure === 'tool_policy_violation',
      ).length;
      const eligible =
        candidateIdentity?.identityStatus === 'verified' &&
        ineligibleRate <= 0.1 &&
        policyViolations === 0;
      const estimate = eligible
        ? bootstrapPairedDifference(variant, baseline, iterations)
        : { pairedCases: 0, difference: null, lower95: null, upper95: null };
      return [
        alias,
        {
          ...estimate,
          eligible,
          ineligibleRate,
          policyViolations,
          exclusionReason: eligible
            ? null
            : candidateIdentity?.identityStatus !== 'verified'
              ? 'identity_not_verified'
              : policyViolations
                ? 'tool_policy_violation'
                : 'ineligible_rate_over_10_percent',
        },
      ];
    }),
  );
  return {
    split: 'holdout',
    conclusionType: '一次性留出集确认',
    baselineProfile: 'baseline',
    winnerProfile: winner,
    primaryComparisonCandidate: primaryCandidate,
    candidateResults,
    bootstrapIterations: iterations,
    multipleComparisonCorrection: 'single_predeclared_primary_contrast',
    interpretation:
      'Holdout is a one-time confirmation. It cannot be used to select a different winner; intervals containing zero mean no observed significant difference.',
  };
}

export function compareProfileRunData(
  left: Record<string, any>,
  right: Record<string, any>,
  candidateAliases: string[],
  iterations = 10_000,
  mode: 'screening' | 'formal' = 'formal',
  primaryCandidate = candidateAliases[0],
) {
  if (
    left.split !== 'dev' ||
    right.split !== 'dev' ||
    left.invalidRun !== false ||
    right.invalidRun !== false ||
    left.profileVariant === right.profileVariant ||
    right.profileVariant !== 'baseline' ||
    left.profileVariant === 'baseline' ||
    left.sourceHashes?.caseDefinition !== right.sourceHashes?.caseDefinition ||
    left.sourceHashes?.fixtureDefinitions !==
      right.sourceHashes?.fixtureDefinitions
  )
    throw new Error('profile_comparison_runs_not_paired_dev');
  const caseIds = (report: Record<string, any>) =>
    [
      ...new Set(report.results.map((row: Record<string, any>) => row.caseId)),
    ].sort();
  if (JSON.stringify(caseIds(left)) !== JSON.stringify(caseIds(right)))
    throw new Error('profile_comparison_case_sets_differ');

  const candidates = Object.fromEntries(
    candidateAliases.map((alias) => {
      const leftRows = left.results.filter(
        (row: Record<string, any>) => row.candidate === alias,
      );
      const rightRows = right.results.filter(
        (row: Record<string, any>) => row.candidate === alias,
      );
      const eligibleRun = (
        report: Record<string, any>,
        rows: Array<Record<string, any>>,
      ) => {
        const identityVerified =
          report.identityByCandidate?.[alias]?.identityStatus === 'verified';
        const ineligibleRate = rows.length
          ? rows.filter((row) => !row.qualityEligible).length / rows.length
          : 1;
        const policyViolations = rows.filter(
          (row) => row.businessFailure === 'tool_policy_violation',
        ).length;
        const eligible =
          identityVerified && ineligibleRate <= 0.1 && policyViolations === 0;
        return {
          eligible,
          identityVerified,
          ineligibleRate,
          policyViolations,
        };
      };
      const leftEligibility = eligibleRun(left, leftRows);
      const rightEligibility = eligibleRun(right, rightRows);
      const eligible = leftEligibility.eligible && rightEligibility.eligible;
      return [
        alias,
        {
          ...(eligible
            ? bootstrapPairedDifference(leftRows, rightRows, iterations)
            : {
                pairedCases: 0,
                difference: null,
                lower95: null,
                upper95: null,
              }),
          eligible,
          exclusionReason: eligible
            ? null
            : !leftEligibility.identityVerified ||
                !rightEligibility.identityVerified
              ? 'identity_not_verified'
              : leftEligibility.policyViolations ||
                  rightEligibility.policyViolations
                ? 'tool_policy_violation'
                : 'ineligible_rate_over_10_percent',
          leftEligibility,
          rightEligibility,
        },
      ];
    }),
  );
  if (!candidates[primaryCandidate])
    throw new Error('primary_candidate_not_in_comparison');
  const primary = candidates[primaryCandidate];
  return {
    leftProfile: left.profileVariant,
    rightProfile: right.profileVariant,
    conclusionType: mode === 'screening' ? '筛选结论' : '正式比较结论',
    selectionEligible: mode === 'formal',
    primaryCandidate,
    primarySelection:
      mode === 'screening'
        ? '筛选后需进入三次重复确认'
        : !primary.eligible
          ? '不可选：主要候选未满足身份/测量约束'
          : primary.pairedCases === 0 || primary.lower95 === null
            ? '不可判定：没有配对合格样本'
            : primary.lower95 !== null && primary.lower95 > 0
              ? left.profileVariant
              : right.profileVariant,
    candidateResults: candidates,
    bootstrapIterations: iterations,
    multipleComparisonCorrection: 'single_predeclared_primary_candidate',
    interpretation:
      'Only the predeclared primary candidate is confirmatory; all other candidate contrasts are descriptive. If the 95% interval includes zero, report no observed significant difference.',
  };
}

export function compareProfiles(args = process.argv.slice(2)) {
  if (args.includes('--holdout')) return compareHoldout(args);
  const screening = args.includes('--screening');
  const primaryCandidateIndex = args.indexOf('--primary-candidate');
  const primaryCandidate =
    primaryCandidateIndex >= 0 ? args[primaryCandidateIndex + 1] : undefined;
  if (!primaryCandidate) throw new Error('primary_candidate_required');
  const positional = args.filter(
    (arg, index) =>
      !arg.startsWith('--') && args[index - 1] !== '--primary-candidate',
  );
  const [leftArg, rightArg] = positional;
  if (!leftArg || !rightArg)
    throw new Error('usage: bench:compare-profiles <left-run> <right-run>');
  const leftDirectory = resolveRun(leftArg);
  const rightDirectory = resolveRun(rightArg);
  const left = reassessPromptfoo(leftDirectory);
  const right = reassessPromptfoo(rightDirectory);
  if (!screening && left.profileVariant !== 'evidence-audit')
    throw new Error('formal_profile_contrast_not_predeclared');
  const leftMetadata = JSON.parse(
    fs.readFileSync(path.join(leftDirectory, 'run-metadata.json'), 'utf8'),
  );
  const rightMetadata = JSON.parse(
    fs.readFileSync(path.join(rightDirectory, 'run-metadata.json'), 'utf8'),
  );
  if (
    leftMetadata.selectionProtocol?.primaryCandidateAlias !==
      primaryCandidate ||
    rightMetadata.selectionProtocol?.primaryCandidateAlias !==
      primaryCandidate ||
    leftMetadata.selectionProtocol?.primaryCandidateFingerprint !==
      rightMetadata.selectionProtocol?.primaryCandidateFingerprint
  )
    throw new Error('profile_primary_candidate_manifest_mismatch');
  const expectedRepetitions = screening ? 1 : 3;
  if (
    leftMetadata.repetitions !== rightMetadata.repetitions ||
    leftMetadata.repetitions !== expectedRepetitions
  )
    throw new Error(
      screening
        ? 'screening_comparison_requires_one_dev_repetition'
        : 'profile_comparison_requires_three_dev_repetitions',
    );
  const leftCandidates = parseCandidates(
    JSON.parse(
      fs.readFileSync(path.join(leftDirectory, 'candidates.json'), 'utf8'),
    ),
  );
  const rightCandidates = parseCandidates(
    JSON.parse(
      fs.readFileSync(path.join(rightDirectory, 'candidates.json'), 'utf8'),
    ),
  );
  const leftByAlias = new Map(
    leftCandidates.map((candidate) => [candidate.alias, candidate]),
  );
  const rightByAlias = new Map(
    rightCandidates.map((candidate) => [candidate.alias, candidate]),
  );
  const aliases = [...leftByAlias.keys()].sort();
  if (
    JSON.stringify(aliases) !==
      JSON.stringify([...rightByAlias.keys()].sort()) ||
    aliases.some((alias) => {
      const a = leftByAlias.get(alias)!;
      const b = rightByAlias.get(alias)!;
      return (
        a.model !== b.model ||
        a.baseUrl !== b.baseUrl ||
        modelFingerprint(a.model, a.baseUrl) !==
          modelFingerprint(b.model, b.baseUrl) ||
        a.billingRegion !== b.billingRegion ||
        a.gateway !== b.gateway
      );
    })
  )
    throw new Error('profile_comparison_candidate_matrices_differ');
  const comparison = compareProfileRunData(
    left,
    right,
    aliases,
    10_000,
    screening ? 'screening' : 'formal',
    primaryCandidate,
  );
  const id = `profile-comparison-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = path.join(benchmarkDirectory, 'results', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const publicAlias = (alias: string) =>
    `candidate-${crypto
      .createHash('sha256')
      .update(`${id}|${alias}`)
      .digest('hex')
      .slice(0, 10)}`;
  const markdown = [
    `# Profile variant comparison — ${comparison.conclusionType}`,
    '',
    `Split: dev; repetitions: ${expectedRepetitions}; profiles: ${comparison.leftProfile} vs ${comparison.rightProfile}.`,
    `Primary candidate: ${publicAlias(primaryCandidate)}; primary selection result: ${comparison.primarySelection}. Other candidates are descriptive only and do not create additional confirmatory tests.`,
    screening
      ? '筛选结论仅用于选择后续三次重复确认的变体，不构成正式比较或排名依据。'
      : '这是正式三次重复比较；只有预先指定的主要比较可用于选型。',
    'Difference is variant minus baseline. Intervals use paired case bootstrap (10,000 resamples). The single predeclared primary-candidate comparison is confirmatory; other candidate rows are descriptive. Intervals containing zero mean no observed significant difference.',
    '',
    '| Candidate | Difference | 95% interval | Paired cases | Interpretation |',
    '|---|---:|---:|---:|---|',
    ...aliases.map((alias) => {
      const estimate = comparison.candidateResults[alias];
      const difference =
        estimate.difference === null
          ? 'unknown'
          : `${(estimate.difference * 100).toFixed(1)} pp`;
      const interval =
        estimate.lower95 === null || estimate.upper95 === null
          ? 'unknown'
          : `[${(estimate.lower95 * 100).toFixed(1)}, ${(estimate.upper95 * 100).toFixed(1)}] pp`;
      return `| ${publicAlias(alias)} | ${difference} | ${interval} | ${estimate.pairedCases} | ${estimate.lower95 === null || estimate.upper95 === null || (estimate.lower95 <= 0 && estimate.upper95 >= 0) ? 'no observed significant difference' : 'interval excludes zero'} |`;
    }),
    '',
    'Judge scores were not used. Candidates with unverified identity, over 10% ineligible attempts, or any tool-policy violation are excluded.',
    '',
  ].join('\n');
  const privateCandidates = leftCandidates.map((candidate) => ({
    alias: candidate.alias,
    model: candidate.model,
    baseUrl: candidate.baseUrl,
  }));
  if (!validatePublicSummary(markdown, privateCandidates).valid)
    throw new Error('profile_comparison_public_leak');
  const output = {
    ...comparison,
    leftRunId: path.basename(leftDirectory),
    rightRunId: path.basename(rightDirectory),
    leftSummaryHash: hash(left),
    rightSummaryHash: hash(right),
    publicLeakCheckPassed: true,
  };
  privateJson(path.join(directory, 'comparison.private.json'), output);
  fs.writeFileSync(path.join(directory, 'comparison.public.md'), markdown, {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      profileComparisonId: id,
      profiles: [comparison.leftProfile, comparison.rightProfile],
      pairedCandidates: aliases.length,
      candidatePairsWithEligibleCases: Object.values(
        comparison.candidateResults,
      ).filter((result) => result.pairedCases > 0).length,
      publicLeakCheckPassed: true,
      publicReport: path.relative(
        directory,
        path.join(directory, 'comparison.public.md'),
      ),
    }) + '\n',
  );
  return output;
}

function compareHoldout(args: string[]) {
  const runIndex = args.indexOf('--holdout');
  const winnerIndex = args.indexOf('--winner');
  const primaryCandidateIndex = args.indexOf('--primary-candidate');
  const runArg = runIndex >= 0 ? args[runIndex + 1] : undefined;
  const winner = winnerIndex >= 0 ? args[winnerIndex + 1] : undefined;
  const primaryCandidate =
    primaryCandidateIndex >= 0 ? args[primaryCandidateIndex + 1] : undefined;
  if (!runArg || !winner || !primaryCandidate)
    throw new Error(
      'usage: bench:compare-profiles --holdout <run-id> --winner <profile-id> --primary-candidate <alias>',
    );
  const runDirectory = resolveRun(runArg);
  const report = reassessPromptfoo(runDirectory);
  const holdoutLedger = path.join(
    benchmarkDirectory,
    'results/holdout-runs.jsonl',
  );
  if (
    countHoldoutRuns(holdoutLedger) !== 1 ||
    !fs
      .readFileSync(holdoutLedger, 'utf8')
      .split('\n')
      .filter(Boolean)
      .some((line) => JSON.parse(line).runId === path.basename(runDirectory))
  )
    throw new Error('holdout_ledger_mismatch');
  const candidates = parseCandidates(
    JSON.parse(
      fs.readFileSync(path.join(runDirectory, 'candidates.json'), 'utf8'),
    ),
  );
  const metadata = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'run-metadata.json'), 'utf8'),
  );
  const aliases = candidates.map((candidate) => candidate.alias).sort();
  if (!aliases.includes(primaryCandidate))
    throw new Error('primary_candidate_not_in_holdout');
  if (
    report.identityByCandidate?.[primaryCandidate]?.identityStatus !==
    'verified'
  )
    throw new Error('primary_candidate_identity_unverified');
  const manifestCandidate = candidates.find(
    (candidate) => candidate.alias === primaryCandidate,
  )!;
  if (
    metadata.selectionProtocol?.primaryCandidateAlias !== primaryCandidate ||
    metadata.selectionProtocol?.primaryCandidateFingerprint !==
      modelFingerprint(manifestCandidate.model, manifestCandidate.baseUrl)
  )
    throw new Error('holdout_primary_candidate_manifest_mismatch');
  const comparison = compareJointHoldoutData(
    report,
    aliases,
    winner,
    10_000,
    primaryCandidate,
  );
  const id = `holdout-confirmation-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const directory = path.join(benchmarkDirectory, 'results', id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const publicAlias = (alias: string) =>
    `candidate-${crypto
      .createHash('sha256')
      .update(`${id}|${alias}`)
      .digest('hex')
      .slice(0, 10)}`;
  const markdown = [
    '# One-time holdout confirmation',
    '',
    `Run: ${path.basename(runDirectory)}; profile: ${winner} vs baseline; candidates: ${aliases.length}; holdout launches: 1.`,
    `Primary candidate: ${publicAlias(primaryCandidate)}. Other candidates are descriptive only; this preserves one predeclared primary profile comparison.`,
    'This is a one-time confirmation and cannot be used to select a different profile. The interval is paired by case and uses 10,000 bootstrap resamples. Only identity-verified candidates contribute.',
    '',
    '| Candidate | Winner minus baseline | 95% interval | Paired cases |',
    '|---|---:|---:|---:|',
    ...aliases.map((alias) => {
      const estimate = comparison.candidateResults[alias];
      const difference =
        estimate.difference === null
          ? 'unknown'
          : `${(estimate.difference * 100).toFixed(1)} pp`;
      const interval =
        estimate.lower95 === null || estimate.upper95 === null
          ? 'unknown'
          : `[${(estimate.lower95 * 100).toFixed(1)}, ${(estimate.upper95 * 100).toFixed(1)}] pp`;
      return `| ${publicAlias(alias)} | ${difference} | ${interval} | ${estimate.pairedCases} |`;
    }),
    '',
  ].join('\n');
  if (!validatePublicSummary(markdown, candidates).valid)
    throw new Error('holdout_confirmation_public_leak');
  privateJson(path.join(directory, 'comparison.private.json'), {
    ...comparison,
    runId: path.basename(runDirectory),
    runSummaryHash: hash(report),
    publicLeakCheckPassed: true,
  });
  fs.writeFileSync(path.join(directory, 'comparison.public.md'), markdown, {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({
      holdoutConfirmationId: id,
      pairedCandidates: aliases.length,
      candidatesWithPairedCases: Object.values(
        comparison.candidateResults,
      ).filter((result) => result.pairedCases > 0).length,
      publicLeakCheckPassed: true,
    }) + '\n',
  );
  return comparison;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    compareProfiles();
  } catch (error) {
    const message =
      error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
        ? error.message
        : 'profile_comparison_failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
