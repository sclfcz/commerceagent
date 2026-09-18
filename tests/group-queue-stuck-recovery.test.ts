import { afterEach, describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';

// Regression coverage for #618: warm-path IPC follow-ups must be visible to
// stuck-runner recovery. Follow-ups injected into a live runner establish a
// dedicated IPC-debt timestamp without re-arming pendingMessages, so a wedged
// in-flight turn remains visible even when ordinary output refreshes activity.
//
// State is seeded directly into the internal map (same approach as
// conversation-agent-warm-lifecycle.test.ts) so the tests stay hermetic.

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;

interface SeedOpts {
  active?: boolean;
  groupFolder?: string;
  agentId?: string | null;
  runnerRuntime?: 'host' | 'container' | null;
  runnerGeneration?: number;
  runnerPid?: number | null;
  queryInFlight?: boolean;
  queryId?: string | null;
  activeRunnerIsTask?: boolean;
  lastActivityAt?: number | null;
  pendingMessages?: boolean;
  hasIpcInjectedMessages?: boolean;
  ipcOwedSinceAt?: number | null;
}

function seedRunner(q: GroupQueue, jid: string, opts: SeedOpts = {}) {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  anyQ.groups.set(jid, {
    active: opts.active ?? true,
    runnerGeneration: opts.runnerGeneration ?? 1,
    runnerRuntime: opts.runnerRuntime ?? 'host',
    activeRunnerIsTask: opts.activeRunnerIsTask ?? false,
    lastActivityAt: opts.lastActivityAt ?? null,
    queryInFlight: opts.queryInFlight ?? false,
    queryId:
      opts.queryId !== undefined
        ? opts.queryId
        : opts.queryInFlight
          ? 'query-1'
          : null,
    pendingMessages: opts.pendingMessages ?? false,
    pendingTasks: [],
    process:
      opts.runnerPid === undefined || opts.runnerPid === null
        ? null
        : { pid: opts.runnerPid },
    containerName: null,
    displayName: null,
    groupFolder: opts.groupFolder ?? 'main',
    agentId: opts.agentId ?? null,
    taskRunId: null,
    retryCount: 0,
    retryTimer: null,
    restarting: false,
    selectedProviderId: null,
    drainSentinelWritten: false,
    hasIpcInjectedMessages: opts.hasIpcInjectedMessages ?? false,
    ipcOwedSinceAt: opts.ipcOwedSinceAt ?? null,
  });
}

function getState(q: GroupQueue, jid: string): Record<string, unknown> {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  return anyQ.groups.get(jid)!;
}

describe('#618: IPC-injected follow-ups are visible to stuck recovery', () => {
  const folder = `stuck-test-${process.pid}-${Date.now()}`;
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);

  afterEach(() => {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  test('wedged in-flight turn with injected input is reported as stuck (ipc_injected)', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].jid).toBe(jid);
    expect(stuck[0].reason).toBe('ipc_injected');
    expect(stuck[0].idleMs).toBeGreaterThanOrEqual(IDLE_THRESHOLD_MS);
  });

  test('warm runner idle between turns is NOT stuck: turn completed, no owed work', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    // hasIpcInjectedMessages stays true for the runner lifetime (exit-replay
    // safety), but queryInFlight=false means the runner reported the turn
    // idle. IDLE_TIMEOUT owns this runner, not stuck recovery.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('pendingMessages path still reports stuck with pending_messages reason', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      pendingMessages: true,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('pending_messages');
  });

  test('a recently injected follow-up is not stuck: sendMessage restarts the idle window', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    // Warm runner sitting idle long past the threshold when the user's
    // follow-up arrives. Without the lastActivityAt refresh at inject time,
    // the runner would look instantly stuck and get restarted before it had
    // any chance to answer.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.sendMessage(jid, 'follow-up message')).toBe('sent');
    expect(getState(q, jid).hasIpcInjectedMessages).toBe(true);
    expect(getState(q, jid).queryInFlight).toBe(true);
    expect(getState(q, jid).ipcOwedSinceAt).toEqual(expect.any(Number));
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('markIpcInjectedMessage restarts the idle window', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      lastActivityAt: 1,
    });

    const before = Date.now();
    q.markIpcInjectedMessage(jid);
    const after = Date.now();

    const last = getState(q, jid).lastActivityAt as number;
    expect(last).toBeGreaterThanOrEqual(before);
    expect(last).toBeLessThanOrEqual(after);
    expect(getState(q, jid).ipcOwedSinceAt).toBe(last);
  });

  test('ordinary runner output refreshes idle activity without moving the absolute IPC debt clock', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: 1,
      lastActivityAt: 1,
    });

    q.markRunnerActivity(jid);

    expect(getState(q, jid).lastActivityAt).toBeGreaterThan(1);
    expect(getState(q, jid).ipcOwedSinceAt).toBe(1);
  });

  test('absolute IPC ceiling remains visible despite recent runner output', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    const forceRestartMs = 10 * 60 * 1000;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: Date.now() - forceRestartMs - 1000,
      lastActivityAt: Date.now() - 30_000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS, forceRestartMs);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('ipc_injected');
    expect(stuck[0].idleMs).toBeLessThan(IDLE_THRESHOLD_MS);
    expect(stuck[0].ipcOwedMs).toBeGreaterThanOrEqual(forceRestartMs);
  });

  test('probe result is rejected when the old turn becomes idle', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 101,
      queryInFlight: true,
      queryId: 'old-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerQueryIdle(jid);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is rejected when fresh activity drops below the idle threshold', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 106,
      queryInFlight: true,
      queryId: 'recovering-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerActivity(jid);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result cannot restart a new healthy query on the same warm runner', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 102,
      queryInFlight: true,
      queryId: 'old-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerQueryIdle(jid);
    expect(q.sendMessage(jid, 'new healthy turn')).toBe('sent');
    expect(getState(q, jid).queryId).not.toBe(candidate.queryId);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is rejected when the query, PID, or generation changes', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 103,
      queryInFlight: true,
      queryId: 'same-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    const state = getState(q, jid);

    state.queryId = 'replacement-query';
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();

    state.queryId = 'same-query';
    state.process = { pid: 104 };
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();

    state.process = { pid: 103 };
    state.runnerGeneration = 2;
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is accepted only while the same IPC debt remains owed', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 105,
      queryInFlight: true,
      queryId: 'same-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 2000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 2000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toMatchObject({
      runnerGeneration: candidate.runnerGeneration,
      queryId: candidate.queryId,
      runnerPid: candidate.runnerPid,
      ipcOwedSinceAt: candidate.ipcOwedSinceAt,
    });

    getState(q, jid).ipcOwedSinceAt = Date.now() - IDLE_THRESHOLD_MS - 1000;
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('in-flight injected turn below the idle threshold is not stuck', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}`;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: Date.now() - 30_000,
      lastActivityAt: Date.now() - 30_000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('conversation-agent task lanes remain explicitly owned by their task lifecycle', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:sess1`;
    seedRunner(q, jid, {
      groupFolder: folder,
      agentId: 'sess1',
      activeRunnerIsTask: true,
      queryInFlight: true,
      hasIpcInjectedMessages: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });
});
