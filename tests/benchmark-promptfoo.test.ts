import { describe, expect, test } from 'vitest';
import type { Candidate, SpikeCase } from '../benchmarks/lib/contracts.js';
import {
  buildTests,
  validateAssessmentParity,
  validateExecutionOrder,
} from '../benchmarks/promptfoo/build-tests.js';
import { providerResponse } from '../benchmarks/promptfoo/provider.js';
import {
  aggregatePromptfooCosts,
  calculateCost,
} from '../benchmarks/lib/pricing.js';
import { importOpenCodeGoKey } from '../benchmarks/lib/opencode-go.js';
import { importCandidateCredentials } from '../benchmarks/lib/local-credentials.js';
import { configurePromptfooStorage } from '../benchmarks/promptfoo/runtime.js';
import { parse } from 'yaml';
import { countClassifications } from '../benchmarks/lib/assessment.js';
import { persistAttemptResult } from '../benchmarks/lib/attempt.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { reassessPromptfoo } from '../benchmarks/lib/reassess-promptfoo.js';

const candidates = [
  { alias: 'candidate-a' },
  { alias: 'candidate-b' },
] as Candidate[];

const cases = [
  { id: 'first', prompt: 'first', maxCalls: 1 },
  { id: 'second', prompt: 'second', maxCalls: 1 },
] as SpikeCase[];

