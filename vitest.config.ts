import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // The audio-level and property tests are CPU-heavy: each takes 1-2 s alone, but the whole suite runs
    // ~120 files in parallel workers and the default 5 s limit then fails them on a busy machine without
    // any bug. A generous limit only lets a slow-but-correct run finish; a hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
