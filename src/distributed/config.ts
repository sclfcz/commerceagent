import { randomUUID } from 'node:crypto';

/**
 * Configuration for the distributed run-claiming subsystem.
 *
 * Every value is validated eagerly so a misconfigured worker fails at startup
 * instead of silently heart-beating too slowly and losing its lease.
 */
export class DistributedConfigError extends Error {
  constructor(
    readonly field: string,
    message?: string,
  ) {
    super(message ?? `invalid distributed config: ${field}`);
    this.name = 'DistributedConfigError';
  }
}

export interface DistributedConfig {
  /** MySQL connection string, e.g. mysql://user:pass@127.0.0.1:3307/dist */
  mysqlUrl: string;
  /** Stable identity of this worker process, recorded on leases and events. */
  workerId: string;
  /** How long a lease stays valid after the last successful heartbeat. */
  leaseMs: number;
  /** How often a running run refreshes its lease. */
  heartbeatMs: number;
  /** Maximum number of runs executed concurrently by this worker. */
  concurrency: number;
  /** How many runs one claim transaction asks for (defaults to concurrency). */
  claimBatch: number;
  /** Base poll interval when no run is available; jittered by 0-30%. */
  pollMs: number;
  /** How often the reaper looks for expired leases. */
  reaperIntervalMs: number;
  /** Base delay for exponential retry backoff. */
  backoffBaseMs: number;
  /** Upper bound for a single retry delay. */
  backoffMaxMs: number;
  /** `poll`: claim directly from MySQL. `mq`: consume run.ready messages. */
  dispatch: 'poll' | 'mq';
  /** RabbitMQ connection string (only used when dispatch = mq / by the relay). */
  amqpUrl: string;
  /** Safety-net poll interval when dispatch = mq (messages can be lost). */
  fallbackPollMs: number;
  /** Relay: rows per publish batch. */
  relayBatchSize: number;
  /** Relay: idle sleep between batches. */
  relayPollMs: number;
  /** Relay fault injection: exit between confirm and commit. */
  relayCrashAfterConfirmRate: number;
  /** Relay fault injection: publish the same message twice. */
  relayDuplicateRate: number;
  /** Redis connection used only for admission control (slots, token buckets). */
  redisUrl: string;
  /** Per-tenant concurrency limit; 0 disables admission control. */
  tenantConcurrency: number;
  /** Behaviour when Redis admission calls fail. */
  admissionFailMode: 'open' | 'closed';
  /** Per-effect send timeout; on expiry the step becomes unknown. */
  effectTimeoutMs: number;
  /** Monitoring scan for stale `unknown` steps. */
  unknownSweepMs: number;
  /** Grace window after a client timeout before declaring "not sent". */
  effectSettleMs: number;
}

function readInt(
  env: NodeJS.ProcessEnv,
  field: string,
  fallback: number,
  bounds: { min: number; max?: number },
): number {
  const raw = env[field];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < bounds.min ||
    (bounds.max !== undefined && value > bounds.max)
  )
    throw new DistributedConfigError(field);
  return value;
}

/** Probability in [0,1]; used only by the relay's fault injection. */
function readRate(env: NodeJS.ProcessEnv, field: string): number {
  const raw = env[field];
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw new DistributedConfigError(field, `${field} must be within [0,1]`);
  return value;
}

function readFailMode(env: NodeJS.ProcessEnv): 'open' | 'closed' {
  const raw = (env.DIST_ADMISSION_FAIL_MODE ?? 'open').trim().toLowerCase();
  if (raw !== 'open' && raw !== 'closed')
    throw new DistributedConfigError(
      'DIST_ADMISSION_FAIL_MODE',
      "DIST_ADMISSION_FAIL_MODE must be 'open' or 'closed'",
    );
  return raw;
}

function readDispatch(env: NodeJS.ProcessEnv): 'poll' | 'mq' {
  const raw = (env.DIST_DISPATCH ?? 'poll').trim().toLowerCase();
  if (raw !== 'poll' && raw !== 'mq')
    throw new DistributedConfigError(
      'DIST_DISPATCH',
      "DIST_DISPATCH must be 'poll' or 'mq'",
    );
  return raw;
}

function readWorkerId(env: NodeJS.ProcessEnv): string {
  const raw = env.DIST_WORKER_ID?.trim();
  if (raw) {
    if (raw.length > 128 || /[\u0000-\u001f]/.test(raw))
      throw new DistributedConfigError('DIST_WORKER_ID');
    return raw;
  }
  const host = process.env.HOSTNAME?.trim() || 'localhost';
  return `${host}:${process.pid}:${randomUUID()}`;
}

