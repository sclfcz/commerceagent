import type { Redis } from 'ioredis';

export type AdmissionFailMode = 'open' | 'closed';

const SLOT_KEY_PREFIX = 'dist:slots:';

/**
 * Acquire one slot for `runId`.
 *
 * Expired members are removed *before* the capacity check, so a crashed worker
 * never leaks a slot permanently: the next acquirer of that tenant pays for the
 * cleanup. This is the whole anti-leak mechanism — no janitor process needed.
 *
 * Returns 1 when the run owns a slot (also when it already did), 0 when the
 * tenant is at its limit.
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local runId = ARGV[1]
local limit = tonumber(ARGV[2])
local leaseMs = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
local existing = redis.call('ZSCORE', key, runId)
if existing then
  redis.call('ZADD', key, nowMs + leaseMs, runId)
  redis.call('PEXPIRE', key, leaseMs * 10)
  return 1
end
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, nowMs + leaseMs, runId)
  redis.call('PEXPIRE', key, leaseMs * 10)
  return 1
end
redis.call('PEXPIRE', key, leaseMs * 10)
return 0
`;

/**
 * Extend an existing slot. Returns 0 when the run no longer owns one, which the
 * worker treats as "the slot expired / someone else may hold the tenant".
 */
const RENEW_LUA = `
local key = KEYS[1]
local runId = ARGV[1]
local leaseMs = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local score = redis.call('ZSCORE', key, runId)
if not score then
  return 0
end
-- An expired slot is logically gone: capacity may already have been handed to
-- another run, so renewing it would be a resurrection. Treat it as lost.
if tonumber(score) <= nowMs then
  redis.call('ZREM', key, runId)
  return 0
end
redis.call('ZADD', key, nowMs + leaseMs, runId)
redis.call('PEXPIRE', key, leaseMs * 10)
return 1
`;

/** Live usage: expired members are excluded before counting. */
const USAGE_LUA = `
local key = KEYS[1]
local nowMs = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
return redis.call('ZCARD', key)
`;

export interface TenantSlotsOptions {
  redis: Redis;
  /** Lease duration; slots expire at the same deadline as the run's lease. */
  leaseMs: number;
  /** Per-tenant limit. 0 disables admission control entirely. */
  limit: number;
  failMode: AdmissionFailMode;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
  /** Per-tenant override hook (reserved for per-tenant configuration). */
  limitFor?: (tenantId: string) => number;
}

/**
 * Per-tenant concurrency slots backed by a Redis ZSET per tenant.
 *
 * Member = runId, score = absolute expiry (ms epoch). MySQL still owns run
 * state; these slots only decide whether a run may start right now.
 */
export class TenantSlots {
  private readonly redis: Redis;
  private readonly leaseMs: number;
  private readonly failMode: AdmissionFailMode;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly now: () => number;
  private readonly limitFor: (tenantId: string) => number;
  private readonly configuredLimit: number;
  private lastDegradedLogAt = 0;

  constructor(options: TenantSlotsOptions) {
    this.redis = options.redis;
    this.leaseMs = options.leaseMs;
    this.failMode = options.failMode;
    this.logger = options.logger ?? (() => {});
    this.now = options.now ?? Date.now;
    this.configuredLimit = options.limit;
    this.limitFor = options.limitFor ?? (() => options.limit);
  }

  /** True when admission control is active (DIST_TENANT_CONCURRENCY > 0). */
  get enabled(): boolean {
    return this.configuredLimit > 0;
  }

  private key(tenantId: string): string {
    return `${SLOT_KEY_PREFIX}${tenantId}`;
  }

  /** Log at most once every 5s so a dead Redis does not flood the log. */
  private reportDegraded(operation: string, error: unknown): void {
    const now = this.now();
    if (now - this.lastDegradedLogAt < 5_000) return;
    this.lastDegradedLogAt = now;
    this.logger({
      event: 'admission_degraded',
      component: 'tenant-slots',
      operation,
      failMode: this.failMode,
      error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }

  async acquire(tenantId: string, runId: string): Promise<boolean> {
    const limit = this.limitFor(tenantId);
    if (limit <= 0) return true;
    try {
      const result = await this.redis.eval(
        ACQUIRE_LUA,
        1,
        this.key(tenantId),
        runId,
        String(limit),
        String(this.leaseMs),
        String(this.now()),
      );
      return Number(result) === 1;
    } catch (error) {
      this.reportDegraded('acquire', error);
      return this.failMode === 'open';
    }
  }

  /** Returns false when the slot is gone (or Redis is down in closed mode). */
  async renew(tenantId: string, runId: string): Promise<boolean> {
    if (this.limitFor(tenantId) <= 0) return true;
    try {
      const result = await this.redis.eval(
        RENEW_LUA,
        1,
        this.key(tenantId),
        runId,
        String(this.leaseMs),
        String(this.now()),
      );
      return Number(result) === 1;
    } catch (error) {
      this.reportDegraded('renew', error);
      return this.failMode === 'open';
    }
  }

  /** Best effort: the slot also expires on its own. */
  async release(tenantId: string, runId: string): Promise<void> {
    if (this.limitFor(tenantId) <= 0) return;
    try {
      await this.redis.zrem(this.key(tenantId), runId);
    } catch (error) {
      this.reportDegraded('release', error);
    }
  }

  async usage(tenantId: string): Promise<number> {
    try {
      const result = await this.redis.eval(
        USAGE_LUA,
        1,
        this.key(tenantId),
        String(this.now()),
      );
      return Number(result);
    } catch (error) {
      this.reportDegraded('usage', error);
      return 0;
    }
  }

  /** Test/ops helper: force a slot's expiry into the past. */
  async expireNow(tenantId: string, runId: string): Promise<void> {
    await this.redis.zadd(this.key(tenantId), this.now() - 1, runId);
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* already closed */
    }
  }
}
