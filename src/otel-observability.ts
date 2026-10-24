import { createHash, randomUUID } from 'node:crypto';

import { ROOT_CONTEXT, trace, type Span } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import type { StreamEvent } from './types.js';
import { serializeRedactedContent } from './otel-redaction.js';
import {
  getObservabilitySecret,
  getSystemSettings,
  isSafeOtelEndpoint,
} from './runtime-config.js';
import { logger } from './logger.js';

const SERVICE_NAME = 'commerceagent';
const OTEL_TIMEOUT_MS = 2_000;
const FLUSH_TIMEOUT_MS = 2_500;
const STALE_RUN_TIMEOUT_BUFFER_MS = 60_000;
const activeRuns = new Map<string, ObservabilityRun>();
const activeRunsByChatJid = new Map<string, ObservabilityRun>();
const activeRunsByTurnId = new Map<string, ObservabilityRun>();
const activeRunTimeouts = new Map<ObservabilityRun, NodeJS.Timeout>();
let exportFailureCount = 0;
let loggedExportFailure = false;

export interface ObservabilityRunIdentity {
  runId?: string;
  chatJid?: string;
  turnId?: string;
  workspace: string;
  profileVersion?: number;
  userId?: string;
}

export interface ObservabilityExportConfig {
  enabled: boolean;
  endpoint: string;
  publicKey: string;
  secretKey: string;
  sampleRate: number;
  includeContent: boolean;
}

function hashIdentity(value: string | undefined): string {
  if (!value) return 'unknown';
  return createHash('sha256').update(value).digest('hex');
}

function reportExportFailure(): void {
  exportFailureCount += 1;
  if (loggedExportFailure) return;
  loggedExportFailure = true;
  logger.warn(
    { category: 'otel_export_failed' },
    'OpenTelemetry trace export failed; export failures will be counted without logging payloads',
  );
}

export function getObservabilityExportFailureCount(): number {
  return exportFailureCount;
}

function readExportConfig(): ObservabilityExportConfig {
  const settings = getSystemSettings();
  return {
    enabled: settings.observabilityEnabled,
    endpoint: settings.observabilityEndpoint,
    publicKey: settings.observabilityPublicKey,
    secretKey: getObservabilitySecret(),
    sampleRate: settings.observabilitySampleRate,
    includeContent: settings.observabilityIncludeContent,
  };
}

