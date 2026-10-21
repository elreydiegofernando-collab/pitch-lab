/**
 * Shared synthesized-signal generator for every DSP (and, later, analyzer)
 * test: sines, voice-like harmonic tones, vibrato, glides, note sequences,
 * noise and silence, all deterministic. Phase 2's scoop/glide/run/swell/
 * crack tests are expected to build on these same primitives rather than
 * writing their own synthesis.
 *
 * `synthesize()` is the core: it drives everything by **phase
 * accumulation** - `phase += f0(t)/sampleRate` each sample, wrapped to
 * [0, 1) - rather than evaluating `sin(2*pi*f0(t)*t)` directly. The latter
 * is only correct for constant f0; for a time-varying contour (vibrato,
 * glides) it does not represent frequency modulation at all, since its
 * instantaneous frequency is `d/dt[f0(t)*t]`, not `f0(t)`. Phase
 * accumulation integrates the instantaneous frequency exactly (to the
 * sample-rate's resolution), which is what every test that checks
 * "recovered pitch vs. true instantaneous pitch" depends on.
 */

import { midiToHz } from '../core/music';

/** Default voice-like relative partial amplitudes (fundamental strongest, rolling off). */
export const DEFAULT_HARMONICS: readonly number[] = [1, 0.6, 0.45, 0.3, 0.25, 0.18, 0.12, 0.08];

export interface SynthesizeOptions {
  sampleRate: number;
  /** Signal length, seconds. */
  duration: number;
  /** Fundamental in Hz, fixed or time-varying. NaN or <= 0 at a given `t` means silence at that instant. */
  f0: number | ((t: number) => number);
  /** Amplitude, fixed or time-varying. Default 1. */
  amp?: number | ((t: number) => number);
  /** Relative partial amplitudes, partial 1 = fundamental. Default `DEFAULT_HARMONICS`. Pass `[1]` for a pure sine. */
  harmonics?: readonly number[];
  /** Additive white noise level, dBFS (RMS relative to full scale 1.0). Omit for no noise. */
  noiseDb?: number;
  /** Seeds the noise PRNG. Default a fixed constant, so calls are deterministic even when omitted. */
  seed?: number;
}

const DEFAULT_SEED = 0x9e3779b9;

/**
 * Synthesizes a (possibly harmonic, possibly frequency- and amplitude-
 * modulated, possibly noisy) tone. See the module doc for why this uses
 * phase accumulation. Deterministic for a given `seed`.
 */
export function synthesize(opts: SynthesizeOptions): Float32Array {
  const { sampleRate, duration } = opts;
  const n = Math.max(0, Math.round(sampleRate * duration));
  const out = new Float32Array(n);
  const harmonics = opts.harmonics ?? DEFAULT_HARMONICS;
  const f0Fn = typeof opts.f0 === 'function' ? opts.f0 : constant(opts.f0);
  const ampFn = typeof opts.amp === 'function' ? opts.amp : constant(opts.amp ?? 1);
  const noiseAmp = opts.noiseDb !== undefined ? dbToNoiseAmp(opts.noiseDb) : 0;
  const rng = noiseAmp > 0 ? seededRandom(opts.seed ?? DEFAULT_SEED) : null;

  let phase = 0; // cycles, wrapped to [0, 1)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f = f0Fn(t);
    const voiced = f > 0 && Number.isFinite(f);
    if (voiced) {
      phase += f / sampleRate;
      phase -= Math.floor(phase);
    }

    let sample = 0;
    if (voiced) {
      for (let h = 0; h < harmonics.length; h++) {
        sample += harmonics[h] * Math.sin(2 * Math.PI * (h + 1) * phase);
      }
      sample *= ampFn(t);
    }
    if (rng) sample += noiseAmp * (rng() * 2 - 1);
    out[i] = sample;
  }
  return out;
}

/** Pure sine at a fixed frequency. `synthesize({ ..., harmonics: [1] })` with a plain-number signature. */
export function sine(sampleRate: number, duration: number, f0Hz: number, amp = 1): Float32Array {
  return synthesize({ sampleRate, duration, f0: f0Hz, amp, harmonics: [1] });
}

/** Voice-like harmonic tone at a fixed frequency. */
export function harmonicTone(
  sampleRate: number,
  duration: number,
  f0Hz: number,
  harmonics: readonly number[] = DEFAULT_HARMONICS,
  amp = 1,
): Float32Array {
  return synthesize({ sampleRate, duration, f0: f0Hz, amp, harmonics });
}

