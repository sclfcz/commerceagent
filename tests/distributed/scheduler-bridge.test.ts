import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-bridge-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });
fs.mkdirSync(path.join(tmpGroupsDir, 'bridge-test'), { recursive: true });

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});
vi.mock('../../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../../src/db.js');
const { ScheduledTaskExecutor, SchedulerForwarder, createSchedulerBridge } =
  await import('../../src/distributed/scheduled-bridge.js');
const { makeRepository, createTestPool, describeMysql, acquireSuiteLock } =
  await import('./helpers.js');
const Database = (await import('better-sqlite3')).default;
const { Worker } = await import('../../src/distributed/worker.js');
const { testConfig } = await import('./helpers.js');

import type { Pool } from '../../src/distributed/mysql.js';
import type { RunRepository } from '../../src/distributed/run-repository.js';
import type { SchedulerDependencies } from '../../src/task-scheduler.js';
const { cancelTaskRunNow, executeClaimedTaskRun, getDistSchedulerHooks } =
  await import('../../src/task-scheduler.js');
import type { ClaimedTaskRun, TaskRun } from '../../src/types.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const CHAT_JID = 'bridge-test@chat';
const GROUP_FOLDER = 'bridge-test';

function makeTask(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    group_folder: GROUP_FOLDER,
    chat_jid: CHAT_JID,
    prompt: 'echo',
    schedule_type: 'once' as const,
    schedule_value: now,
    context_mode: 'isolated' as const,
    execution_type: 'script' as const,
    script_command: 'echo hi',
    execution_mode: 'host' as const,
    next_run: null,
    status: 'active' as const,
    created_at: now,
    created_by: 'user-1',
    notify_channels: null,
    ...overrides,
  };
}

