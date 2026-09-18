import type { User } from './types.js';

const revokingHostPrivilegeUserIds = new Set<string>();

export function beginHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.add(userId);
}

export function endHostPrivilegeRevocation(userId: string): void {
  revokingHostPrivilegeUserIds.delete(userId);
}

/**
 * Host execution is a live privilege, not a property inherited forever from
 * a workspace row. Callers must resolve the user from the database at the
 * point of execution and pass that current record here.
 */
export function canExecuteOnHost(
  owner: (Pick<User, 'role' | 'status'> & { id?: string }) | null | undefined,
): boolean {
  return (
    owner?.role === 'admin' &&
    owner.status === 'active' &&
    (!owner.id || !revokingHostPrivilegeUserIds.has(owner.id))
  );
}

export const HOST_EXECUTION_FORBIDDEN_ERROR =
  'Host execution requires a currently active administrator owner';
