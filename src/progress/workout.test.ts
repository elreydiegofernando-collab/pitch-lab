import { describe, expect, it } from 'vitest';
import { computeSnapshot } from './engine';
import { COOL_DOWN_ROUTINE_ID, ROUTINE_EXERCISES, WARM_UP_ROUTINE_ID } from './routines';
import { P1, P2, attempt, deepFreeze, exerciseDef, fail, fixtureWorlds, levelIds, pass, passThrough, seeded } from './test-fixtures';
import { isExerciseOpenable, isLevelOpenable, requirementHint } from './unlocks';
import type { WeaknessScore } from './weakness';
import { WORKOUT_KNOBS, buildDailyWorkout, estimateTakeSeconds } from './workout';
import type { Workout, WorkoutInput, WorkoutMinutes } from './workout';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const worlds = fixtureWorlds();
const BUDGETS: WorkoutMinutes[] = [5, 10, 20];
const ALL_LEVELS = worlds.flatMap(levelIds);
const BOSSES = new Set(worlds.flatMap((w) => w.levels.filter((l) => l.kind === 'boss').map((l) => l.id)));

const STAGES = {
  early: () => passThrough(worlds, 'foundations.01'),
  mid: () => passThrough(worlds, 'foundations.04'),
  deep: () => passThrough(worlds, 'foundations.09'),
  vibrato: () => passThrough(worlds, 'vibrato.02'),
  all: () => passThrough(worlds, 'inflections.boss'),
};

function plan(attempts: ReturnType<typeof attempt>[], minutes: WorkoutMinutes, extra: Partial<WorkoutInput> = {}) {
  const snapshot = computeSnapshot(P1, worlds, attempts, NOW);
  const workout = buildDailyWorkout({ minutes, snapshot, worlds, attempts, now: NOW, ...extra });
  return { snapshot, workout };
}

/** A ranking with the given levels weakest first. */
function ranking(ids: string[]): WeaknessScore[] {
  return ids.map((levelId, i) => ({ levelId, worldId: 'foundations', mastery: 1, score: 1 - i * 0.01, performance: 0, misses: 0, staleness: 0, dueInDays: null, reasons: [] }));
}

const stages = (w: Workout) => w.items.map((i) => i.stage);
const levelItems = (w: Workout) => w.items.filter((i) => i.source === 'level');

function expectWellFormed(snapshot: ReturnType<typeof computeSnapshot>, w: Workout) {
  const order = { 'warm-up': 0, 'world-item': 1, review: 2, 'cool-down': 3 } as const;
  for (let i = 1; i < w.items.length; i++) expect(order[w.items[i].stage]).toBeGreaterThanOrEqual(order[w.items[i - 1].stage]);
  expect(w.items.filter((i) => i.stage === 'warm-up').length).toBeLessThanOrEqual(1);
  expect(w.items.filter((i) => i.stage === 'cool-down').length).toBeLessThanOrEqual(1);
  expect(w.items.filter((i) => i.stage === 'review').length).toBeLessThanOrEqual(1);
  expect(w.items.filter((i) => i.stage === 'world-item').length).toBeLessThanOrEqual(WORKOUT_KNOBS.maxWorldItems);
  expect(w.totalEstSeconds).toBe(w.items.reduce((s, i) => s + i.estSeconds, 0));
  expect(w.totalEstSeconds).toBeLessThanOrEqual(w.minutes * 60);
  expect(w.totalEstMinutes).toBeCloseTo(w.totalEstSeconds / 60, 9);
  const seen = new Set<string>();
  for (const it of w.items) {
    expect(it.takes).toBeGreaterThanOrEqual(1);
    expect(it.estMinutes).toBeCloseTo(it.estSeconds / 60, 9);
    expect(seen.has(it.exerciseId)).toBe(false); // nothing appears twice
    seen.add(it.exerciseId);
    if (it.source === 'level') {
      expect(it.levelId).not.toBeNull();
      expect(isLevelOpenable(it.levelId as string, snapshot)).toBe(true);
      expect(BOSSES.has(it.levelId as string)).toBe(false);
    }
    expect(isExerciseOpenable(it.exerciseId, snapshot, worlds)).toBe(true);
  }
}

