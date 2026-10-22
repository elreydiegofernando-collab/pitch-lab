/**
 * Helpers shared by every analyzer (Phase 2). Pure functions over a
 * take-relative PitchTrack; nothing here mutates its input. Every function
 * makes one pass (or a binary search plus one pass over its result), so a
 * 60 s take costs well under a millisecond per helper. Exported for
 * analysis-advanced and for the Wave 2 runner / live meters.
 *
 * Note on PitchFrame: the Framer fills `midi`/`f0Hz` for EVERY frame it
 * emits, voiced or not (an unvoiced frame carries the detector's
 * low-confidence guess). So nothing in here, or in any analyzer, may treat
 * "midi is finite" as "voiced": always test `frame.voiced`.
 */
import type { PitchFrame, PitchTrack, TargetNote } from '../core/types';
import { clamp01 } from '../core/math';
import { centsOff } from '../core/music';

// ---------------------------------------------------------------- voiced runs

/** One contiguous run of voiced frames, as indices into the track it was built from. */
export interface VoicedRun {
  startIndex: number;
  /** Exclusive. */
  endIndex: number;
  startT: number;
  endT: number;
}

/**
 * Contiguous runs of `frame.voiced === true`, in order. Empty when nothing
 * is voiced.
 *
 * `maxGapSec` bridges dropouts: two runs whose nearest voiced frames are at
 * most this far apart (in time) become one run, so a one-to-three-frame
 * detector dropout in the middle of a held note does not split it. A
 * bridged run's index range still contains the unvoiced frames inside the
 * gap, so callers must filter on `.voiced` when they read it. Default 0 =
 * strict (any unvoiced frame ends the run).
 */
export function voicedRuns(track: PitchTrack, maxGapSec = 0): VoicedRun[] {
  const runs: VoicedRun[] = [];
  let start = -1;
  let last = -1;
  const close = (): void => {
    if (start === -1) return;
    const prev = runs[runs.length - 1];
    if (prev && maxGapSec > 0 && track[start].t - prev.endT <= maxGapSec) {
      prev.endIndex = last + 1;
      prev.endT = track[last].t;
    } else {
      runs.push({ startIndex: start, endIndex: last + 1, startT: track[start].t, endT: track[last].t });
    }
    start = -1;
  };
  for (let i = 0; i < track.length; i++) {
    if (track[i].voiced) {
      if (start === -1) start = i;
      last = i;
    } else {
      close();
    }
  }
  close();
  return runs;
}

// ---------------------------------------------------------------- target pitch & cents

/**
 * Fractional MIDI the target expects at take time `t`. Holds `note.midi`
 * for a plain sustained note; interpolates linearly (in MIDI, i.e. in
 * log-frequency) from `note.midi` to `note.toMidi` across [start, end) for
 * a glide. Extrapolates by holding the nearer endpoint outside the note's
 * span, so callers never need to pre-clip `t`.
 */
export function targetMidiAt(note: TargetNote, t: number): number {
  if (note.toMidi === undefined || note.end === note.start) return note.midi;
  const u = clamp01((t - note.start) / (note.end - note.start));
  return note.midi + (note.toMidi - note.midi) * u;
}

/** Signed cents of `frame` vs `note`'s expected pitch at `frame.t` (positive = sharp). NaN when `frame` is unvoiced. */
export function centsVsTarget(frame: PitchFrame, note: TargetNote): number {
  if (!frame.voiced || !Number.isFinite(frame.midi)) return NaN;
  return centsOff(frame.midi, targetMidiAt(note, frame.t));
}

// ---------------------------------------------------------------- windows

/** First index in [0, n) at which `before(i)` is false, where it is true for a prefix and false after it. Binary search. */
function firstNotBefore(n: number, before: (i: number) => boolean): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the first element of the ascending time array `ts` with `ts[i] >= time` (`ts.length` when none). */
export function lowerBoundTimes(ts: ArrayLike<number>, time: number): number {
  return firstNotBefore(ts.length, (i) => ts[i] < time);
}

