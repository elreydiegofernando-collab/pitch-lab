/**
 * Pure layout math for the take replay (TraceReplay, docs/DESIGN.md §13.5): which pitches the window shows, how wide the
 * time axis has to be, which lanes get a name, how the sung track splits into colour runs, and where the run verdicts
 * sit. No DOM and no canvas, so every rule is unit tested.
 */
import type { RunNoteVerdict, RunResult } from '../../analysis/types';
import { percentile, targetMidiAt } from '../../analysis/track';
import type { PitchFrame, TargetNote } from '../../core/types';
import { midiToY } from '../pitch-view/geometry';

// ---------------------------------------------------------------- the visible pitch window

/** Visible pitch range, fractional MIDI (the same meaning as PitchView.setRange). */
export interface PitchWindow {
  low: number;
  high: number;
}

export interface FitOptions {
  /** Semitones of room above and below the material. Default 2.5 (a note and a half). */
  margin?: number;
  /** The window is at least this many semitones tall. Default 12. */
  minSpan?: number;
  /** A take widens the window only this far past the material, so one wild octave jump cannot squash the targets. Default 9. */
  maxOffPitch?: number;
}

const DEFAULT_MARGIN = 2.5;
const DEFAULT_MIN_SPAN = 12;
const DEFAULT_MAX_OFF_PITCH = 9;
/** Needs this many voiced frames before the take can widen the window. */
const MIN_VOICED_FOR_FIT = 8;
/** When there is nothing to fit (no notes and no singing): around the middle of a male voice. */
const FALLBACK_CENTRE = 57;

/** Lowest and highest pitch the targets touch (glide ends included); null for no notes. */
export function noteExtent(notes: readonly TargetNote[]): { lo: number; hi: number } | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    if (n.midi < lo) lo = n.midi;
    if (n.midi > hi) hi = n.midi;
    if (n.toMidi !== undefined) {
      if (n.toMidi < lo) lo = n.toMidi;
      if (n.toMidi > hi) hi = n.toMidi;
    }
  }
  return lo === Infinity ? null : { lo, hi };
}

/**
 * The pitch window for a set of targets, optionally widened to hold most of what was sung. The Sing screen fits the
 * targets alone (so the live view and the preview share one window); the report also fits the take.
 */
export function fitPitchWindow(notes: readonly TargetNote[], track: readonly PitchFrame[] = [], opts: FitOptions = {}): PitchWindow {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const minSpan = opts.minSpan ?? DEFAULT_MIN_SPAN;
  const maxOff = opts.maxOffPitch ?? DEFAULT_MAX_OFF_PITCH;
  const extent = noteExtent(notes);
  let lo = extent ? extent.lo : NaN;
  let hi = extent ? extent.hi : NaN;

  const sung: number[] = [];
  for (const f of track) if (f.voiced && Number.isFinite(f.midi)) sung.push(f.midi);
  if (sung.length >= MIN_VOICED_FOR_FIT) {
    const low = percentile(sung, 0.02);
    const high = percentile(sung, 0.98);
    lo = extent ? Math.min(lo, Math.max(low, extent.lo - maxOff)) : low;
    hi = extent ? Math.max(hi, Math.min(high, extent.hi + maxOff)) : high;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = FALLBACK_CENTRE;
    hi = FALLBACK_CENTRE;
  }

  lo -= margin;
  hi += margin;
  if (hi - lo < minSpan) {
    const centre = (hi + lo) / 2;
    lo = centre - minSpan / 2;
    hi = centre + minSpan / 2;
  }
  return { low: lo, high: hi };
}

/**
 * The lanes that get a name: every pitch the targets use, then the C of each octave, skipping any whose label would
 * sit closer than `minGapPx` to one already placed (a chromatic run would otherwise stack its names). Highest first.
 */
export function pickLabelMidis(notes: readonly TargetNote[], win: PitchWindow, heightPx: number, minGapPx = 14): number[] {
  const first = Math.ceil(win.low);
  const last = Math.floor(win.high);
  const priority = new Map<number, number>();
  const want = (m: number, p: number): void => {
    const r = Math.round(m);
    if (r >= first && r <= last) priority.set(r, Math.max(priority.get(r) ?? 0, p));
  };
  for (const n of notes) {
    want(n.midi, 2);
    if (n.toMidi !== undefined) want(n.toMidi, 2);
  }
  for (let m = first; m <= last; m++) if (((m % 12) + 12) % 12 === 0) want(m, 1);

  const order = [...priority.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([m]) => m);
  const ys = (m: number): number => midiToY(m, win.low, win.high, heightPx);
  const placed: number[] = [];
  for (const m of order) if (placed.every((p) => Math.abs(ys(p) - ys(m)) >= minGapPx)) placed.push(m);
  return placed.sort((a, b) => b - a);
}

// ---------------------------------------------------------------- the time axis

/** Seconds of room before the downbeat and after the last step, so the first and last notes are not pressed to the edge. */
export const REPLAY_LEAD_SEC = 0.3;
export const REPLAY_TAIL_SEC = 0.4;

export interface ReplayLayoutInput {
  /** Time covered by the axis (seconds). */
  spanSec: number;
  /** Width of the box the replay sits in (CSS px). */
  hostWidth: number;
  padLeft: number;
  padRight: number;
  /** The tightest gap between two run notes (minRunGapSec); null when no glyphs are drawn. */
  minGapSec: number | null;
  /** Run glyphs need this much room per note. Default 12. */
  minSpacingPx?: number;
  /** The canvas never grows past this (CSS px). Default 3200 (4096 backing pixels at DPR 1.25 still fits an iPhone canvas). */
  maxWidth?: number;
}

