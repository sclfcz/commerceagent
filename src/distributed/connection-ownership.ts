import crypto from 'node:crypto';
import os from 'node:os';

import type { Redis } from 'ioredis';

import { DefinitiveChannelDeliveryError } from '../channel-outbox-delivery.js';

/**
 * Single-owner leases for IM connections.
 *
 * A provider credential must be held by at most one *process*: two live
 * connectors of the same bot compete for the same event stream, so a message
 * can be answered twice. The local `credentialClaims` map only fences accounts
 * inside one process; this module extends the same fence across instances.
 *
 * Layout (per credential, never the raw secret):
 *   dist:im:owner:{credentialKey} -> "{instanceId}:{token}", PX leaseMs
 *   dist:im:fence:{credentialKey} -> monotonically increasing token
 *
 * The fencing token makes a stale owner harmless: renew/release compare the
 * full value, so an owner that lost the lease (frozen process, expired TTL)
 * cannot extend or delete the new owner's key.
 */

const OWNER_KEY_PREFIX = 'dist:im:owner:';
const FENCE_KEY_PREFIX = 'dist:im:fence:';

/**
 * Key derivation shared with `IMConnectionManager.claimCredential`: the lease
 * is per provider credential (not per account), so the fingerprint must be the
 * exact one the in-process claim uses.
 */
export function ownershipCredentialKey(
  provider: string,
  credentialIdentity: string,
): string {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${provider}\0${credentialIdentity}`)
    .digest('hex');
  return `${provider}\0${fingerprint}`;
}

/**
 * Outbound was refused because this process no longer owns the credential.
 *
 * Extends `DefinitiveChannelDeliveryError` on purpose: the outbox has already
 * marked the row `sending`, and only an explicit "the provider never saw this"
 * signal lets it retry instead of freezing the row as `uncertain`.
 */
export class ConnectionOwnershipLostError extends DefinitiveChannelDeliveryError {
  readonly code = 'IM_OWNERSHIP_LOST';
  constructor(
    readonly credentialKey: string,
    retryAt?: string,
  ) {
    super('IM connection ownership was lost; the message was not sent', {
      retryAt,
    });
    this.name = 'ConnectionOwnershipLostError';
  }
}

export interface ImOwnershipConfig {
  /** `DIST_IM_OWNERSHIP=1`; when false the manager keeps its legacy behaviour. */
  enabled: boolean;
  leaseMs: number;
  renewMs: number;
  instanceId: string;
}

export class ImOwnershipConfigError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImOwnershipConfigError';
  }
}

function readInt(
  env: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  const raw = env[field];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max)
    throw new ImOwnershipConfigError(
      field,
      `${field} must be an integer between ${bounds.min} and ${bounds.max}`,
    );
  return value;
}

export function loadImOwnershipConfig(
  env: NodeJS.ProcessEnv = process.env,
): ImOwnershipConfig {
  const enabled = env.DIST_IM_OWNERSHIP?.trim() === '1';
  const leaseMs = readInt(env, 'DIST_IM_LEASE_MS', 15_000, {
    min: 300,
    max: 600_000,
  });
  const renewMs = readInt(env, 'DIST_IM_RENEW_MS', 5_000, {
    min: 100,
    max: 200_000,
  });
  if (renewMs > Math.floor(leaseMs / 3))
    throw new ImOwnershipConfigError(
      'DIST_IM_RENEW_MS',
      'DIST_IM_RENEW_MS must be <= DIST_IM_LEASE_MS / 3',
    );
  const instanceId =
    env.DIST_INSTANCE_ID?.trim() ||
    `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  return { enabled, leaseMs, renewMs, instanceId };
}

const ACQUIRE_LUA = `
local ownerKey = KEYS[1]
local fenceKey = KEYS[2]
local owner = ARGV[1]
local leaseMs = ARGV[2]
if redis.call('EXISTS', ownerKey) == 1 then
  return 0
end
local token = redis.call('INCR', fenceKey)
redis.call('SET', ownerKey, owner .. ':' .. token, 'PX', leaseMs)
return token
`;

const RENEW_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('PEXPIRE', KEYS[1], ARGV[2])
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

/**
 * Bound every Redis round-trip: a client with an offline queue would otherwise
 * keep a renew pending forever and the self-fence would never fire.
 */
function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export interface OwnershipLease {
  readonly credentialKey: string;
  /** Fencing token, monotonic per credential. */
  readonly token: number;
  /** Value stored in Redis: `{instanceId}:{token}`. */
  readonly owner: string;
  /**
   * Whether this instance may still act as the owner.
   *
   * Uses the *monotonic* clock: a frozen process resumes with `performance.now()`
   * advanced, so a lease that expired while the process was stopped is detected
   * before the first inbound message is handled.
   */
  isCurrent(): boolean;
  renew(): Promise<boolean>;
  release(): Promise<void>;
  /** Stop renewing and drop the loss callback (does not touch Redis). */
  stop(): void;
}

export interface ConnectionOwnershipOptions {
  redis: Redis;
  instanceId: string;
  leaseMs: number;
  renewMs: number;
  logger?: (event: Record<string, unknown>) => void;
  /** Monotonic clock in ms (tests inject a fake). */
  monotonicNow?: () => number;
  /** Wall clock, used for logs only. */
  now?: () => number;
  /**
   * Diagnostic timeline (chaos reports only): `redis_ready`, `acquire_start`,
   * `acquire_end`. Never used for correctness decisions.
   */
  onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

export class ConnectionOwnership {
  private readonly redis: Redis;
  private readonly instanceId: string;
  private readonly leaseMs: number;
  private readonly renewMsValue: number;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly monotonicNow: () => number;
  private readonly now: () => number;
  private readonly onEvent?: (
    event: string,
    detail?: Record<string, unknown>,
  ) => void;
  private readonly leases = new Map<string, OwnershipLease>();