/** Index of the first frame with `t >= time` (track.length when none). Binary search; the track must be sorted by `t`. */
export function lowerBound(track: PitchTrack, time: number): number {
  return firstNotBefore(track.length, (i) => track[i].t < time);
}

/** Index range [lo, hi) of the frames with `start <= t < end`; never inverted (`hi >= lo`). */
export function frameRange(track: PitchTrack, start: number, end: number): { lo: number; hi: number } {
  const lo = lowerBound(track, start);
  return { lo, hi: Math.max(lo, lowerBound(track, end)) };
}

/** Frames with `start <= t < end`, in order. Does not require `voiced`. O(log n + k). */
export function framesInWindow(track: PitchTrack, start: number, end: number): PitchFrame[] {
  const { lo, hi } = frameRange(track, start, end);
  return lo < hi ? track.slice(lo, hi) : [];
}

// ---------------------------------------------------------------- held portion

/**
 * The "held" part of a target note, for accuracy/dynamics: voiced frames
 * inside [note.start, note.end), after skipping `holdStartSkipMs` from the
 * note's own onset (its first voiced frame at or after note.start) -- the
 * onset analyzer owns that opening stretch, so accuracy and friends should
 * not double-count it. [] when the note is never voiced.
 */
export function heldPortion(track: PitchTrack, note: TargetNote, holdStartSkipMs: number): PitchFrame[] {
  const inNote = framesInWindow(track, note.start, note.end);
  const onset = inNote.find((f) => f.voiced);
  if (!onset) return [];
  const skipUntil = onset.t + holdStartSkipMs / 1000;
  return inNote.filter((f) => f.voiced && f.t >= skipUntil);
}

// ---------------------------------------------------------------- spike cleaning

/*
 * Detector glitches for analysis. No CONFIG.* entry owns these (they are
 * detector-glitch cleanup, not singing-technique thresholds) -- reported in
 * contractIssues as proposed CONFIG.analysis knobs.
 */
/** A glitch lasts at most this many frames; a real note shorter than ~3 frames (30 ms) cannot be sung. */
const SPIKE_RUN_MAX_FRAMES = 2;
/** "~12 semitones", read as +/-100 cents around an octave so an imperfect-harmonic jump still counts. */
const OCTAVE_SPIKE_CENTS: readonly [number, number] = [1100, 1300];
/** Any other isolated jump this large (3+ semitones) is also physically impossible to sing in 1-2 frames and return. */
const BIG_SPIKE_MIN_CENTS = 300;
/** The pitch must come back to within this many cents of where it was for a jump to count as a glitch. */
const SPIKE_RETURN_TOL_CENTS = 60;
/** Neighbours further apart in time than this are not "adjacent": a real silence or another note lies between. */
const SPIKE_NEIGHBOUR_MAX_GAP_SEC = 0.06;

/**
 * Marks isolated 1-2 frame octave-jump glitches (the detector locks onto a
 * harmonic for a frame or two, then the true fundamental returns) as
 * unvoiced. Never smooths or interpolates their pitch value -- analyzers
 * simply treat them as a short unvoiced gap, same as a breath. Also catches
 * a glitch at the very start or end of a voiced stretch (compared against
 * the stable frames next to it). A genuine octave leap that stays on the new
 * pitch is left alone. Returns a new array; `track`'s frame objects are
 * never mutated.
 */
export function cleanOctaveSpikes(track: PitchTrack): PitchFrame[] {
  return markSpikes(track, OCTAVE_SPIKE_CENTS[0], OCTAVE_SPIKE_CENTS[1]);
}

/**
 * `cleanOctaveSpikes` widened to any isolated 1-2 frame jump of 3+ semitones
 * that returns (octave errors, fifth/twelfth harmonic locks, consonant
 * pops). This is what the analyzers call: one 300-cent frame in a 200-frame
 * hold would otherwise inflate the standard deviation four-fold or split a
 * vibrato lobe in two. Same contract: marks unvoiced, never smooths, never
 * mutates its input.
 */
