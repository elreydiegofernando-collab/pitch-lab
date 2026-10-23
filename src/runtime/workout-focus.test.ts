/**
 * The latest voice check-up steers the daily workout (runtime/workout.ts): the levels behind its focus skills rise to the
 * top of the weakness ranking, so the review leans on them; a focus never plans a level that is not open. Over the
 * session's signals (set directly; no storage needed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics } from '../analysis/types';
import { CHECKUP_TASKS } from '../checkup/types';
import { WORLDS, evaluate, getExercise, realize } from '../exercises';
import { computeSnapshot, withRoutines, type WeaknessScore } from '../progress';
import { BASE_MS, P1, attempt, passThrough } from '../progress/test-fixtures';
import type { AttemptRecord } from '../storage/schema';
import { attemptLog, snapshot } from '../state/session';
import { settings } from '../state/settings';
import { DEFAULT_SETTINGS } from '../state/settings-types';
import { abandonWorkout, planWorkout, raiseFocusLevels } from './workout';

vi.mock('../state/songs', async () => {
  const { signal } = await import('@preact/signals');
  return { songIndex: signal(new Map()), songsLoaded: signal(true), songLoadErrors: signal([]), loadSongs: async () => undefined, getSong: async () => undefined };
});

function useLog(log: AttemptRecord[]): void {
  attemptLog.value = log;
  snapshot.value = computeSnapshot(P1, WORLDS, log, BASE_MS, { getExercise: withRoutines(getExercise) });
}

/** A whole check-up as the runner logs it, every task sung at its best except the overrides. */
function checkupRows(id: string, over: Record<number, Metrics> = {}): AttemptRecord[] {
  return CHECKUP_TASKS.map((task, i) => {
    const def = getExercise(task.exerciseId)!;
    const metrics: Metrics = {};
    for (const t of def.scoring) metrics[t.metric] = t.best;
    Object.assign(metrics, over[i]);
    const e = evaluate(def, metrics);
    const r = realize(def, null, 'unknown', { bpm: def.tempoBpm });
    const practice = task.logAs.kind === 'practice';
    const row = attempt({
      exerciseId: def.id,
      kind: practice ? 'practice' : 'audition',
      levelId: task.logAs.kind === 'practice' ? task.logAs.levelId : null,
      passed: e.passed,
      score: e.score,
      mastery: e.mastery,
      metrics,
      durationSec: r.countInSec + r.totalSec,
      tempoBpm: def.tempoBpm,
    });
    return { ...row, checkupId: id };
  });
}

const review = (log: AttemptRecord[]) => {
  useLog(log);
  return planWorkout(20).items.find((i) => i.stage === 'review') ?? null;
};

beforeEach(() => {
  abandonWorkout();
  settings.value = DEFAULT_SETTINGS;
  useLog([]);
});

describe('raiseFocusLevels', () => {
  const score = (levelId: string): WeaknessScore => ({ levelId, worldId: 'foundations', mastery: 1, score: 0.5, performance: 0.5, misses: 0, staleness: 0.5, dueInDays: 0, reasons: [] });
  const ids = (ranking: WeaknessScore[]) => ranking.map((r) => r.levelId);

  it('puts the first focus skill’s levels first, then the second’s (each weakest first), then the rest in place', () => {
    const ranking = ['a', 'b', 'c', 'd', 'e'].map(score);
    expect(ids(raiseFocusLevels(ranking, [['d'], ['e', 'b']]))).toEqual(['d', 'b', 'e', 'a', 'c']);
    expect(ids(raiseFocusLevels(ranking, [['locked', 'c']]))).toEqual(['c', 'a', 'b', 'd', 'e']); // a level the ranking lacks stays out
    expect(ids(raiseFocusLevels(ranking, [['b'], ['b']]))).toEqual(['b', 'a', 'c', 'd', 'e']); // once, in its first group
    const same = raiseFocusLevels(ranking, []);
    expect(ids(same)).toEqual(ids(ranking));
    expect(same).not.toBe(ranking);
  });
});

describe('planWorkout with a check-up focus', () => {
  it('“your voice cracks on slides”: Sirens & glides becomes the review', () => {
    const before = passThrough(WORLDS, 'foundations.boss');
    const usual = review(before);
    expect(usual).not.toBeNull();
    expect(usual!.levelId).not.toBe('foundations.05');

    const cracks = checkupRows('c1', { 2: { 'glide.cracks': 3 } });
    expect(review([...before, ...cracks])).toMatchObject({ stage: 'review', levelId: 'foundations.05', reason: 'weakest' });
  });

  it('follows the latest check-up: a re-check with clean slides lets the review go back to its usual pick', () => {
    const before = passThrough(WORLDS, 'foundations.boss');
    const log = [...before, ...checkupRows('c1', { 2: { 'glide.cracks': 3 } })];
    expect(review(log)?.levelId).toBe('foundations.05');
    const rechecked = [...log, ...checkupRows('c2')];
    expect(review(rechecked)?.levelId).not.toBe('foundations.05');
    // An unfinished check-up after it changes nothing.
    expect(review([...log, ...checkupRows('c3', { 2: { 'glide.cracks': 0 } }).slice(0, 3)])?.levelId).toBe('foundations.05');
  });

  it('never plans a level that is not open: a focus on a locked skill leaves the plan as it was', () => {
    const early = passThrough(WORLDS, 'foundations.03');
    const focusConnected = checkupRows('c1', { 1: { 'accuracy.inTolerancePct': 0 }, 4: { 'transition.cleanRate': 0 } });
    useLog([...early, ...focusConnected]);
    const plan = planWorkout(20);
    for (const item of plan.items) if (item.levelId) expect(['current', 'passed'], item.levelId).toContain(snapshot.value.levels[item.levelId].status);
    expect(plan.items.some((i) => i.levelId === 'foundations.09')).toBe(false);
  });
});
