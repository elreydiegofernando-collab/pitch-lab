/**
 * 8.3 Vibrato: rate, extent, regularity and centring, plus the style-zone
 * and quality flags. Works on a whole take (`note = null`, e.g. the live
 * vibrato meter or a free-singing segment) or on one sustained TargetNote.
 *
 * Method
 *  1. Clean isolated detector spikes and bridge 1-3 frame dropouts; every
 *     continuous voiced stretch is then searched for oscillation and the
 *     longest oscillation found is the answer.
 *  2. Detrend: subtract a centred moving average (CONFIG.vibrato.detrendWindowSec)
 *     so the slow pitch line goes and the oscillation stays. A second pass
 *     re-detrends with the window snapped to a whole number of vibrato periods,
 *     which cancels the oscillation's own leakage through the average (without
 *     it, extents read up to +/-8% off at some rates).
 *  3. Split the residual into LOBES: runs of one sign, with runs too small to
 *     matter (below a hysteresis amplitude) absorbed into their neighbours, so
 *     frame jitter chatter near the zero line cannot create fake cycles. Each
 *     lobe's start/end are linearly interpolated zero crossings (sub-frame
 *     timing) and its height is a local quadratic fit of the extremum (noise
 *     does not inflate peaks).
 *  4. A CHAIN is a run of consecutive lobes whose durations are plausible half
 *     cycles (2-12 Hz). Longer lobes are the trend, shorter ones are chatter.
 *     The longest chain is the vibrato; other chains are other episodes (see
 *     switch.ts).
 *  5. Rate comes two independent ways and is cross-checked: zero-crossing
 *     count over the chain's span, and the autocorrelation peak (with
 *     parabolic interpolation) of the residual. Extent is half the median
 *     peak-to-trough distance of adjacent lobes. Regularity is cycle-to-cycle
 *     rate variability (after allowing CONFIG.vibrato.rateRampAllowance of
 *     natural speeding-up) and extent variability.
 *
 * The analyzers see the raw pitch track: nothing here smooths a value that
 * is reported; the hysteresis and the quadratic peak fit only decide which
 * swings count and how tall they were.
 */
import type { PitchFrame, PitchTrack, TargetNote } from '../core/types';
import type { AnalyzeContext, VibratoFlag, VibratoResult } from './types';
import { CONFIG } from '../config';
import { centsVsTarget, cleanSpikes, framesInWindow, lowerBound, mad, median, medianSpacing, percentile, standardDeviation, trimmedMean, voicedRuns } from './track';

// ---------------------------------------------------------------- tuning with no CONFIG entry (all PROVISIONAL; see contractIssues)

/** Detector dropouts up to ~3 frames (at 94 fps) do not split a vibrato. */
const BRIDGE_GAP_SEC = 0.045;
/** Vibrato, wobble and bleat all live in this band; anything outside is trend or jitter. */
const MIN_RATE_HZ = 2;
const MAX_RATE_HZ = 12;
/** A lobe is a half cycle, so it lasts 0.5/maxRate .. 0.5/minRate seconds (a little slack on the slow side for wobbles). Longer = trend, shorter = chatter. */
const SLOW_LOBE_SLACK = 1.2;
/** A lobe only counts when its peak reaches max(HYST_MIN_CENTS, HYST_FRACTION x the residual's reference amplitude). */
const HYST_MIN_CENTS = 4;
const HYST_FRACTION = 0.25;
/** Chain ends whose lobe duration is outside this multiple of the chain's median lobe duration are edge artifacts (a scoop's tail, a trailing slide). */
const EDGE_LOBE_RATIO: readonly [number, number] = [0.55, 1.8];
/** Zero-crossing and autocorrelation rates must agree within this fraction to be averaged. */
const RATE_AGREE_REL_TOL = 0.25;
/** Autocorrelation peak height (0..1) needed when both rates agree, and when autocorrelation has to stand alone. */
const PERIODICITY_MIN = 0.4;
const PERIODICITY_STRONG = 0.6;
/** When a chain is too short for autocorrelation, trust the crossings if cycle-to-cycle rate variability is under this. */
const SHORT_CHAIN_MAX_RATE_IRREGULARITY = 0.2;
/** The autocorrelation looks this far beyond the chain on each side so a short vibrato inside a long straight tone is not diluted by the tone. */
const AUTOCORR_PAD_SEC = 0.25;
/** Residual samples are clipped at this multiple of the reference amplitude before autocorrelation (an unflagged outlier must not drown the periodicity). */
const AUTOCORR_CLIP_FACTOR = 3;
/** Regularity 0..1: a rate CV (after the allowed ramp) of RATE_CV_BAD, or an extent CV of EXTENT_CV_BAD, maps its half of the score to 0. */
const RATE_CV_BAD = 0.25;
const EXTENT_CV_BAD = 0.5;
const IRREGULAR_REGULARITY_BELOW = 0.5;
/** Per-window live estimates. */
const LIVE_WINDOW_SEC = 0.8;
const LIVE_WINDOW_STEP_SEC = 0.2;
/** A window or segment needs this many voiced frames before an estimate is attempted. */
const MIN_SEGMENT_FRAMES = 8;
/** Quadratic peak-fit half-width, in vibrato cycles (clamped to 2-4 frames). */
const PEAK_FIT_CYCLES = 0.15;
/** Reference amplitude of a residual: its 90th percentile of |r| divided by this (the 90th percentile of a sinusoid is 0.95 of its amplitude). */
const P90_OF_SINE = 0.95;

