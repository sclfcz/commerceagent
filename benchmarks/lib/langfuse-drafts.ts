import fs from 'node:fs';
import path from 'node:path';
import { privateJson } from './contracts.js';

const OBSERVATION_FIELDS = 'core,metadata';
const MAX_OBSERVATION_PAGES = 20;
const MAX_SCORE_PAGES = 100;
const MAX_ROWS = 20_000;
const TERMINAL_REASONS = new Set([
  'completed',
  'released',
  'runner_exit',
  'stopped',
]);
const ERROR_CATEGORIES = new Set([
  'provider_failure',
  'runner_error',
  'runtime_error',
  'tool_error',
  'runner_exit',
  'stopped',
]);
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,120}$/;

export interface LangfuseObservation {
  id?: unknown;
  traceId?: unknown;
  startTime?: unknown;
  name?: unknown;
  metadata?: unknown;
  input?: unknown;
  output?: unknown;
  statusMessage?: unknown;
  [key: string]: unknown;
}

export interface LangfuseScore {
  dataType?: unknown;
  value?: unknown;
  subject?: unknown;
  comment?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface LangfuseDraftOptions {
  endpoint: string;
  publicKey: string;
  secretKey: string;
  from: Date;
  to: Date;
  minScore: number;
  fetcher?: typeof fetch;
}

export interface LangfuseDraftBundle {
  schemaVersion: 1;
  generatedAt: string;
  selection: {
    failedTraceCount: number;
    lowScoreTraceCount: number;
    draftCount: number;
    skippedMissingRunIdentity: number;
    bodyFieldsRequested: false;
    holdoutRead: false;
    casesModified: false;
  };
  drafts: Array<Record<string, unknown>>;
}

interface SelectedDraft {
  runId: string | null;
  turnId: string | null;
  terminalReason: string | null;
  errorCategory: string | null;
  lowScoreCount: number;
  failed: boolean;
  toolNames: string[];
}

export function isSafeDraftEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase()))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function assertMetadataOnly(row: Record<string, unknown>): void {
  for (const field of [
    'input',
    'output',
    'statusMessage',
    'comment',
    'metadataText',
    'prompt',
    'messages',
    'model',
    'userId',
    'sessionId',
  ]) {
    if (Object.hasOwn(row, field) && containsContent(row[field]))
      throw new Error('langfuse_content_field_rejected');
  }
}

function containsContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(containsContent);
  if (typeof value === 'object')
    return Object.values(value).some(containsContent);
  return true;
}

function safeOpaqueId(value: unknown): string | null {
  return typeof value === 'string' && OPAQUE_ID.test(value) ? value : null;
}

function safeToolName(value: unknown): string | null {
  return typeof value === 'string' && TOOL_NAME.test(value) ? value : null;
}

