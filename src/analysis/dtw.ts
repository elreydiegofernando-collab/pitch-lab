/**
 * Banded alignment of a sung PitchTrack to an ordered sequence of target notes
 * ({midi, start, end}: satisfied by TargetNote and by a mapped SongNote). Used by
 * runs.ts and inflections.ts (tight corridor, plain cents) and phrases.ts (wide
 * corridor, optionally octave-folded cents).
 *
 * This is DTW specialised for "many frames, few notes". Every note gets a
 * contiguous, monotonically ordered, possibly EMPTY block of frames (empty = the
 * note was skipped: the "missed note" case) rather than a general many-to-many
 * warping path:
 *   - a voiced frame may be assigned only to a note whose corridor
 *     [start - band, end + band] contains it, at a cost of its pitch distance
 *     (capped, so one glitch frame cannot dominate) plus a small penalty that grows
 *     with how far outside the note's own [start, end] it sits (ties go to the
 *     nominal slot);
 *   - assigned blocks follow the note order (no swaps);
 *   - skipping a note costs nothing; an unvoiced frame, or a voiced frame outside
 *     every corridor, is consumed for free. A voiced frame inside some corridor MUST
 *     be paid for by a note: otherwise it could always dodge its cost by riding a
 *     free note-skip into a neighbouring column, and every note would end up empty.
 *
 * The cost of a block boundary is minimised where the pitch crosses the midpoint
 * between the two notes, so a block's first frame is a good, tempo-independent
 * estimate of when the singer changed note (`onsetOffsetMs`).
 *
 * Because unvoiced and out-of-corridor frames never change the DP state, only the
 * "active" frames are processed, and each of those only against the few notes whose
 * corridor contains it: O(active frames x notes per corridor). Storage is one Int32Array
 * of backpointers (one cell per active frame/feasible note pair) plus small rolling
 * rows: a 4-minute song at 94 fps aligns in a few milliseconds.
 */
import type { PitchTrack } from '../core/types';
import { centsOff } from '../core/music';
import { lowerBound } from './track';

/** Structural subset of TargetNote/SongNote that alignment needs. */
export interface DtwNote {
  midi: number;
  start: number;
  end: number;
}

export interface DtwAlignment {
  /** Per note: [startIdx, endIdx) of the track frames assigned to it (first to last assigned), or null if the note's block is empty. */
  ranges: Array<{ startIdx: number; endIdx: number } | null>;
  /** Per note: (first assigned frame's time - note.start) * 1000 ms; null if unaligned. + = late. */
  onsetOffsetMs: Array<number | null>;
  /** Per track frame: the index of the note it was assigned to, or -1 (unvoiced, outside every corridor, or none). */
  frameToNote: Int32Array;
  /** Total path cost in cents-equivalent; lower = better fit. 0 when nothing was alignable. */
  totalCost: number;
  /** Voiced frames inside at least one corridor: the frames the DP actually processes. */
  activeFrames: number;
  /**
   * Cells of the banded DP: one per (active frame, note whose corridor holds it) pair, which is also the size of the backpointer array. It is
   * at most activeFrames x the number of corridors that overlap one instant (a few), NOT activeFrames x notes: a ten-minute, 1,200-note song
   * is about 0.1 MB of backpointers, not 200 MB. Exposed so a test can pin that structure instead of a wall-clock budget that a loaded machine breaks.
   */
  cells: number;
}

export interface DtwOptions {
  /** Corridor half-width around each note's own [start, end], in ms. */
  bandMs: number;
  /** Cents distance between a frame's pitch and a note's reference pitch. Default: plain |signed cents|. Use `octaveFoldedDistance` for octave-agnostic scoring. */
  pitchDistanceCents?: (frameMidi: number, noteMidi: number) => number;
  /** Cost (cents-equivalent) of a frame sitting a full band outside its note's [start, end]; scales linearly. Default 30. */
  timePenaltyCents?: number;
  /** Cap on one frame's pitch cost, cents. Default 600. */
  maxFrameCostCents?: number;
}

/** No CONFIG slot for DTW costs yet (see contractIssues); these are PROVISIONAL local stand-ins. */
const DEFAULT_TIME_PENALTY_CENTS = 30;
const DEFAULT_MAX_FRAME_COST_CENTS = 600;

function defaultDistance(frameMidi: number, noteMidi: number): number {
  return Math.abs(centsOff(frameMidi, noteMidi));
}

/** `frameMidi` shifted by whole octaves to the octave nearest `noteMidi`. */
export function foldToNearestOctave(frameMidi: number, noteMidi: number): number {
  return frameMidi - Math.round((frameMidi - noteMidi) / 12) * 12;
}

/** Octave-agnostic cents distance: folds `frameMidi` to the octave nearest `noteMidi` before comparing. */
export function octaveFoldedDistance(frameMidi: number, noteMidi: number): number {
  return Math.abs(centsOff(foldToNearestOctave(frameMidi, noteMidi), noteMidi));
}

/**
 * Aligns `track` to `notes` (ascending, non-overlapping `start`/`end`). Each note
 * comes back with the contiguous frame range assigned to it (or null if nothing
 * was) and its onset offset versus the nominal time; `frameToNote` gives the
 * per-frame assignment.
 */