// ---------------------------------------------------------------- oscillation primitives (shared with pulse.ts and switch.ts)

/** One half cycle of the detrended oscillation. */
export interface Lobe {
  sign: 1 | -1;
  /** Interpolated zero crossings bounding the lobe (seconds). */
  startT: number;
  endT: number;
  /** Height of the lobe's extremum above/below zero (cents, >= 0). */
  amp: number;
}

/** Consecutive lobes with plausible half-cycle durations: one candidate vibrato (or pulse train) episode. */
export interface LobeChain {
  lobes: Lobe[];
  startT: number;
  endT: number;
}

export interface OscillationBand {
  /** Detrend window (seconds). */
  detrendSec: number;
  /** Plausible oscillation rates (Hz): lobes shorter/longer than half a cycle of these are not part of a chain. */
  minRateHz: number;
  maxRateHz: number;
}

export interface Detected {
  chains: LobeChain[];
  /** Detrended series aligned with the input `ts`. */
  residual: Float64Array;
  /** Reference amplitude of the residual (cents). */
  refAmp: number;
  /** Median frame spacing (seconds). */
  dt: number;
}

/** Centred moving average removed from `ys`, via a two-pointer sliding sum (O(n); `ts` ascending). Edges use the truncated window. */
export function detrend(ts: ArrayLike<number>, ys: ArrayLike<number>, windowSec: number): Float64Array {
  const n = ys.length;
  const out = new Float64Array(n);
  const half = windowSec / 2;
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = ts[i];
    while (hi < n && ts[hi] <= t + half) {
      sum += ys[hi];
      hi++;
    }
    while (lo < hi && ts[lo] < t - half) {
      sum -= ys[lo];
      lo++;
    }
    out[i] = ys[i] - sum / (hi - lo);
  }
  return out;
}

/** Linear resampling onto a uniform grid of spacing `dt` (bridges the short gaps left by dropouts). Needs >= 2 samples. */
function resampleUniform(ts: ArrayLike<number>, vals: ArrayLike<number>, dt: number): Float64Array {
  const count = ts.length;
  const t0 = ts[0];
  const n = Math.floor((ts[count - 1] - t0) / dt + 1e-9) + 1;
  const out = new Float64Array(n);
  let j = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * dt;
    while (j < count - 2 && ts[j + 1] < t) j++;
    const ta = ts[j];
    const tb = ts[j + 1];
    const u = tb > ta ? (t - ta) / (tb - ta) : 0;
    out[k] = vals[j] + (vals[j + 1] - vals[j]) * (u < 0 ? 0 : u > 1 ? 1 : u);
  }
  return out;
}

interface Run {
  sign: 1 | -1;
  startCross: number;
  peakAbs: number;
  peakIdx: number;
  i0: number;
  i1: number;
}

/** Extremum height of the lobe whose raw extremum is at `idx`, refined by a local quadratic least-squares fit (falls back to the raw sample). */
function refinedPeak(ts: ArrayLike<number>, r: ArrayLike<number>, idx: number, i0: number, i1: number, sign: number, m: number): number {
  const raw = Math.abs(r[idx]);
  const lo = Math.max(i0, idx - m);
  const hi = Math.min(i1 - 1, idx + m);
  if (hi - lo + 1 < 4) return raw;
  const tc = ts[idx];
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let u0 = 0;
  let u1 = 0;
  let u2 = 0;
  for (let j = lo; j <= hi; j++) {
    const x = ts[j] - tc;
    const y = sign * r[j];
    const x2 = x * x;
    s0 += 1;
    s1 += x;
    s2 += x2;
    s3 += x2 * x;
    s4 += x2 * x2;
    u0 += y;
    u1 += x * y;
    u2 += x2 * y;
  }
  const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
  if (Math.abs(det) < 1e-18) return raw;
  const a = (u0 * (s2 * s4 - s3 * s3) - s1 * (u1 * s4 - s3 * u2) + s2 * (u1 * s3 - s2 * u2)) / det;
  const b = (s0 * (u1 * s4 - s3 * u2) - u0 * (s1 * s4 - s3 * s2) + s2 * (s1 * u2 - u1 * s2)) / det;
  const c = (s0 * (s2 * u2 - u1 * s3) - s1 * (s1 * u2 - u1 * s2) + u0 * (s1 * s3 - s2 * s2)) / det;
  if (!(c < 0)) return raw;
  const xv = -b / (2 * c);
  if (xv < ts[lo] - tc || xv > ts[hi] - tc) return raw;
  const v = a - (b * b) / (4 * c);
  return v > 0 ? v : raw;
}

