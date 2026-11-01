import type { ToolCall } from './contracts.js';
import { isDeepStrictEqual } from 'node:util';

const FIXTURE_PREFIX = 'mcp__commerce_fixture__';

function isCapturedTurn(value: unknown): value is CapturedTurnEvidence {
  if (!value || typeof value !== 'object') return false;
  const turn = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(turn.turnIndex) &&
    (typeof turn.runId === 'string' || turn.runId === null) &&
    (typeof turn.turnId === 'string' || turn.turnId === null) &&
    (typeof turn.messageTurnId === 'string' || turn.messageTurnId === null) &&
    (typeof turn.reason === 'string' || turn.reason === null) &&
    (typeof turn.failure === 'string' || turn.failure === null) &&
    typeof turn.output === 'string' &&
    Number.isSafeInteger(turn.fixtureSequenceStart) &&
    Number.isSafeInteger(turn.fixtureSequenceEnd) &&
    Array.isArray(turn.streamTools) &&
    turn.streamTools.every(
      (tool) =>
        !!tool &&
        typeof tool === 'object' &&
        typeof tool.id === 'string' &&
        typeof tool.name === 'string' &&
        typeof tool.resultObserved === 'boolean' &&
        (typeof tool.failed === 'boolean' || tool.failed === null) &&
        typeof tool.unavailable === 'boolean',
    )
  );
}

export interface CapturedTurnEvidence {
  turnIndex: number;
  runId: string | null;
  turnId: string | null;
  messageTurnId: string | null;
  reason: string | null;
  failure: string | null;
  output: string;
  fixtureSequenceStart: number;
  fixtureSequenceEnd: number;
  streamTools: Array<{
    id: string;
    name: string;
    resultObserved: boolean;
    failed: boolean | null;
    unavailable: boolean;
  }>;
}

export interface FixtureCallTurnReference {
  sequence: number;
  name: string;
  success: boolean;
  isError: boolean;
}

export interface PerTurnEvidence {
  turnIndex: number;
  runId: string | null;
  turnId: string | null;
  messageTurnId: string | null;
  fixtureSequenceStart: number;
  fixtureSequenceEnd: number;
  fixtureCalls: FixtureCallTurnReference[];
  streamFixtureTools: Array<CapturedTurnEvidence['streamTools'][number]>;
  nonFixtureToolNames: string[];
  complete: boolean;
  reasons: string[];
}

