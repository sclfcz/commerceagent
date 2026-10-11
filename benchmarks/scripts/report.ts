import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  countClassifications,
  summarizeCandidates,
} from '../lib/assessment.js';
import {
  validateAdapterParity,
  validateExecutionOrder,
} from '../promptfoo/build-tests.js';
import { privateJson } from '../lib/contracts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

export function createStageTwoReport(runDirectory: string) {
  const summary = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
  );
  const sequence = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'execution-order.json'), 'utf8'),
  );
  const order = validateExecutionOrder(sequence.expected, sequence.actual);
  const attempts = fs
    .readdirSync(runDirectory, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith('promptfoo-'),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const resultPath = path.join(runDirectory, entry.name, 'result.json');
      return fs.existsSync(resultPath)
        ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
        : null;
    })
    .filter(Boolean);
  const promptfooResults = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'promptfoo/results.json'), 'utf8'),
  );
  const adapterParity = validateAdapterParity(attempts, promptfooResults);
  const reconciliationPath = path.join(
    runDirectory,
    'artifact-reconciliation.json',
  );
  const artifactReconciliation = fs.existsSync(reconciliationPath)
    ? JSON.parse(fs.readFileSync(reconciliationPath, 'utf8'))
    : null;
  const identityByCandidate = summarizeCandidates(attempts);
  return {
    schemaVersion: 1,
    stage: summary.stage,
    scope: summary.scope,
    attempts: attempts.length,
    executionOrderValid: order.valid,
    providerParityValid: adapterParity.valid,
    artifactReconciliation,
    measurementValidAttempts: attempts.filter((row) => row.measurementValid)
      .length,
    businessPassedAttempts: attempts.filter((row) => row.businessPass).length,
    failureCounts: countClassifications(attempts, 'failure'),
    measurementFailureCounts: countClassifications(
      attempts,
      'measurementFailure',
    ),
    businessFailureCounts: countClassifications(attempts, 'businessFailure'),
    identityByCandidate,
    invalidRun:
      !order.valid ||
      !adapterParity.valid ||
      attempts.length !== sequence.expectedAttempts ||
      sequence.actualAttempts !== sequence.expectedAttempts,
  };
}

export function main() {
  const argument = process.argv[2];
  if (!argument)
    throw new Error('usage: npm run bench:report -- <run-id-or-path>');
  const runDirectory = path.isAbsolute(argument)
    ? argument
    : path.join(benchmarkDirectory, 'results', argument);
  const report = createStageTwoReport(runDirectory);
  privateJson(path.join(runDirectory, 'report.private.json'), report);
  if (report.artifactReconciliation) {
    const original = JSON.parse(
      fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
    );
    privateJson(path.join(runDirectory, 'summary.reconciled.json'), {
      ...original,
      ...report,
      providerParityValid: report.providerParityValid,
    });
  }
  process.stdout.write(JSON.stringify(report) + '\n');
  if (report.invalidRun) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  try {
    main();
  } catch {
    process.stderr.write('No valid private benchmark result was found\n');
    process.exitCode = 1;
  }
