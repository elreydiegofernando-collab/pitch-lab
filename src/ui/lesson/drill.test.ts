/**
 * A practice try read for its report: good or not (the step's rule, as the lesson reads it), the step's good tries after
 * it, whether it finished the step, and whether every step is done. Fixture lessons stand in for src/lessons.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lessons', async () => (await import('./test-support')).lessonsModule());
vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  ...(await import('./test-support')).lessonProgressModule(),
}));

import { getLevel, getWorld } from '../../exercises';
import { attempt } from '../../progress/test-fixtures';
import type { PreparedRun, TakeOutcome } from '../../runtime/types';
import type { AttemptRecord } from '../../storage/schema';
import { orderedLevels } from '../worlds/levels';
import { snapshotOf } from '../worlds/test-support';
import { drillCaption } from './DrillVerdict';
import { drillNextLine, drillSummary } from './drill';
import { lessonNumber } from './model';
import { fixtureLesson, lessonRig, resetLessons, setLessons } from './test-support';

const ORDER = orderedLevels(getWorld('foundations')!);
const LEVEL = ORDER[3].id;
const LESSON = fixtureLesson(LEVEL);
const SNAP = snapshotOf(ORDER[2].id);
const GOOD = { 'accuracy.inTolerancePct': 90 };
const POOR = { 'accuracy.inTolerancePct': 10 };

/** A finished try of step `step` as far as the report reads one: the target, the step's counts, the verdict and the row. */
function tryOf(step: number, opts: { metrics?: Record<string, number>; drill?: PreparedRun['drill']; notJudged?: 'stopped' | 'folded'; noVoice?: boolean; passed?: boolean } = {}): TakeOutcome {
  const row = attempt({ exerciseId: LESSON.practice[step].exerciseId, levelId: null, metrics: opts.metrics ?? GOOD, passed: opts.passed ?? true });
  return {
    id: row.id,
    prepared: { target: { kind: 'drill', levelId: LEVEL, step }, drill: opts.drill ?? null },
    evaluation: { passed: opts.passed ?? true, notJudged: opts.notJudged },
    analysis: { tipContext: { noVoice: opts.noVoice ?? false }, metrics: row.metrics },
    attempt: row,
  } as unknown as TakeOutcome;
}

/** Earlier tries of a step in the log. */
function rows(step: number, n: number, metrics: Record<string, number> = GOOD): AttemptRecord[] {
  return Array.from({ length: n }, () => attempt({ exerciseId: LESSON.practice[step].exerciseId, levelId: null, metrics }));
}

beforeEach(() => {
  resetLessons();
  setLessons(LESSON);
});

describe('drillSummary', () => {
  it('is null for any take that is not a practice try', () => {
    const level = { ...tryOf(0), prepared: { target: { kind: 'level', levelId: LEVEL } } } as unknown as TakeOutcome;
    expect(drillSummary(level, [], SNAP)).toBeNull();
  });

  it('reads a good try against the log that holds it: the good tries with it, and it did not finish the step yet', () => {
    const t = tryOf(1);
    const s = drillSummary(t, [...rows(1, 1), t.attempt], SNAP)!;
    expect(s.verdict).toEqual({ kind: 'good', word: 'Good try', reason: null });
    expect([s.goodTries, s.needed, s.finishedStep, s.ready]).toEqual([2, 3, false, false]);
    expect(s.lessonName).toBe(`Lesson ${lessonNumber(getWorld('foundations'), getLevel(LEVEL)!)}`);
    expect(drillNextLine(s)).toBeNull();
  });

  it('says when the try finished its step, and when it made every step done', () => {
    const t = tryOf(1);
    const finished = drillSummary(t, [...rows(1, 2), t.attempt], SNAP)!;
    expect([finished.goodTries, finished.finishedStep, finished.ready]).toEqual([3, true, false]);
    expect(drillNextLine(finished)).toBe('This step is done. On to the next one.');

    const last = tryOf(2);
    const ready = drillSummary(last, [...rows(0, 2), ...rows(1, 3), ...rows(2, 1), last.attempt], SNAP)!;
    expect([ready.goodTries, ready.finishedStep, ready.ready]).toEqual([2, true, true]);
    expect(drillNextLine(ready)).toBe('Every practice step is done: you are ready for the check.');
  });

  it('never says a step was finished by a try once it was done before it', () => {
    const t = tryOf(0);
    const s = drillSummary(t, [...rows(0, 2), t.attempt], SNAP)!;
    expect([s.goodTries, s.finishedStep]).toEqual([2, false]);
  });

  it('just says the step is done when practising a passed lesson again', () => {
    const t = tryOf(1);
    const s = drillSummary(t, [...rows(1, 2), t.attempt], snapshotOf(LEVEL))!;
    expect(s.passed).toBe(true);
    expect(drillNextLine(s)).toBe('This step is done.');
  });

  it('says "Not quite yet" for a try the rule did not count, and counts nothing for it', () => {
    const t = tryOf(1, { metrics: POOR, passed: false });
    const s = drillSummary(t, [...rows(1, 1), t.attempt], SNAP)!;
    expect(s.verdict).toEqual({ kind: 'not-yet', word: 'Not quite yet', reason: null });
    expect([s.good, s.goodTries, s.finishedStep]).toEqual([false, 1, false]);
  });

  it('says why a try stopped early, silent, or not fitting the range did not count', () => {
    lessonRig.good = false; // the lesson's rule: such a try was not sung to its end
    expect(drillSummary(tryOf(1, { notJudged: 'stopped' }), [], SNAP)!.verdict).toEqual({
      kind: 'not-yet',
      word: 'Not quite yet',
      reason: 'Stopped early: a try counts when you sing it to the end.',
    });
    expect(drillSummary(tryOf(1, { noVoice: true }), [], SNAP)!.verdict.kind).toBe('silent');
    expect(drillSummary(tryOf(1, { notJudged: 'folded' }), [], SNAP)!.verdict).toMatchObject({ kind: 'not-judged', word: 'Not judged' });
  });

  it('falls back on the counts the runner wrote (this try included) when the log does not hold the try', () => {
    const s = drillSummary(tryOf(1, { drill: { levelId: LEVEL, step: 1, stepCount: 3, good: 3, needed: 3 } }), [], SNAP)!;
    expect([s.goodTries, s.needed, s.finishedStep]).toEqual([3, 3, true]);
  });

  it('still reads a try of a lesson it does not know, from the drill’s own pass and the runner’s counts', () => {
    setLessons();
    const s = drillSummary(tryOf(1, { drill: { levelId: LEVEL, step: 1, stepCount: 4, good: 1, needed: 2 } }), [], SNAP)!;
    expect(s.lesson).toBeNull();
    expect(s.verdict.kind).toBe('good');
    expect([s.goodTries, s.needed, s.stepCount]).toEqual([1, 2, 4]);
    expect(drillCaption(s)).toBe('Step 2 of 4');
  });
});

describe('drillCaption', () => {
  it('names the lesson, the step and its title', () => {
    const s = drillSummary(tryOf(1), [], SNAP)!;
    expect(drillCaption(s)).toBe(`${s.lessonName} · Step 2 of 3: ${LESSON.practice[1].title}`);
  });
});
