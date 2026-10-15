import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrices } from '../lib/pricing.js';
import {
  estimateBenchmarkBudget,
  type EstimateMode,
} from '../lib/budget-estimate.js';
import { resolveRunDirectory } from './report.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

export function runEstimate(args = process.argv.slice(2)) {
  const mode = (option(args, '--mode') || 'screening') as EstimateMode;
  if (!['screening', 'confirmation', 'formal', 'holdout'].includes(mode))
    throw new Error('budget_estimate_mode_invalid');
  const referenceRun = option(args, '--reference-run');
  if (!referenceRun)
    throw new Error(
      'usage: bench:estimate --reference-run <run-id> [--mode screening|confirmation|formal|holdout] [--case-count N] [--candidate-count N] [--profile-count N] [--repetitions N]',
    );
  const runDirectory = resolveRunDirectory(
    referenceRun,
    repository,
    benchmarkDirectory,
  );
  const summary = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
  );
  const candidates = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'candidates.json'), 'utf8'),
  );
  const candidateCount = Number(
    option(args, '--candidate-count') ?? candidates.length,
  );
  const caseCount = Number(
    option(args, '--case-count') ?? (mode === 'holdout' ? 18 : 50),
  );
  const prices = loadPrices(path.join(benchmarkDirectory, 'pricing.yaml'));
  const estimate = estimateBenchmarkBudget({
    mode,
    caseCount,
    candidateCount,
    ...(option(args, '--profile-count')
      ? { profileCount: Number(option(args, '--profile-count')) }
      : {}),
    ...(option(args, '--repetitions')
      ? { repetitions: Number(option(args, '--repetitions')) }
      : {}),
    referenceCandidates: candidates,
    referenceAttempts: summary.results ?? [],
    prices,
  });
  process.stdout.write(JSON.stringify(estimate) + '\n');
  return estimate;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    runEstimate();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : 'budget_estimate_failed'}\n`,
    );
    process.exitCode = 1;
  }
