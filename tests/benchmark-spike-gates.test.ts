import { reassessSpike } from '../benchmarks/scripts/reassess-spike.js';
import { hash, privateJson } from '../benchmarks/lib/contracts.js';
import { auditFixtureCalls } from '../benchmarks/assertions/audit.js';
import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSpike } from '../benchmarks/assertions/spike.js';
import {
  assessAttempt,
  rotateCandidates,
} from '../benchmarks/lib/assessment.js';
import {
  FreshStateTracker,
  type FreshStateEvidence,
} from '../benchmarks/lib/fresh-state.js';
import { requiresGatewayAudit } from '../benchmarks/lib/identity.js';
import {
  cleanupServiceSecrets,
  cleanupHistoricalSecrets,
} from '../benchmarks/lib/secrets.js';
import { openCodeGoCandidate } from '../benchmarks/lib/opencode-go.js';
import type { Candidate, SpikeCase } from '../benchmarks/lib/contracts.js';

const healthy = {
  transportFailure: null,
  usageComplete: true,
  scopeIsolated: true,
  sdkModelMatches: true,
  contextVerified: true,
  freshState: true,
  auditMatched: true,
  onlyAllowedTools: true,
  businessPass: true,
  gateway: false,
} as const;
const example: SpikeCase = {
  id: 'empty',
  scenario: 'empty',
  prompt: 'query',
  expected: { status: 'not_found', facts: {}, evidence: [] },
  requiredTools: [{ name: 'get_order', arguments: { order_id: 'missing' } }],
  maxCalls: 1,
};

describe('measurement and behavior are separate', () => {
  test('no tool calls is a business failure with a matching empty audit', () => {
    const business = assertSpike(
      JSON.stringify(example.expected),
      example,
      [],
      [],
    );
    expect(business.checks).not.toHaveProperty('independentAudit');
    expect(business.checks.requiredTools).toBe(false);
    expect(
      assessAttempt({ ...healthy, businessPass: business.pass }),
    ).toMatchObject({ measurementValid: true, failure: 'business_assertion' });
  });
  test('forbidden shell plus unmatched fixture calls is a policy violation, not collection loss', () => {
    const business = assertSpike(
      JSON.stringify(example.expected),
      example,
      [
        {
          sequence: 1,
          name: 'get_order',
          arguments: { order_id: 'missing' },
          result: {},
          success: true,
        },
      ],
      [{ name: 'Bash' }],
    );
    const result = assessAttempt({
      ...healthy,
      auditMatched: false,
      onlyAllowedTools: business.checks.onlyAllowedTools,
      businessPass: business.pass,
    });
    expect(result).toMatchObject({
      failure: 'tool_policy_violation',
      businessFailure: 'tool_policy_violation',
      measurementFailure: 'audit_mismatch',
      qualityEligible: false,
    });
  });
  test('unexplained audit mismatch is not asserted to be a bypass', () => {
    expect(assessAttempt({ ...healthy, auditMatched: false })).toMatchObject({
      failure: 'audit_mismatch',
      businessFailure: null,
      measurementValid: false,
    });
  });
  test('an allowed tool with invalid arguments is a business failure, not a policy violation', () => {
    const business = assertSpike(
      JSON.stringify(example.expected),
      example,
      [
        {
          sequence: 1,
          name: 'get_order',
          arguments: { bad: 'argument' },
          result: { error: 'invalid_arguments' },
          success: false,
        },
      ],
      [{ name: 'mcp__commerce_fixture__get_order' }],
    );
    expect(business.checks).not.toHaveProperty('independentAudit');
    expect(business.checks.onlyAllowedTools).toBe(true);
    expect(business.checks.successfulTools).toBe(false);
    expect(
      assessAttempt({
        ...healthy,
        businessPass: business.pass,
        onlyAllowedTools: business.checks.onlyAllowedTools,
      }),
    ).toMatchObject({
      measurementValid: true,
      businessFailure: 'business_assertion',
    });
  });
  test('a missing tool event affects measurement but not the independent business outcome', () => {
    const ledger = [
      {
        sequence: 1,
        name: 'get_order',
        arguments: { order_id: 'missing' },
        result: {},
        success: true,
      },
    ];
    const business = assertSpike(
      JSON.stringify(example.expected),
      example,
      ledger,
      [],
    );
    const audit = auditFixtureCalls(ledger, []);
    expect(business.pass).toBe(true);
    expect(audit.matched).toBe(false);
    expect(auditFixtureCalls([], []).matched).toBe(true);
    const assessed = assessAttempt({
      ...healthy,
      auditMatched: audit.matched,
      businessPass: business.pass,
    });
    expect(assessed).toMatchObject({
      measurementFailure: 'audit_mismatch',
      businessFailure: null,
      pass: false,
    });
  });
  test('dirty state rejects an otherwise correct answer', () => {
    expect(assessAttempt({ ...healthy, freshState: false })).toMatchObject({
      failure: 'state_not_fresh',
      measurementValid: false,
      pass: false,
    });
  });
});

