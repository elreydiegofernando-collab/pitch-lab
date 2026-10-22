/**
 * Run / riff scoring (SPEC 8.5). The sung contour is DTW-aligned to the target note
 * sequence (dtw.ts, corridor CONFIG.runs.dtwBandMs), then each note gets:
 *
 *  - reached: the longest contiguous stretch within +/-CONFIG.runs.reachedTolCents of
 *    the target must last CONFIG.runs.reachedMinMs (each frame counts as one hop);
 *  - medianErrorCents: signed error of the note's own pitch level (below);
 *  - definition (0..1): how much of the note was spent on a distinct plateau versus
 *    smeared between neighbours. The note's OWN level is its densest cluster of frames
 *    (the mode of the aligned block, so a stray tail of a neighbour's pitch cannot drag
 *    it, and a distinct note that is simply flat is still "defined": its inaccuracy is
 *    scored by accuracy, not as a smear). Definition is the time spent in that cluster,
 *    divided by the plateau a clean singer can achieve at this tempo (the note's slot
 *    minus TRANSITION_ALLOWANCE_MS for the moves in and out, never less than half the
 *    slot), capped at 1, and then scaled down if the cluster is not flat. Two things stop
 *    a slur from passing as a run. The cluster is narrow where the notes are close: its
 *    half-width is a fraction of the interval to the nearest note of a different pitch
 *    (CONFIG.runs.definitionBand*), so one glide through notes a semitone apart, which spends ~50 ms
 *    inside a fixed +/-25 c band at 9 notes/s, spends ~25 ms inside +/-12 c. And the
 *    frames in the cluster must not be sliding: a voice moving through the cluster at
 *    nearly the speed of a plain slide through the interval (CONFIG.runs.definitionSlide*) is
 *    sweeping, not singing the note. (The band alone leaves a slow slur through a chain of
 *    semitones with enough dwell inside it to pass; the slide test removes what is left.);
 *  - timingErrorMs: when the singer changed to this note versus its metronome slot
 *    (the DTW block boundary sits where the pitch crosses the midpoint between notes);
 *  - verdict. defined = reached with definition >= DEFINED_MIN_DEFINITION. smeared = the
 *    pitch passed through or near the note (came within NEAR_MISS_CENTS of it) but it was
 *    not landed: a swoop too fast to reach, a long slide in, a blur. missed = nothing near
 *    the note at all: silence, skipped, or a clearly different pitch.
 *
 * run score = CONFIG.runs.weights . {reached, accuracy, definition, timing}. Accuracy
 * scales with the LEVEL's tolerance (ctx.toleranceCents: a miss of one tolerance is worth
 * 0.6, 2.5 tolerances is worth 0), timing allows TIMING_FREE_MS of slack (the detector
 * cannot resolve finer) and falls to 0 at the corridor edge. Notes that were not reached
 * score 0 for accuracy, definition and timing.
 *
 * `alignedNoteStats` exposes the per-note measurements so inflections.ts can score a
 * turn (a short run around one pitch) with exactly the same eyes.
 *
 * The definition band and slide knobs are CONFIG.runs entries (PROVISIONAL, real-voice corpus); the TIMING and
 * ACCURACY knobs below are still local PROVISIONAL consts.
 */
import type { PitchTrack } from '../core/types';
import type { AnalyzeRun, RunNoteResult, RunResult } from './types';
import { CONFIG } from '../config';
import { clamp01 } from '../core/math';
import { alignNotesDtw, type DtwNote } from './dtw';
import { CONTIGUOUS_GAP_FRAMES, voicedContour, type Contour } from './segment';
import { medianSpacing, theilSenSlope } from './track';

