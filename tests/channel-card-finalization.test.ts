import { describe, expect, test, vi } from 'vitest';

import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

describe('channel card physical finalization', () => {
  test('completes exactly once after attachment delivery is acknowledged', async () => {
    const card = {
      complete: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };

    const result = await finalizeChannelCardAfterDelivery(
      card,
      'final answer',
      true,
      'retry',
    );

    expect(result.acknowledged).toBe(true);
    expect(card.complete).toHaveBeenCalledTimes(1);
    expect(card.complete).toHaveBeenCalledWith('final answer');
    expect(card.abort).not.toHaveBeenCalled();
  });

  test('a provider rejection is not an ACK and falls back to a terminal abort', async () => {
    const rejection = new Error('provider rejected final update');
    const card = {
      complete: vi.fn(async () => {
        throw rejection;
      }),
      abort: vi.fn(async () => {}),
    };

    const result = await finalizeChannelCardAfterDelivery(
      card,
      'final answer',
      true,
      'retry',
    );

    expect(result).toEqual({ acknowledged: false, error: rejection });
    expect(card.complete).toHaveBeenCalledTimes(1);
    expect(card.abort).toHaveBeenCalledTimes(1);
  });

  test('missing attachment ACK never attempts provider completion', async () => {
    const card = {
      complete: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };

    const result = await finalizeChannelCardAfterDelivery(
      card,
      'final answer',
      false,
      'attachment retry',
    );

    expect(result.acknowledged).toBe(false);
    expect(card.complete).not.toHaveBeenCalled();
    expect(card.abort).toHaveBeenCalledWith('attachment retry');
  });
});
