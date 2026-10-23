/**
 * What the Sing screen's gauge measures against during a take (review R1): the note being asked for, never the nearest
 * one; nothing while the app plays a note, in the count-in, a rest, a slide, or the Range finder.
 */
import { describe, expect, it } from 'vitest';
import { getExercise, getLevel } from '../../exercises';
import { CUE } from '../../exercises/cues';
import { planGauge } from './gauge-target';
import { exercise, note, prepare, rest, slide } from './live-hint-fixtures';

describe('planGauge', () => {
  /** The app plays the note for two seconds, a one-second rest, then the singer holds it for three. */
  const ECHO = prepare(exercise([note(0, 2, { cue: CUE.listen }), rest(1), note(0, 3, { cue: CUE.sing }), rest(1), note(2, 2)]));

  it('reads a held sung note against that note, and says "listen" while the app plays it', () => {
    const plan = planGauge(ECHO.def, ECHO.realized);
    const [listen, , sung, , second] = ECHO.realized.steps;
    expect(plan.at(listen.start + 0.5)).toBe('listen');
    expect(plan.at(sung.start + 1)).toBe(sung.midi);
    expect(plan.at(second.start + 1)).toBe(second.midi);
    expect(second.midi).not.toBe(sung.midi);
  });

  it('asks for nothing in the count-in, a rest, after the end, or at a time that is not a number', () => {
    const plan = planGauge(ECHO.def, ECHO.realized);
    const steps = ECHO.realized.steps;
    expect(plan.at(-0.5)).toBeNull();
    expect(plan.at(steps[1].start + 0.5)).toBeNull(); // the rest
    expect(plan.at(steps[steps.length - 1].end + 1)).toBeNull();
    expect(plan.at(Number.NaN)).toBeNull();
  });

  it('follows the clock both ways: a later time, then an earlier one, reads the right step (a new take restarts it)', () => {
    const plan = planGauge(ECHO.def, ECHO.realized);
    const [, , sung, , second] = ECHO.realized.steps;
    expect(plan.at(second.start + 0.5)).toBe(second.midi);
    expect(plan.at(sung.start + 0.5)).toBe(sung.midi);
    expect(plan.at(second.start + 0.5)).toBe(second.midi);
  });

  it('measures no slide: its line is a shape, not one pitch; the held ends around it are notes', () => {
    const run = prepare(exercise([note(0, 1), slide(0, 2, 2), note(2, 1)], { kind: 'siren', analyzers: ['glide', 'cracks'] }));
    const plan = planGauge(run.def, run.realized);
    const [from, glide, to] = run.realized.steps;
    expect(plan.at(from.start + 0.5)).toBe(from.midi);
    expect(plan.at(glide.start + 1)).toBeNull();
    expect(plan.at(to.start + 0.5)).toBe(to.midi);
  });

  it('never measures the Range finder (the singer goes where the voice goes), but still says "listen" when the app plays', () => {
    const def = getExercise(getLevel('foundations.01')!.exerciseId)!;
    const finder = prepare(def);
    const plan = planGauge(def, finder.realized);
    for (const s of finder.realized.steps) {
      const mid = (s.start + s.end) / 2;
      expect(plan.at(mid), `${s.role} at ${mid}`).toBe(s.role === 'listen' ? 'listen' : null);
    }
  });

  it('reads every Foundations check the same way: a number only on a held sung note, "listen" on every tone the app plays', () => {
    for (const levelId of ['foundations.02', 'foundations.03', 'foundations.13', 'foundations.12']) {
      const def = getExercise(getLevel(levelId)!.exerciseId)!;
      const { realized } = prepare(def);
      const plan = planGauge(def, realized);
      for (const tone of realized.reference) expect(plan.at((tone.start + tone.end) / 2), `${levelId} tone`).toBe('listen');
      for (const s of realized.steps) {
        const got = plan.at((s.start + s.end) / 2);
        if (typeof got === 'number') expect(s.role === 'sing' && s.toMidi === undefined && got === s.midi, `${levelId} ${s.role}`).toBe(true);
      }
    }
  });
});
