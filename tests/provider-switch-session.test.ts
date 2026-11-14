import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Isolated temp DATA_DIR so the suite never touches the real database.
const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'commerceagent-provider-'),
);

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const db = await import('../src/db.ts');

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  db.deleteAllSessionsForFolder('grp');
});

/**
 * Story (PR #549 / session continuity): a provider switch used to delete the
 * SDK session, which also wiped the provider_id binding and forced the next
 * turn to reload the conversation from scratch. The switch now keeps the row:
 * the runner resumes a thinking-stripped copy of the transcript, and the sticky
 * binding moves with it. These tests pin the db-level invariants that flow
 * relies on.
 */
describe('provider switch: session row, binding and strip marker', () => {
  test('switching the bound provider keeps the session id intact', () => {
    db.setSession('grp', 'sess-A', null);
    db.setSessionProviderId('grp', null, 'provider-A');

    // Runner sequence on a provider move: re-bind, then resume (strip mode).
    db.setSessionProviderId('grp', null, 'provider-B');

    expect(db.getSession('grp', null)).toBe('sess-A');
    expect(db.getSessionProviderId('grp', null)).toBe('provider-B');
  });

  test('a pending strip marker survives the provider re-bind', () => {
    db.setSession('grp', 'sess-A', null);
    db.setSessionProviderId('grp', null, 'provider-A');
    db.markSessionsForThinkingStripByProviderId('provider-A');
    expect(db.getSessionResumeStripThinking('grp', null)).toBe(true);

    // trySelectPoolProvider writes the new binding before the runner runs; the
    // marker must not be lost in between, or the switch resumes a transcript
    // whose thinking blocks the new upstream cannot verify.
    db.setSessionProviderId('grp', null, 'provider-B');
    expect(db.getSessionResumeStripThinking('grp', null)).toBe(true);
  });

  test('only an explicit reset (deleteSession) drops the binding', () => {
    db.setSession('grp', 'sess-A', null);
    db.setSessionProviderId('grp', null, 'provider-A');

    db.deleteSession('grp', null);
    expect(db.getSessionProviderId('grp', null)).toBeUndefined();
    expect(db.getSession('grp', null)).toBeUndefined();
  });

  test('marking is agent-scoped — does not leak across agent_ids', () => {
    db.setSession('grp', 'sess-main', null);
    db.setSessionProviderId('grp', null, 'provider-A');
    db.setSession('grp', 'sess-agent', 'agent-1');
    db.setSessionProviderId('grp', 'agent-1', 'provider-A');

    db.markSessionsForThinkingStripByProviderId('provider-A');
    expect(db.getSessionResumeStripThinking('grp', null)).toBe(true);
    expect(db.getSessionResumeStripThinking('grp', 'agent-1')).toBe(true);

    // Re-keying one session clears only that one's marker.
    db.setSession('grp', 'sess-agent-stripped', 'agent-1');
    expect(db.getSessionResumeStripThinking('grp', 'agent-1')).toBe(false);
    expect(db.getSessionResumeStripThinking('grp', null)).toBe(true);
    expect(db.getSession('grp', null)).toBe('sess-main');
    expect(db.getSessionProviderId('grp', null)).toBe('provider-A');
  });
});
