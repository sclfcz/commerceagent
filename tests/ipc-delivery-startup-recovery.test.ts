import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { shouldRecoverPendingHistory } from '../src/delivery-cursor.js';
import { discardStartupTypedIpcDeliveries } from '../src/ipc-delivery-recovery.js';

const roots: string[] = [];

function writeDelivery(
  filepath: string,
  chatJid: string,
  id: string,
  coveredIds: string[] = [id],
): void {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(
    filepath,
    JSON.stringify({
      type: 'message',
      text: id,
      receipt: {
        deliveryId: `delivery-${id}`,
        chatJid,
        coveredCursors: coveredIds.map((coveredId) => ({
          timestamp: '2026-07-10T00:00:01.000Z',
          id: coveredId,
        })),
        cursor: { timestamp: '2026-07-10T00:00:01.000Z', id },
      },
    }),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('startup typed IPC delivery recovery', () => {
  test('deletes main/agent claims, excludes task-run, and recovers even when pull equals committed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-'));
    roots.push(root);
    const mainFile = path.join(root, 'folder', 'input', 'main.json');
    const agentFile = path.join(
      root,
      'folder',
      'agents',
      'agent-1',
      'input',
      'agent.json',
    );
    const taskFile = path.join(
      root,
      'folder',
      'tasks-run',
      'task-1',
      'input',
      'task.json',
    );
    const invalidFile = path.join(root, 'folder', 'input', 'legacy.json');
    writeDelivery(mainFile, 'web:main', 'm1');
    writeDelivery(agentFile, 'web:main#agent:agent-1', 'a1');
    writeDelivery(taskFile, 'web:main#task:task-1', 't1');
    fs.writeFileSync(
      invalidFile,
      JSON.stringify({ type: 'message', text: 'legacy' }),
    );

    let rewindPersistedBeforeDelete = false;
    const recovered = discardStartupTypedIpcDeliveries(root, () => {
      expect(fs.existsSync(mainFile)).toBe(true);
      expect(fs.existsSync(agentFile)).toBe(true);
      rewindPersistedBeforeDelete = true;
    });

    expect(recovered.map((receipt) => receipt.chatJid).sort()).toEqual([
      'web:main',
      'web:main#agent:agent-1',
    ]);
    expect(fs.existsSync(mainFile)).toBe(false);
    expect(fs.existsSync(agentFile)).toBe(false);
    expect(fs.existsSync(taskFile)).toBe(true);
    expect(fs.existsSync(invalidFile)).toBe(true);
    expect(rewindPersistedBeforeDelete).toBe(true);

    // The crash happened after rename/claim but before next-pull advanced:
    // R == C. The typed file itself is sufficient evidence to inspect DB and
    // enqueue replay; recovery must not be gated only on R > C.
    expect(shouldRecoverPendingHistory(true, false, true)).toBe(true);
    expect(shouldRecoverPendingHistory(false, false, true)).toBe(true);
  });

  test('does not delete crash evidence when durable rewind fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-fail-'));
    roots.push(root);
    const deliveryFile = path.join(root, 'folder', 'input', 'main.json');
    writeDelivery(deliveryFile, 'web:main', 'm1');

    expect(() =>
      discardStartupTypedIpcDeliveries(root, () => {
        throw new Error('persist failed');
      }),
    ).toThrow('persist failed');
    expect(fs.existsSync(deliveryFile)).toBe(true);
  });

  test('preserves an exact batch cursor set while startup orders DB replay', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-startup-batch-'));
    roots.push(root);
    const deliveryFile = path.join(root, 'folder', 'input', 'batch.json');
    writeDelivery(deliveryFile, 'web:main', 'm2', ['m1', 'm2']);

    const recovered = discardStartupTypedIpcDeliveries(root);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].coveredCursors?.map((cursor) => cursor.id)).toEqual([
      'm1',
      'm2',
    ]);
    expect(recovered[0].cursor.id).toBe('m2');
    expect(fs.existsSync(deliveryFile)).toBe(false);
  });
});
