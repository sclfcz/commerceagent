import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateJson } from '../lib/contracts.js';
import { reassessPromptfoo } from '../lib/reassess-promptfoo.js';
import { parse } from 'yaml';
import { aggregatePromptfooCosts } from '../lib/pricing.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

export function createStageTwoReport(runDirectory: string) {
  const summary = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
  );
  const independent = reassessPromptfoo(runDirectory);
  const promptfooResults = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'promptfoo/results.json'), 'utf8'),
  );
  const pricing = parse(
    fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
  );
  const reconciliationPath = path.join(
    runDirectory,
    'artifact-reconciliation.json',
  );
  const reconciliation = fs.existsSync(reconciliationPath)
    ? JSON.parse(fs.readFileSync(reconciliationPath, 'utf8'))
    : null;
  const artifactReconciliation = reconciliation
    ? {
        reason: reconciliation.reason,
        attempts: reconciliation.attempts,
        originalSummaryHash: reconciliation.originalSummaryHash,
        originalProviderParityValid: reconciliation.originalProviderParityValid,
        reconciledSidecarCount: reconciliation.results?.length ?? 0,
      }
    : null;
  return {
    ...independent,
    stage: summary.stage,
    scope: summary.scope,
    artifactReconciliation,
    promptfooReportedPasses: promptfooResults.filter(
      (result: Record<string, any>) => result.success === true,
    ).length,
    costByCandidate: aggregatePromptfooCosts(pricing, promptfooResults),
    promptfooCostColumnAuthoritative: false,
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
  privateJson(path.join(runDirectory, 'summary.reassessed.json'), report);
  process.stdout.write(
    JSON.stringify({
      schemaVersion: report.schemaVersion,
      stage: report.stage,
      scope: report.scope,
      attempts: report.attempts,
      evidenceComplete: report.evidenceComplete,
      executionOrderValid: report.executionOrderValid,
      providerParityValid: report.providerParityValid,
      measurementValidAttempts: report.measurementValidAttempts,
      businessPassedAttempts: report.businessPassedAttempts,
      failureCounts: report.failureCounts,
      measurementFailureCounts: report.measurementFailureCounts,
      businessFailureCounts: report.businessFailureCounts,
      identityByCandidate: report.identityByCandidate,
      costByCandidate: report.costByCandidate,
      promptfooReportedPasses: report.promptfooReportedPasses,
      promptfooCostColumnAuthoritative: report.promptfooCostColumnAuthoritative,
      invalidRun: report.invalidRun,
    }) + '\n',
  );
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
