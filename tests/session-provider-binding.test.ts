import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-provider-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  setSession,
  getSession,
  getSessionProviderId,
  setSessionProviderId,
  deleteSession,
  getSessionResumeStripThinking,
  markSessionsForThinkingStripByProviderId,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('session→provider sticky binding', () => {
  test('returns undefined for unknown session', () => {
    expect(getSessionProviderId('unknown-folder')).toBeUndefined();
    expect(
      getSessionProviderId('unknown-folder', 'some-agent'),
    ).toBeUndefined();
  });

  test('setSessionProviderId creates a row when none exists', () => {
    setSessionProviderId('folder-1', '', 'provider-A');
    expect(getSessionProviderId('folder-1')).toBe('provider-A');
    expect(getSessionProviderId('folder-1', '')).toBe('provider-A');
  });

  test('setSessionProviderId updates existing session row without losing session_id', () => {
    setSession('folder-2', 'session-uuid-2', '');
    setSessionProviderId('folder-2', '', 'provider-B');
    expect(getSessionProviderId('folder-2')).toBe('provider-B');

    // Switching provider must not delete the session_id binding.
    setSessionProviderId('folder-2', '', 'provider-C');
    expect(getSessionProviderId('folder-2')).toBe('provider-C');
  });

  test('agent-scoped bindings are independent of main bindings', () => {
    setSessionProviderId('folder-3', '', 'main-provider');
    setSessionProviderId('folder-3', 'agent-x', 'sub-provider');
    expect(getSessionProviderId('folder-3')).toBe('main-provider');
    expect(getSessionProviderId('folder-3', 'agent-x')).toBe('sub-provider');
  });

  test('clearing binding via null removes provider_id but keeps row', () => {
    setSessionProviderId('folder-4', '', 'provider-D');
    setSessionProviderId('folder-4', '', null);
    expect(getSessionProviderId('folder-4')).toBeUndefined();
  });

  test('deleteSession removes the binding too', () => {
    setSessionProviderId('folder-5', '', 'provider-E');
    deleteSession('folder-5', '');
    expect(getSessionProviderId('folder-5')).toBeUndefined();
  });
});

describe('markSessionsForThinkingStripByProviderId — narrowed cleanup (issue #476)', () => {
  test('only marks rows bound to the target provider', () => {
    setSession('folder-narrow-1', 'sess-1', '');
    setSessionProviderId('folder-narrow-1', '', 'provider-target');
    setSession('folder-narrow-2', 'sess-2', '');
    setSessionProviderId('folder-narrow-2', '', 'provider-other');

    const result = markSessionsForThinkingStripByProviderId('provider-target');

    expect(result.markedCount).toBe(1);
    expect(result.affectedFolders).toEqual(['folder-narrow-1']);
    expect(getSessionResumeStripThinking('folder-narrow-1')).toBe(true);
    // Unrelated provider's binding survives — this is the core fix.
    expect(getSessionResumeStripThinking('folder-narrow-2')).toBe(false);
    expect(getSessionProviderId('folder-narrow-2')).toBe('provider-other');
    // The conversation itself is kept; only the resume strategy changes.
    expect(getSession('folder-narrow-1')).toBe('sess-1');
    expect(getSessionProviderId('folder-narrow-1')).toBe('provider-target');
  });

  test('marks per-agent bindings to the same provider in one folder', () => {
    setSessionProviderId('folder-narrow-3', '', 'provider-shared');
    setSessionProviderId('folder-narrow-3', 'agent-a', 'provider-shared');
    setSessionProviderId('folder-narrow-3', 'agent-b', 'provider-other');

    const result = markSessionsForThinkingStripByProviderId('provider-shared');

    expect(result.markedCount).toBe(2);
    expect(result.affectedFolders).toEqual(['folder-narrow-3']);
    expect(getSessionResumeStripThinking('folder-narrow-3')).toBe(true);
    expect(getSessionResumeStripThinking('folder-narrow-3', 'agent-a')).toBe(
      true,
    );
    expect(getSessionResumeStripThinking('folder-narrow-3', 'agent-b')).toBe(
      false,
    );
  });

  test('returns empty result when no sessions match', () => {
    const result = markSessionsForThinkingStripByProviderId(
      'provider-does-not-exist',
    );
    expect(result.markedCount).toBe(0);
    expect(result.affectedFolders).toEqual([]);
  });

  test('deduplicates affected folders across multiple agent rows', () => {
    setSessionProviderId('folder-narrow-4', '', 'provider-multi');
    setSessionProviderId('folder-narrow-4', 'agent-x', 'provider-multi');
    setSessionProviderId('folder-narrow-5', '', 'provider-multi');

    const result = markSessionsForThinkingStripByProviderId('provider-multi');

    expect(result.markedCount).toBe(3);
    expect(result.affectedFolders.sort()).toEqual([
      'folder-narrow-4',
      'folder-narrow-5',
    ]);
  });

  test('marks unbound legacy rows only from explicitly attributable folders', () => {
    setSession('folder-unbound-safe', 'sess-safe', '');
    setSession('folder-unbound-ambiguous', 'sess-ambiguous', '');

    const result = markSessionsForThinkingStripByProviderId(
      'provider-with-no-bound-rows',
      { includeUnboundFolders: ['folder-unbound-safe'] },
    );

    expect(result.markedCount).toBe(1);
    expect(result.affectedFolders).toEqual(['folder-unbound-safe']);
    expect(getSessionResumeStripThinking('folder-unbound-safe')).toBe(true);
    expect(getSessionResumeStripThinking('folder-unbound-ambiguous')).toBe(
      false,
    );
    expect(getSession('folder-unbound-safe')).toBe('sess-safe');
    expect(getSession('folder-unbound-ambiguous')).toBe('sess-ambiguous');
  });

  test('a new session id spends the marker, the same id keeps it', () => {
    setSession('folder-marker', 'sess-old', '');
    setSessionProviderId('folder-marker', '', 'provider-marked');
    markSessionsForThinkingStripByProviderId('provider-marked');
    expect(getSessionResumeStripThinking('folder-marker')).toBe(true);

    // A failed strip leaves the old id in place: the marker must survive so the
    // next turn tries again instead of replaying unverifiable thinking blocks.
    setSession('folder-marker', 'sess-old', '');
    expect(getSessionResumeStripThinking('folder-marker')).toBe(true);

    // The stripped copy reports a new id; that transcript is clean.
    setSession('folder-marker', 'sess-stripped', '');
    expect(getSessionResumeStripThinking('folder-marker')).toBe(false);
  });
});
