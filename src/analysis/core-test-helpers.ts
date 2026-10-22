/**
 * Test-only helpers for the analyzers. Not imported by production code.
 * Counterpart of advanced-test-helpers.ts (pitch contours and plain-track
 * builders); the audio-level pipeline lives only here and is shared by both
 * analyzer sets' tests.
 *
 *  - `trackFromAudio`: the REAL pipeline (synthesized audio -> Framer -> MPM,
 *    fed in 128-sample render quanta like the worklet), so tests can check the
 *    analyzers on detector output: its 43 ms window smearing, onset latency,
 *    and the few cents of jitter a real detector adds.
 *  - `singAudio`: synthesizes a voice from a pitch contour (NaN = silence) and
 *    an amplitude envelope, then runs it through `trackFromAudio`.
 */
import type { PitchFrame } from '../core/types';
import { midiToHz } from '../core/music';
import { CONFIG, hopSizeFor } from '../config';
import { Framer } from '../audio/framer';
import { createDetector } from '../dsp/detector';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

/** The context most tests analyze under: the default tolerance, pop vibrato zone. */
export const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };

/** Audio -> Framer -> MPM at `sampleRate`. Returns every emitted frame (t is the AudioContext time of the window centre; the signal starts at t = 0). */
export function trackFromAudio(signal: Float32Array, sampleRate = 48000): PitchFrame[] {
  const detector = createDetector('mpm', {
    sampleRate,
    windowSize: CONFIG.audio.windowSize,
    minHz: CONFIG.audio.minHz,
    maxHz: CONFIG.audio.maxHz,
    mpmK: CONFIG.audio.mpmK,
  });
  const framer = new Framer({
    sampleRate,
    windowSize: CONFIG.audio.windowSize,
    hopSize: hopSizeFor(sampleRate),
    minHz: CONFIG.audio.minHz,
    maxHz: CONFIG.audio.maxHz,
    minConfidence: CONFIG.audio.minConfidence,
    minRmsDb: CONFIG.audio.minRmsDb,
    rmsFloorDb: CONFIG.audio.rmsFloorDb,
    detector,
  });
  const frames: PitchFrame[] = [];
  const block = 128;
  for (let pos = 0; pos < signal.length; pos += block) {
    framer.push(signal.subarray(pos, Math.min(pos + block, signal.length)), pos, (f) => frames.push(f));
  }
  return frames;
}

export interface SingOptions {
  duration: number;
  /** Fractional MIDI at time t; NaN or non-finite = silence. */
  midi: (t: number) => number;
  /** Linear amplitude at time t (default 0.4). */
  amp?: (t: number) => number;
  /** Additive white noise, dBFS RMS. */
  noiseDb?: number;
  sampleRate?: number;
}

/** A synthesized harmonic voice following `midi`/`amp`, decoded by the real detector pipeline. */
export function singAudio(o: SingOptions): PitchFrame[] {
  const sampleRate = o.sampleRate ?? 48000;
  const signal = synthesize({
    sampleRate,
    duration: o.duration,
    f0: (t) => {
      const m = o.midi(t);
      return Number.isFinite(m) ? midiToHz(m) : NaN;
    },
    amp: o.amp ?? 0.4,
    noiseDb: o.noiseDb,
  });
  return trackFromAudio(signal, sampleRate);
}

/** Linear-amplitude ramp from silence starting at `t0`, reaching `level` after `riseSec` (10-90% rise = 0.8 x riseSec). */
export function attackEnvelope(t0: number, riseSec: number, level = 0.4): (t: number) => number {
  return (t) => (t < t0 ? 0 : level * Math.min(1, (t - t0) / Math.max(1e-6, riseSec)));
}
