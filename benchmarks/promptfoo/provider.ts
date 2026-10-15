import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  attempt,
  CollectionFailure,
  ContextFailure,
  createAttemptContext,
} from '../lib/attempt.js';
import {
  hash,
  renderCasePrompt,
  parseCandidates,
  privateJson,
  type Candidate,
  type SpikeCase,
} from '../lib/contracts.js';
import type { BusinessCase } from '../lib/cases.js';
import { calculateCost, loadPrices } from '../lib/pricing.js';
import { officialVendor } from '../lib/identity.js';
import { loadProfileVariant } from '../lib/profile-variants.js';
import type {
  ApiProvider,
  CallApiContextParams,
  ProviderOptions,
  ProviderResponse,
} from 'promptfoo';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const benchmarkDirectory = path.join(repository, 'benchmarks');

function safeDiagnosticCode(error: unknown): string | null {
  const value = error as { code?: unknown; message?: unknown } | null;
  if (typeof value?.code === 'string' && /^[A-Z0-9_]+$/.test(value.code))
    return value.code;
  if (
    typeof value?.message === 'string' &&
    /^[a-z][a-z0-9_:-]+$/i.test(value.message)
  )
    return value.message;
  return null;
}

interface CandidateRunState {
  candidates: Candidate[];
  cases: Array<SpikeCase | BusinessCase>;
  context: ReturnType<typeof createAttemptContext>;
  prices: ReturnType<typeof loadPrices>;
  runDirectory: string;
  profileVariants: Map<
    string,
    { id: string; profile: Record<string, any>; definitionHash: string }
  >;
  actualExecutionIndex: number;
}

let statePromise: Promise<CandidateRunState> | undefined;
let failedStateCalls = 0;

export function providerResponse(
  result: Record<string, any>,
  actualExecutionIndex: number,
  expectedExecutionIndex: number,
  cost: number | null,
): ProviderResponse {
  const usage = result.usage || null;
  return {
    output:
      result.measurementValid !== false &&
      actualExecutionIndex === expectedExecutionIndex &&
      typeof result.output === 'string'
        ? result.output
        : '',
    ...(usage
      ? {
          tokenUsage: {
            prompt:
              usage.inputTokens +
              usage.cacheReadInputTokens +
              usage.cacheCreationInputTokens,
            completion: usage.outputTokens,
            cached: usage.cacheReadInputTokens,
            total:
              usage.inputTokens +
              usage.cacheReadInputTokens +
              usage.cacheCreationInputTokens +
              usage.outputTokens,
            completionDetails: {
              reasoning: usage.reasoningTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              cacheCreationInputTokens: usage.cacheCreationInputTokens,
            },
          },
        }
      : {}),
    ...(cost === null ? {} : { cost }),
    metadata: {
      ...result,
      actualExecutionIndex,
      expectedExecutionIndex,
      orderValid: actualExecutionIndex === expectedExecutionIndex,
      cost,
      costStatus: cost === null ? 'unknown' : 'known',
      fixtureLedgerSummary: result.fixtureLedgerSummary || null,
    },
  };
}

async function getState(): Promise<CandidateRunState> {
  if (!statePromise) {
    statePromise = Promise.resolve().then(() => {
      const runDirectory = process.env.BENCH_RUN_DIRECTORY;
      if (!runDirectory) throw new Error('run_directory_missing');
      const candidates = parseCandidates(
        JSON.parse(
          fs.readFileSync(path.join(runDirectory, 'candidates.json'), 'utf8'),
        ),
      );
      const cases = JSON.parse(
        fs.readFileSync(path.join(runDirectory, 'cases.used.json'), 'utf8'),
      ) as Array<SpikeCase | BusinessCase>;
      const runMetadataPath = path.join(runDirectory, 'run-metadata.json');
      const runMetadata = fs.existsSync(runMetadataPath)
        ? JSON.parse(fs.readFileSync(runMetadataPath, 'utf8'))
        : {};
      const ids: string[] = runMetadata.profileVariants ?? [
        runMetadata.profileVariant ?? 'baseline',
      ];
      const profileVariants = new Map();
      for (const id of ids) {
        const source = loadProfileVariant(id, benchmarkDirectory);
        const profileFile = path.join(runDirectory, `profile.${id}.used.yaml`);
        const profile = parse(
          fs.readFileSync(
            fs.existsSync(profileFile)
              ? profileFile
              : path.join(runDirectory, 'profile.used.yaml'),
            'utf8',
          ),
        ) as Record<string, any>;
        if (hash(profile) !== source.profileHash)
          throw new Error('profile_definition_mismatch');
        profileVariants.set(id, {
          id,
          profile,
          definitionHash: source.definitionHash,
        });
      }
      const pinnedImage = process.env.BENCH_PINNED_IMAGE || '';
      const expectedRuntimeSourceHash =
        process.env.BENCH_RUNTIME_SOURCE_HASH || '';
      const timeoutMs = Number(process.env.BENCH_TIMEOUT_MS || 180000);
      if (
        !/^sha256:[a-f0-9]{64}$/.test(pinnedImage) ||
        !/^[a-f0-9]{64}$/.test(expectedRuntimeSourceHash)
      )
        throw new Error('runtime_identity_missing');
      return {
        candidates,
        cases,
        context: createAttemptContext({
          repository,
          pinnedImage,
          timeoutMs,
          expectedRuntimeSourceHash,
        }),
        prices: loadPrices(path.join(benchmarkDirectory, 'pricing.yaml')),
        runDirectory,
        profileVariants,
        actualExecutionIndex: 0,
      };
    });
  }
  return statePromise;
}

