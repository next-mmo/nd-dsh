import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// ND-DSH's own tests live in tests/ plus colocated renderer unit tests under
// src/. The pinned DeepSeek Harness submodule ships its own spec suite, which
// must stay out of this repository's test run. The `@renderer`/`@shared`
// aliases mirror the renderer target in electron.vite.config.ts so component
// modules resolve exactly as they do in the app build.
export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared'),
    },
  },
  test: {
    // `mjs` specs cover the benchmark tooling (result kinds and aggregation),
    // which is plain ESM shared with the benchmark scripts themselves.
    include: ['tests/**/*.test.{ts,tsx,mjs}', 'src/**/*.test.{ts,tsx}'],
    // Integration files spawn real Git repositories and process trees. Avoid
    // saturating Windows disk/process startup on machines with many CPU cores;
    // the product's parallel-worktree assertions and deadlines stay unchanged.
    globalSetup: ['./scripts/unit-test-workload.mjs'],
    maxWorkers: process.platform === 'win32' ? 2 : 4,
    testTimeout: 15_000,
  },
})
