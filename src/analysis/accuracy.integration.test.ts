/**
 * Audio-level integration test: real harmonic-tone audio -> real MPM
 * detector -> real Framer -> real PitchFrame track -> analyzeAccuracy.
 * Unlike accuracy.test.ts (which builds a PitchTrack directly from an exact
 * ground-truth contour via fixtures.ts), this proves the analyzer also
 * works on what the actual detector produces, including its own small
 * jitter and the startup settling frames.
 */
import { describe, expect, it } from 'vitest';
import { analyzeAccuracy } from './accuracy';
import { CTX, singAudio } from './core-test-helpers';
import { hzToMidi } from '../core/music';

describe('analyzeAccuracy on real detector output', () => {
  it('a steady 220 Hz tone through the MPM detector measures as near-perfectly in tune', () => {
    const durationSec = 2;
    const frames = singAudio({ duration: durationSec, midi: () => hzToMidi(220) });
    const note = { midi: hzToMidi(220), start: 0, end: durationSec };
    const r = analyzeAccuracy(frames, note, CTX);

    expect(r.voicedSec).toBeGreaterThan(durationSec * 0.9);
    expect(Math.abs(r.biasCents)).toBeLessThan(5);
    expect(r.sdCents).toBeLessThan(5);
    expect(r.inTolerancePct).toBeGreaterThan(95);
    expect(r.coverage).toBeGreaterThan(0.9);
  });

  it('a tone that is 35 cents sharp of the target measures as out of a +/-25c tolerance', () => {
    const durationSec = 1.5;
    const frames = singAudio({ duration: durationSec, midi: () => hzToMidi(220) + 0.35 });
    const note = { midi: hzToMidi(220), start: 0, end: durationSec }; // target is the UN-sharpened 220 Hz
    const r = analyzeAccuracy(frames, note, CTX);

    expect(r.biasCents).toBeGreaterThan(25);
    expect(r.biasCents).toBeLessThan(45);
    expect(r.inTolerancePct).toBeLessThan(10);
  });

  it('recovers flat and sharp offsets within a few cents on a noisy (-25 dBFS) signal, and the verdict flips at the tolerance edge', () => {
    for (const cents of [-35, -20, 0, 20, 35]) {
      const frames = singAudio({ duration: 3, midi: (t) => (t < 0.2 ? NaN : 60 + cents / 100), noiseDb: -25 });
      const r = analyzeAccuracy(frames, { midi: 60, start: 0.2, end: 3 }, CTX);
      expect(Math.abs(r.biasCents - cents)).toBeLessThan(3);
      expect(r.sdCents).toBeLessThan(4);
      expect(r.inTolerancePct).toBeGreaterThan(Math.abs(cents) <= 25 ? 95 : -1);
      if (Math.abs(cents) > 25) expect(r.inTolerancePct).toBeLessThan(5);
    }
  });

  it('a note sung only for its first second reports low coverage on real audio', () => {
    const frames = singAudio({ duration: 4, midi: (t) => (t < 1 ? 60 : NaN) });
    const r = analyzeAccuracy(frames, { midi: 60, start: 0, end: 4 }, CTX);
    expect(r.coverage).toBeLessThan(0.35);
  });

  it('a note sung only for its LAST second reports low coverage on real audio; a half-second reaction time does not', () => {
    const end = singAudio({ duration: 4, midi: (t) => (t >= 3 ? 60 : NaN) });
    expect(analyzeAccuracy(end, { midi: 60, start: 0, end: 4 }, CTX).coverage).toBeLessThan(0.4);
    const reaction = singAudio({ duration: 4, midi: (t) => (t >= 0.5 ? 60 : NaN) });
    expect(analyzeAccuracy(reaction, { midi: 60, start: 0, end: 4 }, CTX).coverage).toBeGreaterThan(0.9);
  });

  it('a glide sung on the moving target scores as accurate against that target', () => {
    const glide = { midi: 55, toMidi: 62, start: 0.2, end: 3.2 };
    const frames = singAudio({
      duration: 3.4,
      midi: (t) => (t < glide.start ? NaN : t > glide.end ? 62 : glide.midi + ((t - glide.start) / (glide.end - glide.start)) * (glide.toMidi - glide.midi)),
    });
    const r = analyzeAccuracy(frames, glide, CTX);
    expect(Math.abs(r.biasCents)).toBeLessThan(15);
    expect(r.inTolerancePct).toBeGreaterThan(85);
  });

  it('works at 44.1 kHz as well as 48 kHz (the hop differs; the analysis must not care)', () => {
    const frames = singAudio({ duration: 2, midi: () => 64, sampleRate: 44100 });
    const r = analyzeAccuracy(frames, { midi: 64, start: 0, end: 2 }, CTX);
    expect(Math.abs(r.biasCents)).toBeLessThan(5);
    expect(r.voicedSec).toBeGreaterThan(1.7);
    expect(r.voicedSec).toBeLessThan(2.1);
  });
});
