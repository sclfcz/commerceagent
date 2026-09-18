import {
  claimStreamingCardRecovery,
  finalizeStreamingCardRecord,
  getChannelTurnRun,
  getStreamingCardRecord,
  interruptChannelTurnRunById,
  manualReconciliationError,
  interruptChannelTurnRunsWithDeliveredEffects,
  interruptExpiredChannelTurnRuns,
  listAllNonterminalStreamingCards,
  releaseStreamingCardRecovery,
  type StreamingCardRecord,
} from './channel-reliability-store.js';
import { logger } from './logger.js';

export interface StreamingCardReconciler {
  reconcileStreamingCard(record: StreamingCardRecord): Promise<{
    version: number;
    method: 'cardkit' | 'message_patch';
  }>;
}

interface ReconciliationPassOptions {
  /** Startup may fence every row present before inbound is resumed. */
  mode: 'startup' | 'live';
  /** Live passes are restricted to the boot backlog, never current work. */
  createdBefore?: string;
}

const MISSING_PROVIDER_IDENTITY_ERROR = manualReconciliationError(
  'Streaming card creation was interrupted before provider identity was persisted; manual reconciliation required',
);

async function reconcileChannelReliabilityPass(
  reconciler: StreamingCardReconciler,
  options: ReconciliationPassOptions,
): Promise<{ reconciled: number; deferred: number; interruptedTurns: number }> {
  const cards = listAllNonterminalStreamingCards(1_000);
  let reconciled = 0;
  let deferred = 0;
  const fencedTurnIds = new Set<string>();
  const now = new Date().toISOString();

  for (const card of cards) {
    if (card.provider !== 'feishu') {
      deferred++;
      continue;
    }
    const turn = getChannelTurnRun(card.turnRunId);
    const hasActiveLease =
      turn !== undefined &&
      ['running', 'finalizing'].includes(turn.status) &&
      turn.leaseOwner !== null &&
      turn.leaseExpiresAt !== null &&
      turn.leaseExpiresAt > now;
    if (hasActiveLease) {
      // Another process may still be serving this Turn. Both startup and live
      // recovery must honor the durable lease; a dead owner is reclaimed once
      // the bounded lease expires.
      if (options.mode === 'startup') deferred++;
      continue;
    }
    if (options.mode === 'live') {
      // The periodic account-ready/reaper pass only owns rows which existed
      // before live inbound resumed. Without this boot epoch fence, a normal
      // 30s+ response would be aborted by the 15s recovery timer.
      if (options.createdBefore && card.createdAt > options.createdBefore) {
        continue;
      }
    }
    const claimed = claimStreamingCardRecovery(card.id, card.revision);
    if (!claimed) {
      const current = getStreamingCardRecord(card.id);
      if (
        current &&
        !['completed', 'aborted', 'failed'].includes(current.status)
      ) {
        deferred++;
      }
      continue;
    }
    if (!claimed.messageId && !claimed.cardId) {
      const final = finalizeStreamingCardRecord(claimed.id, claimed.revision, {
        status: 'failed',
        snapshot: {
          ...(claimed.snapshot && typeof claimed.snapshot === 'object'
            ? claimed.snapshot
            : {}),
          recovery: {
            reason: 'missing_provider_identity',
            method: 'manual_reconciliation',
          },
        },
        error: MISSING_PROVIDER_IDENTITY_ERROR,
      });
      if (!final) {
        deferred++;
        logger.error(
          {
            cardId: claimed.id,
            accountId: claimed.accountId,
            sourceJid: claimed.sourceJid,
            turnRunId: claimed.turnRunId,
          },
          'Could not persist the missing-provider-identity recovery fence',
        );
        continue;
      }
      if (
        interruptChannelTurnRunById(
          claimed.turnRunId,
          MISSING_PROVIDER_IDENTITY_ERROR,
        )
      ) {
        fencedTurnIds.add(claimed.turnRunId);
      }
      reconciled++;
      logger.error(
        {
          cardId: claimed.id,
          accountId: claimed.accountId,
          sourceJid: claimed.sourceJid,
          turnRunId: claimed.turnRunId,
        },
        'Streaming card has no durable provider identity; fenced for manual reconciliation',
      );
      continue;
    }
    try {
      const result = await reconciler.reconcileStreamingCard(claimed);
      const final = finalizeStreamingCardRecord(claimed.id, claimed.revision, {
        status: 'aborted',
        version: result.version,
        snapshot: {
          ...(claimed.snapshot && typeof claimed.snapshot === 'object'
            ? claimed.snapshot
            : {}),
          recovery: {
            reason: 'process_interrupted',
            method: result.method,
          },
        },
        error: 'Process interrupted before the card reached a terminal state',
      });
      if (!final) {
        throw new Error('Streaming card recovery fence was lost');
      }
      if (
        interruptChannelTurnRunById(
          claimed.turnRunId,
          'Process restarted before the streaming card reached a terminal state',
        )
      ) {
        fencedTurnIds.add(claimed.turnRunId);
      }
      reconciled++;
    } catch (error) {
      deferred++;
      const message = error instanceof Error ? error.message : String(error);
      const current = getStreamingCardRecord(claimed.id);
      if (current?.status === 'recovering') {
        releaseStreamingCardRecovery(
          current.id,
          current.revision,
          `Deferred recovery: ${message}`,
        );
      }
      logger.warn(
        {
          err: error,
          cardId: claimed.id,
          accountId: claimed.accountId,
          sourceJid: claimed.sourceJid,
        },
        'Deferred interrupted streaming card until its exact Bot is ready',
      );
    }
  }

  // Startup closes crash-after-ACK windows only after any competing execution
  // lease expires. Never run this bulk fence in the live timer: a healthy Turn
  // briefly has a delivered effect before its own completion transaction.
  const deliveredEffectTurns =
    options.mode === 'startup'
      ? interruptChannelTurnRunsWithDeliveredEffects()
      : 0;
  const interruptedTurns =
    fencedTurnIds.size +
    deliveredEffectTurns +
    interruptExpiredChannelTurnRuns();
  // The live timer fires every 15s and almost always reconciles nothing;
  // logging each no-op pass at info drowned out real events (87% of all
  // production log records were all-zero lines from this call site).
  const logLevel =
    reconciled > 0 ||
    deferred > 0 ||
    interruptedTurns > 0 ||
    options.mode === 'startup'
      ? ('info' as const)
      : ('debug' as const);
  logger[logLevel](
    { reconciled, deferred, interruptedTurns, mode: options.mode },
    'Channel reliability reconciliation completed',
  );
  return { reconciled, deferred, interruptedTurns };
}