/**
 * Lobes of `r`. A sign run whose peak is below `h` is noise-level: it is
 * absorbed into the surrounding lobe instead of ending it, so chatter around
 * zero never splits a real half cycle. Only COMPLETE lobes (both bounding
 * crossings inside the data) are returned.
 */
function findLobes(ts: ArrayLike<number>, r: ArrayLike<number>, h: number, fitHalfWidth: number): Lobe[] {
  const n = r.length;
  if (n < 3) return [];
  const runs: Run[] = [];
  let runStart = 0;
  let runSign: 1 | -1 = r[0] >= 0 ? 1 : -1;
  let prevCross = NaN;
  let peakAbs = Math.abs(r[0]);
  let peakIdx = 0;
  for (let i = 1; i <= n; i++) {
    const s: 1 | -1 | 0 = i < n ? (r[i] >= 0 ? 1 : -1) : 0;
    if (s !== runSign) {
      let crossT = NaN;
      if (i < n) {
        const a = r[i - 1];
        const b = r[i];
        crossT = ts[i - 1] + (ts[i] - ts[i - 1]) * (a / (a - b)); // linear zero crossing; a and b have opposite signs so a-b != 0
      }
      runs.push({ sign: runSign, startCross: prevCross, peakAbs, peakIdx, i0: runStart, i1: i });
      prevCross = crossT;
      runStart = i;
      if (i < n) {
        runSign = s as 1 | -1;
        peakAbs = Math.abs(r[i]);
        peakIdx = i;
      }
    } else if (i < n) {
      const a = Math.abs(r[i]);
      if (a > peakAbs) {
        peakAbs = a;
        peakIdx = i;
      }
    }
  }

  const lobes: Lobe[] = [];
  let cur: Run | null = null;
  for (const run of runs) {
    const big = run.peakAbs >= h;
    if (!cur) {
      if (big) cur = { ...run };
      continue;
    }
    if (run.sign === cur.sign) {
      cur.i1 = run.i1;
      if (run.peakAbs > cur.peakAbs) {
        cur.peakAbs = run.peakAbs;
        cur.peakIdx = run.peakIdx;
      }
    } else if (big) {
      if (Number.isFinite(cur.startCross) && Number.isFinite(run.startCross)) {
        lobes.push({
          sign: cur.sign,
          startT: cur.startCross,
          endT: run.startCross,
          amp: refinedPeak(ts, r, cur.peakIdx, cur.i0, cur.i1, cur.sign, fitHalfWidth),
        });
      }
      cur = { ...run };
    } else {
      cur.i1 = run.i1; // a noise-level opposite run inside a lobe
    }
  }
  return lobes;
}

/** Splits lobes into chains of plausible half-cycle durations and trims edge artifacts. Chains shorter than 2 lobes are dropped. */
function buildChains(lobes: readonly Lobe[], minLobeSec: number, maxLobeSec: number): LobeChain[] {
  const chains: LobeChain[] = [];
  let cur: Lobe[] = [];
  const flush = (): void => {
    if (cur.length >= 2) {
      const trimmed = trimEdges(cur);
      if (trimmed.length >= 2) chains.push({ lobes: trimmed, startT: trimmed[0].startT, endT: trimmed[trimmed.length - 1].endT });
    }
    cur = [];
  };
  for (const lobe of lobes) {
    const d = lobe.endT - lobe.startT;
    if (d >= minLobeSec && d <= maxLobeSec) cur.push(lobe);
    else flush();
  }
  flush();
  return chains;
}

function trimEdges(chain: Lobe[]): Lobe[] {
  const out = chain.slice();
  if (out.length < 4) return out;
  const med = median(out.map((l) => l.endT - l.startT));
  const odd = (l: Lobe): boolean => {
    const ratio = (l.endT - l.startT) / med;
    return ratio < EDGE_LOBE_RATIO[0] || ratio > EDGE_LOBE_RATIO[1];
  };
  while (out.length >= 4 && odd(out[0])) out.shift();
  while (out.length >= 4 && odd(out[out.length - 1])) out.pop();
  return out;
}

/** The chain with the most lobes (ties: the longer span). Null for none. */
export function longestChain(chains: readonly LobeChain[]): LobeChain | null {
  let best: LobeChain | null = null;
  for (const c of chains) {
    if (!best || c.lobes.length > best.lobes.length || (c.lobes.length === best.lobes.length && c.endT - c.startT > best.endT - best.startT)) best = c;
  }
  return best;
}

/**
 * Zero-crossing rate (Hz) of a chain, from WHOLE cycles only. A chain's lobes
 * are half cycles, but for an asymmetric waveform (a short pitch bump on a long
 * flat, a skewed vibrato) the two half cycles differ in length, so dividing
 * the lobe count by the span is biased whenever the count is odd. Counting
 * complete cycles from the first crossing, and again from the second, and
 * pooling the two, is exact for any periodic shape.
 */
