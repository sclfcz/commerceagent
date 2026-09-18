import { afterEach, describe, expect, test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canDeleteAcknowledgedIpcSource,
  ISOLATED_TASK_RUN_COMPLETE_MARKER,
  awaitRequiredIpcSideEffects,
  extractDurableTaskRunIdFromNamespace,
  getIsolatedTaskRunCompletionMarker,
  markIsolatedTaskRunIpcComplete,
  tryCleanupCompletedIsolatedTaskRunIpc,
} from '../src/isolated-task-ipc.js';

const roots: string[] = [];

function makeRunDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-task-ipc-'));
  roots.push(root);
  const runDir = path.join(root, 'tasks-run', 'run-1');
  fs.mkdirSync(path.join(runDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
  return runDir;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('isolated task IPC completion handshake', () => {
  test('retains acknowledged-protocol source until result file is durable', () => {
    expect(canDeleteAcknowledgedIpcSource('request-1', false)).toBe(false);
    expect(canDeleteAcknowledgedIpcSource('request-1', true)).toBe(true);
    expect(canDeleteAcknowledgedIpcSource(undefined, false)).toBe(true);
  });

  test('extracts only the explicit durable run namespace segment', () => {
    const runId = '27b33c99-0558-4a50-a7e6-e0b2334fccf0';
    expect(
      extractDurableTaskRunIdFromNamespace(`task-run-${runId}-attempt-3`),
    ).toBe(runId);
    expect(
      extractDurableTaskRunIdFromNamespace(`task-legacy-${runId}`),
    ).toBeNull();
  });

  test('never removes an unmarked producer namespace', () => {
    const runDir = makeRunDir();
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(false);
    expect(fs.existsSync(runDir)).toBe(true);
  });

  test('keeps completed output until the host watcher ACKs it', () => {
    const runDir = makeRunDir();
    const output = path.join(runDir, 'messages', 'last-message.json');
    fs.writeFileSync(output, JSON.stringify({ type: 'message', text: 'done' }));

    markIsolatedTaskRunIpcComplete(runDir, {
      taskId: 'task-1',
      taskRunId: 'run-1',
      workspaceFolder: 'workspace-1',
      virtualChatJid: 'web:workspace-1#task:run-1',
      sessionAgentId: 'task-run-1',
    });
    expect(fs.existsSync(getIsolatedTaskRunCompletionMarker(runDir))).toBe(
      true,
    );
    expect(path.basename(getIsolatedTaskRunCompletionMarker(runDir))).toBe(
      `${ISOLATED_TASK_RUN_COMPLETE_MARKER}-run-1.json`,
    );
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(false);
    expect(fs.existsSync(output)).toBe(true);

    // Host delivery succeeded and the watcher unlinked the source file.  This
    // is also what a startup recovery scan does after a process crash.
    fs.unlinkSync(output);
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(true);
    expect(fs.existsSync(runDir)).toBe(false);
  });

  test('waits for task request/result JSON as well as messages', () => {
    const runDir = makeRunDir();
    const taskFile = path.join(runDir, 'tasks', 'schedule_task_result_1.json');
    fs.writeFileSync(taskFile, '{}');
    markIsolatedTaskRunIpcComplete(runDir, {
      taskId: 'task-1',
      taskRunId: 'run-1',
      workspaceFolder: 'workspace-1',
      virtualChatJid: 'web:workspace-1#task:run-1',
      sessionAgentId: 'task-run-1',
    });

    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(false);
    fs.unlinkSync(taskFile);
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(true);
  });

  test('does not ACK task output before required delivery settles', async () => {
    const runDir = makeRunDir();
    const output = path.join(runDir, 'messages', 'last-message.json');
    fs.writeFileSync(output, JSON.stringify({ type: 'message', text: 'done' }));
    markIsolatedTaskRunIpcComplete(runDir, {
      taskId: 'task-1',
      taskRunId: 'run-1',
      workspaceFolder: 'workspace-1',
      virtualChatJid: 'web:workspace-1#task:run-1',
      sessionAgentId: 'task-run-1',
    });

    let finishDelivery!: (success: boolean) => void;
    const delivery = new Promise<boolean>((resolve) => {
      finishDelivery = resolve;
    });
    const acknowledge = awaitRequiredIpcSideEffects([delivery]).then(() => {
      fs.unlinkSync(output);
    });

    await Promise.resolve();
    expect(fs.existsSync(output)).toBe(true);
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(false);

    finishDelivery(true);
    await acknowledge;
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(true);
  });

  test('keeps task output unacknowledged when a required delivery fails', async () => {
    const runDir = makeRunDir();
    const output = path.join(runDir, 'messages', 'last-message.json');
    fs.writeFileSync(output, '{}');
    markIsolatedTaskRunIpcComplete(runDir, {
      taskId: 'task-1',
      taskRunId: 'run-1',
      workspaceFolder: 'workspace-1',
      virtualChatJid: 'web:workspace-1#task:run-1',
      sessionAgentId: 'task-run-1',
    });

    await expect(
      awaitRequiredIpcSideEffects([Promise.resolve(false)]),
    ).rejects.toThrow('required IPC side effect');
    expect(fs.existsSync(output)).toBe(true);
    expect(tryCleanupCompletedIsolatedTaskRunIpc(runDir)).toBe(false);
  });
});
