import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { buildAgentProfilePrompt } from '../../src/agent-profile-prompts.js';
import { auditFixtureCalls } from '../assertions/audit.js';
import { assertSpike } from '../assertions/spike.js';
import { FreshStateTracker } from './fresh-state.js';
import { officialVendor, requiresGatewayAudit } from './identity.js';
import { readUsage } from './usage.js';
import { countClassifications, summarizeCandidates } from './assessment.js';
import {
  hash,
  privateJson,
  type Failure,
  type SpikeCase,
  type ToolCall,
} from './contracts.js';
import {
  profilePromptHashes,
  verifyContext,
  type ContextEvidence,
} from './context.js';
import {
  validateAssessmentParity,
  validateExecutionOrder,
} from '../promptfoo/build-tests.js';

const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Independent copy by design: this assessment consumes only reconstructed
// facts from preserved evidence, never the live attempt's classification.
function assessFromEvidence(input: {
  transportFailure: Failure | null;
  usageComplete: boolean;
  scopeIsolated: boolean;
  sdkModelMatches: boolean;
  contextVerified: boolean;
  freshState: boolean;
  auditMatched: boolean;
  onlyAllowedTools: boolean;
  businessPass: boolean;
  gateway: boolean;
}) {
  const measurementFailure: Failure | null =
    input.transportFailure ||
    (!input.usageComplete || !input.scopeIsolated
      ? 'collection_incomplete'
      : !input.freshState
        ? 'state_not_fresh'
        : !input.contextVerified
          ? 'context_mismatch'
          : !input.auditMatched
            ? 'audit_mismatch'
            : !input.sdkModelMatches
              ? 'model_identity'
              : null);
  const businessFailure: Failure | null = !input.onlyAllowedTools
    ? 'tool_policy_violation'
    : !input.businessPass
      ? 'business_assertion'
      : null;
  const failure =
    input.transportFailure ||
    (businessFailure === 'tool_policy_violation' && businessFailure) ||
    measurementFailure ||
    (input.gateway ? 'model_identity' : businessFailure);
  return {
    measurementFailure,
    businessFailure,
    failure,
    measurementValid: measurementFailure === null,
    qualityEligible: measurementFailure === null && !input.gateway,
    pass: measurementFailure === null && !input.gateway && input.businessPass,
  };
}

function readLedger(file: string): ToolCall[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ToolCall);
}

function deriveExpectedContext(
  databaseFile: string,
  profileFile: string,
  actual: ContextEvidence | null,
  fresh: Record<string, any>,
  trace: Record<string, any>,
) {
  if (
    !actual?.agentProfile ||
    !actual.skills.manifestHash ||
    !actual.mcp.manifestHash
  )
    return null;
  const profileDefinition = parse(
    fs.readFileSync(profileFile, 'utf8'),
  ) as Record<string, any>;
  const db = new Database(databaseFile, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const profile = db
      .prepare(
        'SELECT * FROM agent_profiles WHERE id = ? AND owner_user_id = ?',
      )
      .get(actual.agentProfile.id, fresh.userId) as
      | Record<string, any>
      | undefined;
    if (!profile) return null;
    const runtimePolicy = JSON.parse(profile.runtime_policy);
    const sourcePolicy = profileDefinition.runtime_policy ?? {};
    const expectedPolicy = {
      reasoning: { effort: sourcePolicy.reasoning?.effort ?? 'inherit' },
      context: {
        source: sourcePolicy.context?.source ?? 'managed',
        auto_compact_window: sourcePolicy.context?.auto_compact_window ?? 0,
        auto_compact_percentage:
          sourcePolicy.context?.auto_compact_percentage ?? 0,
      },
      skills: {
        mode: sourcePolicy.skills?.mode ?? 'inherit',
        ids: sourcePolicy.skills?.ids ?? [],
        ...(sourcePolicy.skills?.host
          ? {
              host: {
                mode: sourcePolicy.skills.host.mode ?? 'disabled',
                ids: sourcePolicy.skills.host.ids ?? [],
              },
            }
          : {}),
      },
      mcp: {
        mode: sourcePolicy.mcp?.mode ?? 'inherit',
        ids: sourcePolicy.mcp?.ids ?? [],
      },
    };
    const promptsMatch =
      profile.name === profileDefinition.name &&
      Number(profile.version) === 1 &&
      profile.identity_prompt === (profileDefinition.identity_prompt ?? '') &&
      profile.soul_prompt === (profileDefinition.soul_prompt ?? '') &&
      profile.agents_prompt === (profileDefinition.agents_prompt ?? '') &&
      profile.tools_prompt === (profileDefinition.tools_prompt ?? '') &&
      profile.prompt_mode === profileDefinition.prompt_mode &&
      JSON.stringify(runtimePolicy) === JSON.stringify(expectedPolicy);
    const hashes = profilePromptHashes(
      {
        id: profile.id,
        name: profile.name,
        version: profile.version,
        identityHash: profile.identity_hash,
        identityPrompt: buildAgentProfilePrompt(profile),
      },
      profile.prompt_mode === 'append',
    );
    if (!promptsMatch) return null;
    return {
      ...hashes,
      profileId: profile.id,
      version: Number(profile.version),
      identityHash: profile.identity_hash,
      runtimePolicyHash: hash(runtimePolicy),
      // Skills and MCP hashes are captured in the independent run-context
      // stream snapshot. Their allowed IDs are checked against profile.yaml.
      skillsHash: actual.skills.manifestHash,
      mcpHash: actual.mcp.manifestHash,
      sessionId: fresh.sessionId,
      turnId: trace.turnId ?? null,
    };
  } finally {
    db.close();
  }
}

