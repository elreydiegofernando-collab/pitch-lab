import { describe, expect, it } from 'vitest';
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

describe('titles and percentages', () => {
  it('titles the Sing screen with the level, or the exercise for an audition test', () => {
    const prepared = makePrepared('foundations.03');
    expect(singTitle(prepared)).toBe('Sustain I');
    expect(singTitle({ ...prepared, level: null })).toBe(prepared.def.title);
  });

  it('rounds a score to a whole percent and keeps it in range', () => {
    expect(percent(0.864)).toBe('86%');
    expect(percent(0.865)).toBe('87%');
    expect(percent(1.4)).toBe('100%');
    expect(percent(-0.2)).toBe('0%');
  });
});