describe('buildDailyWorkout: gating', () => {
  it('is locked, with the requirement, until the first level is passed', () => {
    for (const minutes of BUDGETS) {
      const { workout } = plan([], minutes);
      expect(workout).toEqual({ minutes, locked: true, hint: requirementHint('daily-workout'), items: [], totalEstSeconds: 0, totalEstMinutes: 0 });
    }
    expect(plan([pass('foundations.02')], 10).workout.locked).toBe(true); // a stray later pass opens nothing
  });

  it('opens after the first level, with no hint', () => {
    const { workout } = plan(STAGES.early(), 10);
    expect(workout.locked).toBe(false);
    expect(workout.hint).toBeNull();
    expect(workout.items.length).toBeGreaterThan(0);
  });

  it('only ever contains unlocked content, at every stage and budget', () => {
    for (const make of Object.values(STAGES)) {
      for (const minutes of BUDGETS) {
        const attempts = make();
        const { snapshot, workout } = plan(attempts, minutes);
        expectWellFormed(snapshot, workout);
      }
    }
  });

  it('never includes a locked level, a boss recital, or a level from a world that is not open yet', () => {
    const { snapshot, workout } = plan(STAGES.deep(), 20);
    const ids = levelItems(workout).map((i) => i.levelId as string);
    for (const id of ALL_LEVELS) if (!isLevelOpenable(id, snapshot)) expect(ids).not.toContain(id);
    expect(ids.some((id) => id.startsWith('vibrato.'))).toBe(false);
    expect(ids).not.toContain('foundations.boss'); // the boss is the current level here, but a recital is not a drill
  });
});

