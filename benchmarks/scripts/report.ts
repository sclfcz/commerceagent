import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, privateJson } from '../lib/contracts.js';
import { reassessPromptfoo } from '../lib/reassess-promptfoo.js';
import { parse } from 'yaml';
import { calculateCost } from '../lib/pricing.js';
import { summarizeMetrics, type MetricAttempt } from '../lib/metrics.js';
import {
  renderPublicSummary,
  validatePublicSummary,
} from '../lib/public-report.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

export function createBenchmarkReport(runDirectory: string) {
  const summary = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
  );
  const independent = reassessPromptfoo(runDirectory);
  const promptfooResults = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'promptfoo/results.json'), 'utf8'),
  );
  const pricing = parse(
    fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
  ) as Record<string, any>;
  const candidates = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'candidates.json'), 'utf8'),
  ) as Array<{
    alias: string;
    model: string;
    baseUrl: string;
    billingRegion?: string;
  }>;
  const usedCases = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'cases.used.json'), 'utf8'),
  ) as Array<{ id: string }>;
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
  const metrics = summarizeMetrics(independent.results as MetricAttempt[], {
    expectedRepetitions: 3,
    bootstrapIterations: 10_000,
    runValid: !independent.invalidRun,
    caseIds: usedCases.map((test) => test.id),
    candidateAliases: candidates.map((candidate) => candidate.alias),
  });
  const costByCandidate = Object.fromEntries(
    Object.keys(metrics.candidates).map((alias) => {
      const rows = independent.results.filter(
        (row: Record<string, any>) => row.candidate === alias,
      );
      const rate = pricing.candidates?.[alias];
      const candidate = candidates.find((item) => item.alias === alias);
      const attemptCosts = rows.map((row: Record<string, any>) =>
        calculateCost(row.usage, rate, candidate),
      );
      const known =
        attemptCosts.length > 0 &&
        attemptCosts.every((cost: number | null) => cost !== null);
      const totalCost = known
        ? attemptCosts.reduce((sum: number, cost: number) => sum + cost!, 0)
        : null;
      const successfulTasks = rows.filter(
        (row: Record<string, any>) =>
          row.measurementValid && row.qualityEligible && row.pass,
      ).length;
      return [
        alias,
        {
          attempts: rows.length,
          currency: rate?.currency ?? pricing.currency ?? null,
          effectiveDate: rate?.effective_date ?? pricing.effective_date ?? null,
          source: rate?.source ?? null,
          totalCost,
          costPerSuccessfulTask:
            totalCost === null || successfulTasks === 0
              ? null
              : totalCost / successfulTasks,
          successfulTasks,
          known,
        },
      ];
    }),
  );
  const publicSummary = renderPublicSummary({
    runId: path.basename(runDirectory),
    metrics,
    costs: costByCandidate,
    privateCandidates: candidates,
  });
  const publicCheck = validatePublicSummary(publicSummary.markdown, candidates);
  if (!publicCheck.valid) throw new Error('public_summary_leak');
  fs.writeFileSync(
    path.join(runDirectory, 'report.public.md'),
    publicSummary.markdown,
    { mode: 0o600 },
  );
  return {
    ...independent,
    pricingHash: hash(
      fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
    ),
    stage: summary.stage,
    scope: summary.scope,
    artifactReconciliation,
    promptfooReportedPasses: promptfooResults.filter(
      (result: Record<string, any>) => result.success === true,
    ).length,
    costByCandidate,
    metrics,
    publicReport: {
      path: 'report.public.md',
      leakageCheckPassed: publicCheck.valid,
      candidateAliases: publicSummary.aliasMap,
    },
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
  const report = createBenchmarkReport(runDirectory);
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
      metrics: report.metrics,
      publicReport: {
        path: report.publicReport.path,
        leakageCheckPassed: report.publicReport.leakageCheckPassed,
      },
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
