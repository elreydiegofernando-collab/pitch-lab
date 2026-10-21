import { defineConfig } from 'vitest/config';

// `npm run e2e`. Builds the app, drives it with the installed Chrome and a
// synthesized fake-mic WAV (see e2e/global-setup.ts), and tears the server
// down afterwards. Separate from vitest.config.ts because it's node-only,
// slow, and must never run its browser launches in parallel with each other.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    globalSetup: ['./e2e/global-setup.ts'],
    // One Chrome launch per WAV, one preview server for the whole run:
    // running test files concurrently would race `vite preview`'s fixed
    // port and pile up Chrome processes for no benefit.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
