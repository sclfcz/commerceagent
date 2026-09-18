import { describe, expect, test } from 'vitest';
import {
  beginHostPrivilegeRevocation,
  canExecuteOnHost,
  endHostPrivilegeRevocation,
} from '../src/host-execution-policy.js';

describe('host execution live authorization', () => {
  test('allows only an active administrator', () => {
    expect(canExecuteOnHost({ role: 'admin', status: 'active' })).toBe(true);
    expect(canExecuteOnHost({ role: 'member', status: 'active' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'disabled' })).toBe(false);
    expect(canExecuteOnHost({ role: 'admin', status: 'deleted' })).toBe(false);
    expect(canExecuteOnHost(undefined)).toBe(false);
  });

  test('fails closed while an administrator revocation is in flight', () => {
    const owner = {
      id: 'admin-1',
      role: 'admin' as const,
      status: 'active' as const,
    };
    beginHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(false);
    endHostPrivilegeRevocation(owner.id);
    expect(canExecuteOnHost(owner)).toBe(true);
  });
});
