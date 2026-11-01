import mysql from 'mysql2/promise';
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise';

export type { Pool, PoolConnection, ResultSetHeader, RowDataPacket };
export type Queryable = Pool | PoolConnection;

export function createPool(
  url: string,
  overrides: Partial<mysql.PoolOptions> = {},
): Pool {
  return mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    ...overrides,
  });
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
export async function withTransaction<T>(
  pool: Pool,
  fn: (connection: PoolConnection) => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const connection = await pool.getConnection();
    try {
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
        await sleep(10 + Math.floor(Math.random() * 40));
        continue;
      }
      throw error;
    } finally {
      connection.release();
    }
  }
}
