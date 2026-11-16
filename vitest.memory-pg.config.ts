import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

// Reuse the existing suites without making ordinary `make test` depend on PG.
// No URL means these suites are skipped; the pure recall algorithm still runs.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: process.env.MEMORY_PG_TEST_URL?.trim()
        ? [
            'tests/routes-workspace-memory.test.ts',
            'tests/memory-recall.test.ts',
            'tests/workspace-memory-recall-b.test.ts',
            'tests/memory-consolidation.test.ts',
            'tests/memory-extraction.test.ts',
            'tests/memory-pg-e2e.test.ts',
            'tests/memory-pg-integration-gaps.test.ts',
            'tests/memory-pg-idempotency-race.test.ts',
            'tests/memory-pg/real-pg-*.test.ts',
          ]
        : ['tests/memory-recall.test.ts', 'tests/memory-pg/real-pg-*.test.ts'],
      setupFiles: ['tests/memory-pg/setup-file.ts'],
      maxWorkers: 4,
    },
  }),
);
