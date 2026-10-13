import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  assertBusinessCase,
  loadBusinessCases,
  countHoldoutRuns,
} from '../lib/cases.js';
import {
  calculateCost,
  loadPrices,
  type CandidatePrice,
} from '../lib/pricing.js';
import { summarizeMetrics, type MetricAttempt } from '../lib/metrics.js';
import {
  renderPublicSummary,
  validatePublicSummary,
} from '../lib/public-report.js';
import { hash } from '../lib/contracts.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');
const directory = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('run_directory_required');
const sha = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const summaryFile = path.join(directory, 'summary.json');
const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
if (summary.split !== 'dev') throw new Error('regrade_dev_only');
const cases = loadBusinessCases('dev');
const used = JSON.parse(
  fs.readFileSync(path.join(directory, 'cases.used.json'), 'utf8'),
);
const candidates = JSON.parse(
  fs.readFileSync(path.join(directory, 'candidates.json'), 'utf8'),
) as Array<{
  alias: string;
  model: string;
  baseUrl: string;
  billingRegion?: string;
}>;
const pricing = parse(
  fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
) as {
  effective_date?: string;
  currency?: string;
  candidates?: Record<string, Partial<CandidatePrice>>;
};
const codeFiles = [
  '../lib/cases.ts',
  '../lib/date-range.ts',
  '../lib/contracts.ts',
  '../lib/interruption-evidence.ts',
  './regrade-business.ts',
];
const codeHash = hash(
  codeFiles.map((file) =>
    fs.readFileSync(new URL(file, import.meta.url), 'utf8'),
  ),
);
const rows: Array<Record<string, any>> = [];
const resultByIndex = new Map<number, ReturnType<typeof assertBusinessCase>>();

for (const row of summary.results as Array<Record<string, any>>) {
  const test = cases.find((candidate) => candidate.id === row.caseId);
  if (!test) continue;
  const attemptDirectory = path.join(
    directory,
    `promptfoo-${String(row.executionIndex).padStart(4, '0')}`,
  );
  const traceFile = path.join(attemptDirectory, 'trace.json');
  const ledgerFile = path.join(attemptDirectory, 'fixture.jsonl');
  const fixtureFile = path.join(attemptDirectory, 'fixture-snapshot.json');
  const stateFile = path.join(attemptDirectory, 'fixture-state.json');
  const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  const ledger = fs
    .readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const result = assertBusinessCase(
    trace.output,
    test,
    fixture,
    ledger,
    trace.tools,
    state,
  );
  resultByIndex.set(Number(row.executionIndex), result);
  rows.push({
    caseId: test.id,
    candidate: row.candidate,
    repetition: row.repetition,
    executionIndex: row.executionIndex,
    contractChanged:
      hash(test) !== hash(used.find((saved: any) => saved.id === test.id)),
    oldBusinessPass: row.businessPass,
    newBusinessPass: result.pass,
    oldChecks: row.businessChecks,
    newChecks: result.checks,
    sourceHashes: {
      trace: sha(traceFile),
      ledger: sha(ledgerFile),
      fixture: sha(fixtureFile),
      state: sha(stateFile),
      originalResult: sha(path.join(attemptDirectory, 'result.json')),
    },
  });
}

