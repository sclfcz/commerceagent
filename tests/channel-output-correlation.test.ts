import { describe, expect, test } from 'vitest';

import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';

describe('host channel output correlation', () => {
  test('slow A output remains owned by A after B is admitted', () => {
    const cold = 'host-turn';
    const admittedB = 'delivery-b';

    expect(
      resolveContainerOutputInputTurnId({ inputTurnId: 'delivery-a' }, cold),
    ).toBe('delivery-a');
    // Admission itself does not mutate output identity. A's later delta/final
    // still carry A even though B now exists in the host reservation maps.
    expect(admittedB).toBe('delivery-b');
    expect(
      resolveContainerOutputInputTurnId(
        {
          inputTurnId: 'delivery-a',
          ipcReceipts: [{ deliveryId: 'delivery-a' }],
        },
        cold,
      ),
    ).toBe('delivery-a');
    expect(
      resolveContainerOutputInputTurnId({ inputTurnId: admittedB }, cold),
    ).toBe('delivery-b');
  });

  test('legacy output falls back to its receipt, then the cold host turn', () => {
    expect(
      resolveContainerOutputInputTurnId(
        { ipcReceipts: [{ deliveryId: 'receipt-a' }] },
        'cold-a',
      ),
    ).toBe('receipt-a');
    expect(resolveContainerOutputInputTurnId({}, 'cold-a')).toBe('cold-a');
  });
});