/**
 * Must run after channel accounts are connected and before pending Agent work
 * is recovered. Failed accounts remain non-terminal for the next startup;
 * they are never silently finalized through a different Bot.
 */
export async function reconcileChannelReliabilityOnStartup(
  reconciler: StreamingCardReconciler,
): Promise<{ reconciled: number; deferred: number; interruptedTurns: number }> {
  return reconcileChannelReliabilityPass(reconciler, { mode: 'startup' });
}

/**
 * Re-run reconciliation while the service is live. This closes cards whose
 * exact Bot became ready after startup and reaps execution leases without
 * requiring another process restart. Overlapping ticks are coalesced.
 */
export function startChannelReliabilityRecoveryLoop(
  reconciler: StreamingCardReconciler,
  options: { intervalMs?: number; runImmediately?: boolean } = {},
): { trigger(): Promise<void>; stop(): void } {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 15_000);
  const bootBacklogCutoff = new Date(Date.now() - 1).toISOString();
  let stopped = false;
  let active: Promise<void> | null = null;
  const trigger = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = reconcileChannelReliabilityPass(reconciler, {
      mode: 'live',
      createdBefore: bootBacklogCutoff,
    })
      .then(() => undefined)
      .catch((error) => {
        logger.error(
          { err: error },
          'Live channel reliability reconciliation pass failed',
        );
      })
      .finally(() => {
        active = null;
      });
    return active;
  };
  const timer = setInterval(() => void trigger(), intervalMs);
  timer.unref?.();
  if (options.runImmediately) void trigger();
  return {
    trigger,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
