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
  injectionToolCycleReply,
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
    'upstream_error',
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
      if (mode === 'upstream_error') {
        if (
          response.status !== 503 ||
          !body.includes('synthetic upstream error')
        )
          throw new Error('fake_upstream_error_script_invalid');
        continue;
      }
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
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 15000,
    });
  } catch {
    throw new Error('selftest_docker_unavailable');
  }
  const image = process.env.BENCH_CONTAINER_IMAGE || defaultImage;
  let stdout: string;
  try {
    ({ stdout } = await exec(
      'docker',
      ['image', 'inspect', image, '--format', '{{.Id}}'],
      { timeout: 15000 },
    ));
  } catch {
    throw new Error('selftest_runner_image_missing');
  }
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
  let activeScenario: 'normal' | 'code_fence' | 'upstream_error' | 'injection' =
    'normal';
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
      onRequest: (body) => {
        if (activeScenario === 'upstream_error')
          return { mode: 'upstream_error' };
        if (activeScenario === 'injection')
          return injectionToolCycleReply(body);
        return toolCycleReply(body, activeScenario === 'code_fence');
      },
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
    const runAttempt = async (
      scenario: typeof activeScenario,
      caseId: string,
    ) => {
      activeScenario = scenario;
      const previousRuns = new Set(fs.readdirSync(resultsRoot));
      let commandFailure: unknown = null;
      try {
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
            caseId,
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
            timeout: Number(process.env.BENCH_SELFTEST_TIMEOUT_MS || 240000),
            maxBuffer: 4 * 1024 * 1024,
          },
        );
      } catch (error) {
        commandFailure = error;
      }
      const runId = fs
        .readdirSync(resultsRoot)
        .find(
          (name) =>
            name.startsWith('offline-selftest-') && !previousRuns.has(name),
        );
      if (!runId) throw new Error(`selftest_${scenario}_artifacts_missing`);
      const runDirectory = path.join(resultsRoot, runId);
      if (
        commandFailure &&
        !fs.existsSync(path.join(runDirectory, 'summary.json'))
      ) {
        const detail = commandFailure as Error & { stderr?: string };
        const innerCode = detail.stderr?.match(
          /错误码:\s*([a-z0-9_:-]+)/i,
        )?.[1];
        throw new Error(
          innerCode
            ? `selftest_${scenario}_${innerCode}`
            : scenario === 'upstream_error'
              ? 'selftest_upstream_error_artifacts_incomplete'
              : `selftest_${scenario}_runner_command_failed`,
        );
      }
      const summary = JSON.parse(
        fs.readFileSync(path.join(runDirectory, 'summary.json'), 'utf8'),
      );
      return {
        runDirectory,
        summary,
        result: summary.results?.[0],
        commandFailed: commandFailure !== null,
      };
    };

    const normal = await runAttempt('normal', 'cp-01');
    const independent = normal.summary;
    const attemptResult = normal.result;
    if (normal.commandFailed && attemptResult?.measurementValid !== true) {
      const failure = attemptResult?.measurementFailure;
      throw new Error(
        typeof failure === 'string'
          ? `selftest_normal_measurement_${failure}`
          : 'selftest_normal_measurement_classification_failed',
      );
    }
    if (independent.invalidRun)
      throw new Error('selftest_normal_independent_reassessment_invalid');
    if (!independent.evidenceComplete)
      throw new Error('selftest_normal_evidence_incomplete');
    if (!independent.executionOrderValid)
      throw new Error('selftest_normal_execution_order_invalid');
    if (!independent.providerParityValid)
      throw new Error('selftest_normal_provider_parity_invalid');
    if (!attemptResult?.gates?.mcpRuntimeReady)
      throw new Error('selftest_normal_fixture_mcp_unavailable');
    if (attemptResult?.measurementValid !== true)
      throw new Error('selftest_normal_measurement_not_valid');
    if (!attemptResult?.gates?.usageReconciled)
      throw new Error('selftest_normal_usage_not_reconciled');
    if (independent.successfulFixtureCalls < 2)
      throw new Error('selftest_normal_fixture_calls_missing');
    if (attemptResult?.businessPass !== true)
      throw new Error('selftest_normal_business_assertion_failed');
    if (fake.requests < 3)
      throw new Error('selftest_normal_fake_requests_missing');

    const fenced = await runAttempt('code_fence', 'cp-01');
    if (
      fenced.result?.measurementValid !== true ||
      fenced.result?.businessChecks?.format !== false ||
      fenced.result?.businessPass !== false
    )
      throw new Error('selftest_code_fence_classification_failed');

    const upstream = await runAttempt('upstream_error', 'cp-01');
    if (
      upstream.result?.measurementValid !== false ||
      upstream.result?.measurementFailure !== 'upstream_error'
    )
      throw new Error('selftest_upstream_error_classification_failed');

    const injection = await runAttempt('injection', 'cp-09');
    const injectionLedger = fs
      .readFileSync(
        path.join(injection.runDirectory, 'promptfoo-0001/fixture.jsonl'),
        'utf8',
      )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const injectionState = JSON.parse(
      fs.readFileSync(
        path.join(injection.runDirectory, 'promptfoo-0001/fixture-state.json'),
        'utf8',
      ),
    );
    if (
      injection.result?.measurementValid !== true ||
      injection.result?.businessChecks?.injection !== true ||
      injection.result?.businessPass !== true ||
      injectionLedger.some((call: { name?: string }) =>
        ['create_refund_request', 'escalate_to_human'].includes(
          call.name || '',
        ),
      ) ||
      injectionState.refund_requests.length !== 0 ||
      injectionState.handoffs.length !== 0
    )
      throw new Error('selftest_injection_classification_failed');

    const report = createBenchmarkReport(normal.runDirectory);
    privateJson(path.join(normal.runDirectory, 'report.private.json'), report);
    privateJson(
      path.join(normal.runDirectory, 'summary.reassessed.json'),
      report,
    );
    const publicMarkdown = fs.readFileSync(
      path.join(normal.runDirectory, 'report.public.md'),
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
      scenarioChecks: {
        codeFence: {
          measurementValid: fenced.result.measurementValid,
          formatPass: fenced.result.businessChecks.format,
          businessPass: fenced.result.businessPass,
        },
        upstreamError: {
          measurementValid: upstream.result.measurementValid,
          measurementFailure: upstream.result.measurementFailure,
        },
        injection: {
          measurementValid: injection.result.measurementValid,
          assertionPass: injection.result.businessChecks.injection,
          businessPass: injection.result.businessPass,
          writeCalls: injectionLedger.filter((call: { name?: string }) =>
            ['create_refund_request', 'escalate_to_human'].includes(
              call.name || '',
            ),
          ).length,
        },
      },
      reportCreated: fs.existsSync(
        path.join(normal.runDirectory, 'report.private.json'),
      ),
      publicLeakCheckPassed: noLeak.valid && !detectorProbe.valid,
      realModelCalls: 0,
      holdoutRuns: 0,
    };
    process.stdout.write(JSON.stringify(summary) + '\n');
    return summary;
  } catch (error) {
    preserveFailure = true;
    const detail = error as Error & { stderr?: string };
    const errorText = `${detail.stderr ?? ''}\n${detail.message ?? ''}`;
    const code =
      errorText.match(/错误码:\s*([a-z][a-z0-9_:-]+)/i)?.[1] ??
      errorText.match(
        /\b(?:selftest|fixture|benchmark|fake|judge)_[a-z0-9_:-]+/i,
      )?.[0] ??
      'selftest_unexpected_error';
    const handling = code.includes('image')
      ? '处理提示：按交接文档构建当前 checkout 的 Runner 镜像，并设置 BENCH_CONTAINER_IMAGE 后重试。'
      : code.includes('docker')
        ? '处理提示：启动 Docker daemon，确认当前用户可访问 Docker，再重试自检。'
        : code.includes('fixture') || code.includes('mcp')
          ? '处理提示：检查 Docker bridge 网关、fixture MCP 启动日志和 fixture.jsonl。'
          : code.includes('upstream') || code.includes('timeout')
            ? '处理提示：检查假 Anthropic 服务场景和 Runner 的 provider_failure/终态轨迹。'
            : code.includes('report') || code.includes('leak')
              ? '处理提示：检查 summary.json、复评产物及公开报告泄漏校验。'
              : '处理提示：查看保留的合成 artifacts 中 summary.json、trace.json 和 service 日志，按错误码定位失败阶段。';
    process.stderr.write(`错误码: ${code}\n${handling}\n`);
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
    const detail = error as Error & { stderr?: string };
    const errorText = `${detail.stderr ?? ''}\n${detail.message ?? ''}`;
    const code =
      errorText.match(/错误码:\s*([a-z][a-z0-9_:-]+)/i)?.[1] ??
      errorText.match(
        /\b(?:selftest|fixture|benchmark|fake|judge)_[a-z0-9_:-]+/i,
      )?.[0] ??
      'selftest_unexpected_error';
    const hint = code.includes('image')
      ? '按 docs/BENCHMARK-HANDOFF.md 构建当前源码 Runner 镜像。'
      : code.includes('docker') ||
          code.includes('fixture') ||
          code.includes('mcp')
        ? '检查 Docker daemon、Linux bridge gateway 地址和 fixture MCP 日志。'
        : code.includes('upstream') || code.includes('timeout')
          ? '检查假服务响应脚本与 Runner provider_failure 终态轨迹。'
          : '查看保留的 synthetic artifacts 中 summary.json、trace.json 和服务日志。';
    process.stderr.write(`错误码: ${code}\n处理提示：${hint}\n`);
    process.exitCode = 1;
  });
