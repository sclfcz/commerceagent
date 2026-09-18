import { afterEach, describe, expect, it, vi } from 'vitest';

import { SteeringTransitionRegistry } from '../src/steering-transition.js';

describe('SteeringTransitionRegistry', () => {
  afterEach(() => vi.useRealTimers());

  it('suppresses old-turn output while steer acknowledgement is pending', () => {
    const registry = new SteeringTransitionRegistry();
    registry.mark('web:chat');

    expect(registry.shouldSuppressOutput('web:chat')).toBe(true);
    expect(registry.shouldSuppressOutput('web:chat', 'old-turn')).toBe(true);
  });

  it('keeps the interrupted turn suppressed but allows the steered turn', () => {
    const registry = new SteeringTransitionRegistry();
    registry.mark('web:chat');

    expect(registry.resolveInterrupted('web:chat', 'old-turn')).toBe(true);
    expect(registry.shouldSuppressOutput('web:chat', 'old-turn')).toBe(true);
    expect(registry.shouldSuppressOutput('web:chat', 'new-turn')).toBe(false);
    expect(registry.resolveInterrupted('web:chat', 'old-turn')).toBe(false);
  });

  it('does not treat an explicit stop as a steer', () => {
    const registry = new SteeringTransitionRegistry();

    expect(registry.resolveInterrupted('web:chat', 'old-turn')).toBe(false);
    expect(registry.shouldSuppressOutput('web:chat', 'old-turn')).toBe(false);
  });

  it('expires abandoned transition state', () => {
    vi.useFakeTimers();
    const registry = new SteeringTransitionRegistry(1_000);
    registry.mark('web:chat');

    vi.advanceTimersByTime(1_001);

    expect(registry.shouldSuppressOutput('web:chat', 'old-turn')).toBe(false);
  });
});
