import { auditFixtureCalls } from '../assertions/audit.js';
import { assertSpike } from '../assertions/spike.js';
import {
  assertBusinessCase,
  fixtureStateMatchesLedger,
  type ToolRequirement,
  parseFixtureVariant,
  type BusinessCase,
} from './cases.js';
import { buildAgentProfilePrompt } from '../../src/agent-profile-prompts.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  hash,
  renderCasePrompts,
  privateJson,
  workspaceBaseline,
  type Candidate,
  type SpikeCase,
} from './contracts.js';
import { startFixtureServer } from '../mcp-fixture-server/server.js';
import {
  observeTurn,
  type TurnObservation,
} from '../providers/commerceagent-provider.js';
import {
  buildFixtureTurnEvidence,
  verifyTraceTurnEvidence,
} from './turn-evidence.js';
import { buildCapabilityCoverageAttempt } from './capability-coverage.js';
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
import { assessMcpRuntime, readMcpRuntimeEvidence } from './mcp-runtime.js';
import { persistInterruptionEvidence } from './interruption-evidence.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const bench = path.join(repositoryRoot, 'benchmarks');
const execFileAsync = promisify(execFile);

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part)))
    return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

/**
 * Linux Docker's host-gateway resolves to the host-side bridge address. Bind
 * only that address so bridge containers can reach the fixture without
 * exposing it on every host interface. Docker Desktop keeps its loopback path.
 */
