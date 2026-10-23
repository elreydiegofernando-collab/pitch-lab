import { describe, expect, it } from 'vitest';
import { CHECKUP_TASKS } from '../../checkup/types';
import { jargonIn } from '../../coaching/plain';
import { getExercise, getLevel, getWorld } from '../../exercises';
import type { PreparedRun, RunTarget } from '../../runtime/types';
import { bossChain, contextChip, levelNumber, percent, singTitle, tempoLabel, toleranceLabel } from './copy';
import { makePrepared } from './test-fakes';

const def = (levelId: string) => getExercise(getLevel(levelId)!.exerciseId)!;
const LEVEL: RunTarget = { kind: 'level', levelId: 'foundations.03' };

describe('levelNumber', () => {
  it('counts a level by its place in its world, zero padded', () => {
    const world = getWorld('foundations');
    expect(levelNumber(world, getLevel('foundations.01')!)).toBe('01');
    expect(levelNumber(world, getLevel('foundations.04')!)).toBe('04');
    expect(levelNumber(world, getLevel('foundations.09')!)).toBe('09');
  });

  it('still answers for a level whose world is unknown', () => {
    expect(levelNumber(undefined, getLevel('foundations.04')!)).toBe('01');
  });
});

describe('tolerance and tempo chips', () => {
  it('gives the in-tune band of the level', () => {
    expect(toleranceLabel(def('foundations.03'))).toBe('±50¢');
    expect(toleranceLabel({ tolerance: 'default' })).toBe('±25¢');
    expect(toleranceLabel({ tolerance: 'studio' })).toBe('±10¢');
  });

  it('says where a Runs ladder is headed', () => {
    const d = def('runs.03');
    const rungs = d.tempoLadder!;
    expect(tempoLabel(d)).toBe(`Tempo climbs ${rungs[0]} → ${rungs[rungs.length - 1]} bpm as you pass`);
  });

  it('gives the tempo of a metronome exercise, and none for a held note', () => {
    expect(tempoLabel(def('foundations.06'))).toBe('84 bpm');
    expect(tempoLabel(def('foundations.03'))).toBeNull();
    expect(tempoLabel({ tempoBpm: 72, tempoLadder: [72], metronome: true })).toBe('72 bpm');
  });
});

describe('bossChain', () => {
  it('lists the cue that opens each section of the take, in order', () => {
    expect(bossChain(def('foundations.boss'))).toEqual(['Hold it steady and straight', 'Attack the octave dead centre', 'Legato down the scale']);
  });

  it('skips the Listen and Sing labels, and repeats', () => {
    const chain = bossChain({
      pattern: [{ beats: 1, cue: 'Listen' }, { beats: 1, cue: 'Sing' }, { beats: 1, cue: 'Up' }, { beats: 1, cue: 'Up' }, { beats: 1 }, { beats: 1, cue: 'Down' }],
    });
    expect(chain).toEqual(['Up', 'Down']);
  });
});

describe('contextChip', () => {
  const base = makePrepared('foundations.03');

  it('is empty for a plain level', () => {
    expect(contextChip(base, LEVEL)).toBeNull();
  });

  it('names the rung of a tempo ladder', () => {
    const p = makePrepared('runs.03');
    expect(p.ladder).not.toBeNull();
    expect(contextChip(p, { kind: 'level', levelId: 'runs.03' })).toBe(`${p.bpm} bpm · rung ${p.ladder!.index + 1} of ${p.ladder!.rungs.length}`);
  });

  it('counts audition tests and workout items from 1, from the runner’s 0-based indexes', () => {
    const audition: PreparedRun = { ...base, audition: { index: 0, count: 4, unlocksFirst: 'a', unlocksLast: 'b' } };
    expect(contextChip(audition, { kind: 'audition', worldId: 'foundations' })).toBe('Test 1 of 4');
    const workout: PreparedRun = { ...base, workout: { item: { stage: 'review' } as never, itemIndex: 5, itemCount: 6, take: 1 } };
    expect(contextChip(workout, { kind: 'workout', itemIndex: 5 })).toBe('Workout · 6 of 6');
    expect(contextChip({ ...workout, workout: { ...workout.workout!, take: 2 } }, { kind: 'workout', itemIndex: 5 })).toBe('Workout · 6 of 6 · take 2');
  });

  it('puts one chip up: a workout item wins over an audition, a ladder over a record', () => {
    const both: PreparedRun = {
      ...makePrepared('runs.03'),
      workout: { item: { stage: 'review' } as never, itemIndex: 0, itemCount: 3, take: 1 },
      audition: { index: 1, count: 2, unlocksFirst: 'a', unlocksLast: 'b' },
    };
    expect(contextChip(both, LEVEL)).toBe('Workout · 1 of 3');
    expect(contextChip({ ...both, workout: null }, LEVEL)).toBe('Test 2 of 2');
    expect(contextChip({ ...both, workout: null, audition: null }, { kind: 'record', levelId: 'runs.03' })).toMatch(/rung/);
  });

  it('marks a record attempt on a level without a ladder', () => {
    expect(contextChip(base, { kind: 'record', levelId: 'foundations.03' })).toBe('Record attempt');
  });
});

