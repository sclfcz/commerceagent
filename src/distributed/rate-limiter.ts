import type { Redis } from 'ioredis';
import type { AdmissionFailMode } from './tenant-slots.js';

/**
 * Classic token bucket, atomic in Lua.
 *
 * KEYS[1] = bucket key, stored as a hash {tokens, lastRefillMs}.
 * Refill uses the caller-supplied clock (`nowMs`) so tests can advance time
 * deterministically instead of sleeping.
 *
 * Returns {allowed, tokens, retryAfterMs} with the numbers encoded as strings
 * so Lua's integer conversion cannot truncate fractional tokens.
 */
const TRY_ACQUIRE_LUA = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

local state = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
local tokens = tonumber(state[1])
local lastRefill = tonumber(state[2])
if tokens == nil or lastRefill == nil then
  tokens = burst
  lastRefill = nowMs
end
local elapsed = nowMs - lastRefill
if elapsed < 0 then elapsed = 0 end
tokens = tokens + (elapsed / 1000) * rate
if tokens > burst then tokens = burst end

local allowed = 0
local retryAfterMs = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retryAfterMs = math.ceil(((cost - tokens) / rate) * 1000)
end
redis.call('HSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(nowMs))
redis.call('PEXPIRE', key, ttlMs)
return {allowed, tostring(tokens), tostring(retryAfterMs)}
`;

export interface TryAcquireResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number | null;
}

export interface TokenBucketOptions {
  redis: Redis;
  failMode: AdmissionFailMode;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
  /** Injectable so tests can advance a fake clock while "sleeping". */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimitTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`rate limit not available within ${waitedMs}ms`);
    this.name = 'RateLimitTimeoutError';
  }
}

export class TokenBucket {
  private readonly redis: Redis;
  private readonly failMode: AdmissionFailMode;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastDegradedLogAt = 0;

  constructor(options: TokenBucketOptions) {
    this.redis = options.redis;
    this.failMode = options.failMode;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private reportDegraded(operation: string, error: unknown): void {
    const now = this.now();
    if (now - this.lastDegradedLogAt < 5_000) return;
    this.lastDegradedLogAt = now;
    this.logger({
      event: 'admission_degraded',
      component: 'rate-limiter',
      operation,
      failMode: this.failMode,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }

  async tryAcquire(
    key: string,
    ratePerSec: number,
    burst: number,
    cost = 1,
  ): Promise<TryAcquireResult> {
    if (!Number.isFinite(ratePerSec) || ratePerSec <= 0)
      throw new Error('ratePerSec must be > 0');
    if (!Number.isFinite(burst) || burst < 1)
      throw new Error('burst must be >= 1');
    const ttlMs = Math.max(1_000, Math.ceil((burst / ratePerSec) * 10_000));
    try {
      const result = (await this.redis.eval(
        TRY_ACQUIRE_LUA,
        1,
        key,
        String(ratePerSec),
        String(burst),
        String(this.now()),
        String(cost),
        String(ttlMs),
      )) as [number | string, string, string];
      const allowed = Number(result[0]) === 1;
      return {
        allowed,
        remaining: Number(result[1]),
        retryAfterMs: allowed ? null : Number(result[2]),
      };
    } catch (error) {
      this.reportDegraded('tryAcquire', error);
      if (this.failMode === 'open')
        return { allowed: true, remaining: 0, retryAfterMs: null };
      return { allowed: false, remaining: 0, retryAfterMs: 1_000 };
    }
  }

  /**
   * Retry until a token is available or `maxWaitMs` elapses.
   * Uses the injected clock for both the bucket and the deadline, so tests can
   * drive time forward through the injected `sleep`.
   */
  async acquireBlocking(
    key: string,
    ratePerSec: number,
    burst: number,
    maxWaitMs: number,
    cost = 1,
  ): Promise<TryAcquireResult> {
    const deadline = this.now() + maxWaitMs;
    for (;;) {
      const result = await this.tryAcquire(key, ratePerSec, burst, cost);
      if (result.allowed) return result;
      const remaining = deadline - this.now();
      if (remaining <= 0) throw new RateLimitTimeoutError(maxWaitMs);
      const wait = Math.max(1, Math.min(result.retryAfterMs ?? 10, remaining));
      await this.sleep(wait);
    }
  }
}
