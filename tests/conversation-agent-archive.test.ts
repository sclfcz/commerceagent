import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-archive-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const {
  initDatabase,
  createAgent,
  getAgent,
  archiveInactiveConversationAgents,
  listActiveConversationAgents,
} = await import('../src/db.js');

const DAY = 24 * 60 * 60 * 1000;

function seedAgent(
  id: string,
  overrides: Partial<{
    kind: 'conversation' | 'spawn' | 'task';
    status: string;
    created_at: string;
    last_active_at: string | null;
  }> = {},
): void {
  createAgent({
    id,
    group_folder: 'main',
    chat_jid: 'web:main',
    name: id,
    prompt: '',
    status: (overrides.status as 'idle') ?? 'idle',
    kind: overrides.kind ?? 'conversation',
    created_by: 'owner-1',
    created_at: overrides.created_at ?? new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    ...(overrides.last_active_at !== undefined
      ? { last_active_at: overrides.last_active_at ?? undefined }
      : {}),
  });
}

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('archiveInactiveConversationAgents', () => {
  test('archives only long-inactive conversation/spawn sessions', () => {
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    const recent = new Date(Date.now() - 1 * DAY).toISOString();
    seedAgent('stale-conversation', {
      created_at: old,
      last_active_at: old,
    });
    seedAgent('fresh-conversation', {
      created_at: old,
      last_active_at: recent,
    });
    // No last_active_at at all: created_at is the activity anchor.
    seedAgent('stale-legacy', { created_at: old, last_active_at: null });
    seedAgent('stale-spawn', {
      kind: 'spawn',
      created_at: old,
      last_active_at: old,
    });
    seedAgent('stale-task', {
      kind: 'task',
      status: 'running',
      created_at: old,
      last_active_at: old,
    });

    const cutoff = new Date(Date.now() - 30 * DAY).toISOString();
    expect(archiveInactiveConversationAgents(cutoff)).toBe(3);

    expect(getAgent('stale-conversation')?.status).toBe('completed');
    expect(getAgent('stale-conversation')?.completed_at).toBeTruthy();
    expect(getAgent('stale-legacy')?.status).toBe('completed');
    expect(getAgent('stale-spawn')?.status).toBe('completed');
    // Untouched: recently active sessions and task agents.
    expect(getAgent('fresh-conversation')?.status).toBe('idle');
    expect(getAgent('stale-task')?.status).toBe('running');

    const active = listActiveConversationAgents().map((agent) => agent.id);
    expect(active).toContain('fresh-conversation');
    expect(active).not.toContain('stale-conversation');

    // Idempotent: a second pass finds nothing new.
    expect(archiveInactiveConversationAgents(cutoff)).toBe(0);
  });
});