describe('contextChip: the voice check-up', () => {
  const base = makePrepared('foundations.03');
  const task = (taskIndex: number): PreparedRun => ({ ...base, level: null, checkup: { taskIndex, taskCount: CHECKUP_TASKS.length, checkupId: 'run-1' } });
  const target = (taskIndex: number): RunTarget => ({ kind: 'checkup', taskIndex });

  it('says which task of the check-up this is, counting from 1 from the runner’s 0-based index', () => {
    expect(contextChip(task(0), target(0))).toBe('Check-up · 1 of 5');
    expect(contextChip(task(1), target(1))).toBe('Check-up · 2 of 5');
    expect(contextChip(task(4), target(4))).toBe('Check-up · 5 of 5');
  });

  it('counts out of the task count the runner prepared', () => {
    const prepared: PreparedRun = { ...base, checkup: { taskIndex: 2, taskCount: 7, checkupId: 'run-1' } };
    expect(contextChip(prepared, target(2))).toBe('Check-up · 3 of 7');
  });

  it('still says it from the route\'s target when the run carries no check-up details', () => {
    expect(contextChip(base, target(2))).toBe('Check-up · 3 of 5');
    expect(contextChip({ ...base, checkup: null }, target(3))).toBe('Check-up · 4 of 5');
  });

  it('wins over the audition test it is sung as, and over a ladder, a workout and a record', () => {
    const crowded: PreparedRun = {
      ...makePrepared('runs.03'),
      checkup: { taskIndex: 1, taskCount: 5, checkupId: 'run-1' },
      audition: { index: 1, count: 4, unlocksFirst: 'a', unlocksLast: 'b' },
      workout: { item: { stage: 'review' } as never, itemIndex: 0, itemCount: 3, take: 1 },
    };
    expect(contextChip(crowded, target(1))).toBe('Check-up · 2 of 5');
    expect(contextChip(crowded, { kind: 'record', levelId: 'runs.03' })).toBe('Check-up · 2 of 5');
  });

  it('is plain: no jargon and no exclamation mark', () => {
    for (let i = 0; i < CHECKUP_TASKS.length; i++) expect(jargonIn(contextChip(task(i), target(i)) ?? '')).toEqual([]);
  });

  it('leaves every other chip as it was', () => {
    expect(contextChip({ ...base, checkup: null }, LEVEL)).toBeNull();
    expect(contextChip({ ...base, checkup: undefined }, { kind: 'record', levelId: 'foundations.03' })).toBe('Record attempt');
  });
});

describe('singTitle: the voice check-up', () => {
  const base = makePrepared('foundations.03');

  it('titles a task of the check-up by its plain title, not the audition exercise or level it is sung as', () => {
    CHECKUP_TASKS.forEach((t, taskIndex) => {
      expect(singTitle({ ...base, level: null, checkup: { taskIndex, taskCount: 5, checkupId: 'run-1' } })).toBe(t.title);
    });
    expect(singTitle({ ...base, checkup: { taskIndex: 2, taskCount: 5, checkupId: 'run-1' } })).toBe('Slide up and down');
  });

  it('falls back to the level or exercise when the task is not one the battery knows', () => {
    expect(singTitle({ ...base, checkup: { taskIndex: 9, taskCount: 5, checkupId: 'run-1' } })).toBe('Sustain I');
  });
});

describe('titles and percentages', () => {
  it('titles the Sing screen with the level, or the exercise for an audition test', () => {
    const prepared = makePrepared('foundations.03');
    expect(singTitle(prepared)).toBe('Sustain I');
    expect(singTitle({ ...prepared, level: null })).toBe(prepared.def.title);
  });

  it('names a Boss Recital in full, as Level, Home and the report do (every boss level is titled just "Boss Recital")', () => {
    const boss = makePrepared('foundations.boss');
    expect(boss.level?.title).toBe('Boss Recital');
    expect(singTitle(boss)).toBe(boss.def.title);
    expect(singTitle(boss)).toMatch(/^Foundations Boss Recital/);
  });

  it('rounds a score to a whole percent and keeps it in range', () => {
    expect(percent(0.864)).toBe('86%');
    expect(percent(0.865)).toBe('87%');
    expect(percent(1.4)).toBe('100%');
    expect(percent(-0.2)).toBe('0%');
  });
});