export function cleanSpikes(track: PitchTrack): PitchFrame[] {
  return markSpikes(track, BIG_SPIKE_MIN_CENTS, Infinity);
}

function markSpikes(track: PitchTrack, minCents: number, maxCents: number): PitchFrame[] {
  const out: PitchFrame[] = track.slice();
  const n = out.length;
  const usable = (k: number): boolean => out[k].voiced && Number.isFinite(out[k].midi);
  const cents = (a: number, b: number): number => Math.abs(centsOff(out[a].midi, out[b].midi));
  const isJump = (a: number, ref: number): boolean => {
    const c = cents(a, ref);
    return c >= minCents && c <= maxCents;
  };
  /** Nearest usable frame strictly before `i`, if it is close enough in time to count as adjacent; -1 otherwise. */
  const before = (i: number): number => {
    for (let k = i - 1; k >= 0; k--) {
      if (out[i].t - out[k].t > SPIKE_NEIGHBOUR_MAX_GAP_SEC) return -1;
      if (usable(k)) return k;
    }
    return -1;
  };
  /** Nearest usable frame at index >= `from`, if it is close enough in time to the frame at `ref`; -1 otherwise. */
  const after = (from: number, ref: number): number => {
    for (let k = from; k < n; k++) {
      if (out[k].t - out[ref].t > SPIKE_NEIGHBOUR_MAX_GAP_SEC) return -1;
      if (usable(k)) return k;
    }
    return -1;
  };

  let i = 0;
  while (i < n) {
    if (!usable(i)) {
      i++;
      continue;
    }
    const prev = before(i);
    let marked = 0;
    for (let len = 1; len <= SPIKE_RUN_MAX_FRAMES && i + len <= n; len++) {
      const last = i + len - 1;
      if (!usable(last)) break; // the run must be consecutive usable frames
      const next = after(last + 1, last);
      let spike = false;
      if (prev >= 0) {
        let allJump = true;
        for (let k = i; k <= last; k++) if (!isJump(k, prev)) allJump = false;
        if (allJump) {
          if (next >= 0) {
            spike = cents(next, prev) <= SPIKE_RETURN_TOL_CENTS; // jumped away and came back
          } else {
            const pp = before(prev); // tail glitch: nothing follows, and the pitch was steady before it
            spike = pp >= 0 && cents(pp, prev) <= SPIKE_RETURN_TOL_CENTS;
          }
        }
      } else if (next >= 0) {
        let allJump = true;
        for (let k = i; k <= last; k++) if (!isJump(k, next)) allJump = false;
        if (allJump) {
          const nn = after(next + 1, next); // head glitch: the pitch that follows is steady
          spike = nn >= 0 && cents(nn, next) <= SPIKE_RETURN_TOL_CENTS;
        }
      }
      if (spike) {
        marked = len;
        break;
      }
    }
    if (marked > 0) {
      for (let k = i; k < i + marked; k++) out[k] = { ...out[k], voiced: false };
      i += marked;
    } else {
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- robust stats

/** Sorted Float64Array copy of `xs` (numeric ascending; typed-array sort needs no comparator). */
function sortedCopy(xs: ArrayLike<number>): Float64Array {
  const s = Float64Array.from(xs as ArrayLike<number>);
  s.sort();
  return s;
}

/** Median of `xs[lo..hi)`. NaN for an empty range. Copies the range (it is small: one note or one window); never mutates `xs`. */
export function medianRange(xs: ArrayLike<number>, lo: number, hi: number): number {
  const n = hi - lo;
  if (n <= 0) return NaN;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = xs[lo + i];
  s.sort();
  const mid = n >> 1;
  return n % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Median of `xs`. NaN for an empty input. Never mutates `xs`. */
export function median(xs: ArrayLike<number>): number {
  return medianRange(xs, 0, xs.length);
}

/** Median absolute deviation from the median (raw, not scaled to a normal sigma). NaN for an empty input. */
export function mad(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const m = median(xs);
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) dev[i] = Math.abs(xs[i] - m);
  return median(dev);
}

/** `p`-quantile of `xs` (`p` in [0,1], linear interpolation between ranks). NaN for an empty input. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const s = sortedCopy(xs);
  const pos = (p < 0 ? 0 : p > 1 ? 1 : p) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Mean after dropping the lowest and highest `fraction` (0..0.5) of values: a mean that shrugs off a few glitch frames. NaN for an empty input. */
export function trimmedMean(xs: ArrayLike<number>, fraction = 0.1): number {
  const n = xs.length;
  if (n === 0) return NaN;
  const s = sortedCopy(xs);
  const cut = Math.min(Math.floor(n * Math.max(0, fraction)), (n - 1) >> 1);
  let sum = 0;
  for (let i = cut; i < n - cut; i++) sum += s[i];
  return sum / (n - 2 * cut);
}

/** Population standard deviation. NaN for an empty input, 0 for a single value. */
export function standardDeviation(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n === 0) return NaN;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += xs[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (xs[i] - mean) * (xs[i] - mean);
  variance /= n;
  return Math.sqrt(variance);
}

// ---------------------------------------------------------------- running filters

/** Half-width of a centred window `width` samples wide. An even width is rounded up to the next odd one so the window stays centred; below 3 there is no window to speak of. */
function windowHalf(width: number): number {
  return width >= 3 ? Math.floor(width / 2) : 0;
}

/** Inserts `v` into the ascending `a[0..size)` and returns the new size. `a` must have room for one more. */
function insertSorted(a: Float64Array, size: number, v: number): number {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  a.copyWithin(lo + 1, lo, size);
  a[lo] = v;
  return size + 1;
}

/** Removes one element equal to `v` from the ascending `a[0..size)` and returns the new size. `v` must be in there. */
function removeSorted(a: Float64Array, size: number, v: number): number {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  a.copyWithin(lo, lo + 1, size);
  return size - 1;
}

/**
 * Centred running median of `xs`: out[i] is the median of the `width` samples around i
 * (an even `width` is rounded up to the next odd one; below 3 returns a copy). Near the two ends the window
 * shrinks to what is there rather than padding, so the first and last samples are medians of about half a window.
 * A glitch shorter than half the window cannot move it at all, which is why this (not a moving average) is what
 * separates a pitch's centre line from detector spikes. O(n * width) with a sorted window kept up to date
 * incrementally, so it costs well under a millisecond for a 60 s take at a 0.3 s window and allocates only its output and one window.
 *
 * `xs` must hold finite numbers (a NaN would corrupt the sorted window): filter first.
 */
export function runningMedian(xs: ArrayLike<number>, width: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  const half = windowHalf(width);
  const win = new Float64Array(Math.min(2 * half + 1, n));
  let size = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const wantLo = i > half ? i - half : 0;
    const wantHi = i + half + 1 < n ? i + half + 1 : n;
    while (lo < wantLo) size = removeSorted(win, size, xs[lo++]); // leave first: the window never holds more than it has room for
    while (hi < wantHi) size = insertSorted(win, size, xs[hi++]);
    const mid = size >> 1;
    out[i] = size & 1 ? win[mid] : (win[mid - 1] + win[mid]) / 2;
  }
  return out;
}

/**
 * Centred running mean of `xs`, windowed like `runningMedian` (an even `width` is rounded up to odd, the window
 * shrinks at the ends, below 3 returns a copy). Linear time. A mean over a window of w samples attenuates an
 * oscillation of frequency f by |sin(pi f w dt) / (pi f w dt)|, which is what removes the ripple a median leaves
 * behind on a vibrato. `xs` must hold finite numbers.
 */
export function runningMean(xs: ArrayLike<number>, width: number): Float64Array {
  const n = xs.length;
  const out = new Float64Array(n);
  const half = windowHalf(width);
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const wantLo = i > half ? i - half : 0;
    const wantHi = i + half + 1 < n ? i + half + 1 : n;
    while (hi < wantHi) sum += xs[hi++];
    while (lo < wantLo) sum -= xs[lo++];
    out[i] = sum / (hi - lo);
  }
  return out;
}

export interface LinearFit {
  slope: number;
  intercept: number;
}

/**
 * Ordinary-least-squares fit `y = slope*x + intercept` over the points `[from, to)` (default: all of them).
 * Null for < 2 points or degenerate (zero-variance) `xs`.
 */
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>, from = 0, to = Math.min(xs.length, ys.length)): LinearFit | null {
  const n = to - from;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = from; i < to; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = from; i < to; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/** Theil-Sen is O(n^2): beyond this many points the inputs are thinned by an even stride (deterministic) first. */
const THEIL_SEN_MAX_POINTS = 400;

/**
 * Theil-Sen (robust) slope: the median of all pairwise slopes between
 * distinct x values. Resists the few outlier frames (an onset scoop, a
 * breath) that would swing an OLS slope. O(n^2), so inputs longer than
 * THEIL_SEN_MAX_POINTS are first thinned with an even stride -- callers with
 * long, oscillating series (a vibrato riding a swell) should reduce them to
 * block medians themselves before calling, as dynamics.ts does, because a
 * stride can alias a periodic ripple. Null for < 2 points or when every pair
 * is vertical (duplicate x values only).
 */
export function theilSenSlope(xs: ArrayLike<number>, ys: ArrayLike<number>): number | null {
  const total = Math.min(xs.length, ys.length);
  if (total < 2) return null;
  const stride = total > THEIL_SEN_MAX_POINTS ? Math.ceil(total / THEIL_SEN_MAX_POINTS) : 1;
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < total; i += stride) {
    px.push(xs[i]);
    py.push(ys[i]);
  }
  const n = px.length;
  const slopes: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = px[j] - px[i];
      if (dx !== 0) slopes.push((py[j] - py[i]) / dx);
    }
  }
  return slopes.length === 0 ? null : median(slopes);
}

