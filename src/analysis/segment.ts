/**
 * Voiced contours and note-plateau segmentation (SPEC 8.5 runs, legato).
 *
 * Two jobs live here because every advanced analyzer needs them:
 *  1. `voicedContour`: the voiced frames of a PitchTrack window in typed arrays, with an
 *     edge-preserving median-of-3 so a single glitch frame cannot fake a pitch event.
 *     (Windowing, medians and frame spacing are track.ts: `frameRange`, `medianRange`,
 *     `medianSpacing`.)
 *  2. `segmentPlateaus`: splits a sung track into stable note plateaus (a new plateau
 *     when the median pitch moves by about a semitone and stays there). Tuned for fast
 *     material: at 12 notes/s a note is ~83 ms (~8 frames at the ~94 fps hop), so the
 *     confirmation window guarding against jitter is only a couple of frames, and the
 *     transitional frames between plateaus are trimmed off each segment.
 *
 * Pure. No CONFIG slot owns the segmentation knobs yet (docs/RESEARCH.md 6: the
 * ~1-semitone rule has no number behind it), so the DEFAULT_* consts below are
 * clearly-named local stand-ins, overridable per call. See contractIssues.
 */
import type { PitchTrack } from '../core/types';
import { linearFit, mad, median, medianRange, medianSpacing } from './track';

/** Pitch change (semitones) that starts a candidate new plateau. */
const DEFAULT_SPLIT_SEMITONES = 1;
/** A candidate level must hold this long (or to the end of the voiced stretch) before the split is confirmed. */
const DEFAULT_CONFIRM_MS = 25;
/** Frames at a segment's edges further than this from its median are transition, not plateau, and are trimmed. */
const DEFAULT_TRIM_CENTS = 60;
/** Plateaus shorter than this are dropped (a single transitional frame is not a note). */
const DEFAULT_MIN_SEGMENT_MS = 30;
/** A candidate split starts at this fraction of the split size (a true step lands a little short of it after jitter) and must then confirm at CONFIRM_FRACTION of it. */
const CANDIDATE_FRACTION = 0.7;
const CONFIRM_FRACTION = 0.8;
/** Voiced frames closer than this belong to one stretch: bridges a one-frame detector flicker. */
const GAP_BRIDGE_SEC = 0.025;
/** The median-of-3 only mixes neighbours that are at most this far apart in time (not across a real gap). */
const SMOOTH_MAX_GAP_SEC = 0.03;

// ---------------------------------------------------------------- voiced contour

/** Two voiced frames this many hops apart or fewer (or closer) are contiguous in time; farther apart means a gap (a dropout or silence). */
export const CONTIGUOUS_GAP_FRAMES = 1.6;

