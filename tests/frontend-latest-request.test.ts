import { describe, expect, test } from 'vitest';
import {
  createLatestRequestGate,
  isSelectionCurrent,
} from '../web/src/utils/latest-request';

describe('latest async selection request', () => {
  test('only the newest selected skill may commit success, error, or loading state', () => {
    const gate = createLatestRequestGate();
    const first = gate.begin('user:first');
    const second = gate.begin('user:second');

    expect(gate.isCurrent(first, 'user:second')).toBe(false);
    expect(gate.isCurrent(first, 'user:first')).toBe(false);
    expect(gate.isCurrent(second, 'user:second')).toBe(true);

    gate.cancel(first);
    expect(gate.isCurrent(second, 'user:second')).toBe(true);
    gate.cancel(second);
    expect(gate.isCurrent(second, 'user:second')).toBe(false);
  });

  test('selection-bound actions cannot mutate the newly selected skill', () => {
    expect(isSelectionCurrent('user:first', 'user:first')).toBe(true);
    expect(isSelectionCurrent('user:first', 'user:second')).toBe(false);
    expect(isSelectionCurrent('user:first', null)).toBe(false);
  });

  test('invalidating on an empty selection rejects every outstanding request', () => {
    const gate = createLatestRequestGate();
    const request = gate.begin('user:first');
    gate.invalidate();
    expect(gate.isCurrent(request, 'user:first')).toBe(false);
  });
});
