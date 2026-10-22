/**
 * Audio-level integration test for analyzePulse: a synthesized voice whose
 * PITCH pulses (a real "ha-ha-ha" drill, or an alternation between two notes)
 * goes through the real MPM detector and Framer, then the pulse analyzer.
 */
import { describe, expect, it } from 'vitest';
import { analyzePulse } from './pulse';
import { singAudio } from './core-test-helpers';

describe('analyzePulse on real detector output', () => {
  it('measures sinusoidal pitch pulses at 3.5, 4.5 and 5.5 Hz to within 0.05 Hz, with an even rhythm', () => {
    for (const rate of [3.5, 4.5, 5.5]) {
      const frames = singAudio({ duration: 4, midi: (t) => (t < 0.3 ? NaN : 60 + 0.3 * Math.sin(2 * Math.PI * rate * t)) });
      const r = analyzePulse(frames, { midi: 60, start: 0.3, end: 4 }, rate);
      expect(Math.abs(r.rateErrorHz!), `${rate} Hz`).toBeLessThan(0.05);
      expect(r.regularity!, `${rate} Hz`).toBeGreaterThan(0.85);
      expect(r.pulseCount, `${rate} Hz`).toBeGreaterThanOrEqual(Math.floor(rate * 3.7) - 3);
      // the 43 ms tracker window shaves ~10% off a swing at these rates
      expect(r.swingCents!, `${rate} Hz`).toBeGreaterThan(44);
      expect(r.swingCents!, `${rate} Hz`).toBeLessThan(64);
    }
  });

  it('tells a singer who is pulsing too slowly: 3.5 Hz sung against a 4.5 Hz target', () => {
    const frames = singAudio({ duration: 4, midi: (t) => (t < 0.3 ? NaN : 60 + 0.3 * Math.sin(2 * Math.PI * 3.5 * t)) });
    const r = analyzePulse(frames, { midi: 60, start: 0.3, end: 4 }, 4.5);
    expect(r.rateErrorHz!).toBeLessThan(-0.9);
    expect(r.rateErrorHz!).toBeGreaterThan(-1.1);
  });

  it('measures a whole-tone alternation drill (eighths at 80 bpm) through the detector', () => {
    const noteDur = 0.375;
    const notes = Array.from({ length: 16 }, (_, i) => ({ midi: 60 + (i % 2) * 2, start: 0.3 + i * noteDur, end: 0.3 + (i + 1) * noteDur }));
    const frames = singAudio({ duration: 0.3 + 16 * noteDur + 0.2, midi: (t) => (t < 0.3 ? NaN : 60 + (Math.floor((t - 0.3) / noteDur) % 2) * 2) });
    const r = analyzePulse(frames, notes, 1 / (2 * noteDur));
    expect(Math.abs(r.rateErrorHz!)).toBeLessThan(0.05);
    expect(r.regularity!).toBeGreaterThan(0.85);
    expect(r.swingCents!).toBeGreaterThan(150);
  });

  it('a steady tone in room noise has no pulses', () => {
    for (const noiseDb of [-30, -20]) {
      const frames = singAudio({ duration: 3, midi: () => 60, noiseDb });
      const r = analyzePulse(frames, { midi: 60, start: 0, end: 3 }, 4);
      expect(r.measuredRateHz, `noise ${noiseDb}`).toBeNull();
    }
  });
});
