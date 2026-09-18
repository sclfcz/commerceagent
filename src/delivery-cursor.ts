import type { MessageCursor } from './types.js';

export interface CursorOrderedMessage {
  timestamp: string;
  id: string;
}

/** True when DB recovery still contains work ordered before an out-of-band
 * candidate. Such a candidate may advance next-pull but must not advance the
 * durable committed cursor. */
export function hasEarlierCursorMessage(
  pending: CursorOrderedMessage[],
  candidate: MessageCursor,
): boolean {
  return pending.some((message) => {
    if (message.timestamp < candidate.timestamp) return true;
    return (
      message.timestamp === candidate.timestamp && message.id < candidate.id
    );
  });
}

function cursorKey(cursor: CursorOrderedMessage): string {
  return `${cursor.timestamp}\u0000${cursor.id}`;
}

/** True when committing an IPC batch to `terminal` would cross a DB message
 * that the batch did not actually cover. Exact membership matters: using only
 * the terminal cursor mistakes earlier members of the same batch for gaps,
 * while using only a range could skip a concurrently inserted message. */
export function hasUncoveredCursorMessageThrough(
  pending: CursorOrderedMessage[],
  terminal: MessageCursor,
  covered: CursorOrderedMessage[],
): boolean {
  const coveredKeys = new Set(covered.map(cursorKey));
  return pending.some((message) => {
    const isThroughTerminal =
      message.timestamp < terminal.timestamp ||
      (message.timestamp === terminal.timestamp && message.id <= terminal.id);
    return isThroughTerminal && !coveredKeys.has(cursorKey(message));
  });
}

export class DeferredOutOfBandCursorLedger {
  private readonly entries = new Map<string, MessageCursor[]>();

  defer(jid: string, cursor: MessageCursor): void {
    const cursors = this.entries.get(jid) ?? [];
    if (
      !cursors.some(
        (item) => item.timestamp === cursor.timestamp && item.id === cursor.id,
      )
    ) {
      cursors.push(cursor);
      cursors.sort((a, b) =>
        a.timestamp === b.timestamp
          ? a.id.localeCompare(b.id)
          : a.timestamp.localeCompare(b.timestamp),
      );
      this.entries.set(jid, cursors);
    }
  }

  /** Flush every now-contiguous direct completion. The callbacks keep this
   * class persistence-agnostic; a crash merely forgets deferred entries and
   * safely replays them from DB. */
  flush(
    jid: string,
    hasEarlier: (cursor: MessageCursor) => boolean,
    commit: (cursor: MessageCursor) => void,
  ): MessageCursor[] {
    const cursors = this.entries.get(jid);
    if (!cursors) return [];
    const committed: MessageCursor[] = [];
    while (cursors.length > 0 && !hasEarlier(cursors[0])) {
      const cursor = cursors.shift()!;
      commit(cursor);
      committed.push(cursor);
    }
    if (cursors.length === 0) this.entries.delete(jid);
    return committed;
  }
}

export function shouldRecoverPendingHistory(
  hasCommittedCursor: boolean,
  pullWasAhead: boolean,
  foundTypedDeliveryFile: boolean,
): boolean {
  return hasCommittedCursor || pullWasAhead || foundTypedDeliveryFile;
}
