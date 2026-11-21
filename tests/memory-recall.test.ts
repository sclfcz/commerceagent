import { describe, expect, test } from 'vitest';

import {
  WORKSPACE_MEMORY_PROACTIVE_WINDOW_HOURS,
  isProactiveOpenLoop,
  planWorkspaceMemoryRecall,
  workspaceMemoryDecay,
  workspaceMemoryRelevanceScore,
} from '../src/memory-recall.js';
import type { WorkspaceMemoryItem } from '../src/memory-store.js';

const NOW = '2026-11-16T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function item(
  overrides: Partial<WorkspaceMemoryItem> = {},
): WorkspaceMemoryItem {
  return {
    id: overrides.id ?? 'wmi_1',
    workspaceJid: 'web:shop',
    kind: 'fact',
    title: null,
    content: 'x',
    canonicalKey: null,
    searchKeys: [],
    pinned: false,
    status: 'active',
    importance: 0.5,
    confidence: 1,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    provenance: {
      sourceType: 'web_user',
      sourceId: null,
      sessionId: null,
      observedAt: NOW,
    },
    ...overrides,
  };
}

function chars(contentLength: number): string {
  return '记'.repeat(contentLength);
}

/** Simulates a `<memory …>content</memory>` line plus its newline. */
const measureLine = (memory: WorkspaceMemoryItem): number =>
  memory.content.length + 60;

const measureSegmentOverhead = (): number => 20;

describe('workspace memory time decay', () => {
  test('halves the score after one half-life and ignores pinned items', () => {
    const nowMs = Date.parse(NOW);
    const fresh = item({ importance: 1 });
    const stale = item({
      importance: 1,
      provenance: {
        sourceType: 'web_user',
        sourceId: null,
        sessionId: null,
        observedAt: new Date(nowMs - 30 * DAY_MS).toISOString(),
      },
    });
    expect(workspaceMemoryDecay(fresh, nowMs, 30)).toBeCloseTo(1, 5);
    expect(workspaceMemoryDecay(stale, nowMs, 30)).toBeCloseTo(Math.exp(-1), 5);
    expect(workspaceMemoryRelevanceScore({ item: stale }, nowMs)).toBeLessThan(
      workspaceMemoryRelevanceScore({ item: fresh }, nowMs),
    );

    const pinned = item({
      importance: 0.8,
      pinned: true,
      provenance: {
        sourceType: 'web_user',
        sourceId: null,
        sessionId: null,
        observedAt: new Date(nowMs - 90 * DAY_MS).toISOString(),
      },
    });
    expect(workspaceMemoryDecay(pinned, nowMs, 30)).toBe(1);
    expect(workspaceMemoryRelevanceScore({ item: pinned }, nowMs)).toBeCloseTo(
      0.8,
      5,
    );
  });

  test('prefers the search rank over importance when both are available', () => {
    const nowMs = Date.parse(NOW);
    const low = item({ importance: 0.2 });
    expect(
      workspaceMemoryRelevanceScore({ item: low, rank: 0.9 }, nowMs),
    ).toBeCloseTo(0.9, 5);
    expect(
      workspaceMemoryRelevanceScore({ item: low, rank: 0 }, nowMs),
    ).toBeCloseTo(0.2, 5);
  });

  test('attributes time from observedAt when present', () => {
    const nowMs = Date.parse(NOW);
    const updatedRecently = item({
      updatedAt: NOW,
      provenance: {
        sourceType: 'web_user',
        sourceId: null,
        sessionId: null,
        observedAt: new Date(nowMs - 60 * DAY_MS).toISOString(),
      },
    });
    expect(workspaceMemoryDecay(updatedRecently, nowMs, 30)).toBeCloseTo(
      Math.exp(-2),
      5,
    );
  });
});

