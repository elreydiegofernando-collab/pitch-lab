/**
 * What the lesson screens read about a lesson (pure): its number in its world, its progress (read so that a log it
 * cannot read costs the progress line, never the screen), where the singer is in it (learn, practise, check, passed),
 * the one primary move, and the plain words for practice progress and the in-tune zone. Every gate answer still comes
 * from src/progress and the route guard; nothing here opens anything.
 *
 * A missed check sends the singer back to practice (lessons/progress.ts stepAfterMiss: the step that trains what was
 * missed): until a good try is sung, that step is the one marked Now and the amber move practises it; the check stays
 * one tap away on the Check part.
 */
import type { ToleranceLevel } from '../../core/types';
import type { ExerciseDef, LevelDef, WorldDef } from '../../exercises/types';
import { lessonProgress, stepAfterMiss } from '../../lessons/progress';
import type { LessonDef, LessonProgress } from '../../lessons/types';
import type { ProgressSnapshot } from '../../progress/types';
import type { RunTarget } from '../../runtime/types';
import type { AttemptRecord } from '../../storage/schema';

/** A lesson's number: its level's 1-based place in the world, in play order (`index`), never its id's number. */
export function lessonNumber(world: Pick<WorldDef, 'levels'> | undefined, level: Pick<LevelDef, 'id'>): number {
  if (!world) return 1;
  const ordered = [...world.levels].sort((a, b) => a.index - b.index);
  const at = ordered.findIndex((l) => l.id === level.id);
  return at < 0 ? 1 : at + 1;
}

/** "Lesson 5". */
export function lessonLabel(n: number): string {
  return `Lesson ${n}`;
}

/**
 * The title a lesson goes by: its own, except that a Boss Recital lesson titled just "Boss Recital" (as every boss level
 * is) is named in full, "Foundations Boss Recital", as the classic screens name it.
 */
export function lessonTitle(lesson: Pick<LessonDef, 'title'>, level: Pick<LevelDef, 'kind' | 'title'>, world: Pick<WorldDef, 'title'> | undefined): string {
  const generic = lesson.title.trim().toLowerCase() === level.title.trim().toLowerCase() || /^boss recital$/i.test(lesson.title.trim());
  return level.kind === 'boss' && generic && world ? `${world.title} Boss Recital` : lesson.title;
}

/** No progress read yet: nothing tried, the first step next; `passed` from the snapshot. */
export function emptyProgress(lesson: LessonDef, snapshot: ProgressSnapshot): LessonProgress {
  const steps = lesson.practice.map((p) => ({ exerciseId: p.exerciseId, good: 0, needed: p.goodTries, tries: 0, done: false }));
  return {
    levelId: lesson.levelId,
    steps,
    currentStep: 0,
    ready: lesson.practice.length === 0,
    passed: snapshot.levels[lesson.levelId]?.status === 'passed',
  };
}

/**
 * The lesson's progress (src/lessons/progress.ts lessonProgress), never throwing: should the log ever be unreadable, the
 * lesson shows as not started rather than taking the screen down. A pass in the snapshot always counts.
 */
export function readProgress(lesson: LessonDef, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): LessonProgress {
  let read: LessonProgress;
  try {
    read = lessonProgress(lesson, log, snapshot);
  } catch {
    return emptyProgress(lesson, snapshot);
  }
  const passed = read.passed || snapshot.levels[lesson.levelId]?.status === 'passed';
  const currentStep = Math.max(0, Math.min(lesson.practice.length, read.currentStep));
  return passed === read.passed && currentStep === read.currentStep ? read : { ...read, passed, currentStep };
}

/**
 * This lesson's own tries so far: the practice tries of each step and the takes of its check (`checkId`, the level's
 * exercise today). Takes of material the lesson replaced (retired exercises, sung before the rebuild) are not tries of
 * this lesson, so a lesson met for the first time opens on Learn whatever was sung on its level before.
 */
export function triesSoFar(progress: LessonProgress, log: readonly AttemptRecord[], checkId: string): number {
  const practice = progress.steps.reduce((n, s) => n + Math.max(0, s.tries), 0);
  let checks = 0;
  for (const a of log) if (a.exerciseId === checkId && a.deletedAt == null) checks += 1;
  return practice + checks;
}