export function alignNotesDtw(track: PitchTrack, notes: readonly DtwNote[], opts: DtwOptions): DtwAlignment {
  const n = track.length;
  const m = notes.length;
  const frameToNote = new Int32Array(n).fill(-1);
  const ranges: DtwAlignment['ranges'] = new Array(m).fill(null);
  const onsetOffsetMs: DtwAlignment['onsetOffsetMs'] = new Array(m).fill(null);
  if (n === 0 || m === 0) return { ranges, onsetOffsetMs, frameToNote, totalCost: 0, activeFrames: 0, cells: 0 };

  const bandSec = Math.max(0, opts.bandMs) / 1000;
  const dist = opts.pitchDistanceCents ?? defaultDistance;
  const cap = opts.maxFrameCostCents ?? DEFAULT_MAX_FRAME_COST_CENTS;
  const timePen = opts.timePenaltyCents ?? DEFAULT_TIME_PENALTY_CENTS;

  // Corridor frame range [lo, hi) per note, forced monotone so the feasible notes of a frame form one contiguous range.
  const lo = new Int32Array(m);
  const hi = new Int32Array(m);
  for (let j = 0; j < m; j++) {
    let l = lowerBound(track, notes[j].start - bandSec);
    let h = lowerBound(track, notes[j].end + bandSec + 1e-9);
    if (j > 0) {
      if (l < lo[j - 1]) l = lo[j - 1];
      if (h < hi[j - 1]) h = hi[j - 1];
    }
    if (h < l) h = l;
    lo[j] = l;
    hi[j] = h;
  }

  // Active frames: voiced and inside at least one corridor. Everything else never affects the DP.
  const fi = new Int32Array(n);
  const jMin = new Int32Array(n);
  const jMax = new Int32Array(n);
  const cellOff = new Int32Array(n);
  let K = 0;
  let cells = 0;
  let maxW = 1;
  let pMin = 0;
  let pMax = -1;
  for (let i = 0; i < n; i++) {
    while (pMin < m && hi[pMin] <= i) pMin++;
    while (pMax + 1 < m && lo[pMax + 1] <= i) pMax++;
    const f = track[i];
    if (!f.voiced || !Number.isFinite(f.midi) || pMin >= m || pMin > pMax) continue;
    fi[K] = i;
    jMin[K] = pMin;
    jMax[K] = pMax;
    cellOff[K] = cells;
    const w = pMax - pMin + 1;
    cells += w;
    if (w > maxW) maxW = w;
    K++;
  }
  if (K === 0) return { ranges, onsetOffsetMs, frameToNote, totalCost: 0, activeFrames: 0, cells: 0 };

  const back = new Int32Array(cells);
  let fPrev = new Float64Array(maxW);
  let fCur = new Float64Array(maxW);
  const runMin = new Float64Array(maxW);
  const runArg = new Int32Array(maxW);
  let prevA = 0;
  let prevB = -1;

  for (let k = 0; k < K; k++) {
    const c0 = jMin[k];
    const d0 = jMax[k];
    const frame = track[fi[k]];
    if (k > 0) {
      // Prefix-min over the previous frame's states: best cost with last-assigned note <= L.
      let best = Infinity;
      let bestL = -1;
      for (let L = prevA; L <= prevB; L++) {
        const v = fPrev[L - prevA];
        if (v < best) {
          best = v;
          bestL = L;
        }
        runMin[L - prevA] = best;
        runArg[L - prevA] = bestL;
      }
    }
    for (let j = c0; j <= d0; j++) {
      let g = 0;
      let arg = -1;
      if (k > 0) {
        const idx = (j < prevB ? j : prevB) - prevA;
        g = idx >= 0 ? runMin[idx] : Infinity;
        arg = idx >= 0 ? runArg[idx] : -1;
      }
      const note = notes[j];
      let cost = dist(frame.midi, note.midi);
      if (cost > cap) cost = cap;
      if (bandSec > 0) {
        const over = Math.max(0, note.start - frame.t, frame.t - note.end);
        cost += timePen * (over >= bandSec ? 1 : over / bandSec);
      }
      fCur[j - c0] = g + cost;
      back[cellOff[k] + (j - c0)] = arg;
    }
    const tmp = fPrev;
    fPrev = fCur;
    fCur = tmp;
    prevA = c0;
    prevB = d0;
  }

  // Best final state, then trace the assignment back.
  let bestJ = prevA;
  let bestCost = Infinity;
  for (let j = prevA; j <= prevB; j++) {
    const v = fPrev[j - prevA];
    if (v < bestCost) {
      bestCost = v;
      bestJ = j;
    }
  }
  let j = bestJ;
  for (let k = K - 1; k >= 0; k--) {
    frameToNote[fi[k]] = j;
    j = back[cellOff[k] + (j - jMin[k])];
  }

  const first = new Int32Array(m).fill(-1);
  const last = new Int32Array(m).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = frameToNote[i];
    if (a < 0) continue;
    if (first[a] < 0) first[a] = i;
    last[a] = i;
  }
  for (let q = 0; q < m; q++) {
    if (first[q] < 0) continue;
    ranges[q] = { startIdx: first[q], endIdx: last[q] + 1 };
    onsetOffsetMs[q] = (track[first[q]].t - notes[q].start) * 1000;
  }
  return { ranges, onsetOffsetMs, frameToNote, totalCost: Number.isFinite(bestCost) ? bestCost : 0, activeFrames: K, cells };
}
