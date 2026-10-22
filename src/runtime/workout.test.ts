/**
 * The daily-workout session over the session's signals (set directly here; no storage needed): planning from the
 * snapshot and log, starting, recording takes, the summary and abandoning.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORLDS } from '../exercises';
import { computeSnapshot } from '../progress';
import { BASE_MS, P1, pass } from '../progress/test-fixtures';
import type { AttemptRecord } from '../storage/schema';
import { attemptLog, snapshot } from '../state/session';
import { settings } from '../state/settings';
import { DEFAULT_SETTINGS } from '../state/settings-types';
import type { TakeOutcome } from './types';
import { abandonWorkout, activeWorkout, finishWorkout, planWorkout, recordWorkoutTake, startWorkout } from './workout';

vi.mock('../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new Map()), songsLoaded: signal(true), songLoadErrors: signal([]), loadSongs: async () => undefined, getSong: async () => undefined };
});

function useLog(log: AttemptRecord[], momentum?: number): void {
  attemptLog.value = log;
  const s = computeSnapshot(P1, WORLDS, log, BASE_MS);
  snapshot.value = momentum === undefined ? s : { ...s, momentum };
}

function take(attempt: Partial<AttemptRecord>, momentum: { before: number; after: number }): TakeOutcome {
  return {
    attempt: pass('foundations.02', attempt),
    before: { momentum: momentum.before },
    after: { momentum: momentum.after },
  } as unknown as TakeOutcome;
}

beforeEach(() => {
  abandonWorkout();
  settings.value = DEFAULT_SETTINGS;
  useLog([]);
});

describe('planWorkout', () => {
  it('is locked until the first level is passed', () => {
    const plan = planWorkout(10);
    expect(plan).toMatchObject({ locked: true, items: [], hint: 'Pass your first level to unlock the daily workout.' });
    expect(() => startWorkout(10)).toThrow('Pass your first level to unlock the daily workout.');
    expect(activeWorkout.value).toBeNull();
  });

  it("plans from the active profile's snapshot and log: warm-up, the current level, cool-down, within the budget", () => {
    useLog([pass('foundations.01')]);
    const plan = planWorkout(10);
    expect(plan.locked).toBe(false);
    expect(plan.items[0]).toMatchObject({ stage: 'warm-up', source: 'routine' });
    expect(plan.items.find((i) => i.stage === 'world-item')).toMatchObject({ levelId: 'foundations.02', reason: 'current-level' });
    expect(plan.items[plan.items.length - 1]).toMatchObject({ stage: 'cool-down' });
    expect(plan.totalEstSeconds).toBeLessThanOrEqual(10 * 60);
  });
});

describe('a workout session', () => {
  it('starts with one empty result per item and remembers the chosen length', () => {
    useLog([pass('foundations.01')]);
    const session = startWorkout(20);
    expect(activeWorkout.value).toBe(session);
    expect(session.finishedAt).toBeNull();
    expect(session.results).toHaveLength(session.workout.items.length);
    expect(session.results.every((r) => r.attemptIds.length === 0 && r.bestScore === null && !r.passedAny)).toBe(true);
    expect(settings.value.workoutMinutes).toBe(20);
  });

  it('records takes per item and summarizes minutes actually sung and Momentum around the takes', () => {
    const t1 = pass('foundations.02', { score: 0.6, passed: false, durationSec: 45 });
    const t2 = pass('foundations.02', { score: 0.9, passed: true, durationSec: 75 });
    useLog([pass('foundations.01')], 10);
    const session = startWorkout(10);
    recordWorkoutTake(1, take(t1, { before: 10, after: 11 }));
    recordWorkoutTake(1, take(t2, { before: 11, after: 12.5 }));
    recordWorkoutTake(99, take(t2, { before: 0, after: 0 })); // out of range: ignored
    const results = activeWorkout.value!.results;
    expect(results[1]).toEqual({ attemptIds: [t1.id, t2.id], bestScore: 0.9, passedAny: true });
    expect(results[0].attemptIds).toEqual([]);
    expect(activeWorkout.value).not.toBe(session); // a new value, so screens re-render

    useLog([pass('foundations.01'), t1, t2], 12.5);
    const summary = finishWorkout();
    expect(summary).toEqual({ itemsDone: 1, itemCount: session.results.length, takes: 2, minutes: 2, momentumBefore: 10, momentumAfter: 12.5 });
    expect(activeWorkout.value?.finishedAt).not.toBeNull();
    // Finished: further takes are not counted, and the summary repeats.
    recordWorkoutTake(0, take(t1, { before: 0, after: 0 }));
    expect(activeWorkout.value?.results[0].attemptIds).toEqual([]);
    expect(finishWorkout()).toEqual(summary);
  });

  it('a workout with no takes summarizes as nothing sung, Momentum unchanged', () => {
    useLog([pass('foundations.01')], 7);
    startWorkout(5);
    expect(finishWorkout()).toMatchObject({ itemsDone: 0, takes: 0, minutes: 0, momentumBefore: 7, momentumAfter: 7 });
  });

  it('abandoning drops it without a summary', () => {
    useLog([pass('foundations.01')]);
    startWorkout(5);
    abandonWorkout();
    expect(activeWorkout.value).toBeNull();
    expect(finishWorkout()).toBeNull();
  });
});
