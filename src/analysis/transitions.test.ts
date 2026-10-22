import { describe, expect, it } from 'vitest';
import type { TargetNote } from '../core/types';
import { analyzeTransitions } from './transitions';
import { makeTrack, sustained } from './fixtures';
import { makeSung, runNotes } from './advanced-test-helpers';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { notesContour, synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const STUDIO: AnalyzeContext = { toleranceCents: 10, vibratoStyle: 'pop' };

/** A legato scale at 72 bpm (one beat = 833 ms per note). */
const LEGATO = runNotes([60, 62, 64, 65, 67, 65, 64, 62], 1 / 0.833, 0.2);

describe('analyzeTransitions', () => {
  it('marks quick, accurate legato changes as clean, even at studio tolerance', () => {
    for (const tr of [20, 30, 60]) {
      const r = analyzeTransitions(makeSung(LEGATO, { transitionMs: tr, jitterCents: 6 }), LEGATO, STUDIO);
      expect(r.transitions).toHaveLength(LEGATO.length - 1);
      expect(r.cleanRate).toBe(1);
      for (const t of r.transitions) {
        expect(t.durationMs).not.toBeNull();
        expect(t.durationMs as number).toBeLessThan(120);
        expect(t.overshootCents).toBeLessThanOrEqual(10);
      }
    }
  });

  it('indexes the pairs it measured', () => {
    const r = analyzeTransitions(makeSung(LEGATO, { transitionMs: 30 }), LEGATO, CTX);
    r.transitions.forEach((t, i) => {
      expect(t.fromIndex).toBe(i);
      expect(t.toIndex).toBe(i + 1);
    });
  });

  it('marks lazy slides into each note as not clean', () => {
    const r = analyzeTransitions(makeSung(LEGATO, { transitionMs: 400, jitterCents: 8 }), LEGATO, CTX);
    expect(r.cleanRate).toBeLessThan(0.5);
    const slow = r.transitions.filter((t) => !t.clean);
    expect(slow.length).toBeGreaterThanOrEqual(4);
    for (const t of slow) expect(t.durationMs as number).toBeGreaterThan(150);
  });

  it('the budget is relative to tempo: the same 150 ms change is clean on slow notes and not on fast ones', () => {
    const slowNotes = runNotes([60, 64, 67, 64, 60], 1 / 0.833, 0.2);
    const fastNotes = runNotes([60, 64, 67, 64, 60], 1 / 0.3, 0.2);
    const slow = analyzeTransitions(makeSung(slowNotes, { transitionMs: 190, jitterCents: 5 }), slowNotes, CTX);
    const fast = analyzeTransitions(makeSung(fastNotes, { transitionMs: 190, jitterCents: 5 }), fastNotes, CTX);
    expect(slow.cleanRate).toBe(1);
    expect(fast.cleanRate).toBeLessThan(0.5);
  });

  it('allows rising intervals more time than falling ones', () => {
    const up: TargetNote[] = [sustained(52, 0.2, 1.0), sustained(64, 1.0, 1.8)]; // an octave up
    const down: TargetNote[] = [sustained(64, 0.2, 1.0), sustained(52, 1.0, 1.8)]; // an octave down
    const slowish = { transitionMs: 270, jitterCents: 4 }; // measures ~220 ms: over the falling budget (160 ms), under the rising one (160 + 8 ms x 12)
    const r1 = analyzeTransitions(makeSung(up, slowish), up, CTX);
    const r2 = analyzeTransitions(makeSung(down, slowish), down, CTX);
    expect(r1.transitions[0].durationMs).toBeCloseTo(r2.transitions[0].durationMs as number, -2);
    expect(r1.transitions[0].clean).toBe(true);
    expect(r2.transitions[0].clean).toBe(false);
  });

  it('flags a transition that overshoots the new note', () => {
    const notes = [sustained(60, 0, 0.8), sustained(67, 0.8, 1.6)];
    const over = (t: number): number => (t < 0.8 ? 60 : t < 0.86 ? 68 : t < 0.95 ? 68 - (t - 0.86) / 0.09 : 67);
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: over, jitterCents: 6 }), notes, CTX);
    expect(r.transitions[0].overshootCents).toBeGreaterThan(80);
    expect(r.transitions[0].overshootCents).toBeLessThan(130);
    expect(r.transitions[0].clean).toBe(false);
    expect(r.cleanRate).toBe(0);
  });

  it('measures overshoot past where the singer settled, so a consistent sharp landing is not an overshoot', () => {
    const notes = [sustained(60, 0, 0.8), sustained(67, 0.8, 1.6)];
    const sharp = (t: number): number => (t < 0.8 ? 60 : 67.18); // lands 18 c sharp and stays
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: sharp, jitterCents: 4 }), notes, STUDIO);
    expect(r.transitions[0].overshootCents).toBeLessThan(8);
    expect(r.transitions[0].clean).toBe(true);
  });

  it('marks a change that never settles on the new note as not clean, with no duration', () => {
    const notes = [sustained(60, 0, 0.8), sustained(64, 0.8, 1.6)];
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: (t) => (t < 0.8 ? 60 : 70) }), notes, CTX);
    expect(r.transitions[0].durationMs).toBeNull();
    expect(r.transitions[0].clean).toBe(false);
  });

  it('marks a pair as unmeasured and not clean when the first note was never sung', () => {
    const notes = [sustained(60, 0, 0.8), sustained(64, 0.8, 1.6)];
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: (t) => (t < 0.8 ? NaN : 64) }), notes, CTX);
    expect(r.transitions[0].durationMs).toBeNull();
    expect(r.transitions[0].clean).toBe(false);
  });

  it('does not credit a singer who held the first note and never moved, or who sang the second note from the start', () => {
    const notes = [sustained(60, 0, 0.8), sustained(64, 0.8, 1.6)];
    expect(analyzeTransitions(makeTrack({ duration: 1.7, midi: (t) => (t < 1.6 ? 60 : NaN) }), notes, CTX).cleanRate).toBe(0);
    expect(analyzeTransitions(makeTrack({ duration: 1.7, midi: (t) => (t < 1.6 ? 64 : NaN) }), notes, CTX).cleanRate).toBe(0);
  });

  it('counts a breath between the notes as transition time: a broken legato line is not clean', () => {
    const notes = [sustained(60, 0, 0.8), sustained(64, 0.8, 1.6)];
    const broken = (t: number): number => (t < 0.8 ? 60 : t < 1.1 ? NaN : 64); // 300 ms of silence
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: broken }), notes, CTX);
    expect(r.transitions[0].durationMs as number).toBeGreaterThan(250);
    expect(r.transitions[0].clean).toBe(false);
  });

  it('is not thrown by wobble in the first note before the change', () => {
    const notes = [sustained(60, 0, 0.8), sustained(64, 0.8, 1.6)];
    const wobbly = (t: number): number => (t < 0.8 ? 60 + (t > 0.3 && t < 0.4 ? 0.6 : 0) : 64); // a 60 c blip well before the change
    const r = analyzeTransitions(makeTrack({ duration: 1.7, midi: wobbly, jitterCents: 5 }), notes, STUDIO);
    expect(r.transitions[0].durationMs as number).toBeLessThan(60);
    expect(r.transitions[0].clean).toBe(true);
  });

  it('treats a repeated pitch as nothing to move', () => {
    const notes = [sustained(60, 0, 0.5), sustained(60, 0.5, 1)];
    const r = analyzeTransitions(makeTrack({ duration: 1.1, midi: () => 60 }), notes, CTX);
    expect(r.transitions[0].clean).toBe(true);
    expect(r.transitions[0].durationMs).toBe(0);
  });

  it('a repeated pitch is not clean if the second note was never sung', () => {
    const notes = [sustained(60, 0, 0.5), sustained(60, 0.5, 1)];
    const r = analyzeTransitions(makeTrack({ duration: 1.1, midi: (t) => (t < 0.5 ? 60 : NaN) }), notes, CTX);
    expect(r.transitions[0].clean).toBe(false);
    expect(r.transitions[0].durationMs).toBeNull();
  });

  it('returns an empty result for a single note or none', () => {
    expect(analyzeTransitions(makeTrack({ duration: 0.5, midi: () => 60 }), [sustained(60, 0, 0.5)], CTX)).toEqual({ transitions: [], cleanRate: 0 });
    expect(analyzeTransitions([], [], CTX)).toEqual({ transitions: [], cleanRate: 0 });
  });

  it('handles an empty track', () => {
    const r = analyzeTransitions([], LEGATO, CTX);
    expect(r.transitions).toHaveLength(LEGATO.length - 1);
    expect(r.cleanRate).toBe(0);
  });

  it('is fast on a long legato take', () => {
    const notes = runNotes(
      Array.from({ length: 70 }, (_, i) => 55 + ((i * 5) % 9)),
      1.2,
      0.2,
    );
    const track = makeSung(notes, { transitionMs: 40 });
    analyzeTransitions(track, notes, CTX);
    const t0 = performance.now();
    const r = analyzeTransitions(track, notes, CTX);
    const ms = performance.now() - t0;
    expect(r.cleanRate).toBeGreaterThan(0.95);
    expect(ms).toBeLessThan(100); // ~4 ms measured; only catches pathological complexity
  });
});

describe('analyzeTransitions: through the real detector (synthesized audio -> Framer -> MPM)', () => {
  it('finds a connected legato line clean', () => {
    const SR = 48000;
    const spans = LEGATO.map((n) => ({ midi: n.midi, start: n.start, end: n.end }));
    const contour = notesContour(spans);
    // no gaps between notes: pitch steps instantly and the detector's 43 ms window supplies the blur
    const audio = synthesize({ sampleRate: SR, duration: LEGATO[LEGATO.length - 1].end + 0.1, f0: (t) => (t < LEGATO[0].start ? NaN : contour(t) || midiToHz(LEGATO[LEGATO.length - 1].midi)) });
    const r = analyzeTransitions(trackFromAudio(audio, SR), LEGATO, STUDIO);
    expect(r.cleanRate).toBeGreaterThanOrEqual(0.85);
  });
});
