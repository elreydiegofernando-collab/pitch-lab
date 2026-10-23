/**
 * Every lesson, keyed by level id. A level without a lesson (the later worlds, until they are converted) keeps the
 * classic flow: its exercise straight away.
 */
import { FOUNDATIONS_LESSONS } from './foundations';
import type { LessonDef } from './types';

export const LESSONS: Readonly<Record<string, LessonDef>> = Object.freeze({ ...FOUNDATIONS_LESSONS });

/** The lesson of a level; undefined when the level has none yet. */
export function lessonFor(levelId: string): LessonDef | undefined {
  return Object.prototype.hasOwnProperty.call(LESSONS, levelId) ? LESSONS[levelId] : undefined;
}

/** The lesson a drill exercise belongs to, and its step index; undefined for any other exercise. */
export function lessonOfDrill(exerciseId: string): { lesson: LessonDef; step: number } | undefined {
  for (const lesson of Object.values(LESSONS)) {
    const step = lesson.practice.findIndex((p) => p.exerciseId === exerciseId);
    if (step >= 0) return { lesson, step };
  }
  return undefined;
}