describe('official identity policy and matrix', () => {
  test.each([
    'https://api.anthropic.com/',
    'https://api.deepseek.com/anthropic',
    'https://open.bigmodel.cn/api/anthropic',
    'https://api.z.ai/api/anthropic',
    'https://api.moonshot.cn/anthropic',
    'https://api.moonshot.ai/anthropic',
  ])('accepts documented vendor origin %s', (url) =>
    expect(requiresGatewayAudit(url)).toBe(false),
  );
  test.each([
    'https://api.deepseek.com.evil.invalid/anthropic',
    'http://api.deepseek.com/anthropic',
    'https://api.deepseek.com/other',
    'https://opencode.ai/zen/go',
    'https://api.deepseek.com:444/anthropic',
  ])('does not trust gateway or lookalike %s', (url) =>
    expect(requiresGatewayAudit(url)).toBe(true),
  );
  test('explicit audit remains required, and SDK model mismatch never passes', () => {
    expect(
      requiresGatewayAudit('https://api.deepseek.com/anthropic', true),
    ).toBe(true);
    expect(assessAttempt({ ...healthy, sdkModelMatches: false }).pass).toBe(
      false,
    );
  });
  test.each([
    'https://dashscope.aliyuncs.com/apps/anthropic',
    'https://maas.qianwenaiapi.com/apps/anthropic',
  ])('Qwen platform only qualifies Qwen targets as first-party: %s', (base) => {
    expect(requiresGatewayAudit(base, false, 'qwen-synthetic')).toBe(false);
    expect(requiresGatewayAudit(base, false, 'glm-synthetic')).toBe(true);
    expect(requiresGatewayAudit(base)).toBe(true);
    expect(
      requiresGatewayAudit(
        'https://dashscope.aliyuncs.com/apps/other',
        false,
        'qwen-synthetic',
      ),
    ).toBe(true);
    expect(
      requiresGatewayAudit(
        'https://dashscope.aliyuncs.com.evil.invalid/apps/anthropic',
        false,
        'qwen-synthetic',
      ),
    ).toBe(true);
  });
  test('rotates two candidates and selects a different Go model', () => {
    const a: Candidate = {
      alias: 'candidate-a',
      model: 'minimax-synthetic',
      baseUrl: 'https://example.invalid',
      apiKeyEnv: 'TEST_KEY',
      gateway: true,
    };
    const b = { ...a, alias: 'candidate-b', model: 'other' };
    expect(rotateCandidates([a, b], 0, 0)).toEqual([a, b]);
    expect(rotateCandidates([a, b], 1, 0)).toEqual([b, a]);
    expect(rotateCandidates([a, b], 0, 1)).toEqual([b, a]);
    expect(openCodeGoCandidate([a]).model).not.toMatch(/minimax/i);
    expect(openCodeGoCandidate([b]).gateway).toBe(true);
  });
});

