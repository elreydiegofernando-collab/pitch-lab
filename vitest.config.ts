import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

/**
 * The one test file whose assertions are tight wall-clock budgets (every analyzer under 20 ms on a 60 s take). A budget
 * like that only means something on a machine that is not busy with the rest of the suite: run beside ~20 workers (and
 * whatever else the laptop is doing) its best-of-25 time came out 5x slower and failed with no bug. So it gets its own
 * project, in a later group, that starts only after every file of the 'unit' project has finished. Its assertions are
 * unchanged.
 */
const PERF_TEST = 'src/analysis/perf.test.ts';

/**
 * Worker processes at once. The default is one fewer than the logical CPUs (21 on the owner's 22-thread laptop), and
 * that many forks starting together on a 16 GB machine that is also running a browser and other tools starves them: a
 * run lost four test files to vitest's fixed 60 s "Timeout waiting for worker to respond" with no test failing. Eight
 * workers still keep the CPU busy (the suite is CPU-bound) and leave the rest of the machine room to breathe; a
 * smaller machine keeps its own, lower default.
 */
const MAX_WORKERS = Math.max(1, Math.min(8, availableParallelism() - 1));

export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'node',
    maxWorkers: MAX_WORKERS,
    // The audio-level and property tests are CPU-heavy: each takes 1-2 s alone, but the whole suite runs
    // ~120 files in parallel workers and the default 5 s limit then fails them on a busy machine without
    // any bug. A generous limit only lets a slow-but-correct run finish; a hang still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: [...configDefaults.exclude, PERF_TEST],
          maxWorkers: MAX_WORKERS,
        },
      },
      {
        extends: true,
        test: {
          name: 'perf',
          include: [PERF_TEST],
          // Groups run one after the other, lowest first: 'unit' is group 0, so this runs alone once it is done.
          sequence: { groupOrder: 1 },
          maxWorkers: MAX_WORKERS,
        },
      },
    ],
  },
});
