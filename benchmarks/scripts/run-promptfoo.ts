import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  buildTests,
  validateExecutionOrder,
} from '../promptfoo/build-tests.js';
import { configurePromptfooStorage } from '../promptfoo/runtime.js';
import { preflight } from './spike.js';
import {
  parseCandidates,
  privateJson,
  type SpikeCase,
} from '../lib/contracts.js';
import { reassessPromptfoo } from '../lib/reassess-promptfoo.js';
import { aggregatePromptfooCosts } from '../lib/pricing.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

export async function main() {
  const runId = `promptfoo-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDirectory = path.join(benchmarkDirectory, 'results', runId);
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const checks = await preflight(runDirectory);
  const ready =
    checks.docker &&
    checks.imagePresent &&
    checks.configured &&
    checks.credentials &&
    checks.timeoutValid &&
    checks.candidates.length > 0;
  privateJson(path.join(runDirectory, 'preflight.json'), {
    ready,
    docker: checks.docker,
    imagePresent: checks.imagePresent,
    imageHash: checks.imageHash,
    candidateConfigured: checks.configured,
    credentialsPresent: checks.credentials,
    timeoutValid: checks.timeoutValid,
    runtimeSourceHash: checks.runtimeSourceHash,
  });
  if (!ready) {
    process.stdout.write(JSON.stringify({ stage: 'preflight', ready }) + '\n');
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--preflight')) {
    process.stdout.write(
      JSON.stringify({
        stage: 'preflight',
        ready,
        candidates: checks.candidates.length,
      }) + '\n',
    );
    return;
  }

  const candidates = parseCandidates(checks.candidates);
  const allCases = parse(
    fs.readFileSync(path.join(benchmarkDirectory, 'cases/spike.yaml'), 'utf8'),
  ) as SpikeCase[];
  const smoke = process.argv.includes('--smoke');
  const cases = smoke
    ? allCases.slice(0, candidates.length > 1 ? 2 : 1)
    : allCases;
  const repetitions = smoke ? 1 : 3;
  const tests = buildTests(cases, candidates, repetitions);
  privateJson(path.join(runDirectory, 'cases.used.json'), cases);
  const promptfooDirectory = path.join(runDirectory, 'promptfoo');
  configurePromptfooStorage(promptfooDirectory);
  process.env.BENCH_RUN_DIRECTORY = runDirectory;
  process.env.BENCH_PINNED_IMAGE = checks.imageHash!;
  process.env.BENCH_RUNTIME_SOURCE_HASH = checks.runtimeSourceHash!;
  process.env.BENCH_TIMEOUT_MS = String(
    Number(process.env.BENCH_TIMEOUT_MS || 180000),
  );

  const config = parse(
    fs.readFileSync(
      path.join(benchmarkDirectory, 'promptfoo/promptfooconfig.yaml'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const suite = {
    ...config,
    providers: [
      `file://${path.join(benchmarkDirectory, 'promptfoo/provider.ts')}`,
    ],
    tests,
  };
  privateJson(path.join(promptfooDirectory, 'resolved-config.json'), suite);

  try {
    const { evaluate } = await import('promptfoo');
    const evaluation = await evaluate(suite as never, {
      maxConcurrency: 1,
      cache: false,
      showProgressBar: false,
      silent: true,
    });
    const promptfooResults = evaluation.results.map((row) =>
      row.toEvaluateResult(),
    );
    const pricing = parse(
      fs.readFileSync(path.join(benchmarkDirectory, 'pricing.yaml'), 'utf8'),
    );
    const costByCandidate = aggregatePromptfooCosts(pricing, promptfooResults);
    privateJson(
      path.join(promptfooDirectory, 'results.json'),
      promptfooResults,
    );
    const expected = tests.map((row, index) => ({
      ...row.metadata,
      executionIndex: index + 1,
    }));
    const actual = fs
      .readFileSync(path.join(runDirectory, 'execution-sequence.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((row) => ({
        caseId: row.caseId,
        repetition: row.repetition,
        candidateAlias: row.candidateAlias,
        executionIndex: row.executionIndex,
      }));
    const order = validateExecutionOrder(expected, actual);
    privateJson(path.join(runDirectory, 'execution-order.json'), {
      ...order,
      expectedAttempts: expected.length,
      actualAttempts: actual.length,
      expected,
      actual,
    });
    const independent = reassessPromptfoo(runDirectory);
    const report = {
      ...independent,
      schemaVersion: 1,
      stage: smoke ? 'smoke' : 'benchmark',
      scope: 'synthetic-query-analysis',
      promptfooResultPath: 'promptfoo/results.json',
      costByCandidate,
      promptfooReportedPasses: promptfooResults.filter(
        (result: Record<string, any>) => result.success === true,
      ).length,
      promptfooCostColumnAuthoritative: false,
    };
    privateJson(path.join(runDirectory, 'summary.json'), report);
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
        promptfooCostColumnAuthoritative:
          report.promptfooCostColumnAuthoritative,
        invalidRun: report.invalidRun,
      }) + '\n',
    );
    if (
      !order.valid ||
      independent.invalidRun ||
      independent.attempts !== tests.length
    )
      process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Promptfoo benchmark failed; private diagnostics retained\n',
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      'Promptfoo benchmark failed; private diagnostics retained\n',
    );
    process.exitCode = 1;
  });
