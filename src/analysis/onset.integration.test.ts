/**
 * Audio-level integration test for analyzeOnset: real synthesized voice
 * (pitch contour x amplitude envelope) -> real MPM detector -> real Framer ->
 * PitchFrames -> onset analysis. The RMS in each frame is the framer's 43 ms
 * window RMS, so this is what proves the rise-time deconvolution and the
 * scoop/leap logic on real detector output rather than on exact fixtures.
 */
import { describe, expect, it } from 'vitest';
import { analyzeOnset } from './onset';
import { CTX, attackEnvelope, singAudio } from './core-test-helpers';

const NOTE = { midi: 60, start: 0.5, end: 1.6 };

describe('analyzeOnset on real detector output: attacks', () => {
  it('measures the amplitude rise time of real audio attacks, deconvolved from the 43 ms tracker window', () => {
    // linear-amplitude ramps: the 10-90% rise of a ramp of length R is 0.8 R
    const cases: Array<{ rise: number; lo: number; hi: number; type: 'hard' | 'balanced' | 'breathy' }> = [
      { rise: 0.002, lo: 0, hi: 12, type: 'hard' }, // an instantaneous attack reads ~0, not the tracker's 34 ms blur
      { rise: 0.04, lo: 24, hi: 50, type: 'hard' }, // true 10-90% rise 32 ms; frames are 10.7 ms apart
      { rise: 0.1, lo: 66, hi: 92, type: 'balanced' },
      { rise: 0.15, lo: 105, hi: 140, type: 'balanced' },
      { rise: 0.25, lo: 175, hi: 225, type: 'breathy' },
      { rise: 0.4, lo: 290, hi: 345, type: 'breathy' },
    ];
    for (const c of cases) {
      const frames = singAudio({ duration: 2, midi: (t) => (t >= 0.5 ? 60 : NaN), amp: attackEnvelope(0.5, c.rise) });
      const r = analyzeOnset(frames, NOTE, CTX);
      const label = `${c.rise * 1000} ms ramp`;
      expect(r.riseMs, label).not.toBeNull();
      expect(r.riseMs!, label).toBeGreaterThanOrEqual(c.lo);
      expect(r.riseMs!, label).toBeLessThanOrEqual(c.hi);
      expect(r.onsetType, label).toBe(c.type);
      expect(r.crisp, label).toBe(c.type !== 'breathy'); // a slow, soft start is the one thing that is not a crisp landing
    }
  });

  it('a dead-on onset settles at once, with no scoop or overshoot, on real audio', () => {
    const frames = singAudio({ duration: 2, midi: (t) => (t >= 0.5 ? 60 : NaN), amp: attackEnvelope(0.5, 0.05) });
    const r = analyzeOnset(frames, NOTE, CTX);
    expect(r.onsetT).toBeGreaterThan(0.46);
    expect(r.onsetT).toBeLessThan(0.56);
    expect(r.settleMs!).toBeLessThan(25);
    expect(r.scoopCents).toBeLessThan(8);
    expect(r.overshootCents).toBeLessThan(8);
  });

  it('scoops of 30, 60 and 100 cents (sliding up over 100 ms) are measured (the 43 ms window smears the first frames ~15-20%)', () => {
    const cases: Array<[number, number, number]> = [
      [30, 18, 36],
      [60, 42, 64],
      [100, 70, 104],
    ];
    for (const [depth, lo, hi] of cases) {
      const frames = singAudio({
        duration: 2,
        midi: (t) => (t < 0.5 ? NaN : 60 - (depth / 100) * Math.max(0, 1 - (t - 0.5) / 0.1)),
        amp: attackEnvelope(0.5, 0.05),
      });
      const r = analyzeOnset(frames, NOTE, CTX);
      expect(r.scoopCents, `${depth} c`).toBeGreaterThanOrEqual(lo);
      expect(r.scoopCents, `${depth} c`).toBeLessThanOrEqual(hi);
      if (depth >= 60) expect(r.crisp, `${depth} c`).toBe(false);
    }
  });

  it('comes in 300 ms late or 80 ms early: onset is measured from the voice, not the cue', () => {
    const late = singAudio({ duration: 2, midi: (t) => (t >= 0.8 ? 60 : NaN), amp: attackEnvelope(0.8, 0.05) });
    const rl = analyzeOnset(late, NOTE, CTX);
    expect(rl.onsetT!).toBeGreaterThan(0.76);
    expect(rl.onsetT!).toBeLessThan(0.86);
    expect(rl.scoopCents).toBeLessThan(8);
    const early = singAudio({ duration: 2, midi: (t) => (t >= 0.42 ? 60 : NaN), amp: attackEnvelope(0.42, 0.05) });
    const re = analyzeOnset(early, NOTE, CTX);
    expect(re.onsetT!).toBeGreaterThan(0.36);
    expect(re.onsetT!).toBeLessThan(0.46);
  });

  it('the previous note\'s tail inside the lookback is ignored (a staccato after a short note)', () => {
    const frames = singAudio({ duration: 3, midi: (t) => (t < 0.1 ? NaN : t < 0.7 ? 57 : t < 1.0 ? NaN : t < 1.3 ? 60 : NaN), amp: (t) => (t < 0.1 ? 0 : 0.4) });
    const r = analyzeOnset(frames, { midi: 60, start: 1.0, end: 1.4 }, CTX);
    expect(r.onsetT!).toBeGreaterThan(0.95);
    expect(r.onsetT!).toBeLessThan(1.06);
    expect(r.scoopCents).toBeLessThan(8);
  });
});

