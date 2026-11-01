import mysql from 'mysql2/promise';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';

export type { Pool, PoolConnection, ResultSetHeader, RowDataPacket };
export type Queryable = Pool | PoolConnection;

/**
 * Create the shared pool.
 *
 * `timezone: 'Z'` only tells the *client* how to parse DATETIME values; the
 * server session decides what `NOW(3)` writes into them. Every pooled
 * connection therefore pins its session to UTC so a server configured for a
 * local time zone cannot shift stored timestamps by hours.
 */
export function createPool(
  url: string,
  overrides: Partial<mysql.PoolOptions> = {},
): Pool {
  const pool = mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    ...overrides,
  });
  // mysql2 forwards the *core* (callback-style) connection here, and emits it
  // before the connection is handed out, so the SET is queued first.
  pool.on('connection', (connection) => {
    (
      connection as unknown as {
        query: (sql: string, callback: (error?: unknown) => void) => unknown;
      }
    ).query("SET time_zone = '+00:00'", () => {
      /* a failed SET surfaces on the first real query using this connection */
    });
  });
  return pool;
}

export async function queryRows(
  target: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, any>[]> {
  const [rows] = await target.query<RowDataPacket[]>(sql, params as any);
  return rows as Record<string, any>[];
}

export async function execute(
  target: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<ResultSetHeader> {
  const [result] = await target.execute<ResultSetHeader>(sql, params as any);
  return result;
}

function isRetryableTransactionError(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno;
  // 1213 deadlock, 1205 lock wait timeout. Both are safe to retry because the
  // transaction was rolled back by InnoDB.
  return errno === 1213 || errno === 1205;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` inside a single transaction, rolling back on any throw.
 * Deadlocks and lock-wait timeouts are retried a bounded number of times,
 * which keeps `FOR UPDATE SKIP LOCKED` claim batches from failing spuriously.
 */
export type TransactionIsolation =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface TransactionOptions {
  retries?: number;
  onRetry?: () => void;
  /**
   * Applies to the next transaction only (`SET TRANSACTION ...`), so it is
   * issued before `BEGIN` and does not leak into later statements.
   * Claim/reap use READ COMMITTED: their `FOR UPDATE SKIP LOCKED` scans only
   * need to skip rows another transaction already locked, and repeatable-read
   * gap locks make concurrent claimers deadlock far more often.
   */
  isolation?: TransactionIsolation;
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const connection = await pool.getConnection();
    try {
      if (options.isolation)
        await connection.query(
          `SET TRANSACTION ISOLATION LEVEL ${options.isolation}`,
        );
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        /* the connection may already be gone; the original error wins */
      }
      if (attempt < retries && isRetryableTransactionError(error)) {
        options.onRetry?.();
        await sleep(10 + Math.floor(Math.random() * 40));
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