export function buildFixtureTurnEvidence(input: {
  turns: CapturedTurnEvidence[];
  ledger: ToolCall[];
  expectedTurnCount: number;
}) {
  const reasons: string[] = [];
  if (input.turns.length !== input.expectedTurnCount)
    reasons.push('turn_count_mismatch');
  const ledgerBySequence = new Map<number, ToolCall>();
  input.ledger.forEach((call, index) => {
    if (call.sequence !== index + 1 || ledgerBySequence.has(call.sequence))
      reasons.push('fixture_sequence_invalid');
    ledgerBySequence.set(call.sequence, call);
  });

  const seenTurnIds = new Set<string>();
  const seenToolUseIds = new Set<string>();
  const assignedSequences = new Set<number>();
  let expectedSequence = 1;
  const turns = input.turns.map((turn, index): PerTurnEvidence => {
    const turnReasons: string[] = [];
    if (turn.turnIndex !== index + 1) turnReasons.push('turn_index_mismatch');
    if (turn.failure === null && !turn.runId)
      turnReasons.push('stream_run_id_missing');
    if (!turn.turnId) turnReasons.push('stream_turn_id_missing');
    else if (seenTurnIds.has(turn.turnId))
      turnReasons.push('stream_turn_id_duplicate');
    if (turn.turnId) seenTurnIds.add(turn.turnId);
    if (turn.failure === null && !turn.messageTurnId)
      turnReasons.push('persisted_message_turn_id_missing');
    const rangeInvalid =
      !Number.isSafeInteger(turn.fixtureSequenceStart) ||
      !Number.isSafeInteger(turn.fixtureSequenceEnd) ||
      turn.fixtureSequenceStart < 1 ||
      turn.fixtureSequenceEnd < turn.fixtureSequenceStart - 1 ||
      turn.fixtureSequenceStart > input.ledger.length + 1 ||
      turn.fixtureSequenceEnd > input.ledger.length;
    if (rangeInvalid) turnReasons.push('fixture_sequence_range_invalid');
    if (!rangeInvalid && turn.fixtureSequenceStart !== expectedSequence)
      turnReasons.push('fixture_sequence_range_gap');

    const fixtureCalls: FixtureCallTurnReference[] = [];
    if (!rangeInvalid) {
      for (
        let sequence = turn.fixtureSequenceStart;
        sequence <= turn.fixtureSequenceEnd;
        sequence++
      ) {
        const call = ledgerBySequence.get(sequence);
        if (!call || assignedSequences.has(sequence)) {
          turnReasons.push('fixture_sequence_unassigned_or_duplicated');
          continue;
        }
        assignedSequences.add(sequence);
        fixtureCalls.push({
          sequence,
          name: call.name,
          success: call.success,
          isError:
            call.isError === true ||
            (!!call.result &&
              typeof call.result === 'object' &&
              'error' in call.result),
        });
      }
      expectedSequence = Math.max(
        expectedSequence,
        turn.fixtureSequenceEnd + 1,
      );
    }

    const streamFixtureTools = turn.streamTools.filter((tool) =>
      tool.name.startsWith(FIXTURE_PREFIX),
    );
    for (const tool of streamFixtureTools) {
      const scopedId = `${index + 1}:${tool.id}`;
      if (!tool.id || seenToolUseIds.has(scopedId))
        turnReasons.push('stream_tool_use_id_missing_or_duplicate');
      if (tool.id) seenToolUseIds.add(scopedId);
      if (!tool.resultObserved) turnReasons.push('stream_tool_result_missing');
    }
    const normalizedNames = (names: string[]) => [...names].sort().join('\n');
    if (fixtureCalls.length !== streamFixtureTools.length)
      turnReasons.push('stream_fixture_call_count_mismatch');
    if (
      normalizedNames(fixtureCalls.map((call) => call.name)) !==
      normalizedNames(
        streamFixtureTools.map((tool) =>
          tool.name.slice(FIXTURE_PREFIX.length),
        ),
      )
    )
      turnReasons.push('stream_fixture_tool_name_mismatch');
    const statuses = (rows: Array<{ name: string; failed: boolean }>) =>
      rows
        .map((row) => `${row.name}|${row.failed ? 'error' : 'ok'}`)
        .sort()
        .join('\n');
    if (
      fixtureCalls.length === streamFixtureTools.length &&
      statuses(
        fixtureCalls.map((call) => ({ name: call.name, failed: call.isError })),
      ) !==
        statuses(
          streamFixtureTools.map((tool) => ({
            name: tool.name.slice(FIXTURE_PREFIX.length),
            failed: tool.failed === true || tool.unavailable,
          })),
        )
    )
      turnReasons.push('stream_fixture_result_status_mismatch');

    const complete = turnReasons.length === 0;
    turnReasons.forEach((reason) =>
      reasons.push(`turn_${index + 1}:${reason}`),
    );
    return {
      turnIndex: index + 1,
      runId: turn.runId,
      turnId: turn.turnId,
      messageTurnId: turn.messageTurnId,
      fixtureSequenceStart: turn.fixtureSequenceStart,
      fixtureSequenceEnd: turn.fixtureSequenceEnd,
      fixtureCalls,
      streamFixtureTools,
      nonFixtureToolNames: turn.streamTools
        .filter((tool) => !tool.name.startsWith(FIXTURE_PREFIX))
        .map((tool) => tool.name)
        .sort(),
      complete,
      reasons: turnReasons,
    };
  });
  if (assignedSequences.size !== input.ledger.length)
    reasons.push('fixture_calls_not_assigned_to_turn');
  return {
    schemaVersion: 1 as const,
    expectedTurnCount: input.expectedTurnCount,
    observedTurnCount: input.turns.length,
    fixtureCallCount: input.ledger.length,
    turns,
    complete: reasons.length === 0,
    reasons,
  };
}