export function chainRateHz(chain: LobeChain): number {
  const { lobes } = chain;
  const L = lobes.length;
  const cross = (i: number): number => (i === 0 ? lobes[0].startT : lobes[i - 1].endT); // crossing i (0..L)
  const nA = Math.floor(L / 2);
  const nB = Math.floor((L - 1) / 2);
  const spanA = nA > 0 ? cross(2 * nA) - cross(0) : 0;
  const spanB = nB > 0 ? cross(1 + 2 * nB) - cross(1) : 0;
  const cycles = nA + nB;
  const span = spanA + spanB;
  return span > 0 ? cycles / span : NaN;
}

function referenceAmplitude(residual: ArrayLike<number>): number {
  const abs = new Float64Array(residual.length);
  for (let i = 0; i < abs.length; i++) abs[i] = Math.abs(residual[i]);
  return percentile(abs, 0.9) / P90_OF_SINE;
}

function onePass(ts: Float64Array, ys: Float64Array, windowSec: number, dt: number, band: OscillationBand, rateHint: number | null): Detected {
  const residual = detrend(ts, ys, windowSec);
  const refAmp = referenceAmplitude(residual);
  const h = Math.max(HYST_MIN_CENTS, HYST_FRACTION * refAmp);
  const fit = rateHint !== null ? Math.max(2, Math.min(4, Math.round(PEAK_FIT_CYCLES / (rateHint * dt)))) : 2;
  const lobes = findLobes(ts, residual, h, fit);
  const chains = buildChains(lobes, 0.5 / band.maxRateHz, (0.5 / band.minRateHz) * SLOW_LOBE_SLACK);
  return { chains, residual, refAmp, dt };
}

/**
 * Detrends `ys` and finds its oscillation chains. Two passes: the first with
 * `band.detrendSec`, the second (when the first found a plausible rate) with
 * the window snapped to a whole number of that rate's periods.
 */
export function detectOscillation(ts: Float64Array, ys: Float64Array, band: OscillationBand): Detected {
  const dt = medianSpacing(ts);
  if (!(dt > 0) || ts.length < 3) return { chains: [], residual: new Float64Array(ts.length), refAmp: 0, dt: Number.isFinite(dt) ? dt : 0 };
  const first = onePass(ts, ys, band.detrendSec, dt, band, null);
  const main = longestChain(first.chains);
  if (main && main.lobes.length >= 4) {
    const f = chainRateHz(main);
    if (f >= band.minRateHz && f <= band.maxRateHz) {
      const cycles = Math.max(2, Math.round(band.detrendSec * f));
      const w2 = cycles / f;
      if (Math.abs(w2 - band.detrendSec) > 0.02 * band.detrendSec) {
        const second = onePass(ts, ys, w2, dt, band, f);
        const main2 = longestChain(second.chains);
        if (main2 && main2.lobes.length >= 0.8 * main.lobes.length) return second;
      }
    }
  }
  return first;
}

/** Autocorrelation rate (Hz) and peak height (0..1, mean-removed, unbiased) of a uniform series, searching rates in [minHz, maxHz]. Null when nothing periodic is found. */
function autocorrRate(u: Float64Array, dt: number, minHz: number, maxHz: number): { rateHz: number; rho: number } | null {
  const n = u.length;
  if (n < 8) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += u[i];
  mean /= n;
  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += (u[i] - mean) * (u[i] - mean);
  r0 /= n;
  if (r0 <= 1e-12) return null;
  const lagMin = Math.max(2, Math.floor(1 / (maxHz * dt)));
  const lagMax = Math.min(Math.ceil(1 / (minHz * dt)), Math.floor(n * 0.5));
  if (lagMax <= lagMin + 1) return null;
  const R = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1 && lag < n; lag++) {
    let s = 0;
    for (let i = 0; i < n - lag; i++) s += (u[i] - mean) * (u[i + lag] - mean);
    R[lag] = s / (n - lag) / r0;
  }
  let best = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (R[lag] > R[lag - 1] && R[lag] >= R[lag + 1] && R[lag] > best) best = R[lag];
  }
  if (!(best > 0)) return null;
  // The FIRST strong local maximum is the period: a sinusoid's later multiples are as tall, and edge effects can make one taller.
  for (let lag = lagMin; lag <= lagMax; lag++) {
    if (R[lag] > R[lag - 1] && R[lag] >= R[lag + 1] && R[lag] >= 0.85 * best) {
      const a = R[lag - 1];
      const b = R[lag];
      const c = R[lag + 1];
      const den = a - 2 * b + c;
      const off = den < 0 ? (0.5 * (a - c)) / den : 0;
      const tau = (lag + (off < -1 ? -1 : off > 1 ? 1 : off)) * dt;
      return { rateHz: 1 / tau, rho: b < 0 ? 0 : b > 1 ? 1 : b };
    }
  }
  return null;
}

