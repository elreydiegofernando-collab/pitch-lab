/**
 * Integration of the advanced analyzers with the exercise engine: the REAL catalog,
 * realized with realize(), planned with planAnalysis() and scored with analyzeTake() +
 * evaluate(). Ideal synthetic singing must pass everything that depends on these
 * analyzers; singing that ignores the inflections must fail the shape gate.
 *
 * This is the contract test between this module and src/exercises: if plan.ts changes
 * what it hands to analyzeInflection / analyzeRun / analyzeGlide / analyzeTransitions,
 * or an analyzer changes what it expects, it fails here.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame, TargetNote } from '../core/types';
import { CONFIG } from '../config';
import { analyzeTake } from '../exercises/analyze';
import { FOUNDATIONS_EXERCISES } from '../exercises/catalog/foundations';
import { INFLECTIONS_EXERCISES } from '../exercises/catalog/inflections';
import { RUNS_EXERCISES } from '../exercises/catalog/runs';
import { evaluate } from '../exercises/evaluate';
import { planAnalysis } from '../exercises/plan';
import { realize, type RealizedExercise } from '../exercises/transpose';
import type { ExerciseDef } from '../exercises/types';
import { analyzeInflection } from './inflections';
import { analyzeRun } from './runs';
import { makeTrack } from './fixtures';
import { sungContour } from './advanced-test-helpers';
import { trackFromAudio } from './core-test-helpers';
import { midiToHz } from '../core/music';
import { synthesize } from '../dsp/test-signals';
import type { AnalyzeContext } from './types';

/** Ideal singing of a realized exercise: finite-length moves, 6 c jitter, the level dying away on falls. */
function idealTrack(notes: readonly TargetNote[], total: number, contour = sungContour(notes, 30)): PitchFrame[] {
  return makeTrack({
    duration: total + 0.5,
    midi: contour,
    jitterCents: 6,
    seed: 11,
    rmsDb: (t) => {
      if (!Number.isFinite(contour(t))) return -80;
      for (const n of notes) {
        if (n.toMidi !== undefined && n.toMidi < n.midi && t >= n.start && t < n.end) return -20 - 30 * ((t - n.start) / (n.end - n.start));
      }
      return -20;
    },
  });
}

const real = (def: ExerciseDef): RealizedExercise => realize(def, null, 'tenor');
const ctxOf = (def: ExerciseDef): AnalyzeContext => ({ toleranceCents: CONFIG.tolerance[def.tolerance], vibratoStyle: 'pop' });

describe('the real catalog, sung ideally, through analyzeTake + evaluate', () => {
  const mine: ExerciseDef[] = [
    ...INFLECTIONS_EXERCISES,
    ...RUNS_EXERCISES,
    ...FOUNDATIONS_EXERCISES.filter((d) => d.analyzers.some((a) => a === 'glide' || a === 'cracks' || a === 'transitions')),
  ];

  for (const def of mine) {
    it(`${def.id}: plans cleanly, scores well and passes`, () => {
      const rz = real(def);
      const analysis = analyzeTake(def, rz, idealTrack(rz.notes, rz.totalSec), { vibratoStyle: 'pop' });
      expect(analysis.plan.issues).toEqual([]);
      const e = evaluate(def, analysis.metrics);
      expect(e.passed).toBe(true);
      expect(e.score).toBeGreaterThan(0.85);
    });
  }
});

