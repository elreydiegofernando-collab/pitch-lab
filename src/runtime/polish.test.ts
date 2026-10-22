/**
 * The polish line a clean take ends on: it promises only what the report around it offers (J7). Over the real catalog.
 */
import { describe, expect, it } from 'vitest';
import { POLISH_TIP, getExercise, getLevel } from '../exercises';
import type { WorkoutItem } from '../progress';
import { COOL_DOWN_ROUTINE, WARM_UP_ROUTINE } from '../progress/routines';
import { polishLine } from './polish';
import type { PreparedRun } from './types';

type Prep = Pick<PreparedRun, 'target' | 'level' | 'def' | 'bpm' | 'workout'>;

const runs = getExercise('runs.run.1')!;
const [rung0, rung1] = runs.tempoLadder!;
const passBpm = runs.tempoBpm;
const sustain = getExercise(getLevel('foundations.03')!.exerciseId)!;

const levelTake = (levelId: string, bpm: number): Prep => {
  const level = getLevel(levelId)!;
  return { target: { kind: 'level', levelId }, level, def: getExercise(level.exerciseId)!, bpm, workout: null };
};

function item(takes: number): WorkoutItem {
  return { stage: 'world-item', source: 'level', levelId: 'foundations.03', exerciseId: sustain.id, worldId: 'foundations', title: 'Sustain I', reason: 'current-level', takes, estSeconds: 60, estMinutes: 1 };
}

describe('polishLine', () => {
  it('a clean lower rung of a tempo ladder names the next rung and where the level counts, not a tally', () => {
    expect(rung1).toBeLessThanOrEqual(passBpm);
    const line = polishLine(levelTake('runs.01', rung0), { passed: false, mastery: 0 }, rung1);
    expect(line).not.toContain('tally');
    expect(line).not.toContain('move on');
    if (rung1 === passBpm) expect(line).toBe(`Clean at ${rung0} bpm. The next take is at ${rung1} bpm, where the level counts.`);
    else expect(line).toBe(`Clean at ${rung0} bpm. The next take is at ${rung1} bpm, a step closer to ${passBpm} bpm, where the level counts.`);
    // The rung below the pass tempo: the next take is where the level counts.
    const ladder = runs.tempoLadder!;
    const below = ladder[ladder.length - 2];
    expect(polishLine(levelTake('runs.01', below), { passed: false, mastery: 0 }, passBpm)).toBe(
      `Clean at ${below} bpm. The next take is at ${passBpm} bpm, where the level counts.`,
    );
    // No climb reported: still no tally, just the tempo that counts.
    expect(polishLine(levelTake('runs.01', rung0), { passed: false, mastery: 0 }, rung0)).toBe(`Clean at ${rung0} bpm. The level counts at ${passBpm} bpm.`);
  });

  it('a passed audition test opens levels: no tally, no replay', () => {
    const def = getExercise('foundations.audition.1')!;
    const prep: Prep = { target: { kind: 'audition', worldId: 'foundations' }, level: null, def, bpm: def.tempoBpm, workout: null };
    expect(polishLine(prep, { passed: true, mastery: 3 }, null)).toBe('Test passed: the levels it covers are open.');
  });

  it('a warm-up or cool-down is completion: a plain line that names it', () => {
    for (const def of [WARM_UP_ROUTINE, COOL_DOWN_ROUTINE]) {
      const prep: Prep = { target: { kind: 'workout', itemIndex: 0 }, level: null, def, bpm: def.tempoBpm, workout: null };
      const line = polishLine(prep, { passed: true, mastery: 3 }, null);
      expect(line).toBe(`${def.title} done. Easy, unforced sound is all it asks.`);
      expect(line).not.toContain('tally');
    }
  });

  it('a take that lit every tally has none left to light', () => {
    expect(polishLine(levelTake('foundations.03', sustain.tempoBpm), { passed: true, mastery: 3 }, null)).toBe(
      'Clean take. Every tally is lit: move on when you’re ready.',
    );
    // At the pass tempo of a ladder, the same.
    expect(polishLine(levelTake('runs.01', passBpm), { passed: true, mastery: 3 }, passBpm)).toBe('Clean take. Every tally is lit: move on when you’re ready.');
  });

  it('a take with a tally still to light keeps the replay line, except as the last take of a workout item', () => {
    expect(polishLine(levelTake('foundations.03', sustain.tempoBpm), { passed: true, mastery: 2 }, null)).toBe(POLISH_TIP.text);
    const level = getLevel('foundations.03')!;
    const inWorkout = (take: number, takes: number): Prep => ({
      target: { kind: 'workout', itemIndex: 1 },
      level,
      def: sustain,
      bpm: sustain.tempoBpm,
      workout: { item: item(takes), itemIndex: 1, itemCount: 4, take },
    });
    expect(polishLine(inWorkout(1, 2), { passed: true, mastery: 2 }, null)).toBe(POLISH_TIP.text);
    expect(polishLine(inWorkout(2, 2), { passed: true, mastery: 2 }, null)).toBe('Clean take. Move on when you’re ready.');
  });
});
