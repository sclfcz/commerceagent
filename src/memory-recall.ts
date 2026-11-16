/**
 * Three-way Workspace Memory recall.
 *
 * A single snapshot is split into three segments that share one character
 * budget:
 *
 * - `profile`   — pinned items (core shop profile / identity preferences).
 *                 Ordered by importance, never time-decayed, capped at a
 *                 share of the budget with a hard ceiling.
 * - `relevant`  — query hits plus the most important remaining memories,
 *                 ordered by `rank ?? importance` multiplied by exponential
 *                 time decay.
 * - `proactive` — open loops that are due (expiring within 72 hours) or whose
 *                 `valid_from` has arrived, injected even when unrelated.
 *
 * Unused budget is passed forward: profile → relevant → proactive. An item is
 * rendered by exactly one segment: pinned items go to `profile`, due open loops
 * to `proactive`, everything else competes in `relevant`. The module is pure;
 * rendering and character measurement are injected by the caller so the same
 * plan can be tested without a database or XML escaping.
 */

import type { WorkspaceMemoryItem } from './memory-store.js';

export const WORKSPACE_MEMORY_HALF_LIFE_DAYS = 30;
export const WORKSPACE_MEMORY_PROFILE_SHARE = 0.3;
export const WORKSPACE_MEMORY_PROFILE_HARD_CAP = 0.4;
export const WORKSPACE_MEMORY_PROACTIVE_SHARE = 0.15;
export const WORKSPACE_MEMORY_PROACTIVE_WINDOW_HOURS = 72;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

export type WorkspaceMemoryRecallSegment = 'profile' | 'relevant' | 'proactive';

export interface WorkspaceMemoryRecallOptions {
  /** Share of `maxChars` reserved for the pinned profile segment. */
  profileShare?: number;
  /** Hard ceiling for the pinned segment, as a share of `maxChars`. */
  profileHardCap?: number;
  /** Share of `maxChars` reserved for proactive open loops. */
  proactiveShare?: number;
  /** Exponential decay half-life for the relevant segment, in days. */
  halfLifeDays?: number;
  /** How far ahead an open loop still counts as "due soon". */
  proactiveWindowHours?: number;
}

export interface WorkspaceMemoryRecallEntry {
  item: WorkspaceMemoryItem;
  score: number;
}

export interface WorkspaceMemoryRecallSegmentPlan {
  segment: WorkspaceMemoryRecallSegment;
  budgetChars: number;
  usedChars: number;
  entries: WorkspaceMemoryRecallEntry[];
  /** Eligible entries that did not fit the segment budget. */
  truncated: number;
}

export interface WorkspaceMemoryRecallPlan {
  segments: WorkspaceMemoryRecallSegmentPlan[];
  itemCount: number;
  usedChars: number;
}

export interface WorkspaceMemoryRecallInput {
  /** Active, currently-valid candidates, most important first. */
  candidates: readonly WorkspaceMemoryItem[];
  /** Search hits with their database rank, most relevant first. */
  searchHits?: readonly { item: WorkspaceMemoryItem; rank: number }[];
  now?: string;
  maxChars: number;
  limit: number;
  /** Rendered length of one `<memory>` line, including its newline. */
  measureLine: (item: WorkspaceMemoryItem) => number;
  /** Rendered length of a segment's wrapper tags; zero when it stays empty. */
  measureSegmentOverhead?: (segment: WorkspaceMemoryRecallSegment) => number;
  options?: WorkspaceMemoryRecallOptions;
}

function clampUnit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `exp(-Δt / halfLife)` from the observation time (falling back to the last
 * edit). Pinned items are stable profile facts and are never decayed.
 */
export function workspaceMemoryDecay(
  item: WorkspaceMemoryItem,
  nowMs: number,
  halfLifeDays: number = WORKSPACE_MEMORY_HALF_LIFE_DAYS,
): number {
  if (item.pinned) return 1;
  const observed =
    timestamp(item.provenance.observedAt) ?? timestamp(item.updatedAt);
  if (observed === null) return 1;
  const ageMs = Math.max(0, nowMs - observed);
  if (halfLifeDays <= 0) return 1;
  return Math.exp(-ageMs / (halfLifeDays * MS_PER_DAY));
}