/**
 * "On pitch" for definition: within this of the note's own level. Half-width = CONFIG.runs.definitionBandFraction of the interval to the
 * nearest note of a different pitch in the run, so that a slide through closely spaced notes cannot count as dwelling on them; never wider
 * than the perceptual mistuning threshold (CONFIG.tolerance.default, this constant) and never narrower than CONFIG.runs.definitionBandMinCents,
 * the scatter of a steady voice.
 *
 * The slide test is relative too: how fast the cluster slides, as a fraction of the speed one slide through this interval within this slot
 * would have (interval / slot). Up to CONFIG.runs.definitionSlideFree it is a held note, from definitionSlideZero up the voice was sweeping
 * through it (linear in between). Relative, because what a clean run looks like depends on the tempo: through the detector's 43 ms window
 * even a clean 12 notes/s run has no flat plateau left.
 */
const DEFINITION_BAND_MAX_CENTS = CONFIG.tolerance.default;
/** A reached note with definition below this is "smeared". */
const DEFINED_MIN_DEFINITION = 0.6;
/** A note that was not landed is "smeared" (not "missed") if the pitch came within this of it at some point. */
const NEAR_MISS_CENTS = 100;
/** Time a clean singer spends moving into and out of a note, ms. */
const TRANSITION_ALLOWANCE_MS = 40;
/** A clean note is expected to be on its plateau for at least this share of its slot, however fast the tempo. */
const MIN_EXPECTED_PLATEAU_FRACTION = 0.5;
/** Timing slack: within this of the slot scores full marks (latency calibration and the 43 ms window cannot resolve finer). */
const TIMING_FREE_MS = 25;
/** The accuracy score reaches 0 at this many tolerances of median error. */
const ACCURACY_ZERO_TOLERANCES = 2.5;
const FALLBACK_DT_SEC = 512 / 48000;

/**
 * The densest cluster of `a[lo..hi)` that fits in a window `width` wide (same units as
 * `a`): its frame count, its median and the values it spans (`from`..`to`, so its members
 * can be picked out again). Ties go to the cluster whose median is nearest `prefer`. The
 * block is one note's frames, so n is small; a sort and two pointers suffice.
 */
function densestCluster(a: ArrayLike<number>, lo: number, hi: number, width: number, prefer: number): { count: number; level: number; from: number; to: number } {
  const n = hi - lo;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = a[lo + i];
  s.sort();
  let bestCount = 0;
  let bestLevel = NaN;
  let bestFrom = NaN;
  let bestTo = NaN;
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) j = i;
    while (j < n && s[j] - s[i] <= width) j++;
    const count = j - i;
    const mid = i + (count >> 1);
    const level = count % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
    if (count > bestCount || (count === bestCount && Math.abs(level - prefer) < Math.abs(bestLevel - prefer))) {
      bestCount = count;
      bestLevel = level;
      bestFrom = s[i];
      bestTo = s[j - 1];
    }
  }
  return { count: bestCount, level: bestLevel, from: bestFrom, to: bestTo };
}

/**
 * Slope (cents/s) of the contour elements of [k0, k1] whose pitch lies in [from, to]: the MEDIAN of the pairwise slopes (Theil-Sen), so the
 * one or two frames at a held note's edges, where the voice is still arriving or already leaving, do not make it look like it is sliding,
 * while a cluster that is mostly a ramp still reads as the ramp's speed. 0 for fewer than 3 frames.
 */
function clusterSlope(c: Contour, k0: number, k1: number, from: number, to: number): number {
  const ts: number[] = [];
  const ys: number[] = [];
  for (let k = k0; k <= k1; k++) {
    const y = c.smooth[k];
    if (y < from || y > to) continue;
    ts.push(c.t[k]);
    ys.push(y);
  }
  if (ts.length < 3) return 0;
  const slope = theilSenSlope(ts, ys);
  return slope === null ? 0 : slope * 100;
}