function makeExporter(config: ObservabilityExportConfig): {
  provider: BasicTracerProvider;
  tracer: ReturnType<BasicTracerProvider['getTracer']>;
} | null {
  if (!config.enabled || Math.random() >= config.sampleRate) {
    return null;
  }
  const endpoint = config.endpoint.trim().replace(/\/+$/, '');
  const publicKey = config.publicKey.trim();
  const secret = config.secretKey;
  if (!endpoint || !isSafeOtelEndpoint(endpoint) || !publicKey || !secret) {
    return null;
  }

  const auth = Buffer.from(`${publicKey}:${secret}`).toString('base64');
  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${auth}`,
      'x-langfuse-ingestion-version': '4',
    },
    timeoutMillis: OTEL_TIMEOUT_MS,
  });
  const originalExport = exporter.export.bind(exporter);
  exporter.export = (spans, callback) => {
    originalExport(spans, (result) => {
      if (result.code !== 0) reportExportFailure();
      callback(result);
    });
  };
  const provider = new BasicTracerProvider({
    forceFlushTimeoutMillis: FLUSH_TIMEOUT_MS,
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 1_000,
        exportTimeoutMillis: OTEL_TIMEOUT_MS,
      }),
    ],
  });
  return { provider, tracer: provider.getTracer(SERVICE_NAME, '1') };
}

export class ObservabilityRun {
  private readonly provider: BasicTracerProvider;
  private readonly tracer: ReturnType<BasicTracerProvider['getTracer']>;
  private readonly root: Span;
  private readonly startedAt = Date.now();
  private readonly toolSpans = new Map<string, Span>();
  private readonly modelSpans = new Map<string, Span>();
  private readonly includeContent: boolean;
  private readonly assistantOutput: string[] = [];
  private assistantOutputLength = 0;
  private runId: string;
  private finished = false;
  readonly chatJid?: string;
  readonly turnId?: string;

  constructor(
    identity: ObservabilityRunIdentity,
    config: ObservabilityExportConfig,
    initialInput?: string,
  ) {
    const initialized = makeExporter(config);
    if (!initialized) throw new Error('observability exporter not configured');
    this.provider = initialized.provider;
    this.tracer = initialized.tracer;
    this.includeContent = config.includeContent;
    this.chatJid = identity.chatJid;
    this.turnId = identity.turnId;
    this.runId =
      identity.runId ??
      (identity.turnId ? `turn-${identity.turnId}` : randomUUID());
    const userHash = hashIdentity(identity.userId);
    const workspaceHash = hashIdentity(identity.workspace);
    this.root = initialized.tracer.startSpan('commerceagent.turn', {
      attributes: {
        'langfuse.trace.name': 'commerceagent.turn',
        'langfuse.user.id': userHash,
        'langfuse.session.id': workspaceHash,
        'langfuse.trace.metadata.run_id': this.runId,
        'langfuse.trace.metadata.turn_id': identity.turnId ?? 'unknown',
        'langfuse.trace.metadata.workspace_id_hash': workspaceHash,
        'langfuse.trace.metadata.agent_profile_version':
          identity.profileVersion ?? -1,
        'langfuse.trace.metadata.user_id_hash': userHash,
        'service.name': SERVICE_NAME,
      },
    });
    if (this.includeContent && initialInput) {
      this.root.setAttribute(
        'langfuse.observation.input',
        serializeRedactedContent(initialInput),
      );
    }
  }

  private parentContext() {
    return trace.setSpanContext(ROOT_CONTEXT, this.root.spanContext());
  }

  bindRunId(runId: string): void {
    if (!runId || runId === this.runId) return;
    this.runId = runId;
    this.root.setAttribute('langfuse.trace.metadata.run_id', runId);
  }

  record(event: StreamEvent): void {
    if (this.finished) return;
    const parent = this.parentContext();
    if (event.eventType === 'tool_use_start' && event.toolUseId) {
      const span = this.tracer.startSpan(
        'commerceagent.tool',
        {
          attributes: {
            'langfuse.observation.type': 'tool',
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': event.toolName ?? 'unknown',
            'commerceagent.agent_scope': event.agentScope ?? 'unknown',
            ...(this.includeContent
              ? {
                  'langfuse.observation.input': serializeRedactedContent(
                    event.toolInput ?? event.toolInputSummary ?? '',
                  ),
                }
              : {}),
          },
        },
        parent,
      );
      this.toolSpans.set(event.toolUseId, span);
      return;
    }
    if (event.eventType === 'tool_use_end' && event.toolUseId) {
      this.toolSpans
        .get(event.toolUseId)
        ?.setAttribute('commerceagent.tool.call_completed', true);
      return;
    }
    if (event.eventType === 'tool_result' && event.toolUseId) {
      const span = this.toolSpans.get(event.toolUseId);
      // Only inspect the local error marker; never attach the result text.
      if (span && event.toolResult?.startsWith('⚠️ ')) {
        span.setAttribute('error.type', 'tool_error');
        span.setStatus({ code: 2 });
      }
      if (span && this.includeContent && event.toolResult) {
        span.setAttribute(
          'langfuse.observation.output',
          serializeRedactedContent(event.toolResult),
        );
      }
      span?.end();
      this.toolSpans.delete(event.toolUseId);
      return;
    }
    if (event.eventType === 'raw_sdk_event') {
      if (event.apiRequestId) {
        this.root.setAttribute(
          'commerceagent.last_api_request_id',
          event.apiRequestId,
        );
      }
      const messageId = event.messageUuid;
      if (event.rawType === 'stream_event/message_start' && messageId) {
        const span = this.tracer.startSpan(
          'gen_ai.request',
          {
            attributes: {
              'langfuse.observation.type': 'generation',
              'gen_ai.operation.name': 'chat',
              ...(event.apiRequestId
                ? { 'gen_ai.request.id': event.apiRequestId }
                : {}),
            },
          },
          parent,
        );
        this.modelSpans.set(messageId, span);
      } else if (event.rawType === 'stream_event/message_stop' && messageId) {
        this.modelSpans.get(messageId)?.end();
        this.modelSpans.delete(messageId);
      }
      return;
    }
    if (event.eventType === 'usage' && event.usage) {
      const usage = event.usage;
      if (usage.eventId) {
        this.root.setAttribute('commerceagent.usage.event_id', usage.eventId);
      }
      this.root.setAttributes({
        'gen_ai.usage.input_tokens': usage.inputTokens,
        'gen_ai.usage.output_tokens': usage.outputTokens,
        'gen_ai.usage.cache_read_input_tokens': usage.cacheReadInputTokens,
        'gen_ai.usage.cache_creation_input_tokens':
          usage.cacheCreationInputTokens,
        'gen_ai.usage.reasoning_tokens': usage.reasoningTokens,
        'commerceagent.usage.cost_usd': usage.costUSD,
        'commerceagent.usage.duration_ms': usage.durationMs,
        'commerceagent.usage.num_turns': usage.numTurns,
      });
      const models = Object.entries(usage.modelUsage ?? {});
      this.root.setAttribute('gen_ai.request.count', models.length);
      for (const [model, modelUsage] of models) {
        const span = this.tracer.startSpan(
          'gen_ai.model_usage',
          {
            attributes: {
              'langfuse.observation.type': 'generation',
              'gen_ai.request.model': model,
              'gen_ai.usage.input_tokens': modelUsage.inputTokens,
              'gen_ai.usage.output_tokens': modelUsage.outputTokens,
              'gen_ai.usage.cache_read_input_tokens':
                modelUsage.cacheReadInputTokens,
              'gen_ai.usage.cache_creation_input_tokens':
                modelUsage.cacheCreationInputTokens,
              'gen_ai.usage.reasoning_tokens': modelUsage.reasoningTokens,
              'commerceagent.usage.cost_usd': modelUsage.costUSD,
            },
          },
          parent,
        );
        span.end();
      }
      return;
    }
    if (
      this.includeContent &&
      event.eventType === 'text_delta' &&
      event.text &&
      this.assistantOutputLength < 16_000
    ) {
      const remaining = 16_000 - this.assistantOutputLength;
      const next = event.text.slice(0, remaining);
      this.assistantOutput.push(next);
      this.assistantOutputLength += next.length;
      return;
    }
    if (event.eventType === 'status' && event.statusText) {
      const normalized = event.statusText.toLowerCase();
      if (normalized.includes('error') || normalized.includes('failed')) {
        this.root.setAttribute('error.type', 'runtime_error');
      }
    }
  }

  recordFailure(
    category: 'provider_failure' | 'runner_error' | 'runtime_error',
  ): void {
    this.root.setAttribute('error.type', category);
    this.root.setStatus({ code: 2 });
  }

  finish(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    const duration = Math.max(0, Date.now() - this.startedAt);
    for (const span of this.toolSpans.values()) span.end();
    for (const span of this.modelSpans.values()) span.end();
    this.toolSpans.clear();
    this.modelSpans.clear();
    this.root.setAttributes({
      'commerceagent.run_finished.reason': reason,
      'commerceagent.run.duration_ms': duration,
    });
    if (this.includeContent && this.assistantOutput.length > 0) {
      this.root.setAttribute(
        'langfuse.observation.output',
        serializeRedactedContent(this.assistantOutput.join('')),
      );
    }
    if (reason === 'runner_exit' || reason === 'stopped') {
      this.root.setAttribute('error.type', reason);
      this.root.setStatus({ code: 2 });
    }
    this.root.end();
    // Export is intentionally detached from queue/session completion.
    const flush = this.provider
      .forceFlush()
      .catch(() => reportExportFailure())
      .finally(() => {
        void this.provider.shutdown().catch(() => reportExportFailure());
      });
    let flushTimeout: NodeJS.Timeout | undefined;
    const boundedWait = new Promise<void>((resolve) => {
      flushTimeout = setTimeout(resolve, FLUSH_TIMEOUT_MS);
    });
    void Promise.race([flush, boundedWait]).finally(() => {
      if (flushTimeout) clearTimeout(flushTimeout);
    });
  }
}

function removeActiveRun(run: ObservabilityRun): void {
  const timeout = activeRunTimeouts.get(run);
  if (timeout) clearTimeout(timeout);
  activeRunTimeouts.delete(run);
  for (const [alias, candidate] of activeRuns) {
    if (candidate === run) activeRuns.delete(alias);
  }
  for (const [jid, candidate] of activeRunsByChatJid) {
    if (candidate === run) activeRunsByChatJid.delete(jid);
  }
  for (const [turnId, candidate] of activeRunsByTurnId) {
    if (candidate === run) activeRunsByTurnId.delete(turnId);
  }
}

function finishAndRemoveActiveRun(run: ObservabilityRun, reason: string): void {
  removeActiveRun(run);
  run.finish(reason);
}

function configuredStaleRunTimeoutMs(): number {
  try {
    const timeout = getSystemSettings().containerTimeout;
    return Math.max(1_000, timeout) + STALE_RUN_TIMEOUT_BUFFER_MS;
  } catch {
    return 1_800_000 + STALE_RUN_TIMEOUT_BUFFER_MS;
  }
}

export function getActiveObservabilityRunCount(): number {
  return new Set(activeRuns.values()).size;
}

export function startObservabilityRunWithConfig(
  identity: ObservabilityRunIdentity,
  config: ObservabilityExportConfig,
  initialInput?: string,
  staleTimeoutMs = configuredStaleRunTimeoutMs(),
): void {
  const runId =
    identity.runId ?? (identity.turnId ? `turn-${identity.turnId}` : undefined);
  if (!runId) return;

  const activeChatRun = identity.chatJid
    ? activeRunsByChatJid.get(identity.chatJid)
    : undefined;
  if (activeChatRun) {
    // Duplicate start notifications for the same turn are harmless. A new
    // turn on the same chat means the old run missed its terminal callback;
    // close it rather than silently suppressing this turn's trace.
    if (identity.turnId && activeChatRun.turnId === identity.turnId) return;
    finishAndRemoveActiveRun(activeChatRun, 'runner_exit');
  }

  const activeRun = activeRuns.get(runId);
  if (activeRun) {
    if (
      activeRun.chatJid === identity.chatJid &&
      activeRun.turnId === identity.turnId
    ) {
      return;
    }
    finishAndRemoveActiveRun(activeRun, 'runner_exit');
  }

  try {
    const run = new ObservabilityRun(
      { ...identity, runId },
      config,
      initialInput,
    );
    activeRuns.set(runId, run);
    if (identity.chatJid) activeRunsByChatJid.set(identity.chatJid, run);
    if (identity.turnId) activeRunsByTurnId.set(identity.turnId, run);
    const timeout = setTimeout(
      () => finishAndRemoveActiveRun(run, 'runner_exit'),
      staleTimeoutMs,
    );
    timeout.unref?.();
    activeRunTimeouts.set(run, timeout);
  } catch {
    // Misconfiguration must not affect the agent turn; no secret or endpoint
    // detail is logged here.
  }
}

export function startObservabilityRun(
  identity: ObservabilityRunIdentity,
  initialInput?: string,
): void {
  try {
    startObservabilityRunWithConfig(identity, readExportConfig(), initialInput);
  } catch {
    // Observability configuration reads must never interrupt the agent turn.
  }
}

export async function withObservabilityCleanup<T>(
  chatJid: string,
  getRunId: () => string | undefined,
  operation: () => Promise<T>,
  getFinishReason: (result: T) => string,
): Promise<T> {
  let reason = 'runner_exit';
  try {
    const result = await operation();
    reason = getFinishReason(result);
    return result;
  } finally {
    let runId = '';
    try {
      runId = getRunId() ?? '';
    } catch {
      // The chat mapping remains the cleanup fallback if queue state is gone.
    }
    finishObservabilityRun(chatJid, runId, reason);
  }
}

export function createObservabilityRun(
  identity: ObservabilityRunIdentity,
  config: ObservabilityExportConfig,
  initialInput?: string,
): ObservabilityRun | null {
  try {
    return new ObservabilityRun(identity, config, initialInput);
  } catch {
    return null;
  }
}

export function recordObservabilityEvent(
  runId: string | undefined,
  event: StreamEvent | undefined,
): void {
  if (!event) return;
  const run =
    (runId ? activeRuns.get(runId) : undefined) ??
    (event.queryRunId ? activeRuns.get(event.queryRunId) : undefined) ??
    (event.turnId ? activeRunsByTurnId.get(event.turnId) : undefined);
  if (!run) return;
  if (event.queryRunId) {
    run.bindRunId(event.queryRunId);
    activeRuns.set(event.queryRunId, run);
  }
  run.record(event);
}

export function recordObservabilityFailure(
  chatJid: string,
  runId: string | undefined,
  category: 'provider_failure' | 'runner_error' | 'runtime_error',
): void {
  const run =
    (runId ? activeRuns.get(runId) : undefined) ??
    activeRunsByChatJid.get(chatJid);
  run?.recordFailure(category);
}

export function finishObservabilityRun(
  chatJid: string,
  runId: string,
  reason: string,
): void {
  const run = activeRuns.get(runId) ?? activeRunsByChatJid.get(chatJid);
  if (!run) return;
  run.bindRunId(runId);
  finishAndRemoveActiveRun(run, reason);
}