describe('Promptfoo benchmark adapter', () => {
  test('adds metadata-backed javascript assertions grouped by benchmark dimension', () => {
    const row = buildTests(cases.slice(0, 1), candidates.slice(0, 1), 1)[0];
    expect(row.assert.map((assertion) => assertion.metric)).toEqual([
      'measurement',
      'completion',
      'facts_evidence',
      'instruction',
      'tools',
    ]);
    expect(
      row.assert.every((assertion) => assertion.type === 'javascript'),
    ).toBe(true);
    expect(row.assert[0].value).toContain('context.metadata.measurementValid');
    expect(row.assert[1].value).toContain('context.metadata.businessPass');
  });

  test('persists repetition before comparing Promptfoo result metadata', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-attempt-result-test-'),
    );
    const result = {
      candidate: 'candidate-a',
      caseId: 'first',
      measurementValid: true,
      qualityEligible: true,
      pass: true,
      measurementFailure: null,
      businessFailure: null,
      failure: null,
      businessPass: true,
      gatewayVerificationRequired: false,
      identityBasis: 'official_endpoint_sdk',
      gates: { modelIdentity: true },
    };
    try {
      const persisted = persistAttemptResult(directory, result, 2);
      const fromDisk = JSON.parse(
        fs.readFileSync(path.join(directory, 'result.json'), 'utf8'),
      );
      expect(fromDisk.repetition).toBe(2);
      expect(
        validateAssessmentParity(
          [fromDisk],
          [{ response: { metadata: persisted } }],
        ),
      ).toEqual({ valid: true, mismatchIndex: null });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('reports measurement and business classifications independently', () => {
    const attempts = [
      {
        failure: 'business_assertion',
        measurementFailure: null,
        businessFailure: 'business_assertion',
      },
      {
        failure: 'audit_mismatch',
        measurementFailure: 'audit_mismatch',
        businessFailure: 'business_assertion',
      },
      {
        failure: 'tool_policy_violation',
        measurementFailure: null,
        businessFailure: 'tool_policy_violation',
      },
    ];
    expect(countClassifications(attempts, 'measurementFailure')).toEqual({
      audit_mismatch: 1,
    });
    expect(countClassifications(attempts, 'businessFailure')).toEqual({
      business_assertion: 2,
      tool_policy_violation: 1,
    });
  });

  test('disables cache, telemetry and sharing and puts its state in the run directory', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-promptfoo-storage-test-'),
    );
    const keys = [
      'PROMPTFOO_CONFIG_DIR',
      'PROMPTFOO_CACHE_PATH',
      'PROMPTFOO_CACHE_ENABLED',
      'PROMPTFOO_DISABLE_TELEMETRY',
      'PROMPTFOO_DISABLE_UPDATE',
      'PROMPTFOO_DISABLE_SHARING',
    ];
    const previous = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    try {
      const paths = configurePromptfooStorage(
        path.join(directory, 'promptfoo'),
      );
      expect(paths.configDirectory).toBe(
        path.join(directory, 'promptfoo/config'),
      );
      expect(paths.cacheDirectory).toBe(
        path.join(directory, 'promptfoo/cache'),
      );
      expect(process.env.PROMPTFOO_CONFIG_DIR).toBe(paths.configDirectory);
      expect(process.env.PROMPTFOO_CACHE_PATH).toBe(paths.cacheDirectory);
      expect(process.env.PROMPTFOO_CACHE_ENABLED).toBe('false');
      expect(process.env.PROMPTFOO_DISABLE_TELEMETRY).toBe('1');
      expect(process.env.PROMPTFOO_DISABLE_SHARING).toBe('1');
      const config = parse(
        fs.readFileSync(
          path.join(process.cwd(), 'benchmarks/promptfoo/promptfooconfig.yaml'),
          'utf8',
        ),
      );
      expect(config).toMatchObject({
        sharing: false,
        noShare: true,
        writeLatestResults: false,
        evaluateOptions: {
          cache: false,
          maxConcurrency: 1,
        },
      });
      for (const pathName of [paths.configDirectory, paths.cacheDirectory]) {
        expect(fs.statSync(pathName).mode & 0o077).toBe(0);
      }
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('imports and immediately removes a private OpenCode Go key file', () => {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-local-key-test-'),
    );
    const directory = path.join(repository, 'benchmarks');
    const file = path.join(directory, 'opencode-go.local.json');
    const previous = process.env.BENCH_OPENCODE_GO_API_KEY;
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'test-only-key' }), {
      mode: 0o600,
    });
    try {
      delete process.env.BENCH_OPENCODE_GO_API_KEY;
      expect(importOpenCodeGoKey(repository)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
      expect(process.env.BENCH_OPENCODE_GO_API_KEY).toBe('test-only-key');
    } finally {
      if (previous === undefined) delete process.env.BENCH_OPENCODE_GO_API_KEY;
      else process.env.BENCH_OPENCODE_GO_API_KEY = previous;
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  test('imports candidate-specific credentials only for recognized aliases', () => {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-qwen-key-test-'),
    );
    const directory = path.join(repository, 'benchmarks');
    const file = path.join(directory, 'qwen.local.json');
    const previous = process.env.BENCH_QWEN_API_KEY;
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'test-only-key' }), {
      mode: 0o600,
    });
    try {
      delete process.env.BENCH_QWEN_API_KEY;
      importCandidateCredentials(repository, [
        { apiKeyEnv: 'BENCH_QWEN_API_KEY' },
      ]);
      expect(process.env.BENCH_QWEN_API_KEY).toBe('test-only-key');
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BENCH_QWEN_API_KEY;
      else process.env.BENCH_QWEN_API_KEY = previous;
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  test('runs an in-memory provider without network calls and returns its metadata', async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-promptfoo-test-'),
    );
    const envKeys = [
      'PROMPTFOO_CONFIG_DIR',
      'PROMPTFOO_CACHE_PATH',
      'PROMPTFOO_CACHE_ENABLED',
      'PROMPTFOO_DISABLE_TELEMETRY',
      'PROMPTFOO_DISABLE_SHARING',
      'PROMPTFOO_DISABLE_UPDATE',
      'IS_TESTING',
      'BENCH_RUN_DIRECTORY',
    ];
    const previous = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, {
      PROMPTFOO_CONFIG_DIR: directory,
      PROMPTFOO_CACHE_PATH: path.join(directory, 'cache'),
      PROMPTFOO_CACHE_ENABLED: 'false',
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      IS_TESTING: 'true',
    });
    try {
      const benchmarkRequire = createRequire(
        path.join(process.cwd(), 'benchmarks/package.json'),
      );
      const promptfooEntry = benchmarkRequire.resolve('promptfoo');
      expect(promptfooEntry).toContain(
        path.join('benchmarks', 'node_modules', 'promptfoo'),
      );
      const { evaluate, loadApiProvider } = await import(promptfooEntry);
      const benchmarkTest = buildTests(
        cases.slice(0, 1),
        candidates.slice(0, 1),
        1,
      )[0];
      const evaluation = await evaluate(
        {
          prompts: ['{{prompt}}'],
          providers: [
            {
              id: () => 'synthetic-provider',
              callApi: async () => ({
                output: 'synthetic response',
                metadata: {
                  gates: { contextVerified: true },
                  measurementValid: true,
                  businessPass: false,
                  business: {
                    status: true,
                    facts: true,
                    evidence: true,
                    format: true,
                    injection: true,
                    requiredTools: true,
                    onlyAllowedTools: true,
                    successfulTools: true,
                    callLimit: true,
                  },
                },
              }),
            },
          ],
          tests: [benchmarkTest],
          sharing: false,
          writeLatestResults: false,
        },
        {
          maxConcurrency: 1,
          cache: false,
          showProgressBar: false,
          silent: true,
        },
      );
      expect(evaluation.results).toHaveLength(1);
      const evaluationResult = evaluation.results[0].toEvaluateResult();
      expect(evaluationResult).toMatchObject({
        success: false,
        response: {
          output: 'synthetic response',
          metadata: {
            gates: { contextVerified: true },
            measurementValid: true,
            businessPass: false,
            business: {
              status: true,
              facts: true,
              evidence: true,
              format: true,
              injection: true,
              requiredTools: true,
              onlyAllowedTools: true,
              successfulTools: true,
              callLimit: true,
            },
          },
        },
      });
      expect(evaluationResult.namedScores).toMatchObject({
        measurement: 1,
        completion: 0,
        facts_evidence: 1,
        instruction: 1,
        tools: 1,
      });
      const previousRunDirectory = process.env.BENCH_RUN_DIRECTORY;
      delete process.env.BENCH_RUN_DIRECTORY;
      const loaded = await loadApiProvider(
        `file://${path.join(process.cwd(), 'benchmarks/promptfoo/provider.ts')}`,
        { options: { id: 'commerceagent-test' } },
      );
      const measurementFailure = await loaded.callApi('private prompt', {
        vars: { expectedExecutionIndex: '1' },
      });
      expect(measurementFailure.output).toBe('');
      expect(measurementFailure).not.toHaveProperty('error');
      expect(measurementFailure.metadata).toMatchObject({
        measurementValid: false,
        measurementFailure: 'collection_incomplete',
        actualExecutionIndex: 1,
        expectedExecutionIndex: 1,
      });
      if (previousRunDirectory !== undefined)
        process.env.BENCH_RUN_DIRECTORY = previousRunDirectory;
    } finally {
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('builds case batches with rotated candidate order and explicit execution indices', () => {
    const rows = buildTests(cases, candidates, 2);
    expect(
      rows.map(
        ({ metadata }) =>
          `${metadata.repetition}:${metadata.caseId}:${metadata.candidateAlias}:${metadata.expectedExecutionIndex}`,
      ),
    ).toEqual([
      '1:first:candidate-a:1',
      '1:first:candidate-b:2',
      '1:second:candidate-b:3',
      '1:second:candidate-a:4',
      '2:first:candidate-b:5',
      '2:first:candidate-a:6',
      '2:second:candidate-a:7',
      '2:second:candidate-b:8',
    ]);
  });

  test('invalidates a run when observed execution order differs', () => {
    const expected = [
      {
        caseId: 'first',
        repetition: 1,
        candidateAlias: 'candidate-a',
        executionIndex: 1,
      },
      {
        caseId: 'first',
        repetition: 1,
        candidateAlias: 'candidate-b',
        executionIndex: 2,
      },
    ];
    expect(validateExecutionOrder(expected, expected)).toEqual({
      valid: true,
      mismatchIndex: null,
    });
    expect(
      validateExecutionOrder(expected, [expected[1], expected[0]]),
    ).toEqual({ valid: false, mismatchIndex: 1 });
    expect(validateExecutionOrder(expected, [expected[0]])).toEqual({
      valid: false,
      mismatchIndex: 2,
    });
  });

  test('checks that Promptfoo retained attempt gates and failure classifications unchanged', () => {
    const attempt = {
      candidate: 'candidate-a',
      caseId: 'first',
      repetition: 1,
      measurementValid: false,
      qualityEligible: false,
      pass: false,
      measurementFailure: 'audit_mismatch',
      businessFailure: 'business_assertion',
      failure: 'audit_mismatch',
      businessPass: false,
      gatewayVerificationRequired: false,
      identityBasis: 'official_endpoint_sdk',
      gates: { independentFixture: false },
    };
    const promptfooResult = {
      response: {
        metadata: {
          ...attempt,
          actualExecutionIndex: 1,
          expectedExecutionIndex: 1,
        },
      },
    };
    expect(validateAssessmentParity([attempt], [promptfooResult])).toEqual({
      valid: true,
      mismatchIndex: null,
    });
    promptfooResult.response.metadata.measurementFailure =
      'collection_incomplete';
    expect(validateAssessmentParity([attempt], [promptfooResult])).toEqual({
      valid: false,
      mismatchIndex: 1,
      mismatchFields: ['measurementFailure'],
    });
  });

  test('returns output, ledger usage and metadata without converting measurement failures to provider errors', () => {
    const response = providerResponse(
      {
        output: 'private raw answer',
        measurementValid: false,
        measurementFailure: 'context_mismatch',
        businessPass: false,
        gates: { freshState: false },
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 2,
          cacheCreationInputTokens: 1,
          reasoningTokens: 0,
        },
        elapsedMs: 12,
        logicalRunMs: 9,
        fixtureLedgerSummary: [],
      },
      3,
      2,
      null,
    );
    expect(response.output).toBe('');
    expect(response).not.toHaveProperty('error');
    expect(response.tokenUsage).toEqual({
      prompt: 13,
      completion: 4,
      cached: 2,
      total: 17,
      completionDetails: {
        reasoning: 0,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    });
    expect(response.cost).toBeUndefined();
    expect(response.metadata).toMatchObject({
      measurementFailure: 'context_mismatch',
      actualExecutionIndex: 3,
      expectedExecutionIndex: 2,
      orderValid: false,
      cost: null,
      costStatus: 'unknown',
      elapsedMs: 12,
      logicalRunMs: 9,
      gates: { freshState: false },
    });
  });

  test('returns null cost when any candidate rate is unknown', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 30,
      reasoningTokens: 10,
    };
    expect(calculateCost(usage, undefined)).toBeNull();
    expect(
      calculateCost(usage, {
        input: 1,
        output: 2,
        cache_read: 0.2,
        cache_write: 1.2,
      }),
    ).toBeNull();
    expect(
      calculateCost(usage, {
        effective_date: '2026-10-11',
        currency: 'USD',
        input: 1,
        output: 2,
        cache_read: 0.2,
        cache_write: 1.2,
        reasoning: 3,
        source: 'synthetic test rate',
      }),
    ).toBeCloseTo(1.00025);
  });

  test('keeps aggregate candidate cost unknown if any attempt is unpriced', () => {
    const results = [
      { response: { metadata: { candidate: 'candidate-a', cost: 0.25 } } },
      { response: { metadata: { candidate: 'candidate-a', cost: null } } },
      { response: { metadata: { candidate: 'candidate-b', cost: 0.5 } } },
    ];
    expect(
      aggregatePromptfooCosts(
        {
          effective_date: '2026-10-12',
          currency: 'USD',
          candidates: {},
        },
        results,
      ),
    ).toEqual({
      'candidate-a': {
        attempts: 2,
        currency: 'USD',
        effectiveDate: '2026-10-12',
        source: null,
        totalCost: null,
        known: false,
      },
      'candidate-b': {
        attempts: 1,
        currency: 'USD',
        effectiveDate: '2026-10-12',
        source: null,
        totalCost: 0.5,
        known: true,
      },
    });
  });

  test('reassesses classifications from trace, fixture ledger, usage database and context evidence', () => {
    const runDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'commerceagent-independent-reassess-'),
    );
    fs.mkdirSync(path.join(runDirectory, 'promptfoo'), { recursive: true });
    const attemptDirectory = path.join(runDirectory, 'promptfoo-0001');
    const dataDirectory = path.join(attemptDirectory, 'service/data-eval');
    fs.mkdirSync(path.join(dataDirectory, 'db'), { recursive: true });
    const writeJson = (file: string, value: unknown) =>
      fs.writeFileSync(file, JSON.stringify(value) + '\n');
    const caseRow = {
      id: 'policy-check',
      scenario: 'normal',
      prompt: 'What is the return rule?',
      expected: {
        status: 'answered',
        facts: { days: 30 },
        evidence: ['POLICY-1'],
      },
      requiredTools: [
        { name: 'search_policy', arguments: { topic: 'returns' } },
      ],
      maxCalls: 1,
    } as SpikeCase;
    const candidate = {
      alias: 'candidate-a',
      model: 'claude-3-5-sonnet',
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnv: 'BENCH_TEST_KEY',
      gateway: false,
    };
    const call = {
      sequence: 1,
      name: 'search_policy',
      arguments: { topic: 'returns' },
      result: { days: 30, evidence_id: 'POLICY-1' },
      success: true,
    };
    const output = JSON.stringify({
      status: 'answered',
      facts: { days: 30 },
      evidence: ['POLICY-1'],
    });
    const trace = {
      output,
      failure: null,
      reason: 'completed',
      tools: [{ name: 'mcp__commerce_fixture__search_policy' }],
    };
    const contextExpected = {
      renderedProfileHash: 'rendered-profile',
      canonicalProfileHash: 'canonical-profile',
      profileId: 'profile-1',
      version: 1,
      identityHash: 'identity-hash',
      runtimePolicyHash: 'runtime-policy-hash',
      skillsHash: 'skills-hash',
      mcpHash: 'mcp-hash',
      sessionId: 'session-1',
      turnId: 'turn-1',
    };
    const contextActual = {
      executionMode: 'container',
      turnId: 'turn-1',
      agentId: 'session-1',
      agentProfile: {
        id: 'profile-1',
        version: 1,
        identityHash: 'identity-hash',
        runtimePolicyHash: 'runtime-policy-hash',
      },
      skills: { manifestHash: 'skills-hash', selectedSkillIds: [] },
      mcp: { manifestHash: 'mcp-hash', serverIds: ['commerce_fixture'] },
      prompt: {
        blocks: [
          {
            id: 'agent-profile',
            hash: 'rendered-profile',
            owner: 'agent_profile',
          },
          { id: 'platform', hash: 'platform-hash', owner: 'platform' },
        ],
      },
      warnings: [],
    };
    const freshState = {
      serviceDirectoryCreated: true,
      dataDirectoryCreated: true,
      initialDataEntries: 0,
      initialDatabase: {
        users: [],
        workspaces: [],
        sessions: [],
        sdkSessions: [],
        messages: 0,
        usageEvents: 0,
      },
      dataDirectory,
      userId: 'user-1',
      groupFolder: 'group-1',
      sessionId: 'session-1',
      workspaceJid: 'workspace-1',
      userAbsentBeforeSetup: true,
      sessionAbsentBeforeCreate: true,
      sessionOwned: true,
      sessionEmpty: true,
      workspaceBaselineHash: 'baseline-hash',
    };
    const db = new Database(path.join(dataDirectory, 'db/messages.db'));
    db.exec(`
      CREATE TABLE usage_events (
        user_id TEXT, group_folder TEXT, agent_id TEXT, event_id TEXT,
        created_at INTEGER, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
        reasoning_output_tokens INTEGER, duration_ms INTEGER
      );
      CREATE TABLE usage_records (
        user_id TEXT, group_folder TEXT, agent_id TEXT, event_id TEXT,
        created_at INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER,
        reasoning_output_tokens INTEGER
      );
    `);
    const usageRow = [
      'user-1',
      'group-1',
      'session-1',
      'event-1',
      1,
      10,
      3,
      0,
      0,
      0,
    ];
    db.prepare(
      'INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(...usageRow, 5);
    db.prepare(
      'INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(...usageRow.slice(0, 5), candidate.model, ...usageRow.slice(5));
    db.close();

    try {
      writeJson(path.join(runDirectory, 'candidates.json'), [candidate]);
      writeJson(path.join(runDirectory, 'cases.used.json'), [caseRow]);
      writeJson(path.join(runDirectory, 'execution-sequence.jsonl'), {
        caseId: 'policy-check',
        repetition: 1,
        candidateAlias: 'candidate-a',
        executionIndex: 1,
        expectedExecutionIndex: 1,
      });
      writeJson(path.join(runDirectory, 'execution-order.json'), {
        valid: true,
        expectedAttempts: 1,
        actualAttempts: 1,
        expected: [
          {
            caseId: 'policy-check',
            repetition: 1,
            candidateAlias: 'candidate-a',
            executionIndex: 1,
          },
        ],
        actual: [
          {
            caseId: 'policy-check',
            repetition: 1,
            candidateAlias: 'candidate-a',
            executionIndex: 1,
          },
        ],
      });
      fs.mkdirSync(attemptDirectory, { recursive: true });
      writeJson(path.join(attemptDirectory, 'trace.json'), trace);
      const originalResultFile = path.join(attemptDirectory, 'result.json');
      const originalResultText =
        JSON.stringify({ source: 'original-result' }) + '\n';
      fs.writeFileSync(originalResultFile, originalResultText, { mode: 0o600 });
      fs.writeFileSync(
        path.join(attemptDirectory, 'fixture.jsonl'),
        JSON.stringify(call) + '\n',
      );
      writeJson(path.join(attemptDirectory, 'context-evidence.json'), {
        actual: contextActual,
        expected: contextExpected,
      });
      writeJson(path.join(attemptDirectory, 'fresh-state.json'), freshState);
      writeJson(path.join(runDirectory, 'promptfoo/results.json'), [
        {
          success: true,
          response: {
            metadata: {
              candidate: 'candidate-a',
              caseId: 'policy-check',
              repetition: 1,
              actualExecutionIndex: 1,
              expectedExecutionIndex: 1,
              measurementValid: true,
              qualityEligible: true,
              pass: true,
              measurementFailure: null,
              businessFailure: null,
              failure: null,
              businessPass: true,
              gatewayVerificationRequired: false,
              identityBasis: 'official_endpoint_sdk',
              gates: {
                modelIdentity: true,
                independentFixture: true,
                freshState: true,
                terminalClassified: true,
                usageReconciled: true,
                contextVerified: true,
              },
            },
          },
        },
      ]);
      const report = reassessPromptfoo(runDirectory);
      expect(report).toMatchObject({
        evidenceComplete: true,
        executionOrderValid: true,
        providerParityValid: true,
        providerParityMismatchFields: [],
        measurementValidAttempts: 1,
        businessPassedAttempts: 1,
        invalidRun: false,
      });
      expect(report.results[0].sourceHashes).toHaveProperty('trace.json');
      expect(report.results[0].gates).toMatchObject({
        modelIdentity: true,
        independentFixture: true,
        freshState: true,
        contextVerified: true,
      });
      expect(fs.readFileSync(originalResultFile, 'utf8')).toBe(
        originalResultText,
      );
      expect(fs.existsSync(path.join(runDirectory, 'reassessed.json'))).toBe(
        true,
      );

      const promptfooResults = JSON.parse(
        fs.readFileSync(
          path.join(runDirectory, 'promptfoo/results.json'),
          'utf8',
        ),
      );
      promptfooResults[0].response.metadata.businessPass = false;
      writeJson(
        path.join(runDirectory, 'promptfoo/results.json'),
        promptfooResults,
      );
      expect(reassessPromptfoo(runDirectory).providerParityValid).toBe(false);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });
});
