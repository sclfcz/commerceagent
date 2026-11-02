import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';

/**
 * Shared Redis client factory.
 *
 * Admission control must fail fast rather than queue commands behind a dead
 * connection: `enableOfflineQueue: false` makes every command reject while
 * disconnected, which is exactly what DIST_ADMISSION_FAIL_MODE needs to see.
 */
export function createRedis(
  url: string,
  overrides: Partial<RedisOptions> = {},
): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    // Bounded reconnect backoff: without a cap a restarted Redis can leave a
    // client waiting seconds before it retries, which shows up directly in the
    // IM ownership recovery time (lease + renew + ~500ms upper bound).
    retryStrategy: (times) => Math.min(times * 100, 500),
    // Fail the first handshake quickly: a stopped Redis otherwise holds the
    // reconnect attempt for the OS TCP timeout, which dominates recovery.
    connectTimeout: 1_000,
    ...overrides,
  });
}

/** A client that rejects immediately when Redis is unreachable (tests). */
export function createStrictRedis(
  url: string,
  overrides: Partial<RedisOptions> = {},
): Redis {
  return new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
    connectTimeout: 500,
    ...overrides,
  });
}
