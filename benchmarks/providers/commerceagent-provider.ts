import WebSocket from 'ws';
import type { StreamEvent } from '../../shared/stream-event.js';
import type { Failure } from '../lib/contracts.js';

export interface TurnObservation {
  output: string;
  runId: string | null;
  turnId: string | null;
  reason: string | null;
  failure: Failure | null;
  elapsedMs: number;
  logicalRunMs: number | null;
  apiRequests: Array<{ messageId: string; requestId: string }>;
  tools: Array<{ id: string; name: string }>;
  trace: Array<{ atMs: number; type: string; runId?: string; turnId?: string }>;
}

// This transport exercises the real Web entry point; no direct SDK fallback.
export function observeTurn(options: {
  baseUrl: string;
  cookie: string;
  workspaceJid: string;
  sessionId: string;
  prompt: string;
  timeoutMs: number;
  queueTimeoutMs?: number;
}): Promise<TurnObservation> {
  return new Promise((resolve) => {
    const started = Date.now();
    let runStarted: number | null = null;
    let runFinished: number | null = null;
    let collectionDeadline: ReturnType<typeof setTimeout> | null = null;
    let sent = false;
    let finished = false;
    let upstreamFailure = false;
    const observation: TurnObservation = {
      output: '',
      runId: null,
      turnId: null,
      reason: null,
      failure: null,
      elapsedMs: 0,
      logicalRunMs: null,
      apiRequests: [],
      tools: [],
      trace: [],
    };
    const virtualJid = `${options.workspaceJid}#agent:${options.sessionId}`;
    const url = new URL('/ws', options.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url, {
      headers: { Cookie: options.cookie },
      handshakeTimeout: Math.min(options.timeoutMs, 15000),
      maxPayload: 8 * 1024 * 1024,
    });
    const finish = (failure: Failure | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(queueDeadline);
      if (collectionDeadline) clearTimeout(collectionDeadline);
      observation.elapsedMs = Date.now() - started;
      observation.logicalRunMs =
        runStarted === null ? null : (runFinished ?? Date.now()) - runStarted;
      observation.failure = failure;
      ws.terminate();
      resolve(observation);
    };
    const deadline = setTimeout(
      () =>
        finish(
          observation.reason
            ? 'collection_incomplete'
            : runStarted === null
              ? 'queue_timeout'
              : 'run_timeout',
        ),
      options.timeoutMs,
    );
    const queueDeadline = setTimeout(
      () => {
        if (runStarted === null) finish('queue_timeout');
      },
      options.queueTimeoutMs ?? Math.min(options.timeoutMs, 60000),
    );
    ws.on('open', () => {
      sent = true;
      ws.send(
        JSON.stringify({
          type: 'send_message',
          chatJid: options.workspaceJid,
          agentId: options.sessionId,
          content: options.prompt,
        }),
      );
    });
    ws.on('message', (raw) => {
      if (!sent || finished) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (
          msg.type === 'ws_error' &&
          (!msg.chatJid ||
            msg.chatJid === options.workspaceJid ||
            msg.chatJid === virtualJid)
        ) {
          finish('upstream_error');
          return;
        }
        const runtimeTarget = msg.chatJid === virtualJid;
        const streamTarget =
          msg.chatJid === options.workspaceJid &&
          msg.agentId === options.sessionId;
        if (!runtimeTarget && !streamTarget) return;
        if (msg.type === 'ws_error' || msg.type === 'error') {
          finish('upstream_error');
          return;
        }
        if (msg.type === 'run_started' && runtimeTarget) {
          if (observation.runId && observation.runId !== msg.runId) {
            finish('collection_incomplete');
            return;
          }
          observation.runId = msg.runId;
          runStarted = Date.now();
        }
        if (msg.type === 'stream_event' && streamTarget) {
          const event = msg.event as StreamEvent;
          if (
            !observation.runId ||
            msg.runId !== observation.runId ||
            (event.queryRunId && event.queryRunId !== observation.runId)
          )
            return;
          if (event.turnId) {
            if (observation.turnId && event.turnId !== observation.turnId) {
              finish('collection_incomplete');
              return;
            }
            observation.turnId = event.turnId;
          }
          if (
            event.apiRequestId &&
            event.messageUuid &&
            !observation.apiRequests.some(
              (r) =>
                r.messageId === event.messageUuid &&
                r.requestId === event.apiRequestId,
            )
          ) {
            observation.apiRequests.push({
              messageId: event.messageUuid,
              requestId: event.apiRequestId,
            });
          }
          // Omit raw events, thinking, model identifiers and tool summaries.
          observation.trace.push({
            atMs: Date.now() - started,
            type: event.eventType,
            runId: msg.runId,
            turnId: event.turnId,
          });
          if (
            event.eventType === 'tool_use_start' &&
            event.toolUseId &&
            event.toolName &&
            !observation.tools.some((tool) => tool.id === event.toolUseId)
          )
            observation.tools.push({
              id: event.toolUseId,
              name: event.toolName,
            });
        }
        if (
          msg.type === 'new_message' &&
          observation.runId &&
          msg.message?.is_from_me &&
          msg.message.sender === 'commerceagent-agent'
        ) {
          if (msg.message.provider_failure === true) upstreamFailure = true;
          if (msg.message.finalization_reason !== 'completed') return;
          if (observation.turnId && msg.message.turn_id !== observation.turnId)
            return;
          observation.turnId = msg.message.turn_id ?? observation.turnId;
          observation.output = msg.message.content;
          if (observation.reason === 'completed')
            finish(upstreamFailure ? 'upstream_error' : null);
        }
        if (
          msg.type === 'run_finished' &&
          runtimeTarget &&
          observation.runId &&
          msg.runId === observation.runId
        ) {
          observation.reason = msg.reason;
          runFinished = Date.now();
          // queryIdle is handled before the host broadcasts its final DB reply.
          if (
            msg.reason === 'completed' &&
            (!observation.output || !observation.turnId)
          ) {
            collectionDeadline = setTimeout(
              () => finish('collection_incomplete'),
              Math.min(5000, options.timeoutMs),
            );
            return;
          }
          const reasons: Record<string, Failure> = {
            runner_exit: 'runner_exit',
            stopped: 'stopped',
            released: 'released',
          };
          finish(
            upstreamFailure
              ? 'upstream_error'
              : msg.reason === 'completed'
                ? observation.output && observation.turnId
                  ? null
                  : 'collection_incomplete'
                : (reasons[msg.reason] ?? 'collection_incomplete'),
          );
        }
      } catch {
        finish('collection_incomplete');
      }
    });
    ws.on('error', () => finish('stream_disconnected'));
    ws.on('close', () => finish('stream_disconnected'));
  });
}