test('fresh state is derived from snapshots, uniqueness and the workspace baseline', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-fresh-'));
  const evidence = (suffix: string): FreshStateEvidence => {
    const dir = path.join(root, suffix);
    fs.mkdirSync(dir);
    return {
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
      dataDirectory: dir,
      userId: `u-${suffix}`,
      sessionId: `s-${suffix}`,
      workspaceJid: `w-${suffix}`,
      userAbsentBeforeSetup: true,
      sessionAbsentBeforeCreate: true,
      sessionOwned: true,
      sessionEmpty: true,
      workspaceBaselineHash: 'baseline',
    };
  };
  try {
    const tracker = new FreshStateTracker();
    const first = evidence('first');
    expect(tracker.verify(first)).toBe(true);
    expect(tracker.verify(first)).toBe(false);
    expect(
      tracker.verify({ ...evidence('dirty'), initialDataEntries: 1 }),
    ).toBe(false);
    expect(
      tracker.verify({
        ...evidence('old-user'),
        initialDatabase: { ...first.initialDatabase, users: ['old'] },
      }),
    ).toBe(false);
    expect(
      tracker.verify({
        ...evidence('old-session'),
        sessionAbsentBeforeCreate: false,
      }),
    ).toBe(false);
    expect(
      tracker.verify({ ...evidence('wrong-owner'), sessionOwned: false }),
    ).toBe(false);
    expect(
      tracker.verify({ ...evidence('history'), sessionEmpty: false }),
    ).toBe(false);
    expect(
      tracker.verify({
        ...evidence('drift'),
        workspaceBaselineHash: 'different',
      }),
    ).toBe(false);
    expect(tracker.verify(evidence('second'))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secret cleanup preserves ledgers and never follows a symlink', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-secrets-'));
  const data = path.join(root, 'service/data-eval');
  try {
    for (const name of [
      'config',
      'env',
      'sessions/s/.claude',
      'groups/w',
      'mcp-servers/user',
    ])
      fs.mkdirSync(path.join(data, name), { recursive: true });
    fs.writeFileSync(
      path.join(data, 'config/claude-provider.key'),
      'synthetic-secret',
    );
    fs.writeFileSync(path.join(data, 'env/secret'), 'synthetic-secret');
    fs.writeFileSync(
      path.join(data, 'mcp-servers/user/secrets.json'),
      'synthetic-secret',
    );
    fs.writeFileSync(
      path.join(data, 'mcp-servers/user/servers.json'),
      'preserve',
    );
    fs.writeFileSync(
      path.join(data, 'sessions/s/.claude/settings.json'),
      'synthetic-secret',
    );
    fs.writeFileSync(
      path.join(data, 'groups/w/.fixture-connection.json'),
      'ephemeral-token',
    );
    fs.writeFileSync(path.join(data, 'sessions/s/trace.jsonl'), 'preserve');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'settings.json'), 'preserve');
    fs.symlinkSync(outside, path.join(data, 'sessions/link'));
    fs.writeFileSync(path.join(outside, 'secrets.json'), 'preserve');
    fs.symlinkSync(outside, path.join(data, 'mcp-servers/link'));
    cleanupServiceSecrets(data);
    expect(fs.existsSync(path.join(data, 'config'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'env'))).toBe(false);
    expect(
      fs.existsSync(path.join(data, 'mcp-servers/user/secrets.json')),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(data, 'mcp-servers/user/servers.json'), 'utf8'),
    ).toBe('preserve');
    expect(fs.readFileSync(path.join(outside, 'secrets.json'), 'utf8')).toBe(
      'preserve',
    );
    expect(
      fs.existsSync(path.join(data, 'sessions/s/.claude/settings.json')),
    ).toBe(false);
    expect(
      fs.readFileSync(path.join(data, 'sessions/s/trace.jsonl'), 'utf8'),
    ).toBe('preserve');
    expect(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8')).toBe(
      'preserve',
    );
    fs.rmSync(path.join(data, 'mcp-servers'), { recursive: true });
    fs.symlinkSync(outside, path.join(data, 'mcp-servers'));
    cleanupServiceSecrets(data);
    expect(fs.readFileSync(path.join(outside, 'secrets.json'), 'utf8')).toBe(
      'preserve',
    );
    fs.mkdirSync(path.join(root, 'provider-snapshot/config'), {
      recursive: true,
    });
    cleanupHistoricalSecrets(root);
    expect(fs.existsSync(path.join(root, 'provider-snapshot'))).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('offline reassessment retains business success when a tool event was lost, without rewriting old artifacts', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'benchmark-audit-statistics-'),
  );
  try {
    const data = path.join(root, 'data-eval');
    fs.mkdirSync(data);
    const folder = path.join(root, 'empty-candidate-a-1');
    fs.mkdirSync(folder);
    const row = {
      caseId: 'empty',
      candidate: 'candidate-a',
      repetition: 1,
      caseHash: hash(example),
      unexpectedUsageRecords: 0,
      sdkModelMatches: true,
      gatewayVerificationRequired: false,
      businessPass: false,
      pass: false,
      gates: {
        usageReconciled: true,
        contextVerified: true,
        modelIdentity: true,
      },
    };
    privateJson(path.join(root, 'summary.json'), {
      schemaVersion: 3,
      stage: 'spike',
      attempts: 1,
      chainPassed: false,
      identityVerified: true,
      passed: false,
      businessPassedAttempts: 0,
      technicalPassedAttempts: 0,
      passedAttempts: 0,
      results: [row],
    });
    privateJson(path.join(root, 'cases.used.json'), [example]);
    privateJson(path.join(folder, 'trace.json'), {
      failure: null,
      output: JSON.stringify(example.expected),
      tools: [],
    });
    fs.writeFileSync(
      path.join(folder, 'fixture.jsonl'),
      JSON.stringify({
        sequence: 1,
        name: 'get_order',
        arguments: { order_id: 'missing' },
        result: {},
        success: true,
      }) + '\n',
    );
    privateJson(path.join(folder, 'fresh-state.json'), {
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
      dataDirectory: data,
      userId: 'u',
      sessionId: 's',
      workspaceJid: 'w',
      userAbsentBeforeSetup: true,
      sessionAbsentBeforeCreate: true,
      sessionOwned: true,
      sessionEmpty: true,
      workspaceBaselineHash: 'baseline',
    });
    privateJson(path.join(root, 'summary.reassessed.json'), {
      previousRevision: true,
    });
    const before = fs.readFileSync(path.join(root, 'summary.json'), 'utf8');
    const report = reassessSpike(root);
    expect(report.businessPassedAttempts).toBe(1);
    expect(report.technicalPassedAttempts).toBe(0);
    expect(report.passedAttempts).toBe(0);
    expect(report.results[0]).toMatchObject({
      businessPass: true,
      measurementFailure: 'audit_mismatch',
    });
    expect(report.results[0].business).not.toHaveProperty('independentAudit');
    expect(fs.readFileSync(path.join(root, 'summary.json'), 'utf8')).toBe(
      before,
    );
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, 'summary.reassessed.json'), 'utf8'),
      ),
    ).toEqual({ previousRevision: true });
    expect(fs.existsSync(path.join(root, report.reassessmentArtifact))).toBe(
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
