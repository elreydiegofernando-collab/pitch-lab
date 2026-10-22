/**
 * A singer who just sings plain notes must not pass the inflection levels (F2 of the Wave 1 review).
 *
 * The score ceilings for "did not do the figure at all" used to be 0.40-0.45, above the easy tier's
 * inflection.score gate (0.27), so plain notes passed Intentional scoop, Falls and the first audition;
 * and the take-level score was the MEAN of the figures, so a Boss Recital whose timed slide was skipped
 * (turn, turn, slide, flip = 1.0, 1.0, 0.2, 0.98) averaged 0.80 against a 0.57 gate.
 *
 * Plain notes legitimately DO pass the turn and flip levels: those figures are plain notes.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { analyzeTake } from '../exercises/analyze';
import { gate } from '../exercises/catalog/scoring';
import { INFLECTIONS_EXERCISES } from '../exercises/catalog/inflections';
import { evaluate } from '../exercises/evaluate';
import { planAnalysis } from '../exercises/plan';
import { GOOD_SINGER, singTake, type SingerModel } from '../exercises/test-singer';
import { realize } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { analyzeInflection, combineInflectionScores } from './inflections';
import { makeTrack } from './fixtures';
import { sungContour } from './advanced-test-helpers';
import type { AnalyzeContext } from './types';

const CTX: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
const EASY_GATE = gate('inflection.score', 'easy').value; // the lowest gate any level sets (0.27)
const STUDIO_GATE = gate('inflection.score', 'studio').value; // 0.57

const SLOPPY: SingerModel = { ...GOOD_SINGER, jitterCents: 8, scoopCents: 25, transitionMs: 70 };
const MODERATE: SingerModel = { ...GOOD_SINGER, jitterCents: 6, scoopCents: 40, transitionMs: 90, biasCents: 12 };
const byId = (id: string): ExerciseDef => INFLECTIONS_EXERCISES.find((d) => d.id === id) as ExerciseDef;

/** Every sung step as one plain pitch (a glide is sung as its destination), with the exercise's own timing: what a singer who ignores the figures does. */
function plainNotes(def: ExerciseDef, seed: number): PitchFrame[] {
  const rz = realize(def, null, 'tenor');
  const sung = rz.steps.filter((s) => s.role === 'sing').map((s) => ({ midi: (s.toMidi ?? s.midi) as number, start: s.start, end: s.end }));
  const contour = sungContour(sung, 30);
  return makeTrack({ duration: rz.totalSec + 1, t0: -0.5, midi: contour, jitterCents: 3, seed, rmsDb: (t) => (Number.isFinite(contour(t)) ? -20 : -80) });
}

