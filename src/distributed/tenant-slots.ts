import type { Redis } from 'ioredis';

export type AdmissionFailMode = 'open' | 'closed';

const SLOT_KEY_PREFIX = 'dist:slots:';
const ACTIVE_KEY = 'dist:slots:active';

/**
 * Acquire one slot for `(runId, leaseToken)`.
 *
 * All time comes from Redis (`TIME`), so worker clock skew cannot affect
 * capacity. Expired members are removed *before* the capacity check, so a
 * crashed worker never leaks a slot: the next acquirer of that tenant pays for
 * the cleanup.
 *
 * Members are `runId:leaseToken`. If the same run shows up with an older token
 * (a fenced-out worker), that stale generation is deleted instead of being
 * counted twice.
 *
 * KEYS: slot key, active-tenant set
 * ARGV: runId, leaseToken, limit, leaseMs, tenantId
 */
const ACQUIRE_LUA = `
local key = KEYS[1]
local activeKey = KEYS[2]
local runId = ARGV[1]
local leaseToken = ARGV[2]
local limit = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local tenantId = ARGV[5]
local member = runId .. ':' .. leaseToken

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
if redis.call('ZSCORE', key, member) then
  redis.call('ZADD', key, nowMs + leaseMs, member)
  redis.call('PEXPIRE', key, leaseMs * 10)
  redis.call('SADD', activeKey, tenantId)
  return 1
end

-- Drop older lease generations of the same run (that owner was fenced out).
local prefix = runId .. ':'
local token = tonumber(leaseToken)
for _, existing in ipairs(redis.call('ZRANGE', key, 0, -1)) do
  if string.sub(existing, 1, #prefix) == prefix then
    local otherToken = tonumber(string.sub(existing, #prefix + 1))
    if otherToken and token and otherToken < token then
      redis.call('ZREM', key, existing)
    end
  end
end

if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, nowMs + leaseMs, member)
  redis.call('PEXPIRE', key, leaseMs * 10)
  redis.call('SADD', activeKey, tenantId)
  return 1
end
redis.call('PEXPIRE', key, leaseMs * 10)
return 0
`;

/**
 * Extend an existing generation. Returns 0 when the member is gone or already
 * expired (an expired slot may have been reused for another run, so renewing it
 * would be a resurrection).
 *
 * ARGV: runId, leaseToken, leaseMs
 */
const RENEW_LUA = `
local key = KEYS[1]
local runId = ARGV[1]
local leaseToken = ARGV[2]
local leaseMs = tonumber(ARGV[3])
local member = runId .. ':' .. leaseToken

local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local score = redis.call('ZSCORE', key, member)
if not score then
  return 0
end
if tonumber(score) <= nowMs then
  redis.call('ZREM', key, member)
  return 0
end
redis.call('ZADD', key, nowMs + leaseMs, member)
redis.call('PEXPIRE', key, leaseMs * 10)
return 1
`;

/** Release only this generation's member. ARGV: runId, leaseToken, tenantId */
const RELEASE_LUA = `
local key = KEYS[1]
local activeKey = KEYS[2]
local member = ARGV[1] .. ':' .. ARGV[2]
redis.call('ZREM', key, member)
if redis.call('ZCARD', key) == 0 then
  redis.call('SREM', activeKey, ARGV[3])
end
return 1
`;

/** Live usage for one tenant (expired members excluded). */
const USAGE_LUA = `
local key = KEYS[1]
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
return redis.call('ZCARD', key)
`;

/**
 * Snapshot of every active tenant: {tenantId, used, tenantId, used, ...}.
 * Tenants whose slots have all expired are removed from the active set.
 * ARGV: slot key prefix
 */
const SNAPSHOT_LUA = `
local activeKey = KEYS[1]
local prefix = ARGV[1]
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local out = {}
for _, tenantId in ipairs(redis.call('SMEMBERS', activeKey)) do
  local key = prefix .. tenantId
  redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. nowMs)
  local used = redis.call('ZCARD', key)
  if used > 0 then
    table.insert(out, tenantId)
    table.insert(out, tostring(used))
  else
    redis.call('SREM', activeKey, tenantId)
  end
end
return out
`;

