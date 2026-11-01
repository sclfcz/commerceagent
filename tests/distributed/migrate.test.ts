import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import type { Pool } from '../../src/distributed/mysql.js';
import {
  splitSqlStatements,
  SchemaTooNewError,
  runMigrations,
} from '../../src/distributed/migrate.js';
import {
  acquireSuiteLock,
  createTestPool,
  describeMysql,
  resetSchema,
} from './helpers.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

describeMysql('migrations', () => {
  let pool: Pool;
  let release: () => void;

  beforeAll(async () => {
    pool = await createTestPool(4);
    release = await acquireSuiteLock();
    await resetSchema(pool);
  });

  afterAll(async () => {
    await pool?.end();
    release?.();
  });

  test('runs once and is idempotent on the second call', async () => {
    // resetSchema() in beforeAll already migrated once; start from empty here.
    await pool.query('DROP TABLE IF EXISTS dist_task_run_events');
    await pool.query('DROP TABLE IF EXISTS dist_task_runs');
    await pool.query('DROP TABLE IF EXISTS dist_schema_migrations');
    const first = await runMigrations(pool);
    expect(first.applied).toEqual([1, 2, 3, 4]);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.known).toEqual([1, 2, 3, 4]);

    const rows = (
      await pool.query(
        'SELECT version FROM dist_schema_migrations ORDER BY version',
      )
    )[0] as Array<{ version: number }>;
    expect(rows.map((row) => Number(row.version))).toEqual([1, 2, 3, 4]);
  });

  test('refuses to run when the database is newer than the code', async () => {
    await pool.query(
      'INSERT INTO dist_schema_migrations (version, applied_at) VALUES (999, NOW(3))',
    );
    try {
      await expect(runMigrations(pool)).rejects.toBeInstanceOf(
        SchemaTooNewError,
      );
      await expect(runMigrations(pool)).rejects.toThrow(
        /newer than this build/,
      );
    } finally {
      await pool.query(
        'DELETE FROM dist_schema_migrations WHERE version = 999',
      );
    }
    // Cleanup restores a runnable state.
    await expect(runMigrations(pool)).resolves.toMatchObject({ applied: [] });
  });

  test('splits migration SQL without touching quoted bodies or comments', () => {
    const statements = splitSqlStatements(`
      -- a comment with ; inside
      CREATE TABLE a (x INT);
      INSERT INTO a VALUES ('semi;colon', "double;quoted", \`back;tick\`);
      /* block ; comment */
      INSERT INTO a VALUES ('it''s; escaped');
    `);
    expect(statements).toHaveLength(3);
    expect(statements[0]).toContain('CREATE TABLE a');
    expect(statements[1]).toContain("'semi;colon'");
    expect(statements[2]).toContain("'it''s; escaped'");
  });
});
