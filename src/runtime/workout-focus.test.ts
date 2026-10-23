/**
 * The latest voice check-up steers the daily workout (runtime/workout.ts): the levels behind its focus skills rise to the
 * top of the weakness ranking, so the review leans on them; a focus never plans a level that is not open. Over the
 * session's signals (set directly; no storage needed).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metrics } from '../analysis/types';
import { SKILL_LEVELS } from '../checkup/skills';
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
  /** The siren task (sung last) and the connected line, by the skills they rate. */
  const SIREN = CHECKUP_TASKS.findIndex((t) => t.skills.some((s) => s.skill === 'slides'));
  const LINE = CHECKUP_TASKS.findIndex((t) => t.skills.some((s) => s.skill === 'connected'));
  const slideLevels: readonly string[] = SKILL_LEVELS.slides;

  it('“your voice cracks on slides”: a slides lesson (Small slides or Sirens) becomes the review', () => {
    const before = passThrough(WORLDS, 'foundations.boss');
    const usual = review(before);
    expect(usual).not.toBeNull();
    expect(slideLevels).not.toContain(usual!.levelId);

    const cracks = checkupRows('c1', { [SIREN]: { 'glide.cracks': 3 } });
    const focused = review([...before, ...cracks]);
    expect(focused).toMatchObject({ stage: 'review', reason: 'weakest' });
    expect(slideLevels).toContain(focused!.levelId);
  });

  it('follows the latest check-up: a re-check with clean slides lets the review go back to its usual pick', () => {
    const before = passThrough(WORLDS, 'foundations.boss');
    const log = [...before, ...checkupRows('c1', { [SIREN]: { 'glide.cracks': 3 } })];
    expect(slideLevels).toContain(review(log)?.levelId);
    const rechecked = [...log, ...checkupRows('c2')];
    expect(slideLevels).not.toContain(review(rechecked)?.levelId);
    // An unfinished check-up after it (the siren, sung last, not reached) changes nothing.
    expect(slideLevels).toContain(review([...log, ...checkupRows('c3', { [SIREN]: { 'glide.cracks': 0 } }).slice(0, 3)])?.levelId);
  });

  it('never plans a level that is not open: a focus on a locked skill leaves the plan as it was', () => {
    const early = passThrough(WORLDS, 'foundations.03');
    const focusConnected = checkupRows('c1', { 1: { 'accuracy.inTolerancePct': 0 }, [LINE]: { 'transition.cleanRate': 0 } });
    useLog([...early, ...focusConnected]);
    const plan = planWorkout(20);
    for (const item of plan.items) if (item.levelId) expect(['current', 'passed'], item.levelId).toContain(snapshot.value.levels[item.levelId].status);
    for (const id of SKILL_LEVELS.connected) expect(plan.items.some((i) => i.levelId === id), id).toBe(false);
  });
});