describe('buildDailyWorkout: shape', () => {
  it('runs warm-up, then world items, then one review, then cool-down', () => {
    const { workout } = plan(STAGES.mid(), 20);
    const seq = stages(workout);
    expect(seq[0]).toBe('warm-up');
    expect(seq[seq.length - 1]).toBe('cool-down');
    expect(seq.filter((s) => s === 'world-item')).toHaveLength(3);
    expect(seq.filter((s) => s === 'review')).toHaveLength(1);
  });

  it('warm-up and cool-down are the built-in routines: no level, no world', () => {
    const { workout } = plan(STAGES.mid(), 10);
    const [warm, ...rest] = workout.items;
    const cool = rest[rest.length - 1];
    expect(warm).toMatchObject({ stage: 'warm-up', source: 'routine', levelId: null, worldId: null, exerciseId: WARM_UP_ROUTINE_ID, reason: 'warm-up' });
    expect(cool).toMatchObject({ stage: 'cool-down', source: 'routine', levelId: null, worldId: null, exerciseId: COOL_DOWN_ROUTINE_ID, reason: 'cool-down' });
    expect(warm.title).toBe(ROUTINE_EXERCISES[WARM_UP_ROUTINE_ID].title);
  });

  it('puts the level in progress first, then the weakest passed levels of the same world', () => {
    const { workout } = plan(STAGES.mid(), 20);
    const world = workout.items.filter((i) => i.stage === 'world-item');
    expect(world[0]).toMatchObject({ levelId: 'foundations.05', reason: 'current-level' });
    for (const it of world.slice(1)) {
      expect(it.reason).toBe('consolidate');
      expect(it.worldId).toBe('foundations');
    }
  });

  it('works in the world the singer is in, with the review free to come from anywhere unlocked', () => {
    const { workout } = plan(STAGES.vibrato(), 20, { weakness: ranking(['foundations.04', 'vibrato.02', 'vibrato.01', 'foundations.01']) });
    const world = workout.items.filter((i) => i.stage === 'world-item').map((i) => i.levelId);
    expect(world).toEqual(['vibrato.03', 'vibrato.02', 'vibrato.01']);
    expect(workout.items.find((i) => i.stage === 'review')?.levelId).toBe('foundations.04');
  });

  it('keeps going when everything is passed: world items from the last world, review from the weakest overall', () => {
    const { snapshot, workout } = plan(STAGES.all(), 20, { weakness: ranking(['foundations.03', 'inflections.01']) });
    expectWellFormed(snapshot, workout);
    expect(workout.items.filter((i) => i.stage === 'world-item').map((i) => i.worldId)).toEqual(['inflections', 'inflections']);
    expect(workout.items.find((i) => i.stage === 'review')?.levelId).toBe('foundations.03');
  });

  it('review is the weakest passed level not already used, never a boss, at most one', () => {
    const { workout } = plan(STAGES.deep(), 20, { weakness: ranking(['foundations.05', 'foundations.03', 'foundations.boss', 'foundations.02', 'foundations.07', 'foundations.01']) });
    expect(workout.items.filter((i) => i.stage === 'world-item').map((i) => i.levelId)).toEqual(['foundations.05', 'foundations.03', 'foundations.02']);
    const review = workout.items.filter((i) => i.stage === 'review');
    expect(review.map((i) => i.levelId)).toEqual(['foundations.07']);
    expect(review[0].reason).toBe('weakest');
  });

  it('follows the real history: the level the singer keeps failing is the one that gets worked on first', () => {
    const firstWorldItem = (attempts: ReturnType<typeof attempt>[]) => plan(attempts, 20).workout.items.find((i) => i.stage === 'world-item')?.levelId;
    expect(firstWorldItem(STAGES.deep())).toBe('foundations.01'); // all equally stale and equally good: lowest id first
    expect(firstWorldItem([...STAGES.deep(), fail('foundations.07'), fail('foundations.07'), fail('foundations.07')])).toBe('foundations.07');
  });

  it('leaves the range finder and other non-drill kinds out when the catalog lookup says what they are', () => {
    const getExercise = (id: string) => (id === 'foundations.01.ex' ? exerciseDef(id, { kind: 'range-finder' }) : undefined);
    for (const minutes of BUDGETS) {
      const { workout } = plan(STAGES.early(), minutes, { getExercise });
      expect(levelItems(workout).map((i) => i.levelId)).toEqual(['foundations.02']);
    }
    const noAudition = (id: string) => (id.startsWith('foundations.0') ? exerciseDef(id, { kind: 'audition' }) : undefined);
    expect(levelItems(plan(STAGES.deep(), 10, { getExercise: noAudition }).workout)).toEqual([]);
  });

  it('ignores other profiles when weighing the history', () => {
    const mine = STAGES.deep();
    const noise = [fail('foundations.04', { profileId: P2 }), fail('foundations.04', { profileId: P2 })];
    expect(plan([...mine, ...noise], 10).workout).toEqual(plan(mine, 10).workout);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const attempts = STAGES.mid();
    const snapshot = computeSnapshot(P1, worlds, attempts, NOW);
    const input: WorkoutInput = { minutes: 10, snapshot, worlds, attempts, now: NOW };
    const a = buildDailyWorkout(input);
    expect(buildDailyWorkout(input)).toEqual(a);
    expect(() => buildDailyWorkout(deepFreeze({ ...input, snapshot: structuredClone(snapshot), worlds: fixtureWorlds(), attempts: structuredClone(attempts) }))).not.toThrow();
  });
});

