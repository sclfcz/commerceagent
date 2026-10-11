import { auditFixtureCalls } from '../assertions/audit.js';
import { assertSpike } from '../assertions/spike.js';
import { buildAgentProfilePrompt } from '../../src/agent-profile-prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  hash,
  renderCasePrompt,
  privateJson,
  workspaceBaseline,
  type Candidate,
  type SpikeCase,
} from './contracts.js';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import { observeTurn } from '../providers/commerceagent-provider.js';
import { readUsage } from './usage.js';
import {
  profilePromptHashes,
  verifyContext,
  type ContextEvidence,
} from './context.js';
import { startService, stopService, EvalApi, bootstrap } from './service.js';
import { assessAttempt } from './assessment.js';
import { FreshStateTracker } from './fresh-state.js';
import { officialVendor } from './identity.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const bench = path.join(repositoryRoot, 'benchmarks');

export function runtimeSourceHash(repository: string): string {
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

export interface AttemptContext {
  repository: string;
  pinnedImage: string;
  timeoutMs: number;
  expectedRuntimeSourceHash: string;
  freshStates: FreshStateTracker;
}

export function createAttemptContext(
  input: Omit<AttemptContext, 'freshStates'>,
): AttemptContext {
  return { ...input, freshStates: new FreshStateTracker() };
}

export class CollectionFailure extends Error {}
export class ContextFailure extends Error {}

export function persistAttemptResult(
  directory: string,
  result: Record<string, unknown>,
  repetition: number,
) {
  const completed = { ...result, repetition };
  privateJson(path.join(directory, 'result.json'), completed);
  return completed;
}

export async function attempt(
  candidate: Candidate,
  test: SpikeCase,
  directory: string,
  candidates: Candidate[],
  context: AttemptContext,
  repetition: number,
) {
  const { repository, pinnedImage, timeoutMs, freshStates } = context;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHash = runtimeSourceHash(repository);
  if (sourceHash !== context.expectedRuntimeSourceHash)
    throw new ContextFailure();
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
    const evidence = {
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
    const freshState = freshStates.verify(evidence);
    privateJson(path.join(directory, 'fresh-state.json'), evidence);
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
    const contextEvidence = verifyContext(
      after.run_context as ContextEvidence | null,
      {
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
      },
    );
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
    if (runtimeSourceHash(repository) !== sourceHash)
      throw new ContextFailure();
    const assessment = assessAttempt({
      transportFailure: observation.failure,
      usageComplete,
      scopeIsolated: usage.scopeIsolated,
      sdkModelMatches: usage.identityVerified,
      contextVerified: contextEvidence.verified,
      freshState,
      auditMatched: audit.matched,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway: candidate.gateway,
    });
    const result = {
      candidate: candidate.alias,
      caseId: test.id,
      repetition,
      output: observation.output,
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
        contextVerified: contextEvidence.verified,
      },
      contextFingerprint: contextEvidence.fingerprint,
      observedPromptHashes: contextEvidence.observedPromptHashes,
      caseHash: hash(test),
      requestPromptHash: hash(renderCasePrompt(test)),
      runtimeSourceHash: sourceHash,
      workspaceBaselineHash,
      profileContentHash: hash(profile),
      fixtureHash: hash(fixtureData),
      toolSchemaHash: hash(
        (await import('../mcp-fixture-server/server.js')).toolDefinitions,
      ),
      fixtureLedgerSummary: fixture.ledger.map((call) => ({
        name: call.name,
        arguments: call.arguments,
        success: call.success,
      })),
      usage: usageComplete ? usage.usage : null,
      ledgerReconciled: usage.known,
      elapsedMs: observation.elapsedMs,
      logicalRunMs: observation.logicalRunMs,
      business: business.checks,
    };
    return persistAttemptResult(directory, result, repetition);
  } catch (error) {
    if (error instanceof ContextFailure) throw error;
    if (turnObserved) throw new CollectionFailure();
    throw error;
  } finally {
    if (service) await stopService(service.child);
    await fixture.close();
  }
}
