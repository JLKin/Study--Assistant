import { defineConfig } from 'vitest/config';

// Explicit opt-in: missing real runtime/models fails this suite rather than skipping it.
export default defineConfig({
  test: {
    include: ['tests/ocr-runtime/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