describe('buildDailyWorkout: the time budget', () => {
  it('never exceeds 5, 10 or 20 minutes, and uses most of what it is given', () => {
    for (const minutes of BUDGETS) {
      const { workout } = plan(STAGES.deep(), minutes);
      expect(workout.totalEstSeconds).toBeLessThanOrEqual(minutes * 60);
      expect(workout.totalEstSeconds).toBeGreaterThanOrEqual(minutes * 60 * 0.8);
    }
  });

  it('gives longer workouts more takes, not just more items', () => {
    const takes = (m: WorkoutMinutes) => plan(STAGES.deep(), m).workout.items.reduce((s, i) => s + i.takes, 0);
    expect(takes(10)).toBeGreaterThan(takes(5));
    expect(takes(20)).toBeGreaterThan(takes(10));
    for (const it of plan(STAGES.deep(), 20).workout.items) {
      const cap = it.stage === 'warm-up' ? WORKOUT_KNOBS.maxTakes.warmUp : it.stage === 'cool-down' ? WORKOUT_KNOBS.maxTakes.coolDown : it.stage === 'review' ? WORKOUT_KNOBS.maxTakes.review : WORKOUT_KNOBS.maxTakes.worldItem;
      expect(it.takes).toBeLessThanOrEqual(cap);
    }
  });

  it('uses the real take lengths from the catalog lookup', () => {
    const slow = (id: string) => exerciseDef(id, { tempoBpm: 30, pattern: [{ semis: 0, beats: 28 }], countInBeats: 2 }); // 60 s per take
    const fast = (id: string) => exerciseDef(id, { tempoBpm: 120, pattern: [{ semis: 0, beats: 4 }], countInBeats: 2 }); // 3 s per take
    const slowPlan = plan(STAGES.deep(), 10, { getExercise: slow }).workout;
    const fastPlan = plan(STAGES.deep(), 10, { getExercise: fast }).workout;
    const levelTakes = (w: Workout) => levelItems(w).reduce((s, i) => s + i.takes, 0);
    expect(levelTakes(fastPlan)).toBeGreaterThan(levelTakes(slowPlan));
    expect(slowPlan.totalEstSeconds).toBeLessThanOrEqual(600);
    expect(fastPlan.totalEstSeconds).toBeLessThanOrEqual(600);
  });

  it('when single takes already overshoot, drops the least valuable items first and still fits', () => {
    const { workout } = plan(STAGES.deep(), 5, { knobs: { defaultTakeSec: 120 } });
    expect(stages(workout)).toEqual(['warm-up', 'world-item', 'cool-down']);
    expect(workout.totalEstSeconds).toBeLessThanOrEqual(300);
    expect(workout.items.find((i) => i.stage === 'world-item')?.takes).toBe(1);
  });

  it('keeps the routines when no level can fit on its own, and returns nothing only when even they cannot', () => {
    const huge = plan(STAGES.deep(), 5, { knobs: { defaultTakeSec: 100_000 } }).workout;
    expect(stages(huge)).toEqual(['warm-up', 'cool-down']);
    expect(huge.totalEstSeconds).toBeLessThanOrEqual(300);
    const impossible = plan(STAGES.deep(), 5, { knobs: { defaultTakeSec: 100_000, routineSetupSec: 1000 } }).workout;
    expect(impossible.items).toEqual([]);
    expect(impossible.locked).toBe(false);
    expect(impossible.totalEstSeconds).toBe(0);
  });

  it('holds the invariants across many random progress points, budgets and take lengths', () => {
    const rand = seeded(2026);
    for (let n = 0; n < 150; n++) {
      const target = ALL_LEVELS[Math.floor(rand() * ALL_LEVELS.length)];
      const attempts = passThrough(worlds, target);
      const minutes = BUDGETS[Math.floor(rand() * BUDGETS.length)];
      const knobs = { defaultTakeSec: 5 + Math.floor(rand() * 200), levelSetupSec: Math.floor(rand() * 40) };
      const { snapshot, workout } = plan(attempts, minutes, { knobs });
      expectWellFormed(snapshot, workout);
    }
  });
});

describe('estimateTakeSeconds', () => {
  it('is the count-in plus every repeat of the pattern, at the exercise tempo', () => {
    const def = exerciseDef('x', { tempoBpm: 60, countInBeats: 2, pattern: [{ semis: 0, beats: 4 }, { beats: 1 }], repeats: { count: 3, stepSemis: 2 } });
    expect(estimateTakeSeconds(def)).toBeCloseTo(2 + 3 * 5, 9);
    expect(estimateTakeSeconds(exerciseDef('y', { tempoBpm: 120, countInBeats: 0, pattern: [{ semis: 0, beats: 4 }] }))).toBeCloseTo(2, 9);
  });

  it('falls back when the exercise is unknown or has no usable tempo', () => {
    expect(estimateTakeSeconds(undefined)).toBe(WORKOUT_KNOBS.defaultTakeSec);
    expect(estimateTakeSeconds(undefined, 12)).toBe(12);
    expect(estimateTakeSeconds(exerciseDef('z', { tempoBpm: 0 }), 7)).toBe(7);
  });
});
