/**
 * YIN pitch detector (de Cheveigne & Kawahara 2002, "YIN, a fundamental
 * frequency estimator for speech and music"), with the difference function
 * computed via FFT autocorrelation instead of the paper's direct O(W^2) sum:
 *
 *   d(tau)  = E(0, W-tau) + E(tau, W) - 2 r(tau)
 *   d'(tau) = d(tau) * tau / sum_{j=1}^{tau} d(j)     (d'(0) := 1)
 *
 * where `E(a, b) = sum_{j=a}^{b-1} x[j]^2` (from a running prefix sum of
 * squares) and `r(tau)` is the linear autocorrelation (from `Autocorrelator`
 * in `fft.ts`, the same primitive `mpm.ts` uses). This is algebraically the
 * expansion of `sum (x[j] - x[j+tau])^2`, so it reproduces the paper's d(tau)
 * exactly, just in O(W log W) instead of O(W^2).
 *
 * As with MPM, the lag search is bounded to `[sampleRate/maxHz,
 * sampleRate/minHz]` and every buffer is preallocated in the constructor,
 * so `detect()` allocates nothing.
 */

import type { DetectorKind, DetectorOptions, DetectResult, PitchDetector } from './detector-types';
import { Autocorrelator } from './fft';

/** de Cheveigne & Kawahara section III.B suggest 0.10-0.15. Overridden by `CONFIG.audio.yinThreshold` in practice. */
const DEFAULT_THRESHOLD = 0.15;

/** Below this RMS amplitude a window is treated as digital silence, independent of the downstream voicing gate. */
const SILENCE_RMS = 1e-6;

export class YINDetector implements PitchDetector {
  readonly kind: DetectorKind = 'yin';
  readonly windowSize: number;
  readonly sampleRate: number;

  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly minHz: number;
  private readonly maxHz: number;
  private readonly threshold: number;

  private readonly autocorrelator: Autocorrelator;
  private readonly centered: Float64Array;
  /** prefixSq[i] = sum of centered[0..i) squared; length windowSize + 1. */
  private readonly prefixSq: Float64Array;
  private readonly r: Float64Array;
  /** d(tau) then overwritten in place with the cumulative-mean-normalised d'(tau). */
  private readonly d: Float64Array;

  constructor(opts: DetectorOptions) {
    const windowSize = opts.windowSize;
    this.windowSize = windowSize;
    this.sampleRate = opts.sampleRate;
    this.threshold = opts.yinThreshold ?? DEFAULT_THRESHOLD;
    this.minHz = opts.minHz;
    this.maxHz = opts.maxHz;
    this.minLag = Math.max(1, Math.floor(opts.sampleRate / opts.maxHz));
    // Leave room for a right-side interpolation neighbour at maxLag.
    this.maxLag = Math.min(windowSize - 2, Math.ceil(opts.sampleRate / opts.minHz));

    this.autocorrelator = new Autocorrelator(windowSize);
    this.centered = new Float64Array(windowSize);
    this.prefixSq = new Float64Array(windowSize + 1);
    this.r = new Float64Array(windowSize);
    this.d = new Float64Array(windowSize);
  }

  detect(window: Float32Array, out: DetectResult): void {
    const n = this.windowSize;
    const centered = this.centered;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += window[i];
    mean /= n;
    const prefixSq = this.prefixSq;
    prefixSq[0] = 0;
    for (let i = 0; i < n; i++) {
      const v = window[i] - mean;
      centered[i] = v;
      prefixSq[i + 1] = prefixSq[i] + v * v;
    }
    const totalEnergy = prefixSq[n];
    if (Math.sqrt(totalEnergy / n) < SILENCE_RMS) {
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    const r = this.r;
    this.autocorrelator.autocorrelate(centered, r);

    const d = this.d;
    d[0] = 1; // d'(0) := 1 by convention (so tau = 0 is never a candidate)

    const upperCompute = Math.min(this.maxLag + 1, n - 1);
    let runningSum = 0;
    let bestIdx = -1;
    let belowThreshold = false;
    let globalMinIdx = -1;
    let globalMinVal = Infinity;

    for (let tau = 1; tau <= upperCompute; tau++) {
      // E(0, W-tau) + E(tau, W) - 2 r(tau), from prefix sums of squares.
      const dt = prefixSq[n - tau] + (totalEnergy - prefixSq[tau]) - 2 * r[tau];
      runningSum += dt;
      const dPrime = runningSum === 0 ? 1 : (dt * tau) / runningSum;
      d[tau] = dPrime;

      if (tau >= this.minLag && tau <= this.maxLag) {
        if (dPrime < globalMinVal) {
          globalMinVal = dPrime;
          globalMinIdx = tau;
        }
        if (!belowThreshold) {
          if (dPrime < this.threshold) {
            belowThreshold = true;
            bestIdx = tau;
          }
        } else if (dPrime <= d[bestIdx]) {
          bestIdx = tau;
        } else {
          break; // value rose again: bestIdx is the local minimum.
        }
      }
    }

    const finalIdx = bestIdx !== -1 ? bestIdx : globalMinIdx;
    if (finalIdx === -1) {
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    // Parabolic interpolation around the chosen lag (general 3-point vertex
    // fit; both neighbours were always computed in the loop above).
    const y0 = d[finalIdx - 1];
    const y1 = d[finalIdx];
    const y2 = d[finalIdx + 1];
    const denom = y0 - 2 * y1 + y2;
    let refinedLag = finalIdx;
    let dMin = y1;
    if (denom !== 0) {
      let offset = (0.5 * (y0 - y2)) / denom;
      offset = offset < -1 ? -1 : offset > 1 ? 1 : offset;
      refinedLag = finalIdx + offset;
      dMin = y1 - 0.25 * (y0 - y2) * offset;
    }

    const f0 = this.sampleRate / refinedLag;
    if (!(f0 >= this.minHz) || f0 > this.maxHz) {
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    out.f0Hz = f0;
    const confidence = 1 - dMin;
    out.confidence = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence;
  }
}
