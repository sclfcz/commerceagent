import type {
  TaskRunAtomicNotificationPayload,
  TaskRunNotificationPayload,
  TaskRunNotificationReceipt,
} from './db.js';

export interface TaskNotificationDeliveryAttempt {
  channel: string;
  payload: TaskRunAtomicNotificationPayload;
  deliver: () => Promise<boolean>;
}

/** Build durable retry work when image IPC processing fails before delivery
 * has been safely settled. The original workspace image remains the source of
 * truth; the retry payload stores only a workspace-relative path. */
export function buildFailedTaskImageNotification(input: {
  targetJids: string[];
  workspaceFolder: string;
  filePath: string;
  mimeType: string;
  caption?: string;
  fileName?: string;
  error: unknown;
  getChannel: (jid: string) => string | null;
}):
  | {
      receipt: TaskRunNotificationReceipt;
      payload: TaskRunNotificationPayload;
    }
  | undefined {
  const targets = [...new Set(input.targetJids)];
  if (targets.length === 0 || !input.filePath) return undefined;
  const items = targets.map(
    (targetJid): TaskRunAtomicNotificationPayload => ({
      kind: 'im_image',
      targetJid,
      workspaceFolder: input.workspaceFolder,
      filePath: input.filePath,
      mimeType: input.mimeType,
      caption: input.caption,
      fileName: input.fileName,
    }),
  );
  const channels = [
    ...new Set(targets.map((jid) => input.getChannel(jid) ?? jid)),
  ];
  return {
    receipt: {
      status: 'failed',
      summary: {
        attempted: targets.length,
        succeeded: 0,
        failed: targets.length,
        failed_channels: channels,
      },
      error:
        input.error instanceof Error
          ? input.error.message
          : String(input.error),
    },
    payload: items.length === 1 ? items[0] : { kind: 'batch', items: items },
  };
}

/**
 * Settle required scheduled-task deliveries using explicit boolean ACKs.
 * A resolved `false` is a failure (not an acknowledgement); only failed
 * concrete payloads are returned for notification-only retry.
 */
export async function settleTaskNotificationDeliveries(
  attempts: TaskNotificationDeliveryAttempt[],
): Promise<{
  receipt: TaskRunNotificationReceipt;
  retryPayload?: TaskRunNotificationPayload;
}> {
  if (attempts.length === 0) {
    return {
      receipt: {
        status: 'skipped',
        summary: {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          failed_channels: [],
        },
      },
    };
  }

  const outcomes = await Promise.all(
    attempts.map(async (attempt) => {
      try {
        return { attempt, success: (await attempt.deliver()) === true };
      } catch (error) {
        return { attempt, success: false, error };
      }
    }),
  );
  const failed = outcomes.filter((outcome) => !outcome.success);
  const failedChannels = [
    ...new Set(failed.map((outcome) => outcome.attempt.channel)),
  ];
  const succeeded = outcomes.length - failed.length;
  const failedPayloads = failed.map((outcome) => outcome.attempt.payload);
  const retryPayload =
    failedPayloads.length === 0
      ? undefined
      : failedPayloads.length === 1
        ? failedPayloads[0]
        : ({ kind: 'batch', items: failedPayloads } as const);
  const errorMessages = failed
    .map((outcome) =>
      'error' in outcome
        ? outcome.error instanceof Error
          ? outcome.error.message
          : String(outcome.error)
        : null,
    )
    .filter(Boolean);

  return {
    receipt: {
      status:
        failed.length === 0
          ? 'success'
          : succeeded > 0
            ? 'partial_failed'
            : 'failed',
      summary: {
        attempted: outcomes.length,
        succeeded,
        failed: failed.length,
        failed_channels: failedChannels,
      },
      error:
        failed.length > 0
          ? errorMessages.join('; ') ||
            `Notification delivery failed: ${failedChannels.join(', ')}`
          : null,
    },
    retryPayload,
  };
}