/** Voiced frames of a track window in typed arrays (struct of arrays), ascending in time. */
export interface Contour {
  length: number;
  t: Float64Array;
  /** Raw fractional MIDI as detected. */
  midi: Float64Array;
  /** Gap-aware median-of-3 of `midi`: kills 1-frame glitches, keeps real steps sharp. */
  smooth: Float64Array;
  rmsDb: Float64Array;
  confidence: Float64Array;
  /** Index of each element in the source track. */
  index: Int32Array;
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** The voiced frames of `track[lo..hi)` as a Contour. Non-finite pitches are treated as unvoiced. */
export function voicedContour(track: PitchTrack, lo = 0, hi = track.length): Contour {
  const start = Math.max(0, lo);
  const end = Math.min(hi, track.length);
  let count = 0;
  for (let i = start; i < end; i++) if (track[i].voiced && Number.isFinite(track[i].midi)) count++;
  const t = new Float64Array(count);
  const midi = new Float64Array(count);
  const rmsDb = new Float64Array(count);
  const confidence = new Float64Array(count);
  const index = new Int32Array(count);
  let k = 0;
  for (let i = start; i < end; i++) {
    const f = track[i];
    if (!f.voiced || !Number.isFinite(f.midi)) continue;
    t[k] = f.t;
    midi[k] = f.midi;
    rmsDb[k] = f.rmsDb;
    confidence[k] = f.confidence;
    index[k] = i;
    k++;
  }
  const smooth = new Float64Array(midi);
  for (let j = 1; j < count - 1; j++) {
    if (t[j] - t[j - 1] <= SMOOTH_MAX_GAP_SEC && t[j + 1] - t[j] <= SMOOTH_MAX_GAP_SEC) {
      smooth[j] = median3(midi[j - 1], midi[j], midi[j + 1]);
    }
  }
  return { length: count, t, midi, smooth, rmsDb, confidence, index };
}

// ---------------------------------------------------------------- plateau segmentation

/** One stable stretch of pitch (a sung note, or a held part of one). */
export interface NoteSegment {
  /** First frame, as an index into the track the segment was built from. */
  startIdx: number;
  /** Exclusive: one past the last frame. */
  endIdx: number;
  startT: number;
  /** Time of the last frame. */
  endT: number;
  /** Median MIDI of the segment's frames. */
  medianMidi: number;
  /** Robust spread (1.4826 * MAD) of the frames around the median, cents. Small = a steady plateau. */
  spreadCents: number;
  /** Linear-fit slope across the segment, cents per second. Large = it is a glide, not a plateau. */
  slopeCentsPerSec: number;
  /** Voiced frames in the segment. */
  frames: number;
}

export interface SegmentOptions {
  /** Pitch change (semitones) that starts a candidate new plateau. Default 1. */
  splitSemitones?: number;
  /** The candidate level must hold this long (or to the end of the voiced stretch) before the split is confirmed. Default 25 ms. */
  confirmMs?: number;
  /** Edge frames further than this from the segment median are trimmed as transition. Default 60 cents. */
  trimCents?: number;
  /** Segments shorter than this are dropped. Default 30 ms. */
  minSegmentMs?: number;
}

/**
 * Splits each voiced stretch of `track` into note plateaus. A new plateau starts
 * when the pitch departs the current plateau's running median by at least
 * `splitSemitones` AND the next `confirmMs` of frames agree on the new level, so
 * one noisy frame cannot cut a note in two. Silence (a gap longer than a
 * one-frame flicker) is always a boundary. Each segment is then trimmed of the
 * transitional frames at its edges, so `startT..endT` is the plateau itself.
 */
export function segmentPlateaus(track: PitchTrack, opts: SegmentOptions = {}): NoteSegment[] {
  const splitCents = (opts.splitSemitones ?? DEFAULT_SPLIT_SEMITONES) * 100;
  const confirmSec = (opts.confirmMs ?? DEFAULT_CONFIRM_MS) / 1000;
  const trimCents = opts.trimCents ?? DEFAULT_TRIM_CENTS;
  const minSec = (opts.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS) / 1000;
  const c = voicedContour(track);
  const dt = medianSpacing(c.t);
  const frameSec = Number.isFinite(dt) ? dt : 0;
  const segments: NoteSegment[] = [];

  const emit = (from: number, to: number): void => {
    let a = from;
    let b = to;
    const m0 = medianRange(c.smooth, a, b);
    while (a < b && Math.abs(c.smooth[a] - m0) * 100 > trimCents) a++;
    while (b > a && Math.abs(c.smooth[b - 1] - m0) * 100 > trimCents) b--;
    if (b - a < 1) return;
    if (c.t[b - 1] - c.t[a] + frameSec < minSec) return;
    const frames = c.midi.subarray(a, b);
    segments.push({
      startIdx: c.index[a],
      endIdx: c.index[b - 1] + 1,
      startT: c.t[a],
      endT: c.t[b - 1],
      medianMidi: median(frames),
      spreadCents: 1.4826 * mad(frames) * 100,
      slopeCentsPerSec: fitSlopeCentsPerSec(c.t, c.midi, a, b),
      frames: b - a,
    });
  };

  let a = 0;
  while (a < c.length) {
    let b = a + 1;
    while (b < c.length && c.t[b] - c.t[b - 1] <= GAP_BRIDGE_SEC) b++;

    // One voiced stretch [a, b). `sorted[0..count)` holds the current segment's smoothed pitches in order, so the running median is a lookup.
    let segStart = a;
    const sorted = new Float64Array(b - a);
    let count = 0;
    const add = (v: number): void => {
      let lo = 0;
      let hi = count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      sorted.copyWithin(lo + 1, lo, count);
      sorted[lo] = v;
      count++;
    };
    const runningMedian = (): number => (count % 2 === 1 ? sorted[count >> 1] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2);
    add(c.smooth[a]);
    let level = c.smooth[a];
    for (let k = a + 1; k < b; k++) {
      if (Math.abs(c.smooth[k] - level) * 100 >= CANDIDATE_FRACTION * splitCents) {
        let e = k;
        while (e + 1 < b && c.t[e + 1] - c.t[k] < confirmSec) e++;
        const cand = medianRange(c.smooth, k, e + 1);
        let agree = Math.abs(cand - level) * 100 >= CONFIRM_FRACTION * splitCents;
        for (let q = k; agree && q <= e; q++) if (Math.abs(c.smooth[q] - cand) * 100 >= splitCents) agree = false;
        if (agree) {
          emit(segStart, k);
          segStart = k;
          count = 0;
        }
      }
      add(c.smooth[k]);
      level = runningMedian();
    }
    emit(segStart, b);
    a = b;
  }
  return segments;
}

/** Least-squares slope of `midi` (semitones) vs `t` over [a, b), in cents per second. 0 for < 3 points. */
export function fitSlopeCentsPerSec(t: ArrayLike<number>, midi: ArrayLike<number>, a: number, b: number): number {
  if (b - a < 3) return 0;
  const fit = linearFit(t, midi, a, b);
  return fit === null ? 0 : fit.slope * 100;
}
