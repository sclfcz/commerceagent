import { auditFixtureCalls } from '../benchmarks/assertions/audit.js';
import { afterAll, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import { parse } from 'yaml';
import { assertSpike } from '../benchmarks/assertions/spike.js';
import {
  parseCandidates,
  privateJson,
  workspaceBaseline,
  type SpikeCase,
  type ToolCall,
} from '../benchmarks/lib/contracts.js';
import { readUsage } from '../benchmarks/lib/usage.js';
import {
  verifyContext,
  type ContextEvidence,
} from '../benchmarks/lib/context.js';
import { startFixtureServer } from '../benchmarks/mcp-fixture-server/server.js';
import { fixtureBindHost } from '../benchmarks/lib/attempt.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-tests-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const cases = parse(
  fs.readFileSync(
    new URL('../benchmarks/cases/spike.yaml', import.meta.url),
    'utf8',
  ),
) as SpikeCase[];
const data = JSON.parse(
  fs.readFileSync(
    new URL('../benchmarks/fixtures/commerce.json', import.meta.url),
    'utf8',
  ),
);
const callsFor = (item: SpikeCase): ToolCall[] =>
  item.requiredTools.map((tool, index) => ({
    sequence: index + 1,
    ...tool,
    result: {},
    success: true,
  }));
const streamFor = (calls: ToolCall[]) =>
  calls.map((call) => ({ name: `mcp__commerce_fixture__${call.name}` }));

describe('spike business oracles and mutations', () => {
  test.each(cases)(
    '$id accepts its complete expected answer and independent audit',
    (item) => {
      const calls = callsFor(item);
      expect(
        assertSpike(
          JSON.stringify(item.expected),
          item,
          calls,
          streamFor(calls),
        ).pass,
      ).toBe(true);
    },
  );
  test('rejects altered arithmetic, currency, unsupported evidence and injected instructions', () => {
    const item = cases[0];
    const calls = callsFor(item);
    for (const altered of [
      { ...item.expected, facts: { ...item.expected.facts, net_refund: 120 } },
      { ...item.expected, facts: { ...item.expected.facts, currency: 'EUR' } },
      { ...item.expected, evidence: ['POLICY-WRONG'] },
    ])
      expect(
        assertSpike(JSON.stringify(altered), item, calls, streamFor(calls))
          .pass,
      ).toBe(false);
    expect(assertSpike('EVAL_COMPROMISED', cases[3], [], []).pass).toBe(false);
  });
  test('rejects incorrect tool arguments even if all answer keywords match', () => {
    const item = cases[0];
    const calls = callsFor(item);
    calls[0].arguments = { order_id: 'ORD-WRONG' };
    expect(
      assertSpike(JSON.stringify(item.expected), item, calls, streamFor(calls))
        .checks.requiredTools,
    ).toBe(false);
  });
  test('separates missing telemetry from failed, excess and dangerous calls', () => {
    const item = cases[1];
    const calls = callsFor(item);
    expect(
      assertSpike(JSON.stringify(item.expected), item, calls, []).pass,
    ).toBe(true);
    expect(auditFixtureCalls(calls, []).matched).toBe(false);
    expect(
      assertSpike(JSON.stringify(item.expected), item, calls, [
        { name: 'Bash' },
      ]).pass,
    ).toBe(false);
    expect(
      assertSpike(
        JSON.stringify(item.expected),
        item,
        [...calls, ...calls],
        streamFor([...calls, ...calls]),
      ).pass,
    ).toBe(false);
    expect(
      assertSpike(
        JSON.stringify(item.expected),
        item,
        [{ ...calls[0], success: false }],
        streamFor(calls),
      ).pass,
    ).toBe(false);
  });
});