export function reassessPromptfoo(runDirectory: string) {
  const executionFile = path.join(runDirectory, 'execution-sequence.jsonl');
  const execution = fs
    .readFileSync(executionFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const orderFile = path.join(runDirectory, 'execution-order.json');
  const savedOrder = JSON.parse(fs.readFileSync(orderFile, 'utf8'));
  const order = validateExecutionOrder(savedOrder.expected, savedOrder.actual);
  const candidates = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'candidates.json'), 'utf8'),
  ) as Array<Record<string, any>>;
  const copiedCases = JSON.parse(
    fs.readFileSync(path.join(runDirectory, 'cases.used.json'), 'utf8'),
  ) as SpikeCase[];
  const profileFile = fileURLToPath(
    new URL('../profile.yaml', import.meta.url),
  );
  const caseFile = fileURLToPath(
    new URL('../cases/spike.yaml', import.meta.url),
  );
  const sourceCases = parse(fs.readFileSync(caseFile, 'utf8')) as SpikeCase[];
  const sourceCaseById = new Map(sourceCases.map((test) => [test.id, test]));
  const casesMatchSource =
    copiedCases.length > 0 &&
    copiedCases.every(
      (test) => hash(test) === hash(sourceCaseById.get(test.id) ?? null),
    );
  const promptfooFile = path.join(runDirectory, 'promptfoo/results.json');
  const promptfooResults = JSON.parse(fs.readFileSync(promptfooFile, 'utf8'));
  const promptfooByIndex = new Map<number, Record<string, any>>();
  for (const entry of promptfooResults) {
    const metadata = entry.response?.metadata;
    if (Number.isSafeInteger(metadata?.actualExecutionIndex))
      promptfooByIndex.set(metadata.actualExecutionIndex, entry);
  }

  const freshStates = new FreshStateTracker();
  const reassessed: Array<Record<string, any>> = [];
  let evidenceComplete = true;
  for (const row of execution.sort(
    (left, right) => left.executionIndex - right.executionIndex,
  )) {
    const index = Number(row.executionIndex);
    const attemptDirectory = path.join(
      runDirectory,
      `promptfoo-${String(index).padStart(4, '0')}`,
    );
    const traceFile = path.join(attemptDirectory, 'trace.json');
    const ledgerFile = path.join(attemptDirectory, 'fixture.jsonl');
    const contextFile = path.join(attemptDirectory, 'context-evidence.json');
    const freshStateFile = path.join(attemptDirectory, 'fresh-state.json');
    const databaseFile = path.join(
      attemptDirectory,
      'service/data-eval/db/messages.db',
    );
    const sourceFiles = [
      traceFile,
      ledgerFile,
      contextFile,
      freshStateFile,
      databaseFile,
    ];
    const candidate = candidates.find(
      (entry) => entry.alias === row.candidateAlias,
    );
    const test = sourceCases.find((entry) => entry.id === row.caseId);
    if (!candidate || !test) throw new Error('assessment_identity_missing');
    const missingEvidence = sourceFiles.some((file) => !fs.existsSync(file));
    const gateway = requiresGatewayAudit(
      candidate.baseUrl,
      typeof candidate.gatewayDeclared === 'boolean'
        ? candidate.gatewayDeclared
        : candidate.gateway === true,
      candidate.model,
    );
    if (missingEvidence) {
      evidenceComplete = false;
      reassessed.push({
        candidate: row.candidateAlias,
        caseId: row.caseId,
        repetition: row.repetition,
        executionIndex: index,
        measurementValid: false,
        qualityEligible: false,
        pass: false,
        measurementFailure: 'collection_incomplete',
        businessFailure: null,
        failure: 'collection_incomplete',
        businessPass: false,
        gatewayVerificationRequired: gateway,
        sdkModelMatches: false,
        identityBasis:
          officialVendor(candidate.baseUrl) && !gateway
            ? 'official_endpoint_sdk'
            : 'gateway_pending',
        gates: {
          modelIdentity: false,
          independentFixture: false,
          freshState: false,
          terminalClassified: false,
          usageReconciled: false,
          contextVerified: false,
        },
        sourceHashes: Object.fromEntries(
          sourceFiles
            .filter((file) => fs.existsSync(file))
            .map((file) => [path.basename(file), sha256(file)]),
        ),
      });
      continue;
    }

    const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
    const ledger = readLedger(ledgerFile);
    const contextEvidence = JSON.parse(
      fs.readFileSync(contextFile, 'utf8'),
    ) as { actual: ContextEvidence | null; expected?: Record<string, any> };
    const freshEvidence = JSON.parse(fs.readFileSync(freshStateFile, 'utf8'));
    const expectedContext = deriveExpectedContext(
      databaseFile,
      profileFile,
      contextEvidence.actual,
      freshEvidence,
      trace,
    );
    const context = expectedContext
      ? verifyContext(contextEvidence.actual, expectedContext)
      : { verified: false, observedPromptHashes: [], fingerprint: null };
    const freshState = freshStates.verify(freshEvidence);
    const folderRows = readUsage(
      databaseFile,
      {
        userId: freshEvidence.userId,
        groupFolder: freshEvidence.groupFolder,
        sessionId: freshEvidence.sessionId,
      },
      candidate.model,
    );
    const business = assertSpike(trace.output, test, ledger, trace.tools);
    const audit = auditFixtureCalls(ledger, trace.tools);
    const usageComplete =
      folderRows.known &&
      !!folderRows.usage &&
      folderRows.usage.inputTokens +
        folderRows.usage.cacheReadInputTokens +
        folderRows.usage.cacheCreationInputTokens >
        0 &&
      (!trace.output || folderRows.usage.outputTokens > 0);
    const assessment = assessFromEvidence({
      transportFailure: trace.failure ?? null,
      usageComplete,
      scopeIsolated: folderRows.scopeIsolated,
      sdkModelMatches: folderRows.identityVerified,
      contextVerified: context.verified,
      freshState,
      auditMatched: audit.matched,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway,
    });
    reassessed.push({
      candidate: candidate.alias,
      caseId: test.id,
      repetition: row.repetition,
      executionIndex: index,
      ...assessment,
      businessPass: business.pass,
      businessChecks: business.checks,
      caseDefinitionVerified: casesMatchSource,
      gatewayVerificationRequired: gateway,
      sdkModelMatches: folderRows.identityVerified,
      identityBasis:
        officialVendor(candidate.baseUrl) && !gateway
          ? 'official_endpoint_sdk'
          : 'gateway_pending',
      gates: {
        modelIdentity: folderRows.identityVerified && !gateway,
        independentFixture: audit.matched,
        freshState,
        terminalClassified: trace.reason !== null,
        usageReconciled: usageComplete && folderRows.scopeIsolated,
        contextVerified: context.verified,
      },
      usage: folderRows.usage,
      elapsedMs: trace.elapsedMs ?? null,
      logicalRunMs: trace.logicalRunMs ?? null,
      sourceHashes: Object.fromEntries(
        sourceFiles.map((file) => [path.basename(file), sha256(file)]),
      ),
    });
  }

  const independentParity = validateAssessmentParity(
    reassessed,
    [...promptfooByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, result]) => result),
  );
  const revisionHash = hash([
    fs.readFileSync(new URL('../assertions/spike.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('../assertions/audit.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./assessment.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./fresh-state.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./usage.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./context.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./metrics.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./public-report.ts', import.meta.url), 'utf8'),
    fs.readFileSync(
      new URL('../promptfoo/build-tests.ts', import.meta.url),
      'utf8',
    ),
    fs.readFileSync(
      new URL('./reassess-promptfoo.ts', import.meta.url),
      'utf8',
    ),
    fs.readFileSync(new URL('../scripts/report.ts', import.meta.url), 'utf8'),
  ]);
  const report = {
    schemaVersion: 1,
    source: 'trace-fixture-ledger-messages-db-context-fresh-state',
    runId: path.basename(runDirectory),
    sourceHashes: {
      executionSequence: sha256(executionFile),
      order: sha256(orderFile),
      promptfooResults: sha256(promptfooFile),
      candidateMatrix: sha256(path.join(runDirectory, 'candidates.json')),
      cases: sha256(path.join(runDirectory, 'cases.used.json')),
      caseDefinition: sha256(caseFile),
      profileDefinition: sha256(profileFile),
    },
    reassessmentRevision: revisionHash,
    evidenceComplete,
    executionOrderValid: order.valid,
    providerParityValid: independentParity.valid,
    providerParityMismatchIndex: independentParity.mismatchIndex,
    providerParityMismatchFields: independentParity.mismatchFields ?? [],
    attempts: reassessed.length,
    measurementValidAttempts: reassessed.filter((row) => row.measurementValid)
      .length,
    businessPassedAttempts: reassessed.filter((row) => row.businessPass).length,
    failureCounts: countClassifications(reassessed, 'failure'),
    measurementFailureCounts: countClassifications(
      reassessed,
      'measurementFailure',
    ),
    businessFailureCounts: countClassifications(reassessed, 'businessFailure'),
    identityByCandidate: summarizeCandidates(reassessed as any),
    invalidRun:
      !evidenceComplete ||
      !casesMatchSource ||
      !order.valid ||
      !independentParity.valid ||
      reassessed.length !== savedOrder.expectedAttempts,
    results: reassessed,
  };
  privateJson(path.join(runDirectory, 'reassessed.json'), report);
  return report;
}