export async function fixtureBindHost(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  inspectBridgeGateway: () => Promise<string> = async () => {
    const result = await execFileAsync(
      'docker',
      [
        'network',
        'inspect',
        'bridge',
        '--format',
        '{{(index .IPAM.Config 0).Gateway}}',
      ],
      { timeout: 5000, maxBuffer: 16 * 1024 },
    );
    return result.stdout.trim();
  },
): Promise<string> {
  const configured = environment.BENCH_FIXTURE_BIND_HOST?.trim();
  if (configured && platform !== 'linux') return configured;
  if (platform !== 'linux') return '127.0.0.1';
  let gateway = '';
  try {
    gateway = await inspectBridgeGateway();
  } catch {
    throw new Error('fixture_docker_bridge_gateway_unavailable');
  }
  if (isIP(gateway) !== 4 || !isPrivateIpv4(gateway))
    throw new Error('fixture_docker_bridge_gateway_invalid');
  if (configured && configured !== gateway)
    throw new Error('fixture_bind_host_must_be_docker_bridge_gateway');
  return gateway;
}

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
  test: SpikeCase | BusinessCase,
  directory: string,
  candidates: Candidate[],
  context: AttemptContext,
  repetition: number,
  profileSelection?: {
    id: string;
    profile: Record<string, any>;
    definitionHash: string;
  },
) {
  const { repository, pinnedImage, timeoutMs, freshStates } = context;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sourceHash = runtimeSourceHash(repository);
  if (sourceHash !== context.expectedRuntimeSourceHash)
    throw new ContextFailure();
  const isBusinessCase = 'fixture_variant' in test;
  const fixtureVariant = isBusinessCase
    ? parseFixtureVariant(test.fixture_variant)
    : null;
  const fixtureData =
    fixtureVariant?.data ??
    JSON.parse(
      fs.readFileSync(path.join(bench, 'fixtures/commerce.json'), 'utf8'),
    );
  if (fixtureVariant)
    privateJson(path.join(directory, 'fixture-snapshot.json'), {
      data: fixtureVariant.data,
      variant: fixtureVariant.variant,
      config: fixtureVariant.config,
    });
  const profile =
    profileSelection?.profile ??
    (parse(fs.readFileSync(path.join(bench, 'profile.yaml'), 'utf8')) as Record<
      string,
      any
    >);
  const fixtureHost = await fixtureBindHost();
  const fixture = await startFixtureServer({
    data: fixtureData,
    scenario: isBusinessCase ? 'normal' : test.scenario,
    ...(fixtureVariant ? { variantConfig: fixtureVariant.config } : {}),
    allowHostGateway: process.platform === 'linux',
    includeWorkflowWrites:
      isBusinessCase && (test as BusinessCase).tags.includes('write-operation'),
    ledgerFile: path.join(directory, 'fixture.jsonl'),
    host: fixtureHost,
  });
  let service: Awaited<ReturnType<typeof startService>> | null = null;
  let turnObserved = false;
  let stage = 'service_start';
  let interrupted: {
    failure: 'environment' | 'context_mismatch' | 'collection_incomplete';
    error: unknown;
  } | null = null;
  try {
    service = await startService({
      repository,
      directory: path.join(directory, 'service'),
      image: pinnedImage,
      timeoutMs,
    });
    stage = 'bootstrap';
    const api = new EvalApi(service.baseUrl, 60000);
    const runtime = await bootstrap(
      api,
      candidate,
      profile,
      service.data,
      candidates,
      (bootstrapStage) => {
        stage = `bootstrap_${bootstrapStage}`;
      },
    );
    stage = 'fixture_bridge_install';
    fs.copyFileSync(
      path.join(bench, 'mcp-fixture-server/bridge.mjs'),
      path.join(runtime.groupDir, 'fixture-bridge.mjs'),
    );
    stage = 'workspace_baseline';
    const workspaceBaselineHash = workspaceBaseline(runtime.groupDir);
    const evidence = {
      ...service.creationEvidence,
      initialDatabase: runtime.initialDatabase,
      dataDirectory: service.data,
      userId: runtime.userId,
      groupFolder: runtime.folder,
      sessionId: runtime.sessionId,
      workspaceJid: runtime.workspaceJid,
      userAbsentBeforeSetup: runtime.userAbsentBeforeSetup,
      sessionAbsentBeforeCreate: runtime.sessionAbsentBeforeCreate,
      sessionOwned: runtime.sessionOwned,
      sessionEmpty: runtime.sessionEmpty,
      workspaceBaselineHash,
    };
    const freshState = freshStates.verify(evidence);
    stage = 'fresh_state_persist';
    privateJson(path.join(directory, 'fresh-state.json'), evidence);
    privateJson(path.join(runtime.groupDir, '.fixture-connection.json'), {
      url: `http://host.docker.internal:${fixture.port}/rpc`,
      token: fixture.token,
    });
    const route = `/api/agent-profiles/${runtime.profile.id}/effective-capabilities`;
    stage = 'capability_preview';
    const preview = await api.request(route, {
      workspace_jid: runtime.workspaceJid,
      runtime_session_id: runtime.sessionId,
    });
    const turnPrompts = renderCasePrompts(test);
    const turnObservations: Array<{
      observation: TurnObservation;
      fixtureSequenceStart: number;
      fixtureSequenceEnd: number;
    }> = [];
    stage = 'turn_observation';
    for (const prompt of turnPrompts) {
      const fixtureSequenceStart = (fixture.ledger.at(-1)?.sequence ?? 0) + 1;
      const turn = await observeTurn({
        baseUrl: service.baseUrl,
        cookie: api.cookie,
        workspaceJid: runtime.workspaceJid,
        sessionId: runtime.sessionId,
        prompt,
        timeoutMs,
      });
      turnObserved = true;
      turnObservations.push({
        observation: turn,
        fixtureSequenceStart,
        fixtureSequenceEnd:
          fixture.ledger.at(-1)?.sequence ?? fixtureSequenceStart - 1,
      });
      if (turn.failure) break;
    }
    const finalTurn = turnObservations.at(-1)!.observation;
    const capturedTurns = turnObservations.map(
      (
        { observation: turn, fixtureSequenceStart, fixtureSequenceEnd },
        index,
      ) => ({
        turnIndex: index + 1,
        runId: turn.runId,
        turnId: turn.turnId,
        messageTurnId: turn.messageTurnId,
        reason: turn.reason,
        failure: turn.failure,
        fixtureSequenceStart,
        fixtureSequenceEnd,
        streamTools: turn.tools,
        output: turn.output,
      }),
    );
    const perTurnFixtureEvidence = buildFixtureTurnEvidence({
      turns: capturedTurns,
      ledger: fixture.ledger,
      expectedTurnCount: turnPrompts.length,
    });
    const observation = {
      ...finalTurn,
      output: finalTurn.output,
      tools: turnObservations.flatMap((entry) => entry.observation.tools),
      apiRequests: turnObservations.flatMap(
        (entry) => entry.observation.apiRequests,
      ),
      trace: turnObservations.flatMap((entry, index) =>
        entry.observation.trace.map((event) => ({
          ...event,
          turnIndex: index + 1,
        })),
      ),
      elapsedMs: turnObservations.reduce(
        (total, entry) => total + entry.observation.elapsedMs,
        0,
      ),
      logicalRunMs: turnObservations.every(
        (entry) => entry.observation.logicalRunMs !== null,
      )
        ? turnObservations.reduce(
            (total, entry) => total + entry.observation.logicalRunMs!,
            0,
          )
        : null,
      failure:
        turnObservations.find((entry) => entry.observation.failure)?.observation
          .failure ?? null,
      expectedTurnCount: turnPrompts.length,
      turns: capturedTurns,
      perTurnFixtureEvidence,
    };
    const turnEvidenceCheck = verifyTraceTurnEvidence({
      trace: observation,
      ledger: fixture.ledger,
      expectedTurnCount: turnPrompts.length,
    });
    observation.perTurnFixtureEvidence = turnEvidenceCheck.evidence;
    const turnEvidenceMatched = turnEvidenceCheck.matched;
    stage = 'trace_persist';
    privateJson(path.join(directory, 'trace.json'), observation);
    stage = 'post_turn_context';
    const after = await api.request(route, {
      workspace_jid: runtime.workspaceJid,
      runtime_session_id: runtime.sessionId,
    });
    const actualContext = after.run_context as ContextEvidence | null;
    const expectedContext = {
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
    };
    stage = 'context_evidence_persist';
    privateJson(path.join(directory, 'context-evidence.json'), {
      actual: actualContext,
      expected: expectedContext,
    });
    const contextEvidence = verifyContext(actualContext, expectedContext);
    // Container Runner log lines are flushed when the per-attempt service
    // exits. Stop it before reading SDK init and usage evidence so both the
    // live result and independent reassessment observe the same durable DB.
    const serviceData = service.data;
    stage = 'service_shutdown';
    if (service) {
      await stopService(service.child);
      service = null;
    }
    stage = 'usage_reconciliation';
    const usage = readUsage(
      path.join(serviceData, 'db/messages.db'),
      {
        userId: runtime.userId,
        groupFolder: runtime.folder,
        sessionId: runtime.sessionId,
      },
      candidate.model,
    );
    const business = isBusinessCase
      ? assertBusinessCase(
          observation.output,
          test,
          fixtureVariant!,
          fixture.ledger,
          observation.tools,
          fixture.state,
        )
      : assertSpike(
          observation.output,
          test,
          fixture.ledger,
          observation.tools,
        );
    const audit = auditFixtureCalls(fixture.ledger, observation.tools);
    const mcpRuntimeEvidence = readMcpRuntimeEvidence(
      path.join(serviceData, 'groups', runtime.folder, 'logs'),
    );
    const mcpRuntime = isBusinessCase
      ? assessMcpRuntime(mcpRuntimeEvidence, test as BusinessCase)
      : {
          ready:
            mcpRuntimeEvidence?.mcpServers.some(
              (server) => server.status === 'connected',
            ) ?? false,
        };
    privateJson(path.join(directory, 'mcp-runtime-evidence.json'), {
      evidence: mcpRuntimeEvidence,
      assessment: mcpRuntime,
    });
    const fixtureStateReconciled = fixtureStateMatchesLedger(
      fixture.ledger,
      fixture.state,
    );
    const auditMatched = audit.matched && fixtureStateReconciled;
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
      auditMatched,
      turnEvidenceMatched,
      mcpRuntimeReady: mcpRuntime.ready,
      toolUnavailable: audit.toolUnavailableCalls.length > 0,
      fixtureBypass: audit.bypassedFixtureCalls.length > 0,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway: candidate.gateway,
    });
    const result = {
      candidate: candidate.alias,
      caseId: test.id,
      profileVariant: profileSelection?.id ?? 'default',
      profileDefinitionHash: profileSelection?.definitionHash ?? null,
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
        independentFixture: auditMatched,
        perTurnFixtureEvidence: turnEvidenceMatched,
        mcpRuntimeReady: mcpRuntime.ready,
        toolUnavailable: audit.toolUnavailableCalls.length > 0,
        fixtureBypass: audit.bypassedFixtureCalls.length > 0,
        fixtureStateReconciled,
        freshState,
        terminalClassified: observation.reason !== null,
        usageReconciled: usageComplete && usage.scopeIsolated,
        contextVerified: contextEvidence.verified,
      },
      contextFingerprint: contextEvidence.fingerprint,
      observedPromptHashes: contextEvidence.observedPromptHashes,
      caseHash: hash(test),
      requestPromptHash: hash(turnPrompts),
      runtimeSourceHash: sourceHash,
      workspaceBaselineHash,
      profileContentHash: hash(profile),
      fixtureHash: hash({
        data: fixtureData,
        variant:
          fixtureVariant?.variant ??
          ('scenario' in test ? test.scenario : null),
        config: fixtureVariant?.config ?? null,
      }),
      toolSchemaHash: hash(
        (await import('../mcp-fixture-server/server.js')).definitionsForFixture(
          isBusinessCase &&
            (test as BusinessCase).tags.includes('write-operation'),
          fixtureData,
        ),
      ),
      fixtureStateHash: hash(fixture.state),
      fixtureStateReconciled,
      fixtureAudit: audit,
      perTurnFixtureEvidence: turnEvidenceCheck.evidence,
      capabilityEvidence: buildCapabilityCoverageAttempt({
        category: isBusinessCase ? (test as BusinessCase).category : 'spike',
        selectedSkillIds: actualContext?.skills.selectedSkillIds ?? [],
        selectedMcpServers: actualContext?.mcp.serverIds ?? [],
        availableFixtureTools: mcpRuntimeEvidence?.fixtureTools ?? [],
        fixtureRuntimeStatus:
          mcpRuntimeEvidence?.mcpServers.find(
            (server) => server.name === 'commerce_fixture',
          )?.status ?? 'missing',
        requiredTools: isBusinessCase
          ? (test as BusinessCase).tools.required
          : ((test as SpikeCase).requiredTools.map((requirement) => ({
              name: requirement.name,
              arguments: requirement.arguments,
            })) as ToolRequirement[]),
        calls: fixture.ledger,
        turns: perTurnFixtureEvidence.turns,
        turnEvidenceComplete: turnEvidenceMatched,
        routingOracleDeclared: false,
      }),
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
    stage = 'result_persist';
    return persistAttemptResult(directory, result, repetition);
  } catch (error) {
    interrupted = {
      failure:
        error instanceof ContextFailure
          ? 'context_mismatch'
          : turnObserved
            ? 'collection_incomplete'
            : 'environment',
      error,
    };
    if (error instanceof ContextFailure) throw error;
    if (turnObserved) throw new CollectionFailure();
    throw error;
  } finally {
    try {
      if (service) await stopService(service.child);
    } finally {
      try {
        if (isBusinessCase)
          privateJson(
            path.join(directory, 'fixture-state.json'),
            fixture.state,
          );
        await fixture.close();
      } finally {
        if (interrupted)
          persistInterruptionEvidence({
            directory,
            candidate: candidate.alias,
            caseId: test.id,
            failure: interrupted.failure,
            stage,
            turnObserved,
            error: interrupted.error,
          });
      }
    }
  }
}
