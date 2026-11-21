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
 * accounts or models without being dropped. Same-provider pairs are written as
 * baselines (`from === to`): they tell the model catalog whether an upstream
 * can even continue the session it produced itself, and cross-provider results
 * are only meaningful while that baseline holds. Output contains provider names
 * and booleans only, never endpoints, models, credentials or response text.
 *
 * Usage:
 *   npm run probe:session-continuity              # all enabled providers
 *   npm run probe:session-continuity -- --all     # include disabled ones
 *   npm run probe:session-continuity -- --dry-run # do not write the matrix
 *   npm run probe:session-continuity -- --strip-thinking
 *
 * `--strip-thinking` exercises the fallback used for unverified pairs: after
 * the first turn, thinking blocks are removed into a new session id (the
 * runner's `createThinkingStrippedSession`) and that copy is resumed on `to`.
 * Its results are printed only and never written to the matrix, which records
 * direct resume. A pair whose first turn produced no thinking blocks is
 * reported as inconclusive, since nothing was actually stripped.
 */
import '../src/load-env.js';

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
  type ResumeMatrixEntry,
} from '../src/session-continuity.js';
import {
  probePair,
  stripResultInconclusive,
  type RunTurnOptions,
  type TurnResult,
} from './session-continuity-probe-core.js';

const args = new Set(process.argv.slice(2));
const TIMEOUT_MS = 180_000;

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

async function runTurn(
  opts: RunTurnOptions<UnifiedProvider>,
): Promise<TurnResult> {
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

async function main(): Promise<void> {
  const providers = getProviders().filter(
    (p) => args.has('--all') || p.enabled,
  );
  if (providers.length === 0) {
    process.stderr.write('No providers configured.\n');
    process.exitCode = 1;
    return;
  }
  const stripMode = args.has('--strip-thinking');
  const pairs: Array<[UnifiedProvider, UnifiedProvider]> = [];
  for (const from of providers) {
    for (const to of providers) pairs.push([from, to]);
  }

  const entries: ResumeMatrixEntry[] = [];
  const inconclusive: string[] = [];
  for (const [from, to] of pairs) {
    const startedAt = Date.now();
    const outcome = await probePair({
      from,
      to,
      mode: stripMode ? 'strip_thinking' : 'direct',
      runTurn,
    });
    const label = `${from.name} → ${to.name}`;
    const base = { from: from.name, to: to.name };
    if (outcome.kind !== 'checked') {
      inconclusive.push(label);
      process.stdout.write(
        `${JSON.stringify({
          ...base,
          inconclusive: true,
          cause: outcome.kind,
          ...(outcome.kind === 'strip_failed'
            ? {
                thinkingBlocksStripped: outcome.strip.thinkingBlocksStripped,
                stripReason: outcome.strip.reason,
              }
            : {}),
          elapsedMs: Date.now() - startedAt,
        })}\n`,
      );
      continue;
    }
    const { checks, strip } = outcome;
    const resume = resumeChecksPass(checks);
    if (strip) {
      // Strip mode: report only, never persisted.
      const noThinking = stripResultInconclusive(strip);
      if (noThinking) inconclusive.push(label);
      else if (!resume) process.exitCode = 1;
      process.stdout.write(
        `${JSON.stringify({
          ...base,
          mode: 'strip_thinking',
          thinkingBlocksStripped: strip.thinkingBlocksStripped,
          ...checks,
          resume,
          ...(noThinking ? { inconclusive: true, cause: 'no_thinking' } : {}),
          elapsedMs: Date.now() - startedAt,
        })}\n`,
      );
      continue;
    }
    const entry: ResumeMatrixEntry = {
      fromFingerprint: providerContinuityFingerprint(from),
      toFingerprint: providerContinuityFingerprint(to),
      fromName: from.name,
      toName: to.name,
      checks,
      resume,
      checkedAt: new Date().toISOString(),
    };
    entries.push(entry);
    process.stdout.write(
      `${JSON.stringify({
        ...base,
        ...checks,
        resume,
        elapsedMs: Date.now() - startedAt,
      })}\n`,
    );
  }

  // Same-provider pairs are a baseline: if they fail, the probe itself (or
  // that provider) is broken and cross-provider results are not trustworthy.
  // Baselines are persisted as well so the model catalog can tell a provider
  // that continues its own sessions from one that was simply never probed.
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

  if (inconclusive.length > 0) {
    process.stderr.write(
      `Inconclusive (first turn failed, or no thinking to strip): ${inconclusive.join(', ')}\n`,
    );
    process.exitCode = 1;
  }

  if (!stripMode && !args.has('--dry-run') && entries.length > 0) {
    writeResumeMatrixEntries(entries);
    process.stdout.write('Matrix updated.\n');
  }
}

void main().catch(() => {
  process.stderr.write('session continuity probe failed\n');
  process.exitCode = 1;
});
