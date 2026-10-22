/**
 * Audio-level integration test: real vibrato audio -> real MPM detector ->
 * real Framer -> real PitchFrame track -> analyzeVibrato. Proves the
 * detrend / lobe / rate / extent pipeline also works on actual detector output
 * (its own per-frame jitter, 43 ms window smearing and onset latency
 * included), not just the exact fixture contours in vibrato.test.ts.
 *
 * Reading the numbers: the detector's 43 ms analysis window low-passes the
 * pitch contour, so a measured extent comes out ~7% under the true one at
 * 5.8 Hz and ~14% under at 7.5 Hz. The assertions allow for that; the style
 * zones in CONFIG are therefore zones of what THIS tracker measures.
 */
import { describe, expect, it } from 'vitest';
import { analyzeVibrato, findVibratoEpisodes } from './vibrato';
import { CTX, singAudio } from './core-test-helpers';
import { hzToMidi } from '../core/music';

const vib = (midi: number, rate: number, extentCents: number, from = 0) => (t: number) => (t < from ? midi : midi + (extentCents / 100) * Math.sin(2 * Math.PI * rate * (t - from)));

describe('analyzeVibrato on real detector output', () => {
  it('recovers a 5.8 Hz +/-45c vibrato sung at A3 through the MPM detector', () => {
    const durationSec = 2.5;
    const baseHz = 220; // A3
    const frames = singAudio({ duration: durationSec, midi: vib(hzToMidi(baseHz), 5.8, 45) });

    const note = { midi: hzToMidi(baseHz), start: 0, end: durationSec };
    const r = analyzeVibrato(frames, note, CTX);

    expect(r.present).toBe(true);
    expect(r.rateHz).not.toBeNull();
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.15);
    expect(r.extentCents).not.toBeNull();
    expect(r.extentCents!).toBeGreaterThan(36); // ~7% under 45: the detector's window smooths the contour
    expect(r.extentCents!).toBeLessThan(48);
    expect(Math.abs(r.centeringCents!)).toBeLessThan(6);
    expect(r.regularity!).toBeGreaterThan(0.85);
    expect(r.inZone).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it('a steady (vibrato-free) tone through the detector reads as straight, not a false vibrato', () => {
    const durationSec = 2;
    const frames = singAudio({ duration: durationSec, midi: () => hzToMidi(220) });
    const r = analyzeVibrato(frames, { midi: hzToMidi(220), start: 0, end: durationSec }, CTX);
    expect(r.present).toBe(false);
    expect(r.flags).toContain('straight');
    expect(r.rateHz).toBeNull();
  });

  it('straight tones in a noisy room (-25, -20, -15 dBFS white noise) are still straight at low and high pitch', () => {
    for (const midi of [43, 57, 72]) {
      for (const noiseDb of [-25, -20, -15]) {
        const frames = singAudio({ duration: 3, midi: () => midi, noiseDb });
        const r = analyzeVibrato(frames, { midi, start: 0, end: 3 }, CTX);
        expect(r.present, `midi ${midi} noise ${noiseDb}`).toBe(false);
        expect(r.rateHz, `midi ${midi} noise ${noiseDb}`).toBeNull();
      }
    }
  });

  it('a 5.8 Hz vibrato in -20 dBFS room noise is still found, at the right rate', () => {
    const frames = singAudio({ duration: 3, midi: vib(57, 5.8, 45), noiseDb: -20 });
    const r = analyzeVibrato(frames, { midi: 57, start: 0, end: 3 }, CTX);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.2);
    expect(r.extentCents!).toBeGreaterThan(34);
    expect(r.extentCents!).toBeLessThan(50);
  });

  it('works across the voice (E2 to C6), at the rates and extents of both styles', () => {
    const cases: Array<{ midi: number; rate: number; ext: number; lo: number; hi: number }> = [
      { midi: 40, rate: 5.5, ext: 60, lo: 50, hi: 64 }, // E2
      { midi: 57, rate: 5.0, ext: 100, lo: 88, hi: 104 }, // classical-wide
      { midi: 72, rate: 6.2, ext: 40, lo: 31, hi: 44 },
      { midi: 84, rate: 6.0, ext: 45, lo: 36, hi: 48 }, // C6
      { midi: 57, rate: 4.2, ext: 40, lo: 34, hi: 44 }, // slow
      { midi: 57, rate: 7.5, ext: 50, lo: 38, hi: 52 }, // fast: the 43 ms window costs ~14%
    ];
    for (const c of cases) {
      const frames = singAudio({ duration: 3, midi: vib(c.midi, c.rate, c.ext), noiseDb: -25 });
      const r = analyzeVibrato(frames, { midi: c.midi, start: 0, end: 3 }, CTX);
      const label = `midi ${c.midi}, ${c.rate} Hz +/-${c.ext}`;
      expect(r.present, label).toBe(true);
      expect(Math.abs(r.rateHz! - c.rate), label).toBeLessThan(0.15);
      expect(r.extentCents!, label).toBeGreaterThan(c.lo);
      expect(r.extentCents!, label).toBeLessThan(c.hi);
    }
  });

  it('a wide classical vibrato is in the classical zone but not the pop zone', () => {
    const frames = singAudio({ duration: 3, midi: vib(57, 5.5, 85) });
    const note = { midi: 57, start: 0, end: 3 };
    expect(analyzeVibrato(frames, note, { toleranceCents: 25, vibratoStyle: 'classical' }).inZone).toBe(true);
    expect(analyzeVibrato(frames, note, { toleranceCents: 25, vibratoStyle: 'pop' }).inZone).toBe(false);
  });

  it('44.1 kHz audio works as well (a different hop; the analysis must not care)', () => {
    const frames = singAudio({ duration: 2.5, midi: vib(60, 5.8, 45), sampleRate: 44100 });
    const r = analyzeVibrato(frames, { midi: 60, start: 0, end: 2.5 }, CTX);
    expect(r.present).toBe(true);
    expect(Math.abs(r.rateHz! - 5.8)).toBeLessThan(0.2);
  });

  it('a vibrato that blooms 1.5 s into a note shows up as an episode starting near 1.5 s and as present windows after it', () => {
    const frames = singAudio({ duration: 4, midi: vib(60, 5.8, 45, 1.5) });
    const eps = findVibratoEpisodes(frames);
    expect(eps.length).toBe(1);
    expect(Math.abs(eps[0].startT - 1.5)).toBeLessThan(0.2);
    const r = analyzeVibrato(frames, { midi: 60, start: 0, end: 4 }, CTX);
    expect(r.windows.filter((w) => w.end <= 1.5).some((w) => w.present)).toBe(false);
    expect(r.windows.filter((w) => w.start >= 1.6 && w.end - w.start > 0.75).every((w) => w.present)).toBe(true);
  });

  it('a vibrato centred 40 cents flat on real audio flags sagging-flat', () => {
    const frames = singAudio({ duration: 3, midi: vib(59.6, 5.8, 45) }); // centred 40 cents flat
    const r = analyzeVibrato(frames, { midi: 60, start: 0, end: 3 }, CTX);
    expect(r.centeringCents!).toBeLessThan(-30);
    expect(r.flags).toContain('sagging-flat');
  });
});