export function workspaceMemoryRelevanceScore(
  entry: { item: WorkspaceMemoryItem; rank?: number | null },
  nowMs: number,
  halfLifeDays: number = WORKSPACE_MEMORY_HALF_LIFE_DAYS,
): number {
  const rank =
    typeof entry.rank === 'number' &&
    Number.isFinite(entry.rank) &&
    entry.rank > 0
      ? entry.rank
      : null;
  const base = rank ?? entry.item.importance;
  return base * workspaceMemoryDecay(entry.item, nowMs, halfLifeDays);
}

/**
 * Open loops are injected proactively when they are due: expiring inside the
 * next 72 hours, or explicitly scheduled with a `valid_from` that has already
 * arrived. A plain open loop with no dates stays a normal relevant-segment
 * candidate.
 */
export function isProactiveOpenLoop(
  item: WorkspaceMemoryItem,
  nowMs: number,
  windowHours: number = WORKSPACE_MEMORY_PROACTIVE_WINDOW_HOURS,
): boolean {
  if (item.kind !== 'open_loop') return false;
  if (item.status !== 'active') return false;
  const expiresAt = timestamp(item.expiresAt);
  const expiringSoon =
    expiresAt !== null &&
    expiresAt > nowMs &&
    expiresAt <= nowMs + windowHours * MS_PER_HOUR;
  if (expiringSoon) return true;
  // A loop may also start on a schedule: once its `valid_from` has arrived it
  // is actionable now, even if its own expiry is far away.
  const validFrom = timestamp(item.validFrom);
  return validFrom !== null && validFrom <= nowMs;
}

function compareImportance(
  left: WorkspaceMemoryRecallEntry,
  right: WorkspaceMemoryRecallEntry,
): number {
  return (
    right.item.importance - left.item.importance ||
    right.score - left.score ||
    (left.item.updatedAt < right.item.updatedAt
      ? 1
      : left.item.updatedAt > right.item.updatedAt
        ? -1
        : left.item.id < right.item.id
          ? -1
          : left.item.id > right.item.id
            ? 1
            : 0)
  );
}

function compareRelevance(
  left: WorkspaceMemoryRecallEntry,
  right: WorkspaceMemoryRecallEntry,
): number {
  return (
    right.score - left.score ||
    right.item.importance - left.item.importance ||
    (left.item.updatedAt < right.item.updatedAt
      ? 1
      : left.item.updatedAt > right.item.updatedAt
        ? -1
        : left.item.id < right.item.id
          ? -1
          : left.item.id > right.item.id
            ? 1
            : 0)
  );
}

function compareProactive(
  left: WorkspaceMemoryRecallEntry,
  right: WorkspaceMemoryRecallEntry,
): number {
  const leftExpiry = timestamp(left.item.expiresAt);
  const rightExpiry = timestamp(right.item.expiresAt);
  if (
    leftExpiry !== null &&
    rightExpiry !== null &&
    leftExpiry !== rightExpiry
  ) {
    return leftExpiry - rightExpiry;
  }
  if (leftExpiry !== null && rightExpiry === null) return -1;
  if (leftExpiry === null && rightExpiry !== null) return 1;
  return compareImportance(left, right);
}

function fitSegment(
  segment: WorkspaceMemoryRecallSegment,
  entries: readonly WorkspaceMemoryRecallEntry[],
  budgetChars: number,
  limit: number,
  input: Pick<
    WorkspaceMemoryRecallInput,
    'measureLine' | 'measureSegmentOverhead'
  >,
): WorkspaceMemoryRecallSegmentPlan {
  const included: WorkspaceMemoryRecallEntry[] = [];
  let used = 0;
  for (const entry of entries) {
    if (included.length >= limit) break;
    const overhead =
      included.length === 0
        ? Math.max(0, input.measureSegmentOverhead?.(segment) ?? 0)
        : 0;
    const lineLength = Math.max(0, input.measureLine(entry.item));
    if (used + overhead + lineLength > budgetChars) break;
    included.push(entry);
    used += overhead + lineLength;
  }
  return {
    segment,
    budgetChars,
    usedChars: used,
    entries: included,
    truncated: entries.length - included.length,
  };
}

