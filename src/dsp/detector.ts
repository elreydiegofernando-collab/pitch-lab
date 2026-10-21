/**
 * Detector factory and startup micro-benchmark. This file (plus `mpm.ts`,
 * `yin.ts`, `fft.ts`, `rms.ts` and `detector-types.ts`) is bundled into the
 * AudioWorklet, so it imports only `src/dsp/*` and `src/core/*`, never the
 * DOM or `performance`/`TextDecoder` at module scope (see docs/ARCHITECTURE.md).
 */

import type { DetectorKind, DetectorOptions, DetectResult, PitchDetector } from './detector-types';
import { MPMDetector } from './mpm';
import { YINDetector } from './yin';

/** Builds the detector named by `kind`. The only factory other modules should use. */
export function createDetector(kind: DetectorKind, opts: DetectorOptions): PitchDetector {
  switch (kind) {
    case 'mpm':
      return new MPMDetector(opts);
    case 'yin':
      return new YINDetector(opts);
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown detector kind: ${String(unreachable)}`);
    }
  }
}

/** Voice-like partial amplitudes for the benchmark tone (same shape as test-signals' default, duplicated locally - see below). */
const BENCH_HARMONICS = [1, 0.6, 0.45, 0.3, 0.25, 0.18, 0.12, 0.08];
const BENCH_F0_HZ = 220;

/**
 * Fills `out` with a fixed 220 Hz voice-like tone, scaled to a comfortable
 * amplitude. Deliberately self-contained rather than importing the shared
 * generator in `test-signals.ts`: that module exists for tests, and this
 * one *is* bundled into the production AudioWorklet, so it should not pull
 * in a signal generator (PRNG, contour helpers, ...) nothing at runtime needs.
 */
function fillBenchmarkTone(out: Float32Array, sampleRate: number): void {
  let peak = 0;
  for (let h = 0; h < BENCH_HARMONICS.length; h++) peak += BENCH_HARMONICS[h];
  const scale = 0.5 / peak;
  for (let i = 0; i < out.length; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (let h = 0; h < BENCH_HARMONICS.length; h++) {
      s += BENCH_HARMONICS[h] * Math.sin(2 * Math.PI * BENCH_F0_HZ * (h + 1) * t);
    }
    out[i] = scale * s;
  }
}

/**
 * Median milliseconds per `detect()` call on a synthesized harmonic tone,
 * over `iterations` calls. This is a startup diagnostic (see
 * docs/ARCHITECTURE.md step 7 of the start-audio recipe), never a hot-path
 * call: it allocates its own scratch buffers and reads `performance.now()`
 * at call time, not at module scope.
 */
export function benchmarkDetector(det: PitchDetector, iterations: number): number {
  const window = new Float32Array(det.windowSize);
  fillBenchmarkTone(window, det.sampleRate);
  const out: DetectResult = { f0Hz: NaN, confidence: 0 };
  const samples: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    det.detect(window, out);
    samples[i] = performance.now() - t0;
  }
  samples.sort((a, b) => a - b);
  const mid = samples.length >> 1;
  return samples.length % 2 === 0 ? (samples[mid - 1] + samples[mid]) / 2 : samples[mid];
}
