import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/env-setup.ts', './test/setup.ts'],
    fileParallel: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 15_000,
  },
});