/** Pearson correlation coefficient of `xs` vs `ys`, in [-1, 1]. Null for < 2 points or either series having zero variance. */
export function correlation(xs: ArrayLike<number>, ys: ArrayLike<number>): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------- frame spacing & rebasing

/** Median gap between `n` consecutive times read through `timeAt`. NaN for n < 2. Robust to an occasional dropped block. */
function medianGap(n: number, timeAt: (i: number) => number): number {
  if (n < 2) return NaN;
  const gaps = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) gaps[i - 1] = timeAt(i) - timeAt(i - 1);
  return median(gaps);
}

/** Median spacing between consecutive frames' `t` (seconds). NaN for < 2 frames. Robust to an occasional dropped block. */
export function estimateFrameDt(track: PitchTrack): number {
  return medianGap(track.length, (i) => track[i].t);
}

/** The same for a plain ascending time array (a voiced Contour's `t`, a vibrato stretch's times). NaN for < 2 samples. */
export function medianSpacing(ts: ArrayLike<number>): number {
  return medianGap(ts.length, (i) => ts[i]);
}

/**
 * Rebases raw AudioContext-timeline frames so t=0 is the exercise downbeat,
 * net of round-trip latency: `t' = frame.t - downbeatT - latencyMs/1000`
 * (the round trip is already a single scalar by the time it reaches here --
 * see docs/ARCHITECTURE.md's "Timebase" note). Pure; input order and every
 * other field are preserved.
 */
export function toTakeRelative(frames: readonly PitchFrame[], downbeatT: number, latencyMs: number): PitchFrame[] {
  const offset = downbeatT + latencyMs / 1000;
  return frames.map((f) => ({ ...f, t: f.t - offset }));
}
