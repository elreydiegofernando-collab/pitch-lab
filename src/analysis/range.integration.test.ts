/**
 * Audio-level integration test for analyzeRange: a synthesized range-finder
 * take (siren down, hold the lowest note, siren up, hold the highest) through
 * the real MPM detector and Framer.
 */
import { describe, expect, it } from 'vitest';
import { analyzeRange } from './range';
import { attackEnvelope, singAudio } from './core-test-helpers';

/** Siren 57 -> 48 (1 s), hold 48 for 2 s, rest, siren 57 -> 69 (1 s), hold 69 (with vibrato) for 2.2 s. */
function rangeFinderTake(noiseDb?: number, vibratoOnTop = true) {
  return singAudio({
    duration: 8,
    noiseDb,
    midi: (t) => {
      if (t < 0.3) return NaN;
      if (t < 1.3) return 57 - 9 * (t - 0.3);
      if (t < 3.3) return 48;
      if (t < 4.0) return NaN;
      if (t < 5.0) return 57 + 12 * (t - 4.0);
      if (t < 7.2) return 69 + (vibratoOnTop ? 0.4 * Math.sin(2 * Math.PI * 5.5 * t) : 0);
      return NaN;
    },
    amp: (t) => (t < 4.0 ? attackEnvelope(0.3, 0.05)(t) : attackEnvelope(4.0, 0.05)(t)),
  });
}

describe('analyzeRange on real detector output', () => {
  it('finds exactly the two held extremes of a range-finder take; the sirens hold nothing', () => {
    const r = analyzeRange(rangeFinderTake());
    expect(r.lowestMidi).toBe(48);
    expect(r.highestMidi).toBe(69);
    expect(r.heldNotes.length).toBe(2);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(1.8);
    expect(r.heldNotes[1].durationSec).toBeGreaterThan(1.9);
  });

  it('still finds them in room noise (-25 dBFS)', () => {
    const r = analyzeRange(rangeFinderTake(-25));
    expect(r.lowestMidi).toBe(48);
    expect(r.highestMidi).toBe(69);
  });

  it('a high note held with vibrato counts the same as one held straight', () => {
    const straight = analyzeRange(rangeFinderTake(undefined, false));
    const vib = analyzeRange(rangeFinderTake(undefined, true));
    expect(vib.highestMidi).toBe(straight.highestMidi);
  });

  it('a note held for only 0.7 s does not count, at any pitch', () => {
    const frames = singAudio({ duration: 2.5, midi: (t) => (t >= 0.3 && t < 1.0 ? 72 : t >= 1.3 && t < 2.4 ? 55 : NaN), amp: attackEnvelope(0.3, 0.05) });
    const r = analyzeRange(frames);
    expect(r.heldNotes.map((n) => n.midi)).toEqual([55]);
    expect(r.highestMidi).toBe(55);
  });

  it('works at the extremes of the supported range (E2 and C6)', () => {
    const lo = analyzeRange(singAudio({ duration: 2.5, midi: (t) => (t >= 0.3 ? 40 : NaN), amp: attackEnvelope(0.3, 0.05) }));
    expect(lo.lowestMidi).toBe(40);
    const hi = analyzeRange(singAudio({ duration: 2.5, midi: (t) => (t >= 0.3 ? 84 : NaN), amp: attackEnvelope(0.3, 0.05) }));
    expect(hi.highestMidi).toBe(84);
  });
});

/**
 * Vibrato up to the top of the classical zone, through the real detector. The detector adds its own
 * jitter and a few glitch frames to a swing this wide, which is what used to cut (or lose) the hold:
 * +/-60 c was cut short, and +/-70 c and wider found no held note at all.
 */
describe('analyzeRange on real detector output: wide vibrato', () => {
  const A3 = 57;
  const vibratoHold = (extentCents: number, rateHz: number, phase: number, midi = A3) =>
    singAudio({
      duration: 3.7,
      midi: (t) => (t < 0.2 ? NaN : midi + (extentCents / 100) * Math.sin(2 * Math.PI * rateHz * (t - 0.2) + phase)),
      amp: attackEnvelope(0.2, 0.05),
    });

  it.each([
    [60, 5.8, 0],
    [70, 5, 1],
    [80, 6.5, 2],
    [100, 5.8, 0],
    [100, 5, 2],
    [100, 6.5, 1],
  ])('A3 held for 3.5 s with +/-%i c vibrato at %f Hz (phase %f) is one whole hold on A3', (extent, rate, phase) => {
    const r = analyzeRange(vibratoHold(extent, rate, phase));
    expect(r.heldNotes.length).toBe(1);
    expect(r.heldNotes[0].midi).toBe(A3);
    expect(r.heldNotes[0].durationSec).toBeGreaterThan(3.3);
    expect(r.lowestMidi).toBe(A3);
    expect(r.highestMidi).toBe(A3);
  });

  it('a wide vibrato still does not hide a semitone step: 2 s of A3 then 2 s of B-flat 3, each with +/-80 c vibrato, are two holds', () => {
    const frames = singAudio({
      duration: 4.4,
      midi: (t) => (t < 0.2 ? NaN : (t < 2.2 ? A3 : A3 + 1) + 0.8 * Math.sin(2 * Math.PI * 5.8 * t)),
      amp: attackEnvelope(0.2, 0.05),
    });
    const r = analyzeRange(frames);
    expect(r.heldNotes.map((n) => n.midi)).toEqual([A3, A3 + 1]);
  });

  it('a slow siren sung through the detector (50 c/s, then 100 c/s with +/-60 c vibrato on it) holds nothing', () => {
    const slow = singAudio({ duration: 7, midi: (t) => (t < 0.2 ? NaN : 50 + 0.5 * (t - 0.2)), amp: attackEnvelope(0.2, 0.05) });
    expect(analyzeRange(slow).heldNotes).toEqual([]);
    const wobbly = singAudio({
      duration: 5,
      midi: (t) => (t < 0.2 ? NaN : 50 + (t - 0.2) + 0.6 * Math.sin(2 * Math.PI * 5.8 * t)),
      amp: attackEnvelope(0.2, 0.05),
    });
    expect(analyzeRange(wobbly).heldNotes).toEqual([]);
  });
});