export interface ChainMeasure {
  startT: number;
  endT: number;
  lobes: number;
  /** Whole cycles = lobes / 2. */
  cycles: number;
  /** Half the median peak-to-trough distance of adjacent lobes (cents). */
  extentCents: number | null;
  extentSdCents: number | null;
  /** Robust (MAD-based) coefficient of variation of the peak-to-trough distances. */
  extentCv: number | null;
  zeroCrossingRateHz: number | null;
  autocorrRateHz: number | null;
  /** Autocorrelation peak height, 0..1. */
  periodicity: number;
  /** Cross-checked rate; null when the chain is not periodic. */
  rateHz: number | null;
  periodic: boolean;
  rateSdHz: number | null;
  /** Plain coefficient of variation (std / mean) of the cycle-to-cycle rate: a single hiccup counts. Used for metronomic pulses. */
  rateCv: number | null;
  /** Robust (MAD-based) variability of the cycle-to-cycle rate after removing a linear trend, plus any speed-up beyond the natural ramp allowance. Used for vibrato. */
  rateIrregularity: number | null;
}

/**
 * Statistics of one chain. `ts`/`residual` are the series the chain was
 * found in (the autocorrelation cross-check reads the residual around the
 * chain). `rampAllowance` is the fraction of rate change across the chain
 * that is considered natural, not irregular (0 for metronomic pulses).
 */
export function measureChain(chain: LobeChain, det: Detected, ts: Float64Array, band: OscillationBand, rampAllowance: number): ChainMeasure {
  const { lobes } = chain;
  const L = lobes.length;
  const span = chain.endT - chain.startT;
  const zcRaw = span > 0 ? chainRateHz(chain) : NaN;
  const zc = Number.isFinite(zcRaw) ? zcRaw : null;

  const crossings: number[] = [lobes[0].startT];
  for (const l of lobes) crossings.push(l.endT);
  const periods: number[] = [];
  const mids: number[] = [];
  for (let j = 0; j + 2 < crossings.length; j++) {
    periods.push(crossings[j + 2] - crossings[j]);
    mids.push((crossings[j + 2] + crossings[j]) / 2);
  }

  const p2t: number[] = [];
  for (let i = 0; i + 1 < L; i++) p2t.push(lobes[i].amp + lobes[i + 1].amp);
  const extent = p2t.length > 0 ? median(p2t) / 2 : null;
  const extentSd = p2t.length > 1 ? standardDeviation(p2t) / 2 : p2t.length === 1 ? 0 : null;
  const extentCv = p2t.length > 1 && extent !== null && extent > 0 ? (1.4826 * mad(p2t)) / (2 * extent) : p2t.length === 1 ? 0 : null;

  let rateSd: number | null = null;
  let rateCv: number | null = null;
  let rateIrr: number | null = null;
  if (periods.length >= 2) {
    const q = periods.map((p) => 1 / p);
    const qMean = q.reduce((a, b) => a + b, 0) / q.length;
    rateSd = standardDeviation(q);
    rateCv = rateSd / qMean;
    let spread = 1.4826 * mad(q);
    let excessRamp = 0;
    if (q.length >= 4) {
      const tMean = mids.reduce((a, b) => a + b, 0) / mids.length;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < q.length; i++) {
        sxx += (mids[i] - tMean) * (mids[i] - tMean);
        sxy += (mids[i] - tMean) * (q[i] - qMean);
      }
      const slope = sxx > 0 ? sxy / sxx : 0;
      const resid = q.map((v, i) => v - (qMean + slope * (mids[i] - tMean)));
      spread = 1.4826 * mad(resid);
      const ramp = (Math.abs(slope) * (mids[mids.length - 1] - mids[0])) / qMean;
      excessRamp = Math.max(0, ramp - rampAllowance);
    }
    rateIrr = spread / qMean + excessRamp;
  }

  // Autocorrelation cross-check over the chain plus a little context, outliers clipped.
  let ac: { rateHz: number; rho: number } | null = null;
  const from = chain.startT - AUTOCORR_PAD_SEC;
  const to = chain.endT + AUTOCORR_PAD_SEC;
  const idx: number[] = [];
  for (let i = 0; i < ts.length; i++) if (ts[i] >= from && ts[i] <= to) idx.push(i);
  if (idx.length >= 8) {
    const t = new Float64Array(idx.length);
    const v = new Float64Array(idx.length);
    const clip = AUTOCORR_CLIP_FACTOR * Math.max(det.refAmp, HYST_MIN_CENTS);
    for (let k = 0; k < idx.length; k++) {
      t[k] = ts[idx[k]];
      const x = det.residual[idx[k]];
      v[k] = x > clip ? clip : x < -clip ? -clip : x;
    }
    ac = autocorrRate(resampleUniform(t, v, det.dt), det.dt, band.minRateHz, band.maxRateHz);
  }

  let rateHz: number | null = null;
  let periodic = false;
  const inBand = (f: number): boolean => f >= band.minRateHz && f <= band.maxRateHz;
  if (zc !== null && ac !== null && Math.abs(zc - ac.rateHz) / ac.rateHz <= RATE_AGREE_REL_TOL && ac.rho >= PERIODICITY_MIN) {
    rateHz = (zc + ac.rateHz) / 2;
    periodic = inBand(rateHz);
  } else if (ac !== null && ac.rho >= PERIODICITY_STRONG && inBand(ac.rateHz)) {
    rateHz = ac.rateHz;
    periodic = true;
  } else if (ac === null && zc !== null && rateIrr !== null && rateIrr <= SHORT_CHAIN_MAX_RATE_IRREGULARITY && inBand(zc)) {
    rateHz = zc;
    periodic = true;
  }
  if (!periodic) rateHz = null;

  return {
    startT: chain.startT,
    endT: chain.endT,
    lobes: L,
    cycles: L / 2,
    extentCents: extent,
    extentSdCents: extentSd,
    extentCv,
    zeroCrossingRateHz: zc,
    autocorrRateHz: ac ? ac.rateHz : null,
    periodicity: ac ? ac.rho : 0,
    rateHz,
    periodic,
    rateSdHz: rateSd,
    rateCv,
    rateIrregularity: rateIrr,
  };
}