export interface ReplayLayout {
  /** Canvas width, CSS px. */
  width: number;
  pxPerSec: number;
  /** The canvas is wider than its box: it scrolls inside its own row. */
  scrolls: boolean;
}

const DEFAULT_MIN_SPACING_PX = 12;
const DEFAULT_MAX_WIDTH = 3200;

/**
 * Fit the take into the box; when run notes are packed tighter than a glyph (nine notes a second on a phone), widen the
 * canvas until each one has room, up to a cap. The page itself never scrolls sideways: the row does.
 */
export function replayLayout(input: ReplayLayoutInput): ReplayLayout {
  const { spanSec, hostWidth, padLeft, padRight, minGapSec } = input;
  const minSpacing = input.minSpacingPx ?? DEFAULT_MIN_SPACING_PX;
  const maxWidth = input.maxWidth ?? DEFAULT_MAX_WIDTH;
  const inner = Math.max(1, hostWidth - padLeft - padRight);
  const span = Math.max(0.001, spanSec);
  let pxPerSec = inner / span;
  if (minGapSec !== null && minGapSec > 0) pxPerSec = Math.max(pxPerSec, minSpacing / minGapSec);
  pxPerSec = Math.min(pxPerSec, Math.max(inner / span, (maxWidth - padLeft - padRight) / span));
  const width = padLeft + padRight + span * pxPerSec;
  return { width, pxPerSec, scrolls: width > hostWidth + 1 };
}

// ---------------------------------------------------------------- the sung trace, split into colour runs

/** 0 = no target at that moment (a rest), 1 = inside the tolerance band, 2 = outside it. */
export type TraceColor = 0 | 1 | 2;

export interface TraceSegment {
  color: TraceColor;
  t: number[];
  midi: number[];
}

/** Two voiced frames further apart than this are separate lines (a gap is drawn as a gap). */
const MAX_LINK_GAP_SEC = 0.06;

/** The target pitch at take time `t`, or NaN between notes. `notes` must be sorted by start. */
function targetAt(notes: readonly TargetNote[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const note = lo > 0 ? notes[lo - 1] : undefined;
  return note && t < note.end ? targetMidiAt(note, t) : NaN;
}

/**
 * The voiced frames of a take as runs of one colour (DESIGN.md §8: blue inside the band, orange outside, the plain
 * trace where nothing is asked). Where the colour changes, the next run starts from the last point of the previous
 * one, so the line stays whole. Unvoiced frames, and gaps longer than a few frames, break the line.
 */
export function traceSegments(track: readonly PitchFrame[], notes: readonly TargetNote[], toleranceCents: number, maxGapSec = MAX_LINK_GAP_SEC): TraceSegment[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const out: TraceSegment[] = [];
  let current: TraceSegment | null = null;
  let prevT = -Infinity;
  let prevMidi = NaN;
  for (const f of track) {
    if (!f.voiced || !Number.isFinite(f.midi)) {
      current = null;
      continue;
    }
    const target = targetAt(sorted, f.t);
    const color: TraceColor = Number.isNaN(target) ? 0 : Math.abs((f.midi - target) * 100) <= toleranceCents ? 1 : 2;
    const linked = current !== null && f.t - prevT <= maxGapSec;
    if (!linked || current === null) {
      current = { color, t: [f.t], midi: [f.midi] };
      out.push(current);
    } else if (current.color !== color) {
      current = { color, t: [prevT, f.t], midi: [prevMidi, f.midi] };
      out.push(current);
    } else {
      current.t.push(f.t);
      current.midi.push(f.midi);
    }
    prevT = f.t;
    prevMidi = f.midi;
  }
  return out;
}

// ---------------------------------------------------------------- run verdict glyphs

export interface RunGlyph {
  /** Take time of the note's centre. */
  t: number;
  /** The note's target pitch. */
  midi: number;
  verdict: RunNoteVerdict;
}

/** One glyph per scored run note, at the centre of its target bar. */
export function runGlyphs(runs: ReadonlyArray<{ notes: readonly TargetNote[]; result: RunResult }>): RunGlyph[] {
  const out: RunGlyph[] = [];
  for (const run of runs) {
    for (const r of run.result.notes) {
      const note = run.notes[r.index];
      if (note) out.push({ t: (note.start + note.end) / 2, midi: note.midi, verdict: r.verdict });
    }
  }
  return out;
}

/** The tightest gap between two consecutive run notes (note centres), or null when there are fewer than two. */
export function minRunGapSec(runs: ReadonlyArray<{ notes: readonly TargetNote[] }>): number | null {
  let min = Infinity;
  for (const run of runs) {
    for (let i = 1; i < run.notes.length; i++) {
      const gap = (run.notes[i].start + run.notes[i].end) / 2 - (run.notes[i - 1].start + run.notes[i - 1].end) / 2;
      if (gap > 0 && gap < min) min = gap;
    }
  }
  return min === Infinity ? null : min;
}

/** How many run notes got each verdict. */
export function verdictCounts(glyphs: readonly RunGlyph[]): Record<RunNoteVerdict, number> {
  const counts: Record<RunNoteVerdict, number> = { defined: 0, smeared: 0, missed: 0 };
  for (const g of glyphs) counts[g.verdict]++;
  return counts;
}
