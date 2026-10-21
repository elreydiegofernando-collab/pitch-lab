/** Pitch/notation helpers. 12-TET, A4 = 440 Hz. Pure and allocation-free on the hot path. */

export const A4_HZ = 440;
export const A4_MIDI = 69;

const LN2 = Math.LN2;

/** Hz -> fractional MIDI. Returns NaN for non-positive or non-finite input. */
export function hzToMidi(hz: number): number {
  if (!(hz > 0) || !Number.isFinite(hz)) return NaN;
  return A4_MIDI + (12 * Math.log(hz / A4_HZ)) / LN2;
}

/** Fractional MIDI -> Hz. */
export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Cents from the nearest equal-tempered note, in [-50, 50). NaN in, NaN out. */
export function centsFromNearest(midi: number): number {
  if (!Number.isFinite(midi)) return NaN;
  const c = (midi - Math.round(midi)) * 100;
  // Math.round(x.5) rounds up, so +50 maps to the note above as -50.
  return c >= 50 ? c - 100 : c;
}

/** Signed cents from `midi` to `targetMidi` (positive = sharp). */
export function centsOff(midi: number, targetMidi: number): number {
  return (midi - targetMidi) * 100;
}

/** Cents between two frequencies (positive when `hz` is above `refHz`). */
export function centsBetweenHz(hz: number, refHz: number): number {
  return (1200 * Math.log(hz / refHz)) / LN2;
}

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'] as const;
const ASCII_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export type Notation = 'sharps' | 'flats';

/** Pitch class 0..11 of a (rounded) MIDI note. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Scientific-pitch octave of a (rounded) MIDI note (MIDI 60 = C4). */
export function octaveOf(midi: number): number {
  return Math.floor(Math.round(midi) / 12) - 1;
}

/** "F♯4" style name of the nearest note. Uses real ♯/♭ glyphs for display. */
export function noteName(midi: number, notation: Notation = 'sharps', withOctave = true): string {
  if (!Number.isFinite(midi)) return '–';
  const names = notation === 'flats' ? FLAT_NAMES : SHARP_NAMES;
  const n = names[pitchClass(midi)];
  return withOctave ? `${n}${octaveOf(midi)}` : n;
}

/** True for C♯/D♭, D♯/E♭, F♯/G♭, G♯/A♭, A♯/B♭ (piano black keys). */
export function isAccidental(midi: number): boolean {
  const pc = pitchClass(midi);
  return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

/**
 * Parse "C4", "F#3", "Bb2", "F♯3", "E♭5" -> MIDI number. Returns NaN when invalid.
 * Accepts ASCII #/b and Unicode ♯/♭.
 */
export function parseNote(name: string): number {
  const m = /^\s*([A-Ga-g])([#♯b♭]?)(-?\d+)\s*$/.exec(name);
  if (!m) return NaN;
  const letter = m[1].toUpperCase();
  const acc = m[2];
  const octave = Number(m[3]);
  let pc = ASCII_SHARP.indexOf(letter as (typeof ASCII_SHARP)[number]);
  if (acc === '#' || acc === '♯') pc += 1;
  else if (acc === 'b' || acc === '♭') pc -= 1;
  return (octave + 1) * 12 + pc;
}

/** Inclusive pitch range in MIDI note numbers. */
export interface MidiRange {
  low: number;
  high: number;
}

/**
 * Semitone shift that best fits `notes` inside `range`: centres the material's
 * span in the range, then nudges so the highest note does not exceed range.high
 * and the lowest is not below range.low when possible. Returns an integer.
 */
export function bestTransposition(notes: readonly number[], range: MidiRange): number {
  if (notes.length === 0) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of notes) {
    if (n < lo) lo = n;
    if (n > hi) hi = n;
  }
  const matCentre = (lo + hi) / 2;
  const rangeCentre = (range.low + range.high) / 2;
  let shift = Math.round(rangeCentre - matCentre);
  if (hi + shift > range.high) shift -= hi + shift - range.high;
  if (lo + shift < range.low) shift += range.low - (lo + shift);
  // If the material is wider than the range, favour keeping the top in range.
  if (hi + shift > range.high) shift = range.high - hi;
  return Math.round(shift);
}