// ---------------------------------------------------------------- scope analysis

/** One continuous voiced stretch as parallel arrays: time (seconds) and cents (vs the note, or raw MIDI x 100 when there is none). */
interface Series {
  ts: Float64Array;
  ys: Float64Array;
}

/** A measured chain plus the voiced stretch it lives in. */
interface MeasuredChain {
  series: Series;
  chain: LobeChain;
  m: ChainMeasure;
}

interface ScopeAnalysis {
  /** The longest voiced stretch (centring falls back to it when there is no oscillation). Null when nothing is voiced. */
  longestRun: Series | null;
  chains: MeasuredChain[];
}

/** Only this many of a stretch's longest chains are measured (each costs an autocorrelation); a shorter one cannot become the answer. */
const MAX_CHAINS_PER_RUN = 12;

/** Voiced frames of `scope[i0, i1)` as parallel arrays. */
function seriesOf(scope: readonly PitchFrame[], i0: number, i1: number, note: TargetNote | null): Series {
  let count = 0;
  for (let i = i0; i < i1; i++) if (scope[i].voiced) count++;
  const ts = new Float64Array(count);
  const ys = new Float64Array(count);
  let k = 0;
  for (let i = i0; i < i1; i++) {
    const f = scope[i];
    if (!f.voiced) continue;
    ts[k] = f.t;
    ys[k] = note ? centsVsTarget(f, note) : f.midi * 100;
    k++;
  }
  return { ts, ys };
}

/** Detects and measures the oscillation chains of every continuous voiced stretch of `scope` (already spike-cleaned). */
function analyseScope(scope: readonly PitchFrame[], note: TargetNote | null): ScopeAnalysis {
  const band: OscillationBand = { detrendSec: CONFIG.vibrato.detrendWindowSec, minRateHz: MIN_RATE_HZ, maxRateHz: MAX_RATE_HZ };
  let longestRun: Series | null = null;
  let longestDur = -1;
  const chains: MeasuredChain[] = [];
  for (const run of voicedRuns(scope, BRIDGE_GAP_SEC)) {
    const series = seriesOf(scope, run.startIndex, run.endIndex, note);
    const n = series.ts.length;
    if (n === 0) continue;
    const dur = series.ts[n - 1] - series.ts[0];
    if (dur > longestDur) {
      longestDur = dur;
      longestRun = series;
    }
    if (n < MIN_SEGMENT_FRAMES) continue;
    const det = detectOscillation(series.ts, series.ys, band);
    const candidates = det.chains
      .slice()
      .sort((a, b) => b.lobes.length - a.lobes.length)
      .slice(0, MAX_CHAINS_PER_RUN);
    for (const chain of candidates) {
      chains.push({ series, chain, m: measureChain(chain, det, series.ts, band, CONFIG.vibrato.rateRampAllowance) });
    }
  }
  return { longestRun, chains };
}

/** True when the chain is a real vibrato by itself: at least minCycles whole cycles, periodic, and big enough not to be a straight tone's wobble. */
function isVibratoChain(m: ChainMeasure): boolean {
  return m.periodic && m.cycles >= CONFIG.vibrato.minCycles && m.extentCents !== null && m.extentCents >= CONFIG.vibrato.straightBelowExtentCents;
}

/** Trimmed mean of the series over whole oscillation cycles of `mc` (a trailing half cycle would bias it toward one lobe). */
function cycleAlignedMean(mc: MeasuredChain): number {
  const { lobes } = mc.chain;
  const whole = lobes.length - (lobes.length % 2);
  const endT = whole >= 2 ? lobes[whole - 1].endT : mc.chain.endT;
  const inside: number[] = [];
  const { ts, ys } = mc.series;
  for (let i = 0; i < ts.length; i++) if (ts[i] >= mc.chain.startT && ts[i] <= endT) inside.push(ys[i]);
  return inside.length >= 4 ? trimmedMean(inside, 0.1) : trimmedMean(ys, 0.1);
}

