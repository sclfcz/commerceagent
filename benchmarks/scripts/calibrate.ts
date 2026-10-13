import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationScorePairs, JUDGE_DIMENSIONS } from '../lib/judge.js';
import { hash, privateJson } from '../lib/contracts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

interface JudgeReport {
  runId: string;
  executionId?: string;
  judgeProvenance?: Record<string, unknown>;
  sourceHash?: string;
  samples: Array<{
    sampleId: string;
    category: string;
    question: string;
    expectedStatus: string;
    expectedFacts: Record<string, unknown>;
    expectedEvidence: string[];
    rubric: string[];
    candidateOutput: string;
  }>;
  evaluations: Array<{
    sampleId: string;
    dimensions: Record<
      string,
      { scoreOutOfFive: number | null; pass: boolean; reason: string | null }
    >;
  }>;
}

function jsonlRead(file: string) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function jsonlWrite(file: string, rows: unknown[]) {
  fs.writeFileSync(
    file,
    rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
}

export function buildHumanLabelTemplate(report: JudgeReport) {
  return report.samples.map((sample) => ({
    sampleId: sample.sampleId,
    category: sample.category,
    question: sample.question,
    expectedStatus: sample.expectedStatus,
    expectedFacts: sample.expectedFacts,
    expectedEvidence: sample.expectedEvidence,
    rubric: sample.rubric,
    candidateOutput: sample.candidateOutput,
    humanScores: Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => [dimension, null]),
    ),
    humanNotes: '',
  }));
}

export function analyzeHumanLabels(
  report: JudgeReport,
  labels: Array<{
    sampleId: string;
    humanScores: Record<string, unknown>;
  }>,
) {
  const expectedIds = new Set(report.samples.map((sample) => sample.sampleId));
  if (
    expectedIds.size !== report.samples.length ||
    new Set(labels.map((label) => label.sampleId)).size !== labels.length ||
    labels.length !== expectedIds.size ||
    labels.some((label) => !expectedIds.has(label.sampleId))
  )
    throw new Error('calibration_sample_set_invalid');
  if (
    new Set(report.evaluations.map((row) => row.sampleId)).size !==
    report.evaluations.length
  )
    throw new Error('judge_sample_set_invalid');
  const judgeById = new Map(
    report.evaluations.map((evaluation) => [evaluation.sampleId, evaluation]),
  );
  const rows = labels.map((label) => {
    const judge = judgeById.get(label.sampleId);
    if (!judge) throw new Error('calibration_sample_id_invalid');
    const humanScores = Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => {
        const score = label.humanScores?.[dimension];
        if (!Number.isInteger(score) || Number(score) < 1 || Number(score) > 5)
          throw new Error('calibration_score_invalid');
        return [dimension, Number(score)];
      }),
    );
    const judgeScores = Object.fromEntries(
      JUDGE_DIMENSIONS.map((dimension) => {
        const score = judge.dimensions[dimension]?.scoreOutOfFive;
        if (!Number.isInteger(score) || Number(score) < 1 || Number(score) > 5)
          throw new Error('judge_score_missing');
        return [dimension, Number(score)];
      }),
    );
    return { sampleId: label.sampleId, judgeScores, humanScores };
  });
  const metrics = calibrationScorePairs(rows);
  return {
    schemaVersion: 2,
    runId: report.runId,
    annotatedSamples: rows.length,
    minimumRecommendedSamples: 20,
    kappaThreshold: 0.6,
    calibratedScope: {
      executionId: report.executionId ?? null,
      judgeProvenance: report.judgeProvenance ?? null,
      sourceHash: report.sourceHash ?? null,
      judgeReportHash: hash(report),
      humanLabelsHash: hash(labels),
      limitation:
        'Pilot calibration of these sampled dev answers only; not evidence of stable gateway routing, future Judge versions or general accuracy.',
    },
    judgeEligibleForRanking:
      rows.length >= 20 && (metrics.overall.kappa ?? -1) >= 0.6,
    metrics,
  };
}

export function calibrate(runDirectory: string) {
  const judgeRoot = path.join(path.resolve(runDirectory), 'judge');
  const latestFile = path.join(judgeRoot, 'latest-completed.json');
  const latest = fs.existsSync(latestFile)
    ? JSON.parse(fs.readFileSync(latestFile, 'utf8'))
    : null;
  const judgeDirectory = latest
    ? path.dirname(path.resolve(judgeRoot, latest.reportPath))
    : judgeRoot;
  if (
    latest &&
    !judgeDirectory.startsWith(path.join(judgeRoot, 'executions') + path.sep)
  )
    throw new Error('judge_report_path_invalid');
  const reportFile = path.join(judgeDirectory, 'report.private.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as JudgeReport;
  if (latest && hash(report) !== latest.reportHash)
    throw new Error('judge_report_hash_mismatch');
  const labelFile = path.join(judgeDirectory, 'human-labels.jsonl');
  if (!fs.existsSync(labelFile)) {
    jsonlWrite(labelFile, buildHumanLabelTemplate(report));
    return {
      stage: 'human_labels_needed',
      samples: report.samples.length,
      file: path.relative(benchmarkDirectory, labelFile),
      candidateIdentityIncluded: false,
      judgeScoresIncluded: false,
    };
  }
  const labels = jsonlRead(labelFile);
  if (labels.length !== report.samples.length)
    throw new Error('calibration_sample_count_mismatch');
  const result = analyzeHumanLabels(report, labels);
  const summaryFile = path.join(
    judgeDirectory,
    `calibration-summary.${hash(result).slice(0, 12)}.private.json`,
  );
  if (!fs.existsSync(summaryFile)) privateJson(summaryFile, result);
  return {
    stage: 'calibration_complete',
    annotatedSamples: result.annotatedSamples,
    overallKappa: result.metrics.overall.kappa,
    overallAgreement: result.metrics.overall.agreement,
    ordinalByDimension: Object.fromEntries(
      Object.entries(result.metrics.byDimension).map(([key, value]) => [
        key,
        value.ordinal,
      ]),
    ),
    judgeEligibleForRanking: result.judgeEligibleForRanking,
    falsePasses: result.metrics.overall.falsePasses,
    falseRejects: result.metrics.overall.falseRejects,
    report: path.relative(path.resolve(runDirectory), summaryFile),
  };
}

const runDirectory = process.argv[2];
if (
  runDirectory &&
  path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)
) {
  try {
    process.stdout.write(JSON.stringify(calibrate(runDirectory)) + '\n');
  } catch (error) {
    const code =
      error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
        ? error.message
        : 'calibration_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
