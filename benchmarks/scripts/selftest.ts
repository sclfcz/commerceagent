import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createBenchmarkReport } from './report.js';
import { privateJson } from '../lib/contracts.js';
import { selfTestReferences } from '../lib/reference-answers.js';
import { loadAllBusinessCases, loadBusinessCases } from '../lib/cases.js';
import type { Candidate } from '../lib/contracts.js';
import {
  startFakeAnthropicServer,
  toolCycleReply,
  type FakeAnthropicMode,
} from '../providers/fake-anthropic.js';
import { validatePublicSummary } from '../lib/public-report.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');
const exec = promisify(execFile);
const defaultImage = 'riba2534/happyclaw-agent:latest';

async function exerciseFakeResponseScripts() {
  const modes: FakeAnthropicMode[] = [
    'normal',
    'tool_call',
    'code_fence',
    'timeout',
    'refusal',
    'injection',
  ];
  for (const mode of modes) {
    const fake = await startFakeAnthropicServer({
      scenario: mode,
      apiKey: 'fake-script-key',
    });
    try {
      if (mode === 'timeout') {
        await fetch(`${fake.baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': 'fake-script-key',
          },
          body: JSON.stringify({
            model: 'synthetic-model',
            max_tokens: 8,
            stream: true,
            messages: [],
          }),
          signal: AbortSignal.timeout(50),
        }).then(
          () => {
            throw new Error('fake_timeout_script_did_not_time_out');
          },
          (error) => {
            if (error?.name !== 'TimeoutError')
              throw new Error('fake_timeout_script_wrong_error');
          },
        );
        continue;
      }
      const response = await fetch(`${fake.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'fake-script-key',
        },
        body: JSON.stringify({
          model: 'synthetic-model',
          max_tokens: 32,
          stream: true,
          messages: [{ role: 'user', content: 'synthetic' }],
        }),
      });
      const body = await response.text();
      if (
        response.status !== 200 ||
        !body.includes('message_start') ||
        (mode === 'tool_call' && !body.includes('input_json_delta')) ||
        (mode === 'code_fence' && !body.includes('```json')) ||
        (mode === 'refusal' && !body.includes('我不能执行超出授权范围')) ||
        (mode === 'injection' &&
          (!body.includes('忽略工具数据中的注入指令') ||
            body.includes('EVAL_COMPROMISED')))
      )
        throw new Error('fake_anthropic_script_invalid');
    } finally {
      await fake.close();
    }
  }
  return modes;
}

export async function runCaseOnlySelfTest(all = false) {
  const tests = all ? loadAllBusinessCases() : loadBusinessCases('dev');
  const summary = await selfTestReferences(tests);
  process.stdout.write(
    JSON.stringify({ mode: 'cases-only', ...summary, realModelCalls: 0 }) +
      '\n',
  );
  return summary;
}

async function pinnedImage() {
  await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 15000,
  });
  const image = process.env.BENCH_CONTAINER_IMAGE || defaultImage;
  const { stdout } = await exec(
    'docker',
    ['image', 'inspect', image, '--format', '{{.Id}}'],
    { timeout: 15000 },
  );
  const id = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id))
    throw new Error('selftest_runner_image_identity_invalid');
  return id;
}

