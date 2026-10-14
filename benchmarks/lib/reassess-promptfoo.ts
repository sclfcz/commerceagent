import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { parse } from 'yaml';
import { buildAgentProfilePrompt } from '../../src/agent-profile-prompts.js';
import { auditFixtureCalls } from '../assertions/audit.js';
import { assertSpike } from '../assertions/spike.js';
import {
  assertBusinessCase,
  fixtureStateMatchesLedger,
  loadBusinessCases,
  parseFixtureVariant,
  type BusinessCase,
  type FixtureState,
} from './cases.js';
import { FreshStateTracker } from './fresh-state.js';
import { officialVendor, requiresGatewayAudit } from './identity.js';
import { readUsage } from './usage.js';
import {
  assessMcpRuntime,
  countSuccessfulFixtureCalls,
  readMcpRuntimeEvidence,
} from './mcp-runtime.js';
import {
  countClassifications,
  measurementValidityGate,
  summarizeCandidates,
} from './assessment.js';
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
import { loadProfileVariant } from './profile-variants.js';
import { verifyInterruptionEvidence } from './interruption-evidence.js';
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
  mcpRuntimeReady?: boolean;
  toolUnavailable?: boolean;
  fixtureBypass?: boolean;
  onlyAllowedTools: boolean;
  businessPass: boolean;
  gateway: boolean;
}) {
  const measurementFailure: Failure | null =
    input.transportFailure ||
    (input.fixtureBypass
      ? 'fixture_bypass'
      : input.toolUnavailable || input.mcpRuntimeReady === false
        ? 'tool_unavailable'
        : !input.usageComplete || !input.scopeIsolated
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
    measurementFailure ||
    (businessFailure === 'tool_policy_violation' && businessFailure) ||
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
  profileDefinition: Record<string, any>,
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
  ) as Array<SpikeCase | BusinessCase>;
  const summaryFile = path.join(runDirectory, 'summary.json');
  const metadataFile = path.join(runDirectory, 'run-metadata.json');
  const runMetadata = {
    ...(fs.existsSync(metadataFile)
      ? JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
      : {}),
    ...(fs.existsSync(summaryFile)
      ? JSON.parse(fs.readFileSync(summaryFile, 'utf8'))
      : {}),
  };
  const copiedSplits = [
    ...new Set(
      copiedCases
        .filter((test): test is BusinessCase => 'split' in test)
        .map((test) => test.split),
    ),
  ];
  const inferredSplit = copiedSplits.length === 1 ? copiedSplits[0] : undefined;
  const savedSummary = {
    ...runMetadata,
    ...(runMetadata.split === undefined && inferredSplit
      ? { split: inferredSplit }
      : {}),
  };
  const splitValid =
    savedSummary.split === undefined ||
    ((savedSummary.split === 'dev' || savedSummary.split === 'holdout') &&
      (savedSummary.split === 'holdout'
        ? savedSummary.finalRun === true &&
          savedSummary.cumulativeHoldoutRuns === 1
        : savedSummary.finalRun !== true) &&
      copiedCases.every(
        (test) => 'split' in test && test.split === savedSummary.split,
      ));
  const defaultProfileFile = fileURLToPath(
    new URL('../profile.yaml', import.meta.url),
  );
  const usedProfileFile = path.join(runDirectory, 'profile.used.yaml');
  const profileVariantIds: string[] = savedSummary.profileVariants ?? [
    savedSummary.profileVariant ?? 'default',
  ];
  const profileVariantId =
    profileVariantIds.length === 1 ? profileVariantIds[0] : 'joint';
  const profileFile = fs.existsSync(usedProfileFile)
    ? usedProfileFile
    : defaultProfileFile;
  let profileVariantMatch = true;
  const profileVariantSourceHashes: Record<string, string> = {};
  const profileDefinitions = new Map<string, Record<string, any>>();
  for (const variantId of profileVariantIds) {
    if (variantId === 'default') continue;
    try {
      const sourceVariant = loadProfileVariant(
        variantId,
        fileURLToPath(new URL('../', import.meta.url)),
      );
      const variantProfileFile = path.join(
        runDirectory,
        `profile.${variantId}.used.yaml`,
      );
      const resolvedProfileFile = fs.existsSync(variantProfileFile)
        ? variantProfileFile
        : profileFile;
      const profileDefinition = parse(
        fs.readFileSync(resolvedProfileFile, 'utf8'),
      ) as Record<string, any>;
      profileDefinitions.set(variantId, profileDefinition);
      const variantMetadata = JSON.parse(
        fs.readFileSync(
          fs.existsSync(
            path.join(runDirectory, `profile.${variantId}.variant.json`),
          )
            ? path.join(runDirectory, `profile.${variantId}.variant.json`)
            : path.join(runDirectory, 'profile.variant.json'),
          'utf8',
        ),
      );
      profileVariantSourceHashes[variantId] = sourceVariant.definitionHash;
      const expectedProfileHash =
        savedSummary.profileHashes?.[variantId] ?? savedSummary.profileHash;
      const expectedDefinitionHash =
        savedSummary.profileDefinitionHashes?.[variantId] ??
        savedSummary.profileDefinitionHash;
      profileVariantMatch =
        hash(profileDefinition) === sourceVariant.profileHash &&
        variantMetadata.id === sourceVariant.id &&
        variantMetadata.profileHash === sourceVariant.profileHash &&
        variantMetadata.definitionHash === sourceVariant.definitionHash &&
        expectedProfileHash === sourceVariant.profileHash &&
        expectedDefinitionHash === sourceVariant.definitionHash &&
        profileVariantMatch;
    } catch {
      profileVariantMatch = false;
    }
  }
  const caseFile = fileURLToPath(
    new URL('../cases/spike.yaml', import.meta.url),
  );
  const legacyCases = parse(fs.readFileSync(caseFile, 'utf8')) as SpikeCase[];
  const selectedCases =
    savedSummary.split === 'dev' || savedSummary.split === 'holdout'
      ? loadBusinessCases(savedSummary.split)
      : [];
  const sourceCases: Array<SpikeCase | BusinessCase> = [
    ...legacyCases,
    ...selectedCases,
  ];
  const sourceCaseById = new Map(sourceCases.map((test) => [test.id, test]));
  const casesMatchSource =
    copiedCases.length > 0 &&
    copiedCases.every(
      (test) => hash(test) === hash(sourceCaseById.get(test.id) ?? null),
    );
  const caseSourceFiles = [
    caseFile,
    ...(savedSummary.split === 'dev' || savedSummary.split === 'holdout'
      ? fs
          .readdirSync(
            fileURLToPath(
              new URL(`../cases/${savedSummary.split}/`, import.meta.url),
            ),
          )
          .filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'))
          .map((file) =>
            fileURLToPath(
              new URL(
                `../cases/${savedSummary.split}/${file}`,
                import.meta.url,
              ),
            ),
          )
      : []),
  ].sort();
  const fixtureSourceFiles = fs
    .readdirSync(fileURLToPath(new URL('../fixtures/', import.meta.url)), {
      withFileTypes: true,
    })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      fs
        .readdirSync(
          fileURLToPath(new URL(`../fixtures/${entry.name}/`, import.meta.url)),
        )
        .filter((file) => file.endsWith('.json'))
        .map((file) =>
          fileURLToPath(
            new URL(`../fixtures/${entry.name}/${file}`, import.meta.url),
          ),
        ),
    )
    .sort();
  const promptfooFile = path.join(runDirectory, 'promptfoo/results.json');
  const promptfooResults = JSON.parse(fs.readFileSync(promptfooFile, 'utf8'));
  const promptfooByIndex = new Map<number, Record<string, any>>();
  for (const entry of promptfooResults) {
    const metadata = entry.response?.metadata;
    if (Number.isSafeInteger(metadata?.actualExecutionIndex))
      promptfooByIndex.set(metadata.actualExecutionIndex, entry);
  }

  const freshStates = new FreshStateTracker();
  if (!profileDefinitions.has('default'))
    profileDefinitions.set(
      'default',
      parse(fs.readFileSync(profileFile, 'utf8')) as Record<string, any>,
    );
  const reassessed: Array<Record<string, any>> = [];
  let evidenceComplete = true;
  let fixtureDefinitionsMatch = true;
  let fixtureStatesReconciled = true;
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
    const candidate = candidates.find(
      (entry) => entry.alias === row.candidateAlias,
    );
    const rowProfileVariant = row.profileVariant ?? profileVariantId;
    const profileDefinition = profileDefinitions.get(rowProfileVariant);
    const test = sourceCaseById.get(row.caseId);
    if (!candidate || !test || !profileDefinition)
      throw new Error('assessment_identity_missing');
    const fixtureSnapshotFile = path.join(
      attemptDirectory,
      'fixture-snapshot.json',
    );
    const fixtureStateFile = path.join(attemptDirectory, 'fixture-state.json');
    const mcpRuntimeEvidenceFile = path.join(
      attemptDirectory,
      'mcp-runtime-evidence.json',
    );
    const freshEvidenceForPath = fs.existsSync(freshStateFile)
      ? JSON.parse(fs.readFileSync(freshStateFile, 'utf8'))
      : null;
    const mcpLogDirectory = path.join(
      attemptDirectory,
      'service/data-eval/groups',
      freshEvidenceForPath?.groupFolder ?? '',
      'logs',
    );
    const mcpLogFiles = fs.existsSync(mcpLogDirectory)
      ? fs
          .readdirSync(mcpLogDirectory)
          .filter((name) => name.endsWith('.log'))
          .map((name) => path.join(mcpLogDirectory, name))
      : [];
    const sourceFiles = [
      traceFile,
      ledgerFile,
      contextFile,
      freshStateFile,
      databaseFile,
      ...('fixture_variant' in test
        ? [fixtureSnapshotFile, fixtureStateFile]
        : []),
    ];
    const missingEvidence = sourceFiles.some((file) => !fs.existsSync(file));
    const gateway = requiresGatewayAudit(
      candidate.baseUrl,
      typeof candidate.gatewayDeclared === 'boolean'
        ? candidate.gatewayDeclared
        : candidate.gateway === true,
      candidate.model,
    );
    if (missingEvidence) {
      const interruption = verifyInterruptionEvidence({
        directory: attemptDirectory,
        candidate: row.candidateAlias,
        caseId: row.caseId,
        executionIndex: index,
      });
      let partialTrace: Record<string, any> | null = null;
      if (fs.existsSync(traceFile)) {
        try {
          partialTrace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
        } catch {
          partialTrace = null;
        }
      }
      const partialFailure =
        interruption?.failure ??
        (partialTrace?.failure === 'upstream_error' ||
        partialTrace?.failure === 'queue_timeout' ||
        partialTrace?.failure === 'run_timeout' ||
        partialTrace?.failure === 'stream_disconnected' ||
        partialTrace?.failure === 'runner_exit' ||
        partialTrace?.failure === 'stopped' ||
        partialTrace?.failure === 'released'
          ? partialTrace.failure
          : 'collection_incomplete');
      if (!interruption) evidenceComplete = false;
      reassessed.push({
        candidate: row.candidateAlias,
        caseId: row.caseId,
        profileVariant:
          row.profileVariant ??
          (profileVariantId === 'default' ? undefined : profileVariantId),
        repetition: row.repetition,
        executionIndex: index,
        measurementValid: false,
        qualityEligible: false,
        pass: false,
        measurementFailure: partialFailure,
        businessFailure: null,
        failure: partialFailure,
        businessPass: null,
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
          terminalClassified: partialTrace?.reason != null,
          usageReconciled: false,
          contextVerified: false,
        },
        sourceHashes: Object.fromEntries(
          sourceFiles
            .filter((file) => fs.existsSync(file))
            .map((file) => [path.basename(file), sha256(file)]),
        ),
        ...(interruption
          ? {
              interruptionEvidenceHash: sha256(
                path.join(attemptDirectory, 'interruption.json'),
              ),
            }
          : {}),
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
      profileDefinition,
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
    let fixtureDefinitionVerified: boolean | null = null;
    const fixtureState =
      'fixture_variant' in test
        ? (JSON.parse(
            fs.readFileSync(fixtureStateFile, 'utf8'),
          ) as FixtureState)
        : undefined;
    const fixtureStateReconciled = fixtureState
      ? fixtureStateMatchesLedger(ledger, fixtureState)
      : true;
    fixtureStatesReconciled &&= fixtureStateReconciled;
    const fixtureVariant =
      'fixture_variant' in test
        ? (() => {
            const snapshot = JSON.parse(
              fs.readFileSync(fixtureSnapshotFile, 'utf8'),
            );
            const source = parseFixtureVariant(test.fixture_variant);
            const matchesSource = hash(snapshot) === hash(source);
            fixtureDefinitionVerified = matchesSource;
            fixtureDefinitionsMatch &&= matchesSource;
            return {
              data: snapshot.data,
              variant: snapshot.variant,
              config: snapshot.config,
            };
          })()
        : null;
    const business = fixtureVariant
      ? assertBusinessCase(
          trace.output,
          test as BusinessCase,
          fixtureVariant,
          ledger,
          trace.tools,
          fixtureState,
        )
      : assertSpike(trace.output, test as SpikeCase, ledger, trace.tools);
    const audit = auditFixtureCalls(ledger, trace.tools);
    const mcpEvidence = readMcpRuntimeEvidence(mcpLogDirectory);
    const mcpRuntime = fixtureVariant
      ? assessMcpRuntime(mcpEvidence, test as BusinessCase)
      : {
          ready:
            mcpEvidence?.mcpServers.some(
              (server) => server.status === 'connected',
            ) ?? false,
        };
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
      auditMatched: audit.matched && fixtureStateReconciled,
      mcpRuntimeReady: mcpRuntime.ready,
      toolUnavailable: audit.toolUnavailableCalls.length > 0,
      fixtureBypass: audit.bypassedFixtureCalls.length > 0,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
      gateway,
    });
    reassessed.push({
      candidate: candidate.alias,
      caseId: test.id,
      profileVariant:
        row.profileVariant ??
        (profileVariantId === 'default' ? undefined : profileVariantId),
      repetition: row.repetition,
      executionIndex: index,
      ...assessment,
      businessPass: business.pass,
      businessChecks: business.checks,
      fixtureStateReconciled,
      caseDefinitionVerified: casesMatchSource,
      fixtureDefinitionVerified,
      gatewayVerificationRequired: gateway,
      sdkModelMatches: folderRows.identityVerified,
      identityBasis:
        officialVendor(candidate.baseUrl) && !gateway
          ? 'official_endpoint_sdk'
          : 'gateway_pending',
      gates: {
        modelIdentity: folderRows.identityVerified && !gateway,
        independentFixture: audit.matched && fixtureStateReconciled,
        mcpRuntimeReady: mcpRuntime.ready,
        toolUnavailable: audit.toolUnavailableCalls.length > 0,
        fixtureBypass: audit.bypassedFixtureCalls.length > 0,
        fixtureStateReconciled,
        freshState,
        terminalClassified: trace.reason !== null,
        usageReconciled: usageComplete && folderRows.scopeIsolated,
        contextVerified: context.verified,
      },
      usage: folderRows.usage,
      fixtureAudit: audit,
      elapsedMs: trace.elapsedMs ?? null,
      logicalRunMs: trace.logicalRunMs ?? null,
      sourceHashes: Object.fromEntries(
        [...sourceFiles, ...mcpLogFiles, mcpRuntimeEvidenceFile]
          .filter((file) => fs.existsSync(file))
          .map((file) => [path.relative(attemptDirectory, file), sha256(file)]),
      ),
    });
  }

  const independentParity = validateAssessmentParity(
    reassessed,
    [...promptfooByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, result]) => result),
  );
  const successfulFixtureCalls = countSuccessfulFixtureCalls(reassessed as any);
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
    fs.readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    fs.readFileSync(
      new URL('../mcp-fixture-server/server.ts', import.meta.url),
      'utf8',
    ),
    fs.readFileSync(
      new URL('../providers/commerceagent-provider.ts', import.meta.url),
      'utf8',
    ),
    fs.readFileSync(new URL('../scripts/report.ts', import.meta.url), 'utf8'),
    fs.readFileSync(new URL('./profile-variants.ts', import.meta.url), 'utf8'),
  ]);
  const report = {
    schemaVersion: 1,
    source: 'trace-fixture-ledger-messages-db-context-fresh-state',
    reassessmentMethod: {
      contextExpectedSnapshotUsed: false,
      contextExpectedRecomputedFrom:
        'versioned-profile-and-observed-runtime-evidence',
      fixtureMcpStatusAndRequiredToolsRecomputedFrom:
        'Runner SDK system/init logs',
      gatewayMarkerRecomputedFromCandidateEndpointAndDeclaration: true,
      fixtureStateRecomputedFromLedger: true,
    },
    runId: path.basename(runDirectory),
    profileVariant: profileVariantId === 'joint' ? null : profileVariantId,
    profileVariants: profileVariantIds,
    profileVariantMatch,
    sourceHashes: {
      executionSequence: sha256(executionFile),
      order: sha256(orderFile),
      promptfooResults: sha256(promptfooFile),
      candidateMatrix: sha256(path.join(runDirectory, 'candidates.json')),
      runMetadata: fs.existsSync(metadataFile) ? sha256(metadataFile) : null,
      cases: sha256(path.join(runDirectory, 'cases.used.json')),
      caseDefinition: hash(
        caseSourceFiles.map((file) => [
          path.relative(path.dirname(caseFile), file),
          sha256(file),
        ]),
      ),
      fixtureDefinitions: hash(
        fixtureSourceFiles.map((file) => [
          path.relative(path.dirname(caseFile), file),
          sha256(file),
        ]),
      ),
      profileDefinition:
        profileVariantIds.length > 1
          ? Object.fromEntries(
              profileVariantIds.map((id) => [
                id,
                sha256(path.join(runDirectory, `profile.${id}.used.yaml`)),
              ]),
            )
          : sha256(profileFile),
      profileVariantDefinition: profileVariantSourceHashes,
    },
    reassessmentRevision: revisionHash,
    evidenceComplete,
    executionOrderValid: order.valid,
    split: savedSummary.split ?? null,
    finalRun: savedSummary.finalRun ?? false,
    splitValid,
    fixtureDefinitionsMatch,
    fixtureStatesReconciled,
    cumulativeHoldoutRuns: savedSummary.cumulativeHoldoutRuns ?? null,
    providerParityValid: independentParity.valid,
    providerParityMismatchIndex: independentParity.mismatchIndex,
    providerParityMismatchFields: independentParity.mismatchFields ?? [],
    successfulFixtureCalls,
    attempts: reassessed.length,
    measurementValidAttempts: reassessed.filter((row) => row.measurementValid)
      .length,
    measurementValidityGate: measurementValidityGate({
      split: savedSummary.split,
      caseCount: copiedCases.length,
      attempts: reassessed.length,
      expectedAttempts: savedOrder.expectedAttempts,
      validAttempts: reassessed.filter((row) => row.measurementValid).length,
    }),
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
      !splitValid ||
      !profileVariantMatch ||
      !fixtureDefinitionsMatch ||
      !fixtureStatesReconciled ||
      !order.valid ||
      !independentParity.valid ||
      (reassessed.some((row) => row.gates?.mcpRuntimeReady !== undefined) &&
        successfulFixtureCalls === 0) ||
      reassessed.length !== savedOrder.expectedAttempts,
    results: reassessed,
  };
  privateJson(path.join(runDirectory, 'reassessed.json'), report);
  return report;
}
