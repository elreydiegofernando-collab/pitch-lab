/**
 * Song transposition (Phase 6). A pure pitch shift of a chart, plus a suggestion of how far
 * to shift it to fit a singer's saved range. Octave-FOLDED scoring (octave-agnostic grading)
 * belongs to analysis/phrases.ts + dtw.ts, not here: this module only ever does a real,
 * whole-song shift, so the piano roll, the reference tones and the scorer all see the same notes.
 *
 * Only pitched notes (normal, golden) steer the fit: freestyle and rap pitches are meaningless.
 */
import type { Song } from './types';
import type { VocalRange } from '../storage/schema';
import { bestTransposition, type MidiRange } from '../core/music';
import { isPitchedNote } from './pitched';

/**
 * Shifts every note by `semis` semitones (fractions allowed, for tuning) and the pitch
 * fields of `difficulty` with it; every other field is untouched, `requiredWorld`
 * included (a rating never depends on the key). Pure: returns a new Song that callers
 * may mutate without touching `song`.
 */
export function transposeSong(song: Song, semis: number): Song {
  if (!Number.isFinite(semis)) throw new RangeError('transposeSong: semis must be a finite number');
  return {
    ...song,
    notes: song.notes.map((n) => ({ ...n, midi: n.midi + semis })),
    phrases: song.phrases.map((p) => ({ ...p })),
    difficulty: {
      ...song.difficulty,
      lowestMidi: song.difficulty.lowestMidi + semis,
      highestMidi: song.difficulty.highestMidi + semis,
    },
  };
}

/** Shifts by whole octaves (positive = up). */
export function transposeOctaves(song: Song, octaves: number): Song {
  return transposeSong(song, 12 * Math.round(octaves));
}

function validRange(r: MidiRange | undefined): r is MidiRange {
  return !!r && Number.isFinite(r.low) && Number.isFinite(r.high) && r.low <= r.high;
}

function fitPitches(song: Song): number[] {
  const pitched = song.notes.filter(isPitchedNote);
  return (pitched.length > 0 ? pitched : song.notes).map((n) => n.midi);
}

function countOutside(pitches: readonly number[], shift: number, range: MidiRange): number {
  let outside = 0;
  for (const p of pitches) if (p + shift < range.low || p + shift > range.high) outside++;
  return outside;
}

/**
 * The whole-semitone shift that best fits the melody into the singer's range.
 *
 * It centres the melody in `range.comfortable` with core/music.ts bestTransposition (which
 * keeps the top note in range when the tune is wider than the range). If that pushes any
 * note outside the EXTENDED range, which is a note the singer cannot sing at all, it
 * falls back to fitting the extended range, so reachable beats comfortable. Returns 0 for
 * a song with no notes or a range without usable bounds.
 */
export function suggestTransposition(song: Song, range: VocalRange): number {
  const pitches = fitPitches(song);
  if (pitches.length === 0) return 0;
  const comfortable = validRange(range?.comfortable) ? range.comfortable : undefined;
  const extended = validRange(range?.extended) ? range.extended : undefined;
  if (!comfortable && !extended) return 0;
  if (!comfortable) return bestTransposition(pitches, extended as MidiRange);

  const shift = bestTransposition(pitches, comfortable);
  if (!extended || countOutside(pitches, shift, extended) === 0) return shift;
  const alt = bestTransposition(pitches, extended);
  return countOutside(pitches, alt, extended) < countOutside(pitches, shift, extended) ? alt : shift;
}

/** suggestTransposition + transposeSong in one call: the song, already shifted to fit. */
export function transposeSongToRange(song: Song, range: VocalRange): Song {
  return transposeSong(song, suggestTransposition(song, range));
}

export interface RangeFit {
  /** The shift this report is about. */
  shift: number;
  /** The transposed melody's lowest and highest pitch. */
  lowest: number;
  highest: number;
  /** Notes outside the comfortable range (still singable if inside the extended range). */
  outsideComfortable: number;
  /** Notes outside the extended range: the singer cannot reach them. */
  outsideExtended: number;
  /** Pitched notes counted. */
  total: number;
}

/**
 * How well `song`, shifted by `shift` (default: the suggested shift), sits in the singer's
 * range, so the UI can warn "3 notes are above your range" before the singer starts.
 */
export function rangeFit(song: Song, range: VocalRange, shift: number = suggestTransposition(song, range)): RangeFit {
  const pitches = fitPitches(song);
  let lowest = Infinity;
  let highest = -Infinity;
  for (const p of pitches) {
    lowest = Math.min(lowest, p + shift);
    highest = Math.max(highest, p + shift);
  }
  return {
    shift,
    lowest: pitches.length > 0 ? lowest : 0,
    highest: pitches.length > 0 ? highest : 0,
    outsideComfortable: validRange(range?.comfortable) ? countOutside(pitches, shift, range.comfortable) : 0,
    outsideExtended: validRange(range?.extended) ? countOutside(pitches, shift, range.extended) : 0,
    total: pitches.length,
  };
}

/**
 * Moves one pitch by whole octaves into `range` (the nearest placement; unchanged when already
 * inside, or when the range is narrower than an octave and no placement fits). For guide tones
 * and labels, never for the scored melody (folding every note separately destroys its contour).
 */
export function foldIntoRange(midi: number, range: MidiRange): number {
  if (!validRange(range) || !Number.isFinite(midi)) return midi;
  if (midi >= range.low && midi <= range.high) return midi;
  let m = midi;
  while (m > range.high) m -= 12;
  while (m < range.low) m += 12;
  if (m > range.high) return midi; // range narrower than an octave: no octave of this pitch fits
  return m;
}