describe('the real inflection exercises, per group', () => {
  for (const def of INFLECTIONS_EXERCISES) {
    const rz = real(def);
    const plan = planAnalysis(rz);
    const ctx = ctxOf(def);

    it(`${def.id}: every group scores >= 0.85 when sung as asked`, () => {
      const track = idealTrack(rz.notes, rz.totalSec);
      expect(plan.inflections.length).toBeGreaterThan(0);
      for (const g of plan.inflections) {
        const r = analyzeInflection(track, g.kind, g.targets, ctx);
        expect(r.detected, `${g.kind} @ ${g.targets[0].start}s: ${r.notes.join(' | ')}`).toBe(true);
        expect(r.score, `${g.kind} @ ${g.targets[0].start}s: ${r.notes.join(' | ')}`).toBeGreaterThan(0.85);
      }
    });

    it(`${def.id}: every group fails the 0.5 shape gate when the singer holds one plain pitch instead`, () => {
      const flat = makeTrack({
        duration: rz.totalSec + 0.5,
        midi: (t) => (t >= 0 && t < rz.totalSec && rz.notes.some((n) => t >= n.start && t < n.end) ? rz.tonicMidi : NaN),
        jitterCents: 6,
      });
      for (const g of plan.inflections) {
        const r = analyzeInflection(flat, g.kind, g.targets, ctx);
        // a flat tone cannot be a scoop, fall, slide, turn or flip (unless the group's own pitches happen to be the tonic)
        const targetsAreTonic = g.targets.every((n) => n.midi === rz.tonicMidi && (n.toMidi === undefined || n.toMidi === rz.tonicMidi));
        if (!targetsAreTonic) expect(r.score, `${g.kind} @ ${g.targets[0].start}s`).toBeLessThan(0.5);
      }
    });
  }
});

describe('the real run exercises', () => {
  for (const def of RUNS_EXERCISES) {
    it(`${def.id}: analyzeRun defines every note of an ideal take`, () => {
      const rz = real(def);
      const plan = planAnalysis(rz);
      const track = idealTrack(rz.notes, rz.totalSec);
      expect(plan.runs.length).toBeGreaterThan(0);
      for (const seq of plan.runs) {
        const r = analyzeRun(track, seq, ctxOf(def));
        expect(r.notes.map((n) => n.verdict)).toEqual(seq.map(() => 'defined'));
        expect(r.score).toBeGreaterThan(0.9);
      }
    });
  }

  it('an exercise sung with one note dropped reports it missed through the whole chain', () => {
    const def = RUNS_EXERCISES[2];
    const rz = real(def);
    const plan = planAnalysis(rz);
    const seq = plan.runs[0];
    const dropped = seq[2];
    const base = sungContour(rz.notes, 30);
    const track = makeTrack({ duration: rz.totalSec + 0.5, midi: (t) => (t >= dropped.start && t < dropped.end ? NaN : base(t)), jitterCents: 6 });
    const a = analyzeTake(def, rz, track, { vibratoStyle: 'pop' });
    expect(a.metrics['run.missedRate']).toBeGreaterThan(0);
    expect(a.metrics['run.definedRate'] as number).toBeLessThan(1);
    expect(a.details.runs[0].result.notes[2].verdict).toBe('missed');
  });
});

describe('the real sirens and legato lines', () => {
  it('foundations.sirens.1: smooth, no cracks, ends within tolerance; a cracked siren is counted', () => {
    const def = FOUNDATIONS_EXERCISES.find((d) => d.id === 'foundations.sirens.1') as ExerciseDef;
    const rz = real(def);
    const ideal = analyzeTake(def, rz, idealTrack(rz.notes, rz.totalSec), { vibratoStyle: 'pop' });
    expect(ideal.metrics['glide.cracks']).toBe(0);
    expect(ideal.metrics['glide.smoothness'] as number).toBeGreaterThan(0.9);
    expect(ideal.metrics['glide.endAbsCents'] as number).toBeLessThan(25);

    // a 300 c break in the middle of the first long glide
    const glide = rz.notes.find((n) => n.toMidi !== undefined && n.end - n.start > 2.5) as TargetNote;
    const base = sungContour(rz.notes, 30);
    const breakAt = (glide.start + glide.end) / 2;
    const cracked = makeTrack({ duration: rz.totalSec + 0.5, midi: (t) => (t >= breakAt && t < glide.end ? base(t) + 3 : base(t)), jitterCents: 6 });
    const bad = analyzeTake(def, rz, cracked, { vibratoStyle: 'pop' });
    expect(bad.metrics['glide.cracks'] as number).toBeGreaterThanOrEqual(1);
    expect(bad.details.cracks.some((c) => Math.abs(c.t - breakAt) < 0.1)).toBe(true);
    expect(evaluate(def, bad.metrics).score).toBeLessThan(evaluate(def, ideal.metrics).score);
  });

  it('foundations.five-notes.1: clean connected lines are clean, and the breath between lines is not counted as a transition', () => {
    const def = FOUNDATIONS_EXERCISES.find((d) => d.id === 'foundations.five-notes.1') as ExerciseDef;
    const rz = real(def);
    const a = analyzeTake(def, rz, idealTrack(rz.notes, rz.totalSec), { vibratoStyle: 'pop' });
    expect(a.metrics['transition.cleanRate']).toBe(1);
    expect(a.plan.transitions.length).toBeGreaterThanOrEqual(2); // one connected line per turn
  });
});

