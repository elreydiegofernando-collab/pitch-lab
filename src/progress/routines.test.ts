import { describe, expect, it } from 'vitest';
import { CUE } from '../exercises/cues';
import { rangeFromMeasurement, realize } from '../exercises/transpose';
import { COOL_DOWN_ROUTINE, COOL_DOWN_ROUTINE_ID, ROUTINE_EXERCISES, WARM_UP_ROUTINE, WARM_UP_ROUTINE_ID, isRoutineExerciseId, withRoutines } from './routines';
import { exerciseDef } from './test-fixtures';
import { estimateTakeSeconds } from './workout';

const ROUTINES = [WARM_UP_ROUTINE, COOL_DOWN_ROUTINE];

describe('built-in routines', () => {
  it('are registered under their ids and recognised as routines', () => {
    expect(WARM_UP_ROUTINE.id).toBe(WARM_UP_ROUTINE_ID);
    expect(COOL_DOWN_ROUTINE.id).toBe(COOL_DOWN_ROUTINE_ID);
    expect(Object.keys(ROUTINE_EXERCISES).sort()).toEqual([COOL_DOWN_ROUTINE_ID, WARM_UP_ROUTINE_ID].sort());
    expect(isRoutineExerciseId(WARM_UP_ROUTINE_ID)).toBe(true);
    expect(isRoutineExerciseId(COOL_DOWN_ROUTINE_ID)).toBe(true);
    expect(isRoutineExerciseId('foundations.siren.1')).toBe(false);
    expect(isRoutineExerciseId('toString')).toBe(false);
    expect(isRoutineExerciseId('')).toBe(false);
  });

  it('are well-formed exercise definitions', () => {
    for (const def of ROUTINES) {
      expect(def.title.length).toBeGreaterThan(3);
      expect(def.goal.length).toBeGreaterThan(10);
      expect(def.pattern.length).toBeGreaterThan(0);
      expect(def.tempoBpm).toBeGreaterThan(0);
      expect(def.countInBeats).toBeGreaterThanOrEqual(0);
      expect(def.tiers.solid).toBeLessThan(def.tiers.studio);
      expect(def.tiers.studio).toBeLessThanOrEqual(1);
      expect(def.scoring.length).toBeGreaterThan(0);
      for (const t of def.scoring) expect(t.weight).toBeGreaterThan(0);
      for (const step of def.pattern) expect(step.beats).toBeGreaterThan(0);
    }
  });

  it('are completion-based: nothing gated, nothing that can fail a take', () => {
    for (const def of ROUTINES) {
      expect(def.pass.score).toBe(0);
      expect(def.pass.gates ?? []).toEqual([]);
      expect(def.tolerance).toBe('easy');
    }
  });

  it('are gentle: short slides, a sensible length, only glide analysis, no vibrato', () => {
    for (const def of ROUTINES) {
      const offsets = def.pattern.flatMap((s) => [s.semis, s.glideToSemis].filter((x): x is number => x !== undefined));
      expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThanOrEqual(14);
      const sec = estimateTakeSeconds(def);
      expect(sec).toBeGreaterThan(10);
      expect(sec).toBeLessThan(60);
      expect(def.analyzers.every((a) => a === 'glide' || a === 'cracks')).toBe(true);
      expect(def.demo.vibrato ?? null).toBeNull();
      expect(def.metronome).toBe(false);
    }
    // The warm-up rises, the cool-down only falls.
    expect(WARM_UP_ROUTINE.pattern.some((s) => s.glideToSemis !== undefined && s.glideToSemis > (s.semis ?? 0))).toBe(true);
    for (const s of COOL_DOWN_ROUTINE.pattern) if (s.glideToSemis !== undefined) expect(s.glideToSemis).toBeLessThan(s.semis ?? 0);
  });

  it('use no cue text that the realizer reads as meaning something (Listen, Straight, Scoop in, ...)', () => {
    const reserved = new Set(Object.values(CUE).map((c) => c.toLowerCase()));
    for (const def of ROUTINES) for (const s of def.pattern) if (s.cue !== undefined) expect(reserved.has(s.cue.toLowerCase())).toBe(false);
  });
});

describe('routines in the exercise realizer', () => {
  const ranges = [
    { name: 'no saved range (voice default)', range: null, voice: 'unknown' as const },
    { name: 'tenor C3-C5', range: rangeFromMeasurement(48, 72, 'x'), voice: 'tenor' as const },
    { name: 'baritone A2-F4', range: rangeFromMeasurement(45, 65, 'x'), voice: 'baritone' as const },
    { name: 'a narrow beginner range', range: rangeFromMeasurement(52, 62, 'x'), voice: 'other' as const },
  ];

  for (const { name, range, voice } of ranges) {
    it(`place every note inside the range, with real glides: ${name}`, () => {
      for (const def of ROUTINES) {
        const r = realize(def, range, voice);
        expect(r.notes.length).toBeGreaterThan(0);
        for (const n of r.notes) {
          expect(n.midi).toBeGreaterThanOrEqual(r.range.low);
          expect(n.midi).toBeLessThanOrEqual(r.range.high);
          if (n.toMidi !== undefined) {
            expect(n.toMidi).toBeGreaterThanOrEqual(r.range.low);
            expect(n.toMidi).toBeLessThanOrEqual(r.range.high);
          }
        }
        expect(r.notes.some((n) => n.toMidi !== undefined)).toBe(true);
        expect(r.totalSec).toBeGreaterThan(10);
      }
    });
  }

  it('keep to the realized range without folding whenever the range is a normal width', () => {
    for (const { range, voice } of ranges.slice(0, 3)) for (const def of ROUTINES) expect(realize(def, range, voice).fit).not.toBe('folded');
  });

  it('start the warm-up low in the range, never above the middle', () => {
    const r = realize(WARM_UP_ROUTINE, rangeFromMeasurement(48, 72, 'x'), 'tenor');
    expect(r.notes[0].midi).toBeLessThanOrEqual((r.range.low + r.range.high) / 2);
  });
});

describe('withRoutines', () => {
  const catalogDef = exerciseDef('foundations.sustain.1');
  const lookup = (id: string) => (id === catalogDef.id ? catalogDef : undefined);

  it('resolves the catalog first, then the built-in routines, then nothing', () => {
    const find = withRoutines(lookup);
    expect(find(catalogDef.id)).toBe(catalogDef);
    expect(find(WARM_UP_ROUTINE_ID)).toBe(WARM_UP_ROUTINE);
    expect(find(COOL_DOWN_ROUTINE_ID)).toBe(COOL_DOWN_ROUTINE);
    expect(find('nope')).toBeUndefined();
    expect(find('toString')).toBeUndefined();
  });

  it('lets a catalog entry with a routine id replace the default, and works with no catalog at all', () => {
    const override = exerciseDef(WARM_UP_ROUTINE_ID, { title: 'Catalog warm-up' });
    expect(withRoutines((id) => (id === WARM_UP_ROUTINE_ID ? override : undefined))(WARM_UP_ROUTINE_ID)).toBe(override);
    expect(withRoutines()(COOL_DOWN_ROUTINE_ID)).toBe(COOL_DOWN_ROUTINE);
  });
});
