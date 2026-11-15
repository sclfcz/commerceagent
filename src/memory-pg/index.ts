import fs from 'node:fs';
import path from 'node:path';

import { logger } from '../logger.js';

/**
 * Workspace Memory storage backend.
 *
 * Workspace Memory v2 lives in PostgreSQL while the rest of CommerceAgent stays
 * on SQLite. Two deployments share one narrow interface:
 *
 * - `postgres`: an external PostgreSQL server reached through `pg`
 *   (node-postgres). Selected by setting `MEMORY_DATABASE_URL`. This is the
 *   SaaS deployment.
 * - `pglite`: embedded PostgreSQL from `@electric-sql/pglite`, persisted under
 *   `<DATA_DIR>/memory-pg`. Zero-configuration self-hosting and the test
 *   backend (ram or temp directory; never Docker).
 *
 * The store layer only depends on `MemoryDatabase`, so both behave identically
 * down to SQL semantics.
 */
export type MemoryBackendKind = 'postgres' | 'pglite';

export type MemoryRow = Record<string, unknown>;

export interface MemoryQueryResult<T extends MemoryRow = MemoryRow> {
  rows: T[];
  rowCount: number;
}

/** The subset of a database connection a single statement or transaction uses. */
export interface MemorySql {
  query<T extends MemoryRow = MemoryRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<MemoryQueryResult<T>>;
  /** Run a parameterless multi-statement script (schema migrations only). */
  exec(sql: string): Promise<void>;
}

export interface MemoryDatabase extends MemorySql {
  readonly backend: MemoryBackendKind;
  /** Redacted connection description for logs and diagnostics. */
  readonly location: string;
  transaction<T>(work: (sql: MemorySql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MemoryDatabaseConfig {
  kind: MemoryBackendKind;
  /** External PostgreSQL URL; only set for `postgres`. */
  url: string | null;
  /** Embedded data directory root; only used for `pglite`. */
  dataDir: string | null;
}

export interface MemoryDatabaseOverrides {
  /** Defaults to `process.env.MEMORY_DATABASE_URL`. */
  url?: string | null;
  /** Defaults to the CommerceAgent DATA_DIR. */
  dataDir: string;
}

/**
 * Choose the backend. The presence of `MEMORY_DATABASE_URL` is the only switch:
 * SaaS sets it, self-hosted installs leave it empty and get embedded PostgreSQL.
 */
export function resolveMemoryDatabaseConfig(
  options: MemoryDatabaseOverrides,
): MemoryDatabaseConfig {
  const url = (options.url ?? process.env.MEMORY_DATABASE_URL ?? '').trim();
  if (url) {
    return {
      kind: 'postgres',
      url,
      dataDir: null,
    };
  }
  return {
    kind: 'pglite',
    url: null,
    dataDir: path.join(options.dataDir, 'memory-pg'),
  };
}

export function describeMemoryDatabaseLocation(
  config: MemoryDatabaseConfig,
): string {
  if (config.kind === 'pglite') return `pglite:${config.dataDir}`;
  return `postgres:${redactDatabaseUrl(config.url ?? '')}`;
}

function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}@` : '';
    return `${parsed.protocol}//${user}${parsed.host}${parsed.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

export async function createMemoryDatabase(
  config: MemoryDatabaseConfig,
): Promise<MemoryDatabase> {
  if (config.kind === 'postgres') {
    return await createPostgresDatabase(config.url ?? '');
  }
  return await createPgliteDatabase(config.dataDir!);
}

async function createPostgresDatabase(url: string): Promise<MemoryDatabase> {
  if (!url) throw new Error('MEMORY_DATABASE_URL is empty');
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: url,
    max: 10,
    application_name: 'commerceagent-memory',
  });
  // An idle client error must never take the host process down; the next query
  // reconnects from the pool.
  pool.on('error', (error: Error) => {
    logger.warn(
      { err: error },
      'Workspace Memory PostgreSQL pool reported an idle client error',
    );
  });
  const location = describeMemoryDatabaseLocation({
    kind: 'postgres',
    url,
    dataDir: null,
  });
  return {
    backend: 'postgres',
    location,
    async query<T extends MemoryRow = MemoryRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<MemoryQueryResult<T>> {
      const result = await pool.query(sql, params as unknown[]);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? result.rows.length,
      };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(work: (sql: MemorySql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: MemorySql = {
          async query<U extends MemoryRow = MemoryRow>(
            sql: string,
            params: readonly unknown[] = [],
          ) {
            const result = await client.query(sql, params as unknown[]);
            return {
              rows: result.rows as U[],
              rowCount: result.rowCount ?? result.rows.length,
            };
          },
          async exec(sql: string) {
            await client.query(sql);
          },
        };
        const value = await work(tx);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

async function createPgliteDatabase(dataDir: string): Promise<MemoryDatabase> {
  fs.mkdirSync(dataDir, { recursive: true });
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const pglite = await PGlite.create({ dataDir, extensions: { pg_trgm } });

  // PGlite exposes exactly one connection. Every unit of work is serialized so
  // two transactions can never interleave their statements.
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.then(work, work);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function runQuery<T extends MemoryRow = MemoryRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<MemoryQueryResult<T>> {
    const result = await pglite.query(sql, params as unknown[]);
    return {
      rows: result.rows as T[],
      // PGlite reports `affectedRows: 0` for a plain SELECT while node-postgres
      // reports the row count, so fall back to the row count on both paths to
      // keep the two backends' `rowCount` identical.
      rowCount: result.affectedRows || result.rows.length,
    };
  }

  return {
    backend: 'pglite',
    location: describeMemoryDatabaseLocation({
      kind: 'pglite',
      url: null,
      dataDir,
    }),
    query<T extends MemoryRow = MemoryRow>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      return serialize(() => runQuery<T>(sql, params));
    },
    exec(sql: string) {
      return serialize(async () => {
        await pglite.exec(sql);
      });
    },
    transaction<T>(work: (sql: MemorySql) => Promise<T>): Promise<T> {
      return serialize(() =>
        pglite.transaction(async (tx) => {
          const adapter: MemorySql = {
            async query<U extends MemoryRow = MemoryRow>(
              statement: string,
              params: readonly unknown[] = [],
            ): Promise<MemoryQueryResult<U>> {
              const result = await tx.query<U>(statement, params as unknown[]);
              return {
                rows: result.rows as U[],
                rowCount: result.affectedRows || result.rows.length,
              };
            },
            async exec(statement: string) {
              await tx.exec(statement);
            },
          };
          return await work(adapter);
        }),
      );
    },
    async close() {
      await serialize(async () => {
        await pglite.close();
      });
    },
  };
}