export default class CommerceAgentProvider implements ApiProvider {
  constructor(
    private readonly options: ProviderOptions = { id: 'commerceagent' },
  ) {}

  id(): string {
    return this.options.id || 'commerceagent';
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
  ): Promise<ProviderResponse> {
    const requestedProfileVariant = String(
      context?.vars?.profileVariant ??
        process.env.BENCH_PROFILE_VARIANT ??
        'baseline',
    );
    let run: CandidateRunState;
    try {
      run = await getState();
    } catch {
      const actualExecutionIndex = ++failedStateCalls;
      const expectedExecutionIndex = Number(
        context?.vars?.expectedExecutionIndex,
      );
      return providerResponse(
        {
          measurementValid: false,
          qualityEligible: false,
          pass: false,
          profileVariant: requestedProfileVariant,
          measurementFailure: 'collection_incomplete',
          businessFailure: null,
          failure: 'environment',
        },
        actualExecutionIndex,
        expectedExecutionIndex,
        null,
      );
    }
    const vars = context?.vars || {};
    const candidateAlias = String(vars.candidateAlias || '');
    const caseId = String(vars.caseId || '');
    const repetition = Number(vars.repetition);
    const profileVariant = String(vars.profileVariant || 'baseline');
    const selectedProfile = run.profileVariants.get(profileVariant);
    const expectedExecutionIndex = Number(vars.expectedExecutionIndex);
    const actualExecutionIndex = ++run.actualExecutionIndex;
    const candidate = run.candidates.find(
      (entry) => entry.alias === candidateAlias,
    );
    const test = run.cases.find((entry) => entry.id === caseId);
    let result: Record<string, any>;
    let orderValid = actualExecutionIndex === expectedExecutionIndex;
    let failure: string | null = null;

    if (
      !candidate ||
      !test ||
      !selectedProfile ||
      !Number.isSafeInteger(repetition) ||
      repetition < 1
    ) {
      failure = 'invalid_test_row';
      result = {
        candidate: candidateAlias,
        caseId,
        profileVariant,
        measurementValid: false,
        qualityEligible: false,
        pass: false,
        failure,
      };
    } else if (hash(vars.prompt) !== hash(renderCasePrompt(test))) {
      failure = 'prompt_mismatch';
      result = {
        candidate: candidateAlias,
        caseId,
        profileVariant,
        measurementValid: false,
        qualityEligible: false,
        pass: false,
        failure,
      };
    } else {
      const attemptDirectory = path.join(
        run.runDirectory,
        `promptfoo-${String(actualExecutionIndex).padStart(4, '0')}`,
      );
      try {
        result = await attempt(
          candidate,
          test,
          attemptDirectory,
          run.candidates,
          run.context,
          repetition,
          selectedProfile,
        );
      } catch (error) {
        failure =
          error instanceof ContextFailure
            ? 'context_mismatch'
            : error instanceof CollectionFailure
              ? 'collection_incomplete'
              : 'environment';
        let trace: Record<string, any> | null = null;
        const traceFile = path.join(attemptDirectory, 'trace.json');
        if (fs.existsSync(traceFile)) {
          try {
            trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
          } catch {
            trace = null;
          }
        }
        result = {
          candidate: candidate.alias,
          caseId,
          profileVariant,
          repetition,
          output: typeof trace?.output === 'string' ? trace.output : '',
          measurementValid: false,
          qualityEligible: false,
          pass: false,
          measurementFailure: failure,
          businessFailure: null,
          failure,
          businessPass: null,
          gatewayVerificationRequired: candidate.gateway,
          sdkModelMatches: false,
          identityBasis:
            officialVendor(candidate.baseUrl) && !candidate.gateway
              ? 'official_endpoint_sdk'
              : 'gateway_pending',
          upstreamRequestIdCount: trace?.apiRequests?.length ?? 0,
          profileBindingVerified: false,
          provisionedBindings: [],
          unexpectedUsageRecords: null,
          gates: {
            modelIdentity: false,
            independentFixture: false,
            freshState: false,
            terminalClassified: trace?.reason != null,
            usageReconciled: false,
            contextVerified: false,
          },
          contextFingerprint: null,
          observedPromptHashes: null,
          caseHash: hash(test),
          requestPromptHash: hash(renderCasePrompt(test)),
          runtimeSourceHash: process.env.BENCH_RUNTIME_SOURCE_HASH || null,
          workspaceBaselineHash: null,
          profileContentHash: null,
          fixtureHash: null,
          toolSchemaHash: null,
          usage: null,
          ledgerReconciled: false,
          elapsedMs: trace?.elapsedMs ?? null,
          logicalRunMs: trace?.logicalRunMs ?? null,
          business: null,
          fixtureLedgerSummary: Array.isArray(trace?.tools)
            ? trace.tools.map((call: Record<string, any>) => ({
                name: call.name,
              }))
            : [],
          diagnosticCode: safeDiagnosticCode(error),
        };
        privateJson(path.join(attemptDirectory, 'result.json'), result);
      }
    }

    const identity = {
      caseId,
      repetition,
      candidateAlias,
      profileVariant,
      executionIndex: actualExecutionIndex,
    };
    fs.appendFileSync(
      path.join(run.runDirectory, 'execution-sequence.jsonl'),
      JSON.stringify({ ...identity, expectedExecutionIndex, orderValid }) +
        '\n',
      { mode: 0o600 },
    );
    const usage = result.usage || null;
    const price = run.prices[candidateAlias];
    const cost = calculateCost(usage, price, candidate);
    const response = providerResponse(
      result,
      actualExecutionIndex,
      expectedExecutionIndex,
      cost,
    );
    response.metadata = { ...response.metadata, orderValid };
    return response;
  }
}
