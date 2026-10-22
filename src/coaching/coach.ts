/**
 * The coach: turns one take (and the log before it) into a Coaching (src/coaching/types.ts): the problem located in the
 * take, plain words and plain numbers, "since last time", and help that deepens with each miss in a row.
 *
 * WAVE CONTRACT STUB: the coaching-engine builder replaces the bodies and keeps these signatures (report needed changes).
 * depthFor is final.
 */
import type { Notation } from '../core/music';
import type { ExerciseDef } from '../exercises/types';
import type { RealizedExercise } from '../exercises/transpose';
import type { TakeAnalysis } from '../exercises/analyze';
import type { PickedTip } from '../exercises/tips';
import type { TakeOutcome } from '../runtime/types';
import type { AttemptRecord } from '../storage/schema';
import type { CoachDepth, Coaching, ProgressLine, TakeProblem } from './types';

/** Misses in a row -> depth: 0-1 -> 1 (the tip), 2 -> 2 (+ why), 3-4 -> 3 (+ steps), 5 or more -> 4 (+ an easier way in). */
export function depthFor(missesInARow: number): CoachDepth {
  if (missesInARow >= 5) return 4;
  if (missesInARow >= 3) return 3;
  if (missesInARow === 2) return 2;
  return 1;
}

/** Non-passing takes of this exercise in a row, newest first, up to the last pass (the log is oldest first). */
export function missesInARow(exerciseId: string, log: readonly AttemptRecord[]): number {
  void exerciseId;
  void log;
  throw new Error('missesInARow: not built yet');
}

/** Where in the take the tip's problem shows, and one plain sentence with plain numbers. */
export function locateProblem(input: {
  def: ExerciseDef;
  realized: Pick<RealizedExercise, 'notes' | 'totalSec' | 'tonicMidi'>;
  analysis: TakeAnalysis;
  tip: PickedTip;
  notation: Notation;
}): TakeProblem {
  void input;
  throw new Error('locateProblem: not built yet');
}

/** The same measures on the previous take of this exercise and on this one. */
export function progressLines(def: ExerciseDef, previous: AttemptRecord | null, current: AttemptRecord, problem: TakeProblem): ProgressLine[] {
  void def;
  void previous;
  void current;
  void problem;
  throw new Error('progressLines: not built yet');
}

/** The coaching for a finished take; `log` is the profile's attempt log AFTER this take was written. */
export function coachTake(outcome: TakeOutcome, log: readonly AttemptRecord[], opts?: { notation?: Notation }): Coaching {
  void outcome;
  void log;
  void opts;
  throw new Error('coachTake: not built yet');
}