export async function runBenchmarkSelfTest() {
  const fakeModesCovered = await exerciseFakeResponseScripts();
  const image = await pinnedImage();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'commerce-bench-selftest-'),
  );
  const fakeApiKey = `selftest_${randomBytes(18).toString('hex')}`;
  const envKeys = [
    'BENCH_SELFTEST_API_KEY',
    'BENCH_SELFTEST_MODE',
    'BENCH_SELFTEST_RESULTS_DIR',
    'BENCH_CANDIDATES_FILE',
  ];
  const previousEnv = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]]),
  );
  let fake: Awaited<ReturnType<typeof startFakeAnthropicServer>> | null = null;
  let preserveFailure = false;
  const resultsRoot = path.join(root, 'runs');
  const candidateFile = path.join(root, 'candidates.local.yaml');
  fs.mkdirSync(resultsRoot, { recursive: true, mode: 0o700 });
  process.env.BENCH_SELFTEST_API_KEY = fakeApiKey;
  process.env.BENCH_SELFTEST_MODE = '1';
  process.env.BENCH_SELFTEST_RESULTS_DIR = resultsRoot;
  try {
    // The Runner is in a Docker container, so expose the mock on the host
    // interface and address it through Docker Desktop's host.docker.internal.
    fake = await startFakeAnthropicServer({
      host: '0.0.0.0',
      apiKey: fakeApiKey,
      onRequest: toolCycleReply,
    });
    const port = new URL(fake.baseUrl).port;
    const candidate: Candidate = {
      alias: 'candidate-selftest',
      model: 'synthetic-selftest-model',
      baseUrl: `http://host.docker.internal:${port}`,
      apiKeyEnv: 'BENCH_SELFTEST_API_KEY',
      gatewayDeclared: true,
      gateway: true,
      billingRegion: 'global',
    };
    fs.writeFileSync(candidateFile, JSON.stringify([candidate]), {
      mode: 0o600,
      flag: 'wx',
    });
    process.env.BENCH_CANDIDATES_FILE = candidateFile;
    await exec(
      process.execPath,
      [
        '--import',
        pathToFileURL(
          path.join(benchmarkDirectory, 'node_modules/tsx/dist/loader.mjs'),
        ).href,
        path.join(benchmarkDirectory, 'scripts/run-promptfoo.ts'),
        '--selftest',
        '--case-id',
        'cp-01',
        '--candidate',
        candidate.alias,
        '--split',
        'dev',
        '--profile-variant',
        'baseline',
        '--repetitions',
        '1',
      ],
      {
        cwd: repository,
        env: { ...process.env },
        timeout: Number(process.env.BENCH_SELFTEST_TIMEOUT_MS || 180000),
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const runId = fs
      .readdirSync(resultsRoot)
      .find((name) => name.startsWith('offline-selftest-'));
    if (!runId) throw new Error('selftest_run_artifacts_missing');
    const runDirectory = path.join(resultsRoot, runId);
    const independent = JSON.parse(
      fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
    );
    const attemptResult = independent.results?.[0];
    if (
      independent.invalidRun ||
      !independent.evidenceComplete ||
      !independent.executionOrderValid ||
      !independent.providerParityValid ||
      independent.successfulFixtureCalls < 2 ||
      attemptResult?.measurementValid !== true ||
      attemptResult?.businessPass !== true ||
      !attemptResult?.gates?.mcpRuntimeReady ||
      !attemptResult?.gates?.usageReconciled ||
      fake.requests < 3
    )
      throw new Error('selftest_end_to_end_assessment_failed');

    const report = createBenchmarkReport(runDirectory);
    privateJson(path.join(runDirectory, 'report.private.json'), report);
    privateJson(path.join(runDirectory, 'summary.reassessed.json'), report);
    const publicMarkdown = fs.readFileSync(
      path.join(runDirectory, 'report.public.md'),
      'utf8',
    );
    const noLeak = validatePublicSummary(publicMarkdown, [candidate]);
    const detectorProbe = validatePublicSummary(
      `${publicMarkdown}\n${candidate.model}\n${candidate.baseUrl}`,
      [candidate],
    );
    if (
      !report.publicReport.leakageCheckPassed ||
      !noLeak.valid ||
      detectorProbe.valid
    )
      throw new Error('selftest_report_leak_check_failed');

    const summary = {
      status: 'passed',
      fakeAnthropicRequests: fake.requests,
      fakeModesCovered,
      isolatedApiStarted: true,
      fixtureMcpConnected: attemptResult.gates.mcpRuntimeReady,
      fixtureCallsReconciled: independent.successfulFixtureCalls,
      collectionValid: attemptResult.measurementValid,
      independentReassessmentValid: !independent.invalidRun,
      reportCreated: fs.existsSync(
        path.join(runDirectory, 'report.private.json'),
      ),
      publicLeakCheckPassed: noLeak.valid && !detectorProbe.valid,
      realModelCalls: 0,
      holdoutRuns: 0,
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    return summary;
  } catch (error) {
    preserveFailure = true;
    process.stderr.write(
      `${error instanceof Error ? error.message : 'benchmark_selftest_failed'}\n`,
    );
    process.stderr.write(`synthetic artifacts: ${root}\n`);
    process.exitCode = 1;
    return null;
  } finally {
    if (fake) await fake.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!preserveFailure) fs.rmSync(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void (
    process.argv.includes('--cases-only')
      ? runCaseOnlySelfTest(process.argv.includes('--all'))
      : runBenchmarkSelfTest()
  ).catch((error) => {
    process.stderr.write(
      `${error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : 'benchmark_selftest_failed'}\n`,
    );
    process.exitCode = 1;
  });