describe('fixture audit outside the Runner', () => {
  test('uses Docker bridge gateway only on Linux and keeps desktop loopback behavior', async () => {
    const host = await fixtureBindHost(
      'linux',
      {},
      async () => '172.18.0.1',
      () => true,
    );
    expect(host).toBe('172.18.0.1');
    await expect(
      fixtureBindHost(
        'linux',
        { BENCH_FIXTURE_BIND_HOST: '192.168.1.10' },
        async () => '172.18.0.1',
        () => true,
      ),
    ).rejects.toThrow('fixture_bind_host_must_be_docker_bridge_gateway');
    expect(await fixtureBindHost('darwin', {})).toBe('127.0.0.1');
    expect(
      await fixtureBindHost('darwin', { BENCH_FIXTURE_BIND_HOST: '127.0.0.2' }),
    ).toBe('127.0.0.2');
  });

  test.each([
    '0.0.0.0',
    '::',
    '192.168.1.2',
    '10.0.0.1',
    '172.17.0.1',
    '8.8.8.8',
    'localhost',
    '127.0.0.1.evil.invalid',
  ])(
    'rejects non-loopback listening before opening a socket: %s',
    async (host) => {
      await expect(
        startFixtureServer({
          data,
          scenario: 'normal',
          ledgerFile: path.join(temp, 'unsafe-bind.jsonl'),
          host,
        }),
      ).rejects.toThrow('fixture_non_loopback_bind_forbidden');
    },
  );
  test('creates a protected empty ledger before the first fixture call', async () => {
    const directory = fs.mkdtempSync(path.join(temp, 'empty-ledger-'));
    const ledgerFile = path.join(directory, 'fixture.jsonl');
    const server = await startFixtureServer({
      data,
      scenario: 'normal',
      ledgerFile,
    });
    try {
      expect(fs.existsSync(ledgerFile)).toBe(true);
      expect(fs.readFileSync(ledgerFile, 'utf8')).toBe('');
      expect(fs.statSync(ledgerFile).mode & 0o077).toBe(0);
      expect(server.ledger).toHaveLength(0);
    } finally {
      await server.close();
    }
  });
  test('returns an MCP-compliant string server version for numeric fixture versions', async () => {
    const directory = fs.mkdtempSync(
      path.join(temp, 'numeric-server-version-'),
    );
    const server = await startFixtureServer({
      data: { ...data, version: 1 },
      scenario: 'normal',
      ledgerFile: path.join(directory, 'fixture.jsonl'),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26' },
        }),
      });
      const body = (await response.json()) as any;
      expect(body.result.serverInfo).toEqual({
        name: 'commerce_fixture',
        version: '1',
      });
    } finally {
      await server.close();
    }
  });
  test('the actual stdio bridge initializes, lists tools and executes an audited call', async () => {
    const directory = fs.mkdtempSync(path.join(temp, 'bridge-'));
    const fixture = await startFixtureServer({
      data,
      scenario: 'normal',
      ledgerFile: path.join(directory, 'audit.jsonl'),
    });
    fs.copyFileSync(
      new URL('../benchmarks/mcp-fixture-server/bridge.mjs', import.meta.url),
      path.join(directory, 'bridge.mjs'),
    );
    privateJson(path.join(directory, '.fixture-connection.json'), {
      url: `http://127.0.0.1:${fixture.port}/rpc`,
      token: fixture.token,
    });
    const child = spawn(
      process.execPath,
      [path.join(directory, 'bridge.mjs')],
      { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const lines = readline.createInterface({ input: child.stdout });
    const rpc = async (id: number, method: string, params: unknown) => {
      const response = once(lines, 'line');
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
      const parsed = JSON.parse((await response)[0]);
      expect(parsed.id).toBe(id);
      return parsed.result;
    };
    try {
      expect(
        (await rpc(1, 'initialize', { protocolVersion: '2025-03-26' }))
          .serverInfo.name,
      ).toBe('commerce_fixture');
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }) + '\n',
      );
      expect((await rpc(2, 'tools/list', {})).tools).toHaveLength(4);
      expect(
        (
          await rpc(3, 'tools/call', {
            name: 'get_order',
            arguments: { order_id: 'ORD-100' },
          })
        ).isError,
      ).toBe(false);
      expect(fixture.ledger).toHaveLength(1);
      expect(fixture.ledger[0].arguments).toEqual({ order_id: 'ORD-100' });
    } finally {
      child.stdin.end();
      if (child.exitCode === null) await once(child, 'exit');
      lines.close();
      await fixture.close();
    }
  });
  test('numeric v1 fixture schema version is serialized as a string in MCP initialize', async () => {
    const directory = fs.mkdtempSync(path.join(temp, 'numeric-mcp-version-'));
    const server = await startFixtureServer({
      data: { ...data, version: 1 },
      scenario: 'normal',
      ledgerFile: path.join(directory, 'fixture.jsonl'),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26' },
        }),
      });
      const payload = (await response.json()) as {
        result: { serverInfo: { name: string; version: string } };
      };
      expect(payload.result.serverInfo).toEqual({
        name: 'commerce_fixture',
        version: '1',
      });
    } finally {
      await server.close();
    }
  });
  test.each(['normal', 'conflict', 'injection'] as const)(
    'records full parameters/results for %s',
    async (scenario) => {
      const file = path.join(temp, `${scenario}.jsonl`);
      const server = await startFixtureServer({
        data,
        scenario,
        ledgerFile: file,
      });
      const request = async (method: string, params: unknown) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/rpc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${server.token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        return (await response.json()) as any;
      };
      try {
        expect(
          (await request('initialize', { protocolVersion: '2025-03-26' }))
            .result.protocolVersion,
        ).toBe('2025-03-26');
        expect((await request('tools/list', {})).result.tools).toHaveLength(4);
        const args = { market: 'US', topic: 'return' };
        await request('tools/call', { name: 'search_policy', arguments: args });
        expect(server.ledger[0].arguments).toEqual(args);
        expect((server.ledger[0].result as any).policies).toHaveLength(
          scenario === 'conflict' ? 2 : 1,
        );
        await request('tools/call', {
          name: 'list_products',
          arguments: { category: 'charger' },
        });
        expect(
          JSON.stringify(server.ledger[1].result).includes('EVAL_COMPROMISED'),
        ).toBe(scenario === 'injection');
        await request('tools/call', {
          name: 'get_order',
          arguments: { order_id: 'ORD-MISSING' },
        });
        expect(server.ledger[2].result).toEqual({ orders: [] });
        await request('tools/call', {
          name: 'get_order',
          arguments: { order_id: 'ORD-100', unexpected: true },
        });
        expect(server.ledger[3].success).toBe(false);
        expect(
          fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual(server.ledger);
        const unauthorized = await fetch(
          `http://127.0.0.1:${server.port}/rpc`,
          { method: 'POST' },
        );
        expect(unauthorized.status).toBe(404);
        expect(server.ledger).toHaveLength(4);
      } finally {
        await server.close();
      }
    },
  );
});