export function loadDistributedConfig(
  env: NodeJS.ProcessEnv = process.env,
): DistributedConfig {
  const mysqlUrl = env.DIST_MYSQL_URL?.trim();
  if (!mysqlUrl) throw new DistributedConfigError('DIST_MYSQL_URL');
  let parsed: URL;
  try {
    parsed = new URL(mysqlUrl);
  } catch {
    throw new DistributedConfigError('DIST_MYSQL_URL');
  }
  if (parsed.protocol !== 'mysql:' && parsed.protocol !== 'mysql2:')
    throw new DistributedConfigError('DIST_MYSQL_URL');

  const leaseMs = readInt(env, 'DIST_LEASE_MS', 30_000, {
    min: 300,
    max: 3_600_000,
  });
  const heartbeatMs = readInt(env, 'DIST_HEARTBEAT_MS', 10_000, {
    min: 100,
    max: leaseMs,
  });
  // A lease must survive at least two missed heartbeats; otherwise a single
  // slow query can hand the run to another worker while this one still works.
  if (heartbeatMs > leaseMs / 3)
    throw new DistributedConfigError(
      'DIST_HEARTBEAT_MS',
      'DIST_HEARTBEAT_MS must be <= DIST_LEASE_MS / 3',
    );

  const concurrency = readInt(env, 'DIST_WORKER_CONCURRENCY', 4, {
    min: 1,
    max: 256,
  });
  const config: DistributedConfig = {
    mysqlUrl,
    workerId: readWorkerId(env),
    leaseMs,
    heartbeatMs,
    concurrency,
    claimBatch: Math.min(
      readInt(env, 'DIST_CLAIM_BATCH', concurrency, { min: 1, max: 256 }),
      concurrency,
    ),
    pollMs: readInt(env, 'DIST_POLL_MS', 1_000, { min: 10, max: 600_000 }),
    reaperIntervalMs: readInt(env, 'DIST_REAPER_INTERVAL_MS', 5_000, {
      min: 100,
      max: 3_600_000,
    }),
    backoffBaseMs: readInt(env, 'DIST_BACKOFF_BASE_MS', 2_000, {
      min: 1,
      max: 3_600_000,
    }),
    backoffMaxMs: readInt(env, 'DIST_BACKOFF_MAX_MS', 300_000, {
      min: 1,
      max: 86_400_000,
    }),
    dispatch: readDispatch(env),
    amqpUrl: env.DIST_AMQP_URL?.trim() || 'amqp://dist:dist@127.0.0.1:5672',
    fallbackPollMs: readInt(env, 'DIST_FALLBACK_POLL_MS', 30_000, {
      min: 50,
      max: 3_600_000,
    }),
    relayBatchSize: readInt(env, 'DIST_RELAY_BATCH_SIZE', 100, {
      min: 1,
      max: 1000,
    }),
    relayPollMs: readInt(env, 'DIST_RELAY_POLL_MS', 200, {
      min: 10,
      max: 60_000,
    }),
    relayCrashAfterConfirmRate: readRate(
      env,
      'DIST_RELAY_CRASH_AFTER_CONFIRM_RATE',
    ),
    relayDuplicateRate: readRate(env, 'DIST_RELAY_DUPLICATE_RATE'),
    redisUrl: env.DIST_REDIS_URL?.trim() || 'redis://127.0.0.1:6379',
    tenantConcurrency: readInt(env, 'DIST_TENANT_CONCURRENCY', 0, {
      min: 0,
      max: 10_000,
    }),
    admissionFailMode: readFailMode(env),
    effectTimeoutMs: readInt(env, 'DIST_EFFECT_TIMEOUT_MS', 5_000, {
      min: 100,
      max: 600_000,
    }),
    unknownSweepMs: readInt(env, 'DIST_UNKNOWN_SWEEP_MS', 60_000, {
      min: 1_000,
      max: 3_600_000,
    }),
    effectSettleMs: readInt(env, 'DIST_EFFECT_SETTLE_MS', 2_000, {
      min: 0,
      max: 600_000,
    }),
  };
  if (config.backoffBaseMs > config.backoffMaxMs)
    throw new DistributedConfigError(
      'DIST_BACKOFF_BASE_MS',
      'DIST_BACKOFF_BASE_MS must be <= DIST_BACKOFF_MAX_MS',
    );
  return config;
}
