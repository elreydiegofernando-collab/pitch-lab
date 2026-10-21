/**
 * McLeod & Wyvill 2005 pitch detector ("A Smarter Way to Find Pitch"):
 * the normalised square difference function (NSDF), key-maximum picking
 * with the `k` clarity threshold, and parabolic interpolation.
 *
 * This module's overall shape - NSDF via autocorrelation plus the
 * incremental `m'(tau)` recurrence, key maxima between zero crossings,
 * parabolic refinement - was informed by reading the `pitchy` package
 * (github.com/ianprime0509/pitchy, MIT; see its `_nsdf`/`findPitch`). Two
 * things are deliberately different from it, per the project decision to
 * build in-house rather than depend on it at runtime:
 *
 *  - **Lag bounds.** `detect()` only ever looks at lags in
 *    `[sampleRate/maxHz, sampleRate/minHz]`. pitchy has no such bound, so
 *    on a singer's sibilants it can lock onto a very short, very "clear"
 *    lag near the Nyquist edge (its documented ~3 kHz spike failure);
 *    bounding the lag search removes that failure mode outright, and is
 *    also strictly less work per call.
 *  - **Allocation.** Every buffer `detect()` touches (the NSDF, the
 *    candidate list) is preallocated in the constructor. pitchy allocates
 *    a fresh key-maximum array (and a `.map` + spread over it) on every
 *    `findPitch` call.
 */

import type { DetectorKind, DetectorOptions, DetectResult, PitchDetector } from './detector-types';
import { Autocorrelator } from './fft';

/** Literature default (McLeod & Wyvill section 6; Tartini used 0.93). Overridden by `CONFIG.audio.mpmK` in practice. */
const DEFAULT_K = 0.9;

/** Below this RMS amplitude a window is treated as digital silence, independent of the downstream voicing gate. */
const SILENCE_RMS = 1e-6;

export class MPMDetector implements PitchDetector {
  readonly kind: DetectorKind = 'mpm';
  readonly windowSize: number;
  readonly sampleRate: number;

  private readonly minLag: number;
  private readonly maxLag: number;
  private readonly minHz: number;
  private readonly maxHz: number;
  private readonly k: number;

  private readonly autocorrelator: Autocorrelator;
  /** DC-removed copy of the input window. */
  private readonly centered: Float64Array;
  /** Holds r'(tau), then is overwritten in place with the NSDF n'(tau). */
  private readonly nsdf: Float64Array;
  /** Scratch lists of key-maximum (index, value) pairs found within the lag bounds. */
  private readonly candIndex: Int32Array;
  private readonly candValue: Float64Array;

  constructor(opts: DetectorOptions) {
    const windowSize = opts.windowSize;
    this.windowSize = windowSize;
    this.sampleRate = opts.sampleRate;
    this.k = opts.mpmK ?? DEFAULT_K;
    this.minHz = opts.minHz;
    this.maxHz = opts.maxHz;
    this.minLag = Math.max(1, Math.floor(opts.sampleRate / opts.maxHz));
    this.maxLag = Math.min(windowSize - 2, Math.ceil(opts.sampleRate / opts.minHz));

    this.autocorrelator = new Autocorrelator(windowSize);
    this.centered = new Float64Array(windowSize);
    this.nsdf = new Float64Array(windowSize);
    this.candIndex = new Int32Array(windowSize);
    this.candValue = new Float64Array(windowSize);
  }

  detect(window: Float32Array, out: DetectResult): void {
    const n = this.windowSize;
    const centered = this.centered;

    let mean = 0;
    for (let i = 0; i < n; i++) mean += window[i];
    mean /= n;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = window[i] - mean;
      centered[i] = v;
      sumSq += v * v;
    }
    if (Math.sqrt(sumSq / n) < SILENCE_RMS) {
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    const nsdf = this.nsdf;
    this.autocorrelator.autocorrelate(centered, nsdf); // nsdf now holds r'(tau)

    // n'(tau) = 2 r'(tau) / m'(tau), with m'(tau) via the incremental recurrence
    // m'(0) = 2 r'(0); m'(tau) = m'(tau-1) - x[tau-1]^2 - x[W-tau]^2.
    let m = 2 * nsdf[0];
    let i = 0;
    for (; i < n && m > 0; i++) {
      const r = nsdf[i];
      nsdf[i] = (2 * r) / m;
      const a = centered[i];
      const b = centered[n - 1 - i];
      m -= a * a + b * b;
    }
    for (; i < n; i++) nsdf[i] = 0;

    // Key maxima: the highest local maximum between each positive-going and
    // the following negative-going zero crossing. Only maxima whose lag
    // falls inside [minLag, maxLag] are ever recorded - this is the lag
    // bound described above, applied here rather than as a post-filter so a
    // sibilant's short-lag "peak" can never become the reference `nMax`.
    const candIndex = this.candIndex;
    const candValue = this.candValue;
    let count = 0;
    let curIdx = -1;
    let curVal = -Infinity;
    for (let t = 1; t < n - 1; t++) {
      const prev = nsdf[t - 1];
      const cur = nsdf[t];
      if (prev <= 0 && cur > 0) {
        curIdx = t;
        curVal = cur;
      } else if (prev > 0 && cur <= 0) {
        if (curIdx !== -1 && curIdx >= this.minLag && curIdx <= this.maxLag) {
          candIndex[count] = curIdx;
          candValue[count] = curVal;
          count++;
        }
        curIdx = -1;
        curVal = -Infinity;
      } else if (curIdx !== -1 && cur > curVal) {
        curVal = cur;
        curIdx = t;
      }
    }

    if (count === 0) {
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    let nMax = -Infinity;
    for (let c = 0; c < count; c++) if (candValue[c] > nMax) nMax = candValue[c];

    const threshold = this.k * nMax;
    let chosen = candIndex[0];
    for (let c = 0; c < count; c++) {
      if (candValue[c] >= threshold) {
        chosen = candIndex[c];
        break;
      }
    }

    // Parabolic interpolation of the NSDF around the chosen lag (general
    // 3-point vertex fit; chosen is always in [1, n-2] by construction above).
    const y0 = nsdf[chosen - 1];
    const y1 = nsdf[chosen];
    const y2 = nsdf[chosen + 1];
    const denom = y0 - 2 * y1 + y2;
    let refinedLag = chosen;
    let clarity = y1;
    if (denom !== 0) {
      let offset = (0.5 * (y0 - y2)) / denom;
      offset = offset < -1 ? -1 : offset > 1 ? 1 : offset;
      refinedLag = chosen + offset;
      clarity = y1 - 0.25 * (y0 - y2) * offset;
    }

    const f0 = this.sampleRate / refinedLag;
    if (!(f0 >= this.minHz) || f0 > this.maxHz) {
      // Refinement pushed the result outside the configured Hz range.
      out.f0Hz = NaN;
      out.confidence = 0;
      return;
    }

    out.f0Hz = f0;
    out.confidence = clarity < 0 ? 0 : clarity > 1 ? 1 : clarity;
  }
}
