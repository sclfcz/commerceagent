import { describe, expect, test, vi } from 'vitest';

import {
  buildFailedTaskImageNotification,
  settleTaskNotificationDeliveries,
} from '../src/task-notification.js';

function payload(targetJid: string) {
  return {
    kind: 'im_message' as const,
    targetJid,
    text: 'scheduled output',
    localImagePaths: [],
  };
}

describe('scheduled task physical delivery receipts', () => {
  test('internal image failure becomes exact durable image retry work', () => {
    const failed = buildFailedTaskImageNotification({
      targetJids: ['feishu:source', 'tg:owner', 'feishu:source'],
      workspaceFolder: 'workspace',
      filePath: 'artifacts/chart.png',
      mimeType: 'image/png',
      caption: 'chart',
      fileName: 'chart.png',
      error: new Error('database unavailable'),
      getChannel: (jid) => jid.split(':')[0] || null,
    });

    expect(failed).toEqual({
      receipt: {
        status: 'failed',
        summary: {
          attempted: 2,
          succeeded: 0,
          failed: 2,
          failed_channels: ['feishu', 'tg'],
        },
        error: 'database unavailable',
      },
      payload: {
        kind: 'batch',
        items: [
          expect.objectContaining({
            kind: 'im_image',
            targetJid: 'feishu:source',
            filePath: 'artifacts/chart.png',
          }),
          expect.objectContaining({
            kind: 'im_image',
            targetJid: 'tg:owner',
            filePath: 'artifacts/chart.png',
          }),
        ],
      },
    });
    expect(
      buildFailedTaskImageNotification({
        targetJids: ['feishu:source'],
        workspaceFolder: 'workspace',
        filePath: '',
        mimeType: 'image/png',
        error: 'missing source',
        getChannel: () => 'feishu',
      }),
    ).toBeUndefined();
  });

  test('resolved false is a failed ACK and becomes notification-only retry', async () => {
    const direct = vi.fn(async () => false);
    const result = await settleTaskNotificationDeliveries([
      {
        channel: 'feishu',
        payload: payload('feishu:direct'),
        deliver: direct,
      },
    ]);

    expect(direct).toHaveBeenCalledOnce();
    expect(result.receipt).toMatchObject({
      status: 'failed',
      summary: {
        attempted: 1,
        succeeded: 0,
        failed: 1,
        failed_channels: ['feishu'],
      },
    });
    expect(result.retryPayload).toEqual(payload('feishu:direct'));
  });

  test('aggregates delayed success and failure without acknowledging early', async () => {
    let finishDelayed!: (value: boolean) => void;
    const delayed = new Promise<boolean>((resolve) => {
      finishDelayed = resolve;
    });
    let settled = false;
    const pending = settleTaskNotificationDeliveries([
      {
        channel: 'feishu',
        payload: payload('feishu:ok'),
        deliver: () => delayed,
      },
      {
        channel: 'telegram',
        payload: payload('telegram:failed'),
        deliver: async () => false,
      },
    ]).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    finishDelayed(true);
    const result = await pending;
    expect(result.receipt).toMatchObject({
      status: 'partial_failed',
      summary: {
        attempted: 2,
        succeeded: 1,
        failed: 1,
        failed_channels: ['telegram'],
      },
    });
    expect(result.retryPayload).toEqual(payload('telegram:failed'));
  });

  test('no required channel is explicitly skipped', async () => {
    await expect(settleTaskNotificationDeliveries([])).resolves.toEqual({
      receipt: {
        status: 'skipped',
        summary: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          failed_channels: [],
        },
      },
    });
  });
});
