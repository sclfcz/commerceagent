import { describe, expect, test } from 'vitest';

import {
  applyFollowUpTransition,
  getMessageDisplayTimestamp,
  isMessageVisibleInTimeline,
  orderMessagesForTimeline,
  type TimelineMessageLike,
} from '../web/src/lib/message-timeline.js';

type TestMessage = TimelineMessageLike & { content: string };

function message(
  id: string,
  timestamp: string,
  isFromMe: boolean,
  overrides: Partial<TestMessage> = {},
): TestMessage {
  return {
    id,
    content: id,
    timestamp,
    is_from_me: isFromMe,
    ...overrides,
  };
}

describe('Codex-style message timeline', () => {
  test('keeps queued inputs beside the composer until they start', () => {
    for (const deliveryStatus of [
      'queued',
      'promoting',
      'cancelled',
    ] as const) {
      expect(
        isMessageVisibleInTimeline(
          message(`user-${deliveryStatus}`, '2026-07-20T00:00:00.000Z', false, {
            delivery_status: deliveryStatus,
          }),
        ),
      ).toBe(false);
    }

    expect(
      isMessageVisibleInTimeline(
        message('assistant', '2026-07-20T00:00:01.000Z', true),
      ),
    ).toBe(true);
  });

  test('orders three rapid questions as question-answer pairs by release time', () => {
    const messages = [
      message('q1', '2026-07-20T15:14:45.841Z', false),
      message('q2', '2026-07-20T15:14:52.961Z', false, {
        delivery_status: 'released',
        delivery_updated_at: '2026-07-20T15:14:58.527Z',
      }),
      message('q3', '2026-07-20T15:14:57.320Z', false, {
        delivery_status: 'released',
        delivery_updated_at: '2026-07-20T15:16:25.024Z',
      }),
      message('a1', '2026-07-20T15:14:58.524Z', true),
      message('a2', '2026-07-20T15:16:25.022Z', true),
      message('a3', '2026-07-20T15:16:36.421Z', true),
    ];

    expect(orderMessagesForTimeline(messages).map((item) => item.id)).toEqual([
      'q1',
      'a1',
      'q2',
      'a2',
      'q3',
      'a3',
    ]);
    expect(getMessageDisplayTimestamp(messages[1])).toBe(
      '2026-07-20T15:14:58.527Z',
    );
    expect(messages[1].timestamp).toBe('2026-07-20T15:14:52.961Z');
  });

  test('makes a queued message visible only after the release transition', () => {
    const queued = message('q2', '2026-07-20T00:00:01.000Z', false, {
      delivery_status: 'queued',
      delivery_run_id: 'old-run',
      delivery_updated_at: '2026-07-20T00:00:01.000Z',
    });

    expect(orderMessagesForTimeline([queued])).toEqual([]);
    const transitioned = applyFollowUpTransition([queued], {
      id: 'q2',
      delivery_status: 'released',
      delivery_run_id: 'next-run',
      delivery_updated_at: '2026-07-20T00:00:03.000Z',
    });
    expect(orderMessagesForTimeline(transitioned)).toHaveLength(1);
    expect(transitioned[0]).toMatchObject({
      delivery_status: 'released',
      delivery_run_id: 'next-run',
      delivery_updated_at: '2026-07-20T00:00:03.000Z',
    });
  });

  test('keeps ordinary historical messages on their original timestamps', () => {
    const ordinary = message('ordinary', '2026-07-19T23:59:59.000Z', false);
    expect(getMessageDisplayTimestamp(ordinary)).toBe(ordinary.timestamp);
  });
});
