import { auditFixtureCalls } from '../assertions/audit.js';
import {
  assessAttempt,
  rotateCandidates,
  summarizeCandidates,
} from '../lib/assessment.js';
import { FreshStateTracker } from '../lib/fresh-state.js';
import { officialVendor } from '../lib/identity.js';
import { openCodeGoCandidate } from '../lib/opencode-go.js';
import { buildAgentProfilePrompt } from '../../src/agent-profile-prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import {
  hash,
  renderCasePrompt,
  parseCandidates,
  privateJson,
  workspaceBaseline,
  type Candidate,
  type SpikeCase,
} from '../lib/contracts.js';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import { observeTurn } from '../providers/commerceagent-provider.js';
import { assertSpike } from '../assertions/spike.js';
import { readUsage } from '../lib/usage.js';
import {
  profilePromptHashes,
  verifyContext,
  type ContextEvidence,
} from '../lib/context.js';
import {
  startService,
  stopService,
  EvalApi,
  bootstrap,
  stopOwnedServices,
} from '../lib/service.js';
import { importExisting } from '../lib/existing.js';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const bench = path.join(repository, 'benchmarks');
const image =
  process.env.BENCH_CONTAINER_IMAGE || 'riba2534/happyclaw-agent:latest';
let pinnedImage = image;
let expectedRuntimeSourceHash: string | null = null;
function runtimeSourceHash(): string {
  return hash({
    host: workspaceBaseline(path.join(repository, 'src')),
    runner: workspaceBaseline(
      path.join(repository, 'container/agent-runner/src'),
    ),
    prompts: workspaceBaseline(
      path.join(repository, 'container/agent-runner/prompts'),
    ),
  });
}
const freshStates = new FreshStateTracker();
const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || 180000);
class CollectionFailure extends Error {}
class ContextFailure extends Error {}

async function preflight(runDirectory: string) {
  expectedRuntimeSourceHash = runtimeSourceHash();
  let docker = false;
  let imagePresent = false;
  let imageHash: string | null = null;
  try {
    await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 15000,
    });
    docker = true;
  } catch {
    /* report only booleans */
  }
  if (docker)
    try {
      const result = await exec(
        'docker',
        ['image', 'inspect', image, '--format', '{{.Id}}'],
        { timeout: 15000 },
      );
      imageHash = result.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageHash))
        throw new Error('image_identity');
      pinnedImage = imageHash;
      imagePresent = true;
    } catch {
      /* never pull implicitly */
    }
  let candidates: Candidate[] = [];
  let configured = false;
  let credentials = false;
  try {
    if (process.argv.includes('--existing')) {
      candidates = await importExisting(repository, runDirectory);
      configured = true;
      credentials = candidates.every(
        (candidate) => !!process.env[candidate.apiKeyEnv]?.trim(),
      );
    } else if (process.env.BENCH_CANDIDATES_FILE) {
      candidates = parseCandidates(
        parse(fs.readFileSync(process.env.BENCH_CANDIDATES_FILE, 'utf8')),
      );
      configured = true;
      credentials = candidates.every(
        (candidate) => !!process.env[candidate.apiKeyEnv]?.trim(),
      );
    }
  } catch {
    /* don't print endpoint/config parse errors */
  }
  if (process.argv.includes('--with-opencode-go')) {
    const go = openCodeGoCandidate(candidates);
    if (!process.env[go.apiKeyEnv]?.trim()) credentials = false;
    candidates = parseCandidates([...candidates, go]);
    privateJson(path.join(runDirectory, 'candidates.json'), candidates);
  }
  privateJson(path.join(runDirectory, 'candidates.json'), candidates);
  return {
    docker,
    imagePresent,
    imageHash,
    configured,
    credentials,
    candidates,
    runtimeSourceHash: expectedRuntimeSourceHash,
    timeoutValid:
      Number.isSafeInteger(timeoutMs) &&
      timeoutMs >= 1000 &&
      timeoutMs <= 1800000,
  };
}