describe('a figure that was not done at all scores under every gate (analyzer level)', () => {
  const track = (midi: (t: number) => number, end: number) => makeTrack({ duration: end + 0.4, midi, jitterCents: 6, seed: 3 });

  it('a scoop sung as a plain note', () => {
    const G: TargetNote = { midi: 62, toMidi: 64, start: 1.0, end: 1.4167 };
    const r = analyzeInflection(track((t) => (t >= 1.0 && t < 3.0 ? 64 : NaN), 3.0), 'scoop', [G], CTX);
    expect(r.detected).toBe(false);
    expect(r.score).toBeLessThan(EASY_GATE);
  });

  it('a scoop that never arrives', () => {
    const G: TargetNote = { midi: 62, toMidi: 64, start: 1.0, end: 1.4167 };
    const r = analyzeInflection(track((t) => (t >= 1.0 ? 62.2 + 0.3 * Math.sin(t * 5) : NaN), 3.0), 'scoop', [G], CTX);
    expect(r.score).toBeLessThan(EASY_GATE);
  });

  it('a held note that stops, or steps down, instead of falling', () => {
    const H: TargetNote = { midi: 67, start: 0.5, end: 2.2 };
    const F: TargetNote = { midi: 67, toMidi: 62, start: 2.2, end: 3.0333 };
    const stops = analyzeInflection(track((t) => (t >= 0.5 && t < 2.3 ? 67 : NaN), 3.0), 'fall', [H], CTX);
    expect(stops.detected).toBe(false);
    expect(stops.score).toBeLessThan(EASY_GATE);
    const steps = analyzeInflection(track((t) => (t < 0.5 ? NaN : t < F.start ? 67 : 62), 3.1), 'fall', [H, F], CTX);
    expect(steps.detected).toBe(false);
    expect(steps.score).toBeLessThan(EASY_GATE);
  });

  it('a slide sung as the destination note, or as a jump', () => {
    const G: TargetNote = { midi: 60, toMidi: 65, start: 1.0, end: 1.8333 };
    const plain = analyzeInflection(track((t) => (t >= 0.2 && t < 3.0 ? 65 : NaN), 3.0), 'slide', [G], CTX);
    expect(plain.detected).toBe(false);
    expect(plain.score).toBeLessThan(EASY_GATE);
    const jump = analyzeInflection(track((t) => (t < 0.2 ? NaN : t < 1.8333 ? 60 : 65), 3.0), 'slide', [G], CTX);
    expect(jump.score).toBeLessThan(EASY_GATE);
  });

  it('a neighbour never sung in a turn, and a flip that is only a third', () => {
    const MAIN: TargetNote = { midi: 60, start: 1.0, end: 4.0 };
    const UP: TargetNote = { midi: 62, start: 1.8, end: 2.2 };
    const flatMain = analyzeInflection(track((t) => (t >= 1.0 && t < 4.0 ? 60 : NaN), 4.0), 'turn', [MAIN, UP], CTX);
    expect(flatMain.detected).toBe(false);
    expect(flatMain.score).toBeLessThan(EASY_GATE);
    const LOW: TargetNote = { midi: 60, start: 0.5, end: 2.3 };
    const HIGH: TargetNote = { midi: 67, start: 2.3, end: 4.1 };
    const small = analyzeInflection(track((t) => (t < 0.5 ? NaN : t < 2.3 ? 60 : 63), 4.1), 'flip', [LOW, HIGH], CTX);
    expect(small.detected).toBe(false);
    expect(small.score).toBeLessThan(EASY_GATE);
  });

  it('a slide of three times the requested length', () => {
    const A: TargetNote = { midi: 60, start: 0.2, end: 1.0 };
    const G: TargetNote = { midi: 60, toMidi: 65, start: 1.0, end: 1.8333 };
    const crawl = sungContour([A, { ...G, end: 3.5 }, { midi: 65, start: 3.5, end: 5 }], 30);
    expect(analyzeInflection(track(crawl, 5.0), 'slide', [G], CTX).score).toBeLessThan(EASY_GATE);
  });
});

describe('the real inflection exercises: plain notes fail the figures that are not plain notes', () => {
  // Every level whose figure is a scoop, a fall or a timed slide.
  for (const id of ['inflections.scoop.1', 'inflections.fall.1', 'inflections.slide.1', 'inflections.slide.2', 'inflections.audition.1', 'inflections.audition.2']) {
    it(`${id}: a singer of plain notes fails, in every one of 3 takes`, () => {
      const def = byId(id);
      const rz = realize(def, null, 'tenor');
      for (let seed = 1; seed <= 3; seed++) {
        const a = analyzeTake(def, rz, plainNotes(def, seed), { vibratoStyle: 'pop' });
        expect(a.metrics['inflection.score'], `seed ${seed}`).toBeLessThan(EASY_GATE);
        expect(evaluate(def, a.metrics).passed, `seed ${seed}`).toBe(false);
      }
    });
  }

  it('plain notes legitimately pass the turn and flip levels: those figures ARE plain notes', () => {
    for (const id of ['inflections.turn.1', 'inflections.turn.2', 'inflections.flip.1', 'inflections.flip.2']) {
      const def = byId(id);
      const rz = realize(def, null, 'tenor');
      expect(evaluate(def, analyzeTake(def, rz, plainNotes(def, 1), { vibratoStyle: 'pop' }).metrics).passed, id).toBe(true);
    }
  });
});

