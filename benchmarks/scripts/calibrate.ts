import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calibrationScorePairs, JUDGE_DIMENSIONS } from '../lib/judge.js';
import { privateJson } from '../lib/contracts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

interface JudgeReport {
  runId: string;
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
    schemaVersion: 1,
    runId: report.runId,
    annotatedSamples: rows.length,
    minimumRecommendedSamples: 20,
    kappaThreshold: 0.6,
    judgeEligibleForRanking:
      rows.length >= 20 && (metrics.overall.kappa ?? -1) >= 0.6,
    metrics,
  };
}

export function calibrate(runDirectory: string) {
  const judgeDirectory = path.join(path.resolve(runDirectory), 'judge');
  const reportFile = path.join(judgeDirectory, 'report.private.json');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as JudgeReport;
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
  privateJson(
    path.join(judgeDirectory, 'calibration-summary.private.json'),
    result,
  );
  return {
    stage: 'calibration_complete',
    annotatedSamples: result.annotatedSamples,
    overallKappa: result.metrics.overall.kappa,
    judgeEligibleForRanking: result.judgeEligibleForRanking,
    falsePasses: result.metrics.overall.falsePasses,
    falseRejects: result.metrics.overall.falseRejects,
    report: 'judge/calibration-summary.private.json',
  };
}

const runDirectory = process.argv[2];
if (runDirectory) {
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
