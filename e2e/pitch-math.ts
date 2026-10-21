/**
 * Pure analysis helpers the e2e tests use to check what the app's own pitch
 * track reports — independent of `src/dsp` and `src/audio`, deliberately: an
 * e2e assertion that imported the app's own math could pass by agreeing with
 * a bug in that math. Not a hot path (runs once per test on a 10 s track).
 */
import type { PitchFrame } from '../src/core/types';

export function voicedFrames(frames: readonly PitchFrame[]): PitchFrame[] {
  return frames.filter((f) => f.voiced && Number.isFinite(f.f0Hz));
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Cents from `hz` to `refHz` (positive = sharp). */
export function centsFromReference(hz: number, refHz: number): number {
  return 1200 * Math.log2(hz / refHz);
}

/**
 * Frames per second measured from timestamps alone (not the worklet's own
 * `framesPerSec` stat), over the last `windowSec` of the track's `t` values.
 */
export function frameRateOverWindow(frames: readonly PitchFrame[], windowSec: number): number {
  if (frames.length < 2) return 0;
  const lastT = frames[frames.length - 1].t;
  const inWindow = frames.filter((f) => f.t >= lastT - windowSec);
  if (inWindow.length < 2) return 0;
  const span = inWindow[inWindow.length - 1].t - inWindow[0].t;
  return span > 0 ? (inWindow.length - 1) / span : 0;
}

/**
 * Centred moving-average detrend: subtracts the local mean (within
 * +/-windowSec/2) from each sample, the same recipe CONFIG.vibrato names for
 * removing the slow centre line before measuring rate/extent. `times` must
 * be ascending; gaps (already-filtered unvoiced frames) are fine, since the
 * window is defined in time, not sample count.
 */
export function detrend(times: readonly number[], values: readonly number[], windowSec: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  const half = windowSec / 2;
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    while (hi < n && times[hi] <= t + half) {
      sum += values[hi];
      hi++;
    }
    while (lo < hi && times[lo] < t - half) {
      sum -= values[lo];
      lo++;
    }
    const count = hi - lo;
    out[i] = count > 0 ? values[i] - sum / count : 0;
  }
  return out;
}

/**
 * Oscillation rate (Hz) from upward zero crossings of a detrended track,
 * linearly interpolated for sub-frame precision. NaN when fewer than two
 * crossings are found (can't bound a cycle).
 */
export function estimateRateHz(times: readonly number[], detrended: readonly number[]): number {
  const crossings: number[] = [];
  for (let i = 1; i < detrended.length; i++) {
    const prev = detrended[i - 1];
    const curr = detrended[i];
    if (prev < 0 && curr >= 0) {
      const frac = curr === prev ? 0 : -prev / (curr - prev);
      crossings.push(times[i - 1] + frac * (times[i] - times[i - 1]));
    }
  }
  if (crossings.length < 2) return NaN;
  const span = crossings[crossings.length - 1] - crossings[0];
  const cycles = crossings.length - 1;
  return span > 0 ? cycles / span : NaN;
}

/**
 * Half peak-to-trough extent (CONFIG.vibrato's convention): find local
 * extrema in the detrended track, take the median of consecutive
 * extrema-to-extrema distances, and halve it.
 */
export function estimateHalfExtent(detrended: readonly number[]): number {
  const extrema: number[] = [];
  for (let i = 1; i < detrended.length - 1; i++) {
    const a = detrended[i - 1];
    const b = detrended[i];
    const c = detrended[i + 1];
    if ((b >= a && b > c) || (b <= a && b < c)) extrema.push(b);
  }
  if (extrema.length < 2) return NaN;
  const steps: number[] = [];
  for (let i = 1; i < extrema.length; i++) steps.push(Math.abs(extrema[i] - extrema[i - 1]));
  return median(steps) / 2;
}
