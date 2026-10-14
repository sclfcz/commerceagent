import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importOpenCodeGoKey } from '../lib/opencode-go.js';
import { readBlindSamples, validateCustomSampleSet } from './judge.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = path.resolve(repository);
const benchmarkDirectory = path.join(repository, 'benchmarks');
const judgeScript = fileURLToPath(new URL('./judge.ts', import.meta.url));

function requiredOption(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--'))
    throw new Error(`judge_batch_option_required:${name}`);
  return path.isAbsolute(value) ? value : path.resolve(repositoryRoot, value);
}

function runStage(name: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', judgeScript, ...args],
    {
      cwd: benchmarkDirectory,
      env: { ...process.env },
      stdio: 'inherit',
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(`judge_batch_stage_failed:${name}`);
}

function readJsonl(file: string): Array<Record<string, any>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function validateLabelFile(samplesFile: string, labelsFile: string) {
  const samples = readJsonl(samplesFile);
  const labels = readJsonl(labelsFile);
  const dimensions = [
    'completeness',
    'grounding',
    'decision_appropriateness',
    'professional_tone',
  ];
  const sampleIds = new Set(samples.map((sample) => sample.sampleId));
  if (
    !samples.length ||
    sampleIds.size !== samples.length ||
    labels.length !== samples.length ||
    new Set(labels.map((label) => label.sampleId)).size !== labels.length ||
    labels.some(
      (label) =>
        !sampleIds.has(label.sampleId) ||
        dimensions.some(
          (dimension) =>
            !Number.isInteger(label.humanScores?.[dimension]) ||
            label.humanScores[dimension] < 1 ||
            label.humanScores[dimension] > 5,
        ),
    )
  )
    throw new Error('judge_batch_labels_invalid');
}

export function runJudgeCalibrationBatch(args = process.argv.slice(2)) {
  const diagnosticRun = requiredOption(args, '--diagnostic-run');
  const diagnosticSamples = requiredOption(args, '--diagnostic-samples');
  const diagnosticLabels = requiredOption(args, '--diagnostic-labels');
  const diagnosticPriorReport = requiredOption(
    args,
    '--diagnostic-prior-report',
  );
  const freshRun = requiredOption(args, '--fresh-run');
  const freshSamples = requiredOption(args, '--fresh-samples');
  const freshLabels = requiredOption(args, '--fresh-labels');
  const inputs = [
    diagnosticRun,
    diagnosticSamples,
    diagnosticLabels,
    diagnosticPriorReport,
    freshRun,
    freshSamples,
    freshLabels,
  ];
  if (
    inputs.some(
      (file) =>
        !path.isAbsolute(file) ||
        !(
          file === repositoryRoot || file.startsWith(repositoryRoot + path.sep)
        ),
    )
  )
    throw new Error('judge_batch_input_path_invalid');
  if (inputs.some((file) => !fs.existsSync(file)))
    throw new Error('judge_batch_input_missing');
  validateLabelFile(diagnosticSamples, diagnosticLabels);
  validateLabelFile(freshSamples, freshLabels);
  const diagnosticRows = readJsonl(diagnosticSamples);
  const freshRows = readJsonl(freshSamples);
  validateCustomSampleSet(
    diagnosticRows as never,
    readBlindSamples(diagnosticRun, { allowHistoricalCaseContract: true }),
  );
  validateCustomSampleSet(
    freshRows as never,
    readBlindSamples(freshRun, { allowIsolatedParityMismatch: true }),
  );
  const priorReport = JSON.parse(
    fs.readFileSync(diagnosticPriorReport, 'utf8'),
  );
  const priorIds = new Set(
    (priorReport.samples ?? []).map(
      (sample: Record<string, unknown>) => sample.sampleId,
    ),
  );
  if (
    priorIds.size !== diagnosticRows.length ||
    diagnosticRows.some((sample) => !priorIds.has(sample.sampleId))
  )
    throw new Error('judge_batch_diagnostic_sample_set_changed');
  if (!importOpenCodeGoKey(repository))
    throw new Error('opencode_go_judge_key_missing');

  runStage('same-sample-diagnostic', [
    diagnosticRun,
    '--sample-ids-from',
    diagnosticPriorReport,
    '--samples-file',
    diagnosticSamples,
    '--labels-file',
    diagnosticLabels,
  ]);
  runStage('fresh-manual-calibration', [
    freshRun,
    '--samples-file',
    freshSamples,
    '--labels-file',
    freshLabels,
    '--manual-blind-labels',
  ]);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    runJudgeCalibrationBatch();
  } catch (error) {
    const message =
      error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
        ? error.message
        : 'judge_calibration_batch_failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
