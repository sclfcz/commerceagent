import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  buildTests,
  validateAdapterParity,
  validateExecutionOrder,
} from '../promptfoo/build-tests.js';
import { configurePromptfooStorage } from '../promptfoo/runtime.js';
import { preflight } from './spike.js';
import {
  parseCandidates,
  privateJson,
  type SpikeCase,
} from '../lib/contracts.js';
import {
  countClassifications,
  summarizeCandidates,
} from '../lib/assessment.js';

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
    const results = fs
      .readdirSync(runDirectory, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('promptfoo-'),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => {
        const file = path.join(runDirectory, entry.name, 'result.json');
        return fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, 'utf8'))
          : null;
      })
      .filter(Boolean);
    const parity = validateAdapterParity(results, promptfooResults);
    privateJson(path.join(runDirectory, 'adapter-parity.json'), {
      ...parity,
      attempts: results.length,
      promptfooResults: promptfooResults.length,
    });
    const report = {
      schemaVersion: 1,
      stage: smoke ? 'smoke' : 'benchmark',
      scope: 'synthetic-query-analysis',
      executionOrderValid: order.valid,
      providerParityValid: parity.valid,
      attempts: results.length,
      measurementValidAttempts: results.filter((row) => row.measurementValid)
        .length,
      businessPassedAttempts: results.filter((row) => row.businessPass).length,
      failureCounts: countClassifications(results, 'failure'),
      measurementFailureCounts: countClassifications(
        results,
        'measurementFailure',
      ),
      businessFailureCounts: countClassifications(results, 'businessFailure'),
      identityByCandidate: summarizeCandidates(results),
      promptfooResultPath: 'promptfoo/results.json',
    };
    privateJson(path.join(runDirectory, 'summary.json'), report);
    process.stdout.write(JSON.stringify(report) + '\n');
    if (!order.valid || !parity.valid || results.length !== tests.length)
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
