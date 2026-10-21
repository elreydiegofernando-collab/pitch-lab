/**
 * Minimal 16-bit PCM mono WAV writer for e2e fixtures. Deliberately
 * independent of every other agent's code (DSP, audio, synth): the whole
 * point of a fake-mic fixture is to be a known signal nothing in the app
 * could have "cheated" to produce.
 */

const TWO_PI = 2 * Math.PI;

/** A voice-like falloff: fundamental-dominant but clearly harmonic, not a pure sine. */
const DEFAULT_HARMONIC_AMPLITUDES = [1, 0.5, 0.3, 0.18, 0.1, 0.06, 0.03] as const;

export interface HarmonicToneOptions {
  /** Fundamental, Hz (the vibrato carrier when `vibrato` is set). */
  f0Hz: number;
  durationSec: number;
  sampleRate?: number;
  /** Relative amplitude of harmonic 1..N; index 0 is the fundamental. */
  harmonicAmplitudes?: readonly number[];
  /** Peak sample amplitude after mixing, before fades (0..1). The mix is normalised so this is a hard ceiling. */
  peakAmplitude?: number;
  /** Linear fade in/out to avoid an onset/offset click, seconds. */
  fadeSec?: number;
  vibrato?: {
    rateHz: number;
    /** Half peak-to-trough, cents (i.e. the carrier swings +/-depthCents). */
    depthCents: number;
  };
}

/**
 * Phase-accumulated harmonic tone: each harmonic's phase is integrated from
 * its own instantaneous frequency every sample, so frequency modulation
 * (vibrato) stays phase-continuous instead of producing clicks the way
 * `sin(2*pi*f(t)*t)` would once f(t) varies.
 */
export function generateHarmonicTone(opts: HarmonicToneOptions): Float32Array {
  const sampleRate = opts.sampleRate ?? 48000;
  const n = Math.round(opts.durationSec * sampleRate);
  const harmonics = opts.harmonicAmplitudes ?? DEFAULT_HARMONIC_AMPLITUDES;
  const ampSum = harmonics.reduce((a, b) => a + b, 0);
  const peak = opts.peakAmplitude ?? 0.3;
  const fadeSamples = Math.max(1, Math.round((opts.fadeSec ?? 0.02) * sampleRate));
  const vibrato = opts.vibrato;

  const out = new Float32Array(n);
  const phase = new Float64Array(harmonics.length);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = vibrato
      ? opts.f0Hz * Math.pow(2, (vibrato.depthCents * Math.sin(TWO_PI * vibrato.rateHz * t)) / 1200)
      : opts.f0Hz;

    let mix = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const freq = f0 * (h + 1);
      phase[h] = (phase[h] + (TWO_PI * freq) / sampleRate) % TWO_PI;
      mix += harmonics[h] * Math.sin(phase[h]);
    }
    // |mix / ampSum| <= 1 by the triangle inequality, so this is clip-safe.
    let sample = (mix / ampSum) * peak;

    if (i < fadeSamples) sample *= i / fadeSamples;
    else if (i > n - fadeSamples) sample *= (n - i) / fadeSamples;

    out[i] = sample;
  }
  return out;
}

/** Encodes mono float samples (-1..1) as a canonical 16-bit PCM WAV file buffer. */
export function encodeWavPCM16Mono(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const intSample = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff));
    buffer.writeInt16LE(intSample, offset);
    offset += bytesPerSample;
  }
  return buffer;
}