/** Cents from `notes[j]` to the nearest note of a different pitch, either side (Infinity when the whole run is one pitch). */
function nearestOtherPitchCents(notes: readonly DtwNote[], j: number): number {
  let best = Infinity;
  for (let q = j - 1; q >= 0; q--) {
    if (notes[q].midi !== notes[j].midi) {
      best = Math.abs(notes[q].midi - notes[j].midi) * 100;
      break;
    }
  }
  for (let q = j + 1; q < notes.length; q++) {
    if (notes[q].midi !== notes[j].midi) {
      best = Math.min(best, Math.abs(notes[q].midi - notes[j].midi) * 100);
      break;
    }
  }
  return best;
}

/** What the aligner and the contour say about one target note. */
export interface AlignedNoteStat {
  index: number;
  /** Voiced frames aligned to the note (0 = nothing aligned: skipped or silent). */
  frames: number;
  /** Longest contiguous time within CONFIG.runs.reachedTolCents of the target, ms. */
  reachedMs: number;
  /** The note's own pitch level (MIDI): median of its densest cluster. NaN when nothing aligned. */
  level: number;
  /** Signed cents of `level` vs the target; null when nothing aligned. */
  levelErrorCents: number | null;
  /** 0..1, see the module doc. 0 when nothing aligned. */
  definition: number;
  /** Closest the pitch came to the target, cents (Infinity when nothing aligned). */
  closestCents: number;
  /** Take time of the first aligned frame; null when nothing aligned. */
  startT: number | null;
  /** First aligned frame vs the note's nominal start, ms (+ = late); null when nothing aligned. */
  onsetOffsetMs: number | null;
}

/** DTW-aligns `track` to `notes` (corridor `bandMs`) and measures each note. See the module doc. */
export function alignedNoteStats(track: PitchTrack, notes: readonly DtwNote[], bandMs: number): AlignedNoteStat[] {
  const m = notes.length;
  const out: AlignedNoteStat[] = new Array(m);
  const alignment = alignNotesDtw(track, notes, { bandMs });
  const c = voicedContour(track);
  const dtRaw = medianSpacing(c.t);
  const dt = Number.isFinite(dtRaw) && dtRaw > 0 ? dtRaw : FALLBACK_DT_SEC;
  const reachedTol = CONFIG.runs.reachedTolCents;

  // Contour elements of each note. Assignment is monotone, so each note's elements are one contiguous range.
  const first = new Int32Array(m).fill(-1);
  const last = new Int32Array(m).fill(-1);
  for (let k = 0; k < c.length; k++) {
    const j = alignment.frameToNote[c.index[k]];
    if (j < 0) continue;
    if (first[j] < 0) first[j] = k;
    last[j] = k;
  }

  for (let j = 0; j < m; j++) {
    const note = notes[j];
    const k0 = first[j];
    const k1 = last[j];
    const stat: AlignedNoteStat = {
      index: j,
      frames: 0,
      reachedMs: 0,
      level: NaN,
      levelErrorCents: null,
      definition: 0,
      closestCents: Infinity,
      startT: null,
      onsetOffsetMs: null,
    };
    out[j] = stat;
    if (k0 < 0) continue;

    stat.frames = k1 - k0 + 1;
    stat.startT = c.t[k0];
    stat.onsetOffsetMs = alignment.onsetOffsetMs[j];

    // Longest contiguous in-band stretch; closest approach.
    let runStart = -1;
    let prev = -1;
    for (let k = k0; k <= k1; k++) {
      const off = Math.abs(c.smooth[k] - note.midi) * 100;
      if (off < stat.closestCents) stat.closestCents = off;
      if (off <= reachedTol) {
        const contiguous = prev >= 0 && c.t[k] - c.t[prev] <= CONTIGUOUS_GAP_FRAMES * dt;
        if (runStart < 0 || !contiguous) runStart = k;
        const ms = (c.t[k] - c.t[runStart] + dt) * 1000;
        if (ms > stat.reachedMs) stat.reachedMs = ms;
        prev = k;
      } else {
        runStart = -1;
        prev = -1;
      }
    }

    // The note's own level: its densest cluster of frames (ties go to the one nearest the target). The cluster is narrow where the notes are close.
    const otherCents = nearestOtherPitchCents(notes, j);
    const halfWidth = Math.min(DEFINITION_BAND_MAX_CENTS, Math.max(CONFIG.runs.definitionBandMinCents, CONFIG.runs.definitionBandFraction * otherCents));
    const own = densestCluster(c.smooth, k0, k1 + 1, (2 * halfWidth) / 100, note.midi);
    stat.level = own.level;
    stat.levelErrorCents = (own.level - note.midi) * 100;
    if (k1 > k0) {
      const slot = Math.max(1e-3, note.end - note.start);
      const expected = Math.max(MIN_EXPECTED_PLATEAU_FRACTION * slot, slot - TRANSITION_ALLOWANCE_MS / 1000);
      // How fast the cluster slides, against how fast one slide through this interval within this slot would have to be.
      const glideSpeed = otherCents / slot;
      const sliding = Number.isFinite(glideSpeed) && glideSpeed > 0 ? Math.abs(clusterSlope(c, k0, k1, own.from, own.to)) / glideSpeed : 0;
      const flat = clamp01(1 - (sliding - CONFIG.runs.definitionSlideFree) / (CONFIG.runs.definitionSlideZero - CONFIG.runs.definitionSlideFree));
      stat.definition = clamp01((own.count * dt) / expected) * flat;
    }
  }
  return out;
}

