import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assessJudgeValidationReadiness,
  countSubstantiveBusinessFailures,
  selectFreshUniqueCases,
} from '../lib/judge-validation.js';
import { privateJson } from '../lib/contracts.js';
import { readBlindSampleSet } from './judge.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

function parseFlag(args: string[], flag: string, fallback?: string) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${flag.replaceAll('-', '_').slice(2)}_value_required`);
  return value;
}

function parseRepeatedFlag(args: string[], flag: string) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`${flag.replaceAll('-', '_').slice(2)}_value_required`);
    values.push(path.resolve(value));
  }
  return values;
}

function readRunMetadata(runDirectory: string) {
  const metadataFile = path.join(runDirectory, 'run-metadata.json');
  if (!fs.existsSync(metadataFile))
    throw new Error('judge_validation_run_split_unclassified');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')) as Record<
    string,
    any
  >;
  if (metadata.split === 'holdout')
    return { split: 'holdout' as const, summary: null, metadata };
  if (metadata.split !== 'dev')
    throw new Error('judge_validation_run_split_unclassified');
  const summaryFile = path.join(runDirectory, 'summary.json');
  if (!fs.existsSync(summaryFile))
    throw new Error('judge_validation_run_summary_missing');
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as Record<
    string,
    any
  >;
  if (summary.split !== 'dev')
    throw new Error('judge_validation_run_split_mismatch');
  return { split: 'dev' as const, summary, metadata };
}

function readDevRunMetadata(runDirectory: string) {
  const result = readRunMetadata(runDirectory);
  if (result.split !== 'dev' || !result.summary)
    throw new Error('judge_validation_dev_run_required');
  return result;
}

function priorCaseIdsInJudgeDirectory(judgeDirectory: string) {
  const caseIds = new Set<string>();
  const executions = path.join(judgeDirectory, 'executions');
  if (fs.existsSync(executions))
    for (const executionId of fs.readdirSync(executions)) {
      const reportFile = path.join(
        executions,
        executionId,
        'report.private.json',
      );
      if (!fs.existsSync(reportFile)) continue;
      const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as Record<
        string,
        any
      >;
      if (report.split !== 'dev')
        throw new Error('judge_validation_non_dev_history_rejected');
      if (!Array.isArray(report.samples) || report.samples.length === 0)
        throw new Error('judge_validation_history_samples_missing');
      for (const sample of report.samples) {
        if (!sample || typeof sample.caseId !== 'string')
          throw new Error('judge_validation_history_case_id_missing');
        caseIds.add(sample.caseId);
      }
    }
  for (const entry of fs.readdirSync(judgeDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('manual-calibration.'))
      continue;
    const samplesFile = path.join(judgeDirectory, entry.name, 'samples.jsonl');
    if (!fs.existsSync(samplesFile)) continue;
    for (const line of fs
      .readFileSync(samplesFile, 'utf8')
      .split('\n')
      .filter(Boolean)) {
      const sample = JSON.parse(line) as Record<string, unknown>;
      if (typeof sample.caseId !== 'string')
        throw new Error('judge_validation_manual_case_id_missing');
      caseIds.add(sample.caseId);
    }
  }
  return caseIds;
}

export function collectPreviouslyUsedCaseIds(
  sourceRunDirectory: string,
  explicitRuns: string[],
) {
  const resultsRoot = path.dirname(sourceRunDirectory);
  const runDirectories = new Set<string>([sourceRunDirectory, ...explicitRuns]);
  // Scan only run metadata and Judge artifacts. Never open other runs' cases,
  // traces, ledgers, fixture snapshots or saved answers.
  if (fs.existsSync(resultsRoot))
    for (const entry of fs.readdirSync(resultsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runDirectory = path.join(resultsRoot, entry.name);
      if (!fs.existsSync(path.join(runDirectory, 'judge'))) continue;
      const { split } = readRunMetadata(runDirectory);
      if (split === 'dev') runDirectories.add(runDirectory);
    }
  const usedCaseIds = new Set<string>();
  const sources: Array<{ runId: string; uniquePreviouslyUsedCases: number }> =
    [];
  for (const runDirectory of runDirectories) {
    if (path.resolve(runDirectory) !== path.resolve(sourceRunDirectory))
      readDevRunMetadata(runDirectory);
    const judgeDirectory = path.join(runDirectory, 'judge');
    if (!fs.existsSync(judgeDirectory)) continue;
    const ids = priorCaseIdsInJudgeDirectory(judgeDirectory);
    ids.forEach((id) => usedCaseIds.add(id));
    if (ids.size)
      sources.push({
        runId: path.basename(runDirectory),
        uniquePreviouslyUsedCases: ids.size,
      });
  }
  return { usedCaseIds, sources };
}

export function prepareJudgeValidationPreflight(args = process.argv.slice(2)) {
  const runDirectory = path.resolve(parseFlag(args, '--run-dir') ?? '');
  if (!fs.existsSync(runDirectory))
    throw new Error('judge_validation_run_directory_missing');
  const { summary } = readDevRunMetadata(runDirectory);
  const requestedSamples = Number(parseFlag(args, '--samples', '20'));
  const maximumSyntheticFraction = Number(
    parseFlag(args, '--max-synthetic-fraction', '0.30'),
  );
  const minimumContentFailureFraction = Number(
    parseFlag(args, '--min-content-failure-fraction', '0.30'),
  );
  const minimumNaturalContentFailures = Number(
    parseFlag(args, '--min-natural-content-failures', '1'),
  );
  const explicitRuns = parseRepeatedFlag(args, '--exclude-cases-from');
  const sampleSet = readBlindSampleSet(runDirectory, {
    allowHistoricalCaseContract: true,
  });
  const { usedCaseIds, sources } = collectPreviouslyUsedCaseIds(
    runDirectory,
    explicitRuns,
  );
  const freshSamples = selectFreshUniqueCases(sampleSet.samples, usedCaseIds);
  const resultsByExecution = new Map(
    (summary.results as Array<Record<string, any>>).map((row) => [
      Number(row.executionIndex),
      row,
    ]),
  );
  const freshNaturalContentFailures = freshSamples.filter((sample) => {
    const result = resultsByExecution.get(sample.executionIndex);
    return (
      sample.businessPass === false &&
      countSubstantiveBusinessFailures(result?.businessChecks) > 0
    );
  }).length;
  const readiness = assessJudgeValidationReadiness({
    requestedSamples,
    maximumSyntheticFraction,
    minimumContentFailureFraction,
    minimumNaturalContentFailures,
    freshEligibleCases: freshSamples.length,
    freshNaturalContentFailures,
  });
  const report = {
    schemaVersion: 1,
    runId: path.basename(runDirectory),
    split: 'dev',
    candidateIdentityIncluded: false,
    realModelCalls: 0,
    judgeCalls: 0,
    holdoutCasesRead: false,
    holdoutRunsStarted: 0,
    sourceSummaryHash: createHash('sha256')
      .update(fs.readFileSync(path.join(runDirectory, 'summary.json')))
      .digest('hex'),
    priorJudgeCaseCount: usedCaseIds.size,
    priorJudgeArtifactSources: sources,
    eligibleAttempts: sampleSet.selection.qualityEligibleAttempts,
    sourceSelection: sampleSet.selection,
    freshEligibleCases: freshSamples.length,
    freshNaturalContentFailures,
    selection: readiness,
    sampleDataSufficientForPlannedProtocol: readiness.ready,
  };
  const judgeDirectory = path.join(runDirectory, 'judge');
  fs.mkdirSync(judgeDirectory, { recursive: true, mode: 0o700 });
  const output = path.join(
    judgeDirectory,
    `validation-preflight.${Date.now()}.${randomUUID().slice(0, 8)}.private.json`,
  );
  privateJson(output, report);
  process.stdout.write(
    JSON.stringify({ ...report, report: path.relative(runDirectory, output) }) +
      '\n',
  );
  return report;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    prepareJudgeValidationPreflight();
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'judge_validation_preflight_failed';
    process.stderr.write(`validation preflight blocked: ${message}\n`);
    process.exitCode = 2;
  }
