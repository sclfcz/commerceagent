import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, execute, queryRows, type Pool } from './mysql.js';
import { loadDistributedConfig } from './config.js';

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** The database was migrated by a newer build; this process must not run. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly appliedVersion: number,
    readonly knownVersion: number,
  ) {
    super(
      `database schema version ${appliedVersion} is newer than this build (${knownVersion})`,
    );
    this.name = 'SchemaTooNewError';
  }
}

/**
 * Migrations live next to the subsystem sources. `tsc` does not copy `.sql`
 * files into `dist/`, so a compiled build falls back to the source tree.
 */
function resolveMigrationsDirectory(): string {
  const candidates = [
    new URL('./migrations/', import.meta.url),
    new URL('../../../src/distributed/migrations/', import.meta.url),
  ];
  for (const candidate of candidates) {
    const directory = fileURLToPath(candidate);
    if (fs.existsSync(directory)) return directory;
  }
  return fileURLToPath(candidates[0]);
}

export const DEFAULT_MIGRATIONS_DIR = resolveMigrationsDirectory();

export interface MigrationFile {
  version: number;
  file: string;
  fullPath: string;
}

export function listMigrations(dir = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const entries = fs
    .readdirSync(dir)
    .filter((name) => /^\d+_[A-Za-z0-9._-]+\.sql$/.test(name));
  const migrations = entries.map((file) => {
    const version = Number(file.slice(0, file.indexOf('_')));
    if (!Number.isSafeInteger(version) || version < 1)
      throw new MigrationError(`invalid migration filename: ${file}`);
    return { version, file, fullPath: path.join(dir, file) };
  });
  migrations.sort((left, right) => left.version - right.version);
  for (let index = 1; index < migrations.length; index++)
    if (migrations[index].version === migrations[index - 1].version)
      throw new MigrationError(
        `duplicate migration version ${migrations[index].version}`,
      );
  return migrations;
}

/**
 * Split a migration file into individual statements.
 *
 * The pool intentionally does NOT enable `multipleStatements` (it widens the
 * blast radius of any SQL injection bug), so migrations are executed one
 * statement at a time. This splitter understands single/double quotes,
 * backticks, line comments (`--`, `#`) and block comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (inLineComment) {
      current += char;
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += '/';
        index++;
        inBlockComment = false;
      }
      continue;
    }
    if (quote) {
      current += char;
      if (char === '\\' && quote !== '`') {
        // Backslash escapes the next character inside normal string literals.
        current += next ?? '';
        index++;
        continue;
      }
      if (char === quote) {
        // A doubled quote is an escaped quote, not the end of the literal.
        if (next === quote) {
          current += next;
          index++;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === '-' && next === '-' && /\s/.test(sql[index + 2] ?? ' ')) {
      current += '--';
      index++;
      inLineComment = true;
      continue;
    }
    if (char === '#') {
      current += char;
      inLineComment = true;
      continue;
    }
    if (char === '/' && next === '*') {
      current += '/*';
      index++;
      inBlockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (quote)
    throw new MigrationError('unterminated string literal in migration');
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const LOCK_NAME = 'commerceagent_dist_schema_migrate';

/**
 * Apply every pending migration in version order.
 *
 * MySQL DDL is not transactional, so a migration that fails halfway cannot be
 * rolled back atomically; the version row is only written after the statement
 * batch succeeds, and the error is surfaced for a human to clean up.
 * `GET_LOCK` serialises concurrent migrators (multiple worker pods at boot).
 */
export async function runMigrations(
  pool: Pool,
  options: { dir?: string; lockTimeoutSeconds?: number } = {},
): Promise<{ applied: number[]; known: number[] }> {
  const migrations = listMigrations(options.dir);
  const known = migrations.map((migration) => migration.version);
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? 30;
  const connection = await pool.getConnection();
  try {
    const lockRows = await queryRows(
      connection,
      'SELECT GET_LOCK(?, ?) AS acquired',
      [LOCK_NAME, lockTimeoutSeconds],
    );
    if (Number(lockRows[0]?.acquired) !== 1)
      throw new MigrationError('timed out waiting for the migration lock');

    await execute(
      connection,
      `CREATE TABLE IF NOT EXISTS dist_schema_migrations (
         version INT PRIMARY KEY,
         applied_at DATETIME(3) NOT NULL
       ) ENGINE = InnoDB`,
    );

    const rows = await queryRows(
      connection,
      'SELECT version FROM dist_schema_migrations',
    );
    const appliedVersions = new Set(rows.map((row) => Number(row.version)));
    const highestApplied = appliedVersions.size
      ? Math.max(...appliedVersions)
      : 0;
    const highestKnown = known.length ? Math.max(...known) : 0;
    if (highestApplied > highestKnown)
      throw new SchemaTooNewError(highestApplied, highestKnown);

    const applied: number[] = [];
    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      const sql = fs.readFileSync(migration.fullPath, 'utf8');
      try {
        for (const statement of splitSqlStatements(sql))
          await connection.query(statement);
        await execute(
          connection,
          'INSERT INTO dist_schema_migrations (version, applied_at) VALUES (?, NOW(3))',
          [migration.version],
        );
      } catch (error) {
        throw new MigrationError(
          `migration ${migration.file} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      applied.push(migration.version);
    }
    return { applied, known };
  } finally {
    try {
      await queryRows(connection, 'SELECT RELEASE_LOCK(?) AS released', [
        LOCK_NAME,
      ]);
    } catch {
      /* the connection is released either way; MySQL drops session locks */
    }
    connection.release();
  }
}

const invokedDirectly =
  !!process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const config = loadDistributedConfig();
  const pool = createPool(config.mysqlUrl, { connectionLimit: 2 });
  try {
    const result = await runMigrations(pool);
    process.stdout.write(
      JSON.stringify({
        event: 'migrations_applied',
        applied: result.applied,
        known: result.known,
      }) + '\n',
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        event: 'migration_failed',
        error: error instanceof Error ? error.message : String(error),
      }) + '\n',
    );
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