function regularityOf(chain: ChainMeasure): number | null {
  if (chain.rateIrregularity === null || chain.extentCv === null) return null;
  const penalty = (chain.rateIrregularity / RATE_CV_BAD + chain.extentCv / EXTENT_CV_BAD) / 2;
  return 1 - (penalty < 0 ? 0 : penalty > 1 ? 1 : penalty);
}

export interface AnalyzeVibratoOptions {
  /** Compute the per-window live estimates (default true). The live meter can turn it off and read the whole-segment result only. */
  windows?: boolean;
}

/**
 * analyzeVibrato(track, note, ctx) -- `note = null` analyzes the whole track
 * (live meter / free singing); a note analyzes the frames inside it and
 * reports centring against it. The result describes the longest oscillation
 * (chain) found. Rate, extent, regularity and the quality flags are only
 * reported when a vibrato is actually present; a straight tone reports
 * `present: false`, the `straight` flag (neutral, never an error) and, when
 * measurable, its residual wobble as `extentCents`.
 */
export function analyzeVibrato(track: PitchTrack, note: TargetNote | null, ctx: AnalyzeContext, opts: AnalyzeVibratoOptions = {}): VibratoResult {
  const scope = cleanSpikes(note ? framesInWindow(track, note.start, note.end) : track);
  const analysis = analyseScope(scope, note);
  const windows = opts.windows === false ? [] : windowsFrom(scope, analysis);

  if (!analysis.longestRun) {
    return { present: false, rateHz: null, extentCents: null, rateSdHz: null, extentSdCents: null, regularity: null, centeringCents: null, inZone: false, flags: [], windows };
  }

  let main: MeasuredChain | null = null;
  for (const c of analysis.chains) if (!main || c.m.lobes > main.m.lobes) main = c;

  const chain = main ? main.m : null;
  const spanSec = chain ? chain.endT - chain.startT : 0; // how long the oscillation itself lasted
  const extent = chain?.extentCents ?? null;
  const present = chain !== null && isVibratoChain(chain) && spanSec >= CONFIG.vibrato.minDurationSec;
  const regularity = present && chain ? regularityOf(chain) : null;
  const centeringCents = note ? (main ? cycleAlignedMean(main) : trimmedMean(analysis.longestRun.ys, 0.1)) : null;

  const zone = CONFIG.vibrato.styles[ctx.vibratoStyle];
  const rateHz = present && chain ? chain.rateHz : null;
  const inZone =
    present &&
    rateHz !== null &&
    extent !== null &&
    rateHz >= zone.rateHz[0] &&
    rateHz <= zone.rateHz[1] &&
    extent >= zone.extentCents[0] &&
    extent <= zone.extentCents[1];

  const flags = computeFlags({ present, chain, rateHz, extent, regularity, centeringCents, toleranceCents: ctx.toleranceCents, spanSec });

  return {
    present,
    rateHz,
    extentCents: extent,
    rateSdHz: present && chain ? chain.rateSdHz : null,
    extentSdCents: present && chain ? chain.extentSdCents : null,
    regularity,
    centeringCents,
    inZone,
    flags,
    windows,
  };
}

function computeFlags(p: {
  present: boolean;
  chain: ChainMeasure | null;
  rateHz: number | null;
  extent: number | null;
  regularity: number | null;
  centeringCents: number | null;
  toleranceCents: number;
  spanSec: number;
}): VibratoFlag[] {
  const flags: VibratoFlag[] = [];
  const straightBelow = CONFIG.vibrato.straightBelowExtentCents;
  // No oscillation found, or one too small to be vibrato: straight. Neutral, never an error.
  if (p.extent === null || p.extent < straightBelow) flags.push('straight');
  if (p.present && p.rateHz !== null && p.extent !== null) {
    if (p.rateHz < CONFIG.vibrato.wobbleBelowHz || p.extent > CONFIG.vibrato.wobbleAboveExtentCents) flags.push('wobble');
    if (p.rateHz > CONFIG.vibrato.bleatAboveHz) flags.push('bleat');
    if (p.regularity !== null && p.regularity < IRREGULAR_REGULARITY_BELOW) flags.push('irregular');
    if (p.centeringCents !== null) {
      if (p.centeringCents < -p.toleranceCents) flags.push('sagging-flat');
      else if (p.centeringCents > p.toleranceCents) flags.push('sharp-centred');
    }
  } else if (
    // Big, repeated swings that never settle into a rhythm: unsteady rather than vibrato.
    p.chain !== null &&
    p.extent !== null &&
    p.extent >= straightBelow &&
    p.chain.cycles >= CONFIG.vibrato.minCycles &&
    p.spanSec >= CONFIG.vibrato.minDurationSec &&
    !p.chain.periodic
  ) {
    flags.push('irregular');
  }
  return flags;
}