/** analyzeRun(track, notes, ctx) - one RunNoteResult per `notes` entry, plus the combined run score. */
export const analyzeRun: AnalyzeRun = (track, notes, ctx): RunResult => {
  const { reachedMinMs, dtwBandMs, weights } = CONFIG.runs;
  const m = notes.length;
  if (m === 0) return { notes: [], score: 0, components: { reached: 0, accuracy: 0, definition: 0, timing: 0 } };

  const tol = ctx.toleranceCents > 0 ? ctx.toleranceCents : CONFIG.tolerance.default;
  const stats = alignedNoteStats(track, notes, dtwBandMs);

  const results: RunNoteResult[] = new Array(m);
  let sumReached = 0;
  let sumAccuracy = 0;
  let sumDefinition = 0;
  let sumTiming = 0;

  for (let j = 0; j < m; j++) {
    const s = stats[j];
    const reached = s.reachedMs >= reachedMinMs;
    const verdict: RunNoteResult['verdict'] = reached
      ? s.definition >= DEFINED_MIN_DEFINITION
        ? 'defined'
        : 'smeared'
      : s.closestCents <= NEAR_MISS_CENTS
        ? 'smeared'
        : 'missed';
    const timingErrorMs = reached ? s.onsetOffsetMs : null;

    sumReached += Math.min(1, s.reachedMs / reachedMinMs);
    if (reached) {
      if (s.levelErrorCents !== null) sumAccuracy += clamp01(1 - Math.abs(s.levelErrorCents) / (ACCURACY_ZERO_TOLERANCES * tol));
      sumDefinition += s.definition;
      if (timingErrorMs !== null) {
        sumTiming += clamp01(1 - Math.max(0, Math.abs(timingErrorMs) - TIMING_FREE_MS) / Math.max(1, dtwBandMs - TIMING_FREE_MS));
      }
    }

    results[j] = {
      index: j,
      targetMidi: notes[j].midi,
      reached,
      reachedMs: s.reachedMs,
      medianErrorCents: s.levelErrorCents,
      definition: reached ? s.definition : 0,
      timingErrorMs,
      verdict,
    };
  }

  const components = {
    reached: sumReached / m,
    accuracy: sumAccuracy / m,
    definition: sumDefinition / m,
    timing: sumTiming / m,
  };
  const score = clamp01(
    weights.reached * components.reached + weights.accuracy * components.accuracy + weights.definition * components.definition + weights.timing * components.timing,
  );
  return { notes: results, score, components };
};
