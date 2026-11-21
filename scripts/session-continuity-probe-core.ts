/**
 * SDK-free core of `probe-session-continuity.ts`, split out so the pair logic
 * (direct resume and strip-thinking resume) can be unit tested with a fake
 * turn runner. The CLI supplies the real SDK-backed `runTurn`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createThinkingStrippedSession,
  type ThinkingStripFailureReason,
} from '../container/agent-runner/src/thinking-strip.js';
import type { ResumeCheckResult } from '../src/session-continuity.js';

export interface TurnResult {
  sessionId?: string;
  text: string;
  ok: boolean;
  toolCalls: number;
  streamed: boolean;
}

export interface RunTurnOptions<P> {
  provider: P;
  configDir: string;
  cwd: string;
  prompt: string;
  resume?: string;
  code: string;
}

export type RunTurn<P> = (opts: RunTurnOptions<P>) => Promise<TurnResult>;

export type ProbeMode = 'direct' | 'strip_thinking';

export interface StripSummary {
  /** A stripped copy was written and the resume used its new session id. */
  created: boolean;
  /** Thinking / redacted_thinking blocks removed from the first turn. */
  thinkingBlocksStripped: number;
  reason?: ThinkingStripFailureReason | 'transcript_not_found';
}

export type PairOutcome =
  | { kind: 'first_turn_failed' }
  | { kind: 'strip_failed'; strip: StripSummary }
  | { kind: 'checked'; checks: ResumeCheckResult; strip?: StripSummary };

export const FIRST_PROMPT =
  '请调用 lookup_order 工具查询订单 A-1，然后只回复“已查询”，不要复述验证码。';

export const RESUME_PROMPT =
  '1. 回忆上一次查询订单 A-1 时工具返回的验证码。' +
  '2. 再调用 lookup_order 查询订单 B-2。' +
  '最后只输出一行：A-1=<验证码>;B-2=<验证码>';

/**
 * Locate the directory holding `<sessionId>.jsonl` under
 * `<configDir>/projects/`. The CLI encodes the (possibly realpath'd) cwd into
 * the directory name, so scanning is more reliable than re-deriving it.
 */
export function findTranscriptDir(
  configDir: string,
  sessionId: string,
): string | null {
  const projectsDir = path.join(configDir, 'projects');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    if (fs.existsSync(path.join(dir, `${sessionId}.jsonl`))) return dir;
  }
  return null;
}

/**
 * Produce the thinking-stripped copy of a session the same way the runner
 * does for `sessionResumeMode: 'strip_thinking'`.
 */
export function prepareStrippedResume(opts: {
  configDir: string;
  sessionId: string;
  newSessionId?: string;
}): StripSummary & { sessionId: string } {
  const transcriptDir = findTranscriptDir(opts.configDir, opts.sessionId);
  if (!transcriptDir) {
    return {
      sessionId: opts.sessionId,
      created: false,
      thinkingBlocksStripped: 0,
      reason: 'transcript_not_found',
    };
  }
  const result = createThinkingStrippedSession({
    transcriptDir,
    sessionId: opts.sessionId,
    newSessionId: opts.newSessionId,
  });
  return {
    sessionId: result.sessionId,
    created: result.created,
    thinkingBlocksStripped: result.strippedBlocks,
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export function evaluateResumeTurn(
  second: TurnResult,
  firstCode: string,
  secondCode: string,
): ResumeCheckResult {
  return {
    resumed: second.ok,
    recalledToolResult: second.ok && second.text.includes(firstCode),
    toolCallAfterResume:
      second.ok && second.toolCalls > 0 && second.text.includes(secondCode),
    streamed: second.streamed,
  };
}

/**
 * A strip-mode result only says something about stripping when the first
 * turn actually produced thinking blocks; otherwise it is a plain resume.
 */
export function stripResultInconclusive(strip: StripSummary): boolean {
  return !strip.created || strip.thinkingBlocksStripped === 0;
}

export async function probePair<P>(opts: {
  from: P;
  to: P;
  mode: ProbeMode;
  runTurn: RunTurn<P>;
  /** Testing seam for the per-pair scratch directory. */
  workDir?: string;
}): Promise<PairOutcome> {
  const workDir =
    opts.workDir ??
    fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ca-continuity-')));
  const configDir = path.join(workDir, '.claude');
  const cwd = path.join(workDir, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const firstCode = `C${crypto.randomInt(100000, 999999)}`;
  const secondCode = `D${crypto.randomInt(100000, 999999)}`;
  try {
    const first = await opts.runTurn({
      provider: opts.from,
      configDir,
      cwd,
      code: firstCode,
      prompt: FIRST_PROMPT,
    });
    // The first turn says nothing about resuming: an expired key, quota or
    // a model that never calls the tool must not be recorded as a resume
    // failure, or the model catalog would refuse a provider for the wrong
    // reason. Such pairs are reported as inconclusive and left unwritten.
    if (!first.ok || !first.sessionId || first.toolCalls === 0) {
      return { kind: 'first_turn_failed' };
    }

    let resume = first.sessionId;
    let strip: StripSummary | undefined;
    if (opts.mode === 'strip_thinking') {
      const prepared = prepareStrippedResume({
        configDir,
        sessionId: first.sessionId,
      });
      const { sessionId, ...summary } = prepared;
      strip = summary;
      if (!prepared.created) return { kind: 'strip_failed', strip };
      resume = sessionId;
    }

    const second = await opts.runTurn({
      provider: opts.to,
      configDir,
      cwd,
      code: secondCode,
      resume,
      prompt: RESUME_PROMPT,
    });
    return {
      kind: 'checked',
      checks: evaluateResumeTurn(second, firstCode, secondCode),
      ...(strip ? { strip } : {}),
    };
  } finally {
    if (!opts.workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}