describe('analyzeOnset on real detector output: legato leaps', () => {
  const leapAudio = (from: number, to: number, leapAt: number, moveSec: number) =>
    singAudio({
      duration: 3,
      midi: (t) => (t < 0.3 ? NaN : t < leapAt ? from : from + (to - from) * Math.min(1, (t - leapAt) / moveSec)),
      amp: attackEnvelope(0.3, 0.05),
    });
  const target = { midi: 60, start: 1.0, end: 2.4 };

  it('a clean major-third and octave jump up lands crisp: ~0 settle, tiny scoop and overshoot (the in-flight frames do not count)', () => {
    for (const from of [56, 48]) {
      const r = analyzeOnset(leapAudio(from, 60, 1.0, 0.01), target, CTX);
      expect(r.settleMs!, `from ${from}`).toBeLessThan(40);
      expect(r.scoopCents, `from ${from}`).toBeLessThan(20);
      expect(r.overshootCents, `from ${from}`).toBeLessThan(20);
      expect(r.crisp, `from ${from}`).toBe(true);
    }
  });

  it('a clean jump down lands crisp too', () => {
    const r = analyzeOnset(leapAudio(64, 60, 1.0, 0.01), target, CTX);
    expect(r.settleMs!).toBeLessThan(40);
    expect(r.scoopCents).toBeLessThan(20);
    expect(r.crisp).toBe(true);
  });

  it('leaping 150 ms late is not a scoop: onset is when the voice left the old note', () => {
    const r = analyzeOnset(leapAudio(56, 60, 1.15, 0.01), target, CTX);
    expect(r.onsetT!).toBeGreaterThan(1.1);
    expect(r.onsetT!).toBeLessThan(1.22);
    expect(r.scoopCents).toBeLessThan(20);
    expect(r.crisp).toBe(true);
  });

  it('sliding into the note from a third below over 120 ms is a scoop, and not crisp', () => {
    const r = analyzeOnset(leapAudio(56, 60, 1.0, 0.12), target, CTX);
    expect(r.scoopCents).toBeGreaterThan(250);
    expect(r.settleMs!).toBeGreaterThan(80);
    expect(r.crisp).toBe(false);
  });
});