export interface VibratoContourOptions {
  /** Initial phase of the vibrato oscillation, radians. Default 0 (rising from centre). */
  phase?: number;
}

/**
 * A sinusoidal-vibrato frequency contour: `baseHz` modulated by
 * `+/- extentCents` at `rateHz`, linear in pitch (i.e. in log-frequency, so
 * the cents deviation is exact, not an approximation that only holds for
 * small extents). Pass as `f0` to `synthesize`.
 */
export function vibratoContour(
  baseHz: number,
  rateHz: number,
  extentCents: number,
  opts: VibratoContourOptions = {},
): (t: number) => number {
  const phase0 = opts.phase ?? 0;
  return (t: number) => baseHz * Math.pow(2, (extentCents * Math.sin(2 * Math.PI * rateHz * t + phase0)) / 1200);
}

/**
 * A glide from `startHz` to `endHz`, linear in pitch (log-frequency) between
 * `startSec` and `endSec`; held constant before and after. Pass as `f0` to
 * `synthesize`.
 */
export function glideContour(startHz: number, endHz: number, startSec: number, endSec: number): (t: number) => number {
  const startLog = Math.log2(startHz);
  const endLog = Math.log2(endHz);
  const span = endSec - startSec;
  return (t: number) => {
    if (t <= startSec) return startHz;
    if (t >= endSec) return endHz;
    const frac = span > 0 ? (t - startSec) / span : 1;
    return Math.pow(2, startLog + (endLog - startLog) * frac);
  };
}

/** One held note in a `notesContour` sequence. Times are seconds; `end` is exclusive. */
export interface NoteSpan {
  midi: number;
  start: number;
  end: number;
}

/**
 * A frequency contour built from discrete held notes: `midiToHz(note.midi)`
 * while `t` falls in `[note.start, note.end)`, `NaN` (silence) in any gap.
 * Pass as `f0` to `synthesize`.
 */
export function notesContour(notes: readonly NoteSpan[]): (t: number) => number {
  return (t: number) => {
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      if (t >= note.start && t < note.end) return midiToHz(note.midi);
    }
    return NaN;
  };
}

/**
 * Additive-white-noise-only signal at `dB` dBFS RMS (see `dbToNoiseAmp`),
 * seeded for determinism.
 */
export function whiteNoise(sampleRate: number, duration: number, dB: number, seed = DEFAULT_SEED): Float32Array {
  const n = Math.max(0, Math.round(sampleRate * duration));
  const out = new Float32Array(n);
  const amp = dbToNoiseAmp(dB);
  const rng = seededRandom(seed);
  for (let i = 0; i < n; i++) out[i] = amp * (rng() * 2 - 1);
  return out;
}

/** `duration` seconds of digital silence. */
export function silence(sampleRate: number, duration: number): Float32Array {
  return new Float32Array(Math.max(0, Math.round(sampleRate * duration)));
}

/**
 * Extracts a `size`-sample window centred on `centerSample` of `signal`,
 * zero-padding past either edge. (`size` odd centres exactly on the sample;
 * even centres between `centerSample - 1` and `centerSample`, matching how
 * a detector's window of `windowSize` samples is framed around a hop centre.)
 */
export function windowAt(signal: Float32Array, centerSample: number, size: number): Float32Array {
  const out = new Float32Array(size);
  const start = centerSample - Math.floor(size / 2);
  for (let i = 0; i < size; i++) {
    const idx = start + i;
    out[i] = idx >= 0 && idx < signal.length ? signal[idx] : 0;
  }
  return out;
}

/**
 * Deterministic seeded PRNG (mulberry32, public domain, Tommy Ettinger).
 * Returns a function producing floats uniformly distributed in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Converts a target dBFS RMS level to the amplitude scale for
 * `2 * rng() - 1` (uniform on [-1, 1), RMS = 1/sqrt(3)): scaling by
 * `10^(dB/20) * sqrt(3)` makes the generated noise's actual measured RMS
 * equal `10^(dB/20)`, i.e. exactly `dB` dBFS, not off by the uniform
 * distribution's own crest factor.
 */
function dbToNoiseAmp(dB: number): number {
  return Math.pow(10, dB / 20) * Math.sqrt(3);
}

function constant(v: number): (t: number) => number {
  return () => v;
}
