/**
 * Test fixtures for analyzers: synthesize PitchTracks directly from pitch/level
 * contours at the real frame rate (~94 fps), with optional jitter and unvoiced
 * gaps. For audio-level realism, tests can instead run src/dsp/test-signals.ts
 * audio through the Framer + MPM detector (see framer.integration.test.ts).
 */
import type { PitchFrame, PitchTrack, TargetNote } from '../core/types';
import { centsFromNearest, midiToHz } from '../core/music';
import { seededRandom } from '../dsp/test-signals';

export const FRAME_RATE = 48000 / 512; // 93.75 frames/s

export interface TrackSpec {
  duration: number;
  /** Fractional MIDI at take time t; return NaN for unvoiced (silence, breath). */
  midi: (t: number) => number;
  /** RMS level in dBFS at t (default -20 when voiced, -80 when unvoiced). */
  rmsDb?: (t: number) => number;
  /** Detector confidence when voiced (default 0.95). */
  confidence?: number;
  /** Gaussian-ish pitch jitter, cents RMS (default 0). */
  jitterCents?: number;
  frameRate?: number;
  /** Take time of the first frame (default 0). */
  t0?: number;
  seed?: number;
}

/** Build a take-relative PitchTrack. Frames are voiced iff midi(t) is finite. */
export function makeTrack(spec: TrackSpec): PitchFrame[] {
  const fr = spec.frameRate ?? FRAME_RATE;
  const t0 = spec.t0 ?? 0;
  const n = Math.max(0, Math.floor(spec.duration * fr));
  const rand = seededRandom(spec.seed ?? 1234);
  const gauss = () => {
    // Irwin-Hall approximation of N(0,1).
    let s = 0;
    for (let i = 0; i < 6; i++) s += rand();
    return (s - 3) / Math.sqrt(0.5);
  };
  const out: PitchFrame[] = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fr;
    let m = spec.midi(t);
    const voiced = Number.isFinite(m);
    if (voiced && spec.jitterCents) m += (gauss() * spec.jitterCents) / 100;
    const rmsDb = spec.rmsDb ? spec.rmsDb(t) : voiced ? -20 : -80;
    out.push({
      t,
      f0Hz: voiced ? midiToHz(m) : NaN,
      midi: voiced ? m : NaN,
      centsFromNearest: voiced ? centsFromNearest(m) : NaN,
      confidence: voiced ? (spec.confidence ?? 0.95) : 0.1,
      rmsDb,
      voiced,
    });
  }
  return out;
}

/** Piecewise contour from target notes (NaN between notes). */
export function notesMidi(notes: readonly TargetNote[]): (t: number) => number {
  return (t) => {
    for (const n of notes) {
      if (t >= n.start && t < n.end) {
        if (n.toMidi === undefined) return n.midi;
        const u = (t - n.start) / (n.end - n.start);
        return n.midi + (n.toMidi - n.midi) * u;
      }
    }
    return NaN;
  };
}

/** Add a vibrato (rate Hz, +/- extent cents) on top of a base contour, optionally from `fromT`. */
export function withVibrato(base: (t: number) => number, rateHz: number, extentCents: number, fromT = 0, phase = 0): (t: number) => number {
  return (t) => {
    const m = base(t);
    if (!Number.isFinite(m) || t < fromT) return m;
    return m + (extentCents / 100) * Math.sin(2 * Math.PI * rateHz * (t - fromT) + phase);
  };
}

/** Concatenate contours: [[duration, fn(localT)], ...]. */
export function sequence(parts: ReadonlyArray<readonly [number, (t: number) => number]>): (t: number) => number {
  return (t) => {
    let start = 0;
    for (const [dur, fn] of parts) {
      if (t < start + dur) return fn(t - start);
      start += dur;
    }
    return NaN;
  };
}

export function sustained(midi: number, start: number, end: number): TargetNote {
  return { midi, start, end };
}

export type { PitchTrack };
