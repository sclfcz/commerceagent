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
  };
  if (config.backoffBaseMs > config.backoffMaxMs)
    throw new DistributedConfigError(
      'DIST_BACKOFF_BASE_MS',
      'DIST_BACKOFF_BASE_MS must be <= DIST_BACKOFF_MAX_MS',
    );
  return config;
}