const regradedAttempts = (summary.results as Array<Record<string, any>>).map(
  (row) => {
    const regraded = resultByIndex.get(Number(row.executionIndex));
    if (!regraded) return row as unknown as MetricAttempt;
    return {
      ...row,
      businessPass: regraded.pass,
      businessChecks: regraded.checks,
      pass: row.measurementValid && row.qualityEligible && regraded.pass,
    } as unknown as MetricAttempt;
  },
);
const metrics = summarizeMetrics(regradedAttempts, {
  expectedRepetitions: 3,
  runValid:
    summary.invalidRun === false &&
    summary.measurementValidityGate?.passed !== false,
  caseIds: used.map((test: { id: string }) => test.id),
  candidateAliases: candidates.map((candidate) => candidate.alias),
});
const costByCandidate = Object.fromEntries(
  Object.keys(metrics.candidates).map((alias) => {
    const candidate = candidates.find((item) => item.alias === alias);
    const price = pricing.candidates?.[alias];
    const candidateRows = regradedAttempts.filter(
      (row) => row.candidate === alias,
    );
    const attemptCosts = candidateRows.map((row) =>
      calculateCost(row.usage ?? null, price, candidate),
    );
    const known =
      attemptCosts.length > 0 &&
      attemptCosts.every(
        (cost) => typeof cost === 'number' && Number.isFinite(cost),
      );
    const totalCost = known
      ? attemptCosts.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
      : null;
    const successfulTasks = candidateRows.filter(
      (row) => row.measurementValid && row.qualityEligible && row.pass,
    ).length;
    return [
      alias,
      {
        attempts: candidateRows.length,
        currency: price?.currency ?? pricing.currency ?? null,
        effectiveDate: price?.effective_date ?? pricing.effective_date ?? null,
        source: price?.source ?? null,
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
const falsePositiveCorrections = rows.filter(
  (row) => row.oldBusinessPass === false && row.newBusinessPass === true,
).length;
const remainingModelFailures = rows.filter(
  (row) => row.oldBusinessPass === false && row.newBusinessPass === false,
).length;
const publicSummary = renderPublicSummary({
  runId: `${path.basename(directory)}-offline-regrade`,
  metrics,
  costs: costByCandidate,
  split: summary.split,
  holdoutCumulativeRuns: countHoldoutRuns(
    path.join(benchmarkDirectory, 'results/holdout-runs.jsonl'),
  ),
  privateCandidates: candidates,
});
const leakageCheck = validatePublicSummary(publicSummary.markdown, candidates);
if (!leakageCheck.valid) throw new Error('regraded_public_summary_leak');

const report = {
  schemaVersion: 2,
  runId: path.basename(directory),
  scope:
    'offline assertion correction using preserved traces, ledgers and fixture snapshots; no new model calls; not a fresh run',
  modelCalls: 0,
  originalSummaryHash: sha(summaryFile),
  assertionCodeHash: codeHash,
  pricingHash: sha(path.join(benchmarkDirectory, 'pricing.yaml')),
  currentCaseHashes: Object.fromEntries(
    cases.map((test) => [test.id, hash(test)]),
  ),
  originalAttempts: summary.attempts,
  originalBusinessPassedAttempts: summary.businessPassedAttempts,
  regradedBusinessPassedAttempts: regradedAttempts.filter(
    (row) => row.measurementValid && row.qualityEligible && row.businessPass,
  ).length,
  falsePositiveCorrections,
  remainingModelFailures,
  categories: {
    model_error: remainingModelFailures,
    case_or_assertion_error: falsePositiveCorrections,
  },
  measurementValidAttempts: summary.measurementValidAttempts,
  measurementValidityGate: summary.measurementValidityGate,
  identityByCandidate: summary.identityByCandidate,
  costByCandidate,
  metrics,
  publicReport: {
    path: 'report.regraded.public.md',
    leakageCheckPassed: leakageCheck.valid,
  },
  rows,
};
const out = path.join(
  directory,
  `business.regraded.${codeHash.slice(0, 12)}.json`,
);
const publicFile = path.join(
  directory,
  `report.regraded.${codeHash.slice(0, 12)}.public.md`,
);
if (!fs.existsSync(out))
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
if (!fs.existsSync(publicFile))
  fs.writeFileSync(publicFile, publicSummary.markdown, {
    mode: 0o600,
    flag: 'wx',
  });
console.log(
  JSON.stringify({
    runId: report.runId,
    originalBusinessPassedAttempts: report.originalBusinessPassedAttempts,
    regradedBusinessPassedAttempts: report.regradedBusinessPassedAttempts,
    falsePositiveCorrections,
    remainingModelFailures,
    costByCandidate,
    modelCalls: 0,
    diagnosticOnly: true,
    artifact: path.basename(out),
    publicArtifact: path.basename(publicFile),
  }),
);