/**
 * Per-window live estimates, read off the lobes found once over each whole
 * voiced stretch (so a window is neither re-detrended on a truncated
 * fragment nor re-autocorrelated): the lobes lying entirely inside the window
 * give its rate and extent, and it is `present` once they make two whole
 * cycles of a chain that is a vibrato in its own right. A bloom therefore
 * shows up in the window that first holds two complete cycles.
 */
function windowsFrom(scope: readonly PitchFrame[], analysis: ScopeAnalysis): VibratoResult['windows'] {
  if (scope.length === 0) return [];
  const t0 = scope[0].t;
  const t1 = scope[scope.length - 1].t;
  const vibratoChains = analysis.chains.filter((c) => isVibratoChain(c.m));
  const out: VibratoResult['windows'] = [];
  for (let start = t0; start < t1; start += LIVE_WINDOW_STEP_SEC) {
    const end = Math.min(start + LIVE_WINDOW_SEC, t1);
    const i0 = lowerBound(scope, start);
    const i1 = lowerBound(scope, end);
    let voiced = 0;
    for (let i = i0; i < i1; i++) if (scope[i].voiced) voiced++;
    if (voiced < MIN_SEGMENT_FRAMES) {
      out.push({ start, end, rateHz: null, extentCents: null, present: false });
      continue;
    }
    let lobes = 0;
    let spanSec = 0;
    const p2t: number[] = [];
    for (const c of vibratoChains) {
      let first = -1;
      let last = -1;
      const ls = c.chain.lobes;
      for (let i = 0; i < ls.length; i++) {
        if (ls[i].startT >= start && ls[i].endT <= end) {
          if (first === -1) first = i;
          last = i;
        }
      }
      if (first === -1) continue;
      lobes += last - first + 1;
      spanSec += ls[last].endT - ls[first].startT;
      for (let i = first; i < last; i++) p2t.push(ls[i].amp + ls[i + 1].amp);
    }
    const extent = p2t.length > 0 ? median(p2t) / 2 : null;
    const present =
      lobes >= 2 * CONFIG.vibrato.minCycles &&
      spanSec >= CONFIG.vibrato.minDurationSec &&
      extent !== null &&
      extent >= CONFIG.vibrato.straightBelowExtentCents;
    out.push({ start, end, rateHz: present && spanSec > 0 ? lobes / (2 * spanSec) : null, extentCents: extent, present });
  }
  return out;
}

// ---------------------------------------------------------------- episodes (used by switch.ts)

/** A stretch of the take where vibrato was actually being sung. */
export interface VibratoEpisode {
  startT: number;
  endT: number;
  rateHz: number;
  extentCents: number;
}

/**
 * Every vibrato episode in `frames` (take-relative, spike-cleaned inside):
 * chains of at least 2 x minCycles lobes, extent at least the straight
 * threshold and periodic, in time order. Episodes separated by less than
 * `mergeGapSec` (a hiccup lobe) are merged. `startT`/`endT` are the first and
 * last zero crossing of the episode's lobes, i.e. sub-frame accurate onset and
 * offset times, not detection-window-delayed ones.
 */
export function findVibratoEpisodes(frames: PitchTrack, mergeGapSec = 0.3): VibratoEpisode[] {
  const scope = cleanSpikes(frames);
  const band: OscillationBand = { detrendSec: CONFIG.vibrato.detrendWindowSec, minRateHz: MIN_RATE_HZ, maxRateHz: MAX_RATE_HZ };
  const raw: VibratoEpisode[] = [];
  for (const run of voicedRuns(scope, BRIDGE_GAP_SEC)) {
    const { ts, ys } = seriesOf(scope, run.startIndex, run.endIndex, null);
    if (ts.length < MIN_SEGMENT_FRAMES) continue;
    const det = detectOscillation(ts, ys, band);
    for (const chain of det.chains) {
      if (chain.lobes.length < 2 * CONFIG.vibrato.minCycles) continue;
      const m = measureChain(chain, det, ts, band, CONFIG.vibrato.rateRampAllowance);
      if (m.periodic && m.rateHz !== null && m.extentCents !== null && m.extentCents >= CONFIG.vibrato.straightBelowExtentCents) {
        raw.push({ startT: m.startT, endT: m.endT, rateHz: m.rateHz, extentCents: m.extentCents });
      }
    }
  }
  raw.sort((a, b) => a.startT - b.startT);
  const merged: VibratoEpisode[] = [];
  for (const e of raw) {
    const last = merged[merged.length - 1];
    if (last && e.startT - last.endT <= mergeGapSec) {
      const span = last.endT - last.startT;
      const add = e.endT - e.startT;
      last.rateHz = (last.rateHz * span + e.rateHz * add) / (span + add);
      last.extentCents = (last.extentCents * span + e.extentCents * add) / (span + add);
      last.endT = Math.max(last.endT, e.endT);
    } else {
      merged.push({ ...e });
    }
  }
  return merged;
}