async function attempt(
  candidate: Candidate,
  test: SpikeCase,
  directory: string,
  candidates: Candidate[],
) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHash = runtimeSourceHash();
  if (sourceHash !== expectedRuntimeSourceHash) throw new ContextFailure();
  const fixtureData = JSON.parse(
    fs.readFileSync(path.join(bench, 'fixtures/commerce.json'), 'utf8'),
  );
  const profile = parse(
    fs.readFileSync(path.join(bench, 'profile.yaml'), 'utf8'),
  );
  const fixture = await startFixtureServer({
    data: fixtureData,
    scenario: test.scenario,
    ledgerFile: path.join(directory, 'fixture.jsonl'),
    host: process.env.BENCH_FIXTURE_BIND_HOST || '127.0.0.1',
  });
  let service: Awaited<ReturnType<typeof startService>> | null = null;
  let turnObserved = false;
  try {
    service = await startService({
      repository,
      directory: path.join(directory, 'service'),
      image: pinnedImage,
      timeoutMs,
    });
    const api = new EvalApi(service.baseUrl);
    const runtime = await bootstrap(
      api,
      candidate,
      profile,
      service.data,
      candidates,
    );
    fs.copyFileSync(
      path.join(bench, 'mcp-fixture-server/bridge.mjs'),
      path.join(runtime.groupDir, 'fixture-bridge.mjs'),
    );
    const workspaceBaselineHash = workspaceBaseline(runtime.groupDir);
    const freshStateEvidence = {
      ...service.creationEvidence,
      initialDatabase: runtime.initialDatabase,
      dataDirectory: service.data,
      userId: runtime.userId,
      sessionId: runtime.sessionId,
      workspaceJid: runtime.workspaceJid,
      userAbsentBeforeSetup: runtime.userAbsentBeforeSetup,
      sessionAbsentBeforeCreate: runtime.sessionAbsentBeforeCreate,
      sessionOwned: runtime.sessionOwned,
      sessionEmpty: runtime.sessionEmpty,
      workspaceBaselineHash,
    };
    const freshState = freshStates.verify(freshStateEvidence);
    privateJson(path.join(directory, 'fresh-state.json'), freshStateEvidence);
    privateJson(path.join(runtime.groupDir, '.fixture-connection.json'), {
      url: `http://host.docker.internal:${fixture.port}/rpc`,
      token: fixture.token,
    });
    const route = `/api/agent-profiles/${runtime.profile.id}/effective-capabilities`;
    const preview = await api.request(route, {
      workspace_jid: runtime.workspaceJid,
      runtime_session_id: runtime.sessionId,
    });
    const observation = await observeTurn({
      baseUrl: service.baseUrl,
      cookie: api.cookie,
      workspaceJid: runtime.workspaceJid,
      sessionId: runtime.sessionId,
      prompt: renderCasePrompt(test),
      timeoutMs,
    });
    turnObserved = true;
    privateJson(path.join(directory, 'trace.json'), observation);
    const after = await api.request(route, {
      workspace_jid: runtime.workspaceJid,
      runtime_session_id: runtime.sessionId,
    });
    const context = verifyContext(after.run_context as ContextEvidence | null, {
      ...profilePromptHashes(
        {
          id: runtime.profile.id,
          name: runtime.profile.name,
          version: runtime.profile.version,
          identityHash: runtime.profile.identity_hash,
          identityPrompt: buildAgentProfilePrompt(runtime.profile),
        },
        runtime.profile.prompt_mode === 'append',
      ),
      profileId: runtime.profile.id,
      version: runtime.profile.version,
      identityHash: runtime.profile.identity_hash,
      runtimePolicyHash: hash(runtime.profile.runtime_policy),
      skillsHash: preview.preview.skills.manifestHash,
      mcpHash: preview.preview.mcp.manifestHash,
      sessionId: runtime.sessionId,
      turnId: observation.turnId,
    });
    const usage = readUsage(
      path.join(service.data, 'db/messages.db'),
      {
        userId: runtime.userId,
        groupFolder: runtime.folder,
        sessionId: runtime.sessionId,
      },
      candidate.model,
    );
    const business = assertSpike(
      observation.output,
      test,
      fixture.ledger,
      observation.tools,
    );
    const audit = auditFixtureCalls(fixture.ledger, observation.tools);
    const usageComplete =
      usage.known &&
      !!usage.usage &&
      usage.usage.inputTokens +
        usage.usage.cacheReadInputTokens +
        usage.usage.cacheCreationInputTokens >
        0 &&
      (!observation.output || usage.usage.outputTokens > 0);
    if (runtimeSourceHash() !== sourceHash) throw new ContextFailure();
    const assessment = assessAttempt({
      transportFailure: observation.failure,
      usageComplete,
      scopeIsolated: usage.scopeIsolated,
      sdkModelMatches: usage.identityVerified,
      contextVerified: context.verified,
      freshState,
      auditMatched: audit.matched,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway: candidate.gateway,
    });
    const result = {
      candidate: candidate.alias,
      caseId: test.id,
      ...assessment,
      businessPass: business.pass,
      gatewayVerificationRequired: candidate.gateway,
      sdkModelMatches: usage.identityVerified,
      identityBasis:
        officialVendor(candidate.baseUrl) && !candidate.gateway
          ? 'official_endpoint_sdk'
          : 'gateway_pending',
      upstreamRequestIdCount: observation.apiRequests.length,
      profileBindingVerified:
        runtime.profile.model_config_id === runtime.providerId,
      provisionedBindings: runtime.bindings,
      unexpectedUsageRecords: usage.unexpectedRecordCount,
      gates: {
        modelIdentity: usage.identityVerified && !candidate.gateway,
        independentFixture: audit.matched,
        freshState,
        terminalClassified: observation.reason !== null,
        usageReconciled: usageComplete && usage.scopeIsolated,
        contextVerified: context.verified,
      },
      contextFingerprint: context.fingerprint,
      observedPromptHashes: context.observedPromptHashes,
      caseHash: hash(test),
      requestPromptHash: hash(renderCasePrompt(test)),
      runtimeSourceHash: sourceHash,
      workspaceBaselineHash,
      profileContentHash: hash(profile),
      fixtureHash: hash(fixtureData),
      toolSchemaHash: hash(
        (await import('../mcp-fixture-server/server.js')).toolDefinitions,
      ),
      usage: usageComplete ? usage.usage : null,
      ledgerReconciled: usage.known,
      elapsedMs: observation.elapsedMs,
      logicalRunMs: observation.logicalRunMs,
      business: business.checks,
    };
    // Private synthetic response artifact, never echoed or published.
    privateJson(path.join(directory, 'result.json'), result);
    return result;
  } catch (error) {
    if (error instanceof ContextFailure) throw error;
    if (turnObserved) throw new CollectionFailure();
    throw error;
  } finally {
    if (service) await stopService(service.child);
    await fixture.close();
  }
}

