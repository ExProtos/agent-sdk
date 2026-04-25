import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // E2E tests hit real APIs and may be slow.
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Don't parallelize across files — limits API quota burn and avoids
    // step-on-each-other state (e.g., shared continuation files).
    fileParallelism: false,
  },
});
