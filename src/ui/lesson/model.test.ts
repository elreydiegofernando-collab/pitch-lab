/** The lesson screens' model: numbers, safe progress, where the singer is, the one amber move, and the plain lines. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lessons/progress', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lessons/progress')>()),
  lessonProgress: vi.fn(),
}));

import { getExercise, getLevel, getWorld } from '../../exercises';
import { lessonProgress } from '../../lessons/progress';
import type { LessonProgress } from '../../lessons/types';
import { attempt } from '../../progress/test-fixtures';
import type { AttemptRecord } from '../../storage/schema';
import { orderedLevels } from '../worlds/levels';
import { snapshotOf } from '../worlds/test-support';
import {
  ZONE_WORDS,
  emptyProgress,
  goodTriesText,
  lessonLabel,
  lessonNumber,
  lessonStage,
  lessonTitle,
  nowStep,
  practiceLine,
  primaryMove,
  readLesson,
  readProgress,
  reviewStep,
  triesSoFar,
} from './model';
import { fixtureLesson, progressOf } from './test-support';

const FOUNDATIONS = getWorld('foundations')!;
const ORDER = orderedLevels(FOUNDATIONS);
const LEVEL = ORDER[3].id;
const LESSON = fixtureLesson(LEVEL);

describe('lessonNumber and lessonLabel', () => {
  it('numbers a lesson by its level’s place in the world, never by its stored id', () => {
    ORDER.forEach((level, i) => expect(lessonNumber(FOUNDATIONS, level), level.id).toBe(i + 1));
    expect(lessonLabel(lessonNumber(FOUNDATIONS, getLevel(LEVEL)!))).toBe('Lesson 4');
  });

  it('still answers for an unknown world or level', () => {
    expect(lessonNumber(undefined, getLevel(LEVEL)!)).toBe(1);
    expect(lessonNumber(FOUNDATIONS, { id: 'nonsense.01' })).toBe(1);
  });

  it('names a Boss Recital lesson titled just "Boss Recital" in full, and keeps every other title', () => {
    const boss = getLevel('foundations.boss')!;
    expect(lessonTitle({ title: 'Boss Recital' }, boss, FOUNDATIONS)).toBe('Foundations Boss Recital');
    expect(lessonTitle({ title: 'A short tune' }, boss, FOUNDATIONS)).toBe('A short tune');
    expect(lessonTitle({ title: 'Hold it steady' }, getLevel(LEVEL)!, FOUNDATIONS)).toBe('Hold it steady');
    expect(lessonTitle({ title: 'Boss Recital' }, boss, undefined)).toBe('Boss Recital');
  });
});

describe('readProgress', () => {
  const snap = snapshotOf(ORDER[2].id);

  it('is the lesson’s own progress when it can be read', () => {
    const read = progressOf(LESSON, [2, 1]);
    vi.mocked(lessonProgress).mockReturnValueOnce(read);
    expect(readProgress(LESSON, [], snap)).toBe(read);
  });

  it('reads as not started, never throwing, when the log cannot be read', () => {
    vi.mocked(lessonProgress).mockImplementationOnce(() => {
      throw new Error('unreadable');
    });
    const read = readProgress(LESSON, [], snap);
    expect(read).toEqual(emptyProgress(LESSON, snap));
    expect(read.currentStep).toBe(0);
    expect(read.steps.map((s) => [s.good, s.needed, s.tries, s.done])).toEqual(LESSON.practice.map((p) => [0, p.goodTries, 0, false]));
    expect(read.ready).toBe(false);
  });

  it('counts a pass in the snapshot, and keeps the current step inside the lesson', () => {
    const passedSnap = snapshotOf(LEVEL);
    vi.mocked(lessonProgress).mockReturnValueOnce({ ...progressOf(LESSON, []), passed: false });
    expect(readProgress(LESSON, [], passedSnap).passed).toBe(true);
    vi.mocked(lessonProgress).mockReturnValueOnce({ ...progressOf(LESSON, []), currentStep: 9 });
    expect(readProgress(LESSON, [], snap).currentStep).toBe(LESSON.practice.length);
  });
});

describe('where the singer is, and the amber move', () => {
  const snap = snapshotOf(ORDER[2].id);
  const fresh = progressOf(LESSON, []);
  const partWay = progressOf(LESSON, [2, 1]);
  const ready = progressOf(LESSON, [2, 3, 2]);
  const passed: LessonProgress = { ...progressOf(LESSON, [2]), passed: true };

  it('counts this lesson’s own tries: its practice tries and its check’s takes, never takes of what it replaced', () => {
    const check = getLevel(LEVEL)!.exerciseId;
    expect(triesSoFar(fresh, [], check)).toBe(0);
    expect(triesSoFar(partWay, [], check)).toBe(3 + 2);
    const checks = [attempt({ exerciseId: check, levelId: LEVEL, passed: false }), attempt({ exerciseId: check, levelId: LEVEL, passed: false })];
    expect(triesSoFar(fresh, checks, check)).toBe(2);
    // Sung on this place in the world before the rebuild (the old Sustain II), or deleted: no try of this lesson, which
    // opens on Learn.
    const before = [
      attempt({ exerciseId: 'foundations.sustain.2', levelId: 'foundations.04', passed: true }),
      attempt({ exerciseId: check, levelId: LEVEL, passed: false, deletedAt: '2026-10-22T12:00:00.000Z' }),
    ];
    expect(triesSoFar(fresh, before, check)).toBe(0);
    expect(lessonStage(fresh, triesSoFar(fresh, before, check))).toBe('learn');
  });

  it('after a missed check, goes back to the step that trains what was missed until a good try: Practise, Now, the amber move', () => {
    expect(lessonStage(ready, 7, 1)).toBe('practise');
    expect(lessonStage(fresh, 0, 0)).toBe('practise'); // a miss is a try: never Learn again
    expect(nowStep(ready, 1)).toBe(1);
    expect(nowStep(partWay)).toBe(partWay.currentStep);
    expect(primaryMove(LESSON, ready, 1)).toEqual({ kind: 'practise', label: 'Practise', target: { kind: 'drill', levelId: LEVEL, step: 1 } });
    expect(practiceLine(ready, 7, 1)).toBe('Practice 2 of 3');
    // A pass ends it, whatever came before.
    expect(lessonStage(passed, 3, 1)).toBe('passed');
    expect(primaryMove(LESSON, passed, 1).kind).toBe('check-again');
    expect(practiceLine(passed, 3, 1)).toBe('Passed');
  });

  it('reads the step to go back to from the log: after the latest check missed, never on a passed lesson, never throwing', () => {
    const check = getExercise(getLevel(LEVEL)!.exerciseId)!;
    const missed = attempt({ exerciseId: check.id, levelId: LEVEL, passed: false, metrics: {} });
    vi.mocked(lessonProgress).mockReturnValueOnce(ready);
    const practised = ready.steps.reduce((n, s) => n + s.tries, 0);
    expect(readLesson(LESSON, check, [missed], snap)).toEqual({ progress: ready, tries: practised + 1, review: LESSON.practice.length - 1 });
    vi.mocked(lessonProgress).mockReturnValueOnce(ready);
    const passedAfter = attempt({ exerciseId: check.id, levelId: LEVEL, passed: true });
    expect(readLesson(LESSON, check, [missed, passedAfter], snap).review).toBeNull();
    vi.mocked(lessonProgress).mockReturnValueOnce(passed);
    expect(readLesson(LESSON, check, [missed], snap).review).toBeNull();
    expect(reviewStep(LESSON, check, null as unknown as AttemptRecord[])).toBeNull(); // an unreadable log
  });

  it('is at Learn before any try, Practise until every step is done, then the Check, until it is passed', () => {
    expect(lessonStage(fresh, 0)).toBe('learn');
    expect(lessonStage(fresh, 1)).toBe('practise');
    expect(lessonStage(partWay, 5)).toBe('practise');
    expect(lessonStage(ready, 7)).toBe('check');
    expect(lessonStage(passed, 0)).toBe('passed');
  });

  it('practises the current step, then takes the check, then sings it again: never a gate, only the next move', () => {
    expect(primaryMove(LESSON, fresh)).toEqual({ kind: 'practise', label: 'Practise', target: { kind: 'drill', levelId: LEVEL, step: 0 } });
    expect(primaryMove(LESSON, partWay)).toEqual({ kind: 'practise', label: 'Practise', target: { kind: 'drill', levelId: LEVEL, step: 1 } });
    expect(primaryMove(LESSON, ready)).toEqual({ kind: 'check', label: 'Take the check', target: { kind: 'level', levelId: LEVEL } });
    expect(primaryMove(LESSON, passed)).toEqual({ kind: 'check-again', label: 'Sing the check again', target: { kind: 'level', levelId: LEVEL } });
    // A lesson with no practice steps is ready for its check from the start.
    const bare = { ...LESSON, practice: [] };
    expect(primaryMove(bare, emptyProgress(bare, snap)).kind).toBe('check');
  });

  it('says where the practice is in plain words', () => {
    expect(practiceLine(fresh, 0)).toBe('New lesson');
    expect(practiceLine(fresh, 1)).toBe('Practice 1 of 3');
    expect(practiceLine(partWay, 5)).toBe('Practice 2 of 3');
    expect(practiceLine(ready, 7)).toBe('Ready for the check');
    expect(practiceLine(passed, 3)).toBe('Passed');
  });
});

describe('plain words', () => {
  it('counts good tries', () => {
    expect(goodTriesText(2, 3)).toBe('2 of 3 good tries');
    expect(goodTriesText(0, 1)).toBe('0 of 1 good try');
    expect(goodTriesText(5, 3)).toBe('3 of 3 good tries');
    expect(goodTriesText(-1, 2)).toBe('0 of 2 good tries');
  });

  it('names the in-tune zone of each tier in a word, never in cents', () => {
    expect(ZONE_WORDS).toEqual({ easy: 'wide', default: 'medium', studio: 'narrow' });
  });
});
