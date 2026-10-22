import { describe, expect, it } from 'vitest';
import { CONFIG } from '../config';
import { makeTrack } from '../analysis/fixtures';
import { parseSwellShape } from '../audio/demos';
import { EXERCISES } from './catalog';
import { CUE, loudnessContourOf, type LoudnessContour } from './cues';
import { FOLLOWS_CUE_SCORE, contourAt, loudnessShapeScore } from './loudness';
import { planAnalysis } from './plan';
import { realize } from './transpose';

const SOFT = -38;
const LOUD = -14;
const NOTE = { midi: 60, start: 0, end: 6 };
const cresc = loudnessContourOf(CUE.crescendo)!;
const decresc = loudnessContourOf(CUE.decrescendo)!;
const swell = loudnessContourOf(CUE.swell)!;
const steps = (cue: string): LoudnessContour => loudnessContourOf(cue)!;

/** A 6 s held note whose level follows `level(u)` (0..1 of the note: 0 = soft, 1 = loud). */
function sung(level: (u: number) => number, o: { jitterDb?: number; seed?: number } = {}) {
  let k = o.seed ?? 1;
  const noise = () => {
    k = (k * 16807) % 2147483647;
    return (k / 2147483647 - 0.5) * 2 * (o.jitterDb ?? 0);
  };
  return makeTrack({ duration: 6, midi: () => 60, rmsDb: (t) => SOFT + (LOUD - SOFT) * level(t / 6) + noise(), jitterCents: 3 });
}

describe('loudnessContourOf: what a cue asks for', () => {
  it('reads the shape cues as smooth ramps and soft/loud cues as equal steps', () => {
    expect(cresc).toEqual({ points: ['soft', 'loud'], smooth: true });
    expect(decresc).toEqual({ points: ['loud', 'soft'], smooth: true });
    expect(swell).toEqual({ points: ['soft', 'loud', 'soft'], smooth: true });
    expect(steps('Loud, soft, loud: change every two clicks')).toEqual({ points: ['loud', 'soft', 'loud'], smooth: false });
  });

  it('asks nothing of other cues, or of a step cue that never changes level', () => {
    expect(loudnessContourOf(undefined)).toBeNull();
    expect(loudnessContourOf('Hold it steady and straight')).toBeNull();
    expect(loudnessContourOf('Soft, softer, soft')).toBeNull();
    expect(loudnessContourOf(CUE.straight)).toBeNull();
  });

  it('agrees with what the Listen demo plays (src/audio/demos.ts) for every loudness cue in the catalog', () => {
    const cues = new Set(EXERCISES.flatMap((e) => e.pattern.map((s) => s.cue)).filter((c): c is string => loudnessContourOf(c) !== null));
    expect(cues.size).toBe(6); // the three shape cues and the three step cues
    for (const cue of cues) {
      const demo = parseSwellShape(cue);
      expect(demo && { points: demo.points, smooth: demo.smooth }, cue).toEqual(loudnessContourOf(cue));
    }
  });

  it('gives every dynamics hold in the catalog a contour to be judged against', () => {
    for (const def of EXERCISES.filter((e) => e.analyzers.includes('dynamics'))) {
      const plan = planAnalysis(realize(def, null, 'tenor'));
      expect(plan.dynamics.length, def.id).toBeGreaterThan(0);
      for (const d of plan.dynamics) expect(d.contour, def.id).not.toBeNull();
    }
  });
});

describe('contourAt', () => {
  it('ramps through smooth stops and holds each step for an equal part', () => {
    expect(contourAt(cresc, 0)).toBe(0);
    expect(contourAt(cresc, 0.25)).toBeCloseTo(0.25, 12);
    expect(contourAt(decresc, 0.25)).toBeCloseTo(0.75, 12);
    expect(contourAt(swell, 0.25)).toBeCloseTo(0.5, 12);
    expect(contourAt(swell, 0.5)).toBe(1);
    expect(contourAt(swell, 1)).toBe(0);
    const sls = steps('Soft, loud, soft: change every two clicks');
    expect([0.1, 0.4, 0.6, 0.9, 1].map((u) => contourAt(sls, u))).toEqual([0, 1, 1, 0, 0]);
    expect(contourAt(cresc, -1)).toBe(0); // clamped
    expect(contourAt(cresc, 2)).toBe(1);
  });
});

describe('loudnessShapeScore', () => {
  it('scores about 1 when the level follows the cue', () => {
    expect(loudnessShapeScore(sung((u) => u), NOTE, cresc)).toBeGreaterThan(0.95);
    expect(loudnessShapeScore(sung((u) => 1 - u), NOTE, decresc)).toBeGreaterThan(0.95);
    expect(loudnessShapeScore(sung((u) => 1 - Math.abs(2 * u - 1)), NOTE, swell)).toBeGreaterThan(0.95);
    const lsl = steps('Loud, soft, loud: change every two clicks');
    expect(loudnessShapeScore(sung((u) => contourAt(lsl, u)), NOTE, lsl)).toBeGreaterThan(0.95);
  });

  it('forgives an uneven but faithful shape: an early peak, a level ripple, late steps', () => {
    const earlyPeak = (u: number) => (u < 0.3 ? u / 0.3 : (1 - u) / 0.7); // a real, lopsided messa di voce
    expect(loudnessShapeScore(sung(earlyPeak), NOTE, swell)!).toBeGreaterThan(FOLLOWS_CUE_SCORE + 0.2);
    expect(loudnessShapeScore(sung((u) => u, { jitterDb: 3 }), NOTE, cresc)!).toBeGreaterThan(0.9);
    const sls = steps('Soft, loud, soft: change every two clicks');
    expect(loudnessShapeScore(sung((u) => contourAt(sls, u - 0.05)), NOTE, sls)!).toBeGreaterThan(FOLLOWS_CUE_SCORE + 0.2); // 0.3 s late on each change
  });

  it('scores 0 for the opposite way and for one way through a swell', () => {
    expect(loudnessShapeScore(sung((u) => 1 - u), NOTE, cresc)).toBe(0);
    expect(loudnessShapeScore(sung((u) => u), NOTE, decresc)).toBe(0);
    expect(loudnessShapeScore(sung((u) => Math.abs(2 * u - 1)), NOTE, swell)).toBe(0); // loud, soft, loud
    expect(loudnessShapeScore(sung((u) => u), NOTE, swell)!).toBeLessThan(FOLLOWS_CUE_SCORE); // a crescendo is no swell
    const sls = steps('Soft, loud, soft: change every two clicks');
    expect(loudnessShapeScore(sung((u) => 1 - contourAt(sls, u)), NOTE, sls)).toBe(0); // the steps swapped
  });

  it('has nothing to judge when the level hardly moved or the note was hardly sung', () => {
    const quiet = makeTrack({ duration: 6, midi: () => 60, rmsDb: (t) => -20 + (CONFIG.dynamics.minRangeDb - 2) * (t / 6) });
    expect(loudnessShapeScore(quiet, NOTE, cresc)).toBeNull();
    const silent = makeTrack({ duration: 6, midi: () => NaN });
    expect(loudnessShapeScore(silent, NOTE, cresc)).toBeNull();
    const blip = makeTrack({ duration: 6, midi: (t) => (t < 0.2 ? 60 : NaN), rmsDb: (t) => (t < 0.2 ? -20 : -80) });
    expect(loudnessShapeScore(blip, NOTE, cresc)).toBeNull();
  });
});
