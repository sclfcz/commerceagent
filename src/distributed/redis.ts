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
