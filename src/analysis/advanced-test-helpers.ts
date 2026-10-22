/**
 * Test-only helpers for the advanced analyzers (transitions, glide, cracks,
 * inflections, runs, dtw, segment, phrases). Not imported by production code.
 *
 *  - `sungContour`: a pitch contour through consecutive notes where adjacent notes are
 *    joined by raised-cosine moves of finite duration, like a real voice (fixtures.ts'
 *    `notesMidi` steps instantaneously).
 *  - `makeSung`: that contour as a PitchTrack with jitter, and an RMS envelope with
 *    a quick onset ramp and a dip at each move.
 *
 * For audio-level realism (synthesized audio -> Framer -> MPM) use `trackFromAudio` from
 * core-test-helpers.ts: there is one copy of that pipeline.
 */
import type { PitchFrame, TargetNote } from '../core/types';
import { centsFromNearest, midiToHz } from '../core/music';
import { seededRandom } from '../dsp/test-signals';
import { makeTrack } from './fixtures';

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

function smoothstepCos(u: number): number {
  return (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u)))) / 2;
}

function levelAt(n: TargetNote, t: number): number {
  if (n.toMidi === undefined || n.end === n.start) return n.midi;
  const u = Math.min(1, Math.max(0, (t - n.start) / (n.end - n.start)));
  return lerp(n.midi, n.toMidi, u);
}

/**
 * Fractional-MIDI contour through `notes`. Adjacent notes (end == next start) are joined
 * by a raised-cosine move of `transitionMs` centred on the boundary; a gap between notes
 * is unvoiced (NaN). Glide notes (toMidi) ramp linearly inside their span.
 */
export function sungContour(notes: readonly TargetNote[], transitionMs = 30): (t: number) => number {
  const half = transitionMs / 2000;
  const adjacent = (a: TargetNote, b: TargetNote | undefined): b is TargetNote => b !== undefined && Math.abs(b.start - a.end) < 1e-6;
  return (t) => {
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (!(t >= n.start && t < n.end)) continue;
      const next = notes[i + 1];
      const prev = notes[i - 1];
      if (half > 0 && adjacent(n, next) && t >= n.end - half) {
        return lerp(levelAt(n, t), levelAt(next, t), smoothstepCos((t - (n.end - half)) / (2 * half)));
      }
      if (half > 0 && prev !== undefined && adjacent(prev, n) && t < n.start + half) {
        return lerp(levelAt(prev, t), levelAt(n, t), smoothstepCos(0.5 + (t - n.start) / (2 * half)));
      }
      return levelAt(n, t);
    }
    return NaN;
  };
}

export interface SungOptions {
  /** Pitch jitter, cents RMS. Default 6 (a steady human voice through a real detector). */
  jitterCents?: number;
  /** Length of the move between adjacent notes, ms. Default 30. */
  transitionMs?: number;
  seed?: number;
  /** Extra seconds of silence after the last note. Default 0.1. */
  tail?: number;
}

/** A realistic PitchTrack of `notes` (see sungContour). RMS dips ~4 dB inside each move. */
export function makeSung(notes: readonly TargetNote[], opts: SungOptions = {}): PitchFrame[] {
  const transitionMs = opts.transitionMs ?? 30;
  const end = notes.length === 0 ? 0 : notes[notes.length - 1].end;
  const contour = sungContour(notes, transitionMs);
  const half = transitionMs / 2000;
  return makeTrack({
    duration: end + (opts.tail ?? 0.1),
    midi: contour,
    jitterCents: opts.jitterCents ?? 6,
    seed: opts.seed ?? 7,
    rmsDb: (t) => {
      if (!Number.isFinite(contour(t))) return -80;
      for (let i = 1; i < notes.length; i++) {
        if (Math.abs(t - notes[i].start) < half && Math.abs(notes[i].start - notes[i - 1].end) < 1e-6) return -24;
      }
      return -20;
    },
  });
}

/** Equal-length notes from a pitch pattern at `notesPerSec`, starting at `t0`. */
export function runNotes(pattern: readonly number[], notesPerSec: number, t0 = 0): TargetNote[] {
  const d = 1 / notesPerSec;
  return pattern.map((midi, i) => ({ midi, start: t0 + i * d, end: t0 + (i + 1) * d }));
}

/**
 * `track` with its unvoiced frames turned into the frames the real Framer emits for unvoiced audio: `voiced` false, but a FINITE pitch guess
 * (random, anywhere in the singable range), a low confidence and the frame's own level. analysis/track.ts warns that "midi is finite" must never
 * be read as "voiced"; fixtures.ts marks unvoiced frames with NaN, which would hide that mistake, so an analyzer's result on the two versions of
 * the same take must be identical (and the voiced frames are not touched). Returns a copy.
 */
export function framerStyleUnvoiced(track: readonly PitchFrame[], seed = 99): PitchFrame[] {
  const rand = seededRandom(seed);
  return track.map((f) => {
    if (f.voiced) return f;
    const midi = 40 + 44 * rand(); // E2 .. C6: where a detector's wrong guesses land
    return { ...f, f0Hz: midiToHz(midi), midi, centsFromNearest: centsFromNearest(midi), confidence: 0.1 + 0.5 * rand() };
  });
}
