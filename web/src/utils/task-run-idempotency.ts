const STORAGE_PREFIX = 'happyclaw:task-run-idempotency:';
const PENDING_KEY_TTL_MS = 24 * 60 * 60 * 1000;

interface PendingRunKey {
  key: string;
  createdAt: number;
}

const memoryFallback = new Map<string, Record<string, PendingRunKey>>();

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeEntries(
  value: unknown,
  now: number,
): { entries: Record<string, PendingRunKey>; changed: boolean } {
  const entries: Record<string, PendingRunKey> = Object.create(null);
  if (!isPlainObject(value)) return { entries, changed: true };

  let changed = false;
  for (const [taskId, candidate] of Object.entries(value)) {
    if (
      !taskId.trim() ||
      !isPlainObject(candidate) ||
      typeof candidate.key !== 'string' ||
      !candidate.key.trim() ||
      typeof candidate.createdAt !== 'number' ||
      !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt < 0 ||
      candidate.createdAt > now ||
      now - candidate.createdAt >= PENDING_KEY_TTL_MS
    ) {
      changed = true;
      continue;
    }
    entries[taskId] = {
      key: candidate.key,
      createdAt: candidate.createdAt,
    };
  }
  return { entries, changed };
}

function readEntries(
  userId: string,
  now: number,
): Record<string, PendingRunKey> {
  const key = storageKey(userId);
  let raw: string | null | undefined;
  try {
    raw = globalThis.localStorage?.getItem(key);
  } catch {
    // Private browsing / quota failures fall back to process memory.
    const sanitized = sanitizeEntries(memoryFallback.get(key) ?? {}, now);
    if (sanitized.changed) writeEntries(userId, sanitized.entries);
    return sanitized.entries;
  }

  if (raw !== null && raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const entries: Record<string, PendingRunKey> = Object.create(null);
      writeEntries(userId, entries);
      return entries;
    }
    const sanitized = sanitizeEntries(parsed, now);
    if (sanitized.changed) {
      writeEntries(userId, sanitized.entries);
    } else {
      memoryFallback.set(key, { ...sanitized.entries });
    }
    return sanitized.entries;
  }

  const sanitized = sanitizeEntries(memoryFallback.get(key) ?? {}, now);
  if (sanitized.changed) writeEntries(userId, sanitized.entries);
  return sanitized.entries;
}

function writeEntries(
  userId: string,
  entries: Record<string, PendingRunKey>,
): void {
  const key = storageKey(userId);
  memoryFallback.set(key, { ...entries });
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(entries));
  } catch {
    // Memory fallback still preserves retries for this page lifetime.
  }
}

/** Reuse an unacknowledged Run Now key across renders and page reloads. */
export function getPendingTaskRunKey(
  userId: string,
  taskId: string,
  now = Date.now(),
): string {
  const entries = readEntries(userId, now);
  const existing = entries[taskId];
  if (existing) {
    writeEntries(userId, entries);
    return existing.key;
  }
  const key = crypto.randomUUID();
  entries[taskId] = { key, createdAt: now };
  writeEntries(userId, entries);
  return key;
}

export function acknowledgeTaskRunKey(
  userId: string,
  taskId: string,
  key: string,
): void {
  const entries = readEntries(userId, Date.now());
  if (entries[taskId]?.key !== key) return;
  delete entries[taskId];
  writeEntries(userId, entries);
}

export function clearTaskRunKeysForTest(): void {
  memoryFallback.clear();
}