describeMysql('scheduled task bridge', () => {
  let pool: Pool;
  let repository: RunRepository;
  let release: () => void;

  let sqlite: InstanceType<typeof Database>;

  beforeAll(async () => {
    db.initDatabase();
    // Host execution is gated on a *live* administrator owner.
    const now = new Date().toISOString();
    db.createUser({
      id: 'user-1',
      username: 'user-1',
      password_hash: 'hash',
      display_name: 'Bridge Owner',
      role: 'admin',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    } as never);
    sqlite = new Database(path.join(tmpStoreDir, 'messages.db'));
    pool = await createTestPool();
    release = await acquireSuiteLock();
    repository = makeRepository(pool, { leaseMs: 5_000 });
  });

  afterAll(async () => {
    sqlite?.close();
    await pool?.end();
    release?.();
  });

  beforeEach(async () => {
    // Leftovers from earlier tests would be picked up by claimNextTaskRun.
    for (const run of db.getTaskRunsByStatus(
      ['queued', 'retry_wait', 'running'],
      500,
    ))
      db.cancelTaskRun(run.id, 'test cleanup');
    await pool.query('DELETE FROM dist_task_run_events');
    await pool.query('DELETE FROM dist_outbox');
    await pool.query('DELETE FROM dist_task_runs');
  });

  const deps = {
    queue: {
      isGroupMutationPaused: () => false,
      // Legacy queue contract: accept the job and run it out-of-band.
      enqueueTask: (_jid: string, _taskId: string, fn: () => unknown) => {
        setTimeout(() => void fn(), 0);
        return true;
      },
    },
    sendMessage: async () => ({}),
    broadcastStreamEvent: () => {},
    registeredGroups: () => ({
      [CHAT_JID]: {
        folder: GROUP_FOLDER,
        created_by: 'user-1',
        executionMode: 'host',
      },
    }),
  } as unknown as SchedulerDependencies;

  /** Create a task + one occurrence and return the SQLite run. */
  const seedRun = (
    options: { availableAt?: string; status?: string } = {},
  ): TaskRun => {
    const task = makeTask();
    db.createTask(task as never);
    if (options.status && options.status !== 'queued') {
      // createTaskRun always starts queued; move it afterwards for the
      // "already terminal / already running" reconciliation cases.
    }
    const created = db.createTaskRun({
      task: db.getTaskById(task.id)!,
      triggerType: 'manual',
      availableAt: options.availableAt,
    });
    return created.run;
  };

  const executorFor = (runClaimed: (claim: ClaimedTaskRun) => Promise<void>) =>
    new ScheduledTaskExecutor({
      repository,
      scheduler: deps,
      leaseMs: 60_000,
      runClaimed: async (claim) => runClaimed(claim),
      getRun: (id) => db.getTaskRunById(id),
      claimRun: (id, owner, leaseMs) => db.claimTaskRunById(id, owner, leaseMs),
    });

  const addDist = (sqliteRun: TaskRun) =>
    new SchedulerForwarder({
      repository,
      scheduler: deps,
      tenantOf: () => 'user-1',
      listRuns: () => [sqliteRun],
      intervalMs: 60_000,
    });

  const payloadOf = (row: Record<string, any>): Record<string, unknown> =>
    typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

  const distRows = async (idempotencyKey: string) =>
    (
      await pool.query(
        'SELECT * FROM dist_task_runs WHERE idempotency_key = ?',
        [idempotencyKey],
      )
    )[0] as Array<Record<string, any>>;

  /** Run one dist envelope through the executor as a worker would. */
  const runDist = async (
    distRunId: string,
    executor: ScheduledTaskExecutor,
    payload: Record<string, unknown>,
  ) => {
    const row = (
      await pool.query('SELECT * FROM dist_task_runs WHERE id = ?', [distRunId])
    )[0] as Array<Record<string, any>>;
    const claimed = (
      await pool.query('SELECT lease_token FROM dist_task_runs WHERE id = ?', [
        distRunId,
      ])
    )[0] as Array<{ lease_token: number }>;
    return executor.execute(
      {
        runId: distRunId,
        tenantId: row[0].tenant_id,
        taskId: row[0].task_id,
        attempt: 1,
        maxAttempts: 20,
        payload,
        workerId: 'bridge-worker',
        leaseToken: Number(claimed[0].lease_token),
        signal: new AbortController().signal,
      },
      {} as never,
    );
  };

  test('a once-task is executed once and the dist envelope mirrors success', async () => {
    const sqliteRun = seedRun();
    const forwarder = addDist(sqliteRun);
    expect((await forwarder.flush()).submitted).toBe(1);
    const [dist] = await distRows(sqliteRun.id);
    // Claim the dist envelope the way the worker would.
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=lease_token+1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );

    let executions = 0;
    const executor = executorFor(async (claim) => {
      executions += 1;
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'echo',
        notificationStatus: 'skipped',
      });
    });
    await runDist(dist.id, executor, payloadOf(dist));

    expect(executions).toBe(1);
    expect(db.getTaskRunById(sqliteRun.id)?.status).toBe('success');
    const after = (await distRows(sqliteRun.id))[0];
    expect(after.status).toBe('succeeded');
    expect(
      (typeof after.result === 'string'
        ? JSON.parse(after.result)
        : after.result
      ).mirroredStatus,
    ).toBe('success');
  });

  test('forwarding the same SQLite run repeatedly keeps one dist row', async () => {
    const sqliteRun = seedRun();
    const forwarder = addDist(sqliteRun);
    const first = await forwarder.flush();
    const second = await forwarder.flush();
    // A fresh forwarder simulates a process restart (empty in-memory Set).
    const restarted = addDist(sqliteRun);
    await restarted.flush();
    expect(first.submitted).toBe(1);
    expect(second.submitted).toBe(0);
    expect((await distRows(sqliteRun.id)).length).toBe(1);
  });

  test('reconcile: terminal SQLite run is mirrored without executing', async () => {
    const sqliteRun = seedRun();
    const claim = db.claimTaskRunById(sqliteRun.id, 'legacy', 60_000)!;
    db.markTaskRunExecutionStarted(
      claim.id,
      claim.lease_owner,
      claim.lease_token,
    );
    db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
      status: 'success',
      result: 'done',
      notificationStatus: 'skipped',
    });

    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    let executions = 0;
    const executor = executorFor(async () => {
      executions += 1;
    });
    await runDist(dist.id, executor, payloadOf(dist));
    expect(executions).toBe(0);
    const after = (await distRows(sqliteRun.id))[0];
    expect(after.status).toBe('succeeded');
    expect(
      (typeof after.result === 'string'
        ? JSON.parse(after.result)
        : after.result
      ).mirroredStatus,
    ).toBe('success');
  });

  test('reconcile: a not-yet-due SQLite run is released with the remaining delay', async () => {
    const sqliteRun = seedRun({
      availableAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    let executions = 0;
    const executor = executorFor(async () => {
      executions += 1;
    });
    await runDist(dist.id, executor, payloadOf(dist));
    expect(executions).toBe(0);
    const after = (await distRows(sqliteRun.id))[0];
    expect(after.status).toBe('queued');
    const waitMs = new Date(after.available_at).getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(20_000);
  });

  test('reconcile: a run owned by a live SQLite lease is released for leaseMs', async () => {
    const sqliteRun = seedRun();
    const claim = db.claimTaskRunById(sqliteRun.id, 'legacy', 60_000)!;
    expect(claim).toBeDefined();
    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    let executions = 0;
    const executor = executorFor(async () => {
      executions += 1;
    });
    await runDist(dist.id, executor, payloadOf(dist));
    expect(executions).toBe(0);
    const after = (await distRows(sqliteRun.id))[0];
    expect(after.status).toBe('queued');
  });

  test('reconcile: a due queued run is claimed and executed', async () => {
    const sqliteRun = seedRun();
    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    const owners: string[] = [];
    const executor = executorFor(async (claim) => {
      owners.push(claim.lease_owner);
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'success',
        result: 'ok',
        notificationStatus: 'skipped',
      });
    });
    await runDist(dist.id, executor, payloadOf(dist));
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatch(/^dist:bridge-worker:\d+$/);
    expect((await distRows(sqliteRun.id))[0].status).toBe('succeeded');
  });

  test('a crash after start is mirrored as failed and never replayed', async () => {
    const sqliteRun = seedRun();
    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    const executions: string[] = [];
    // "Crash": mark started and stop without completing.
    const crashing = executorFor(async (claim) => {
      executions.push(claim.id);
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
    });
    await runDist(dist.id, crashing, payloadOf(dist));
    // The dist envelope is released (still running on the SQLite side).
    expect((await distRows(sqliteRun.id))[0].status).toBe('queued');

    // The legacy reaper turns the abandoned started run into `failed`.
    sqlite
      .prepare(
        "UPDATE task_runs SET lease_expires_at = datetime('now','-1 minute') WHERE id = ?",
      )
      .run(sqliteRun.id);
    expect(db.failExpiredStartedTaskRuns()).toBe(1);
    expect(db.getTaskRunById(sqliteRun.id)?.status).toBe('failed');

    // Next dispatch mirrors the failure and does not execute the script again.
    const after = (await distRows(sqliteRun.id))[0];
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=lease_token+1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [after.id],
    );
    const executor = executorFor(async (claim) => {
      executions.push(claim.id);
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      );
    });
    await runDist(after.id, executor, payloadOf(after));
    expect(executions).toHaveLength(1);
    const final = (await distRows(sqliteRun.id))[0];
    expect(final.status).toBe('succeeded');
    expect(
      (typeof final.result === 'string'
        ? JSON.parse(final.result)
        : final.result
      ).mirroredStatus,
    ).toBe('failed');
  });

  test('a pre-start retry releases the dist envelope without consuming an attempt', async () => {
    const sqliteRun = seedRun();
    const forwarder = addDist(sqliteRun);
    await forwarder.flush();
    const [dist] = await distRows(sqliteRun.id);
    await pool.query(
      "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
      [dist.id],
    );
    const executor = executorFor(async (claim) => {
      db.releaseTaskRunForRetry(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
        new Date(Date.now() + 2_000).toISOString(),
        'workspace mutation in progress',
        { countsAsAttempt: false },
      );
    });
    await runDist(dist.id, executor, payloadOf(dist));
    const sqliteAfter = db.getTaskRunById(sqliteRun.id)!;
    expect(sqliteAfter.status).toBe('retry_wait');
    // claimTaskRunById incremented attempt, the non-counting release gave it
    // back: a pre-start retry must not consume the legacy retry budget.
    expect(sqliteAfter.attempt).toBe(0);
    const after = (await distRows(sqliteRun.id))[0];
    expect(after.status).toBe('queued');
    expect(after.attempt).toBe(0);
  });

  test('host tasks skip tenant slots, container tasks go through them', async () => {
    const acquire = vi.fn(async () => true);
    const worker = new Worker({
      repository,
      executor: { execute: async () => ({}) },
      config: testConfig({ workerId: 'admission-probe', concurrency: 2 }),
      tenantSlots: { acquire } as never,
    });
    const baseClaim = {
      runId: 'run-1',
      tenantId: 'user-1',
      taskId: 'task-1',
      payload: { skipTenantAdmission: true },
      attempt: 1,
      maxAttempts: 20,
      leaseToken: 1,
    };
    const admit = (
      worker as unknown as {
        admit: (claim: unknown) => Promise<boolean>;
      }
    ).admit.bind(worker);
    expect(await admit(baseClaim)).toBe(true);
    expect(acquire).not.toHaveBeenCalled();
    expect(
      await admit({ ...baseClaim, payload: { skipTenantAdmission: false } }),
    ).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(1);
  });
  const waitForDistRow = async (
    runId: string,
  ): Promise<Record<string, any>> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await distRows(runId);
      if (rows.length) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no dist row for ${runId}`);
  };

  const waitForDistStatus = async (runId: string, status: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const [row] = await distRows(runId);
      if (row?.status === status) return row;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`dist row ${runId} never reached ${status}`);
  };

  test('cancel: a running task flips its dist envelope immediately', async () => {
    const sqliteRun = seedRun();
    // Long poll: the embedded worker must not race this test (we drive the
    // envelope state by hand). Its first claim runs before the forwarder has
    // submitted anything, so a 60s interval keeps it out of the way.
    const { bridge } = createSchedulerBridge(
      { scheduler: deps, logger: () => {} },
      testConfig({ pollMs: 60_000 }),
      { repository },
    );
    try {
      // Forwarder + hooks only: an embedded worker would race this test and
      // claim the SQLite run before we can.
      bridge.startForwardingOnly();
      const dist = await waitForDistRow(sqliteRun.id);
      // Legacy owns the SQLite lease: the dist cancel must address the
      // envelope only, never the execution fence.
      const legacy = db.claimTaskRunById(sqliteRun.id, 'legacy-owner', 60_000)!;
      db.markTaskRunExecutionStarted(
        legacy.id,
        legacy.lease_owner,
        legacy.lease_token,
      );
      // The envelope id is the SQLite run id, so id-keyed cancel matches.
      expect(dist.id).toBe(sqliteRun.id);
      await pool.query(
        "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_token=lease_token+1, lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
        [sqliteRun.id],
      );
      expect(getDistSchedulerHooks()).toEqual({ wake: true, cancel: true });

      expect(cancelTaskRunNow(sqliteRun.id).success).toBe(true);

      // Cancelled through the hook, not through a reconcile round-trip.
      const cancelled = await waitForDistStatus(sqliteRun.id, 'cancelled');
      expect(cancelled.finished_at).toBeTruthy();
      expect(db.getTaskRunById(sqliteRun.id)?.status).toBe('cancelled');
    } finally {
      await bridge.stop();
    }
  });

  test('cancel: a queued task cancels its envelope and is never claimed', async () => {
    const sqliteRun = seedRun();
    const { bridge } = createSchedulerBridge(
      { scheduler: deps, logger: () => {} },
      testConfig({ pollMs: 60_000 }),
      { repository },
    );
    try {
      bridge.start();
      // `flush()` is single-flight: the start-time flush may still be running.
      await waitForDistRow(sqliteRun.id);

      expect(cancelTaskRunNow(sqliteRun.id).success).toBe(true);
      await waitForDistStatus(sqliteRun.id, 'cancelled');
      expect(db.getTaskRunById(sqliteRun.id)?.status).toBe('cancelled');

      // No worker can pick it up any more ...
      const claimed = await repository.claim('other-worker', 10);
      expect(claimed.map((row) => row.runId)).not.toContain(sqliteRun.id);

      // ... and a stale envelope cannot resurrect it.
      let executions = 0;
      const executor = executorFor(async () => {
        executions += 1;
      });
      await runDist(
        sqliteRun.id,
        executor,
        payloadOf((await distRows(sqliteRun.id))[0]),
      );
      expect(executions).toBe(0);
      expect((await distRows(sqliteRun.id))[0].status).toBe('cancelled');
    } finally {
      await bridge.stop();
    }
  });

  test('mysql outage: the pump falls back to legacy claiming and recovers', async () => {
    let down = true;
    const flaky = Object.create(repository) as RunRepository;
    flaky.submit = async (input) => {
      if (down) throw new Error('mysql_down');
      return repository.submit(input);
    };
    const { bridge } = createSchedulerBridge(
      { scheduler: deps, logger: () => {} },
      testConfig({
        pollMs: 60_000,
        fallbackAfterFailures: 3,
        fallbackAfterMs: 60_000,
      }),
      {
        repository: flaky,
        probe: async () => {
          if (down) throw new Error('mysql_down');
          return 1;
        },
      },
    );
    try {
      bridge.start();
      const sqliteRun = seedRun();
      for (let attempt = 0; attempt < 8; attempt++) {
        await bridge.forwarder.flush();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await vi.waitFor(
        () =>
          expect(getDistSchedulerHooks()).toEqual({
            wake: false,
            cancel: false,
          }),
        { timeout: 2_000 },
      );
      expect(bridge.health.state).toBe('degraded');
      expect(bridge.health.consecutiveFailures).toBeGreaterThanOrEqual(3);
      // Nothing was dispatched while MySQL was down.
      expect((await distRows(sqliteRun.id)).length).toBe(0);

      // The legacy claim loop still runs the task, exactly once.
      const claim = db.claimNextTaskRun('legacy-after-degrade', 60_000);
      expect(claim?.id).toBe(sqliteRun.id);
      await executeClaimedTaskRun(claim!, deps);
      let afterLegacy = db.getTaskRunById(sqliteRun.id);
      for (let attempt = 0; attempt < 200; attempt++) {
        if (
          afterLegacy &&
          !['queued', 'running', 'retry_wait'].includes(afterLegacy.status)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 25));
        afterLegacy = db.getTaskRunById(sqliteRun.id);
      }
      expect({
        status: afterLegacy?.status,
        error: afterLegacy?.error,
      }).toEqual({ status: 'success', error: null });

      // Two successful probes reinstall the dispatch hooks.
      down = false;
      await bridge.health.probeOnce();
      await bridge.health.probeOnce();
      expect(bridge.health.state).toBe('healthy');
      await vi.waitFor(
        () =>
          expect(getDistSchedulerHooks()).toEqual({ wake: true, cancel: true }),
        { timeout: 2_000 },
      );

      // New work goes through the dist path again, still executed once.
      const next = seedRun();
      const envelope = await waitForDistRow(next.id);
      expect(envelope.status).toBe('queued');
      await pool.query(
        "UPDATE dist_task_runs SET status='running', lease_owner='bridge-worker', lease_expires_at=NOW(3)+INTERVAL 60 SECOND WHERE id=?",
        [next.id],
      );
      let executions = 0;
      const executor = executorFor(async (claimed) => {
        executions += 1;
        db.markTaskRunExecutionStarted(
          claimed.id,
          claimed.lease_owner,
          claimed.lease_token,
        );
        db.completeTaskRun(
          claimed.id,
          claimed.lease_owner,
          claimed.lease_token,
          {
            status: 'success',
            result: 'dist',
            notificationStatus: 'skipped',
          },
        );
      });
      await runDist(next.id, executor, payloadOf(envelope));
      expect(executions).toBe(1);
      expect((await distRows(next.id))[0].status).toBe('succeeded');
      // The run executed during the outage was not dispatched twice.
      expect(db.getTaskRunById(sqliteRun.id)?.status).toBe('success');
      expect((await distRows(sqliteRun.id)).length).toBe(0);
    } finally {
      await bridge.stop();
    }
  });
});
