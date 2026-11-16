import { randomUUID } from 'node:crypto';
import { describe } from 'vitest';
import { Pool } from 'pg';
import {
  createMemoryDatabase,
  type MemoryDatabase,
} from '../../src/memory-pg/index.js';

/** Only this opt-in test URL is used; never fall back to the production URL. */
export const TEST_MEMORY_PG_URL = process.env.MEMORY_PG_TEST_URL?.trim() ?? '';
export const hasMemoryPg = TEST_MEMORY_PG_URL.length > 0;
export const describeMemoryPg = hasMemoryPg ? describe : describe.skip;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export interface MemoryPgScope {
  url: string;
  databaseName: string;
  connect(): Promise<MemoryDatabase>;
  close(): Promise<void>;
}

/**
 * A fresh database per suite (and per isolated migration test), so files run
 * concurrently without sharing extension/schema/role state. The dedicated
 * test server role needs CREATEDB; the no-extension suite also needs CREATEROLE.
 * Every admin connection is bounded and closed, including failed setup.
 */
export async function openMemoryPgScope(): Promise<MemoryPgScope> {
  if (!hasMemoryPg) throw new Error('MEMORY_PG_TEST_URL is required');
  const pool = new Pool({ connectionString: TEST_MEMORY_PG_URL, max: 1 });
  const databaseName = `memory_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await pool.query(`CREATE DATABASE ${quoteIdent(databaseName)}`);
  } catch (error) {
    await pool.end();
    throw error;
  }
  const base = new URL(TEST_MEMORY_PG_URL);
  base.pathname = `/${databaseName}`;
  const url = base.toString();
  const connections: MemoryDatabase[] = [];
  let closed = false;
  return {
    url,
    databaseName,
    async connect() {
      const database = await createMemoryDatabase({
        kind: 'postgres',
        url,
        dataDir: null,
      });
      let closing: Promise<void> | undefined;
      const tracked = {
        ...database,
        close: () => (closing ??= database.close()),
      };
      connections.push(tracked);
      return tracked;
    },
    async close() {
      if (closed) return;
      for (const database of connections) await database.close();
      // Drop only the uniquely named database we created. FORCE ensures a
      // failed suite cannot leave stale connections blocking cleanup.
      try {
        await pool.query(
          `DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`,
        );
        closed = true;
      } finally {
        await pool.end();
      }
    },
  };
}

/** Explicit embedded migration tests also use PG during the opt-in run. */
export async function createIsolatedTestMemoryDatabase(
  dataDir: string,
): Promise<MemoryDatabase> {
  if (!hasMemoryPg || !process.env.MEMORY_DATABASE_URL) {
    return createMemoryDatabase({ kind: 'pglite', url: null, dataDir });
  }
  const scope = await openMemoryPgScope();
  try {
    const database = await scope.connect();
    return { ...database, close: () => scope.close() };
  } catch (error) {
    await scope.close();
    throw error;
  }
}

export interface LimitedMemoryPgRole {
  url: string;
  roleName: string;
  drop(): Promise<void>;
}

/**
 * pg_trgm is trusted: ordinary roles can install it if they have CREATE on
 * the DATABASE. Grant CREATE only on the test database's SCHEMA, sufficient
 * for migrations but insufficient for CREATE EXTENSION.
 */
export async function createLimitedMemoryPgRole(
  databaseName: string,
): Promise<LimitedMemoryPgRole> {
  const admin = new Pool({ connectionString: TEST_MEMORY_PG_URL, max: 1 });
  const databaseUrl = new URL(TEST_MEMORY_PG_URL);
  databaseUrl.pathname = `/${databaseName}`;
  const target = new Pool({ connectionString: databaseUrl.toString(), max: 1 });
  const roleName = `mem_limited_${randomUUID().replaceAll('-', '')}`;
  const password = `pw_${randomUUID()}`;
  try {
    await admin.query(
      `CREATE ROLE ${quoteIdent(roleName)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(
      `REVOKE CREATE ON DATABASE ${quoteIdent(databaseName)} FROM PUBLIC`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${quoteIdent(databaseName)} TO ${quoteIdent(roleName)}`,
    );
    await target.query(
      `GRANT CREATE, USAGE ON SCHEMA public TO ${quoteIdent(roleName)}`,
    );
  } catch (error) {
    await target.end();
    await admin.query(`DROP ROLE IF EXISTS ${quoteIdent(roleName)}`);
    await admin.end();
    throw error;
  }
  databaseUrl.username = roleName;
  databaseUrl.password = password;
  return {
    url: databaseUrl.toString(),
    roleName,
    async drop() {
      try {
        await target.query(`DROP OWNED BY ${quoteIdent(roleName)}`);
        await admin.query(`DROP OWNED BY ${quoteIdent(roleName)}`);
        await admin.query(`DROP ROLE ${quoteIdent(roleName)}`);
      } finally {
        await target.end();
        await admin.end();
      }
    },
  };
}
