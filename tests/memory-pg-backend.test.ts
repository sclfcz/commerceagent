import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const memoryPg = await import('../src/memory-pg/index.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-pg-backend-'));

afterAll(() => {
  delete process.env.MEMORY_DATABASE_URL;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory database backend selection', () => {
  test('MEMORY_DATABASE_URL selects external PostgreSQL', () => {
    const config = memoryPg.resolveMemoryDatabaseConfig({
      url: 'postgres://memory:pw123@db.example.com:5432/commerceagent',
      dataDir: root,
    });

    expect(config).toEqual({
      kind: 'postgres',
      url: 'postgres://memory:pw123@db.example.com:5432/commerceagent',
      dataDir: null,
    });
    // The location line is safe to log: credentials never appear.
    expect(memoryPg.describeMemoryDatabaseLocation(config)).toBe(
      'postgres:postgres://memory@db.example.com:5432/commerceagent',
    );
  });

  test('an unset URL selects embedded PGlite under DATA_DIR', () => {
    const config = memoryPg.resolveMemoryDatabaseConfig({
      url: '',
      dataDir: root,
    });

    expect(config).toEqual({
      kind: 'pglite',
      url: null,
      dataDir: path.join(root, 'memory-pg'),
    });
    expect(memoryPg.describeMemoryDatabaseLocation(config)).toBe(
      `pglite:${path.join(root, 'memory-pg')}`,
    );
  });

  test('the environment variable is the only switch', () => {
    process.env.MEMORY_DATABASE_URL = ' postgres://env@localhost:5432/memory ';
    try {
      // Whitespace is trimmed and an explicit empty override still means PGlite.
      expect(
        memoryPg.resolveMemoryDatabaseConfig({ dataDir: root }),
      ).toMatchObject({
        kind: 'postgres',
        url: 'postgres://env@localhost:5432/memory',
      });
      expect(
        memoryPg.resolveMemoryDatabaseConfig({ url: '', dataDir: root }),
      ).toMatchObject({ kind: 'pglite' });
    } finally {
      delete process.env.MEMORY_DATABASE_URL;
    }
  });

  test('a postgres config builds a pool without connecting eagerly', async () => {
    const database = await memoryPg.createMemoryDatabase({
      kind: 'postgres',
      url: 'postgres://memory:pw123@127.0.0.1:1/memory',
      dataDir: null,
    });

    try {
      expect(database.backend).toBe('postgres');
      expect(database.location).toBe(
        'postgres:postgres://memory@127.0.0.1:1/memory',
      );
      // Nothing is reachable on port 1: the failure surfaces on first use, not
      // at construction, so a bad URL cannot crash startup before logging.
      await expect(database.query('SELECT 1')).rejects.toThrow();
    } finally {
      await database.close();
    }
  });

  test('PGlite supports query, exec, transactions and persistence', async () => {
    const dataDir = path.join(root, 'pglite');
    const first = await memoryPg.createMemoryDatabase({
      kind: 'pglite',
      url: null,
      dataDir,
    });

    try {
      expect(first.backend).toBe('pglite');
      expect(first.location).toBe(`pglite:${dataDir}`);

      await first.exec(`
        CREATE TABLE demo (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      await expect(
        first.query('SELECT $1::int AS n', [7]),
      ).resolves.toMatchObject({ rows: [{ n: 7 }], rowCount: 1 });

      await first.transaction(async (sql) => {
        await sql.query('INSERT INTO demo (id, value) VALUES ($1, $2)', [
          'kept',
          'committed',
        ]);
      });

      // A throwing transaction rolls back and rethrows to the caller.
      await expect(
        first.transaction(async (sql) => {
          await sql.query('INSERT INTO demo (id, value) VALUES ($1, $2)', [
            'dropped',
            'rolled back',
          ]);
          throw new Error('rollback me');
        }),
      ).rejects.toThrow('rollback me');
    } finally {
      await first.close();
    }

    const reopened = await memoryPg.createMemoryDatabase({
      kind: 'pglite',
      url: null,
      dataDir,
    });
    try {
      const { rows } = await reopened.query<{ id: string }>(
        'SELECT id FROM demo ORDER BY id',
      );
      expect(rows).toEqual([{ id: 'kept' }]);
    } finally {
      await reopened.close();
    }
  });
});