  constructor(options: ConnectionOwnershipOptions) {
    this.redis = options.redis;
    this.instanceId = options.instanceId;
    this.leaseMs = options.leaseMs;
    this.renewMsValue = options.renewMs;
    this.logger = options.logger ?? (() => {});
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
    this.redis.on('ready', () => this.record('redis_ready'));
  }

  /** Record a timeline event (diagnostics only). */
  record(event: string, detail?: Record<string, unknown>): void {
    try {
      this.onEvent?.(event, detail);
    } catch {
      /* diagnostics must never throw */
    }
  }

  private ownerKey(credentialKey: string): string {
    return `${OWNER_KEY_PREFIX}${credentialKey}`;
  }

  private fenceKey(credentialKey: string): string {
    return `${FENCE_KEY_PREFIX}${credentialKey}`;
  }

  /**
   * Try to become the owner of `credentialKey`.
   *
   * Returns `null` when another instance holds the lease (standby) or when the
   * Redis call fails: a standby must never connect without the lease.
   */
  async acquire(
    credentialKey: string,
    onLost: () => void,
  ): Promise<OwnershipLease | null> {
    const existing = this.leases.get(credentialKey);
    if (existing && existing.isCurrent()) return existing;
    let token: number;
    this.record('acquire_start', { credentialKey });
    try {
      token = Number(
        await withDeadline(
          this.redis.eval(
            ACQUIRE_LUA,
            2,
            this.ownerKey(credentialKey),
            this.fenceKey(credentialKey),
            this.instanceId,
            String(this.leaseMs),
          ),
          this.leaseMs,
          'acquire',
        ),
      );
    } catch (error) {
      this.logger({
        event: 'im_ownership_acquire_failed',
        credentialKey,
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
      });
      return null;
    }
    this.record('acquire_end', {
      credentialKey,
      granted: Number.isSafeInteger(token) && token > 0,
    });
    if (!Number.isSafeInteger(token) || token <= 0) return null;
    const lease = this.createLease(credentialKey, token, onLost);
    this.leases.set(credentialKey, lease);
    this.logger({
      event: 'im_ownership_acquired',
      credentialKey,
      token,
      instanceId: this.instanceId,
    });
    return lease;
  }

  /** Drop every lease this instance still holds (shutdown). */
  async releaseAll(): Promise<void> {
    const leases = [...this.leases.values()];
    this.leases.clear();
    await Promise.allSettled(leases.map((lease) => lease.release()));
  }

  get renewMs(): number {
    return this.renewMsValue;
  }

  get activeLeases(): number {
    return this.leases.size;
  }

  private createLease(
    credentialKey: string,
    token: number,
    onLost: () => void,
  ): OwnershipLease {
    const owner = `${this.instanceId}:${token}`;
    const renewMs = this.renewMsValue;
    const leaseMs = this.leaseMs;
    let localDeadline = this.monotonicNow() + leaseMs - renewMs;
    let lastRenewOk = true;
    let lost = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const fireLost = (reason: string): void => {
      if (lost) return;
      lost = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      this.logger({
        event: 'im_ownership_lost',
        credentialKey,
        token,
        reason,
        instanceId: this.instanceId,
      });
      try {
        onLost();
      } catch (error) {
        this.logger({
          event: 'im_ownership_on_lost_failed',
          credentialKey,
          token,
          error:
            error instanceof Error ? error.message.slice(0, 200) : 'unknown',
        });
      }
    };

    const lease: OwnershipLease = {
      credentialKey,
      token,
      owner,
      isCurrent: () => {
        if (lost || !lastRenewOk) return false;
        if (this.monotonicNow() >= localDeadline) {
          // The lease ran out while this process was not renewing (frozen,
          // event-loop stall, Redis outage). Nothing may be trusted any more.
          fireLost('local_deadline_exceeded');
          return false;
        }
        return true;
      },
      renew: async () => {
        if (lost) return false;
        try {
          const result = Number(
            await withDeadline(
              this.redis.eval(
                RENEW_LUA,
                1,
                this.ownerKey(credentialKey),
                owner,
                String(leaseMs),
              ),
              renewMs,
              'renew',
            ),
          );
          if (result !== 1) {
            lastRenewOk = false;
            fireLost('renew_rejected');
            return false;
          }
          lastRenewOk = true;
          // Only a successful renew extends the local deadline; a failed one
          // keeps the old deadline so self-fencing still happens on time.
          localDeadline = this.monotonicNow() + leaseMs - renewMs;
          return true;
        } catch (error) {
          lastRenewOk = false;
          this.logger({
            event: 'im_ownership_renew_failed',
            credentialKey,
            token,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
          // Keep serving until the last confirmed lease window runs out; the
          // deadline check in isCurrent() does the self-fence.
          if (this.monotonicNow() >= localDeadline)
            fireLost('renew_failed_past_deadline');
          return false;
        }
      },
      release: async () => {
        lease.stop();
        this.leases.delete(credentialKey);
        try {
          await withDeadline(
            this.redis.eval(
              RELEASE_LUA,
              1,
              this.ownerKey(credentialKey),
              owner,
            ),
            renewMs,
            'release',
          );
        } catch (error) {
          this.logger({
            event: 'im_ownership_release_failed',
            credentialKey,
            token,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'unknown',
          });
        }
      },
      stop: () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
      },
    };

    timer = setInterval(() => void lease.renew(), renewMs);
    timer.unref?.();
    return lease;
  }
}
