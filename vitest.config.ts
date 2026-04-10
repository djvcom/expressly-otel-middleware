/// <reference types="vitest" />
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: path.resolve(__dirname),
    coverage: { provider: 'istanbul' },
    include: ['src/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
