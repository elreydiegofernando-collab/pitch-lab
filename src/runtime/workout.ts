/**
 * The daily-workout session (SPEC §12): built by progress/workout.ts buildDailyWorkout, then sung item by item
 * through the runner (RunTarget { kind: 'workout', itemIndex }).
 *
 * WAVE 2 CONTRACT STUB. Signatures are the contract; the runtime builder implements the bodies.
 * The session lives in memory for the page's lifetime (a workout is one sitting); every take in it is already a
 * durable attempt, so nothing is lost if the page dies mid-workout.
 */
import { signal } from '@preact/signals';
import type { Workout, WorkoutMinutes } from '../progress/workout';
import type { TakeOutcome } from './types';

export interface WorkoutItemResult {
  /** Attempt ids of the takes sung for this item, oldest first. */
  attemptIds: string[];
  bestScore: number | null;
  passedAny: boolean;
}

export interface WorkoutSession {
  workout: Workout;
  startedAt: string;
  /** One entry per workout.items entry. */
  results: WorkoutItemResult[];
  finishedAt: string | null;
}

export interface WorkoutSummary {
  itemsDone: number;
  itemCount: number;
  takes: number;
  /** Minutes actually sung (count-in + take time). */
  minutes: number;
  momentumBefore: number;
  momentumAfter: number;
}

export const activeWorkout = signal<WorkoutSession | null>(null);

/** Today's plan for the active profile (locked: `workout.locked` with the hint). Pure apart from reading the session. */
export function planWorkout(minutes: WorkoutMinutes): Workout {
  void minutes;
  throw new Error('planWorkout: not built yet (Wave 2 runtime)');
}

/** Build today's plan and make it the active workout. */
export function startWorkout(minutes: WorkoutMinutes): WorkoutSession {
  void minutes;
  throw new Error('startWorkout: not built yet (Wave 2 runtime)');
}

/** The runner calls this after each workout take is written. */
export function recordWorkoutTake(itemIndex: number, outcome: TakeOutcome): void {
  void itemIndex;
  void outcome;
}

/** Mark the active workout finished and summarize it (the workout screen shows the summary). */
export function finishWorkout(): WorkoutSummary | null {
  return null;
}

/** Drop the active workout without a summary. */
export function abandonWorkout(): void {
  activeWorkout.value = null;
}
