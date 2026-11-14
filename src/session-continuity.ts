/**
 * Session continuity policy.
 *
 * Three things are managed separately:
 * - the business conversation (messages, workspace files, task state) never
 *   changes because of configuration;
 * - the SDK session is a replaceable execution reference that we keep unless
 *   resuming it is known to be unsafe;
 * - the runner is a restartable process; configuration changes restart it.
 *
 * The AgentProfile identity hash/version only describe which configuration a
 * session last ran with. A mismatch means "the runner must pick up the new
 * configuration", never "drop the SDK session".
 *
 * Switching upstream providers is the one case where resuming can fail
 * (thinking-block signatures, gateway protocol differences). A pair of
 * providers is allowed to resume across each other only after
 * `scripts/probe-session-continuity.ts` verified it end to end; unverified
 * pairs keep the previous fresh-session + history behavior.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { SessionAgentIdentity } from './db.js';
import { logger } from './logger.js';
import { escapeXml } from './message-prompt.js';
import type { AgentProfile } from './types.js';

// ─── AgentProfile changes ───────────────────────────────────────────

export type AgentProfileSessionPlan =
  | { kind: 'unchanged' }
  | {
      kind: 'refresh';
      /** The workspace now points at a different AgentProfile. */
      profileSwitched: boolean;
    };

/**
 * Decide how a session reacts to the AgentProfile it is about to run with.
 * The SDK session is always kept; `refresh` only asks the caller to tell the
 * model that its configuration changed.
 */
export function planAgentProfileSessionContinuity(
  current: SessionAgentIdentity | undefined,
  profile: AgentProfile | undefined,
): AgentProfileSessionPlan {
  if (!profile || !current) return { kind: 'unchanged' };
  // Sessions created before identity tracking carry no identity at all.
  if (!current.agent_profile_id && !current.identity_hash) {
    return { kind: 'unchanged' };
  }
  const profileSwitched =
    !!current.agent_profile_id && current.agent_profile_id !== profile.id;
  const changed =
    profileSwitched ||
    current.identity_hash !== profile.identity_hash ||
    (current.agent_profile_version != null &&
      current.agent_profile_version !== profile.version);
  return changed ? { kind: 'refresh', profileSwitched } : { kind: 'unchanged' };
}

/** One-shot notice prepended to the first turn after a configuration refresh. */
export function buildAgentProfileRefreshNotice(
  profile: AgentProfile,
  plan: Extract<AgentProfileSessionPlan, { kind: 'refresh' }>,
): string {
  const what = plan.profileSwitched
    ? `当前工作区已切换为 Agent「${escapeXml(profile.name)}」`
    : `Agent「${escapeXml(profile.name)}」的配置已更新`;
  return (
    '<system_context>\n' +
    `${what}（版本 ${profile.version}）。本轮起请按当前系统提示词、工具和能力工作；` +
    '之前的对话、已完成的工作和用户要求仍然有效，请继续当前任务。\n' +
    '</system_context>\n\n'
  );
}

// ─── Provider resume compatibility ──────────────────────────────────

export interface ContinuityProviderRef {
  id: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
}

/**
 * Identity of a provider as far as resume compatibility is concerned. Editing
 * the endpoint or model changes the fingerprint, which automatically voids
 * earlier verification results for that provider.
 */
export function providerContinuityFingerprint(
  provider: ContinuityProviderRef,
): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        provider.id,
        provider.anthropicBaseUrl.trim().replace(/\/+$/, ''),
        provider.anthropicModel.trim(),
      ]),
    )
    .digest('hex')
    .slice(0, 24);
}

export interface ResumeCheckResult {
  /** The resumed turn completed without an API error. */
  resumed: boolean;
  /** The resumed model recalled a fact that only existed in a tool result. */
  recalledToolResult: boolean;
  /** The resumed model could still call a tool and use its result. */
  toolCallAfterResume: boolean;
  /** Streaming partial events were observed on the resumed turn. */
  streamed: boolean;
}

export interface ResumeMatrixEntry {
  fromFingerprint: string;
  toFingerprint: string;
  /** Display-only provider names, never secrets or endpoints. */
  fromName: string;
  toName: string;
  checks: ResumeCheckResult;
  resume: boolean;
  checkedAt: string;
}

interface ResumeMatrixFile {
  version: 1;
  /**
   * Keyed by `from>to`. `from === to` entries are baselines: they record that
   * an upstream could resume the session it produced itself, which is what
   * makes cross-provider results trustworthy in the first place.
   */
  pairs: Record<string, ResumeMatrixEntry>;
}

export const SESSION_CONTINUITY_MATRIX_FILE = path.join(
  DATA_DIR,
  'config',
  'session-continuity-matrix.json',
);

let matrixCache: { mtimeMs: number; data: ResumeMatrixFile } | null = null;

