import { expect, test } from 'vitest';
import {
  buildFixtureTurnEvidence,
  verifyTraceTurnEvidence,
} from '../benchmarks/lib/turn-evidence.js';
import type { ToolCall } from '../benchmarks/lib/contracts.js';

const streamTool = (turn: number, changes: Record<string, unknown> = {}) => ({
  id: `tool-${turn}`,
  name: 'mcp__commerce_fixture__get_order',
  resultObserved: true,
  failed: false,
  unavailable: false,
  ...changes,
});
const turn = (turnIndex: number, changes: Record<string, unknown> = {}) => ({
  turnIndex,
  runId: `run-${turnIndex}`,
  turnId: `stream-${turnIndex}`,
  messageTurnId: `message-${turnIndex}`,
  reason: 'completed',
  failure: null,
  output: `answer-${turnIndex}`,
  fixtureSequenceStart: turnIndex,
  fixtureSequenceEnd: turnIndex,
  streamTools: [streamTool(turnIndex)],
  ...changes,
});
const call = (sequence: number, changes: Partial<ToolCall> = {}): ToolCall => ({
  sequence,
  name: 'get_order',
  arguments: { order_id: `ORD-${sequence}` },
  result: { orders: [] },
  success: true,
  isError: false,
  ...changes,
});

test('assigns ledger calls to sequential turn intervals without copying arguments or results', () => {
  const evidence = buildFixtureTurnEvidence({
    expectedTurnCount: 2,
    turns: [
      turn(1, {
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 2,
        streamTools: [streamTool(1), streamTool(1, { id: 'tool-1b' })],
      }),
      turn(2, { fixtureSequenceStart: 3, fixtureSequenceEnd: 3 }),
    ],
    ledger: [call(1), call(2), call(3)],
  });
  expect(evidence.complete).toBe(true);
  expect(
    evidence.turns.map((row) => row.fixtureCalls.map((item) => item.sequence)),
  ).toEqual([[1, 2], [3]]);
  expect(evidence.turns[1].turnId).toBe('stream-2');
  const serialized = JSON.stringify(evidence);
  expect(serialized).not.toContain('order_id');
  expect(serialized).not.toContain('ORD-1');
  expect(serialized).not.toContain('orders');
});

test('checks names, per-turn counts and tool-result statuses', () => {
  const good = buildFixtureTurnEvidence({
    expectedTurnCount: 1,
    turns: [turn(1)],
    ledger: [call(1)],
  });
  expect(good).toMatchObject({
    complete: true,
    turns: [
      { fixtureCalls: [{ sequence: 1, name: 'get_order' }], reasons: [] },
    ],
  });

  const wrongName = buildFixtureTurnEvidence({
    expectedTurnCount: 1,
    turns: [
      turn(1, {
        streamTools: [
          streamTool(1, { name: 'mcp__commerce_fixture__search_policy' }),
        ],
      }),
    ],
    ledger: [call(1)],
  });
  expect(wrongName.reasons).toContain(
    'turn_1:stream_fixture_tool_name_mismatch',
  );

  const wrongStatus = buildFixtureTurnEvidence({
    expectedTurnCount: 1,
    turns: [turn(1, { streamTools: [streamTool(1, { failed: true })] })],
    ledger: [call(1)],
  });
  expect(wrongStatus.reasons).toContain(
    'turn_1:stream_fixture_result_status_mismatch',
  );
});

test('fails closed for absent turn IDs, missing tool results and skipped turns', () => {
  const evidence = buildFixtureTurnEvidence({
    expectedTurnCount: 2,
    turns: [
      turn(1, {
        turnId: null,
        messageTurnId: null,
        streamTools: [streamTool(1, { resultObserved: false })],
      }),
    ],
    ledger: [call(1)],
  });
  expect(evidence.complete).toBe(false);
  expect(evidence.reasons).toEqual(
    expect.arrayContaining([
      'turn_count_mismatch',
      'turn_1:stream_turn_id_missing',
      'turn_1:persisted_message_turn_id_missing',
      'turn_1:stream_tool_result_missing',
    ]),
  );
});

test('detects gaps, overlapping ranges, duplicate IDs, and fixture calls with no turn', () => {
  const gap = buildFixtureTurnEvidence({
    expectedTurnCount: 2,
    turns: [
      turn(1, {
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 0,
        streamTools: [],
      }),
      turn(2, { fixtureSequenceStart: 2, fixtureSequenceEnd: 2 }),
    ],
    ledger: [call(1), call(2)],
  });
  expect(gap.reasons).toContain('turn_2:fixture_sequence_range_gap');
  expect(gap.reasons).toContain('fixture_calls_not_assigned_to_turn');

  const duplicate = buildFixtureTurnEvidence({
    expectedTurnCount: 2,
    turns: [
      turn(1),
      turn(2, {
        turnId: 'stream-1',
        messageTurnId: 'message-1',
        fixtureSequenceStart: 3,
        fixtureSequenceEnd: 1,
        streamTools: [],
      }),
    ],
    ledger: [call(1)],
  });
  expect(duplicate.reasons).toContain('turn_2:stream_turn_id_duplicate');
  expect(duplicate.reasons).toContain('turn_2:fixture_sequence_range_invalid');

  const unassigned = buildFixtureTurnEvidence({
    expectedTurnCount: 0,
    turns: [],
    ledger: [call(1)],
  });
  expect(unassigned.reasons).toContain('fixture_calls_not_assigned_to_turn');
});

