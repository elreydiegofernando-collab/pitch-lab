/**
 * Test support for the lesson screens (imported by tests only): fixture lessons on real catalog levels, and stand-ins for
 * src/lessons (its LESSONS are the fixtures a test sets, so a test never depends on the Foundations content) and for
 * src/lessons/progress (a lesson's progress is what a test sets, else counted from the log; a good try is what a test
 * says, else the step's rule on the metrics). vi.mock factories reach them with `await import('../lesson/test-support')`,
 * so a test file and the mocked modules share this state.
 */
import { vi } from 'vitest';
import type { GoodTryRule, LessonDef, LessonProgress, PracticeStep } from '../../lessons/types';
import type { ProgressSnapshot } from '../../progress/types';
import type { AttemptRecord } from '../../storage/schema';
import type { TermId } from '../../teach/glossary';

/** What the stand-ins answer: the lessons there are, each one's progress, and whether a try was good. */
export const lessonRig = {
  /** The stand-in's LESSONS (filled in place by setLessons). */
  lessons: {} as Record<string, LessonDef>,
  /** A lesson's progress as a test sets it; a lesson without one is counted from the log (progressFromLog). */
  progress: new Map<string, LessonProgress>(),
  /** isGoodTry's answer (for the try and for every row of the log); null = every condition holds on the metrics read. */
  good: null as boolean | null,
};

/** The lessons the app has for this test (none: every level keeps the classic screen). */
export function setLessons(...lessons: LessonDef[]): void {
  for (const key of Object.keys(lessonRig.lessons)) delete lessonRig.lessons[key];
  for (const lesson of lessons) lessonRig.lessons[lesson.levelId] = lesson;
}

/** Back to no lessons, no progress and the metrics' own answer for a good try; call from beforeEach. */
export function resetLessons(): void {
  setLessons();
  lessonRig.progress.clear();
  lessonRig.good = null;
}

/** What `vi.mock('../../lessons', ...)` returns. */
export function lessonsModule() {
  return {
    LESSONS: lessonRig.lessons,
    lessonFor: (levelId: string): LessonDef | undefined =>
      Object.prototype.hasOwnProperty.call(lessonRig.lessons, levelId) ? lessonRig.lessons[levelId] : undefined,
    lessonOfDrill: (exerciseId: string): { lesson: LessonDef; step: number } | undefined => {
      for (const lesson of Object.values(lessonRig.lessons)) {
        const step = lesson.practice.findIndex((p) => p.exerciseId === exerciseId);
        if (step >= 0) return { lesson, step };
      }
      return undefined;
    },
  };
}

/** Nothing tried yet: what a fresh profile's lesson reads (passed from the snapshot). */
export function freshProgress(lesson: LessonDef, snapshot?: ProgressSnapshot): LessonProgress {
  return progressOf(lesson, [], { passed: snapshot?.levels[lesson.levelId]?.status === 'passed' });
}

/**
 * A lesson's progress from the good tries of each step (missing steps: none), with the tries (default: one more than
 * the good ones on a step that has any) and whether the level is passed.
 */
export function progressOf(lesson: LessonDef, good: readonly number[], opts: { tries?: readonly number[]; passed?: boolean } = {}): LessonProgress {
  const steps = lesson.practice.map((p, i) => {
    const g = Math.min(p.goodTries, good[i] ?? 0);
    const tries = opts.tries?.[i] ?? (g > 0 ? g + 1 : 0);
    return { exerciseId: p.exerciseId, good: g, needed: p.goodTries, tries, done: g >= p.goodTries };
  });
  const open = steps.findIndex((s) => !s.done);
  const currentStep = open < 0 ? steps.length : open;
  return { levelId: lesson.levelId, steps, currentStep, ready: currentStep === steps.length, passed: opts.passed ?? false };
}

/** Set the progress a lesson reads. */
export function setProgress(progress: LessonProgress): void {
  lessonRig.progress.set(progress.levelId, progress);
}

type MetricsRead = Readonly<Record<string, number | undefined>>;

function holds(rule: GoodTryRule, metrics: MetricsRead): boolean {
  return rule.conditions.every((c) => {
    const v = metrics[c.metric];
    return typeof v === 'number' && (c.op === '<=' ? v <= c.value : v >= c.value);
  });
}

/** The stand-in's good try: what the test says, else every condition of the rule holds on the metrics read. */
function goodTry(rule: GoodTryRule, metrics: MetricsRead): boolean {
  return lessonRig.good ?? holds(rule, metrics);
}

/** A lesson's progress counted from the log: each step's tries are the rows of its exercise, its good tries the good ones. */
export function progressFromLog(lesson: LessonDef, log: readonly AttemptRecord[], snapshot?: ProgressSnapshot): LessonProgress {
  const rows = (exerciseId: string) => log.filter((a) => a.exerciseId === exerciseId && a.deletedAt == null);
  return progressOf(
    lesson,
    lesson.practice.map((p) => rows(p.exerciseId).filter((a) => goodTry(p.good, a.metrics as MetricsRead)).length),
    { tries: lesson.practice.map((p) => rows(p.exerciseId).length), passed: snapshot?.levels[lesson.levelId]?.status === 'passed' },
  );
}

/** What `vi.mock('../../lessons/progress', ...)` returns (spread over the real module, so its other exports stay). */
export function lessonProgressModule() {
  return {
    isGoodTry: vi.fn((rule: GoodTryRule, attempt: { metrics: MetricsRead }, metrics?: MetricsRead) => goodTry(rule, metrics ?? attempt.metrics)),
    lessonProgress: vi.fn(
      (lesson: LessonDef, log: readonly AttemptRecord[], snapshot: ProgressSnapshot) => lessonRig.progress.get(lesson.levelId) ?? progressFromLog(lesson, log, snapshot),
    ),
  };
}

function step(n: number, goodTries: number, title: string, ask: string): PracticeStep {
  return { exerciseId: `test.drill.${n}`, title, ask, goodTries, good: { conditions: [{ metric: 'accuracy.inTolerancePct', op: '>=', value: 50 }] } };
}

/**
 * A lesson on `levelId` with three practice steps (2, 3 and 2 good tries), a Learn page that uses glossary words in its
 * text, and `terms` as the words it teaches.
 */
export function fixtureLesson(levelId: string, opts: { title?: string; terms?: readonly TermId[]; steps?: readonly PracticeStep[] } = {}): LessonDef {
  return {
    levelId,
    title: opts.title ?? 'Two notes, one step apart',
    outcome: 'Hear two notes a step apart, then sing them back in tune.',
    learn: {
      what: 'A step is the smallest move between two notes in a tune.',
      why: 'Most tunes move by steps, so landing each one in tune is half of singing a song.',
      how: ['Listen to both notes.', 'Sing the first one back and hold it.', 'Move up to the second note and hold it.'],
      onScreen: ['Each note is a bar. Keep your line inside the in-tune zone.', 'Your line turns blue while you are in tune.'],
      terms: opts.terms ?? ['step', 'echo'],
    },
    practice: opts.steps ?? [
      step(1, 2, 'Echo the first note', 'The app plays one note: sing it back.'),
      step(2, 3, 'Echo both notes', 'The app plays two notes a step apart: sing them back.'),
      step(3, 2, 'Both notes, held longer', 'Hold each note for two seconds.'),
    ],
  };
}
