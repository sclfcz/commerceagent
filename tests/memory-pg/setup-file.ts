import path from 'node:path';
import { afterAll, expect, vi } from 'vitest';
import { hasMemoryPg, openMemoryPgScope } from './helpers.js';

// Setup runs before each test file. Dedicated PG suites own their scope; the
// existing suites use a separate database per file and the full store startup.
const testFile = path.basename(expect.getState().testPath!);
const dedicated = testFile.startsWith('real-pg-');
if (!dedicated && testFile !== 'memory-recall.test.ts') {
  if (hasMemoryPg) {
    const scope = await openMemoryPgScope();
    vi.stubEnv('MEMORY_DATABASE_URL', scope.url);
    afterAll(async () => {
      const store = await import('../../src/memory-store.js');
      await store.closeWorkspaceMemoryStore();
      await scope.close();
      vi.unstubAllEnvs();
    });
  }
}
