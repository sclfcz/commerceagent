import { describe, expect, test } from 'vitest';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  userCapabilityLockKey,
  withCapabilityScopeLocks,
} from '../src/capability-lock.js';

describe('capability scope lock', () => {
  test('serializes Agent policy validation/commit with a same-user mutation', async () => {
    const events: string[] = [];
    let releasePolicy!: () => void;
    let markPolicyStarted!: () => void;
    const policyGate = new Promise<void>((resolve) => {
      releasePolicy = resolve;
    });
    const policyStarted = new Promise<void>((resolve) => {
      markPolicyStarted = resolve;
    });
    const keys = [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey('owner')];
    const policy = withCapabilityScopeLocks(keys, async () => {
      events.push('policy:validate');
      markPolicyStarted();
      await policyGate;
      events.push('policy:commit');
    });
    await policyStarted;
    const mutation = withCapabilityScopeLocks(
      [userCapabilityLockKey('owner')],
      () => events.push('mutation'),
    );
    expect(events).toEqual(['policy:validate']);
    releasePolicy();
    await Promise.all([policy, mutation]);
    expect(events).toEqual(['policy:validate', 'policy:commit', 'mutation']);
  });

  test('system mutation cannot race any user policy that selects system MCP', async () => {
    const events: string[] = [];
    let releaseSystem!: () => void;
    let markSystemStarted!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSystem = resolve;
    });
    const systemStarted = new Promise<void>((resolve) => {
      markSystemStarted = resolve;
    });
    const mutation = withCapabilityScopeLocks(
      [SYSTEM_CAPABILITY_LOCK_KEY],
      async () => {
        events.push('system:check-references');
        markSystemStarted();
        await gate;
        events.push('system:delete');
      },
    );
    await systemStarted;
    const policy = withCapabilityScopeLocks(
      [SYSTEM_CAPABILITY_LOCK_KEY, userCapabilityLockKey('other-owner')],
      () => events.push('policy:commit'),
    );
    expect(events).toEqual(['system:check-references']);
    releaseSystem();
    await Promise.all([mutation, policy]);
    expect(events).toEqual([
      'system:check-references',
      'system:delete',
      'policy:commit',
    ]);
  });
});
