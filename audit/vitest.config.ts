import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['audit/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
