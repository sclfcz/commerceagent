import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  findTranscriptDir,
  prepareStrippedResume,
  probePair,
  stripResultInconclusive,
  type RunTurn,
  type RunTurnOptions,
} from '../scripts/session-continuity-probe-core.js';

let scratch: string;
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-core-'));
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function transcriptLines(sessionId: string, withThinking: boolean): string {
  const assistantContent = [
    ...(withThinking
      ? [{ type: 'thinking', thinking: 'plan', signature: 'sig-from' }]
      : []),
    { type: 'tool_use', id: 'tu1', name: 'mcp__probe__lookup_order' },
  ];
  return [
    { type: 'user', uuid: 'u1', sessionId, message: { content: 'hi' } },
    {
      type: 'assistant',
      uuid: 'a1',
      parentUuid: 'u1',
      sessionId,
      message: { content: assistantContent },
    },
    {
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\n');
}

function writeTranscript(
  opts: RunTurnOptions<string>,
  sessionId: string,
  withThinking: boolean,
): void {
  const dir = path.join(
    opts.configDir,
    'projects',
    opts.cwd.replace(/[^a-zA-Z0-9]/g, '-'),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    transcriptLines(sessionId, withThinking),
  );
}

/**
 * Fake SDK turn runner: the first turn writes a transcript (optionally with
 * thinking), the resumed turn answers with both codes when the resumed
 * transcript exists and carries no thinking block.
 */
function fakeRunTurn(config: {
  thinking: boolean;
  firstOk?: boolean;
  seen?: Array<{ resume?: string; transcript?: string }>;
}): { runTurn: RunTurn<string>; firstCode: () => string } {
  let firstCode = '';
  const runTurn: RunTurn<string> = async (opts) => {
    if (!opts.resume) {
      firstCode = opts.code;
      if (config.firstOk === false) {
        return { ok: false, text: '', toolCalls: 0, streamed: false };
      }
      writeTranscript(opts, 'first-session', config.thinking);
      return {
        sessionId: 'first-session',
        ok: true,
        text: '已查询',
        toolCalls: 1,
        streamed: true,
      };
    }
    const dir = findTranscriptDir(opts.configDir, opts.resume);
    const transcript = dir
      ? fs.readFileSync(path.join(dir, `${opts.resume}.jsonl`), 'utf-8')
      : undefined;
    config.seen?.push({ resume: opts.resume, transcript });
    return {
      sessionId: opts.resume,
      ok: !!transcript,
      text: `A-1=${firstCode};B-2=${opts.code}`,
      toolCalls: 1,
      streamed: true,
    };
  };
  return { runTurn, firstCode: () => firstCode };
}

describe('probePair strip_thinking mode', () => {
  test('resumes a new session id whose transcript has no thinking blocks', async () => {
    const seen: Array<{ resume?: string; transcript?: string }> = [];
    const { runTurn } = fakeRunTurn({ thinking: true, seen });

    const outcome = await probePair({
      from: 'a',
      to: 'b',
      mode: 'strip_thinking',
      runTurn,
      workDir: scratch,
    });

    expect(outcome).toEqual({
      kind: 'checked',
      checks: {
        resumed: true,
        recalledToolResult: true,
        toolCallAfterResume: true,
        streamed: true,
      },
      strip: { created: true, thinkingBlocksStripped: 1 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].resume).not.toBe('first-session');
    expect(seen[0].transcript).not.toContain('"thinking"');
    expect(seen[0].transcript).toContain('tool_result');
    expect(seen[0].transcript).toContain(`"sessionId":"${seen[0].resume}"`);
    // The original transcript is left untouched.
    const dir = findTranscriptDir(
      path.join(scratch, '.claude'),
      'first-session',
    );
    expect(
      fs.readFileSync(path.join(dir!, 'first-session.jsonl'), 'utf-8'),
    ).toContain('"thinking"');
    if (outcome.kind === 'checked') {
      expect(stripResultInconclusive(outcome.strip!)).toBe(false);
    }
  });

  test('reports zero stripped blocks (inconclusive) when the first turn had no thinking', async () => {
    const { runTurn } = fakeRunTurn({ thinking: false });

    const outcome = await probePair({
      from: 'a',
      to: 'a',
      mode: 'strip_thinking',
      runTurn,
      workDir: scratch,
    });

    expect(outcome.kind).toBe('checked');
    if (outcome.kind !== 'checked') return;
    expect(outcome.strip).toEqual({ created: true, thinkingBlocksStripped: 0 });
    expect(stripResultInconclusive(outcome.strip!)).toBe(true);
  });

  test('a failed first turn never reaches the resume turn', async () => {
    const seen: Array<{ resume?: string }> = [];
    const { runTurn } = fakeRunTurn({ thinking: true, firstOk: false, seen });

    const outcome = await probePair({
      from: 'a',
      to: 'b',
      mode: 'strip_thinking',
      runTurn,
      workDir: scratch,
    });

    expect(outcome).toEqual({ kind: 'first_turn_failed' });
    expect(seen).toHaveLength(0);
  });

  test('a missing transcript is a strip failure, not a resume failure', async () => {
    const seen: Array<{ resume?: string }> = [];
    const runTurn: RunTurn<string> = async (opts) => {
      if (opts.resume) seen.push({ resume: opts.resume });
      return {
        sessionId: 'no-file',
        ok: true,
        text: '',
        toolCalls: 1,
        streamed: true,
      };
    };

    const outcome = await probePair({
      from: 'a',
      to: 'b',
      mode: 'strip_thinking',
      runTurn,
      workDir: scratch,
    });

    expect(outcome).toEqual({
      kind: 'strip_failed',
      strip: {
        created: false,
        thinkingBlocksStripped: 0,
        reason: 'transcript_not_found',
      },
    });
    expect(seen).toHaveLength(0);
  });

  test('direct mode resumes the original session id', async () => {
    const seen: Array<{ resume?: string; transcript?: string }> = [];
    const { runTurn } = fakeRunTurn({ thinking: true, seen });

    const outcome = await probePair({
      from: 'a',
      to: 'b',
      mode: 'direct',
      runTurn,
      workDir: scratch,
    });

    expect(seen[0].resume).toBe('first-session');
    expect(outcome.kind).toBe('checked');
    if (outcome.kind === 'checked') expect(outcome.strip).toBeUndefined();
  });
});

describe('prepareStrippedResume', () => {
  test('finds the transcript under any projects/ subdirectory', () => {
    const configDir = path.join(scratch, '.claude');
    const dir = path.join(configDir, 'projects', '-private-tmp-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's1.jsonl'), transcriptLines('s1', true));

    const prepared = prepareStrippedResume({
      configDir,
      sessionId: 's1',
      newSessionId: 's2',
    });

    expect(prepared).toEqual({
      sessionId: 's2',
      created: true,
      thinkingBlocksStripped: 1,
    });
    expect(fs.existsSync(path.join(dir, 's2.jsonl'))).toBe(true);
  });
});

// CLI wiring: the SDK and provider config are mocked so no request is made.
describe('probe CLI --strip-thinking', () => {
  const writeResumeMatrixEntries = vi.fn();

  async function runCli(argv: string[]): Promise<string[]> {
    vi.resetModules();
    writeResumeMatrixEntries.mockReset();
    const handlers: Array<() => Promise<unknown>> = [];
    vi.doMock('../src/load-env.js', () => ({}));
    vi.doMock('../src/runtime-config.js', () => ({
      getProviders: () => [
        { id: 'p1', name: 'P1', enabled: true },
        { id: 'p2', name: 'P2', enabled: false },
      ],
      resolveProviderById: () => ({ config: {}, customEnv: {} }),
      buildClaudeEnvLines: () => [],
      clearInheritedClaudeProviderEnv: () => {},
      writeCredentialsFile: () => {},
    }));
    vi.doMock('../src/session-continuity.js', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      providerContinuityFingerprint: (p: { id: string }) => p.id,
      writeResumeMatrixEntries,
    }));
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      tool: (_n: string, _d: string, _s: unknown, handler: () => unknown) => {
        handlers.push(handler as () => Promise<unknown>);
        return {};
      },
      createSdkMcpServer: () => ({}),
      query: ({
        options,
      }: {
        options: {
          cwd: string;
          resume?: string;
          env: Record<string, string>;
        };
      }) =>
        (async function* () {
          const sessionId = options.resume ?? `s-${handlers.length}`;
          if (!options.resume) {
            writeTranscript(
              {
                configDir: options.env.CLAUDE_CONFIG_DIR,
                cwd: options.cwd,
              } as RunTurnOptions<string>,
              sessionId,
              true,
            );
          }
          await handlers[handlers.length - 1]();
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          yield { type: 'stream_event' };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: sessionId,
            result: 'ok',
          };
        })(),
    }));

    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        out.push(String(chunk));
        return true;
      });
    const errWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const originalArgv = process.argv;
    const originalExit = process.exitCode;
    process.argv = ['node', 'probe', ...argv];
    try {
      await import('../scripts/probe-session-continuity.js');
      await vi.waitFor(() => {
        expect(out.length).toBeGreaterThanOrEqual(4);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExit;
      write.mockRestore();
      errWrite.mockRestore();
    }
    return out;
  }

  test('strip mode prints per-pair stripped counts and never writes the matrix', async () => {
    const out = await runCli(['--all', '--strip-thinking']);
    const rows = out
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({
        mode: 'strip_thinking',
        thinkingBlocksStripped: 1,
        resumed: true,
        streamed: true,
      });
      // Only provider names, booleans and counts.
      expect(Object.keys(row).sort()).toEqual(
        [
          'elapsedMs',
          'from',
          'mode',
          'recalledToolResult',
          'resume',
          'resumed',
          'streamed',
          'thinkingBlocksStripped',
          'to',
          'toolCallAfterResume',
        ].sort(),
      );
    }
    expect(writeResumeMatrixEntries).not.toHaveBeenCalled();
    expect(out.join('')).not.toContain('Matrix updated');
  });

  test('direct mode still writes the matrix', async () => {
    await runCli(['--all']);
    expect(writeResumeMatrixEntries).toHaveBeenCalledTimes(1);
  });
});