export async function main() {
  const runDir = path.join(
    bench,
    'results',
    `spike-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const checks = await preflight(runDir);
  const safePreflight = {
    runtimeSourceHash: checks.runtimeSourceHash,
    docker: checks.docker,
    imagePresent: checks.imagePresent,
    imageHash: checks.imageHash,
    candidateConfigured: checks.configured,
    credentialsPresent: checks.credentials,
    timeoutValid: checks.timeoutValid,
  };
  privateJson(path.join(runDir, 'preflight.json'), safePreflight);
  const ready =
    checks.docker &&
    checks.imagePresent &&
    checks.configured &&
    checks.credentials &&
    checks.timeoutValid;
  if (process.argv.includes('--preflight') || !ready) {
    process.stdout.write(
      JSON.stringify({ stage: 'preflight', ready, ...safePreflight }) + '\n',
    );
    if (!ready) process.exitCode = 1;
    return;
  }
  const allCases = parse(
    fs.readFileSync(path.join(bench, 'cases/spike.yaml'), 'utf8'),
  ) as SpikeCase[];
  privateJson(path.join(runDir, 'cases.used.json'), allCases);
  const smoke = process.argv.includes('--smoke');
  const cases = smoke
    ? allCases.slice(0, checks.candidates.length > 1 ? 2 : 1)
    : allCases;
  const repetitions = smoke ? 1 : 3;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    void stopOwnedServices();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const results: Array<Record<string, any>> = [];
  // Three independent repetitions. Rotate candidates per case/repetition.
  attempts: for (let repetition = 0; repetition < repetitions; repetition++)
    for (let caseIndex = 0; caseIndex < cases.length; caseIndex++) {
      const rotated = rotateCandidates(
        checks.candidates,
        caseIndex,
        repetition,
      );
      for (const candidate of rotated) {
        if (cancelled) break attempts;
        const test = cases[caseIndex];
        const directory = path.join(
          runDir,
          `${test.id}-${candidate.alias}-${repetition + 1}`,
        );
        try {
          results.push({
            ...(await attempt(candidate, test, directory, checks.candidates)),
            repetition: repetition + 1,
          });
        } catch (error) {
          const result = {
            candidate: candidate.alias,
            caseId: test.id,
            repetition: repetition + 1,
            pass: false,
            failure:
              error instanceof ContextFailure
                ? 'context_mismatch'
                : error instanceof CollectionFailure
                  ? 'collection_incomplete'
                  : 'environment',
          };
          privateJson(path.join(directory, 'result.json'), result);
          results.push(result);
        }
        const latest = results.at(-1)!;
        process.stdout.write(
          JSON.stringify({
            caseId: latest.caseId,
            candidate: latest.candidate,
            repetition: latest.repetition,
            measurementValid: latest.measurementValid ?? false,
            businessPass: latest.businessPass ?? false,
            identityPending: latest.gatewayVerificationRequired ?? false,
            failure: latest.failure,
          }) + '\n',
        );
      }
    }
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
  const fingerprints = results.map((result) =>
    result.contextFingerprint ? hash(result.contextFingerprint) : null,
  );
  const contextReproducible =
    fingerprints.every(Boolean) &&
    new Set(fingerprints).size === 1 &&
    results.every((result) => result.workspaceBaselineHash) &&
    new Set(results.map((result) => result.workspaceBaselineHash)).size === 1;
  const chainPassed =
    !cancelled &&
    results.length === cases.length * repetitions * checks.candidates.length &&
    results.every(
      (result) => result.measurementValid && result.gates?.freshState,
    ) &&
    contextReproducible;
  const identityVerified = results.every(
    (result) => result.gates?.modelIdentity,
  );
  const passed = chainPassed && identityVerified && !smoke;
  const report = {
    schemaVersion: 3,
    chainPassed,
    identityVerified,
    identityByCandidate: summarizeCandidates(results as any),
    stage: smoke ? 'smoke' : 'spike',
    cancelled,
    scope: 'synthetic-query-analysis',
    passed,
    contextReproducible,
    coldStartOnly: true,
    attempts: results.length,
    passedAttempts: results.filter((result) => result.pass).length,
    businessPassedAttempts: results.filter((result) => result.businessPass)
      .length,
    technicalPassedAttempts: results.filter((result) => result.measurementValid)
      .length,
    runtimeSourceHash: checks.runtimeSourceHash,
    results,
  };
  privateJson(path.join(runDir, 'summary.json'), report);
  process.stdout.write(
    JSON.stringify({
      stage: smoke ? 'smoke' : 'spike',
      passed,
      chainPassed,
      identityVerified,
      identityByCandidate: report.identityByCandidate,
      businessPassedAttempts: report.businessPassedAttempts,
      contextReproducible,
      attempts: report.attempts,
      passedAttempts: report.passedAttempts,
    }) + '\n',
  );
  if (!(smoke ? chainPassed : passed)) process.exitCode = cancelled ? 130 : 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void main().catch(() => {
    process.stderr.write(
      'benchmark spike failed; no provider diagnostics printed\n',
    );
    process.exitCode = 1;
  });