describe('the real inflection exercises: real singers keep passing every level', () => {
  const singers: Array<[string, SingerModel]> = [['good', GOOD_SINGER], ['sloppy (8 c jitter, 25 c scoop, 70 ms moves)', SLOPPY], ['moderate (6 c, 40 c scoop, 90 ms moves, 12 c sharp)', MODERATE]];
  for (const [label, singer] of singers) {
    it(`a ${label} singer passes all ${INFLECTIONS_EXERCISES.length} exercises in 3 takes each`, () => {
      for (const def of INFLECTIONS_EXERCISES) {
        const rz = realize(def, null, 'tenor');
        for (let seed = 1; seed <= 3; seed++) {
          const a = analyzeTake(def, rz, singTake(rz, { ...singer, seed }), { vibratoStyle: 'pop' });
          expect(evaluate(def, a.metrics).passed, `${def.id} seed ${seed}`).toBe(true);
        }
      }
    });
  }
});

describe('the Boss Recital: a skipped figure cannot average its way past the gate', () => {
  const def = byId('inflections.boss-recital');
  const rz = realize(def, null, 'tenor');
  const plan = planAnalysis(rz);

  it('plain notes give turn, turn, slide, flip scores of about 1, 1, 0.2, 1', () => {
    const track = plainNotes(def, 1);
    const scores = plan.inflections.map((g) => analyzeInflection(track, g.kind, g.targets, { toleranceCents: 10, vibratoStyle: 'pop' }));
    expect(scores.map((s) => s.kind)).toEqual(['turn', 'turn', 'slide', 'flip']);
    expect(scores[2].detected).toBe(false);
    expect(scores[2].score).toBeLessThanOrEqual(0.2);
    for (const i of [0, 1, 3]) expect(scores[i].score).toBeGreaterThan(0.9);
  });

  it('their mean clears the studio gate (so a mean cannot judge it) and combineInflectionScores does not', () => {
    const track = plainNotes(def, 1);
    const scores = plan.inflections.map((g) => analyzeInflection(track, g.kind, g.targets, { toleranceCents: 10, vibratoStyle: 'pop' }).score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(mean).toBeGreaterThan(STUDIO_GATE);
    expect(combineInflectionScores(scores)).toBeLessThan(STUDIO_GATE);
  });

  it('a clean take of the Boss is unaffected: all four figures done, so the combined score is the mean', () => {
    const scores = plan.inflections.map((g) => analyzeInflection(singTake(rz, { ...GOOD_SINGER, seed: 1 }), g.kind, g.targets, { toleranceCents: 10, vibratoStyle: 'pop' }).score);
    expect(Math.min(...scores)).toBeGreaterThan(0.85);
    expect(combineInflectionScores(scores)).toBeGreaterThan(STUDIO_GATE + 0.2);
  });
});

describe('combineInflectionScores', () => {
  it('is the figure\'s own score for a take with one figure, or with figures alike', () => {
    expect(combineInflectionScores([0.73])).toBeCloseTo(0.73, 12);
    expect(combineInflectionScores([0.4, 0.4, 0.4])).toBeCloseTo(0.4, 12);
  });

  it('is half the mean and half the worst', () => {
    expect(combineInflectionScores([1, 1, 0.2, 0.98])).toBeCloseTo(0.5 * ((1 + 1 + 0.2 + 0.98) / 4) + 0.5 * 0.2, 12);
    expect(combineInflectionScores([1, 0])).toBeCloseTo(0.25, 12);
  });

  it('ignores scores that are not numbers, and is NaN when there are none', () => {
    expect(combineInflectionScores([0.8, Number.NaN, 0.6])).toBeCloseTo(0.5 * 0.7 + 0.5 * 0.6, 12);
    expect(Number.isNaN(combineInflectionScores([]))).toBe(true);
    expect(Number.isNaN(combineInflectionScores([Number.NaN]))).toBe(true);
  });

  it('stays within 0..1 and never exceeds the mean', () => {
    for (const xs of [[0, 0], [1, 1, 1], [0.1, 0.9], [0.5], [1, 0.2, 0.2]]) {
      const c = combineInflectionScores(xs);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
      expect(c).toBeLessThanOrEqual(xs.reduce((a, b) => a + b, 0) / xs.length + 1e-12);
    }
  });
});
