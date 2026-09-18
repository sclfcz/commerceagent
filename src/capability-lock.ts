type LockState = {
  tail: Promise<void>;
  references: number;
};

const capabilityLocks = new Map<string, LockState>();

export function userCapabilityLockKey(userId: string): string {
  return `user:${userId}`;
}

export const SYSTEM_CAPABILITY_LOCK_KEY = 'system';

async function acquireCapabilityLock(key: string): Promise<() => void> {
  let state = capabilityLocks.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), references: 0 };
    capabilityLocks.set(key, state);
  }
  state.references += 1;
  const previous = state.tail;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  state.tail = previous.then(() => gate);
  await previous;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
    state!.references -= 1;
    if (state!.references === 0 && capabilityLocks.get(key) === state) {
      capabilityLocks.delete(key);
    }
  };
}

/**
 * Serializes Agent policy validation/commit with capability mutations. Keys
 * are acquired lexically so operations spanning system + user scopes cannot
 * deadlock with single-scope mutations.
 */
export async function withCapabilityScopeLocks<T>(
  keys: string[],
  operation: () => Promise<T> | T,
): Promise<T> {
  const ordered = Array.from(new Set(keys)).sort();
  const releases: Array<() => void> = [];
  try {
    for (const key of ordered) releases.push(await acquireCapabilityLock(key));
    return await operation();
  } finally {
    for (let index = releases.length - 1; index >= 0; index -= 1) {
      releases[index]();
    }
  }
}