/**
 * After a missed check, the practice step to go back to (lessons/progress.ts stepAfterMiss); null when there is none, or
 * should the log be unreadable (the lesson then reads as it would without the miss, never as a broken screen).
 */
export function reviewStep(lesson: LessonDef, check: Pick<ExerciseDef, 'id' | 'pass'>, log: readonly AttemptRecord[]): number | null {
  try {
    const step = stepAfterMiss(lesson, check, log);
    return step !== null && step >= 0 && step < lesson.practice.length ? step : null;
  } catch {
    return null;
  }
}

/** Everything the screens read about where a singer is in a lesson. */
export interface LessonState {
  progress: LessonProgress;
  /** This lesson's own tries (triesSoFar). */
  tries: number;
  /** After a missed check, the step to go back to (reviewStep); null otherwise. */
  review: number | null;
}

/** A lesson's state for a profile, read from its log and snapshot (`check`: the lesson's check, its level's exercise). */
export function readLesson(lesson: LessonDef, check: Pick<ExerciseDef, 'id' | 'pass'>, log: readonly AttemptRecord[], snapshot: ProgressSnapshot): LessonState {
  const progress = readProgress(lesson, log, snapshot);
  return { progress, tries: triesSoFar(progress, log, check.id), review: progress.passed ? null : reviewStep(lesson, check, log) };
}

/**
 * Where the singer is in the lesson: Learn before the first try, then Practise until every step is done, then the
 * Check, until it is passed. After a missed check it is Practise again (`review`, the step to go back to), until a good
 * try is sung.
 */
export type LessonStage = 'learn' | 'practise' | 'check' | 'passed';

export function lessonStage(progress: LessonProgress, tries: number, review: number | null = null): LessonStage {
  if (progress.passed) return 'passed';
  if (review !== null) return 'practise';
  if (tries === 0) return 'learn';
  return progress.ready ? 'check' : 'practise';
}

/** The practice step marked Now: the step to go back to after a missed check, else the first step not yet done. */
export function nowStep(progress: LessonProgress, review: number | null = null): number {
  return review ?? progress.currentStep;
}

/** The lesson screen's one amber move, and what it sings. */
export interface PrimaryMove {
  kind: 'practise' | 'check' | 'check-again';
  label: string;
  target: RunTarget;
}

/**
 * Practise the current step until every step is done, then take the check; a passed lesson sings its check again (for
 * the tally lights). After a missed check, practise the step that trains what was missed (`review`) until a good try is
 * sung. Practice is never a gate: the check can be taken any time, it just is not the amber button then.
 */
export function primaryMove(lesson: LessonDef, progress: LessonProgress, review: number | null = null): PrimaryMove {
  const check: RunTarget = { kind: 'level', levelId: lesson.levelId };
  if (progress.passed) return { kind: 'check-again', label: 'Sing the check again', target: check };
  if (review !== null && review < lesson.practice.length) return { kind: 'practise', label: 'Practise', target: { kind: 'drill', levelId: lesson.levelId, step: review } };
  if (progress.ready || progress.currentStep >= lesson.practice.length) return { kind: 'check', label: 'Take the check', target: check };
  return { kind: 'practise', label: 'Practise', target: { kind: 'drill', levelId: lesson.levelId, step: progress.currentStep } };
}

/**
 * The practice step the singer is on, as words for the map and Home: "Practice 2 of 4", "Ready for the check", "New
 * lesson" (after a missed check, the step to go back to).
 */
export function practiceLine(progress: LessonProgress, tries: number, review: number | null = null): string {
  if (progress.passed) return 'Passed';
  if (tries === 0 && review === null) return 'New lesson';
  if (review === null && (progress.ready || progress.steps.length === 0)) return 'Ready for the check';
  const at = review ?? progress.currentStep;
  return `Practice ${Math.min(at, progress.steps.length - 1) + 1} of ${progress.steps.length}`;
}

/** "2 of 3 good tries" ("1 of 1 good try"). */
export function goodTriesText(good: number, needed: number): string {
  const n = Math.max(0, Math.min(good, needed));
  return `${n} of ${needed} good ${needed === 1 ? 'try' : 'tries'}`;
}

/** The in-tune zone of a level in a word (CONFIG.tolerance: easy ±50, default ±25, studio ±10). */
export const ZONE_WORDS: Readonly<Record<ToleranceLevel, string>> = { easy: 'wide', default: 'medium', studio: 'narrow' };