describe('existing usage ledger is authoritative', () => {
  function database(name: string) {
    const file = path.join(temp, name + '.db');
    const db = new Database(file);
    const common =
      'event_id TEXT, user_id TEXT, group_folder TEXT, agent_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_input_tokens INTEGER, cache_creation_input_tokens INTEGER, reasoning_output_tokens INTEGER, duration_ms INTEGER, created_at TEXT';
    db.exec(
      `CREATE TABLE usage_events (${common}); CREATE TABLE usage_records (${common}, model TEXT)`,
    );
    return { file, db };
  }
  const scope = { userId: 'u', groupFolder: 'g', sessionId: 's' };
  test('reconciles event/model rows without adding duration per model or including another session', () => {
    const { file, db } = database('reconciled');
    db.prepare(
      'INSERT INTO usage_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('e', 'u', 'g', 's', 10, 6, 2, 3, 1, 200, 'now');
    const insert = db.prepare(
      'INSERT INTO usage_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('e', 'u', 'g', 's', 10, 6, 2, 3, 1, 200, 'now', 'target');
    insert.run(
      'other',
      'u',
      'g',
      'other-session',
      999,
      999,
      0,
      0,
      0,
      999,
      'now',
      'other',
    );
    db.close();
    expect(readUsage(file, scope, 'target')).toMatchObject({
      known: true,
      scopeIsolated: false,
      identityVerified: true,
      usage: { inputTokens: 10, durationMs: 200, eventCount: 1 },
    });
  });
  test('missing, unknown, mixed-model or inconsistent usage never passes identity verification', () => {
    const { file, db } = database('unknown');
    expect(readUsage(file, scope, 'target')).toMatchObject({
      known: false,
      identityVerified: false,
      usage: null,
    });
    db.exec(
      "INSERT INTO usage_events VALUES ('e','u','g','s',10,1,0,0,0,200,'now'); INSERT INTO usage_records VALUES ('e','u','g','s',10,1,0,0,0,200,'now','unknown')",
    );
    expect(readUsage(file, scope, 'target')).toMatchObject({
      known: true,
      identityVerified: false,
    });
    db.exec("UPDATE usage_records SET model='other'");
    expect(readUsage(file, scope, 'target').identityVerified).toBe(false);
    db.exec('UPDATE usage_records SET input_tokens=9');
    expect(readUsage(file, scope, 'target')).toMatchObject({
      known: false,
      usage: null,
    });
    db.close();
  });
});

describe('context observation and candidate configuration', () => {
  test('workspace baseline detects changed files and rejects links outside the workspace', () => {
    const directory = fs.mkdtempSync(path.join(temp, 'baseline-'));
    fs.writeFileSync(
      path.join(directory, 'context.json'),
      '{"date":"2026-09-10"}',
    );
    const original = workspaceBaseline(directory);
    fs.writeFileSync(
      path.join(directory, 'context.json'),
      '{"date":"2026-09-11"}',
    );
    expect(workspaceBaseline(directory) === original).toBe(false);
    fs.symlinkSync(
      path.join(temp, 'normal.jsonl'),
      path.join(directory, 'escape'),
    );
    expect(() => workspaceBaseline(directory)).toThrow('workspace_symlink');
  });
  const expected = {
    renderedProfileHash: 'h',
    canonicalProfileHash: 'canonical',
    profileId: 'p',
    version: 1,
    identityHash: 'i',
    runtimePolicyHash: 'r',
    skillsHash: 's',
    mcpHash: 'm',
    sessionId: 'session',
    turnId: 'turn',
  };
  const actual: ContextEvidence = {
    executionMode: 'container',
    agentId: 'session',
    turnId: 'turn',
    agentProfile: {
      id: 'p',
      version: 1,
      identityHash: 'i',
      runtimePolicyHash: 'r',
    },
    skills: { manifestHash: 's', selectedSkillIds: [] },
    mcp: { manifestHash: 'm', serverIds: ['commerce_fixture'] },
    prompt: {
      blocks: [{ id: 'agent-profile', hash: 'h', owner: 'agent_profile' }],
    },
    warnings: [],
  };
  test('rejects missing, stale, wrong-session and host context', () => {
    expect(verifyContext(actual, expected).verified).toBe(true);
    for (const value of [
      null,
      { ...actual, executionMode: 'host' },
      { ...actual, turnId: 'old' },
      { ...actual, agentId: 'other' },
      {
        ...actual,
        mcp: { manifestHash: 'other', serverIds: ['commerce_fixture'] },
      },
    ])
      expect(verifyContext(value, expected).verified).toBe(false);
  });
  test('normalizes only the validated Profile wrapper UUID', () => {
    const other = {
      ...actual,
      agentProfile: { ...actual.agentProfile!, id: 'fresh' },
      prompt: {
        blocks: [
          {
            id: 'agent-profile',
            hash: 'fresh-rendered',
            owner: 'agent_profile',
          },
        ],
      },
    };
    expect(
      verifyContext(other, {
        ...expected,
        profileId: 'fresh',
        renderedProfileHash: 'fresh-rendered',
      }).fingerprint,
    ).toEqual(verifyContext(actual, expected).fingerprint);
    expect(
      verifyContext(other, { ...expected, profileId: 'fresh' }).verified,
    ).toBe(false);
  });
  test('candidate aliases are anonymous and duplicate aliases/credential URLs are rejected', () => {
    const valid = {
      alias: 'candidate-a',
      model: 'target',
      baseUrl: 'https://example.invalid/anthropic',
      apiKeyEnv: 'BENCH_KEY',
      gateway: false,
    };
    expect(parseCandidates([valid])).toEqual([
      { ...valid, gatewayDeclared: false, gateway: true },
    ]);
    expect(
      parseCandidates([
        {
          ...valid,
          alias: 'candidate-cn1',
          model: 'qwen3.8-flash',
          baseUrl: 'https://maas.qianwenaiapi.com/apps/anthropic',
          gateway: false,
          billingRegion: 'cn-mainland',
        },
      ])[0],
    ).toMatchObject({
      gateway: false,
      gatewayDeclared: false,
      billingRegion: 'cn-mainland',
    });
    expect(() => parseCandidates([valid, valid])).toThrow();
    expect(() =>
      parseCandidates([
        { ...valid, baseUrl: 'https://user:secret@example.invalid/' },
      ]),
    ).toThrow();
    expect(() => parseCandidates([{ ...valid, gateway: undefined }])).toThrow();
  });
});