export function planWorkspaceMemoryRecall(
  input: WorkspaceMemoryRecallInput,
): WorkspaceMemoryRecallPlan {
  const nowMs = timestamp(input.now) ?? Date.now();
  const maxChars = Math.max(0, Math.trunc(input.maxChars));
  const limit = Math.max(1, Math.trunc(input.limit));
  const options = input.options ?? {};
  const profileShare = clampUnit(
    options.profileShare,
    WORKSPACE_MEMORY_PROFILE_SHARE,
  );
  const profileHardCap = clampUnit(
    options.profileHardCap,
    WORKSPACE_MEMORY_PROFILE_HARD_CAP,
  );
  const proactiveShare = clampUnit(
    options.proactiveShare,
    WORKSPACE_MEMORY_PROACTIVE_SHARE,
  );
  const halfLifeDays =
    options.halfLifeDays && options.halfLifeDays > 0
      ? options.halfLifeDays
      : WORKSPACE_MEMORY_HALF_LIFE_DAYS;
  const proactiveWindowHours =
    options.proactiveWindowHours && options.proactiveWindowHours > 0
      ? options.proactiveWindowHours
      : WORKSPACE_MEMORY_PROACTIVE_WINDOW_HOURS;

  const profileBudget = Math.min(
    Math.floor(maxChars * profileShare),
    Math.floor(maxChars * profileHardCap),
  );
  const proactiveReserve = Math.floor(maxChars * proactiveShare);

  const candidates = input.candidates.filter(
    (item) => item.status === 'active',
  );
  const byId = new Map(candidates.map((item) => [item.id, item]));

  const profileEntries = candidates
    .filter((item) => item.pinned)
    .map((item) => ({
      item,
      score: workspaceMemoryRelevanceScore(
        { item, rank: null },
        nowMs,
        halfLifeDays,
      ),
    }))
    .sort(compareImportance);
  const profile = fitSegment(
    'profile',
    profileEntries,
    profileBudget,
    limit,
    input,
  );

  const includedIds = new Set(profile.entries.map((entry) => entry.item.id));
  const relevantEntries = new Map<string, WorkspaceMemoryRecallEntry>();
  for (const hit of input.searchHits ?? []) {
    const item = byId.get(hit.item.id) ?? hit.item;
    if (item.status !== 'active') continue;
    relevantEntries.set(item.id, {
      item,
      score: workspaceMemoryRelevanceScore(
        { item, rank: hit.rank },
        nowMs,
        halfLifeDays,
      ),
    });
  }
  for (const item of candidates) {
    if (relevantEntries.has(item.id)) continue;
    relevantEntries.set(item.id, {
      item,
      score: workspaceMemoryRelevanceScore(
        { item, rank: null },
        nowMs,
        halfLifeDays,
      ),
    });
  }
  const relevantPool = [...relevantEntries.values()]
    .filter((entry) => !includedIds.has(entry.item.id))
    // A due open loop is always delivered under the `proactive` label so the
    // model can see why it was injected, and no item is rendered twice.
    .filter(
      (entry) => !isProactiveOpenLoop(entry.item, nowMs, proactiveWindowHours),
    )
    .sort(compareRelevance);
  const relevantBudget = Math.max(
    0,
    maxChars - profile.usedChars - proactiveReserve,
  );
  const relevant = fitSegment(
    'relevant',
    relevantPool,
    relevantBudget,
    limit,
    input,
  );
  for (const entry of relevant.entries) includedIds.add(entry.item.id);

  const proactiveEntries = candidates
    .filter((item) => !includedIds.has(item.id))
    .filter((item) => isProactiveOpenLoop(item, nowMs, proactiveWindowHours))
    .map((item) => ({
      item,
      score: workspaceMemoryRelevanceScore(
        { item, rank: null },
        nowMs,
        halfLifeDays,
      ),
    }))
    .sort(compareProactive);
  const proactiveBudget = Math.max(
    0,
    maxChars - profile.usedChars - relevant.usedChars,
  );
  const proactive = fitSegment(
    'proactive',
    proactiveEntries,
    proactiveBudget,
    limit,
    input,
  );

  const segments = [profile, relevant, proactive];
  return {
    segments,
    itemCount: segments.reduce(
      (total, segment) => total + segment.entries.length,
      0,
    ),
    usedChars: segments.reduce(
      (total, segment) => total + segment.usedChars,
      0,
    ),
  };
}