describe('proactive open loops', () => {
  test('includes loops expiring within 72 hours', () => {
    const nowMs = Date.parse(NOW);
    const soon = item({
      kind: 'open_loop',
      expiresAt: new Date(nowMs + 48 * HOUR_MS).toISOString(),
    });
    const later = item({
      kind: 'open_loop',
      expiresAt: new Date(
        nowMs + (WORKSPACE_MEMORY_PROACTIVE_WINDOW_HOURS + 1) * HOUR_MS,
      ).toISOString(),
    });
    const past = item({
      kind: 'open_loop',
      expiresAt: new Date(nowMs - HOUR_MS).toISOString(),
    });
    expect(isProactiveOpenLoop(soon, nowMs)).toBe(true);
    expect(isProactiveOpenLoop(later, nowMs)).toBe(false);
    expect(isProactiveOpenLoop(past, nowMs)).toBe(false);
  });

  test('includes loops whose valid_from has already arrived', () => {
    const nowMs = Date.parse(NOW);
    const started = item({
      kind: 'open_loop',
      validFrom: new Date(nowMs - 2 * DAY_MS).toISOString(),
    });
    const undated = item({ kind: 'open_loop' });
    expect(isProactiveOpenLoop(started, nowMs)).toBe(true);
    expect(isProactiveOpenLoop(undated, nowMs)).toBe(false);
    // The two triggers are independent: an arrival date counts even when the
    // loop's own expiry is far beyond the 72-hour window.
    expect(
      isProactiveOpenLoop(
        item({
          kind: 'open_loop',
          validFrom: new Date(nowMs - 2 * DAY_MS).toISOString(),
          expiresAt: new Date(nowMs + 30 * DAY_MS).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(true);
  });

  test('never promotes facts or non-active loops', () => {
    const nowMs = Date.parse(NOW);
    expect(
      isProactiveOpenLoop(
        item({
          kind: 'fact',
          expiresAt: new Date(nowMs + HOUR_MS).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(false);
    expect(
      isProactiveOpenLoop(
        item({
          kind: 'open_loop',
          status: 'superseded',
          validFrom: new Date(nowMs - HOUR_MS).toISOString(),
        }),
        nowMs,
      ),
    ).toBe(false);
  });
});

describe('three-way recall budget', () => {
  test('profile takes 30% and reports truncation', () => {
    const pinned = Array.from({ length: 5 }, (_, index) =>
      item({
        id: `wmi_pinned_${index}`,
        content: chars(140),
        pinned: true,
        importance: 0.9 - index * 0.01,
      }),
    );
    const plan = planWorkspaceMemoryRecall({
      candidates: pinned,
      now: NOW,
      maxChars: 1000,
      limit: 10,
      measureLine,
      measureSegmentOverhead,
    });
    const profile = plan.segments[0];
    expect(profile.segment).toBe('profile');
    expect(profile.budgetChars).toBe(300);
    // 140 content chars + 60 tag chars + 20 segment overhead = 220 for the
    // first item; the second would exceed the 300 character profile budget.
    expect(profile.entries).toHaveLength(1);
    expect(profile.truncated).toBe(4);
    expect(profile.entries[0].item.id).toBe('wmi_pinned_0');
  });

  test('profile honors the hard ceiling even when configured higher', () => {
    const plan = planWorkspaceMemoryRecall({
      candidates: [],
      now: NOW,
      maxChars: 1000,
      limit: 5,
      measureLine,
      options: { profileShare: 0.9, profileHardCap: 0.4 },
    });
    expect(plan.segments[0].budgetChars).toBe(400);
  });

  test('unused budget passes forward to the next segment', () => {
    const plan = planWorkspaceMemoryRecall({
      candidates: [
        item({ id: 'wmi_relevant_1', content: chars(40) }),
        item({ id: 'wmi_relevant_2', content: chars(40) }),
        item({
          id: 'wmi_loop',
          kind: 'open_loop',
          content: chars(40),
          validFrom: new Date(Date.parse(NOW) - DAY_MS).toISOString(),
        }),
      ],
      now: NOW,
      maxChars: 1000,
      limit: 5,
      measureLine,
      measureSegmentOverhead,
    });
    const [profile, relevant, proactive] = plan.segments;
    // No pinned items, so nothing is spent on the profile segment.
    expect(profile.entries).toHaveLength(0);
    expect(profile.usedChars).toBe(0);
    expect(relevant.budgetChars).toBe(850);
    expect(relevant.entries.map((entry) => entry.item.id)).toEqual([
      'wmi_relevant_1',
      'wmi_relevant_2',
    ]);
    // 1000 - profile used (0) - relevant used (20 wrapper + 2 × 100 lines).
    expect(proactive.budgetChars).toBe(780);
    expect(proactive.entries.map((entry) => entry.item.id)).toEqual([
      'wmi_loop',
    ]);
    expect(plan.itemCount).toBe(3);
  });

  test('relevant keeps only items that fit and never duplicates profile items', () => {
    const pinned = item({
      id: 'wmi_profile',
      content: chars(20),
      pinned: true,
      importance: 1,
    });
    const plain = item({
      id: 'wmi_plain',
      content: chars(20),
      importance: 0.4,
    });
    const plan = planWorkspaceMemoryRecall({
      candidates: [pinned, plain],
      searchHits: [
        { item: plain, rank: 0.5 },
        { item: pinned, rank: 0.9 },
        { item: plain, rank: 0.4 },
      ],
      now: NOW,
      maxChars: 1000,
      limit: 5,
      measureLine,
      measureSegmentOverhead,
    });
    expect(plan.segments[0].entries.map((entry) => entry.item.id)).toEqual([
      'wmi_profile',
    ]);
    expect(plan.segments[1].entries.map((entry) => entry.item.id)).toEqual([
      'wmi_plain',
    ]);
    // 1000 - profile used (100) - proactive reserve (150).
    expect(plan.segments[1].budgetChars).toBe(750);
  });

  test('rejects candidate items that are not active', () => {
    const plan = planWorkspaceMemoryRecall({
      candidates: [
        item({ id: 'wmi_deleted', status: 'deleted', content: chars(10) }),
        item({ id: 'wmi_ok', content: chars(10) }),
      ],
      now: NOW,
      maxChars: 1000,
      limit: 5,
      measureLine,
      measureSegmentOverhead,
    });
    expect(plan.segments[1].entries.map((entry) => entry.item.id)).toEqual([
      'wmi_ok',
    ]);
  });

  test('orders relevant items by decayed score, newest first', () => {
    const nowMs = Date.parse(NOW);
    const old = item({
      id: 'wmi_old',
      content: chars(10),
      importance: 0.5,
      provenance: {
        sourceType: 'web_user',
        sourceId: null,
        sessionId: null,
        observedAt: new Date(nowMs - 60 * DAY_MS).toISOString(),
      },
    });
    const recent = item({
      id: 'wmi_recent',
      content: chars(10),
      importance: 0.5,
      provenance: {
        sourceType: 'web_user',
        sourceId: null,
        sessionId: null,
        observedAt: new Date(nowMs - DAY_MS).toISOString(),
      },
    });
    const plan = planWorkspaceMemoryRecall({
      candidates: [old, recent],
      now: NOW,
      maxChars: 1000,
      limit: 5,
      measureLine,
      measureSegmentOverhead,
    });
    expect(plan.segments[1].entries.map((entry) => entry.item.id)).toEqual([
      'wmi_recent',
      'wmi_old',
    ]);
  });
});
