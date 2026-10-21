/**
 * Pure layout math for the pitch canvas: pitch <-> y, time <-> x, the
 * semitone lane grid, and the auto-range re-centring decision. No DOM, no
 * Canvas, no state - easy to unit test and safe to call from the render loop
 * (nothing here allocates except `computeLanes`, which only runs when the
 * static layer repaints).
 */
import { isAccidental, noteName, type Notation } from '../../core/music';

/** Pixel y of a (possibly fractional) MIDI note. Higher pitch sits nearer the top. */
export function midiToY(midi: number, lowMidi: number, highMidi: number, height: number): number {
  const span = highMidi - lowMidi;
  if (!(span > 0)) return height / 2;
  return (height * (highMidi - midi)) / span;
}

/** Inverse of {@link midiToY}. */
export function yToMidi(y: number, lowMidi: number, highMidi: number, height: number): number {
  if (!(height > 0)) return (lowMidi + highMidi) / 2;
  return highMidi - (y / height) * (highMidi - lowMidi);
}

/** The time-axis geometry needed by {@link tToX}/{@link xToT}. */
export interface TimeAxis {
  width: number;
  /** Seconds of history visible left of the now-line. */
  pastSeconds: number;
  /** Seconds of upcoming targets visible right of the now-line. */
  futureSeconds: number;
  /** Now-line position as a fraction of `width` (CONFIG.display.nowLineFraction). */
  nowLineFraction: number;
}

/** Pixel x of time `t` (seconds, same clock as `tNow`). Past is linear left of the now-line, future linear right of it. */
export function tToX(t: number, tNow: number, axis: TimeAxis): number {
  const nowX = axis.width * axis.nowLineFraction;
  const dt = t - tNow;
  if (dt <= 0) {
    return axis.pastSeconds > 0 ? nowX + (dt / axis.pastSeconds) * nowX : nowX;
  }
  const rightWidth = axis.width - nowX;
  return axis.futureSeconds > 0 ? nowX + (dt / axis.futureSeconds) * rightWidth : nowX;
}

/** Inverse of {@link tToX}. */
export function xToT(x: number, tNow: number, axis: TimeAxis): number {
  const nowX = axis.width * axis.nowLineFraction;
  if (x <= nowX) {
    return nowX > 0 ? tNow + ((x - nowX) / nowX) * axis.pastSeconds : tNow;
  }
  const rightWidth = axis.width - nowX;
  return rightWidth > 0 ? tNow + ((x - nowX) / rightWidth) * axis.futureSeconds : tNow;
}

/** One semitone lane of the piano-roll grid (static layer). */
export interface Lane {
  /** Integer MIDI note this lane represents. */
  midi: number;
  yTop: number;
  yBottom: number;
  accidental: boolean;
  /** True for C (the octave boundary; drawn with a thicker separator and an emphasised label). */
  isC: boolean;
  label: string;
}

/**
 * `noteName()` allocates a fresh string every call, but the label for a given (midi, notation)
 * pair never changes. Cache all 128 MIDI values the first time either notation is needed, so
 * repeatedly rebuilding the lane grid - e.g. once per rAF frame while an auto-range re-centre is
 * tweening, see pitch-view.ts updateAutoRange() - never allocates a label string after warm-up.
 */
const noteNameCache: Record<Notation, string[] | null> = { sharps: null, flats: null };
function cachedNoteName(midi: number, notation: Notation): string {
  let table = noteNameCache[notation];
  if (!table) {
    table = new Array(128);
    for (let m = 0; m < 128; m++) table[m] = noteName(m, notation, true);
    noteNameCache[notation] = table;
  }
  return table[midi < 0 ? 0 : midi > 127 ? 127 : midi];
}

/**
 * Rebuilds `buf` in place with every semitone lane fully or partially covering the visible
 * [lowMidi, highMidi] range (highest to lowest) and returns how many of its slots are now in
 * use; the caller reads only `buf[0..count)` (there may be unused trailing slots). Existing lane
 * objects are mutated rather than replaced, and a new object is allocated only the first time a
 * slot index is needed, so a caller that keeps reusing the same `buf` across repeated calls at a
 * stable lane count - the static grid during an auto-range tween - allocates nothing
 * (docs/ARCHITECTURE.md "No allocation per animation frame").
 */
export function updateLanes(
  buf: Lane[],
  lowMidi: number,
  highMidi: number,
  height: number,
  notation: Notation,
): number {
  const top = Math.ceil(highMidi + 0.5);
  const bottom = Math.floor(lowMidi - 0.5);
  const count = Math.max(0, top - bottom + 1);
  for (let i = 0; i < count; i++) {
    const midi = top - i;
    let lane = buf[i];
    if (!lane) {
      lane = { midi: NaN, yTop: 0, yBottom: 0, accidental: false, isC: false, label: '' };
      buf[i] = lane;
    }
    lane.midi = midi;
    lane.yTop = midiToY(midi + 0.5, lowMidi, highMidi, height);
    lane.yBottom = midiToY(midi - 0.5, lowMidi, highMidi, height);
    lane.accidental = isAccidental(midi);
    lane.isC = (((midi % 12) + 12) % 12) === 0;
    lane.label = cachedNoteName(midi, notation);
  }
  return count;
}

/**
 * Every semitone lane fully or partially covering the visible [lowMidi, highMidi] range, from
 * highest to lowest, as a freshly allocated array. Convenience wrapper over {@link updateLanes}
 * for one-off callers; the hot rendering path keeps its own buffer and calls `updateLanes`
 * directly instead (see pitch-view.ts drawStatic()).
 */
export function computeLanes(lowMidi: number, highMidi: number, height: number, notation: Notation): Lane[] {
  const lanes: Lane[] = [];
  updateLanes(lanes, lowMidi, highMidi, height, notation);
  return lanes;
}

export interface MidiRangeBounds {
  low: number;
  high: number;
}

export interface AutoRangeConfig {
  /** Visible span to keep, semitones (CONFIG.display.autoRangeSemitones). */
  span: number;
  /** How far the reference pitch may drift from the current centre before re-centring (CONFIG.display.autoRangeMarginSemitones). */
  margin: number;
}

/**
 * Decide whether the visible range should re-centre on `referenceMidi` (the
 * median of recent voiced pitch, or the active target). Returns the new
 * target range, or null when the reference is still within the margin of the
 * current centre, i.e. no change is needed. Pure: the caller animates the
 * transition from the current range to the returned one.
 */
export function decideAutoRange(
  current: MidiRangeBounds,
  referenceMidi: number,
  cfg: AutoRangeConfig,
): MidiRangeBounds | null {
  if (!Number.isFinite(referenceMidi)) return null;
  const centre = (current.low + current.high) / 2;
  if (Math.abs(referenceMidi - centre) <= cfg.margin) return null;
  const half = cfg.span / 2;
  return { low: referenceMidi - half, high: referenceMidi + half };
}
