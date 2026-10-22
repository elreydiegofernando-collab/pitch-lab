/**
 * Audio-level integration test for analyzeDynamics: a synthesized voice whose
 * AMPLITUDE swells (and whose pitch optionally moves with the loudness) goes
 * through the real MPM detector and Framer; the RMS in each frame is the
 * framer's window RMS. Proves the relative-dB slope, verdicts and shape
 * measures on detector output, and that a note's attack is not "dynamics".
 */
import { describe, expect, it } from 'vitest';
import { analyzeDynamics } from './dynamics';
import { CTX, singAudio } from './core-test-helpers';

const START = 0.2;
const DUR = 4;
const NOTE = { midi: 60, start: START, end: START + DUR };

/** Loudness 0..1 of a half-sine swell over the note. */
const loud = (t: number) => Math.sin(Math.PI * Math.max(0, Math.min(1, (t - START) / DUR)));

const voice = (pitch: (loudness: number) => number, amp: (t: number) => number) =>
  singAudio({ duration: START + DUR + 0.2, midi: (t) => (t < START ? NaN : pitch(loud(t))), amp: (t) => (t < START ? 0 : amp(t)) });

const swellAmp = (t: number) => 0.02 + 0.5 * loud(t);

describe('analyzeDynamics on real detector output', () => {
  it('a swell with steady pitch: a wide relative range, a flat slope, "steady", and a centred symmetric shape', () => {
    const r = analyzeDynamics(voice(() => 60, swellAmp), NOTE, CTX);
    expect(r.rangeDb).toBeGreaterThan(20);
    expect(Math.abs(r.slopeCentsPerDb!)).toBeLessThan(0.3);
    expect(r.verdict).toBe('steady');
    expect(r.peakPosition!).toBeGreaterThan(0.42);
    expect(r.peakPosition!).toBeLessThan(0.58);
    expect(r.symmetry!).toBeGreaterThan(0.8);
  });

  it('pitch that goes sharp as the voice gets loud (+30 c at the peak) is "sharp-when-loud", with a positive slope', () => {
    const r = analyzeDynamics(voice((l) => 60 + (30 * l) / 100, swellAmp), NOTE, CTX);
    expect(r.slopeCentsPerDb!).toBeGreaterThan(CONFIG_MAX_DRIFT);
    expect(r.correlation!).toBeGreaterThan(0.9);
    expect(r.verdict).toBe('sharp-when-loud');
  });

  it('pitch that sags flat as the voice gets soft is "flat-when-soft"', () => {
    const r = analyzeDynamics(voice((l) => 60 - (0.35 * (1 - l)), swellAmp), NOTE, CTX);
    expect(r.slopeCentsPerDb!).toBeGreaterThan(CONFIG_MAX_DRIFT);
    expect(r.verdict).toBe('flat-when-soft');
  });

  it('pitch that falls as the voice gets louder is plain drift', () => {
    const r = analyzeDynamics(voice((l) => 60 - (30 * l) / 100, swellAmp), NOTE, CTX);
    expect(r.slopeCentsPerDb!).toBeLessThan(-CONFIG_MAX_DRIFT);
    expect(r.verdict).toBe('drifts');
  });

  it('a sharp rise and a long fade (peak a quarter in) is asymmetric, peak position ~0.25', () => {
    const asym = (t: number) => {
      const u = Math.max(0, Math.min(1, (t - START) / DUR));
      return 0.02 + 0.5 * (u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75);
    };
    const r = analyzeDynamics(voice(() => 60, asym), NOTE, CTX);
    expect(r.peakPosition!).toBeGreaterThan(0.18);
    expect(r.peakPosition!).toBeLessThan(0.34);
    expect(r.symmetry!).toBeLessThan(0.78);
  });

  it('a one-way crescendo peaks at the end, and is not a swell: shape "crescendo", symmetry 0', () => {
    const r = analyzeDynamics(voice(() => 60, (t) => 0.02 + 0.5 * Math.max(0, Math.min(1, (t - START) / DUR))), NOTE, CTX);
    expect(r.rangeDb).toBeGreaterThan(18);
    expect(r.peakPosition!).toBeGreaterThan(0.85);
    expect(r.shape).toBe('crescendo');
    expect(r.symmetry).toBe(0);
  });

  it('the same voice turned upside down (loud, soft, loud) is as symmetric as a swell and is not one: symmetry 0, shape "inverted", peak at an end', () => {
    const swell = analyzeDynamics(voice(() => 60, swellAmp), NOTE, CTX);
    const upsideDown = analyzeDynamics(voice(() => 60, (t) => 0.02 + 0.5 * (1 - loud(t))), NOTE, CTX);
    expect(swell.shape).toBe('swell');
    expect(swell.symmetry!).toBeGreaterThan(0.8);
    expect(upsideDown.rangeDb).toBeGreaterThan(20); // the same loudness range ...
    expect(upsideDown.shape).toBe('inverted'); // ... and the opposite shape
    expect(upsideDown.symmetry).toBe(0);
    expect(upsideDown.peakPosition! < 0.2 || upsideDown.peakPosition! > 0.8).toBe(true);
  });

  it('a swell that peaks at 0.3 of the note is still a swell (lopsided, so less symmetric)', () => {
    const lopsided = (t: number) => {
      const u = Math.max(0, Math.min(1, (t - START) / DUR));
      return 0.02 + 0.5 * (u < 0.3 ? u / 0.3 : (1 - u) / 0.7);
    };
    const r = analyzeDynamics(voice(() => 60, lopsided), NOTE, CTX);
    expect(r.shape).toBe('swell');
    expect(r.peakPosition!).toBeGreaterThan(0.2);
    expect(r.peakPosition!).toBeLessThan(0.4);
    expect(r.symmetry!).toBeGreaterThan(0.4);
    expect(r.symmetry!).toBeLessThan(0.8);
  });

  it('a loud steady note with only its natural attack has no dynamic range (the first frames are excluded)', () => {
    const r = analyzeDynamics(voice(() => 60, (t) => 0.4 * Math.min(1, (t - START) / 0.05)), NOTE, CTX);
    expect(r.rangeDb).toBeLessThan(2);
    expect(r.verdict).toBe('insufficient-range');
  });

  it('is relative: the same swell 10 dB quieter reads the same range', () => {
    // (Quieter than this the swell's soft ends fall under the framer's voicing gate, CONFIG.audio.minRmsDb = -50 dBFS:
    // unvoiced frames are not in the voiced envelope, so a pianissimo near the noise floor is cut from the range.)
    const a = analyzeDynamics(voice(() => 60, swellAmp), NOTE, CTX);
    const quiet = 10 ** (-10 / 20);
    const b = analyzeDynamics(voice(() => 60, (t) => quiet * swellAmp(t)), NOTE, CTX);
    expect(Math.abs(a.rangeDb - b.rangeDb)).toBeLessThan(2);
  });
});

/** CONFIG.dynamics.maxDriftCentsPerDb, restated so a retune of the knob is a visible test edit rather than a silent change. */
const CONFIG_MAX_DRIFT = 1;