/** Test helper: move a member's expiry into the past. */
const EXPIRE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', key, nowMs - 1, member)
return 1
`;

export interface TenantSlotsOptions {
  redis: Redis;
  /** Lease duration; slots expire at the same deadline as the run's lease. */
  leaseMs: number;
  /** Per-tenant limit. 0 disables admission control entirely. */
  limit: number;
  failMode: AdmissionFailMode;
  logger?: (event: Record<string, unknown>) => void;
  /** Used only for log throttling — slot math always uses the Redis clock. */
  now?: () => number;
  /** Per-tenant override hook (reserved for per-tenant configuration). */
  limitFor?: (tenantId: string) => number;
}

export interface AdmissionPlan {
  /** Tenants at (or above) their limit, excluded from the next claim. */
  saturated: string[];
  /** Remaining room per active tenant (limit - usage). */
  room: Map<string, number>;
}

/**
 * Per-tenant concurrency slots backed by a Redis ZSET per tenant.
 * MySQL still owns run state; these slots only decide whether a run may start.
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

  get enabled(): boolean {
    return this.configuredLimit > 0;
  }

  get limit(): number {
    return this.configuredLimit;
  }

  private key(tenantId: string): string {
    return `${SLOT_KEY_PREFIX}${tenantId}`;
  }

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

  async acquire(
    tenantId: string,
    runId: string,
    leaseToken: number,
  ): Promise<boolean> {
    const limit = this.limitFor(tenantId);
    if (limit <= 0) return true;
    try {
      const result = await this.redis.eval(
        ACQUIRE_LUA,
        2,
        this.key(tenantId),
        ACTIVE_KEY,
        runId,
        String(leaseToken),
        String(limit),
        String(this.leaseMs),
        tenantId,
      );
      return Number(result) === 1;
    } catch (error) {
      this.reportDegraded('acquire', error);
      return this.failMode === 'open';
    }
  }

  async renew(
    tenantId: string,
    runId: string,
    leaseToken: number,
  ): Promise<boolean> {
    if (this.limitFor(tenantId) <= 0) return true;
    try {
      const result = await this.redis.eval(
        RENEW_LUA,
        1,
        this.key(tenantId),
        runId,
        String(leaseToken),
        String(this.leaseMs),
      );
      return Number(result) === 1;
    } catch (error) {
      this.reportDegraded('renew', error);
      return this.failMode === 'open';
    }
  }

  /** Only removes this lease generation; a newer owner keeps its slot. */
  async release(
    tenantId: string,
    runId: string,
    leaseToken: number,
  ): Promise<void> {
    if (this.limitFor(tenantId) <= 0) return;
    try {
      await this.redis.eval(
        RELEASE_LUA,
        2,
        this.key(tenantId),
        ACTIVE_KEY,
        runId,
        String(leaseToken),
        tenantId,
      );
    } catch (error) {
      this.reportDegraded('release', error);
    }
  }

  async usage(tenantId: string): Promise<number> {
    try {
      return Number(await this.redis.eval(USAGE_LUA, 1, this.key(tenantId)));
    } catch (error) {
      this.reportDegraded('usage', error);
      return 0;
    }
  }

  /**
   * Live usage of every active tenant. Used by the worker to exclude saturated
   * tenants from a claim batch instead of claiming and rejecting them.
   */
  async snapshot(): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    try {
      const flat = (await this.redis.eval(
        SNAPSHOT_LUA,
        1,
        ACTIVE_KEY,
        SLOT_KEY_PREFIX,
      )) as string[];
      for (let index = 0; index + 1 < flat.length; index += 2)
        result.set(String(flat[index]), Number(flat[index + 1]));
    } catch (error) {
      this.reportDegraded('snapshot', error);
    }
    return result;
  }

  /** Saturation view derived from `snapshot()`. */
  async admissionPlan(): Promise<AdmissionPlan> {
    const usage = await this.snapshot();
    const saturated: string[] = [];
    const room = new Map<string, number>();
    for (const [tenantId, used] of usage) {
      const limit = this.limitFor(tenantId);
      if (limit <= 0) continue;
      if (used >= limit) saturated.push(tenantId);
      else room.set(tenantId, limit - used);
    }
    return { saturated, room };
  }

  /** Test/ops helper: expire a specific generation. */
  async expireSlot(
    tenantId: string,
    runId: string,
    leaseToken: number,
  ): Promise<void> {
    await this.redis.eval(
      EXPIRE_LUA,
      1,
      this.key(tenantId),
      `${runId}:${leaseToken}`,
    );
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* already closed */
    }
  }
}