function pairKey(fromFingerprint: string, toFingerprint: string): string {
  return `${fromFingerprint}>${toFingerprint}`;
}

function emptyMatrix(): ResumeMatrixFile {
  return { version: 1, pairs: {} };
}

export function readResumeMatrix(
  file = SESSION_CONTINUITY_MATRIX_FILE,
): ResumeMatrixFile {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return emptyMatrix();
  }
  if (matrixCache && matrixCache.mtimeMs === stat.mtimeMs) {
    return matrixCache.data;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const data =
      parsed &&
      typeof parsed === 'object' &&
      (parsed as ResumeMatrixFile).version === 1 &&
      typeof (parsed as ResumeMatrixFile).pairs === 'object'
        ? (parsed as ResumeMatrixFile)
        : emptyMatrix();
    matrixCache = { mtimeMs: stat.mtimeMs, data };
    return data;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'Session continuity matrix unreadable; treating every provider pair as unverified',
    );
    return emptyMatrix();
  }
}

export function writeResumeMatrixEntries(
  entries: ResumeMatrixEntry[],
  file = SESSION_CONTINUITY_MATRIX_FILE,
): void {
  const current = readResumeMatrix(file);
  const next: ResumeMatrixFile = {
    version: 1,
    pairs: { ...current.pairs },
  };
  for (const entry of entries) {
    next.pairs[pairKey(entry.fromFingerprint, entry.toFingerprint)] = entry;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  matrixCache = null;
}

/** A resume entry passes only when every behavior check passed. */
export function resumeChecksPass(checks: ResumeCheckResult): boolean {
  return (
    checks.resumed &&
    checks.recalledToolResult &&
    checks.toolCallAfterResume &&
    checks.streamed
  );
}

// ─── Provider continuity catalog ────────────────────────────────

export type SessionContinuityStatus = 'unverified' | 'verified' | 'failed';

export interface ProviderContinuitySummary {
  /**
   * `verified`: the provider resumed its own session and passed every check.
   * `failed`: the baseline probe ran and did not pass, so sessions on this
   * upstream cannot be trusted to continue.
   * `unverified`: no baseline probe result matches the current upstream
   * fingerprint (never probed, or the endpoint/model changed since).
   */
  status: SessionContinuityStatus;
  /** ISO time of the baseline probe that produced `status`, if any. */
  checkedAt: string | null;
  /** Providers that can take a session from this one *and* hand it back. */
  bidirectionalProviderIds: string[];
}

function baselineStatus(
  matrix: ResumeMatrixFile,
  fingerprint: string,
): { status: SessionContinuityStatus; checkedAt: string | null } {
  const entry = matrix.pairs[pairKey(fingerprint, fingerprint)];
  if (!entry) return { status: 'unverified', checkedAt: null };
  return {
    status: entry.resume ? 'verified' : 'failed',
    checkedAt: entry.checkedAt,
  };
}

/**
 * Continuity standing of one upstream: whether its own baseline passed and
 * which other upstreams it can swap sessions with in both directions.
 *
 * Only fingerprints and provider ids leave this function; endpoints, models
 * and credentials never do, so the result is safe for public API payloads.
 */
export function summarizeProviderContinuity(
  provider: ContinuityProviderRef,
  candidates: ContinuityProviderRef[] = [],
  file = SESSION_CONTINUITY_MATRIX_FILE,
): ProviderContinuitySummary {
  const matrix = readResumeMatrix(file);
  const fingerprint = providerContinuityFingerprint(provider);
  const { status, checkedAt } = baselineStatus(matrix, fingerprint);
  const bidirectionalProviderIds: string[] = [];
  for (const candidate of candidates) {
    if (candidate.id === provider.id) continue;
    const candidateFingerprint = providerContinuityFingerprint(candidate);
    const outbound = matrix.pairs[pairKey(fingerprint, candidateFingerprint)];
    const inbound = matrix.pairs[pairKey(candidateFingerprint, fingerprint)];
    if (outbound?.resume === true && inbound?.resume === true) {
      bidirectionalProviderIds.push(candidate.id);
    }
  }
  return { status, checkedAt, bidirectionalProviderIds };
}

/**
 * Whether a session produced on `from` may be resumed on `to` without
 * dropping the SDK session. The same provider always may.
 */
export function canResumeAcrossProviders(
  from: ContinuityProviderRef | undefined,
  to: ContinuityProviderRef | undefined,
  file = SESSION_CONTINUITY_MATRIX_FILE,
): boolean {
  if (!from || !to) return false;
  if (from.id === to.id) return true;
  const entry =
    readResumeMatrix(file).pairs[
      pairKey(
        providerContinuityFingerprint(from),
        providerContinuityFingerprint(to),
      )
    ];
  return entry?.resume === true;
}
