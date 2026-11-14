/**
 * Session continuity probe (real provider requests, may incur cost).
 *
 * For every ordered pair of configured providers (from → to):
 *   1. Start a session on `from` with thinking enabled. The model must call a
 *      tool whose result carries a secret code that never appears in any
 *      user message.
 *   2. Resume that SDK session on `to` and check that it (a) completes without
 *      an API error, (b) recalls the code, which only exists in the earlier
 *      tool result, (c) can still call a tool and use the result, and (d)
 *      streams partial events.
 *
 * Passing pairs are written to data/config/session-continuity-matrix.json,
 * which the provider pool reads to decide whether a session may move between
 * accounts or models without being dropped. Output contains provider names and
 * booleans only, never endpoints, models, credentials or response text.
 *
 * Usage:
 *   npm run probe:session-continuity              # all enabled providers
 *   npm run probe:session-continuity -- --all     # include disabled ones
 *   npm run probe:session-continuity -- --dry-run # do not write the matrix
 */
import '../src/load-env.js';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  buildClaudeEnvLines,
  clearInheritedClaudeProviderEnv,
  getProviders,
  resolveProviderById,
  writeCredentialsFile,
  type UnifiedProvider,
} from '../src/runtime-config.js';
import {
  providerContinuityFingerprint,
  resumeChecksPass,
  writeResumeMatrixEntries,
  type ResumeCheckResult,
  type ResumeMatrixEntry,
} from '../src/session-continuity.js';

const args = new Set(process.argv.slice(2));
const TIMEOUT_MS = 180_000;

interface TurnResult {
  sessionId?: string;
  text: string;
  ok: boolean;
  toolCalls: number;
  streamed: boolean;
}

function providerEnv(
  provider: UnifiedProvider,
  configDir: string,
): Record<string, string | undefined> {
  const { config, customEnv } = resolveProviderById(provider.id);
  const env: Record<string, string | undefined> = { ...process.env };
  clearInheritedClaudeProviderEnv(env);
  for (const line of buildClaudeEnvLines(config, customEnv)) {
    const eq = line.indexOf('=');
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  writeCredentialsFile(configDir, config);
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

async function runTurn(opts: {
  provider: UnifiedProvider;
  configDir: string;
  cwd: string;
  prompt: string;
  resume?: string;
  code: string;
}): Promise<TurnResult> {
  let toolCalls = 0;
  const server = createSdkMcpServer({
    name: 'probe',
    version: '1.0.0',
    tools: [
      tool(
        'lookup_order',
        'Look up an order by id and return its verification code.',
        { orderId: z.string() },
        async () => {
          toolCalls += 1;
          return {
            content: [{ type: 'text', text: `verification_code=${opts.code}` }],
          };
        },
      ),
    ],
  });
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  const result: TurnResult = {
    text: '',
    ok: false,
    toolCalls: 0,
    streamed: false,
  };
  try {
    const conversation = query({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        env: providerEnv(opts.provider, opts.configDir),
        ...(opts.resume ? { resume: opts.resume } : {}),
        thinking: { type: 'enabled', budgetTokens: 2048 },
        includePartialMessages: true,
        mcpServers: { probe: server },
        tools: [],
        allowedTools: ['mcp__probe__lookup_order'],
        settingSources: [],
        skills: [],
        maxTurns: 6,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });
    for await (const event of conversation) {
      if (event.type === 'stream_event') result.streamed = true;
      if (event.type === 'system' && event.subtype === 'init') {
        result.sessionId = event.session_id;
      }
      if (event.type === 'result') {
        result.sessionId = event.session_id || result.sessionId;
        result.ok = event.subtype === 'success' && !event.is_error;
        if (event.subtype === 'success') result.text = event.result ?? '';
      }
    }
  } catch {
    result.ok = false;
  } finally {
    clearTimeout(timer);
  }
  result.toolCalls = toolCalls;
  return result;
}

async function probePair(
  from: UnifiedProvider,
  to: UnifiedProvider,
): Promise<ResumeCheckResult> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-continuity-'));
  const configDir = path.join(workDir, '.claude');
  const cwd = path.join(workDir, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const firstCode = `C${crypto.randomInt(100000, 999999)}`;
  const secondCode = `D${crypto.randomInt(100000, 999999)}`;
  const failed: ResumeCheckResult = {
    resumed: false,
    recalledToolResult: false,
    toolCallAfterResume: false,
    streamed: false,
  };
  try {
    const first = await runTurn({
      provider: from,
      configDir,
      cwd,
      code: firstCode,
      prompt:
        '请调用 lookup_order 工具查询订单 A-1，然后只回复“已查询”，不要复述验证码。',
    });
    if (!first.ok || !first.sessionId || first.toolCalls === 0) return failed;

    const second = await runTurn({
      provider: to,
      configDir,
      cwd,
      code: secondCode,
      resume: first.sessionId,
      prompt:
        '1. 回忆上一次查询订单 A-1 时工具返回的验证码。' +
        '2. 再调用 lookup_order 查询订单 B-2。' +
        '最后只输出一行：A-1=<验证码>;B-2=<验证码>',
    });
    return {
      resumed: second.ok,
      recalledToolResult: second.ok && second.text.includes(firstCode),
      toolCallAfterResume:
        second.ok && second.toolCalls > 0 && second.text.includes(secondCode),
      streamed: second.streamed,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const providers = getProviders().filter(
    (p) => args.has('--all') || p.enabled,
  );
  if (providers.length === 0) {
    process.stderr.write('No providers configured.\n');
    process.exitCode = 1;
    return;
  }
  const pairs: Array<[UnifiedProvider, UnifiedProvider]> = [];
  for (const from of providers) {
    for (const to of providers) pairs.push([from, to]);
  }

  const entries: ResumeMatrixEntry[] = [];
  for (const [from, to] of pairs) {
    const startedAt = Date.now();
    const checks = await probePair(from, to);
    const entry: ResumeMatrixEntry = {
      fromFingerprint: providerContinuityFingerprint(from),
      toFingerprint: providerContinuityFingerprint(to),
      fromName: from.name,
      toName: to.name,
      checks,
      resume: resumeChecksPass(checks),
      checkedAt: new Date().toISOString(),
    };
    entries.push(entry);
    process.stdout.write(
      `${JSON.stringify({
        from: from.name,
        to: to.name,
        ...checks,
        resume: entry.resume,
        elapsedMs: Date.now() - startedAt,
      })}\n`,
    );
  }

  // Same-provider pairs are a baseline: if they fail, the probe itself (or
  // that provider) is broken and cross-provider results are not trustworthy.
  const baselineFailures = entries.filter(
    (e) => e.fromFingerprint === e.toFingerprint && !e.resume,
  );
  if (baselineFailures.length > 0) {
    process.stderr.write(
      `Baseline (same provider) failed for: ${baselineFailures
        .map((e) => e.fromName)
        .join(', ')}\n`,
    );
    process.exitCode = 1;
  }

  if (!args.has('--dry-run')) {
    writeResumeMatrixEntries(
      entries.filter((e) => e.fromFingerprint !== e.toFingerprint),
    );
    process.stdout.write('Matrix updated.\n');
  }
}

void main().catch(() => {
  process.stderr.write('session continuity probe failed\n');
  process.exitCode = 1;
});
