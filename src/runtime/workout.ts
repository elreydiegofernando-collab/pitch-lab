/**
 * The daily-workout session (SPEC §12): built by progress/workout.ts buildDailyWorkout, then sung item by item
 * through the runner (RunTarget { kind: 'workout', itemIndex }).
 *
 * The session lives in memory for the page's lifetime (a workout is one sitting); every take in it is already a
 * durable attempt, so nothing is lost if the page dies mid-workout. A profile switch, a backup import or Delete all
 * data drops it (src/state/session.ts).
 */
import { signal } from '@preact/signals';
import { WORLDS, getExercise } from '../exercises';
import { buildDailyWorkout, withRoutines, type Workout, type WorkoutMinutes } from '../progress';
import { attemptLog, snapshot } from '../state/session';
import { settings, updateSettings } from '../state/settings';
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

/** Momentum before the workout's first take and after its latest one (the snapshots around each take). */
let momentum: { before: number; after: number } | null = null;

/** Today's plan for the active profile (locked: `workout.locked` with the hint). Pure apart from reading the session. */
export function planWorkout(minutes: WorkoutMinutes): Workout {
  return buildDailyWorkout({
    minutes,
    snapshot: snapshot.value,
    worlds: WORLDS,
    attempts: attemptLog.value,
    now: Date.now(),
    getExercise: withRoutines(getExercise),
  });
}

/** Build today's plan and make it the active workout; the length is remembered as the profile's choice. Throws while the workout is locked. */
export function startWorkout(minutes: WorkoutMinutes): WorkoutSession {
  const workout = planWorkout(minutes);
  if (workout.locked) throw new Error(workout.hint ?? 'The daily workout is not open yet.');
  if (settings.value.workoutMinutes !== minutes) updateSettings({ workoutMinutes: minutes });
  const session: WorkoutSession = {
    workout,
    startedAt: new Date().toISOString(),
    results: workout.items.map(() => ({ attemptIds: [], bestScore: null, passedAny: false })),
    finishedAt: null,
  };
  momentum = null;
  activeWorkout.value = session;
  return session;
}

/** The runner calls this after each workout take is written. */
export function recordWorkoutTake(itemIndex: number, outcome: TakeOutcome): void {
  const session = activeWorkout.value;
  if (!session || session.finishedAt !== null || itemIndex < 0 || itemIndex >= session.results.length) return;
  const { attempt } = outcome;
  const results = session.results.map((r, i) =>
    i === itemIndex
      ? {
          attemptIds: [...r.attemptIds, attempt.id],
          bestScore: r.bestScore === null ? attempt.score : Math.max(r.bestScore, attempt.score),
          passedAny: r.passedAny || attempt.passed,
        }
      : r,
  );
  momentum = { before: momentum?.before ?? outcome.before.momentum, after: outcome.after.momentum };
  activeWorkout.value = { ...session, results };
}

/** Mark the active workout finished and summarize it (the workout screen shows the summary). Calling it again repeats the summary. */
export function finishWorkout(): WorkoutSummary | null {
  const session = activeWorkout.value;
  if (!session) return null;
  const ids = new Set(session.results.flatMap((r) => r.attemptIds));
  let seconds = 0;
  for (const a of attemptLog.value) if (ids.has(a.id)) seconds += a.durationSec;
  const now = snapshot.value.momentum;
  if (session.finishedAt === null) activeWorkout.value = { ...session, finishedAt: new Date().toISOString() };
  return {
    itemsDone: session.results.filter((r) => r.attemptIds.length > 0).length,
    itemCount: session.results.length,
    takes: ids.size,
    minutes: seconds / 60,
    momentumBefore: momentum?.before ?? now,
    momentumAfter: momentum?.after ?? now,
  };
}

/** Drop the active workout without a summary. */
export function abandonWorkout(): void {
  momentum = null;
  activeWorkout.value = null;
}