export function verifyTraceTurnEvidence(input: {
  trace: Record<string, any>;
  ledger: ToolCall[];
  expectedTurnCount: number;
}) {
  const storedTurns = Array.isArray(input.trace.turns)
    ? input.trace.turns
    : null;
  const turnCaptureMalformed =
    storedTurns !== null && !storedTurns.every(isCapturedTurn);
  const hasTurnBoundaries =
    storedTurns !== null &&
    !turnCaptureMalformed &&
    storedTurns.length === input.expectedTurnCount &&
    storedTurns.every(
      (turn) =>
        Number.isSafeInteger(turn.fixtureSequenceStart) &&
        Number.isSafeInteger(turn.fixtureSequenceEnd) &&
        Array.isArray(turn.streamTools),
    );
  const legacySingleTurn =
    storedTurns === null &&
    !hasTurnBoundaries &&
    input.expectedTurnCount === 1 &&
    typeof input.trace.turnId === 'string' &&
    Array.isArray(input.trace.tools);
  const turns: CapturedTurnEvidence[] = hasTurnBoundaries
    ? (storedTurns as CapturedTurnEvidence[])
    : legacySingleTurn
      ? [
          {
            turnIndex: 1,
            runId: input.trace.runId ?? null,
            turnId: input.trace.turnId,
            messageTurnId: input.trace.messageTurnId ?? null,
            reason: input.trace.reason ?? null,
            failure: input.trace.failure ?? null,
            fixtureSequenceStart: 1,
            fixtureSequenceEnd: input.ledger.at(-1)?.sequence ?? 0,
            streamTools: input.trace.tools,
            output: input.trace.output ?? '',
          },
        ]
      : [];
  let evidence = buildFixtureTurnEvidence({
    turns,
    ledger: input.ledger,
    expectedTurnCount: input.expectedTurnCount,
  });
  const verificationReasons: string[] = [];
  if (hasTurnBoundaries && !Array.isArray(input.trace.trace))
    verificationReasons.push('stream_event_list_missing');
  if (!legacySingleTurn) {
    const events = Array.isArray(input.trace.trace) ? input.trace.trace : [];
    const expectedToolEvents = new Map<
      number,
      Array<Record<string, unknown>>
    >();
    for (const event of events as Array<Record<string, unknown>>) {
      if (!['tool_use_start', 'tool_result'].includes(String(event.type)))
        continue;
      const toolUseId =
        typeof event.toolUseId === 'string' ? event.toolUseId : null;
      const fixtureEvent =
        (typeof event.toolName === 'string' &&
          event.toolName.startsWith(FIXTURE_PREFIX)) ||
        (toolUseId !== null &&
          turns.some((turn) =>
            turn.streamTools.some(
              (tool) =>
                tool.id === toolUseId && tool.name.startsWith(FIXTURE_PREFIX),
            ),
          ));
      if (!fixtureEvent) continue;
      if (typeof event.toolUseId !== 'string') {
        if (
          event.type === 'tool_use_start' &&
          typeof event.toolName === 'string' &&
          event.toolName.startsWith(FIXTURE_PREFIX)
        )
          verificationReasons.push('fixture_stream_tool_use_id_missing');
        continue;
      }
      const index = typeof event.turnIndex === 'number' ? event.turnIndex : NaN;
      if (!Number.isSafeInteger(index) || index < 1 || index > turns.length) {
        if (
          typeof event.toolName === 'string' &&
          event.toolName.startsWith(FIXTURE_PREFIX)
        )
          verificationReasons.push('fixture_stream_event_turn_index_missing');
        continue;
      }
      const group = expectedToolEvents.get(index) ?? [];
      group.push(event);
      expectedToolEvents.set(index, group);
      if (event.turnId !== turns[index - 1]?.turnId)
        verificationReasons.push(`turn_${index}:stream_event_turn_id_mismatch`);
      if (event.runId !== turns[index - 1]?.runId)
        verificationReasons.push(`turn_${index}:stream_event_run_id_mismatch`);
    }
    turns.forEach((turn, index) => {
      const observed = new Map<
        string,
        {
          id: string;
          name: string;
          resultObserved: boolean;
          failed: boolean | null;
          unavailable: boolean;
        }
      >();
      const streamFixtureTools = turn.streamTools.filter((tool) =>
        tool.name.startsWith(FIXTURE_PREFIX),
      );
      for (const event of expectedToolEvents.get(index + 1) ?? []) {
        const id = String(event.toolUseId);
        if (
          event.type === 'tool_use_start' &&
          typeof event.toolName === 'string'
        ) {
          if (observed.has(id))
            verificationReasons.push(
              `turn_${index + 1}:stream_tool_use_id_duplicate`,
            );
          observed.set(id, {
            id,
            name: event.toolName,
            resultObserved: false,
            failed: null,
            unavailable: false,
          });
        }
        if (event.type === 'tool_result') {
          const tool = observed.get(id);
          if (tool) {
            if (tool.resultObserved)
              verificationReasons.push(
                `turn_${index + 1}:stream_tool_result_duplicate`,
              );
            tool.resultObserved = true;
            tool.failed = event.toolFailed === true;
            tool.unavailable = event.toolUnavailable === true;
          } else
            verificationReasons.push(
              `turn_${index + 1}:stream_tool_result_without_start`,
            );
        }
      }
      const normalize = (
        tools: Array<{
          id?: unknown;
          name?: unknown;
          resultObserved?: unknown;
          failed?: unknown;
          unavailable?: unknown;
        }>,
      ) =>
        tools
          .map((tool) => [
            tool.id,
            tool.name,
            tool.resultObserved,
            tool.failed,
            tool.unavailable,
          ])
          .sort((left, right) =>
            String(left[0]).localeCompare(String(right[0])),
          );
      if (
        !isDeepStrictEqual(
          normalize([...observed.values()]),
          normalize(streamFixtureTools),
        )
      )
        verificationReasons.push(
          `turn_${index + 1}:stream_event_tool_set_mismatch`,
        );
      if (index === turns.length - 1 && input.trace.output !== turn.output)
        verificationReasons.push('final_turn_output_mismatch');
      if (
        index === turns.length - 1 &&
        (input.trace.runId !== turn.runId ||
          input.trace.turnId !== turn.turnId ||
          input.trace.messageTurnId !== turn.messageTurnId)
      )
        verificationReasons.push('final_turn_identity_mismatch');
    });
  }
  if (verificationReasons.length)
    evidence = {
      ...evidence,
      complete: false,
      reasons: [...evidence.reasons, ...verificationReasons],
    };
  const matched =
    evidence.complete &&
    (legacySingleTurn ||
      isDeepStrictEqual(evidence, input.trace.perTurnFixtureEvidence));
  return {
    evidence,
    matched,
    mode: legacySingleTurn
      ? ('legacy_single_turn_interval' as const)
      : storedTurns === null
        ? ('turn_capture_missing' as const)
        : turnCaptureMalformed || !hasTurnBoundaries
          ? ('turn_capture_invalid' as const)
          : ('captured_intervals' as const),
  };
}