describe('inflections through the real detector (synthesized audio -> Framer -> MPM)', () => {
  const SR = 48000;
  const ctx: AnalyzeContext = { toleranceCents: 25, vibratoStyle: 'pop' };
  const audio = (midi: (t: number) => number, seconds: number): PitchFrame[] =>
    trackFromAudio(synthesize({ sampleRate: SR, duration: seconds, f0: (t) => (Number.isFinite(midi(t)) ? midiToHz(midi(t)) : NaN) }), SR);

  it('scores a scoop sung into a held note', () => {
    const g: TargetNote = { midi: 62, toMidi: 64, start: 1.0, end: 1.4167 };
    const h: TargetNote = { midi: 64, start: 1.4167, end: 3.0 };
    const r = analyzeInflection(audio(sungContour([g, h], 30), 3.2), 'scoop', [g], ctx);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.sizeCents).toBeGreaterThan(150);
    expect(r.sizeCents).toBeLessThan(250);
  });

  it('scores a slide', () => {
    const a: TargetNote = { midi: 60, start: 0.2, end: 1.0 };
    const g: TargetNote = { midi: 60, toMidi: 65, start: 1.0, end: 1.8333 };
    const b: TargetNote = { midi: 65, start: 1.8333, end: 3.0 };
    const r = analyzeInflection(audio(sungContour([a, g, b], 30), 3.2), 'slide', [g], ctx);
    expect(r.detected).toBe(true);
    expect(r.score).toBeGreaterThan(0.85);
    expect(r.landingAbsCents).toBeLessThan(20);
  });

  it('scores a flip, and tells it from a slow slide up', () => {
    const low: TargetNote = { midi: 60, start: 0.5, end: 2.3 };
    const high: TargetNote = { midi: 67, start: 2.3, end: 4.1 };
    const flip = analyzeInflection(audio(sungContour([low, high], 0), 4.3), 'flip', [low, high], ctx);
    expect(flip.detected).toBe(true);
    expect(flip.score).toBeGreaterThan(0.85);
    expect(flip.timeMs as number).toBeLessThan(120);

    const slideUp = (t: number): number => (t < 0.5 ? NaN : t < 2.1 ? 60 : t < 2.6 ? 60 + 7 * ((t - 2.1) / 0.5) : 67);
    const slow = analyzeInflection(audio(slideUp, 4.3), 'flip', [low, high], ctx);
    expect(slow.score).toBeLessThan(flip.score - 0.1);
    expect(slow.notes.some((n) => /slide, not a flip/.test(n))).toBe(true);
  });

  it('scores a fall with the level dying away', () => {
    const hold: TargetNote = { midi: 67, start: 0.5, end: 2.2 };
    const fall: TargetNote = { midi: 67, toMidi: 62, start: 2.2, end: 3.0333 };
    const midi = (t: number): number => (t < 0.5 ? NaN : t < 2.2 ? 67 : t < 3.0333 ? 67 - 5 * ((t - 2.2) / 0.8333) : NaN);
    const amp = (t: number): number => (t < 2.2 ? 0.3 : 0.3 * Math.pow(10, (-30 * Math.min(1, (t - 2.2) / 0.8333)) / 20));
    const frames = trackFromAudio(synthesize({ sampleRate: SR, duration: 3.5, f0: (t) => (Number.isFinite(midi(t)) ? midiToHz(midi(t)) : NaN), amp }), SR);
    const r = analyzeInflection(frames, 'fall', [hold, fall], ctx);
    expect(r.detected).toBe(true);
    expect(r.sizeCents).toBeGreaterThan(300);
    expect(r.score).toBeGreaterThan(0.7);
  });
});