function safeEnum(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function metadataOf(row: LangfuseObservation): Record<string, unknown> {
  assertMetadataOnly(row);
  return row.metadata && typeof row.metadata === 'object'
    ? (row.metadata as Record<string, unknown>)
    : {};
}

function observationTraceId(row: LangfuseObservation): string | null {
  assertMetadataOnly(row);
  return typeof row.traceId === 'string' && row.traceId.length <= 160
    ? row.traceId
    : null;
}

function observationId(row: LangfuseObservation): string | null {
  assertMetadataOnly(row);
  return typeof row.id === 'string' && row.id.length <= 160 ? row.id : null;
}

function scoreTraceId(
  score: LangfuseScore,
  traceByObservationId: Map<string, string>,
): string | null {
  assertMetadataOnly(score);
  const subject = score.subject;
  if (!subject || typeof subject !== 'object') return null;
  const value = subject as Record<string, unknown>;
  if (value.kind === 'trace' && typeof value.id === 'string') return value.id;
  if (value.kind === 'observation' && typeof value.id === 'string')
    return traceByObservationId.get(value.id) ?? null;
  // Session and experiment scores do not identify a single run and are not
  // expanded into individual drafts.
  return null;
}

export function buildLangfuseDraftBundle(input: {
  roots: LangfuseObservation[];
  tools: LangfuseObservation[];
  scores: LangfuseScore[];
  minScore?: number;
  generatedAt?: Date;
}): LangfuseDraftBundle {
  const minScore = input.minScore ?? 4;
  if (!Number.isFinite(minScore) || minScore <= 1 || minScore > 5)
    throw new Error('langfuse_min_score_invalid');

  const traceByObservationId = new Map<string, string>();
  for (const row of [...input.roots, ...input.tools]) {
    const id = observationId(row);
    const traceId = observationTraceId(row);
    if (id && traceId) traceByObservationId.set(id, traceId);
  }

  const lowScoreCounts = new Map<string, number>();
  for (const score of input.scores) {
    assertMetadataOnly(score);
    if (score.dataType !== 'NUMERIC' || typeof score.value !== 'number')
      continue;
    if (score.value >= minScore) continue;
    const traceId = scoreTraceId(score, traceByObservationId);
    if (traceId)
      lowScoreCounts.set(traceId, (lowScoreCounts.get(traceId) ?? 0) + 1);
  }

  const toolsByTrace = new Map<string, Set<string>>();
  for (const row of input.tools) {
    const traceId = observationTraceId(row);
    if (!traceId) continue;
    const name = safeToolName(metadataOf(row)['attributes.gen_ai.tool.name']);
    if (!name) continue;
    const names = toolsByTrace.get(traceId) ?? new Set<string>();
    names.add(name);
    toolsByTrace.set(traceId, names);
  }

  const selected: SelectedDraft[] = [];
  let skippedMissingRunIdentity = 0;
  for (const row of input.roots) {
    const traceId = observationTraceId(row);
    if (!traceId) continue;
    const metadata = metadataOf(row);
    const terminalReason = safeEnum(
      metadata['attributes.commerceagent.run_finished.reason'],
      TERMINAL_REASONS,
    );
    const errorCategory = safeEnum(
      metadata['attributes.error.type'],
      ERROR_CATEGORIES,
    );
    const lowScoreCount = lowScoreCounts.get(traceId) ?? 0;
    const failed =
      errorCategory !== null ||
      (terminalReason !== null && terminalReason !== 'completed');
    if (!failed && lowScoreCount === 0) continue;
    const runId = safeOpaqueId(metadata.run_id);
    const turnId = safeOpaqueId(metadata.turn_id);
    if (!runId && !turnId) {
      skippedMissingRunIdentity++;
      continue;
    }
    selected.push({
      runId,
      turnId,
      terminalReason,
      errorCategory,
      lowScoreCount,
      failed,
      toolNames: [...(toolsByTrace.get(traceId) ?? [])].sort(),
    });
  }

  selected.sort((a, b) =>
    `${a.turnId ?? ''}|${a.runId ?? ''}`.localeCompare(
      `${b.turnId ?? ''}|${b.runId ?? ''}`,
    ),
  );
  const drafts = selected.map((item, index) => ({
    schemaVersion: 1,
    draftId: `draft-${String(index + 1).padStart(4, '0')}`,
    source: {
      runId: item.runId,
      turnId: item.turnId,
      signal: item.failed
        ? item.lowScoreCount > 0
          ? 'failure_and_low_score'
          : 'failure'
        : 'low_score',
      terminalReason: item.terminalReason,
      errorCategory: item.errorCategory,
      toolNames: item.toolNames,
      lowScoreCount: item.lowScoreCount,
    },
    caseDraft: {
      id: '',
      category: '',
      riskLevel: '',
      split: '',
      prompt: '',
      fixture_variant: '',
      expected: {
        status: '',
        facts: {},
        evidence_required: [],
        evidence_allowed: [],
        forbidden_conclusions: [],
      },
      tools: { required: [], forbidden: [], max_calls: null },
      instructions: {},
      rubric: '',
    },
    promotionRequirements: {
      humanReviewRequired: true,
      referenceAnswerSelfTestRequired: true,
      mutationTestsRequired: true,
      automaticPromotion: false,
    },
  }));

  return {
    schemaVersion: 1,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    selection: {
      failedTraceCount: selected.filter((item) => item.failed).length,
      lowScoreTraceCount: selected.filter((item) => item.lowScoreCount > 0)
        .length,
      draftCount: drafts.length,
      skippedMissingRunIdentity,
      bodyFieldsRequested: false,
      holdoutRead: false,
      casesModified: false,
    },
    drafts,
  };
}

function iso(value: Date): string {
  if (!Number.isFinite(value.getTime()))
    throw new Error('langfuse_time_range_invalid');
  return value.toISOString();
}

function assertRange(from: Date, to: Date): void {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    throw new Error('langfuse_time_range_invalid');
  if (from.getTime() >= to.getTime())
    throw new Error('langfuse_time_range_invalid');
  if (to.getTime() - from.getTime() > 31 * 24 * 60 * 60 * 1_000)
    throw new Error('langfuse_time_range_too_wide');
}

async function fetchPages<T extends Record<string, unknown>>(input: {
  endpoint: string;
  auth: string;
  path: string;
  from: Date;
  to: Date;
  params: Record<string, string>;
  maxPages: number;
  maxRows: number;
  pageSize?: number;
  timeParameters?: { from: string; to: string };
  fetcher: typeof fetch;
}): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  const visitedCursors = new Set<string>();
  for (let page = 0; page < input.maxPages; page++) {
    const url = new URL(`${input.endpoint.replace(/\/+$/, '')}${input.path}`);
    const timeParameters = input.timeParameters ?? {
      from: 'fromStartTime',
      to: 'toStartTime',
    };
    url.searchParams.set(timeParameters.from, iso(input.from));
    url.searchParams.set(timeParameters.to, iso(input.to));
    url.searchParams.set('limit', String(input.pageSize ?? 1000));
    for (const [key, value] of Object.entries(input.params))
      url.searchParams.set(key, value);
    if (cursor) url.searchParams.set('cursor', cursor);

    let response: Response;
    try {
      response = await input.fetcher(url, {
        headers: {
          Authorization: `Basic ${input.auth}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('langfuse_request_failed');
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error('langfuse_auth_failed');
      if (response.status === 429) throw new Error('langfuse_rate_limited');
      throw new Error(`langfuse_http_${response.status}`);
    }
    let payload: { data?: unknown; meta?: { cursor?: unknown } };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new Error('langfuse_response_invalid');
    }
    if (!Array.isArray(payload.data))
      throw new Error('langfuse_response_invalid');
    for (const row of payload.data) {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('langfuse_response_invalid');
      assertMetadataOnly(row as Record<string, unknown>);
      rows.push(row as T);
      if (rows.length > input.maxRows)
        throw new Error('langfuse_result_limit_exceeded');
    }
    const next = payload.meta?.cursor;
    if (next === undefined || next === null || next === '') return rows;
    if (typeof next !== 'string' || next.length > 2048)
      throw new Error('langfuse_cursor_invalid');
    if (visitedCursors.has(next)) throw new Error('langfuse_cursor_repeated');
    visitedCursors.add(next);
    cursor = next;
  }
  throw new Error('langfuse_page_limit_exceeded');
}

export async function collectLangfuseDraftBundle(
  input: LangfuseDraftOptions,
): Promise<LangfuseDraftBundle> {
  assertRange(input.from, input.to);
  if (!isSafeDraftEndpoint(input.endpoint))
    throw new Error('langfuse_endpoint_invalid');
  if (!input.publicKey.trim() || !input.secretKey.trim())
    throw new Error('langfuse_credentials_missing');
  if (
    !Number.isFinite(input.minScore) ||
    input.minScore <= 1 ||
    input.minScore > 5
  )
    throw new Error('langfuse_min_score_invalid');
  const fetcher = input.fetcher ?? fetch;
  const auth = Buffer.from(`${input.publicKey}:${input.secretKey}`).toString(
    'base64',
  );
  const fetchObservations = (name: string) =>
    fetchPages<LangfuseObservation>({
      endpoint: input.endpoint,
      auth,
      path: '/api/public/v2/observations',
      from: input.from,
      to: input.to,
      params: { fields: OBSERVATION_FIELDS, name },
      maxPages: MAX_OBSERVATION_PAGES,
      maxRows: MAX_ROWS,
      fetcher,
    });
  const [roots, tools] = await Promise.all([
    fetchObservations('commerceagent.turn'),
    fetchObservations('commerceagent.tool'),
  ]);
  const lowScores = await fetchPages<LangfuseScore>({
    endpoint: input.endpoint,
    auth,
    path: '/api/public/v3/scores',
    from: input.from,
    to: input.to,
    params: {
      fields: 'subject',
      dataType: 'NUMERIC',
      valueMax: String(Math.max(0, input.minScore - 0.000001)),
    },
    maxPages: MAX_SCORE_PAGES,
    maxRows: MAX_ROWS,
    pageSize: 100,
    timeParameters: { from: 'fromTimestamp', to: 'toTimestamp' },
    fetcher,
  });
  return buildLangfuseDraftBundle({
    roots,
    tools,
    scores: lowScores,
    minScore: input.minScore,
  });
}

export function writeLangfuseDraftBundle(
  benchmarkDirectory: string,
  bundle: LangfuseDraftBundle,
  generatedAt = new Date(),
): string {
  const outputRoot = path.resolve(
    benchmarkDirectory,
    'results',
    'langfuse-drafts',
  );
  const timestamp = generatedAt
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/Z$/, 'Z');
  const outputDirectory = path.join(outputRoot, `run-${timestamp}`);
  if (!outputDirectory.startsWith(`${outputRoot}${path.sep}`))
    throw new Error('langfuse_output_path_invalid');
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputRoot, 0o700);
  if (fs.existsSync(outputDirectory))
    throw new Error('langfuse_output_already_exists');
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  privateJson(path.join(outputDirectory, 'drafts.json'), bundle);
  return outputDirectory;
}
