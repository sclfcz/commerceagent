import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createThinkingStrippedSession,
  stripThinkingFromTranscriptContent,
} from '../container/agent-runner/src/thinking-strip.js';

const NEW_SESSION = '11111111-2222-4333-8444-555555555555';

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function assistant(
  content: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): string {
  return line({
    type: 'assistant',
    sessionId: 'old-session',
    ...extra,
    message: { role: 'assistant', content },
  });
}

function user(content: unknown, extra: Record<string, unknown> = {}): string {
  return line({
    type: 'user',
    sessionId: 'old-session',
    ...extra,
    message: { role: 'user', content },
  });
}

function parseLines(content: string): Array<Record<string, unknown>> {
  return content
    .split('\n')
    .filter((entry) => entry.trim())
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
}

describe('stripThinkingFromTranscriptContent', () => {
  test('removes thinking and redacted_thinking but keeps text and tool_use', () => {
    const transcript = [
      user([{ type: 'text', text: '查一下订单' }], { uuid: 'u1' }),
      assistant(
        [
          { type: 'thinking', thinking: '内部推理', signature: 'sig-A' },
          { type: 'redacted_thinking', data: 'encrypted' },
          { type: 'text', text: '好的' },
          { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
        ],
        { uuid: 'a1', parentUuid: 'u1' },
      ),
    ].join('\n');

    const result = stripThinkingFromTranscriptContent(transcript, NEW_SESSION);

    expect(result.didMutate).toBe(true);
    expect(result.stats.strippedBlocks).toBe(2);
    const [first, second] = parseLines(result.content);
    expect((second.message as { content: unknown[] }).content).toEqual([
      { type: 'text', text: '好的' },
      { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
    ]);
    expect(JSON.stringify(first)).not.toContain('thinking');
  });

  test('keeps tool_use / tool_result pairs and the tool_use id', () => {
    const toolResult = user(
      [{ type: 'tool_result', tool_use_id: 'tool-1', content: '订单已发货' }],
      { uuid: 'u2', parentUuid: 'a1' },
    );
    const transcript = [
      assistant(
        [
          { type: 'thinking', thinking: 'x', signature: 'sig-A' },
          { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
        ],
        { uuid: 'a1' },
      ),
      toolResult,
    ].join('\n');

    const result = stripThinkingFromTranscriptContent(transcript, NEW_SESSION);
    const [first, second] = parseLines(result.content);

    expect((first.message as { content: unknown[] }).content).toEqual([
      { type: 'tool_use', id: 'tool-1', name: 'lookup', input: {} },
    ]);
    // The result line is emitted byte-identically apart from the session id.
    expect(second).toMatchObject({
      type: 'user',
      uuid: 'u2',
      parentUuid: 'a1',
      sessionId: NEW_SESSION,
    });
    expect((second.message as { content: unknown[] }).content).toEqual([
      { type: 'tool_result', tool_use_id: 'tool-1', content: '订单已发货' },
    ]);
  });

  test('keeps a thinking-only assistant entry so the parentUuid chain stays intact', () => {
    const transcript = [
      assistant(
        [{ type: 'thinking', thinking: '只有推理', signature: 'sig-A' }],
        { uuid: 'a-thinking-only', parentUuid: null },
      ),
      user([{ type: 'tool_result', tool_use_id: 'tool-9', content: 'ok' }], {
        uuid: 'u-after',
        parentUuid: 'a-thinking-only',
      }),
    ].join('\n');

    const result = stripThinkingFromTranscriptContent(transcript, NEW_SESSION);
    const entries = parseLines(result.content);

    expect(entries).toHaveLength(2);
    expect(result.stats.emptiedAssistantEntries).toBe(1);
    expect(entries[0]).toMatchObject({
      type: 'assistant',
      uuid: 'a-thinking-only',
      parentUuid: null,
    });
    expect((entries[0].message as { content: unknown[] }).content).toEqual([]);

    // Every referenced parent still exists in the rewritten transcript.
    const uuids = new Set(entries.map((entry) => entry.uuid));
    for (const entry of entries) {
      if (entry.parentUuid) expect(uuids.has(entry.parentUuid)).toBe(true);
    }
  });

  test('leaves entries without thinking byte-identical and tolerates bad lines', () => {
    const plainUser = user([{ type: 'text', text: '原样保留' }]);
    const transcript = [plainUser, 'not-json{', ''].join('\n');

    const result = stripThinkingFromTranscriptContent(transcript, NEW_SESSION);

    // The entry carries 'old-session', so it is re-keyed to the new id.
    const entries = parseLines(result.content.split('\n')[0]);
    expect(entries[0].sessionId).toBe(NEW_SESSION);
    expect(result.stats.rewrittenEntries).toBe(1);
    expect(result.stats.unparsableLines).toBe(1);
    expect(result.content.split('\n')[1]).toBe('not-json{');
  });

  test('reports no mutation when nothing needs rewriting', () => {
    const transcript = line({
      type: 'user',
      sessionId: NEW_SESSION,
      message: { role: 'user', content: 'hi' },
    });
    const result = stripThinkingFromTranscriptContent(transcript, NEW_SESSION);
    expect(result.didMutate).toBe(false);
    expect(result.content).toBe(transcript);
  });
});

describe('createThinkingStrippedSession', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-strip-'));
    dirs.push(dir);
    return dir;
  }

  test('writes a new transcript and leaves the original untouched', () => {
    const dir = makeDir();
    const original = [
      user([{ type: 'text', text: '第一轮' }], { uuid: 'u1' }),
      assistant(
        [
          { type: 'thinking', thinking: '推理', signature: 'sig-A' },
          { type: 'text', text: '回答' },
        ],
        { uuid: 'a1', parentUuid: 'u1' },
      ),
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'old-session.jsonl'), original);

    const result = createThinkingStrippedSession({
      transcriptDir: dir,
      sessionId: 'old-session',
      newSessionId: NEW_SESSION,
    });

    expect(result).toMatchObject({
      created: true,
      sessionId: NEW_SESSION,
      strippedBlocks: 1,
      emptiedAssistantEntries: 0,
    });
    expect(fs.readFileSync(path.join(dir, 'old-session.jsonl'), 'utf-8')).toBe(
      original,
    );
    const copy = fs.readFileSync(
      path.join(dir, `${NEW_SESSION}.jsonl`),
      'utf-8',
    );
    expect(copy).not.toContain('"thinking"');
    expect(copy).toContain('回答');
    expect(
      copy
        .split('\n')
        .every((l) => !l || JSON.parse(l).sessionId === NEW_SESSION),
    ).toBe(true);
    // No temp file is left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(
      ['old-session.jsonl', `${NEW_SESSION}.jsonl`].sort(),
    );
  });

  test('clones the sessions index entry when the CLI keeps one', () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, 'old-session.jsonl'),
      assistant([{ type: 'text', text: 'hi' }], { uuid: 'a1' }),
    );
    fs.writeFileSync(
      path.join(dir, 'sessions-index.json'),
      JSON.stringify({
        entries: [
          {
            sessionId: 'old-session',
            fullPath: path.join(dir, 'old-session.jsonl'),
            summary: '历史摘要',
            firstPrompt: '你好',
          },
        ],
      }),
    );

    createThinkingStrippedSession({
      transcriptDir: dir,
      sessionId: 'old-session',
      newSessionId: NEW_SESSION,
    });

    const index = JSON.parse(
      fs.readFileSync(path.join(dir, 'sessions-index.json'), 'utf-8'),
    ) as { entries: Array<Record<string, string>> };
    expect(index.entries).toHaveLength(2);
    expect(index.entries[1]).toMatchObject({
      sessionId: NEW_SESSION,
      summary: '历史摘要',
      firstPrompt: '你好',
    });
  });

  test('returns the original id when the transcript is missing', () => {
    const dir = makeDir();
    const result = createThinkingStrippedSession({
      transcriptDir: dir,
      sessionId: 'gone-session',
      newSessionId: NEW_SESSION,
    });

    expect(result).toMatchObject({
      created: false,
      sessionId: 'gone-session',
      reason: 'missing_transcript',
    });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