test('permits tool-free turns and repeated tool names inside a known turn boundary', () => {
  const evidence = buildFixtureTurnEvidence({
    expectedTurnCount: 2,
    turns: [
      turn(1, {
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 0,
        streamTools: [],
      }),
      turn(2, {
        fixtureSequenceStart: 1,
        fixtureSequenceEnd: 2,
        streamTools: [streamTool(2), streamTool(2, { id: 'tool-2b' })],
      }),
    ],
    ledger: [call(1), call(2)],
  });
  expect(evidence.complete).toBe(true);
  expect(evidence.turns.map((row) => row.fixtureCalls.length)).toEqual([0, 2]);
});

test('independent verification rejects missing multi-turn boundaries but accepts an unambiguous legacy single turn', () => {
  const multi = verifyTraceTurnEvidence({
    trace: { output: 'done', runId: 'run-1', turnId: 'stream-1', tools: [] },
    ledger: [],
    expectedTurnCount: 2,
  });
  expect(multi.matched).toBe(false);
  expect(multi.mode).toBe('turn_capture_missing');

  const single = verifyTraceTurnEvidence({
    trace: {
      output: 'done',
      runId: 'run-1',
      turnId: 'stream-1',
      messageTurnId: 'message-1',
      tools: [],
      trace: [],
    },
    ledger: [],
    expectedTurnCount: 1,
  });
  expect(single).toMatchObject({
    matched: true,
    mode: 'legacy_single_turn_interval',
  });

  const legacyArray = verifyTraceTurnEvidence({
    trace: {
      output: 'done',
      runId: 'run-1',
      turnId: 'stream-1',
      messageTurnId: 'message-1',
      tools: [],
      turns: [
        {
          output: 'done',
          turnId: 'stream-1',
          messageTurnId: 'message-1',
          reason: 'completed',
          failure: null,
        },
      ],
    },
    ledger: [],
    expectedTurnCount: 1,
  });
  expect(legacyArray).toMatchObject({
    matched: true,
    mode: 'legacy_single_turn_interval',
  });

  const malformedNew = verifyTraceTurnEvidence({
    trace: {
      output: 'done',
      runId: 'run-1',
      turnId: 'stream-1',
      messageTurnId: 'message-1',
      tools: [],
      expectedTurnCount: 1,
      turns: [
        {
          output: 'done',
          turnId: 'stream-1',
          messageTurnId: 'message-1',
          reason: 'completed',
          failure: null,
        },
      ],
    },
    ledger: [],
    expectedTurnCount: 1,
  });
  expect(malformedNew.matched).toBe(false);
  expect(malformedNew.mode).toBe('turn_capture_invalid');
});

test('independent verification binds stored intervals to raw streamed tool events', () => {
  const turns = [
    turn(1, { fixtureSequenceStart: 1, fixtureSequenceEnd: 1 }),
    turn(2, {
      fixtureSequenceStart: 2,
      fixtureSequenceEnd: 1,
      streamTools: [],
      output: 'final',
    }),
  ];
  const ledger = [call(1)];
  const evidence = buildFixtureTurnEvidence({
    turns,
    ledger,
    expectedTurnCount: 2,
  });
  const trace = {
    output: 'final',
    runId: 'run-2',
    turnId: 'stream-2',
    messageTurnId: 'message-2',
    tools: turns.flatMap((item) => item.streamTools),
    turns,
    perTurnFixtureEvidence: evidence,
    trace: [
      {
        type: 'tool_use_start',
        runId: 'run-1',
        turnIndex: 1,
        turnId: 'stream-1',
        toolUseId: 'tool-1',
        toolName: 'mcp__commerce_fixture__get_order',
      },
      {
        type: 'tool_result',
        runId: 'run-1',
        turnIndex: 1,
        turnId: 'stream-1',
        toolUseId: 'tool-1',
        toolFailed: false,
        toolUnavailable: false,
      },
      {
        type: 'tool_result',
        runId: 'subagent-run',
        turnId: 'subagent-turn',
        toolUseId: 'non-fixture-task',
        toolFailed: false,
        toolUnavailable: false,
      },
    ],
  };
  expect(
    verifyTraceTurnEvidence({ trace, ledger, expectedTurnCount: 2 }).matched,
  ).toBe(true);
  const tampered = {
    ...trace,
    trace: trace.trace.map((event) => ({
      ...event,
      runId: 'run-2',
      turnIndex: 2,
      turnId: 'stream-2',
    })),
  };
  expect(
    verifyTraceTurnEvidence({ trace: tampered, ledger, expectedTurnCount: 2 })
      .matched,
  ).toBe(false);
});

test('rejects malformed new captures without falling back to legacy and bounds corrupted sequence ranges', () => {
  const base = {
    output: 'done',
    runId: 'run-1',
    turnId: 'stream-1',
    messageTurnId: 'message-1',
    tools: [],
    trace: [],
  };
  const malformed = verifyTraceTurnEvidence({
    trace: {
      ...base,
      turns: [
        {
          turnIndex: 1,
          runId: 'run-1',
          turnId: 'stream-1',
          messageTurnId: 'message-1',
          reason: 'completed',
          failure: null,
          fixtureSequenceStart: 1,
          fixtureSequenceEnd: 0,
          streamTools: [],
        },
      ],
    },
    ledger: [],
    expectedTurnCount: 1,
  });
  expect(malformed.matched).toBe(false);
  expect(malformed.mode).toBe('turn_capture_invalid');

  const oversized = verifyTraceTurnEvidence({
    trace: {
      ...base,
      turns: [
        turn(1, {
          fixtureSequenceStart: 1,
          fixtureSequenceEnd: Number.MAX_SAFE_INTEGER,
          streamTools: [],
        }),
      ],
    },
    ledger: [],
    expectedTurnCount: 1,
  });
  expect(oversized.matched).toBe(false);
  expect(oversized.evidence.reasons).toContain(
    'turn_1:fixture_sequence_range_invalid',
  );
});
