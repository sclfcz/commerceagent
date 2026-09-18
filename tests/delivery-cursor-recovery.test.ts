import { describe, expect, test } from 'vitest';

import {
  DeferredOutOfBandCursorLedger,
  hasEarlierCursorMessage,
  hasUncoveredCursorMessageThrough,
} from '../src/delivery-cursor.js';
import type { MessageCursor } from '../src/types.js';

function after(candidate: MessageCursor, base: MessageCursor): boolean {
  return (
    candidate.timestamp > base.timestamp ||
    (candidate.timestamp === base.timestamp && candidate.id > base.id)
  );
}

describe('out-of-band completion vs unacknowledged IPC cursor', () => {
  test('later reply-only completion cannot hide earlier accepted delivery on crash', () => {
    const t0 = { timestamp: '2026-07-10T00:00:00.000Z', id: 'm0' };
    const d1 = { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' };
    const d2 = { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' };
    const dbMessages = [d1, d2];

    // d1 was accepted by IPC: next-pull moved, committed stayed at t0.
    let nextPull = d1;
    let committed = t0;

    // A later /cmd is answered out-of-band. Production's single chokepoint
    // sees d1 before d2 and therefore advances next-pull only.
    expect(hasEarlierCursorMessage(dbMessages, d2)).toBe(true);
    nextPull = after(nextPull, d2) ? nextPull : d2;
    expect(committed).toEqual(t0);

    // Runner crashes with d1 unacknowledged: startup/exit recovery rewinds to
    // committed, and DB replay necessarily includes d1 (and may include d2;
    // at-least-once duplicates are preferable to loss).
    nextPull = committed;
    const replay = dbMessages.filter((message) => after(message, nextPull));
    expect(replay.map((message) => message.id)).toEqual(['m1', 'm2']);
  });

  test('reply-only completion commits when it is the oldest pending item', () => {
    const reply = { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' };
    expect(hasEarlierCursorMessage([reply], reply)).toBe(false);
  });

  test('ordered multi-message drop commits the whole batch without a gap', () => {
    const t0 = { timestamp: '2026-07-10T00:00:00.000Z', id: 'm0' };
    const m1 = { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' };
    const m2 = { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' };
    const dbMessages = [m1, m2];
    let committed = t0;
    for (const message of dbMessages) {
      const pending = dbMessages.filter((item) => after(item, committed));
      expect(hasEarlierCursorMessage(pending, message)).toBe(false);
      committed = message;
    }
    expect(committed).toEqual(m2);
  });

  test('exact batch membership permits its prefix but rejects a cursor-range gap', () => {
    const m1 = { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' };
    const m2 = { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' };
    const m3 = { timestamp: '2026-07-10T00:00:03.000Z', id: 'm3' };

    expect(hasUncoveredCursorMessageThrough([m1, m2], m2, [m1, m2])).toBe(
      false,
    );
    expect(hasUncoveredCursorMessageThrough([m1, m2, m3], m3, [m1, m3])).toBe(
      true,
    );
  });

  test('acknowledging the gap flushes deferred replies through the durable cursor', () => {
    const t0 = { timestamp: '2026-07-10T00:00:00.000Z', id: 'm0' };
    const d1 = { timestamp: '2026-07-10T00:00:01.000Z', id: 'm1' };
    const d2 = { timestamp: '2026-07-10T00:00:02.000Z', id: 'm2' };
    const d3 = { timestamp: '2026-07-10T00:00:03.000Z', id: 'm3' };
    const dbMessages = [d1, d2, d3];
    const deferred = new DeferredOutOfBandCursorLedger();
    let committed = t0;
    const hasEarlier = (candidate: MessageCursor) =>
      hasEarlierCursorMessage(
        dbMessages.filter((message) => after(message, committed)),
        candidate,
      );
    const commit = (cursor: MessageCursor) => {
      committed = after(committed, cursor) ? committed : cursor;
    };

    deferred.defer('web:main', d2);
    deferred.defer('web:main', d3);
    expect(deferred.flush('web:main', hasEarlier, commit)).toEqual([]);

    // d1's healthy receipt closes the gap. Both already-delivered direct
    // completions become contiguous and are committed without a restart.
    commit(d1);
    expect(deferred.flush('web:main', hasEarlier, commit)).toEqual([d2, d3]);
    expect(committed).toEqual(d3);
    expect(dbMessages.filter((message) => after(message, committed))).toEqual(
      [],
    );
  });
});
