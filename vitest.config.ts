import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Scope vitest's root-level discovery to project tests only.
// `data/` holds the user's agent scratch workspaces (gitignored) which can
// contain nested projects with their own test suites; vitest does not respect
// .gitignore, so we must exclude explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      react: fileURLToPath(
        new URL('./web/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('./web/node_modules/react-dom', import.meta.url),
      ),
      'react-router-dom': fileURLToPath(
        new URL('./web/node_modules/react-router-dom', import.meta.url),
      ),
    },
  },
  test: {
    // Workspace Memory tests boot a real embedded PostgreSQL (PGlite) per test
    // file. Under parallel load the first WASM compile can exceed Vitest's 5s
    // default, which made those suites flaky on a cold cache. The limits stay
    // bounded so a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      'benchmarks/results/**',
      '.claude/**',
      'web/tests/e2e/**',
    ],
  },
});
